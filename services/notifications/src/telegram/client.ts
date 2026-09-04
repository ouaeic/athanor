import { TransportError } from '../transport.js';

/**
 * How long one call to the bot API may take before it is given up on. Long polling is the one
 * exception and names its own, longer ceiling per call.
 */
export const TELEGRAM_CALL_TIMEOUT_MS = 10_000;

/** What a bot token looks like: a numeric bot id, a colon, and a secret in the URL-safe alphabet. */
const TOKEN_SHAPE = /\b\d{5,12}:[A-Za-z0-9_-]{20,}/g;

/**
 * The token out of anything that might reach the journal or an error message.
 *
 * The bot token is a path segment of every request URL, so an error that quotes the URL - and a
 * fetch failure does - quotes the token. This service holds the token only to send with, and the
 * journal is readable by whoever is at the box. Both the exact token and anything shaped like one
 * are replaced, because the exact one is not always known where the text is produced.
 */
export const redactToken = (text: string, token?: string): string =>
  (token ? text.split(token).join('[bot token]') : text).replace(TOKEN_SHAPE, '[bot token]');

export interface TelegramCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TelegramClient {
  /** One method call. Throws `TransportError`, with the token redacted from its message. */
  call<T>(method: string, body: Record<string, unknown>, options?: TelegramCallOptions): Promise<T>;
  /** The journal, with the token redacted from whatever is written. */
  warn(line: string): void;
}

export interface TelegramClientInput {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
}

interface Envelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * One `call(method, body)` over `fetch`, and the two things every caller needs from it: a 429 read
 * as the wait the far end named, and no token anywhere in what it throws or writes.
 */
export const createTelegramClient = (input: TelegramClientInput): TelegramClient => {
  const doFetch = input.fetch ?? fetch;
  const redact = (text: string): string => redactToken(text, input.token);
  const journal = input.warn ?? ((line: string) => void process.stderr.write(line));
  const base = input.baseUrl.replace(/\/+$/, '');
  return {
    async call<T>(
      method: string,
      body: Record<string, unknown>,
      options: TelegramCallOptions = {}
    ): Promise<T> {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? TELEGRAM_CALL_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await doFetch(`${base}/bot${input.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TransportError(redact(`${method} could not be sent: ${reason}`), {
          statusCode: 0
        });
      }
      let envelope: Envelope | null = null;
      try {
        envelope = (await response.json()) as Envelope;
      } catch {
        envelope = null;
      }
      if (!response.ok || !envelope || envelope.ok !== true) {
        const statusCode = envelope?.error_code ?? response.status;
        const retryAfter = envelope?.parameters?.retry_after;
        const description = envelope?.description ? `: ${envelope.description}` : '';
        throw new TransportError(redact(`${method} answered ${statusCode}${description}`), {
          statusCode,
          ...(typeof retryAfter === 'number' && retryAfter > 0
            ? { retryAfterMs: retryAfter * 1000 }
            : {})
        });
      }
      return envelope.result as T;
    },
    warn: (line) => journal(redact(line))
  };
};
