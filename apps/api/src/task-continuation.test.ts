import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, DataStore, migrateDatabase } from '@athanor/data';
import { decryptJson, encryptJson, wrapDataKey } from '@athanor/core';
import type { TaskRecord } from '@athanor/data';
import type { RouteContext } from './http/server-context.js';
import {
  continueTaskOperation,
  taskContinuationSnapshot,
  type TaskContinuationSnapshot
} from './task-continuation.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const key = Buffer.alloc(32, 7),
  masterKey = Buffer.alloc(32, 9);
const sealed = encryptJson({ prompt: 'Start' }, key, 'test');
beforeAll(async () => migrateDatabase(database));
afterAll(async () => database.close());
const fixture = async (status = 'running') => {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Work',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspace.id, 'running');
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'model',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 8,
    titleCiphertext: sealed,
    promptCiphertext: sealed,
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query(
    'UPDATE tasks SET status=$2,agent_state_ciphertext=$3::jsonb,actual_compute_credits=0.7 WHERE id=$1',
    [
      task.id,
      status,
      JSON.stringify(
        encryptJson(
          { messages: [{ role: 'user', content: 'Start' }], step: 2, turn: 1, credits: 0.7 },
          key,
          `task-state:${task.id}`
        )
      )
    ]
  );
  const current = (await store.getTask(user.id, task.id))!;
  const model = {
    id: 'model',
    displayName: 'Model',
    usageClass: 'medium',
    availability: 'available',
    privacyRoute: 'provider_zdr',
    reasoning: { supportedEfforts: ['high'], mandatory: false }
  };
  const resolveSpendCeiling = vi.fn(async () => 2);
  const context = {
    store,
    database,
    masterKey,
    config: { TASK_MAX_STEPS: 20 },
    modelsForUser: async () => [model],
    privateTaskResponse: async (value: TaskRecord) => value,
    resolveSpendCeiling,
    assertSpendCeilingAllowed: vi.fn(async () => undefined),
    computeAllowanceFor: () => 50
  } as unknown as RouteContext;
  const retained = { expected: taskContinuationSnapshot(current), messageId: randomUUID() };
  const send = (body: unknown = { prompt: 'Check the result' }) =>
    continueTaskOperation(context, user, task.id, body, { retainBudget: retained });
  return { task: current, user, context, retained, send, resolveSpendCeiling };
};

describe('confirmed continuation within existing task authority', () => {
  it('queues and promotes real work without raising either allowance or changing the selected route', async () => {
    const f = await fixture();
    await f.send();
    const queued = await store.getNextQueuedTaskMessage(f.task.id);
    expect(queued).toMatchObject({
      id: f.retained.messageId,
      maxComputeCredits: 0,
      maxSpendUsd: null,
      modelId: f.task.modelId,
      reasoningEffort: 'high',
      privacyRoute: f.task.privacyRoute,
      interrupt: false
    });
    expect(f.resolveSpendCeiling).not.toHaveBeenCalled();
    await database.query("UPDATE tasks SET lease_owner='worker' WHERE id=$1", [f.task.id]);
    const promoted = await store.promoteQueuedTaskMessage({
      taskId: f.task.id,
      messageId: queued!.id,
      workerId: 'worker',
      modelId: queued!.modelId,
      privacyRoute: queued!.privacyRoute,
      additionalComputeCredits: queued!.maxComputeCredits,
      additionalSpendUsd: queued!.maxSpendUsd,
      agentStateCiphertext: f.task.agentStateCiphertext!,
      userMessageCiphertext: sealed,
      statusEventCiphertext: sealed
    });
    expect(promoted).toMatchObject({
      maxComputeCredits: 4,
      maxSpendUsd: 8,
      reasoningEffort: 'high'
    });
    expect(
      (
        await database.query('SELECT credits FROM usage_entries WHERE idempotency_key=$1', [
          queued!.reservationKey
        ])
      ).rows
    ).toEqual([{ credits: 0 }]);
  });
  it('resumes a completed checkpoint with carried credits and one stable message identity', async () => {
    const f = await fixture('completed');
    await f.send();
    const resumed = (await store.getTask(f.user.id, f.task.id))!;
    expect(resumed).toMatchObject({
      status: 'queued',
      maxComputeCredits: 4,
      maxSpendUsd: 8,
      modelId: 'model',
      reasoningEffort: 'high',
      privacyRoute: 'provider_zdr'
    });
    const state = decryptJson<{ credits: number; messages: unknown[]; turn: number }>(
      resumed.agentStateCiphertext!,
      key
    );
    expect(state.credits).toBe(0.7);
    expect(state.turn).toBe(2);
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'Check the result' });
    await expect(f.send()).resolves.toMatchObject({ id: f.task.id });
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([{ id: f.retained.messageId }]);
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
  });
  it('leaves a real pending approval parked while accepting the proposed message', async () => {
    const f = await fixture('awaiting_user');
    const approvalId = await store.createApproval({
      userId: f.user.id,
      taskId: f.task.id,
      action: 'connector_action',
      sideEffect: 'external_consequential',
      previewCiphertext: sealed,
      previewHash: 'test-hash',
      expiresAt: new Date(Date.now() + 60_000)
    });
    await f.send();
    expect(await store.getApproval(approvalId)).toMatchObject({ status: 'pending' });
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({
      status: 'awaiting_user',
      queuedMessageCount: 1
    });
    const question = await fixture('awaiting_user');
    await question.send();
    expect(await store.getTask(question.user.id, question.task.id)).toMatchObject({
      status: 'queued',
      queuedMessageCount: 1
    });
  });
  it('refuses stale authority, setting overrides, other owners, and exhausted spend before writing work', async () => {
    const f = await fixture();
    const expected = f.retained.expected;
    const changes: Array<Partial<TaskContinuationSnapshot>> = [
      { id: randomUUID() },
      { userId: randomUUID() },
      { workspaceId: randomUUID() },
      { modelId: 'other' },
      { privacyRoute: 'external' },
      { reasoningEffort: 'low' },
      { securityMode: 'autonomous' },
      { maxComputeCredits: 5 },
      { maxSpendUsd: 9 }
    ];
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      f.retained.expected = { ...expected, ...change };
      await expect(f.send()).rejects.toMatchObject({ code: 'task_proposal_changed' });
    }
    f.retained.expected = expected;
    for (const extra of [
      { maxSpendUsd: 100 },
      { maxComputeCredits: 100 },
      { interrupt: true },
      { modelId: 'other' }
    ])
      await expect(f.send({ prompt: 'Check', ...extra })).rejects.toThrow();
    await expect(
      continueTaskOperation(
        f.context,
        { ...f.user, id: randomUUID() },
        f.task.id,
        { prompt: 'Check' },
        { retainBudget: f.retained }
      )
    ).rejects.toMatchObject({ code: 'task_not_found' });
    await database.query('UPDATE tasks SET max_spend_usd=0.05 WHERE id=$1', [f.task.id]);
    f.retained.expected = taskContinuationSnapshot((await store.getTask(f.user.id, f.task.id))!);
    await store.recordUsage({
      userId: f.user.id,
      taskId: f.task.id,
      workspaceId: f.task.workspaceId,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'tokens',
      credits: 0.1,
      costUsd: 0.1,
      state: 'settled',
      idempotencyKey: randomUUID()
    });
    await expect(f.send()).rejects.toThrow();
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toBeNull();
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([]);
  });
  it('rolls back with its confirmation transaction and accepts concurrent replay only once', async () => {
    const f = await fixture('completed');
    await expect(
      database.transaction(async () => {
        await f.send();
        throw new Error('confirmation failed');
      })
    ).rejects.toThrow('confirmation failed');
    expect(await store.getTask(f.user.id, f.task.id)).toMatchObject({ status: 'completed' });
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([]);
    await Promise.all([f.send(), f.send()]);
    expect(
      (await database.query('SELECT id FROM task_events WHERE task_id=$1', [f.task.id])).rows
    ).toEqual([{ id: f.retained.messageId }]);
    expect(
      (
        await database.query('SELECT id FROM usage_entries WHERE idempotency_key=$1', [
          `task:${f.task.id}:message:${f.retained.messageId}:reservation`
        ])
      ).rows
    ).toHaveLength(1);
    await expect(f.send({ prompt: 'Different work' })).rejects.toMatchObject({
      code: 'task_message_identity_conflict'
    });
  });
  it('keeps ordinary typed follow-up allocation behavior on the same operation', async () => {
    const f = await fixture();
    await continueTaskOperation(f.context, f.user, f.task.id, {
      prompt: 'A new turn',
      maxComputeCredits: 2,
      maxSpendUsd: 2
    });
    expect(await store.getNextQueuedTaskMessage(f.task.id)).toMatchObject({
      maxComputeCredits: 50,
      maxSpendUsd: 2
    });
    expect(f.resolveSpendCeiling).toHaveBeenCalledExactlyOnceWith(f.user.id, 2);
  });
});
