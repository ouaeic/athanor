import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import {
  assertMasterKeyOpensDatabase,
  createDatabase,
  DataStore,
  migrateDatabase
} from '@athanor/data';
import { deriveServiceSecret, resolveDataMasterKey } from '@athanor/core';
import { AgentWorker } from './agent.js';
import { loadConfig } from './config.js';
import { runLeaseLoops, type WorkerCounters } from './lease.js';

const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
const keyRelease = await resolveDataMasterKey(config);
await assertMasterKeyOpensDatabase(database, keyRelease.key);
const worker = new AgentWorker(
  store,
  config,
  keyRelease.key,
  config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(keyRelease.key, 'runner-capabilities')
);
let running = true;
const counters: WorkerCounters = { active: 0, completed: 0, failed: 0, leaseErrors: 0 };
const health = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `athanor_worker_active ${counters.active}\nathanor_worker_concurrency ${config.WORKER_CONCURRENCY}\nathanor_worker_completed_total ${counters.completed}\nathanor_worker_failed_total ${counters.failed}\nathanor_worker_lease_errors_total ${counters.leaseErrors}\n`
    );
  } else {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'worker' }));
  }
});
health.listen(config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST);

const shutdown = () => {
  running = false;
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Said once when leasing starts failing and once when it recovers, not every poll: at
// WORKER_POLL_MS a database outage would otherwise write thousands of identical lines into the
// journal and bury the first one, which is the only line that says when it began.
let leaseHealthy = true;
const reportLeaseHealth = (healthy: boolean, error?: unknown): void => {
  if (healthy === leaseHealthy) return;
  leaseHealthy = healthy;
  process.stderr.write(
    healthy
      ? '[athanor] leasing recovered; the worker is accepting tasks again\n'
      : `[athanor] leasing the next task failed, so this worker is accepting nothing: ${
          error instanceof Error ? error.message : String(error)
        }\n`
  );
};

await runLeaseLoops({
  concurrency: config.WORKER_CONCURRENCY,
  pollMs: config.WORKER_POLL_MS,
  counters,
  onLeaseHealth: reportLeaseHealth,
  running: () => running,
  lease: () => store.leaseNextTask(config.WORKER_ID, 120),
  run: (task) => worker.run(task),
  fail: (task, error) => worker.fail(task, error),
  idle: (milliseconds) => delay(milliseconds)
});

await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
