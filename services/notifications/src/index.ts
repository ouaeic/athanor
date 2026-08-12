import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import webpush from 'web-push';
import {
  loadConfig,
  NOTIFICATION_HEALTH_HOST,
  NOTIFICATION_HEALTH_PORT,
  pushConfigured
} from './config.js';
import { notificationSubject, ownerPresent, ownerSettings, type PendingRow } from './context.js';
import type { OwnerNotificationSettings } from './model.js';
import { notificationPayload } from './payload.js';
import { deliveryDecision } from './policy.js';
import { backoffMs, EndpointHealth, endpointHost, isGone, RETRY_HORIZON_MS } from './retry.js';

const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
const deliveryEnabled = pushConfigured(config);
if (deliveryEnabled) {
  webpush.setVapidDetails(
    config.PUSH_VAPID_SUBJECT,
    config.PUSH_VAPID_PUBLIC_KEY,
    config.PUSH_VAPID_PRIVATE_KEY
  );
} else {
  // Stay up and report the reason. Exiting would crash-loop under systemd and make an optional
  // feature look like a broken installation; the health endpoint says plainly that it is off.
  process.stdout.write(
    'athanor notifications: no Web Push signing keys are configured, so delivery is disabled. ' +
      'Run the installer, or set PUSH_VAPID_SUBJECT, PUSH_VAPID_PUBLIC_KEY and ' +
      'PUSH_VAPID_PRIVATE_KEY in /etc/athanor/control.env to enable it.\n'
  );
}
let running = true;
let delivered = 0;
let failed = 0;
let suppressed = 0;
let retired = 0;
let deferred = 0;
const endpoints = new EndpointHealth();
const health = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `athanor_notifications_delivered_total ${delivered}\n` +
        `athanor_notifications_failed_total ${failed}\n` +
        `athanor_notifications_suppressed_total ${suppressed}\n` +
        `athanor_notifications_endpoints_retired_total ${retired}\n` +
        `athanor_notifications_endpoints_failing ${endpoints.failingCount}\n` +
        `athanor_notifications_deferred ${deferred}\n`
    );
    return;
  }
  response.setHeader('content-type', 'application/json');
  // `deliveryEnabled` is read by `athanor doctor`, which reports a service that is answering but
  // has no signing keys as a warning rather than as health. `endpointsFailing` is the same idea one
  // step further in: keys are configured, the service is sending, and a device is not receiving.
  // The one thing that cannot report a broken push is a push, so it is reported here, in the
  // journal, and in the owner's own security record - three places that do not need the phone.
  response.end(
    JSON.stringify({
      ok: true,
      service: 'notifications',
      deliveryEnabled,
      endpointsFailing: endpoints.failingCount,
      endpointsRetired: retired
    })
  );
});
health.listen(NOTIFICATION_HEALTH_PORT, NOTIFICATION_HEALTH_HOST);

const shutdown = () => {
  running = false;
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

/**
 * The ledger row that stops a notification firing twice is keyed by subscription, kind and
 * resource, so it is also the only way to record "this one will never be sent". Writing it for a
 * dropped item is deliberate: without it, a message the owner has already read on screen — or has
 * switched off entirely — would be re-examined on every pass for as long as the row exists.
 */
const settle = async (row: PendingRow): Promise<void> => {
  await store.recordNotificationDelivery(row.id, row.kind, row.resourceId);
};

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

/**
 * How far past the batch size a sweep may reach to get round endpoints that are waiting.
 *
 * The wait lives in this process and the batch is chosen by a query, which cannot see it - so a
 * hundred items belonging to one refusing endpoint still fill the page they are ordered to the
 * front of, and skipping them cheaply is not the same as getting past them. Asking for as many
 * extra rows as were skipped last time restores a full batch of deliverable work behind them. It is
 * bounded because the honest version of this is a predicate in the query, which is in the handoff;
 * this is what keeps the queue moving until that lands.
 */
const MAX_DEFERRED_PAGE_ROOM = 400;

while (running) {
  // With no signing keys there is nothing that could be delivered, so the loop idles rather than
  // querying the database twice a second forever.
  if (!deliveryEnabled) {
    await delay(config.NOTIFICATION_POLL_MS);
    continue;
  }
  const pending: PendingRow[] = await store
    .listPendingNotifications(
      config.NOTIFICATION_BATCH_SIZE + Math.min(deferred, MAX_DEFERRED_PAGE_ROOM)
    )
    .catch(() => []);
  if (!pending.length) {
    deferred = 0;
    await delay(config.NOTIFICATION_POLL_MS);
    continue;
  }
  const now = new Date();
  let deferredThisSweep = 0;
  // One owner, one set of switches, one presence answer — resolved once per pass rather than once
  // per subscription, which for a household of devices is the difference between one query and ten.
  const settingsByUser = new Map<string, OwnerNotificationSettings>();
  const presenceByUser = new Map<string, boolean>();
  for (const item of pending) {
    // An endpoint inside its wait costs nothing here: no request, no ten-second timeout, and no
    // place at the front of the queue. Nothing is settled and nothing is lost - the item is simply
    // considered again once the wait is over.
    if (endpoints.waiting(item.id, new Date())) {
      deferredThisSweep += 1;
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
        suppressed += 1;
        continue;
      }
      if (decision.action === 'drop') {
        suppressed += 1;
        await settle(item);
        continue;
      }

      // Only what the push service does counts against the push service. Everything above this
      // point is a database read of the owner's own rows, and a failure there says nothing about
      // the far end and must not put a working device into a wait.
      sending = true;
      // Bounded. A push endpoint is a third party's server on the far side of the internet, and
      // without a timeout one that accepts the connection and then says nothing holds this loop -
      // and therefore every other device's notification behind it - until the socket gives up on
      // its own, which can be minutes.
      await webpush.sendNotification(
        { endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
        JSON.stringify(notificationPayload(subject)),
        {
          TTL: 600,
          urgency: item.kind === 'approval_required' ? 'high' : 'normal',
          timeout: 10_000
        }
      );
      sending = false;
      await settle(item);
      delivered += 1;
      // One delivery is proof the endpoint is back, so it starts again from no failures at all.
      endpoints.succeeded(item.id);
    } catch (error) {
      failed += 1;
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

      const outcome = endpoints.failed(item.id, statusCode, new Date());
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
        retired += 1;
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
        process.stderr.write(
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
        process.stderr.write(
          `athanor-notifications: ${host} refused a notification${status}; nothing is lost and it will be tried again in ${Math.round(backoffMs(outcome.state.attempts) / 60_000)} min, backing off to ${Math.round(RETRY_HORIZON_MS / 3_600_000)}h before that device is retired\n`
        );
      }
    }
  }
  deferred = deferredThisSweep;
  // A sweep with nothing left to attempt waits, rather than reselecting the same waiting rows as
  // fast as the database will answer. Everything else falls straight through to the next batch,
  // which is what drains a backlog quickly.
  if (deferredThisSweep === pending.length) await delay(config.NOTIFICATION_POLL_MS);
}

await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
