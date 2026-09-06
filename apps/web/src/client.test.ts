import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, get, post } from './client.js';
import { stepUp } from './auth.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('request delivery contracts', () => {
  it('retains the write identity and bytes while an idempotent request is reconciled', async () => {
    vi.useFakeTimers();
    const sent: Array<{ key: string | null; body: unknown; credentials: unknown }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      sent.push({
        key: new Headers(options?.headers).get('Idempotency-Key'),
        body: options?.body,
        credentials: options?.credentials
      });
      return sent.length === 1
        ? Response.json(
            { error: { code: 'operation_in_progress', message: 'Still reconciling' } },
            { status: 409 }
          )
        : Response.json({ id: 'created-once' });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = post('/v1/tasks', { message: 'Keep this exact request' }, { retry: 1 });
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toEqual({ id: 'created-once' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = sent[0]!;
    const second = sent[1]!;
    const key = first.key;
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(second.key).toBe(key);
    expect(second.body).toBe(first.body);
    expect(first.credentials).toBe('include');
    expect(second.credentials).toBe('include');
  });

  it('does not automatically repeat a secret-minting write after a lost response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network lost'));
    vi.stubGlobal('fetch', fetcher);
    await expect(post('/v1/tasks/task/shares', {})).rejects.toMatchObject({
      code: 'connection_failed'
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves a caller-supplied identity and surfaces step-up errors without replay', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'step_up_required',
            message: 'Confirm with your passkey',
            requestId: 'trace-1'
          }
        },
        { status: 403 }
      )
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      post('/v1/api-tokens', {}, { idempotencyKey: 'sensitive-action-1', retry: 2 })
    ).rejects.toMatchObject({
      code: 'step_up_required',
      status: 403,
      requestId: 'trace-1'
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe(
      'sensitive-action-1'
    );
  });

  it('cancels a pending retry without dispatching another read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const pending = get('/v1/bootstrap', { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses to send an authenticated request to an external origin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    await expect(get('https://elsewhere.example/v1/tasks')).rejects.toBeInstanceOf(ApiError);
    await expect(get('//elsewhere.example/v1/tasks')).rejects.toBeInstanceOf(ApiError);
    await expect(get('/\\elsewhere.example/v1/tasks')).rejects.toBeInstanceOf(ApiError);
    await expect(get('/\n/elsewhere.example/v1/tasks')).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the server-confirmed step-up window and coalesces simultaneous requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ verified: true }));
    vi.stubGlobal('fetch', fetcher);
    const first = stepUp();
    const second = stepUp();
    expect(second).toBe(first);
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('/v1/auth/step-up/options');
  });
});
