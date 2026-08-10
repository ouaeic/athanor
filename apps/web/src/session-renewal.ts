/**
 * When a live session should ask for a fresh capability.
 *
 * This was a condition inside a socket closure, which is why it went wrong twice without any test
 * noticing: the runner's half was covered, the decision that has to reach it was not. It is a pure
 * function of the deadline and the clock, so it can be.
 *
 * The shape it has to satisfy: renew well before expiry, keep trying if an attempt fails, never
 * stack attempts, and - the one that actually bit - leave enough room that a browser throttling
 * timers in a hidden tab still gets several chances rather than one.
 */
export interface RenewalWindow {
  /** When the current capability dies, in epoch milliseconds. Zero when it could not be read. */
  readonly deadline: number;
  readonly now: number;
  /** Whether a renewal is already in flight, so a slow answer does not start a second. */
  readonly inFlight: boolean;
}

/**
 * A third of a fifteen-minute capability. With a one-minute check that is five chances before
 * expiry, so a tab throttled to one timer a minute - or woken late - still renews in time.
 */
export const RENEW_WITHIN_MS = 300_000;

export const shouldRenew = (window: RenewalWindow): boolean => {
  if (window.inFlight) return false;
  // An unreadable deadline is not a reason to hammer the server every tick; the session will close
  // on its own deadline and reconnecting is the honest recovery.
  if (!window.deadline) return false;
  return window.deadline - window.now <= RENEW_WITHIN_MS;
};

/**
 * The deadline carried by a capability token, in epoch milliseconds, or zero if it cannot be read.
 *
 * The payload is base64url, which `atob` does not accept: a token whose payload happens to contain
 * `-` or `_` would throw, the deadline would read zero, and the session would quietly never renew.
 * That is a bug that only appears for some tokens, which is the worst kind, so the conversion is
 * done rather than hoped for.
 */
export const capabilityDeadline = (token: string): number => {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
};
