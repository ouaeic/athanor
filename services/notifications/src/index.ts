import { createServer } from 'node:http';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import webpush from 'web-push';
import {
  loadConfig,
  masterKeyBytes,
  NOTIFICATION_HEALTH_HOST,
  NOTIFICATION_HEALTH_PORT,
  pushConfigured
} from './config.js';
import { createNotifier } from './loop.js';
import { EndpointHealth } from './retry.js';
import { runSweep } from './sweep.js';

const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
/*
 * Held for the length of the process and handed to exactly one call: the query that selects what
 * is waiting to be sent. Nothing else in this service touches it, and no ciphertext is unwrapped
 * here - the data layer is the only place holding both the envelope and the key.
 */
const masterKey = masterKeyBytes(config);
if (!masterKey) {
  // Not fatal, and worth saying once. Without it every notification this box sends is titled
  // "Untitled conversation", which looks to an owner like a bug in the wording rather than a
  // missing line in control.env.
  process.stdout.write(
    'athanor notifications: no DATA_MASTER_KEY is configured, so notifications cannot name the ' +
      'conversation they are about and will be titled "Untitled conversation". Set DATA_MASTER_KEY ' +
      'in /etc/athanor/control.env to the same value the API and worker use.\n'
  );
}
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
const endpoints = new EndpointHealth();
/*
 * Built before the health server so the metrics handler can read live counters off it, and the
 * signal handler can stop it. Everything about the loop's shape - what it does with no signing
 * keys, and how quickly it notices a SIGTERM - is stated and tested in `loop.ts`.
 */
const shutdown = new AbortController();
const notifier = createNotifier({
  pollMs: config.NOTIFICATION_POLL_MS,
  deliveryEnabled,
  signal: shutdown.signal,
  sweep: (deferredLastSweep) =>
    runSweep({
      store,
      masterKey,
      endpoints,
      batchSize: config.NOTIFICATION_BATCH_SIZE,
      deferredLastSweep,
      signal: shutdown.signal,
      send: (row, payload) =>
        // Bounded. A push endpoint is a third party's server on the far side of the internet, and
        // without a timeout one that accepts the connection and then says nothing holds this loop -
        // and therefore every other device's notification behind it - until the socket gives up on
        // its own, which can be minutes.
        webpush
          .sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify(payload),
            {
              TTL: 600,
              urgency: row.kind === 'approval_required' ? 'high' : 'normal',
              timeout: 10_000
            }
          )
          .then(() => undefined)
    })
});
const health = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `athanor_notifications_delivered_total ${notifier.totals.delivered}\n` +
        `athanor_notifications_failed_total ${notifier.totals.failed}\n` +
        `athanor_notifications_suppressed_total ${notifier.totals.suppressed}\n` +
        `athanor_notifications_endpoints_retired_total ${notifier.totals.retired}\n` +
        `athanor_notifications_endpoints_failing ${endpoints.failingCount}\n` +
        `athanor_notifications_deferred ${notifier.totals.deferred}\n` +
        // Told apart from `deferred` deliberately: a deferral is a device that will not take a
        // push right now, a hold is the owner being at the keyboard or asleep. A rising
        // `suppressed_total` beside a flat `held` is the service dropping notifications on
        // purpose; beside a standing `held` it is the same few items waiting for a person.
        `athanor_notifications_held ${notifier.totals.held}\n`
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
      // Served for the same reason as `deliveryEnabled`: the symptom on the phone - every
      // notification titled "Untitled conversation" - looks like a wording bug rather than the
      // missing line in control.env that it is, so it has to be answerable without a push.
      // `athanor doctor` reads `deliveryEnabled` and `endpointsFailing` from here today and does
      // not yet read this one; the journal line at startup is the record until it does.
      titlesReadable: Boolean(masterKey),
      endpointsFailing: endpoints.failingCount,
      endpointsRetired: notifier.totals.retired
    })
  );
});
health.listen(NOTIFICATION_HEALTH_PORT, NOTIFICATION_HEALTH_HOST);

// Aborting rather than setting a flag: the loop is asleep for almost all of its life, and a flag is
// not read until the sleep is over. See the note on the poll delay in `loop.ts`.
const stop = () => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await notifier.run();

await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
