import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  endpointHost,
  EndpointHealth,
  isGone,
  RETRY_BASE_MS,
  RETRY_CEILING_MS,
  RETRY_HORIZON_MS
} from './retry.js';

const at = (offsetMs: number) => new Date(Date.parse('2026-08-01T00:00:00Z') + offsetMs);

describe('classifying what the far end said', () => {
  it('treats only "this subscription is gone" as permanent', () => {
    expect(isGone(404)).toBe(true);
    expect(isGone(410)).toBe(true);
    // A rate limit, a bad gateway and a rotated signing key are all "not now", not "never".
    expect([429, 502, 503, 401, 403, 0].every((status) => !isGone(status))).toBe(true);
  });
});

describe('the wait between attempts', () => {
  it('doubles from a minute and levels off, so a bad afternoon is not a hot loop', () => {
    expect(backoffMs(1)).toBe(RETRY_BASE_MS);
    expect(backoffMs(2)).toBe(2 * RETRY_BASE_MS);
    expect(backoffMs(3)).toBe(4 * RETRY_BASE_MS);
    expect(backoffMs(20)).toBe(RETRY_CEILING_MS);
  });
});

describe('an endpoint that is refusing', () => {
  it('is skipped until its wait is over, and then tried again', () => {
    const health = new EndpointHealth();
    health.failed('device-a', 429, at(0));
    expect(health.waiting('device-a', at(0))).toBe(true);
    expect(health.waiting('device-a', at(RETRY_BASE_MS - 1))).toBe(true);
    expect(health.waiting('device-a', at(RETRY_BASE_MS))).toBe(false);
  });

  it('holds nothing against an endpoint that has not failed', () => {
    expect(new EndpointHealth().waiting('device-b', at(0))).toBe(false);
  });

  it('does not put every other device behind the one that is refusing', () => {
    const health = new EndpointHealth();
    health.failed('device-a', 502, at(0));
    expect(health.waiting('device-a', at(0))).toBe(true);
    expect(health.waiting('device-b', at(0))).toBe(false);
  });

  it('starts again from nothing once a delivery gets through', () => {
    const health = new EndpointHealth();
    health.failed('device-a', 502, at(0));
    health.failed('device-a', 502, at(RETRY_BASE_MS));
    health.succeeded('device-a');
    expect(health.failingCount).toBe(0);
    expect(health.waiting('device-a', at(RETRY_BASE_MS + 1))).toBe(false);
    // The next failure is a first failure again: the run of them ended.
    expect(health.failed('device-a', 502, at(RETRY_HORIZON_MS)).first).toBe(true);
  });

  it('reports the first refusal of a run and only that one, so the journal stays readable', () => {
    const health = new EndpointHealth();
    expect(health.failed('device-a', 502, at(0)).first).toBe(true);
    expect(health.failed('device-a', 502, at(RETRY_BASE_MS)).first).toBe(false);
    expect(health.failed('device-a', 502, at(3 * RETRY_BASE_MS)).first).toBe(false);
  });

  it('is retired only after a day of refusing, never on a bad minute', () => {
    const health = new EndpointHealth();
    expect(health.failed('device-a', 502, at(0)).exhausted).toBe(false);
    expect(health.failed('device-a', 502, at(RETRY_HORIZON_MS - 1)).exhausted).toBe(false);
    expect(health.failed('device-a', 502, at(RETRY_HORIZON_MS)).exhausted).toBe(true);
  });

  it('measures the day from the first refusal, not from the last one', () => {
    const health = new EndpointHealth();
    for (let elapsed = 0; elapsed < RETRY_HORIZON_MS; elapsed += RETRY_CEILING_MS)
      expect(health.failed('device-a', 503, at(elapsed)).exhausted).toBe(false);
    expect(health.failed('device-a', 503, at(RETRY_HORIZON_MS)).exhausted).toBe(true);
  });

  it('counts the endpoints currently refusing, which is what health reports', () => {
    const health = new EndpointHealth();
    health.failed('device-a', 502, at(0));
    health.failed('device-b', 429, at(0));
    expect(health.failingCount).toBe(2);
    health.forget('device-a');
    expect(health.failingCount).toBe(1);
  });
});

describe('naming the push service in a log line', () => {
  it('keeps the host and drops the path, which is the secret that authorises sending', () => {
    const host = endpointHost('https://push.example.com/send/AAAA-secret-token-BBBB');
    expect(host).toBe('push.example.com');
    expect(host).not.toContain('secret');
  });

  it('still names something when the endpoint will not parse', () => {
    expect(endpointHost('not a url')).toBe('the push service');
  });
});

describe('a far end that names its own wait', () => {
  it('is tried again exactly when it asked, and no later than the ceiling', () => {
    // A rate limit says "retry after 3" and means it. The minute the backoff would have chosen is
    // twenty times too long for the first refusal and would hold every card behind it for nothing.
    const health = new EndpointHealth();
    health.failed('phone-1', 429, at(0), 3_000);
    expect(health.waiting('phone-1', at(2_999))).toBe(true);
    expect(health.waiting('phone-1', at(3_000))).toBe(false);
    // An hour is asked for; the half-hour ceiling is what it gets.
    health.failed('phone-2', 429, at(0), 60 * 60_000);
    expect(health.waiting('phone-2', at(RETRY_CEILING_MS - 1))).toBe(true);
    expect(health.waiting('phone-2', at(RETRY_CEILING_MS))).toBe(false);
    // A nonsense wait is no wait at all: the backoff decides, as it does when none was named.
    health.failed('phone-3', 500, at(0), Number.NaN);
    expect(health.waiting('phone-3', at(RETRY_BASE_MS - 1))).toBe(true);
    expect(health.waiting('phone-3', at(RETRY_BASE_MS))).toBe(false);
  });
});
