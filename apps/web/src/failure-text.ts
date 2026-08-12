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

/**
 * The box answered and the software behind it did not.
 *
 * Its own sentence rather than `UNREACHABLE`, because the two failures are not the same fact and
 * one of them cannot honestly carry the other's reassurance. A dropped connection leaves the box
 * working and unobserved, which is what "it keeps working" is telling the owner. A gateway status
 * is the opposite: something on the box answered to say the application is not there, so claiming
 * it keeps working would be the interface asserting something it has just been told otherwise.
 *
 * What it is is almost always a restart - nginx and the application are separate units, so the
 * proxy stays up across an update, a reboot and a crash while the thing behind it is briefly gone.
 * That is worth saying, because the owner's next move is to wait rather than to go and look.
 */
export const RESTARTING =
  'Your athanor answered, but the software on it is not up yet. That normally means it is ' +
  'restarting; this device will keep trying.';

/**
 * True when the answer came from in front of the application rather than from it.
 *
 * The status alone is not enough: athanor's own API returns 503 for a route whose dependency is
 * genuinely missing, and those answers carry a written explanation that is better than anything
 * here. The pairing is what identifies a gateway - a proxy answers with HTML, `request` fails to
 * parse it and mints `request_failed`, and that code exists nowhere else.
 */
const isGatewayFailure = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { code?: unknown; status?: unknown };
  return (
    error.code === 'request_failed' &&
    (error.status === 502 || error.status === 503 || error.status === 504)
  );
};

export const describeFailure = (cause: unknown, fallback: string): string => {
  if (isTransportFailure(cause)) return UNREACHABLE;
  if (isGatewayFailure(cause)) return RESTARTING;
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
};
