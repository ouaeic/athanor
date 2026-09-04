import { describe, expect, it } from 'vitest';
import { TransportError } from '../transport.js';
import { createTelegramClient, redactToken } from './client.js';

const token = '7654321:AAHfakeSecretPartOfTheBotToken_abcdefg';

const client = (
  answer: (url: string, init: RequestInit) => Promise<Response> | Response,
  warned: string[] = []
) =>
  createTelegramClient({
    baseUrl: 'https://bot-api.test/',
    token,
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      answer(input instanceof Request ? input.url : input.toString(), init ?? {})) as typeof fetch,
    warn: (line) => void warned.push(line)
  });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

describe('the bot API client', () => {
  it('posts the method with the token in the path and hands back the result', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const api = client((url, init) => {
      seen = { url, init };
      return json({ ok: true, result: { message_id: 7 } });
    });
    await expect(api.call('sendMessage', { chat_id: 1, text: 'hi' })).resolves.toEqual({
      message_id: 7
    });
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe(`https://bot-api.test/bot${token}/sendMessage`);
    expect(seen!.init.method).toBe('POST');
    expect(JSON.parse(seen!.init.body as string)).toEqual({ chat_id: 1, text: 'hi' });
  });

  it('never lets the token into what it throws, even when the far end echoes the URL back', async () => {
    // The token is a path segment of every request, so an error that quotes the request quotes
    // the token, and the journal is readable by whoever is at the box.
    const api = client(() =>
      json(
        {
          ok: false,
          error_code: 400,
          description: `Bad Request: https://bot-api.test/bot${token}/sendMessage rejected`
        },
        400
      )
    );
    const failure = await api.call('sendMessage', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    const message = (failure as TransportError).message;
    expect(message).not.toContain(token);
    expect(message).not.toContain('AAHfakeSecret');
    expect(message).toContain('400');
    expect((failure as TransportError).statusCode).toBe(400);
  });

  it('redacts a URL-shaped failure from the transport itself, and every journal line', async () => {
    const warned: string[] = [];
    const api = client(() => {
      throw new Error(`connect ECONNREFUSED https://bot-api.test/bot${token}/getUpdates`);
    }, warned);
    const failure = await api.call('getUpdates', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).message).not.toContain(token);
    expect((failure as TransportError).statusCode).toBe(0);
    api.warn(`something went wrong at https://bot-api.test/bot${token}/x and ${token} again\n`);
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain(token);
    expect(warned[0]).toContain('[bot token]');
  });

  it('reads a rate limit as the wait the far end named', async () => {
    const api = client(() =>
      json({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, 429)
    );
    const failure = await api.call('sendMessage', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 429, retryAfterMs: 3_000, gone: false });
  });

  it('treats a body that is not the envelope as a refusal rather than a result', async () => {
    const api = client(() => new Response('<html>gateway</html>', { status: 502 }));
    const failure = await api.call('sendMessage', {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 502 });
  });
});

describe('redactToken', () => {
  it('removes the exact token and anything shaped like one', () => {
    expect(redactToken(`bot${token}/method ${token} 12345:${'x'.repeat(30)}`, token)).toBe(
      'bot[bot token]/method [bot token] [bot token]'
    );
    // A short "digits:word" is not a token and is left alone, so a journal line about a task or
    // a clock time is not mangled.
    expect(redactToken('at 12:30 the task 42:done')).toBe('at 12:30 the task 42:done');
  });
});
