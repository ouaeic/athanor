/**
 * When to try a push endpoint again after it refused one, and when to stop trying it at all.
 *
 * A push endpoint is a third party's server, and the interesting failures are neither success nor
 * "this device is gone": a rate limit, a bad gateway, a signing key the service no longer accepts.
 * None of those settle the notification and none of them change the order it is selected in, so
 * without a clock of their own the item is picked up again on the very next sweep, refuses again,
 * spends the whole delivery timeout doing it, and does that ahead of every notification queued
 * behind it - which is every other device's, because the sweep is serial and oldest first.
 *
 * So a refusal is given a time it may next be attempted, and that time is kept against the
 * endpoint rather than against the item: when a push service is refusing, it is refusing all of
 * them, and one wait is the truth about all of them.
 */

/** The first wait after a refusal. Long enough to outlast a rate limit, short enough to be a blip. */
export const RETRY_BASE_MS = 60_000;

/**
 * The longest wait between attempts. A half hour keeps a service that is having a bad afternoon at
 * forty-eight pointless attempts a day instead of forty-three thousand, and still delivers within
 * half an hour of it coming back.
 */
export const RETRY_CEILING_MS = 30 * 60_000;

/**
 * How long an endpoint may go on refusing before it is retired.
 *
 * A day is past every outage that is going to end. What is left is a subscription that will never
 * accept another notification - a browser profile deleted without unsubscribing, a signing key
 * rotated out from under it - and retrying that forever is how the queue fills with work that
 * cannot succeed. Retiring writes no delivery record, so nothing is marked as sent that was not.
 */
export const RETRY_HORIZON_MS = 24 * 60 * 60_000;

/**
 * The far end saying this subscription no longer exists. It is the one answer that is about the
 * subscription rather than about the moment, so it retires the endpoint immediately rather than
 * waiting out the horizon.
 */
export const isGone = (statusCode: number): boolean => statusCode === 404 || statusCode === 410;

/** Doubling from a minute, levelling off at the ceiling. */
export const backoffMs = (attempts: number): number =>
  Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export interface EndpointState {
  /** Consecutive refusals. Reset by a delivery, because one success means the endpoint is back. */
  attempts: number;
  /** When this run of refusals started, which is what the horizon is measured from. */
  firstFailedAt: number;
  /** Not before this instant. */
  retryAt: number;
  /** The last HTTP status the endpoint answered with, 0 when it never answered. */
  lastStatus: number;
}

export interface FailureOutcome {
  state: EndpointState;
  /** True on the refusal that starts a run, which is the one worth telling the owner about. */
  first: boolean;
  /** True once the endpoint has been refusing for longer than the horizon: retire it. */
  exhausted: boolean;
}

/**
 * Which endpoints are currently refusing, and until when.
 *
 * Held in memory, so a restart clears it and every endpoint is tried once more. That is the safe
 * direction to be wrong in - it costs one attempt and can never lose a notification - but it does
 * mean the wait is invisible to the query that selects the batch, which is what `deferred` below
 * exists to compensate for until that predicate is in the database. See the handoff.
 */
export class EndpointHealth {
  private readonly failing = new Map<string, EndpointState>();

  /** True while this endpoint is inside its wait, so nothing should be sent to it. */
  waiting(subscriptionId: string, now: Date): boolean {
    const state = this.failing.get(subscriptionId);
    return state !== undefined && now.getTime() < state.retryAt;
  }

  /** A delivery got through: the endpoint is healthy and starts again from nothing. */
  succeeded(subscriptionId: string): void {
    this.failing.delete(subscriptionId);
  }

  failed(subscriptionId: string, statusCode: number, now: Date): FailureOutcome {
    const previous = this.failing.get(subscriptionId);
    const attempts = (previous?.attempts ?? 0) + 1;
    const firstFailedAt = previous?.firstFailedAt ?? now.getTime();
    const state: EndpointState = {
      attempts,
      firstFailedAt,
      retryAt: now.getTime() + backoffMs(attempts),
      lastStatus: statusCode
    };
    this.failing.set(subscriptionId, state);
    return {
      state,
      first: previous === undefined,
      exhausted: now.getTime() - firstFailedAt >= RETRY_HORIZON_MS
    };
  }

  /** The endpoint is gone from the database, so its history here is meaningless. */
  forget(subscriptionId: string): void {
    this.failing.delete(subscriptionId);
  }

  /** How many endpoints are currently refusing, which is what health and metrics report. */
  get failingCount(): number {
    return this.failing.size;
  }
}

/**
 * The host of a push endpoint, for a journal line or an owner-readable record.
 *
 * Which push service is refusing is the part that identifies the failure; the rest of the URL is
 * the secret that authorises sending to that device, and it never leaves this process.
 */
export const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    // An endpoint that will not parse is worth reporting as much as one that will.
    return 'the push service';
  }
};
