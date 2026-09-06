import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { migrations } from './migrations.js';
import { DataStore } from './store.js';

describe('finished message reservation upgrades', () => {
  let database: Database;
  afterEach(async () => database?.close());

  it('reclaims only reserved promoted-message capacity on terminal tasks and retains all billing history', async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    const installed = migrations.filter((migration) => migration.version <= 83);
    expect(installed.length).toBeGreaterThan(0);
    for (const migration of installed) {
      await database.transaction(async (transaction) => {
        await transaction.exec(migration.sql);
        await transaction.query('INSERT INTO schema_migrations(version,name) VALUES ($1,$2)', [
          migration.version,
          migration.name
        ]);
      });
    }
    const store = new DataStore(database);
    const user = await store.createUser({ username: 'upgrade-owner', displayName: 'Owner' });
    const other = await store.createUser({ username: 'upgrade-other', displayName: 'Other' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Reservations',
      storageLimitBytes: 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'unused'
    });
    const envelope = { v: 1 as const, iv: 'message', tag: 'tag', ciphertext: 'sealed' };
    const cases = [
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'released'
      },
      {
        taskStatus: 'failed',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'released'
      },
      {
        taskStatus: 'cancelled',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'released'
      },
      {
        taskStatus: 'running',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'reserved'
      },
      {
        taskStatus: 'paused',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'reserved'
      },
      {
        taskStatus: 'completed',
        queueStatus: 'queued',
        usageState: 'reserved',
        expected: 'reserved'
      },
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'settled',
        expected: 'settled'
      },
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'released',
        expected: 'released'
      },
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'reserved',
        mismatchedOwner: true
      },
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'reserved',
        unrelatedKind: true
      },
      {
        taskStatus: 'completed',
        queueStatus: 'promoted',
        usageState: 'reserved',
        expected: 'reserved',
        mismatchedTask: true
      }
    ] as const;
    const expected = new Map<string, string>();
    let firstTaskId = '';
    for (const [index, item] of cases.entries()) {
      const task = await store.createTask({
        userId: user.id,
        workspaceId: workspace.id,
        titleCiphertext: envelope,
        nameIndex: { nameTokens: '', openingTokens: '' },
        modelId: 'test-model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        maxSpendUsd: 0.75,
        promptCiphertext: envelope
      });
      firstTaskId ||= task.id;
      const messageId = randomUUID();
      const reservationKey = `message:${messageId}`;
      await store.enqueueTaskMessage({
        id: messageId,
        taskId: task.id,
        userId: user.id,
        modelId: 'test-model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: index + 1,
        maxSpendUsd: 0.25,
        resourceClass: 'medium',
        reservationKey,
        interrupt: true,
        promptCiphertext: envelope,
        queuedEventCiphertext: envelope
      });
      await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [task.id, item.taskStatus]);
      await database.query('UPDATE task_message_queue SET status=$2 WHERE id=$1', [
        messageId,
        item.queueStatus
      ]);
      await database.query(
        `UPDATE usage_entries SET state=$2,cost_usd=$3,user_id=$4,kind=$5,task_id=$6 WHERE idempotency_key=$1`,
        [
          reservationKey,
          item.usageState,
          item.usageState === 'settled' ? 0.125 : 0,
          'mismatchedOwner' in item ? other.id : user.id,
          'unrelatedKind' in item ? 'model' : 'task_compute',
          'mismatchedTask' in item ? firstTaskId : task.id
        ]
      );
      expected.set(reservationKey, item.expected);
    }
    const snapshot = async () =>
      (
        await database.query<{ idempotency_key: string; state: string }>(
          'SELECT * FROM usage_entries ORDER BY idempotency_key'
        )
      ).rows;
    const before = await snapshot();
    expect(before).toHaveLength(cases.length);
    expect(before.filter((row) => row.state === 'reserved')).toHaveLength(9);
    const taskHistory = (await database.query('SELECT * FROM tasks ORDER BY id')).rows;
    const messageHistory = (await database.query('SELECT * FROM task_message_queue ORDER BY id'))
      .rows;
    expect(taskHistory).toHaveLength(cases.length);
    expect(messageHistory).toHaveLength(cases.length);

    await migrateDatabase(database);
    const after = await snapshot();
    expect(after).toEqual(
      before.map((row) => ({ ...row, state: expected.get(row.idempotency_key) }))
    );
    expect(after.filter((row) => row.state === 'reserved')).toHaveLength(6);
    expect((await database.query('SELECT * FROM tasks ORDER BY id')).rows).toEqual(taskHistory);
    expect((await database.query('SELECT * FROM task_message_queue ORDER BY id')).rows).toEqual(
      messageHistory
    );
    await migrateDatabase(database);
    expect(await snapshot()).toEqual(after);
  });
});
