import { afterEach, describe, expect, it, vi } from 'vitest';
import { AthanorError } from '@athanor/core';
import { AgentRunnerClient, RUNNER_CONNECT_ATTEMPTS } from './runner-client.js';

const client = new AgentRunnerClient('http://127.0.0.1:4300', 'r'.repeat(48));
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';

/** What undici actually throws: the reason is one level down, in `cause`. */
const transportFailure = (code: string): TypeError =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

const run = (): Promise<unknown> =>
  client.call(workspaceId, taskId, 'exec', `/v1/workspaces/${workspaceId}/exec`, {
    executable: 'ls'
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a workspace runner that is restarting', () => {
  it('rides out the restart window instead of failing the tool', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      if (attempts < 3) throw transportFailure('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' }
      });
    });

    const pending = run();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it('explains a runner that never comes back, and says nothing ran', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw transportFailure('ECONNREFUSED');
    });

    const pending = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const failure = await pending;

    expect(attempts).toBe(RUNNER_CONNECT_ATTEMPTS);
    expect(failure).toBeInstanceOf(AthanorError);
    expect((failure as AthanorError).code).toBe('workspace_runner_unreachable');
    expect((failure as AthanorError).message).toContain('nothing from this call ran');
    expect((failure as AthanorError).message).toContain('athanor-runner');
    expect((failure as AthanorError).message).not.toContain('fetch failed');
  });

  it('never replays a call the connection dropped after sending, and says it may have run', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw transportFailure('UND_ERR_SOCKET');
    });

    const failure = await run().catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect((failure as AthanorError).code).toBe('workspace_runner_interrupted');
    expect((failure as AthanorError).message).toContain('may have partly run');
  });

  it('describes a runner that accepted the call and never answered', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    });

    const failure = await run().catch((error: unknown) => error);

    expect((failure as AthanorError).code).toBe('workspace_runner_timeout');
    expect((failure as AthanorError).message).toContain('It may still be running');
  });

  it('carries an anti-bot challenge across as data, not as a sentence about one', async () => {
    // The wall is the one refusal whose answer is a person: the worker has to raise it with the
    // owner and offer them that exact tab, and none of the vendor, the site or the tab id survives
    // being read back out of `Workspace tool failed (409): {…}`.
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'browser_bot_wall',
              message:
                'Blocked by Cloudflare Turnstile: this page is showing an anti-bot challenge',
              requestId: 'req-1',
              botWall: {
                vendor: 'Cloudflare Turnstile',
                url: 'https://html.duckduckgo.com/html/?q=board+pack',
                reason: 'challenge frame',
                evidence: 'page',
                tabId: 'tab-2'
              }
            }
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
    );

    const failure = (await run().catch((error: unknown) => error)) as AthanorError;

    expect(failure).toBeInstanceOf(AthanorError);
    expect(failure.code).toBe('browser_bot_wall');
    expect(failure.statusCode).toBe(409);
    expect(failure.message).toContain('Cloudflare Turnstile');
    expect(failure.details?.botWall).toMatchObject({
      vendor: 'Cloudflare Turnstile',
      tabId: 'tab-2',
      url: 'https://html.duckduckgo.com/html/?q=board+pack'
    });
  });

  it('gives an ordinary refusal its own code and the runner’s own words', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'runner_request_failed',
              message: 'Browser control is held by user',
              requestId: 'req-2'
            }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    );

    const failure = (await run().catch((error: unknown) => error)) as AthanorError;

    expect(failure.code).toBe('runner_request_failed');
    expect(failure.message).toBe('Browser control is held by user');
    expect(failure.message).not.toContain('Workspace tool failed');
  });

  it('keeps the plain sentence for a body that is not a runner refusal', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }));

    const failure = (await run().catch((error: unknown) => error)) as Error;

    expect(failure).not.toBeInstanceOf(AthanorError);
    expect(failure.message).toContain('Workspace tool failed (502)');
    expect(failure.message).toContain('bad gateway');
  });

  it('leaves a cancelled call as an abort so the stop path still owns it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });

    const failure = await run().catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(AthanorError);
    expect((failure as Error).name).toBe('AbortError');
  });
});
