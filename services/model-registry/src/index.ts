import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { refreshOpenRouterCatalog, seedModels } from '@athanor/model-gateway';
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
    const catalog = config.OPENROUTER_REGISTRY_KEY
      ? await refreshOpenRouterCatalog(seedModels(), {
          baseUrl: config.OPENROUTER_BASE_URL,
          apiKey: config.OPENROUTER_REGISTRY_KEY,
          scope: config.MODEL_CATALOG_SCOPE
        })
      : seedModels();
    await store.upsertModels(catalog);
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
