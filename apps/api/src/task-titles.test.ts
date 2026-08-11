/**
 * Naming a conversation, and the three things that must not happen while it is named: a name the
 * owner wrote must never be replaced, a box at its spending ceiling must not spend on names, and a
 * provider that is refusing must not be asked once per answer for as long as it refuses.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildConversationNameIndex,
  decryptJson,
  encryptJson,
  memoryIndexKey,
  wrapDataKey
} from '@athanor/core';
import { createDatabase, DataStore, migrateDatabase, type Database } from '@athanor/data';
import { createLogger } from './log.js';
import {
  cleanGeneratedTitle,
  MAX_GENERATED_TITLE_LENGTH,
  startTaskTitler,
  titleTasksOnce,
  type TitleCompletion,
  type TaskTitlerDeps
} from './task-titles.js';

const masterKey = Buffer.alloc(32, 7);
const log = createLogger({ level: 'silent' });

const completion = (text: string): TitleCompletion => ({
  text,
  costUsd: 0.0004,
  inputTokens: 120,
  outputTokens: 6,
  providerRef: 'openrouter:z-ai/glm-5.2',
  resourceClass: 'medium'
});

/** A box with one conversation whose first answer has landed and which still wears a placeholder. */
const boxWithAnsweredTask = async () => {
  const database: Database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
  const dataKey = Buffer.alloc(32, 9);
  // The workspace key is bound to the workspace id, so the id is chosen before the row is written.
  const workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Computer',
    storageLimitBytes: 10_000_000_000,
    imageRevision: 'dev',
    region: 'local',
    securityMode: 'balanced',
    wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson(
      { title: 'Have a look at the build log and tell me' },
      dataKey,
      `task-title:${workspace.id}`
    ),
    nameIndex: buildConversationNameIndex(
      'Have a look at the build log and tell me',
      'Have a look at the build log and tell me why the release job is red',
      memoryIndexKey(dataKey)
    ),
    modelId: 'openrouter/z-ai/glm-5.2',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    securityMode: 'balanced',
    promptCiphertext: encryptJson(
      { prompt: 'Have a look at the build log and tell me why the release job is red' },
      dataKey,
      `task-prompt:${workspace.id}`
    )
  });
  await store.appendTaskEvent({
    taskId: task.id,
    kind: 'assistant_message',
    summary: 'Answered',
    payloadCiphertext: encryptJson(
      { markdown: 'The lockfile is stale.' },
      dataKey,
      `task-event:${task.id}`
    )
  });
  const titleOf = async () => {
    const current = await store.getTask(user.id, task.id);
    return current?.titleCiphertext
      ? decryptJson<{ title: string }>(current.titleCiphertext, dataKey).title
      : null;
  };
  return { database, store, user, workspace, task, dataKey, titleOf };
};

const freshState = () => ({ attempts: new Map<string, number>(), providerReadyAt: 0 });

describe('turning a model answer into a name', () => {
  it('keeps the first line, drops the decoration, and cuts on a word', () => {
    expect(cleanGeneratedTitle('Release job failure')).toBe('Release job failure');
    expect(cleanGeneratedTitle('  "Release job failure."  ')).toBe('Release job failure');
    expect(cleanGeneratedTitle('Title: Release job failure\nHere is why:')).toBe(
      'Release job failure'
    );
    expect(cleanGeneratedTitle('\n\nRelease job failure\n')).toBe('Release job failure');
    // A model that answers with a paragraph still yields a line a sidebar can show, ending on a
    // word rather than mid-word.
    const long = cleanGeneratedTitle(
      'Investigating the release pipeline failure caused by a stale dependency lockfile'
    );
    expect(long!.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
    expect(long!.endsWith(' ')).toBe(false);
    expect(long).toBe('Investigating the release pipeline failure caused by a');
    expect(cleanGeneratedTitle('   ')).toBeNull();
    expect(cleanGeneratedTitle('')).toBeNull();
  });
});

describe('the titler', () => {
  it('names a conversation on its own model and records what it cost', async () => {
    const { database, store, user, task, titleOf } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      const named = await titleTasksOnce({ store, masterKey, log, complete }, freshState());

      expect(named).toBe(1);
      expect(await titleOf()).toBe('Release job failure');
      // The conversation's own model, not a cheaper one: the request has already been sent there,
      // and sending it anywhere else is a disclosure the owner did not choose.
      expect(complete.mock.lastCall?.[0]).toMatchObject({
        modelId: 'openrouter/z-ai/glm-5.2',
        privacyRoute: 'provider_zdr',
        prompt: 'Have a look at the build log and tell me why the release job is red'
      });
      await expect(store.taskSpend(task.id)).resolves.toBeCloseTo(0.0004, 6);
      // Attributed to the model that was actually billed, so a title shows up in the usage pane
      // beside the work rather than as an unexplained charge.
      const spend = await store.spendByModel(user.id, new Date(0), new Date());
      expect(spend).toMatchObject([{ key: 'z-ai/glm-5.2', calls: 1 }]);
      expect(spend[0]!.costUsd).toBeCloseTo(0.0004, 6);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('leaves a name the owner wrote alone, and does not look at it twice', async () => {
    const { database, store, user, task, dataKey, workspace, titleOf } =
      await boxWithAnsweredTask();
    try {
      await store.renameTask(
        user.id,
        task.id,
        encryptJson({ title: 'Red release' }, dataKey, `task-title:${workspace.id}`),
        buildConversationNameIndex('Red release', '', memoryIndexKey(dataKey))
      );
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      await expect(titleTasksOnce({ store, masterKey, log, complete }, freshState())).resolves.toBe(
        0
      );
      expect(complete).not.toHaveBeenCalled();
      expect(await titleOf()).toBe('Red release');
    } finally {
      await database.close();
    }
  }, 60_000);

  it('does not spend on a name once the owner is over their cap', async () => {
    const { database, store, user, titleOf } = await boxWithAnsweredTask();
    try {
      await store.setSpendLimits({ userId: user.id, dailyCapUsd: 1 });
      await store.recordUsage({
        userId: user.id,
        kind: 'model_inference',
        resourceClass: 'medium',
        quantity: 1,
        unit: 'tokens',
        credits: 0,
        state: 'settled',
        idempotencyKey: 'already-spent',
        costUsd: 1.5
      });
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };
      // Four sweeps: more than the number of attempts a conversation the model cannot name is
      // given, because a conversation nobody was allowed to pay for has not been attempted at all.
      for (let sweep = 0; sweep < 4; sweep += 1)
        await expect(titleTasksOnce(deps, state)).resolves.toBe(0);
      expect(complete).not.toHaveBeenCalled();
      expect(await titleOf()).toBe('Have a look at the build log and tell me');

      // The window rolls over and the conversation is nameable again, rather than having quietly
      // used up its chances while the box was refusing to spend.
      await store.setSpendLimits({ userId: user.id, dailyCapUsd: null });
      await expect(titleTasksOnce(deps, state)).resolves.toBe(1);
      expect(await titleOf()).toBe('Release job failure');
    } finally {
      await database.close();
    }
  }, 60_000);

  it('waits out a provider that cannot answer instead of asking per conversation', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => null);
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };

      await expect(titleTasksOnce(deps, state, 1_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(state.providerReadyAt).toBeGreaterThan(1_000);

      // Every answer that lands during the outage would otherwise be one more provider call.
      await expect(titleTasksOnce(deps, state, 2_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);

      await expect(titleTasksOnce(deps, state, state.providerReadyAt + 1)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('gives up on a conversation the model will not name rather than retrying it forever', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => completion('   '));
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };
      for (let sweep = 0; sweep < 6; sweep += 1) await titleTasksOnce(deps, state);
      expect(complete).toHaveBeenCalledTimes(3);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('survives a store that fails under it, and stops when it is asked to', async () => {
    const { database, store } = await boxWithAnsweredTask();
    const failing = {
      ...store,
      listTasksNeedingTitle: async () => {
        throw new Error('the database went away');
      },
      waitForAnsweredTask: (timeoutMs: number) => store.waitForAnsweredTask(timeoutMs)
    } as unknown as DataStore;
    try {
      const titler = startTaskTitler(
        { store: failing, masterKey, log, complete: async () => completion('Anything') },
        50
      );
      // The loop has to outlive the failure: an unhandled rejection here would take the API down.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await expect(titler.stop()).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  }, 60_000);
});
