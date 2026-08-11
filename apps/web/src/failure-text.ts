/**
 * One sentence for a failure, in this product's own voice.
 *
 * Roughly twenty call sites wrote `cause instanceof Error ? cause.message : 'Could not X'`. A
 * dropped connection throws a `TypeError` from `fetch`, which satisfies `instanceof Error`, so the
 * carefully written fallback was never reached on the one failure the owner hits most: what
 * actually appeared was the browser's own string — "Load failed" on Safari, "Failed to fetch" on
 * Chrome. This maps the transport failures to something that says what happened and what to do,
 * and passes a real server message through untouched.
 */

/** True when the failure is the network rather than the box. */
export const isTransportFailure = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { name?: unknown; message?: unknown; status?: unknown };
  // An ApiFailure always carries a status, so a real HTTP answer is never mistaken for a blip.
  if (typeof error.status === 'number' && error.status > 0) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error.name !== 'TypeError') return false;
  return typeof error.message === 'string';
};

/**
 * The offline sentence, owned here.
 *
 * It was written out character-for-character in two modules and said a third way in a third, which
 * is three places for one fact to drift apart. Everything that has to say the box is unreachable
 * imports this.
 */
export const UNREACHABLE =
  'Your athanor is not reachable right now. It keeps working; this device will reconnect.';

export const describeFailure = (cause: unknown, fallback: string): string => {
  if (isTransportFailure(cause)) return UNREACHABLE;
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
};
