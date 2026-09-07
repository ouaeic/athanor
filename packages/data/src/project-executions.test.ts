import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { DataStore } from './store.js';
const envelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' } as const;
let db: Database, store: DataStore;
beforeEach(async () => {
  db = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(db);
  store = new DataStore(db);
});
afterEach(async () => {
  await db.close();
});
async function seed() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Computer',
    storageLimitBytes: 1024 ** 3,
    imageRevision: 'fixture',
    region: 'auto',
    wrappedKey: 'fixture'
  });
  await store.updateWorkspaceStatus(workspace.id, 'running');
  const create = () =>
    store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'chosen',
      privacyRoute: 'provider_zdr',
      reasoningEffort: 'high',
      securityMode: 'autonomous',
      maxComputeCredits: 4,
      maxSpendUsd: 2,
      promptCiphertext: envelope
    });
  const a = await create(),
    b = await create();
  return { user, workspace, a, b, create };
}
async function begin(userId: string, taskId: string) {
  return (await store.beginProjectExecution({
    userId,
    taskId,
    workspaceId: randomUUID(),
    wrappedKey: 'same-key-rewrapped',
    sourceManifestCiphertext: envelope,
    seedKind: 'legacy'
  }))!;
}
async function finish(
  userId: string,
  taskId: string,
  workspaceId: string,
  pendingApprovalId?: string
) {
  return store.finishProjectExecution({
    userId,
    taskId,
    workspaceId,
    receiptCiphertext: envelope,
    rewrite: () => ({
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      ...(pendingApprovalId ? { pendingApprovalId } : {})
    })
  });
}
describe('project execution transactions', () => {
  it('leases independent ordinary projects concurrently while a correction to B keeps A’s live lease', async () => {
    const { user, workspace, a, b } = await seed();
    const ea = await begin(user.id, a.id),
      eb = await begin(user.id, b.id);
    expect(await store.leaseNextTask('before-ready')).toBeNull();
    expect(await finish(user.id, a.id, ea.workspaceId)).toBe(true);
    expect(await finish(user.id, b.id, eb.workspaceId)).toBe(true);
    const first = await store.leaseNextTask('worker-a'),
      second = await store.leaseNextTask('worker-b');
    expect(new Set([first?.id, second?.id])).toEqual(new Set([a.id, b.id]));
    expect(first?.workspaceId).not.toBe(second?.workspaceId);
    expect(await store.leaseNextTask('duplicate')).toBeNull();
    const ownerOfB = first?.id === b.id ? 'worker-a' : 'worker-b';
    await db.query("UPDATE tasks SET status='running' WHERE id=$1", [b.id]);
    await store.enqueueTaskMessage({
      id: randomUUID(),
      taskId: b.id,
      userId: user.id,
      modelId: 'chosen',
      reasoningEffort: 'high',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 0.1,
      resourceClass: 'task_compute',
      reservationKey: randomUUID(),
      interrupt: true,
      promptCiphertext: envelope,
      queuedEventCiphertext: envelope
    });
    const correction = await store.getNextQueuedTaskMessage(b.id, { interruptOnly: true });
    expect(correction).not.toBeNull();
    expect(
      await store.consumeQueuedTaskMessageInTurn({
        taskId: b.id,
        workerId: ownerOfB,
        messageId: correction!.id,
        additionalComputeCredits: 1,
        additionalSpendUsd: 0.1,
        userMessageCiphertext: envelope
      })
    ).toBe(true);
    expect((await store.getTask(user.id, a.id))?.leaseOwner).toBe(
      first?.id === a.id ? 'worker-a' : 'worker-b'
    );
    expect(await store.listWorkspaces(user.id)).toHaveLength(1);
    expect((await store.listWorkspaces(user.id))[0]?.id).toBe(workspace.id);
    expect(await store.getTask(user.id, b.id)).toMatchObject({
      securityMode: 'autonomous',
      modelId: 'chosen',
      privacyRoute: 'provider_zdr',
      reasoningEffort: 'high'
    });
  });
  it('never moves an actively leased task or resumes an owner pause', async () => {
    const { user, a, b } = await seed();
    expect((await store.leaseNextTask('running'))?.id).toBe(a.id);
    expect(await begin(user.id, a.id)).toBeNull();
    const execution = await begin(user.id, b.id);
    await store.setTaskStatusForUser(user.id, b.id, 'paused');
    expect(await finish(user.id, b.id, execution.workspaceId)).toBe(true);
    expect(await store.getTask(user.id, b.id)).toMatchObject({
      status: 'paused',
      securityMode: 'autonomous',
      maxComputeCredits: 4,
      maxSpendUsd: 2
    });
  });
  it('refuses approving the source scope during preparation and atomically invalidates its pending card', async () => {
    const { user, b } = await seed();
    await db.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 minute' WHERE id=$1",
      [b.id]
    );
    const id = randomUUID();
    expect(
      await store.parkTaskForApproval({
        id,
        userId: user.id,
        taskId: b.id,
        workerId: 'worker',
        action: 'shell',
        sideEffect: 'external_consequential',
        previewCiphertext: envelope,
        previewHash: 'hash',
        expiresAt: new Date(Date.now() + 60000),
        agentStateCiphertext: envelope,
        actualComputeCredits: 0
      })
    ).toBe(true);
    const execution = await begin(user.id, b.id);
    expect(await store.resolveApproval(user.id, id, 'approved')).toBe(false);
    expect(await finish(user.id, b.id, execution.workspaceId, id)).toBe(true);
    expect((await store.getApproval(id))?.status).toBe('denied');
    expect(await store.resolveApproval(user.id, id, 'approved')).toBe(false);
  });
  it('loads internal project metadata and drafts in owner-scoped batches without adding computers', async () => {
    const { user, workspace, b } = await seed();
    const execution = await begin(user.id, b.id);
    await finish(user.id, b.id, execution.workspaceId);
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: execution.workspaceId,
      taskId: b.id,
      bodyCiphertext: envelope
    });
    const metadata = await store.listWorkspaceMetadata(user.id);
    expect(metadata.length).toBe(2);
    expect(metadata.find((row) => row.id === execution.workspaceId)).toMatchObject({
      parentWorkspaceId: workspace.id,
      projectTaskId: b.id,
      wrappedKey: 'same-key-rewrapped'
    });
    expect(await store.listWorkspaces(user.id)).toHaveLength(1);
    expect(await store.listOwnerMessageDrafts(user.id)).toEqual([
      expect.objectContaining({
        workspaceId: execution.workspaceId,
        taskId: b.id,
        bodyCiphertext: envelope,
        wrappedKey: 'same-key-rewrapped'
      })
    ]);
    const stranger = await store.createUser({ username: randomUUID(), displayName: 'Stranger' });
    expect(
      await store.listWorkspaceMetadata(stranger.id, [workspace.id, execution.workspaceId])
    ).toEqual([]);
    expect(await store.listOwnerMessageDrafts(stranger.id)).toEqual([]);
  });
  it('binds replay to the owned journal and rolls back the scope switch when resealing fails', async () => {
    const { user, workspace, b } = await seed();
    const execution = await begin(user.id, b.id);
    await expect(
      store.finishProjectExecution({
        userId: user.id,
        taskId: b.id,
        workspaceId: execution.workspaceId,
        receiptCiphertext: envelope,
        rewrite: () => {
          throw Error('seal failed');
        }
      })
    ).rejects.toThrow('seal failed');
    expect((await store.getTask(user.id, b.id))?.workspaceId).toBe(workspace.id);
    expect(await finish(user.id, b.id, randomUUID())).toBe(false);
    expect(await finish(user.id, b.id, execution.workspaceId)).toBe(true);
    expect(await finish(user.id, b.id, execution.workspaceId)).toBe(true);
    expect(
      (await db.query('SELECT COUNT(*) AS n FROM project_executions WHERE task_id=$1', [b.id]))
        .rows[0]?.n
    ).toBe(1);
  });
});
