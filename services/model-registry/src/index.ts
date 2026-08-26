import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { decodeMasterKey } from '@athanor/core';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { epochSeconds, readCatalogRecord, writeCatalogRecord } from './catalog-state.js';
import { catalogueFrozenLine, refreshFailureReason, refreshLogLine } from './refresh-log.js';
import { refreshOnce } from './refresh-once.js';

const Config = z.object({
  DATABASE_DRIVER: z.enum(['pglite', 'postgres']).default('postgres'),
  DATABASE_URL: z.string().default('postgres://athanor:athanor@localhost:5432/athanor'),
  PGLITE_PATH: z.string().default('.athanor/postgres'),
  REGISTRY_REFRESH_SECONDS: z.coerce.number().int().min(60).default(3600),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_REGISTRY_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.string().min(1).optional()
  ),
  /**
   * Optional here alone. Every other service refuses to start without it because it cannot do its
   * job at all; this one can still seed an empty catalogue, and a developer running the loop
   * against a scratch database should not have to hold the owner's key to do it.
   */
  DATA_MASTER_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.string().min(1).optional()
  ),
  MODEL_CATALOG_SCOPE: z
    .enum(['provider_catalog', 'reviewed_open_weight'])
    .default('provider_catalog'),
  /**
   * Where each pass writes down what it did, for `athanor doctor` to read. The default is inside
   * /var/lib/athanor-control because that is the one directory `athanor@.service` may write to.
   * `doctor` reads the same variable out of control.env, so an operator who moves the file moves
   * both halves at once.
   */
  MODEL_CATALOG_STATE_PATH: z.string().default('/var/lib/athanor-control/model-catalog.state')
});
const config = Config.parse(process.env);
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
const masterKey = config.DATA_MASTER_KEY ? decodeMasterKey(config.DATA_MASTER_KEY) : null;
/*
 * Shutting down means waking up, not just being told.
 *
 * Almost all of this service's life is the hour it spends asleep between refreshes, and a flag set
 * by the signal handler is not read until that hour is over. So every restart - and every update,
 * which restarts each service in turn - waited out `TimeoutStopSec` and then killed it: thirty
 * seconds of the outage the owner is watching, spent on a process that had nothing to finish.
 */
let running = true;
const shutdown = new AbortController();
const stop = (): void => {
  running = false;
  shutdown.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let consecutiveFailures = 0;
let frozenSaid = false;
let stateWriteSaid = false;
/*
 * When a provider last answered, held here as well as in the record on disk. The file is the
 * durable copy and survives the restart this process gets on every update; this one covers the
 * hour after a pass that could not write it, so a directory that was briefly unwritable does not
 * make the next pass report a catalogue that has never refreshed.
 */
let lastRefreshEpoch = 0;

while (running) {
  const previous = await readCatalogRecord(config.MODEL_CATALOG_STATE_PATH);
  const outcome = await refreshOnce({
    store,
    masterKey,
    environmentKey: config.OPENROUTER_REGISTRY_KEY,
    baseUrl: config.OPENROUTER_BASE_URL,
    scope: config.MODEL_CATALOG_SCOPE
  });
  // The journal is the whole of the observation this box has: one owner, no alerting, and this
  // service has no endpoint to ask. Silence would make a catalogue that stopped changing
  // indistinguishable from a provider that shipped nothing, so the first failure and the recovery
  // are both said once, in `athanor logs registry` - and so is the state where there is nothing to
  // refresh from at all, which used to be the one silence nobody could tell from health.
  const line = refreshLogLine({
    previousFailures: consecutiveFailures,
    reason: outcome.reason,
    intervalSeconds: config.REGISTRY_REFRESH_SECONDS
  });
  if (line) process.stderr.write(line);
  consecutiveFailures = outcome.reason === null ? 0 : consecutiveFailures + 1;
  const previousRefresh = Math.max(previous?.lastRefreshEpoch ?? 0, lastRefreshEpoch);
  const frozen = catalogueFrozenLine({
    alreadySaid: frozenSaid,
    state: outcome.state,
    models: outcome.models,
    lastRefreshAt: previousRefresh ? new Date(previousRefresh * 1000) : null
  });
  if (frozen) process.stderr.write(frozen);
  frozenSaid = outcome.state === 'refreshed' ? false : frozenSaid || frozen !== null;
  const checkedAtEpoch = epochSeconds(new Date());
  // Only a provider answering moves this. A pass that failed, or had no key to try, leaves it
  // where it was - that is the whole point of recording it, and it is what tells the owner how
  // long the catalogue in front of them has actually been standing still.
  lastRefreshEpoch = outcome.state === 'refreshed' ? checkedAtEpoch : previousRefresh;
  try {
    await writeCatalogRecord(config.MODEL_CATALOG_STATE_PATH, {
      checkedAtEpoch,
      lastRefreshEpoch,
      state: outcome.state,
      models: outcome.models,
      intervalSeconds: config.REGISTRY_REFRESH_SECONDS,
      reason: outcome.reason
    });
    stateWriteSaid = false;
  } catch (error) {
    // Once, at the same cadence as everything else here. A refresh loop must not stop refreshing
    // because it could not write a file it keeps only for somebody else to read, but a silent
    // failure here is a `doctor` check that reports a stale catalogue for ever after.
    if (!stateWriteSaid) {
      process.stderr.write(
        `athanor model registry: the refresh record could not be written to ` +
          `${config.MODEL_CATALOG_STATE_PATH} (${refreshFailureReason(error)}), so ` +
          `sudo athanor doctor cannot tell a current catalogue from one that stopped refreshing.\n`
      );
      stateWriteSaid = true;
    }
  }
  await delay(config.REGISTRY_REFRESH_SECONDS * 1000, undefined, {
    signal: shutdown.signal
  }).catch(() => undefined);
}
await database.close();
