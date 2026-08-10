import { describe, expect, it } from 'vitest';
import { RENEW_WITHIN_MS, capabilityDeadline, shouldRenew } from './session-renewal.js';

const NOW = 1_786_000_000_000;
const token = (payload: Record<string, unknown>, urlSafe = false): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString(urlSafe ? 'base64url' : 'base64');
  return `header.${body}.signature`;
};

describe('deciding when a live session asks for a fresh capability', () => {
  it('waits while there is plenty of time left', () => {
    expect(shouldRenew({ deadline: NOW + 15 * 60_000, now: NOW, inFlight: false })).toBe(false);
  });

  /**
   * The failure this exists for: a fifteen-minute capability renewed once, most of the way to
   * expiry, by a timer a hidden tab throttles. Measured on the deployed server, the session closed
   * at 902s with 1008 "Capability expired" - the exact thing renewal prevents. Renewing inside the
   * last third means a one-minute check gets five attempts, not one.
   */
  it('leaves room for several attempts rather than one', () => {
    const deadline = NOW + 15 * 60_000;
    const attempts = [];
    for (let minute = 0; minute <= 15; minute += 1) {
      const now = NOW + minute * 60_000;
      if (shouldRenew({ deadline, now, inFlight: false })) attempts.push(minute);
    }
    // Five chances before the deadline, so missing some to throttling is survivable.
    expect(attempts).toEqual([10, 11, 12, 13, 14, 15]);
    expect(RENEW_WITHIN_MS).toBe(300_000);
  });

  it('does not stack a second attempt on a slow one', () => {
    expect(shouldRenew({ deadline: NOW + 60_000, now: NOW, inFlight: true })).toBe(false);
  });

  it('keeps trying after a failed attempt, since the deadline is still coming', () => {
    // `inFlight` back to false is the only state a failure leaves behind; the window still says yes.
    expect(shouldRenew({ deadline: NOW + 60_000, now: NOW, inFlight: false })).toBe(true);
  });

  it('does not hammer the server when the deadline could not be read', () => {
    expect(shouldRenew({ deadline: 0, now: NOW, inFlight: false })).toBe(false);
  });
});

describe('reading the deadline off a capability', () => {
  it('reads the expiry as milliseconds', () => {
    expect(capabilityDeadline(token({ exp: 1_786_000_900 }))).toBe(1_786_000_900_000);
  });

  /**
   * JWT payloads are base64url, and `atob` rejects `-` and `_`. Left unconverted, a token whose
   * payload happened to contain either would read as zero and that session would silently never
   * renew - a bug that appears for some tokens and not others.
   */
  it('reads a payload that uses the url-safe alphabet', () => {
    const payload = { exp: 1_786_000_900, sub: 'user-1', note: '???>>>' };
    const urlSafe = token(payload, true);
    expect(/[-_]/.test(urlSafe.split('.')[1] ?? '')).toBe(true);
    expect(capabilityDeadline(urlSafe)).toBe(1_786_000_900_000);
  });

  it('returns zero for anything it cannot read, rather than throwing into the socket handler', () => {
    expect(capabilityDeadline('')).toBe(0);
    expect(capabilityDeadline('not.a.token')).toBe(0);
    expect(capabilityDeadline(token({ sub: 'no expiry' }))).toBe(0);
  });
});
