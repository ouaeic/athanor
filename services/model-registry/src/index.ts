import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ModelRelease } from '@athanor/contracts';
import { decodeMasterKey } from '@athanor/core';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { refreshOpenRouterCatalog, seedModels } from '@athanor/model-gateway';
import { catalogCredential } from './catalog-credential.js';
import { refreshFailureReason, refreshLogLine } from './refresh-log.js';

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
    .default('provider_catalog')
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
let running = true;
process.once('SIGINT', () => {
  running = false;
});
process.once('SIGTERM', () => {
  running = false;
});

let consecutiveFailures = 0;

while (running) {
  // The default scope offers whatever the owner's own provider account can reach, so a model
  // released after this build still appears without a code change. `reviewed_open_weight`
  // restores the stricter allowlist. A refresh failure preserves the previous catalog rather
  // than weakening privacy requirements or emptying the model picker.
  let reason: string | null = null;
  try {
    const credential = await catalogCredential({
      store,
      masterKey,
      environmentKey: config.OPENROUTER_REGISTRY_KEY
    });
    const existing = await store.listModels();
    if (credential) {
      // A real refresh, and a replace rather than an upsert: a model the provider has withdrawn
      // should leave the picker rather than sit in it until somebody tries to use it.
      await store.replaceModelCatalog(
        await refreshOpenRouterCatalog(seedModels(), {
          baseUrl: credential.baseUrl ?? config.OPENROUTER_BASE_URL,
          apiKey: credential.apiKey,
          scope: config.MODEL_CATALOG_SCOPE,
          /*
           * What the catalogue said an hour ago, so one failing request cannot withdraw the owner's
           * private routes. Zero-retention is a fact about live endpoints and it arrives on its own
           * request; when that request alone fails, the answer carried forward is the last one this
           * box actually observed rather than "not verified", which the privacy projection would
           * read as a reason to take every private model out of the picker.
           */
          previous: existing.flatMap((model) => {
            const parsed = ModelRelease.safeParse(model);
            return parsed.success ? [parsed.data] : [];
          })
        })
      );
    } else if (!existing.length) {
      /*
       * No key, so there is nothing to refresh from — but an empty catalogue still needs something
       * in it, and this is the only thing that puts it there on a new box.
       *
       * It used to write the seed on every pass regardless. No shipped path sets a registry key, so
       * within an hour of finishing setup the static seed landed on top of the catalogue the API
       * had enriched from the owner's own provider account: the curated models went back to
       * availability 'review' and lost their prices, which took them out of the picker and made any
       * task or schedule pinned to one fail with model_unavailable. The owner's fix was to re-save
       * their provider key, and an hour later it happened again.
       */
      await store.upsertModels(seedModels());
    }
  } catch (error) {
    reason = refreshFailureReason(error);
  }
  // The journal is the whole of the observation this box has: one owner, no alerting, and this
  // service has no endpoint to ask. Silence would make a catalogue that stopped changing
  // indistinguishable from a provider that shipped nothing, so the first failure and the recovery
  // are both said once, in `athanor logs`.
  const line = refreshLogLine({
    previousFailures: consecutiveFailures,
    reason,
    intervalSeconds: config.REGISTRY_REFRESH_SECONDS
  });
  if (line) process.stderr.write(line);
  consecutiveFailures = reason === null ? 0 : consecutiveFailures + 1;
  await delay(config.REGISTRY_REFRESH_SECONDS * 1000);
}
await database.close();
