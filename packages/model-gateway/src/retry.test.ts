import { AthanorError } from '@athanor/core';
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  isRetryableError,
  retryAfterMsOf,
  withRetry,
  type RetryPolicy
} from './retry.js';

const policy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  random: () => 0,
  sleep: async () => {},
  ...overrides
});

describe('retry classification', () => {
  it('retries transient provider faults and leaves permanent ones alone', () => {
    expect(isRetryableError(new AthanorError('provider_unavailable', 'down', 503))).toBe(true);
    expect(isRetryableError(new AthanorError('provider_quota_exhausted', 'slow down'))).toBe(true);
    expect(isRetryableError(new AthanorError('provider_request_failed', 'bad prompt'))).toBe(false);
    expect(isRetryableError(new AthanorError('provider_not_configured', 'missing', 404))).toBe(
      false
    );
    expect(isRetryableError(new Error('socket hang up'))).toBe(false);
  });

  it('retries 408, 429 and 5xx however the adapter carries the status', () => {
    expect(isRetryableError(Object.assign(new Error('timeout'), { status: 408 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('limited'), { statusCode: 429 }))).toBe(true);
    expect(
      isRetryableError(Object.assign(new Error('gateway'), { response: { status: 502 } }))
    ).toBe(true);
    expect(isRetryableError(Object.assign(new Error('teapot'), { status: 418 }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('nope'), { status: 404 }))).toBe(false);
  });
});

describe('retry-after hints', () => {
  it('reads a hint from error details, a seconds header or an HTTP date header', () => {
    expect(
      retryAfterMsOf(new AthanorError('provider_quota_exhausted', 'wait', 429, { retryAfter: 7 }))
    ).toBe(7000);
    expect(
      retryAfterMsOf(
        Object.assign(new Error('limited'), {
          response: { status: 429, headers: new Headers({ 'retry-after': '12' }) }
        })
      )
    ).toBe(12_000);
    const hint = retryAfterMsOf(
      Object.assign(new Error('limited'), {
        headers: new Headers({ 'retry-after': new Date(Date.now() + 30_000).toUTCString() })
      })
    );
    expect(hint).toBeGreaterThan(25_000);
    expect(hint).toBeLessThanOrEqual(30_000);
    expect(retryAfterMsOf(new Error('no hint'))).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially, jitters within the attempt window and stays under the ceiling', () => {
    const zeroJitter = policy({ random: () => 0 });
    expect(backoffDelayMs(zeroJitter, 1, new Error('x'))).toBe(250);
    expect(backoffDelayMs(zeroJitter, 2, new Error('x'))).toBe(500);
    expect(backoffDelayMs(zeroJitter, 3, new Error('x'))).toBe(1000);
    const fullJitter = policy({ random: () => 0.999 });
    expect(backoffDelayMs(fullJitter, 1, new Error('x'))).toBeGreaterThan(250);
    expect(backoffDelayMs(fullJitter, 1, new Error('x'))).toBeLessThanOrEqual(500);
    expect(backoffDelayMs(zeroJitter, 20, new Error('x'))).toBe(10_000);
  });

  it('raises the wait to a provider hint without exceeding the ceiling', () => {
    const error = new AthanorError('provider_quota_exhausted', 'wait', 429, { retryAfter: 5 });
    expect(backoffDelayMs(policy(), 1, error)).toBe(5000);
    const longHint = new AthanorError('provider_quota_exhausted', 'wait', 429, {
      retryAfter: 600
    });
    expect(backoffDelayMs(policy(), 1, longHint)).toBe(20_000);
  });
});

describe('withRetry', () => {
  it('stops after the configured attempt budget and rethrows the last failure', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AthanorError('provider_unavailable', 'upstream down', 503);
        },
        {
          policy: policy({
            maxAttempts: 3,
            sleep: async (ms) => {
              waits.push(ms);
            }
          }),
          hasStreamed: () => false
        }
      )
    ).rejects.toThrow('upstream down');
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  it('does not retry once the attempt has already emitted output', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new AthanorError('provider_unavailable', 'stream cut', 503);
        },
        { policy: policy(), hasStreamed: () => true }
      )
    ).rejects.toThrow('stream cut');
    expect(attempts).toBe(1);
  });

  it('does not retry an aborted request', async () => {
    const controller = new AbortController();
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          controller.abort();
          throw new AthanorError('provider_unavailable', 'cancelled mid-flight', 503);
        },
        { policy: policy(), hasStreamed: () => false, signal: controller.signal }
      )
    ).rejects.toThrow('cancelled mid-flight');
    expect(attempts).toBe(1);
  });

  it('does not retry an AbortError raised by the transport', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('aborted'), { name: 'AbortError', status: 503 });
        },
        { policy: policy(), hasStreamed: () => false }
      )
    ).rejects.toThrow('aborted');
    expect(attempts).toBe(1);
  });
});

describe('provider status classification', () => {
  it('retries a 5xx, which is the status the adapter actually produces for an upstream fault', () => {
    // The adapter used to construct this error without a status, so it inherited AthanorError's
    // default of 400 and a three-hour task died on one upstream blip.
    for (const status of [500, 502, 503, 504]) {
      expect(
        isRetryableError(
          new AthanorError(
            'provider_request_failed',
            `openrouter request failed (${status})`,
            status
          )
        )
      ).toBe(true);
    }
  });

  it('still refuses to retry a genuine client-side rejection', () => {
    expect(isRetryableError(new AthanorError('provider_request_failed', 'bad prompt', 400))).toBe(
      false
    );
  });

  it('honours a Retry-After carried on the error details', () => {
    expect(
      retryAfterMsOf(
        new AthanorError('provider_quota_exhausted', 'rate limited', 429, { retryAfter: '30' })
      )
    ).toBe(30_000);
  });
});
