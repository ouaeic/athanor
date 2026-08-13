/**
 * Reconnect pacing.
 *
 * Every box behind a relay loses its connection at the same instant when the relay restarts, so a
 * fixed or merely-exponential delay reconnects them all in the same millisecond and the relay falls
 * over again. Full jitter - a uniform draw from [0, cap] rather than a jittered band around it - is
 * what spreads a fleet out, and it is why the relay bothers to send `reconnectAfterMs` on GOAWAY.
 */
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 60_000;

export interface BackoffInput {
  /** Consecutive failures so far. Zero means this is the first retry. */
  readonly attempt: number;
  /** Floor requested by the relay in a GOAWAY, if any. Honoured even when it exceeds the cap. */
  readonly requestedMs?: number;
  /** Injected in tests. Must return a value in [0, 1). */
  readonly random?: () => number;
}

export const reconnectDelayMs = ({
  attempt,
  requestedMs,
  random = Math.random
}: BackoffInput): number => {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  const jittered = Math.floor(random() * exponential);
  if (requestedMs === undefined) return jittered;
  // A relay that says "come back in five minutes" is usually restarting or rate-limiting, and
  // ignoring it is how a reconnect storm starts. Spread arrivals across the window it asked for
  // rather than having every box return on the same millisecond it expires.
  const spread = Math.floor(random() * Math.min(MAX_DELAY_MS, Math.max(0, requestedMs)));
  return Math.max(0, requestedMs) + spread;
};
