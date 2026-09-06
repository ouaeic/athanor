import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';
import { TASK_QUEUE_CHANNEL } from './tasks.js';

const envelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' } as const;
let database: Database;
let store: DataStore;
beforeEach(async () => {
  database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  store = new DataStore(database);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.close();
});

async function seed() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Approval fixture',
    storageLimitBytes: 1024 ** 3,
    imageRevision: 'fixture',
    region: 'auto',
    wrappedKey: 'fixture'
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: envelope,
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: envelope
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
    [task.id]
  );
  const input = {
    id: randomUUID(),
    userId: user.id,
    taskId: task.id,
    workerId: 'worker',
    action: 'shell',
    sideEffect: 'external_consequential',
    previewCiphertext: envelope,
    previewHash: 'fixture',
    expiresAt: new Date(Date.now() + 60_000),
    agentStateCiphertext: { ...envelope, ciphertext: 'pending-call' },
    actualComputeCredits: 0.25
  };
  return { user, task, input };
}

describe('approval and continuation transactions', () => {
  it.each(['approved', 'denied'] as const)(
    'settles %s once and wakes the queued continuation',
    async (decision) => {
      const { user, task, input } = await seed();
      expect(await store.parkTaskForApproval(input)).toBe(true);
      expect(await store.getTask(user.id, task.id)).toMatchObject({
        status: 'awaiting_user',
        leaseOwner: null,
        agentStateCiphertext: input.agentStateCiphertext
      });
      const signal = vi.spyOn(database, 'notify');
      expect(await store.resolveApproval(user.id, input.id, decision)).toBe(true);
      expect(signal).toHaveBeenCalledWith(TASK_QUEUE_CHANNEL, task.id);
      expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'queued' });
      expect(await store.getApproval(input.id)).toMatchObject({ status: decision });
      expect(await store.resolveApproval(user.id, input.id, decision)).toBe(false);
    }
  );

  it('settles the card without removing an owner pause', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(true);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'paused' });
  });

  it.each(['completed', 'failed', 'cancelled'])('never restarts a %s task', async (status) => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await store.setTaskStatusForUser(user.id, task.id, status);
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status });
  });

  it('leaves cancellation authoritative on either side of the answer', async () => {
    for (const answerFirst of [true, false]) {
      const { user, task, input } = await seed();
      expect(await store.parkTaskForApproval(input)).toBe(true);
      if (answerFirst)
        expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(true);
      expect(await store.cancelTaskAndReleaseReservations(user.id, task.id)).toBe(true);
      if (!answerFirst)
        expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
      expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'cancelled' });
    }
  });

  it('refuses foreign and expired decisions before changing task state', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    expect(await store.resolveApproval(randomUUID(), input.id, 'approved')).toBe(false);
    await database.query("UPDATE approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [
      input.id
    ]);
    expect(await store.resolveApproval(user.id, input.id, 'approved')).toBe(false);
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'awaiting_user' });
    expect(await store.getApproval(input.id)).toMatchObject({ status: 'pending' });
  });

  it('rolls back the decision when its task cannot be queued', async () => {
    const { user, task, input } = await seed();
    expect(await store.parkTaskForApproval(input)).toBe(true);
    await database.query(`CREATE FUNCTION refuse_approval_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'queued' THEN RAISE EXCEPTION 'fixture queue failure'; END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER refuse_approval_queue BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION refuse_approval_queue()`);
    await expect(store.resolveApproval(user.id, input.id, 'approved')).rejects.toThrow(
      'fixture queue failure'
    );
    expect(await store.getApproval(input.id)).toMatchObject({ status: 'pending' });
    expect(await store.getTask(user.id, task.id)).toMatchObject({ status: 'awaiting_user' });
  });

  it('rolls back parking if its card cannot be inserted', async () => {
    const { user, task, input } = await seed();
    const existingId = await store.createApproval(input);
    await expect(store.parkTaskForApproval({ ...input, id: existingId })).rejects.toThrow();
    expect(await store.getTask(user.id, task.id)).toMatchObject({
      status: 'running',
      leaseOwner: 'worker',
      agentStateCiphertext: null
    });
    const cards = await store.listApprovals(user.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(existingId);
  });

  it.each(['paused', 'cancelled', 'expired', 'replacement'])(
    'does not publish a decision from a %s lease',
    async (kind) => {
      const { user, task, input } = await seed();
      if (kind === 'paused' || kind === 'cancelled')
        await store.setTaskStatusForUser(user.id, task.id, kind);
      else if (kind === 'expired')
        await database.query(
          "UPDATE tasks SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
          [task.id]
        );
      else input.workerId = 'another-worker';
      expect(await store.parkTaskForApproval(input)).toBe(false);
      expect(await store.getApproval(input.id)).toBeNull();
      expect((await store.getTask(user.id, task.id))?.agentStateCiphertext).toBeNull();
    }
  );
});
