import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@athanor/data';
import { encryptJson, decryptJson, unwrapDataKey, wrapDataKey } from '@athanor/core';
import { RunnerClient } from './runner-client.js';
import {
  beginProjectExecution,
  completeProjectExecution,
  projectSourcePaths
} from './project-execution.js';
const databases: Database[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
});
async function fixture() {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  databases.push(database);
  await migrateDatabase(database);
  const store = new DataStore(database),
    masterKey = Buffer.alloc(32, 8),
    key = Buffer.alloc(32, 3),
    runner = new RunnerClient('http://runner.invalid', 's'.repeat(32));
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' }),
    workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Computer',
    storageLimitBytes: 1024 ** 3,
    imageRevision: 'fixture',
    region: 'auto',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  await store.updateWorkspaceStatus(workspace.id, 'running');
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson({ title: 'Analysis' }, key, `task-title:${workspace.id}`),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'owner-model',
    reasoningEffort: 'high',
    securityMode: 'autonomous',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 4,
    maxSpendUsd: 2,
    promptCiphertext: encryptJson(
      { prompt: 'Continue my analysis' },
      key,
      `task-prompt:${workspace.id}`
    )
  });
  const context = { database, store, masterKey, runner };
  const call = vi.spyOn(runner, 'request').mockImplementation(async (input) => {
    if (typeof input.body !== 'string') throw Error('Expected a JSON preparation request');
    const body = JSON.parse(input.body) as { workspaceId: string; taskId: string };
    return {
      status: 'ready',
      sourceWorkspaceId: input.workspaceId,
      workspaceId: body.workspaceId,
      taskId: body.taskId,
      bytes: 42
    };
  });
  return { ...context, context, user, workspace, task, key, call };
}
describe('project preparation API operation', () => {
  it('keeps explicitly attached files exact and derives only recorded project directories', () => {
    expect(projectSourcePaths([], ['workspace/uploads/selected.wav'])).toEqual([
      'workspace/AGENTS.md',
      'workspace/ATHANOR.md',
      'workspace/OPEN_CLOUD.md',
      'workspace/uploads/selected.wav'
    ]);
  });
  it('rebinds prompt/title under the same data key and preserves owner policy and allocation', async () => {
    const f = await fixture(),
      execution = await beginProjectExecution(f.context, f.task, []);
    expect(execution).not.toBeNull();
    expect(await f.store.leaseNextTask('early')).toBeNull();
    const updated = await completeProjectExecution(f.context, f.task, execution);
    expect(updated.workspaceId).not.toBe(f.workspace.id);
    const workspace = await f.store.getWorkspace(f.user.id, updated.workspaceId);
    const key = unwrapDataKey(workspace!.wrappedKey!, f.masterKey, updated.workspaceId);
    expect(key).toEqual(f.key);
    expect(decryptJson(updated.titleCiphertext!, key, `task-title:${updated.workspaceId}`)).toEqual(
      { title: 'Analysis' }
    );
    expect(
      decryptJson(updated.promptCiphertext, key, `task-prompt:${updated.workspaceId}`)
    ).toEqual({ prompt: 'Continue my analysis' });
    expect(updated).toMatchObject({
      securityMode: 'autonomous',
      reasoningEffort: 'high',
      modelId: 'owner-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 4,
      maxSpendUsd: 2
    });
    expect(f.call).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'control',
        scopes: ['workspace.manage'],
        workspaceId: f.workspace.id
      })
    );
    expect((await f.store.listWorkspaces(f.user.id))[0]?.storageBytes).toBe(42);
    expect(await f.store.leaseNextTask('ready')).toMatchObject({
      id: f.task.id,
      workspaceId: updated.workspaceId
    });
    expect(
      (
        await f.database.query('SELECT COUNT(*) AS n FROM usage_entries WHERE task_id=$1', [
          f.task.id
        ])
      ).rows[0]?.n
    ).toBe(0);
  });
  it('keeps cancellation authoritative when preparation returns late', async () => {
    const f = await fixture(),
      execution = await beginProjectExecution(f.context, f.task, []);
    await f.store.cancelTaskAndReleaseReservations(f.user.id, f.task.id);
    await expect(completeProjectExecution(f.context, f.task, execution)).rejects.toThrow(
      'changed during preparation'
    );
    expect(await f.store.getTask(f.user.id, f.task.id)).toMatchObject({
      workspaceId: f.workspace.id,
      status: 'cancelled',
      securityMode: 'autonomous'
    });
  });
  it('rejects a mismatched native receipt and keeps the original task intact', async () => {
    const f = await fixture(),
      execution = await beginProjectExecution(f.context, f.task, []);
    f.call.mockResolvedValue({
      status: 'ready',
      workspaceId: randomUUID(),
      sourceWorkspaceId: f.workspace.id,
      taskId: f.task.id,
      bytes: 0
    });
    await expect(completeProjectExecution(f.context, f.task, execution)).rejects.toThrow(
      'mismatched receipt'
    );
    expect((await f.store.getTask(f.user.id, f.task.id))?.workspaceId).toBe(f.workspace.id);
    expect((await f.store.getProjectExecution(f.user.id, f.task.id))?.status).toBe('failed');
    expect(await f.store.leaseNextTask('not-ready')).toBeNull();
  });
});
