import type { DataStore } from '@athanor/data';
import { notificationSubject, ownerPresent, ownerSettings, type PendingRow } from './context.js';
import type { OwnerNotificationSettings } from './model.js';
import { notificationPayload, type PushPayload } from './payload.js';
import { deliveryDecision } from './policy.js';
import { backoffMs, endpointHost, isGone, RETRY_HORIZON_MS, type EndpointHealth } from './retry.js';

/**
 * How far past the batch size a sweep may reach to get round endpoints that are waiting.
 *
 * The wait lives in this process and the batch is chosen by a query, which cannot see it - so a
 * hundred items belonging to one refusing endpoint still fill the page they are ordered to the
 * front of, and skipping them cheaply is not the same as getting past them. Asking for as many
 * extra rows as were skipped last time restores a full batch of deliverable work behind them. It is
 * bounded because the honest version of this is a predicate in the query, which is in the handoff;
 * this is what keeps the queue moving until that lands.
 *
 * A hold does not widen the page and deliberately so. An endpoint wait is a fact about one device,
 * so the rows behind it are ordinary work; a hold is a decision about the owner - they are at the
 * keyboard, or it is the middle of their night - and it is the same decision for every row of that
 * kind on that pass, so reaching further would only return more rows that hold too.
 */
export const MAX_DEFERRED_PAGE_ROOM = 400;

/** What one push needs from the transport, so the loop can be tested without a push service. */
export type SendNotification = (row: PendingRow, payload: PushPayload) => Promise<void>;

export interface SweepInput {
  store: DataStore;
  /**
   * The owner's key, or undefined on a box that has none.
   *
   * This is the whole difference between a notification that says which conversation it is about
   * and one that says "Untitled conversation". The data layer is the only place holding both the
   * envelope and the key, so the title and the agent's sentence are unwrapped there and arrive on
   * the row already in the clear - which only happens if the key gets this far.
   */
  masterKey: Uint8Array | undefined;
  endpoints: EndpointHealth;
  batchSize: number;
  /** Endpoint waits carried over from the previous pass, which widen this one's page. */
  deferredLastSweep: number;
  /**
   * Shutdown, checked between items and nowhere else.
   *
   * A full batch is a hundred serial sends, each with a ten-second ceiling, so a pass that meets a
   * push service which accepts the connection and then says nothing can run for minutes - longer
   * than the thirty seconds `athanor@.service` gives a stop before it sends SIGKILL. Two things
   * follow, and only the second is a defect: every `athanor restart` and every update pays that
   * thirty seconds, and the kill can land in the gap between a push that was sent and the ledger
   * row recording it was sent, so the owner gets that notification a second time on the next start.
   * Checking here - at an item boundary, never inside one - closes both without abandoning work.
   */
  signal?: AbortSignal;
  send: SendNotification;
  now?: () => Date;
  /** The journal. Separated so a test can read what an owner at the box would have read. */
  warn?: (line: string) => void;
}

export interface SweepResult {
  /** Rows the query returned, before anything was decided about them. */
  pending: number;
  delivered: number;
  failed: number;
  suppressed: number;
  retired: number;
  /** Endpoints inside their wait: nothing attempted, and the only thing that widens the next page. */
  deferred: number;
  /** Decisions to hold: nothing sent, nothing settled, reconsidered on a later pass. */
  held: number;
  /**
   * Nothing in this batch could be attempted, so the caller must wait before asking again.
   *
   * A sweep whose whole batch was held used to leave this false, because only endpoint waits were
   * counted - so the loop re-issued the four-branch UNION as fast as PostgreSQL would answer it,
   * for as long as the owner kept a tab open or their quiet hours lasted. Nine hours of a hot loop
   * on a machine whose whole point is running unattended, with an inflating suppressed counter on
   * a loopback metrics port as the only sign of it.
   */
  idle: boolean;
}

/**
 * The ledger row that stops a notification firing twice is keyed by subscription, kind and
 * resource, so it is also the only way to record "this one will never be sent". Writing it for a
 * dropped item is deliberate: without it, a message the owner has already read on screen — or has
 * switched off entirely — would be re-examined on every pass for as long as the row exists.
 */
const settle = (store: DataStore, row: PendingRow): Promise<void> =>
  store.recordNotificationDelivery(row.id, row.kind, row.resourceId);

/**
 * A write that records a failure must not be able to end the loop.
 *
 * These run inside the handler for a delivery that already went wrong, and an exception thrown
 * there escapes the batch, escapes the while, and stops the service - turning one refusing push
 * service into no notifications at all. The journal line beside each of them is the record that
 * survives a database that will not take the write.
 */
const bestEffort = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined
  );

/** One pass over everything waiting to be told to a device that has not been told it yet. */
export const runSweep = async (input: SweepInput): Promise<SweepResult> => {
  const { store, endpoints, send } = input;
  const clock = input.now ?? (() => new Date());
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const result: SweepResult = {
    pending: 0,
    delivered: 0,
    failed: 0,
    suppressed: 0,
    retired: 0,
    deferred: 0,
    held: 0,
    idle: true
  };

  const pending: PendingRow[] = await store
    .listPendingNotifications(
      input.batchSize + Math.min(input.deferredLastSweep, MAX_DEFERRED_PAGE_ROOM),
      input.masterKey
    )
    .catch(() => []);
  result.pending = pending.length;
  if (!pending.length) return result;

  const now = clock();
  // One owner, one set of switches, one presence answer — resolved once per pass rather than once
  // per subscription, which for a household of devices is the difference between one query and ten.
  const settingsByUser = new Map<string, OwnerNotificationSettings>();
  const presenceByUser = new Map<string, boolean>();
  for (const item of pending) {
    // Told to stop. Nothing in this batch is settled or lost by leaving now - an item that was not
    // reached has no delivery record, so the next start considers it again - and leaving between
    // items is the only place where that is true.
    if (input.signal?.aborted) break;
    // An endpoint inside its wait costs nothing here: no request, no ten-second timeout, and no
    // place at the front of the queue. Nothing is settled and nothing is lost - the item is simply
    // considered again once the wait is over.
    if (endpoints.waiting(item.id, clock())) {
      result.deferred += 1;
      continue;
    }
    let sending = false;
    try {
      let settings = settingsByUser.get(item.userId);
      if (!settings) {
        settings = await ownerSettings(store, item.userId);
        settingsByUser.set(item.userId, settings);
      }
      let present = presenceByUser.get(item.userId);
      if (present === undefined) {
        present = await ownerPresent(store, item.userId, now);
        presenceByUser.set(item.userId, present);
      }

      const { subject, eventAt } = await notificationSubject(store, item);
      const decision = deliveryDecision({
        kind: item.kind,
        settings,
        ownerPresent: present,
        eventAt,
        now
      });
      if (decision.action === 'hold') {
        result.suppressed += 1;
        result.held += 1;
        continue;
      }
      if (decision.action === 'drop') {
        result.suppressed += 1;
        await settle(store, item);
        continue;
      }

      // Only what the push service does counts against the push service. Everything above this
      // point is a database read of the owner's own rows, and a failure there says nothing about
      // the far end and must not put a working device into a wait.
      sending = true;
      await send(item, notificationPayload(subject));
      sending = false;
      await settle(store, item);
      result.delivered += 1;
      // One delivery is proof the endpoint is back, so it starts again from no failures at all.
      endpoints.succeeded(item.id);
    } catch (error) {
      result.failed += 1;
      // Not the endpoint's doing: retried on the next sweep, holding nothing against the device.
      if (!sending) continue;
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number(error.statusCode)
          : 0;
      const host = endpointHost(item.endpoint);
      // The far end saying the subscription is gone. Nothing to wait for and nothing to tell the
      // owner: a device that unsubscribed, or a browser profile that was cleared, is ordinary.
      if (isGone(statusCode)) {
        endpoints.forget(item.id);
        await bestEffort(store.deletePushSubscriptionById(item.id));
        continue;
      }

      const outcome = endpoints.failed(item.id, statusCode, clock());
      const status = statusCode ? ` (HTTP ${statusCode})` : '';
      if (outcome.exhausted) {
        /*
         * A day of refusals, so this endpoint is not coming back and every notification queued
         * behind it has been waiting on something that cannot happen. Retiring it removes its
         * candidates; it writes no delivery record, so nothing is marked sent that was not, and
         * everything the owner should have been told is still in the conversation it belongs to
         * and in the standing list of what the agent has raised.
         */
        endpoints.forget(item.id);
        await bestEffort(store.deletePushSubscriptionById(item.id));
        result.retired += 1;
        await bestEffort(
          store.recordSecurityEvent({
            userId: item.userId,
            kind: 'push_endpoint_retired',
            outcome: 'failure',
            // The push service and the code it answered with. The rest of the endpoint is the
            // secret that authorises sending to that device and never leaves this process.
            metadata: { host, statusCode, attempts: outcome.state.attempts }
          })
        );
        warn(
          `athanor-notifications: ${host} has refused every notification for ${Math.round(RETRY_HORIZON_MS / 3_600_000)}h${status}; that device has been retired and will not be tried again. Turn notifications on again on the device to restore it\n`
        );
        continue;
      }

      if (outcome.first) {
        /*
         * Said out loud once, when an endpoint starts failing rather than on every refusal.
         *
         * The only record of a failure was `failed`, a counter on a metrics port bound to loopback
         * - so a device whose notifications had silently stopped working looked exactly like a
         * device nothing had happened on, and the owner's first clue was noticing they had stopped
         * arriving. A push cannot report that pushes are not arriving, so it is written where the
         * owner can find it without one: the journal for whoever is at the box, and the security
         * record, which is theirs and travels in the privacy export.
         */
        await bestEffort(
          store.recordSecurityEvent({
            userId: item.userId,
            kind: 'push_delivery_failing',
            outcome: 'failure',
            metadata: { host, statusCode }
          })
        );
        warn(
          `athanor-notifications: ${host} refused a notification${status}; nothing is lost and it will be tried again in ${Math.round(backoffMs(outcome.state.attempts) / 60_000)} min, backing off to ${Math.round(RETRY_HORIZON_MS / 3_600_000)}h before that device is retired\n`
        );
      }
    }
  }

  // A sweep with nothing left to attempt waits, rather than reselecting the same rows as fast as
  // the database will answer. Everything else falls straight through to the next batch, which is
  // what drains a backlog quickly.
  result.idle = result.deferred + result.held === pending.length;
  return result;
};
