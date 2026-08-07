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
const health = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `athanor_notifications_delivered_total ${delivered}\n` +
        `athanor_notifications_failed_total ${failed}\n` +
        `athanor_notifications_suppressed_total ${suppressed}\n`
    );
    return;
  }
  response.setHeader('content-type', 'application/json');
  // `deliveryEnabled` is read by `athanor doctor`, which reports a service that is answering but
  // has no signing keys as a warning rather than as health.
  response.end(JSON.stringify({ ok: true, service: 'notifications', deliveryEnabled }));
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

while (running) {
  // With no signing keys there is nothing that could be delivered, so the loop idles rather than
  // querying the database twice a second forever.
  if (!deliveryEnabled) {
    await delay(config.NOTIFICATION_POLL_MS);
    continue;
  }
  const pending: PendingRow[] = await store
    .listPendingNotifications(config.NOTIFICATION_BATCH_SIZE)
    .catch(() => []);
  if (!pending.length) {
    await delay(config.NOTIFICATION_POLL_MS);
    continue;
  }
  const now = new Date();
  // One owner, one set of switches, one presence answer — resolved once per pass rather than once
  // per subscription, which for a household of devices is the difference between one query and ten.
  const settingsByUser = new Map<string, OwnerNotificationSettings>();
  const presenceByUser = new Map<string, boolean>();
  for (const item of pending) {
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
      await settle(item);
      delivered += 1;
    } catch (error) {
      failed += 1;
      const statusCode =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number(error.statusCode)
          : 0;
      if (statusCode === 404 || statusCode === 410) {
        await store.deletePushSubscriptionById(item.id);
      } else {
        /*
         * Said out loud, once per run, per endpoint.
         *
         * The only record of a failure was `failed`, a counter on a metrics port bound to loopback
         * - so a device whose notifications had silently stopped working looked exactly like a
         * device nothing had happened on, and the owner's first clue was noticing they had stopped
         * arriving. The host is enough to identify which push service is refusing without putting
         * the endpoint's secret path in the journal.
         */
        let host = 'the push service';
        try {
          host = new URL(item.endpoint).host;
        } catch {
          // An endpoint that will not parse is worth reporting as much as one that will.
        }
        process.stderr.write(
          `athanor-notifications: ${host} refused a notification${statusCode ? ` (HTTP ${statusCode})` : ''}; it stays queued and will be retried\n`
        );
      }
    }
  }
}

await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
