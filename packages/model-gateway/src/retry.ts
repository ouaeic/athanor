import { AthanorError } from '@athanor/core';

/**
 * Provider faults an identical later request has a real chance of surviving. Anything else
 * (a rejected prompt, an unknown model, a malformed tool schema) fails the same way every time,
 * so retrying it only burns the owner's budget.
 */
const RETRYABLE_CODES = new Set(['provider_unavailable', 'provider_quota_exhausted']);

export interface RetryPolicy {
  /** Total attempts including the first; `1` disables retry. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Ceiling for a single wait, including a provider's own Retry-After hint. */
  maxDelayMs: number;
  /** Jitter source in [0, 1); injected so tests are deterministic. */
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  random: Math.random,
  sleep: wait
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Adapters surface upstream status differently, so every conventional carrier is checked. */
export const httpStatusOf = (error: unknown): number | undefined => {
  const record = asRecord(error);
  if (!record) return undefined;
  return (
    finiteNumber(record.status) ??
    finiteNumber(record.statusCode) ??
    finiteNumber(asRecord(record.response)?.status) ??
    finiteNumber(asRecord(record.details)?.status)
  );
};

const retryAfterHeader = (holder: Record<string, unknown> | undefined): string | undefined => {
  const headers = asRecord(holder?.headers);
  const get = headers?.get;
  if (typeof get !== 'function') return undefined;
  const value = (get as (name: string) => unknown).call(headers, 'retry-after');
  return typeof value === 'string' ? value : undefined;
};

/** Retry-After is either a delay in seconds or an HTTP date; both forms appear in the wild. */
const parseRetryAfter = (value: unknown): number | undefined => {
  const seconds = finiteNumber(value);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const asSeconds = Number(value.trim());
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value.trim());
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : undefined;
};

export const retryAfterMsOf = (error: unknown): number | undefined => {
  const record = asRecord(error);
  if (!record) return undefined;
  const response = asRecord(record.response);
  return (
    parseRetryAfter(asRecord(record.details)?.retryAfter) ??
    parseRetryAfter(record.retryAfter) ??
    parseRetryAfter(retryAfterHeader(response)) ??
    parseRetryAfter(retryAfterHeader(record))
  );
};

export const isRetryableError = (error: unknown): boolean => {
  if (error instanceof AthanorError && RETRYABLE_CODES.has(error.code)) return true;
  const status = httpStatusOf(error);
  if (status === undefined) return false;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
};

const isAbortError = (error: unknown): boolean => {
  const record = asRecord(error);
  return record?.name === 'AbortError' || record?.code === 'ABORT_ERR';
};

/**
 * Exponential backoff with full jitter, so a fleet of agents that all hit the same rate limit
 * spreads out instead of resynchronising on the provider's next window. A provider's own
 * Retry-After hint raises the floor but never lifts the wait past `maxDelayMs`, which keeps one
 * stuck upstream from parking a task for an unbounded stretch.
 */
export const backoffDelayMs = (policy: RetryPolicy, attempt: number, error: unknown): number => {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jittered = exponential * (0.5 + policy.random() * 0.5);
  return Math.min(policy.maxDelayMs, Math.max(retryAfterMsOf(error) ?? 0, jittered));
};

export interface RetryOptions {
  policy: RetryPolicy;
  /**
   * Whether the failed attempt already handed text to the caller. Replaying such a request would
   * repeat visible output, so a partially streamed failure is always terminal.
   */
  hasStreamed: () => boolean;
  signal?: AbortSignal;
}

export const withRetry = async <T>(
  attempt: () => Promise<T>,
  options: RetryOptions
): Promise<T> => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        tries >= options.policy.maxAttempts ||
        options.hasStreamed() ||
        options.signal?.aborted ||
        isAbortError(error) ||
        !isRetryableError(error)
      )
        throw error;
      await options.policy.sleep(backoffDelayMs(options.policy, tries, error), options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
};
