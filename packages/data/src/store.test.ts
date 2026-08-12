import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMORY_KINDS,
  MEMORY_PREDICATES,
  buildConversationNameIndex,
  buildMemoryItemIndex,
  buildMemorySourceIndex,
  memoryIndexKey,
  memoryOriginKey,
  planMemoryQuery,
  renderMemoryPack,
  spendWindowBounds
} from '@athanor/core';
import {
  encryptJson,
  generateDataKey,
  hashRecoveryCode,
  verifyRecoveryCode,
  wrapDataKey
} from '@athanor/core';
import type { EncryptedEnvelope, MemoryItemContent, MemoryKind } from '@athanor/core';
import { MAX_AGENT_NOTIFICATIONS_PER_TASK, PREVIEW_IDLE_EXPIRY_DAYS } from '@athanor/contracts';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { migrations } from './migrations.js';
import {
  agentNotificationAad,
  DataStore,
  MEMORY_SOURCE_SEARCH_PER_TASK,
  TASK_MAX_ATTEMPTS,
  type RecallMemoryInput
} from './store.js';

/** For the conversations in this file that are never searched by name. */
const UNINDEXED_NAME = { nameTokens: '', openingTokens: '' };

const workspaceInput = (
  userId: string,
  name: string
): Parameters<DataStore['createWorkspace']>[0] => ({
  userId,
  name,
  storageLimitBytes: 10 * 1024 ** 3,
  imageRevision: 'dev',
  region: 'auto',
  wrappedKey: 'wrapped'
});

const taskInput = (
  userId: string,
  workspaceId: string
): Parameters<DataStore['createTask']>[0] => ({
  userId,
  workspaceId,
  titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
  nameIndex: UNINDEXED_NAME,
  modelId: 'qwen',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 1,
  promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
});

describe('DataStore', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  it('consumes authentication challenges exactly once', async () => {
    const id = await store.createChallenge({
      username: 'Ada',
      challenge: 'challenge',
      kind: 'registration'
    });
    await expect(store.consumeChallenge(id, 'registration')).resolves.toEqual({
      username: 'ada',
      challenge: 'challenge',
      expectedOrigin: null,
      rpId: null
    });
    await expect(store.consumeChallenge(id, 'registration')).resolves.toBeNull();
  });

  it('tracks recent passkey verification on a session', async () => {
    const user = await store.createUser({ username: 'reauth', displayName: 'Reauth' });
    await store.createSession(
      user.id,
      'recent-session',
      new Date(Date.now() + 60_000),
      undefined,
      'Test',
      true
    );
    const inserted = await database.query(
      'SELECT id_hash,step_up_at,expires_at,NOW() AS now FROM sessions'
    );
    expect(inserted.rows[0]).toMatchObject({ id_hash: 'recent-session' });
    expect(inserted.rows[0]?.step_up_at).not.toBeNull();
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(false);
    await expect(store.markSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
  });

  it('stores only hashed, scoped API credentials and revokes them immediately', async () => {
    const user = await store.createUser({ username: 'cli-user', displayName: 'CLI user' });
    const token = await store.createApiToken({
      userId: user.id,
      label: 'Laptop CLI',
      tokenHash: 'one-way-hash',
      prefix: 'oc_live_example',
      scopes: ['models:read', 'tasks:read'],
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(await store.listApiTokens(user.id)).toMatchObject([
      { id: token.id, label: 'Laptop CLI', scopes: ['models:read', 'tasks:read'] }
    ]);
    const raw = await database.query('SELECT token_hash,token_prefix FROM api_tokens');
    expect(raw.rows[0]).toMatchObject({
      token_hash: 'one-way-hash',
      token_prefix: 'oc_live_example'
    });
    await expect(store.authenticateApiToken('one-way-hash')).resolves.toMatchObject({
      user: { id: user.id },
      token: { id: token.id }
    });
    await expect(store.revokeApiToken(user.id, token.id)).resolves.toBe(true);
    await expect(store.authenticateApiToken('one-way-hash')).resolves.toBeNull();
  });

  it('keeps reviewed memory and skills in encrypted workspace records', async () => {
    const user = await store.createUser({ username: 'knowledge-user', displayName: 'Knowledge' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Knowledge room',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const memory = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: workspace.id,
      target: 'workspace',
      contentCiphertext: { v: 1, iv: 'memory', tag: 'tag', ciphertext: 'cipher' }
    });
    await expect(store.listWorkspaceMemories(user.id, workspace.id)).resolves.toMatchObject([
      { id: memory.id, target: 'workspace' }
    ]);
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'opaque-name-hash',
      documentCiphertext: { v: 1, iv: 'skill', tag: 'tag', ciphertext: 'cipher' }
    });
    const revised = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'opaque-name-hash',
      documentCiphertext: { v: 1, iv: 'skill-2', tag: 'tag', ciphertext: 'cipher-2' }
    });
    expect(revised).toMatchObject({ id: skill.id, version: 2, nameHash: 'opaque-name-hash' });
    await store.markWorkspaceSkillUsed(user.id, workspace.id, skill.id);
    await expect(store.getWorkspaceSkill(user.id, workspace.id, skill.id)).resolves.toMatchObject({
      useCount: 1,
      status: 'active'
    });
    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      pinned: false
    });
    await database.query(
      "UPDATE workspace_skills SET last_used_at=NOW()-INTERVAL '100 days',updated_at=NOW()-INTERVAL '100 days' WHERE id=$1",
      [skill.id]
    );
    await store.curateWorkspaceSkills(workspace.id);
    await expect(store.getWorkspaceSkill(user.id, workspace.id, skill.id)).resolves.toMatchObject({
      status: 'archived'
    });
    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      pinned: true,
      status: 'active'
    });
    await expect(store.deleteWorkspaceMemory(user.id, workspace.id, memory.id)).resolves.toBe(true);
    await expect(store.deleteWorkspaceSkill(user.id, workspace.id, skill.id)).resolves.toBe(true);
  });

  it('leaves a skill whose occasion has not come up, instead of blinking it out every 31 days', async () => {
    // The clock was COALESCE(last_used_at,updated_at) while the same statement wrote updated_at, so
    // for a never-used skill the anchor was the column the transition overwrote: stale on day 31,
    // clock reset, stale again on day 61, and 'archived' unreachable forever. Every workspace skill
    // was approved by this owner in full, so one whose trigger has not arisen is left alone.
    const user = await store.createUser({ username: 'curator', displayName: 'Curator' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Curation',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'never-used-hash',
      documentCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'cipher' }
    });
    await database.query(
      "UPDATE workspace_skills SET last_used_at=NULL,updated_at=NOW()-INTERVAL '400 days' WHERE id=$1",
      [skill.id]
    );
    const before = await store.getWorkspaceSkill(user.id, workspace.id, skill.id);
    await store.curateWorkspaceSkills(workspace.id);
    const after = await store.getWorkspaceSkill(user.id, workspace.id, skill.id);
    expect(after).toMatchObject({ status: 'active' });
    // A true no-op: the row is not even rewritten, so updated_at keeps meaning "when this changed".
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("takes a conversation's memory with it when the conversation is deleted", async () => {
    // "Delete this conversation" used to leave the episode and, worse, the chunks of the owner's
    // own words held verbatim in mem.source. On a computer that offers to keep no logs it has to
    // mean it, and the schema is the only place that cannot be forgotten by a later caller.
    const user = await store.createUser({ username: 'forgetful', displayName: 'Forgetful' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Forgetting',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      modelId: 'model-1',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      titleCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'title' },
      nameIndex: UNINDEXED_NAME,
      promptCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'prompt' }
    });
    const item = await store.createMemoryItem({
      userId: user.id,
      workspaceId: workspace.id,
      kind: 'episode',
      trust: 'derived',
      documentCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'episode' },
      index: buildMemoryItemIndex(
        { title: 'A past run', body: 'what happened' },
        memoryIndexKey(Buffer.alloc(32, 9))
      ),
      taskId: task.id
    });
    await expect(
      database.query('SELECT 1 FROM mem.item WHERE id=$1', [item.id])
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(store.deleteTask(user.id, task.id)).resolves.toBe(true);
    await expect(
      database.query('SELECT 1 FROM mem.item WHERE id=$1', [item.id])
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("keeps the owner's choices on the box, and merges rather than clobbers them", async () => {
    // These lived in localStorage, so they were facts about a browser rather than about the person:
    // pick a model on the laptop and the phone still offered the old one. On a computer whose whole
    // point is being the same computer from anywhere, a setting that does not travel is not set.
    const user = await store.createUser({ username: 'chooser', displayName: 'Chooser' });
    await expect(store.getUserById(user.id)).resolves.toMatchObject({ preferences: {} });

    await store.mergeUserPreferences(user.id, {
      model: { automatic: false, preference: 'best', modelId: 'vendor/one' }
    });
    // A second device saving a different key must not erase the first. `place` is the live example:
    // it is written every time the owner opens another conversation, so if this merged badly it
    // would silently reset the model choice several times an hour.
    const merged = await store.mergeUserPreferences(user.id, {
      place: { taskId: 'task-one', workspaceId: 'workspace-one' }
    });
    expect(merged).toMatchObject({
      model: { automatic: false, preference: 'best', modelId: 'vendor/one' },
      place: { taskId: 'task-one', workspaceId: 'workspace-one' }
    });
    await expect(store.getUserById(user.id)).resolves.toMatchObject({
      preferences: { model: { modelId: 'vendor/one' } }
    });
  });

  it('keeps a half-typed message on the box, for the conversation and for the one not started', async () => {
    // The draft lived in localStorage, so "close the laptop, pick it up on the phone" - the reason
    // the client's storage module gives for existing - was true only if both were the same device.
    const user = await store.createUser({ username: 'drafter', displayName: 'Drafter' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Drafting',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const sealed = (body: string) => ({ v: 1, iv: 'iv', tag: 'tag', ciphertext: body }) as const;

    // The one with no conversation yet, which is where most first sentences are typed.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: sealed('a first sentence')
    });
    // And again, to prove the upsert finds the partial index rather than inserting a second row.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: sealed('a better first sentence')
    });
    let drafts = await store.listMessageDrafts(user.id, workspace.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      taskId: null,
      bodyCiphertext: { ciphertext: 'a better first sentence' }
    });

    // Emptying it removes the row rather than storing emptiness for every conversation ever opened.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: null
    });
    drafts = await store.listMessageDrafts(user.id, workspace.id);
    expect(drafts).toHaveLength(0);
  });

  it('reaches nothing in a workspace it does not own', async () => {
    const owner = await store.createUser({ username: 'box-owner', displayName: 'Owner' });
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    const workspace = await store.createWorkspace({
      userId: owner.id,
      name: 'Private analysis',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: owner.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    await expect(store.getWorkspace(owner.id, workspace.id)).resolves.toMatchObject({
      id: workspace.id
    });
    await expect(store.getTask(owner.id, task.id)).resolves.toMatchObject({ id: task.id });
    await expect(store.setTaskStatusForUser(owner.id, task.id, 'paused')).resolves.toBe(true);

    // There is one owner on this box, so a second account is a stranger to every workspace on it -
    // there is no group, no policy and no role that could ever grant it a read.
    await expect(store.getWorkspace(stranger.id, workspace.id)).resolves.toBeNull();
    await expect(store.getTask(stranger.id, task.id)).resolves.toBeNull();
    await expect(store.listWorkspaces(stranger.id)).resolves.toEqual([]);
    await expect(store.listTasks(stranger.id, workspace.id)).resolves.toEqual([]);
    await expect(store.workspaceBelongsToUser(stranger.id, workspace.id)).resolves.toBe(false);
    await expect(store.workspaceBelongsToUser(owner.id, workspace.id)).resolves.toBe(true);
    await expect(store.setTaskStatusForUser(stranger.id, task.id, 'queued')).resolves.toBe(false);
  });

  it('queues a follow-up on the same durable task with a fresh reservation', async () => {
    const user = await store.createUser({ username: 'follow-up', displayName: 'Follow up' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Conversation',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title', tag: 'tag', ciphertext: 'cipher' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'prompt', tag: 'tag', ciphertext: 'cipher' }
    });
    await store.updateTask({
      id: task.id,
      status: 'completed',
      agentStateCiphertext: { v: 1, iv: 'state', tag: 'tag', ciphertext: 'cipher' },
      clearLease: true
    });
    const continued = await store.continueTask({
      id: task.id,
      userId: user.id,
      modelId: 'qwen-next',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 2,
      agentStateCiphertext: { v: 1, iv: 'next', tag: 'tag', ciphertext: 'cipher' },
      reservationKey: `task:${task.id}:turn:1:reservation`,
      resourceClass: 'medium',
      userMessageCiphertext: { v: 1, iv: 'message', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(continued).toMatchObject({
      id: task.id,
      status: 'queued',
      modelId: 'qwen-next',
      maxComputeCredits: 3
    });
    await expect(store.listTaskEvents(task.id, 0)).resolves.toMatchObject([
      { sequence: 1, kind: 'user_message', summary: 'User message' }
    ]);
    await expect(
      store.usageTotals(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000))
    ).resolves.toMatchObject({ reserved: 2 });
  });

  it('keeps active follow-ups FIFO and promotes them without ending the conversation', async () => {
    const user = await store.createUser({ username: 'queue-user', displayName: 'Queue user' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Queue lab',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title', tag: 'tag', ciphertext: 'cipher' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'lead-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'prompt', tag: 'tag', ciphertext: 'cipher' }
    });
    await expect(store.leaseNextTask('queue-worker')).resolves.toMatchObject({ id: task.id });
    const messageId = '12b65a33-e4bf-4f8e-99bc-43f2d1a89e29';
    const queued = await store.enqueueTaskMessage({
      id: messageId,
      taskId: task.id,
      userId: user.id,
      modelId: 'next-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      resourceClass: 'high',
      reservationKey: `task:${task.id}:message:${messageId}:reservation`,
      promptCiphertext: { v: 1, iv: 'queue', tag: 'tag', ciphertext: 'cipher' },
      queuedEventCiphertext: { v: 1, iv: 'event', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(queued).toMatchObject({ id: task.id, queuedMessageCount: 1, maxComputeCredits: 1 });
    await expect(store.getNextQueuedTaskMessage(task.id)).resolves.toMatchObject({
      id: messageId,
      modelId: 'next-model',
      maxComputeCredits: 2
    });
    const promoted = await store.promoteQueuedTaskMessage({
      taskId: task.id,
      messageId,
      workerId: 'queue-worker',
      modelId: 'next-model',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 2,
      agentStateCiphertext: { v: 1, iv: 'next', tag: 'tag', ciphertext: 'cipher' },
      userMessageCiphertext: { v: 1, iv: 'user', tag: 'tag', ciphertext: 'cipher' },
      statusEventCiphertext: { v: 1, iv: 'status', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(promoted).toMatchObject({
      status: 'queued',
      modelId: 'next-model',
      maxComputeCredits: 3,
      queuedMessageCount: 0
    });
    await expect(store.listTaskEvents(task.id)).resolves.toMatchObject([
      { sequence: 1, kind: 'queued_message' },
      { sequence: 2, kind: 'status' },
      { sequence: 3, kind: 'user_message' }
    ]);
  });

  /**
   * The turn the owner corrected died before it could read the correction.
   *
   * Everything here is about one question: whether a message they sent is still going to happen.
   * The store is where that is decided, because it is the only place that can read the task's
   * status, its attempt count and its queue in one breath and act on all three at once.
   */
  describe('a message left over from a turn that died', () => {
    /** A task a worker is inside, with one message queued behind the turn it is running. */
    const workingTaskWithAMessage = async (
      name: string
    ): Promise<{ userId: string; taskId: string; messageId: string }> => {
      const user = await store.createUser({ username: name, displayName: name });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await store.leaseNextTask('worker-1');
      const messageId = randomUUID();
      await store.enqueueTaskMessage({
        id: messageId,
        taskId: task.id,
        userId: user.id,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 2,
        resourceClass: 'medium',
        reservationKey: `task:${task.id}:message:${messageId}:reservation`,
        interrupt: true,
        promptCiphertext: { v: 1, iv: 'queue', tag: 'tag', ciphertext: 'cipher' },
        queuedEventCiphertext: { v: 1, iv: 'event', tag: 'tag', ciphertext: 'cipher' }
      });
      return { userId: user.id, taskId: task.id, messageId };
    };

    it('puts the conversation back in the queue without spending a second budget on it', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('carried');

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toEqual({ attempt: 1, queuedMessageCount: 1 });

      // Leasable again, and the message is untouched - the loop takes it at its next step, which is
      // what the owner was told would happen before the turn died.
      const requeued = await store.getTask(userId, taskId);
      expect(requeued).toMatchObject({ status: 'queued', attempt: 1, queuedMessageCount: 1 });
      expect(requeued?.leaseOwner).toBeNull();
      await expect(store.leaseNextTask('worker-2')).resolves.toMatchObject({
        id: taskId,
        attempt: 2
      });
    });

    /**
     * The bound, and it is the one the queue already has. Nothing here invents a retry budget: the
     * attempt count is left standing on every requeue, so a failure that simply repeats walks the
     * count up to the ceiling and stops, rather than running the owner's money out against it.
     */
    it('stops at the ceiling the queue already keeps, rather than a second one of its own', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('bounded');
      let requeues = 0;
      for (let round = 0; round < TASK_MAX_ATTEMPTS * 2; round += 1) {
        if (!(await store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' }))) break;
        requeues += 1;
        // What the worker does next: the queue hands the task back out, which is the attempt.
        if (!(await store.leaseNextTask('worker-1'))) break;
      }
      expect(requeues).toBe(TASK_MAX_ATTEMPTS - 1);
      expect(await store.getTask(userId, taskId)).toMatchObject({ attempt: TASK_MAX_ATTEMPTS });
      await expect(store.leaseNextTask('worker-1')).resolves.toBeNull();
    });

    /**
     * The one thing this must never do. Stop is the owner saying stop, and a message they sent
     * before they said it cannot become the way the conversation starts itself up again.
     */
    it('never restarts a conversation the owner cancelled', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('cancelled');
      expect(await store.cancelTaskAndReleaseReservations(userId, taskId)).toBe(true);

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
      // Cancelling empties the queue, so that refusal could have come from either lock. This is the
      // other one on its own: a queued row against a stopped conversation still starts nothing.
      await database.query(
        `UPDATE task_message_queue SET status='queued' WHERE task_id=$1 AND status='cancelled'`,
        [taskId]
      );
      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
      expect(await store.getTask(userId, taskId)).toMatchObject({ status: 'cancelled' });
      await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();
    });

    it('leaves a task another worker has taken over alone', async () => {
      const { taskId } = await workingTaskWithAMessage('handed-over');
      await database.query(`UPDATE tasks SET lease_owner='worker-2' WHERE id=$1`, [taskId]);

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
    });

    it('has nothing to say about a failure with no message behind it', async () => {
      const user = await store.createUser({ username: 'plain', displayName: 'Plain' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await store.leaseNextTask('worker-1');

      await expect(
        store.requeueTaskForQueuedMessage({ id: task.id, workerId: 'worker-1' })
      ).resolves.toBeNull();
    });

    /**
     * The header pill read a count of queued rows, so a message stuck on a dead conversation was
     * advertised for ever. Taking the row out of the queue is what makes the count true again, and
     * handing it back is what stops that being the same thing as throwing it away.
     */
    it('hands back the words it can no longer deliver, and stops advertising them', async () => {
      const { userId, taskId, messageId } = await workingTaskWithAMessage('undelivered');
      await store.updateTask({ id: taskId, status: 'failed', clearLease: true });

      const stranded = await store.strandQueuedTaskMessages(taskId);
      expect(stranded).toMatchObject([
        { id: messageId, status: 'undelivered', promptCiphertext: { iv: 'queue' } }
      ]);
      expect(await store.getTask(userId, taskId)).toMatchObject({ queuedMessageCount: 0 });
      // And the ceiling it was holding against work nobody is going to do comes back.
      await expect(store.reservedUsageForTask(taskId)).resolves.toBe(0);
      // Said once. A second sweep of the same conversation has nothing left to report.
      await expect(store.strandQueuedTaskMessages(taskId)).resolves.toEqual([]);
    });

    it('leaves a message alone while the conversation can still reach it', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('still-running');

      await expect(store.strandQueuedTaskMessages(taskId)).resolves.toEqual([]);
      expect(await store.getTask(userId, taskId)).toMatchObject({ queuedMessageCount: 1 });
    });

    /**
     * A turn that takes the worker process down with it never reaches the worker's own failure
     * path, so the sweep is the only thing that ever reads these rows again.
     */
    it('clears the queue of a conversation the attempt sweep has given up on', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('swept');
      await database.query(
        `UPDATE tasks SET attempt=$2, lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
        [taskId, TASK_MAX_ATTEMPTS]
      );

      await expect(store.failTasksAtAttemptLimit()).resolves.toMatchObject([
        { id: taskId, undeliveredMessages: 1 }
      ]);
      expect(await store.getTask(userId, taskId)).toMatchObject({
        status: 'failed',
        queuedMessageCount: 0
      });
    });
  });

  it('versions task plans atomically and preserves explicit branch ancestry', async () => {
    const user = await store.createUser({ username: 'planner', displayName: 'Planner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Plan lab',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const first = await store.createTaskPlan({
      taskId: task.id,
      expectedVersion: 0,
      branchName: 'Main',
      stepsCiphertext: { v: 1, iv: 'step-a', tag: 'step-b', ciphertext: 'step-c' },
      createdBy: 'agent'
    });
    expect(first).toMatchObject({ version: 1, parentVersion: null, branchName: 'encrypted' });
    const second = await store.createTaskPlan({
      taskId: task.id,
      expectedVersion: 1,
      parentVersion: 1,
      branchName: 'User revision',
      stepsCiphertext: { v: 1, iv: 'step-d', tag: 'step-e', ciphertext: 'step-f' },
      createdBy: 'user'
    });
    expect(second).toMatchObject({ version: 2, parentVersion: 1, createdBy: 'user' });
    await expect(
      store.createTaskPlan({
        taskId: task.id,
        expectedVersion: 1,
        branchName: 'Stale writer',
        stepsCiphertext: { v: 1, iv: 'g', tag: 'h', ciphertext: 'i' },
        createdBy: 'user'
      })
    ).rejects.toThrow('plan_version_conflict');
    await expect(store.getLatestTaskPlan(task.id)).resolves.toMatchObject({ id: second.id });
    await expect(store.listTaskPlans(task.id)).resolves.toMatchObject([
      { version: 2 },
      { version: 1 }
    ]);
  });

  it('atomically rotates recovery, passkeys, and active sessions', async () => {
    const user = await store.createUser({
      username: 'recovering',
      displayName: 'Recovering user',
      recoveryHash: 'old-recovery-hash'
    });
    await store.addPasskey({
      userId: user.id,
      credentialId: 'old-credential',
      publicKey: 'old-key',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await store.createSession(user.id, 'old-session', new Date(Date.now() + 60_000));
    await store.replacePasskeysForRecovery({
      userId: user.id,
      username: user.username,
      expectedRecoveryHash: 'old-recovery-hash',
      newRecoveryHash: 'new-recovery-hash',
      passkey: {
        credentialId: 'new-credential',
        publicKey: 'new-key',
        counter: 0,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true
      }
    });
    await expect(store.listPasskeys(user.id)).resolves.toMatchObject([
      { credentialId: 'new-credential', backedUp: true }
    ]);
    await expect(store.listSessions(user.id)).resolves.toEqual([]);
    await expect(store.getUserById(user.id)).resolves.toMatchObject({
      recoveryHash: 'new-recovery-hash'
    });
    await expect(
      store.replacePasskeysForRecovery({
        userId: user.id,
        username: user.username,
        expectedRecoveryHash: 'old-recovery-hash',
        newRecoveryHash: 'attacker-hash',
        passkey: {
          credentialId: 'second-credential',
          publicKey: 'second-key',
          counter: 0,
          transports: [],
          deviceType: 'singleDevice',
          backedUp: false
        }
      })
    ).rejects.toThrow('already been rotated');
  });

  it('never removes the final passkey', async () => {
    const user = await store.createUser({ username: 'keys', displayName: 'Keys' });
    const first = await store.addPasskey({
      userId: user.id,
      credentialId: 'first-credential',
      publicKey: 'first-key',
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('last_passkey');
    const second = await store.addPasskey({
      userId: user.id,
      credentialId: 'second-credential',
      publicKey: 'second-key',
      counter: 0,
      transports: ['hybrid'],
      deviceType: 'multiDevice',
      backedUp: true
    });
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('deleted');
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('not_found');
    await expect(store.deletePasskeyForUser(user.id, second.id)).resolves.toBe('last_passkey');
    const remaining = await store.listPasskeys(user.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
    expect(typeof remaining[0]?.createdAt).toBe('string');
  });

  it('keeps a device signed in by sliding the session, and still lapses an idle one', async () => {
    const lifetime = 180 * 24 * 60 * 60;
    const user = await store.createUser({ username: 'slider', displayName: 'Slider' });
    await store.createSession(user.id, 'sliding-session', new Date(Date.now() + lifetime * 1000));

    // Freshly issued: over halfway through its window, so nothing is rewritten.
    const untouched = await store.getSession('sliding-session', lifetime);
    expect(untouched?.user.id).toBe(user.id);
    expect(untouched?.renewedExpiresAt).toBeNull();

    // Past halfway, a request renews the full window rather than letting it run out.
    await database.query("UPDATE sessions SET expires_at = NOW() + INTERVAL '10 days'");
    const renewed = await store.getSession('sliding-session', lifetime);
    expect(renewed?.user.id).toBe(user.id);
    expect(renewed?.renewedExpiresAt).toBeInstanceOf(Date);
    const stored = await database.query('SELECT expires_at FROM sessions');
    expect(new Date(String(stored.rows[0]?.expires_at)).getTime()).toBeGreaterThan(
      Date.now() + 170 * 24 * 60 * 60 * 1000
    );

    // An abandoned device is still signed out on schedule.
    await database.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second'");
    await expect(store.getSession('sliding-session', lifetime)).resolves.toBeNull();
  });

  it('leases a queued task durably', async () => {
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 50 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title-a', tag: 'title-b', ciphertext: 'title-c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const leased = await store.leaseNextTask('worker-1');
    expect(leased?.status).toBe('planning');
    expect(leased?.leaseOwner).toBe('worker-1');
  });

  /**
   * The outage this ordering exists to end: a turn that takes the worker process down with it is
   * back in the queue the moment systemd restarts, and by age it is ahead of everything the owner
   * sent while it was crashing. Ordered by attempt first, it drops a place per death and is out of
   * the queue entirely at the ceiling.
   */
  it('puts a task that keeps dying behind a healthy one, and stops leasing it at the ceiling', async () => {
    const user = await store.createUser({ username: 'queue-order', displayName: 'Queue order' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const crasher = await store.createTask(taskInput(user.id, workspace.id));
    const healthy = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      `UPDATE tasks SET attempt=$2, created_at=NOW() - INTERVAL '2 minutes' WHERE id=$1`,
      [crasher.id, TASK_MAX_ATTEMPTS - 1]
    );

    // Oldest, and still second: the message the owner sent two minutes later goes first.
    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: healthy.id, attempt: 1 });
    // Second means after it, not beside it: both of these are the same computer.
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    await database.query(
      `UPDATE tasks SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
      [healthy.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({
      id: crasher.id,
      attempt: TASK_MAX_ATTEMPTS
    });

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [crasher.id]
    );
    // The lease has expired and the status is still live, which before the ceiling was all it took
    // to be handed straight back to a worker.
    await expect(store.leaseNextTask('worker-3')).resolves.toBeNull();
  });

  /**
   * The most ordinary thing an owner does is ask about a second thing while the first is still
   * running. That must not put two agents in one filesystem, one browser and one desktop.
   */
  it('hands a workspace to one worker at a time, and leaves other workspaces alone', async () => {
    const user = await store.createUser({ username: 'one-writer', displayName: 'One writer' });
    const main = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const spare = await store.createWorkspace(workspaceInput(user.id, 'Spare'));
    const running = await store.createTask(taskInput(user.id, main.id));
    const waiting = await store.createTask(taskInput(user.id, main.id));
    const elsewhere = await store.createTask(taskInput(user.id, spare.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: running.id });
    // The second question waits; a workspace of its own is a different computer and runs at once.
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: elsewhere.id });
    await expect(store.leaseNextTask('worker-3')).resolves.toBeNull();

    // Parking the first turn hands the computer over, without waiting for any lease to run out.
    await store.updateTask({
      id: running.id,
      workerId: 'worker-1',
      status: 'awaiting_user',
      clearLease: true
    });
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: waiting.id });
  });

  /**
   * The window this closes cannot be reproduced against one connection, so what is proved here is
   * the property that makes it impossible rather than the collision itself: the answer to "is
   * anybody in this workspace" is a column on the row the statement locks, so a poll whose snapshot
   * of the tasks table is a moment out of date has nothing to read it from.
   */
  it('decides one writer from the workspace row, not from a reading of the tasks in it', async () => {
    const user = await store.createUser({ username: 'row-truth', displayName: 'Row truth' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));
    // Stands in for the turn another worker just started. Parked, so it is never a candidate here
    // and can only ever appear as a name on the hold.
    const competitor = await store.createTask(taskInput(user.id, workspace.id));
    await database.query("UPDATE tasks SET status='paused' WHERE id=$1", [competitor.id]);
    // Two rows can be created in the same instant, so which one the queue prefers is said.
    await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
      second.id
    ]);
    const hold = async (): Promise<Record<string, unknown> | undefined> =>
      (
        await database.query(
          `SELECT w.lease_task_id, w.lease_expires_at = t.lease_expires_at AS same_deadline
           FROM workspaces w LEFT JOIN tasks t ON t.id=w.lease_task_id WHERE w.id=$1`,
          [workspace.id]
        )
      ).rows[0];
    const freeEveryTaskLease = async (): Promise<unknown> =>
      database.query('UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL');

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id });
    // Written by the statement that leased the task, and written to run out at the same instant:
    // a worker that dies holding both lets go of both together, with nobody left to do it for it.
    expect(await hold()).toMatchObject({ lease_task_id: first.id, same_deadline: true });

    // Exactly what a poll a millisecond behind the winner reads. Every task in the workspace looks
    // free, and the only trace of the turn that just started is on the row being locked - which is
    // the one place the question is now asked, and the one place it was never written before.
    await database.query(
      `UPDATE workspaces SET lease_task_id=$2, lease_expires_at=NOW() + INTERVAL '1 minute'
       WHERE id=$1`,
      [workspace.id, competitor.id]
    );
    await freeEveryTaskLease();
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    // And the same row is what hands the computer back, three ways, none of which needs anything
    // to still be running to notice: a deadline that has passed, a holder that was deleted, and a
    // hold half written. A workspace nothing can take back is the one failure worse than the race.
    await database.query(
      `UPDATE workspaces SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [workspace.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id });

    await store.deleteTask(user.id, second.id);
    expect(await hold()).toMatchObject({ lease_task_id: null });
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: first.id });

    await database.query(
      `UPDATE workspaces SET lease_task_id=$2, lease_expires_at=NULL WHERE id=$1`,
      [workspace.id, competitor.id]
    );
    await freeEveryTaskLease();
    expect(await store.leaseNextTask('worker-4')).toMatchObject({ id: first.id });
  });

  /**
   * The invariant used to be eight callers each remembering one flag. A task the queue will not
   * hand out again cannot go on holding a workspace, so the status decides and the caller cannot
   * get it wrong.
   */
  it('takes the workspace back from a caller that forgot to let go of it', async () => {
    const user = await store.createUser({ username: 'forgetful', displayName: 'Forgetful' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
      second.id
    ]);
    const holder = async (): Promise<unknown> =>
      (await database.query('SELECT lease_task_id FROM workspaces WHERE id=$1', [workspace.id]))
        .rows[0]?.lease_task_id;

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id });
    // Mid-turn, still working: a status the queue would lease keeps what it was given.
    await store.updateTask({ id: first.id, workerId: 'worker-1', status: 'running' });
    expect(await holder()).toBe(first.id);

    // Parked without the flag - and the workspace comes back anyway, along with the wake-up the
    // conversation waiting behind it would otherwise have sat out a whole worker poll for.
    const startedAt = Date.now();
    const woken = store.waitForQueuedTask(4_000);
    await store.updateTask({ id: first.id, workerId: 'worker-1', status: 'awaiting_user' });
    await woken;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await holder()).toBeNull();
    expect(await store.getTask(user.id, first.id)).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null
    });
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id });
  });

  it('takes the workspace back when the worker holding it dies, and still retries its task', async () => {
    const user = await store.createUser({ username: 'dead-worker', displayName: 'Dead worker' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id, attempt: 1 });
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    // Nothing is renewing the lease any more, so the process that is gone stops holding the box.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [first.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id, attempt: 1 });

    // And the turn that died is still the same task, so it comes back rather than being lost.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [second.id]
    );
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: first.id, attempt: 2 });
  });

  /**
   * The hold is a deadline, and any answer worth waiting for outlives it. Nothing else in the
   * schema says the workspace is occupied any more, so whatever keeps a task's lease alive has to
   * keep the workspace's alive with it - otherwise the one-writer rule quietly stops applying two
   * minutes into every long turn, which is the only kind of turn during which the owner has time
   * to ask a second question.
   */
  it('holds the workspace for as long as the worker keeps saying it is alive', async () => {
    const user = await store.createUser({ username: 'long-turn', displayName: 'Long turn' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const running = await store.createTask(taskInput(user.id, workspace.id));
    const waiting = await store.createTask(taskInput(user.id, workspace.id));
    const hold = async (): Promise<Record<string, unknown> | undefined> =>
      (
        await database.query(
          `SELECT w.lease_task_id, w.lease_expires_at = t.lease_expires_at AS same_deadline
           FROM workspaces w LEFT JOIN tasks t ON t.id=w.lease_task_id WHERE w.id=$1`,
          [workspace.id]
        )
      ).rows[0];

    // A hold short enough to run out inside a test, and a turn that goes on past it.
    expect(await store.leaseNextTask('worker-1', 1)).toMatchObject({ id: running.id });
    await expect(store.renewTaskLease(running.id, 'worker-1', 120)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The original hold has run out; the turn has not, and says so every step.
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();
    // Still welded to the lease it renewed, so a worker that dies now still lets go of both at the
    // same instant and no sweep has to exist.
    expect(await hold()).toMatchObject({ lease_task_id: running.id, same_deadline: true });

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [running.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id });
  });

  /**
   * Waiting for the workspace is not an attempt at anything. If a poll that finds the workspace
   * held were to spend one, an idle worker would count a patient conversation to death in a few
   * seconds and the sweep would fail it as a task that keeps dying, having never once run.
   */
  it('spends no attempt on a conversation that is only waiting for the workspace', async () => {
    const user = await store.createUser({ username: 'patient', displayName: 'Patient' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const holder = await store.createTask(taskInput(user.id, workspace.id));
    const waiting = await store.createTask(taskInput(user.id, workspace.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id, attempt: 1 });
    for (let poll = 0; poll < TASK_MAX_ATTEMPTS + 3; poll += 1)
      await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    const untouched = await store.getTask(user.id, waiting.id);
    expect(untouched).toMatchObject({ attempt: 0, status: 'queued', leaseOwner: null });
    // And nothing swept it up as a task that has run out of tries while it stood in line.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);

    await store.updateTask({
      id: holder.id,
      workerId: 'worker-1',
      status: 'completed',
      clearLease: true
    });
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id, attempt: 1 });
  });

  /**
   * The owner is watching at exactly this moment - one answer has just finished and the question
   * they asked while it ran is next. Every door out of a turn has to say so, or the conversation
   * that was waiting for the computer sits out a whole worker poll after it became leasable.
   */
  it('wakes the queue on every door a turn leaves the workspace by', async () => {
    const user = await store.createUser({ username: 'handover', displayName: 'Handover' });
    const state: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
    const doors: Array<[string, (holderId: string) => Promise<unknown>]> = [
      [
        'end of turn',
        (id) => store.updateTask({ id, workerId: 'worker-1', status: 'paused', clearLease: true })
      ],
      [
        'finished',
        (id) =>
          store.completeTaskIfNoQueued({
            id,
            workerId: 'worker-1',
            actualComputeCredits: 1,
            agentStateCiphertext: state
          })
      ],
      ['stopped from the screen', (id) => store.setTaskStatusForUser(user.id, id, 'paused')],
      ['cancelled', (id) => store.cancelTaskAndReleaseReservations(user.id, id)],
      ['deleted', (id) => store.deleteTask(user.id, id)]
    ];
    for (const [door, release] of doors) {
      const workspace = await store.createWorkspace(workspaceInput(user.id, door));
      const holder = await store.createTask(taskInput(user.id, workspace.id));
      const waiting = await store.createTask(taskInput(user.id, workspace.id));
      // The queue hands out the older conversation first, and two writes can land in the same
      // instant here, so which of these is the holder is said rather than assumed.
      await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
        waiting.id
      ]);
      expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id });

      const startedAt = Date.now();
      const woken = store.waitForQueuedTask(4_000);
      await release(holder.id);
      await woken;
      expect(Date.now() - startedAt, door).toBeLessThan(1_000);
      expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id });

      // Left held by nobody, so the next door in this list is the only thing the queue can offer.
      await store.updateTask({
        id: waiting.id,
        workerId: 'worker-2',
        status: 'completed',
        clearLease: true
      });
    }
  });

  /**
   * A wake-up is every worker slot in the install stopping to poll, so the price of announcing one
   * that freed nothing is paid by every turn that is running at the time.
   */
  it('says nothing on a write that let go of no workspace', async () => {
    const user = await store.createUser({ username: 'quiet', displayName: 'Quiet' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Quiet'));
    const holder = await store.createTask(taskInput(user.id, workspace.id));
    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id });

    let woke = false;
    const woken = store.waitForQueuedTask(500).then(() => {
      woke = true;
    });
    // The ordinary mid-turn write: the worker is still in there and still holding the computer.
    await store.updateTask({ id: holder.id, workerId: 'worker-1', status: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(woke).toBe(false);

    // And a lease that ran out was already excluding nobody: whatever was behind it became
    // leasable when it expired, which is what the poll interval is the floor for.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [holder.id]
    );
    await store.updateTask({
      id: holder.id,
      workerId: 'worker-1',
      status: 'paused',
      clearLease: true
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(woke).toBe(false);
    await woken;
  });

  it('fails a task that has used every attempt exactly once, and gives back what it held', async () => {
    const user = await store.createUser({ username: 'exhausted', displayName: 'Exhausted' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'compute',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'credit',
      credits: 4,
      state: 'reserved',
      idempotencyKey: `task:${task.id}:reservation`
    });
    await database.query(
      `UPDATE tasks SET status='running', attempt=$2, lease_owner='worker-1',
         lease_expires_at=NOW() + INTERVAL '2 minutes' WHERE id=$1`,
      [task.id, TASK_MAX_ATTEMPTS]
    );

    // A live lease means a worker is in there renewing it, whatever the count says.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [task.id]
    );
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([
      {
        id: task.id,
        userId: user.id,
        workspaceId: workspace.id,
        attempt: TASK_MAX_ATTEMPTS,
        undeliveredMessages: 0
      }
    ]);
    expect((await store.getTask(user.id, task.id))?.status).toBe('failed');
    await expect(store.reservedUsageForTask(task.id)).resolves.toBe(0);
    // Exactly once, so the owner is told once: the statement that finds the rows is the statement
    // that moves them out of the statuses it looks at.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);
  });

  it('starts the count again whenever a task re-enters the queue, so a long conversation never runs out', async () => {
    const user = await store.createUser({ username: 'long-run', displayName: 'Long run' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const attemptOf = async (): Promise<number | undefined> =>
      (await store.getTask(user.id, task.id))?.attempt;

    // Many more turns than the ceiling: an approval answered, a pause resumed, a follow-up sent -
    // each one is a fresh start, and the ceiling must not be counting them.
    for (let turn = 0; turn < TASK_MAX_ATTEMPTS + 2; turn += 1) {
      expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: task.id, attempt: 1 });
      await store.updateTask({
        id: task.id,
        workerId: 'worker-1',
        status: 'awaiting_user',
        clearLease: true
      });
      // Parked, not queued: the count stands until something puts it back in the queue, which is
      // what keeps `attempt = 0` meaning "never leased" for the scheduled-run recovery sweep.
      expect(await attemptOf()).toBe(1);
      await store.setTaskStatusForUser(user.id, task.id, 'queued');
      expect(await attemptOf()).toBe(0);
    }

    // A lease that simply expires - the worker died - is the one that counts.
    await store.leaseNextTask('worker-1');
    await database.query(`UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second'`);
    await store.leaseNextTask('worker-2');
    expect(await attemptOf()).toBe(2);

    // And the way back in for a task the ceiling stopped: the owner writes again.
    await database.query(
      `UPDATE tasks SET status='failed', attempt=$2, lease_owner=NULL WHERE id=$1`,
      [task.id, TASK_MAX_ATTEMPTS]
    );
    const continued = await store.continueTask({
      id: task.id,
      userId: user.id,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      agentStateCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      reservationKey: `task:${task.id}:turn:1:reservation`,
      resourceClass: 'medium',
      userMessageCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    expect(continued).toMatchObject({ status: 'queued', attempt: 0 });
    await expect(store.leaseNextTask('worker-3')).resolves.toMatchObject({ id: task.id });
  });

  it('materialises a due schedule exactly once, whichever worker got there first', async () => {
    const user = await store.createUser({ username: 'scheduler', displayName: 'Scheduler' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Scheduled work',
      storageLimitBytes: 20 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const periodStart = new Date(Date.now() - 60_000);
    const periodEnd = new Date(Date.now() + 86_400_000);
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    const updatedSchedule = await store.updateTaskSchedule(user.id, schedule.id, {
      titleCiphertext: { ...envelope, ciphertext: 'updated-title' },
      promptCiphertext: { ...envelope, ciphertext: 'updated-prompt' },
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      maxComputeCredits: 1.5,
      nextRunAt: new Date(Date.now() + 120_000)
    });
    expect(updatedSchedule).toMatchObject({
      id: schedule.id,
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      maxComputeCredits: 1.5
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    const leased = await store.leaseDueTaskSchedule('scheduler-1');
    expect(leased?.id).toBe(schedule.id);
    await expect(store.leaseDueTaskSchedule('scheduler-2')).resolves.toBeNull();
    const taskId = '00000000-0000-4000-8000-000000000001';
    const materialized = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-1',
      taskId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(materialized).toMatchObject({ outcome: 'queued', errorCode: null });
    expect(materialized?.task.status).toBe('awaiting_resource');
    // Where the run came from is written by the statement that creates it, and survives the read
    // path: it is the only thing that lets the sidebar fold a watcher's runs into one line rather
    // than interleaving ninety-six of them a day with the owner's own conversations.
    expect(materialized?.task.scheduleId).toBe(schedule.id);
    await expect(store.getTask(user.id, taskId)).resolves.toMatchObject({
      scheduleId: schedule.id
    });
    await expect(
      store.materializeTaskSchedule({
        scheduleId: schedule.id,
        workerId: 'scheduler-1',
        taskId: '00000000-0000-4000-8000-000000000002',
        nextRunAt: null,
        resourceClass: 'medium',
        preparingEventCiphertext: envelope,
        failureEventCiphertext: envelope
      })
    ).resolves.toBeNull();
    await expect(store.usageTotals(user.id, periodStart, periodEnd)).resolves.toMatchObject({
      reserved: 1.5
    });

    // A run the caller has already decided against - an unavailable model, a workspace that is not
    // there - still lands as a failed task with its reason, rather than as silence.
    const refused = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      spec: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query(
      "UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
      [refused.id]
    );
    await store.leaseDueTaskSchedule('scheduler-1');
    const failed = await store.materializeTaskSchedule({
      scheduleId: refused.id,
      workerId: 'scheduler-1',
      taskId: '00000000-0000-4000-8000-000000000003',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope,
      forceFailureCode: 'model_unavailable'
    });
    expect(failed).toMatchObject({ outcome: 'failed', errorCode: 'model_unavailable' });
    expect(failed?.task.status).toBe('failed');
    // A run that never started reserves nothing, so the earlier reservation is all there is.
    await expect(store.usageTotals(user.id, periodStart, periodEnd)).resolves.toMatchObject({
      reserved: 1.5
    });
  });

  it('tracks user-owned workspace snapshots', async () => {
    const user = await store.createUser({ username: 'snapshot', displayName: 'Snapshot' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const snapshot = await store.createWorkspaceSnapshot({
      userId: user.id,
      workspaceId: workspace.id,
      name: 'Before upgrade',
      sizeBytes: workspace.storageLimitBytes
    });
    await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'ready');
    await expect(store.listWorkspaceSnapshots(user.id, workspace.id)).resolves.toMatchObject([
      { id: snapshot.id, name: 'Before upgrade', status: 'ready', sizeBytes: 10 * 1024 ** 3 }
    ]);
    await expect(
      store.deleteWorkspaceSnapshot(user.id, workspace.id, String(snapshot.id))
    ).resolves.toBe(true);
    await expect(store.listWorkspaceSnapshots(user.id, workspace.id)).resolves.toEqual([]);
  });

  it('stores connector secrets as ciphertext and records content-free capability audit', async () => {
    const user = await store.createUser({ username: 'connector', displayName: 'Connector' });
    const connector = await store.createConnector({
      id: '00000000-0000-4000-8000-000000000101',
      userId: user.id,
      kind: 'github',
      authMode: 'secret',
      label: 'Work GitHub',
      baseUrl: 'https://api.github.com',
      scopes: ['github:repository.read'],
      secretCiphertext: {
        v: 1,
        iv: 'encrypted-iv',
        tag: 'encrypted-tag',
        ciphertext: 'encrypted-secret',
        aad: `connector:${user.id}:00000000-0000-4000-8000-000000000101`
      }
    });
    expect(connector).toMatchObject({
      kind: 'github',
      scopes: ['github:repository.read'],
      enabled: true,
      lastUsedAt: null
    });
    const raw = await database.query('SELECT * FROM connectors WHERE id=$1', [connector.id]);
    expect(JSON.stringify(raw.rows)).not.toContain('plaintext-token');
    await store.recordConnectorAudit({
      connectorId: connector.id,
      userId: user.id,
      operation: 'github_list_repositories',
      outcome: 'succeeded',
      statusCode: 200,
      responseBytes: 128,
      durationMs: 12
    });
    await expect(store.listConnectorAudit(user.id)).resolves.toMatchObject([
      {
        connectorId: connector.id,
        operation: 'github_list_repositories',
        outcome: 'succeeded',
        statusCode: 200,
        responseBytes: 128,
        durationMs: 12
      }
    ]);
    expect((await store.listConnectors(user.id))[0]?.lastUsedAt).not.toBeNull();
    await expect(store.revokeConnector(user.id, connector.id)).resolves.toBe(true);
    await expect(store.getConnector(user.id, connector.id)).resolves.toBeNull();
  });

  it('limits, rotates, publishes, expires, and revokes isolated workspace previews', async () => {
    const user = await store.createUser({ username: 'preview', displayName: 'Preview' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'App',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const preview = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Private app',
      port: 3000,
      slug: '0123456789abcdef0123456789abcdef',
      accessTokenHash: 'first-hash',
      maxPreviews: 1
    });
    await expect(
      store.createWorkspacePreview({
        userId: user.id,
        workspaceId: workspace.id,
        label: 'Second',
        port: 3001,
        slug: 'abcdef0123456789abcdef0123456789',
        accessTokenHash: 'second-hash',
        maxPreviews: 1
      })
    ).rejects.toThrow('preview_limit');
    await expect(
      store.rotateWorkspacePreviewAccess(user.id, preview.id, 'rotated-hash')
    ).resolves.toMatchObject({ accessTokenHash: 'rotated-hash' });
    await expect(
      store.publishWorkspacePreview(user.id, preview.id, 'public', 'public-hash')
    ).resolves.toMatchObject({
      visibility: 'public',
      accessTokenHash: 'public-hash',
      expiresAt: null
    });
    await store.touchWorkspacePreview(preview.id);
    expect((await store.getWorkspacePreviewBySlug(preview.slug))?.lastAccessedAt).not.toBeNull();
    await expect(store.revokeWorkspacePreview(user.id, preview.id)).resolves.toBe(true);
    await expect(
      store.rotateWorkspacePreviewAccess(user.id, preview.id, 'late-hash')
    ).resolves.toBeNull();
  });

  it('replays completed operations, rejects cross-operation keys, and retries failed work', async () => {
    const user = await store.createUser({ username: 'grace', displayName: 'Grace' });
    const input = {
      userId: user.id,
      idempotencyKey: 'stable-key-0001',
      method: 'POST',
      path: '/v1/workspaces',
      requestHash: 'hash-a'
    };
    await expect(store.beginOperation(input)).resolves.toBeNull();
    await store.completeOperation(user.id, input.idempotencyKey, 200, { id: 'one' });
    await expect(store.beginOperation(input)).resolves.toMatchObject({
      state: 'completed',
      method: 'POST',
      path: '/v1/workspaces',
      responseBody: { id: 'one' }
    });
    await expect(store.beginOperation({ ...input, path: '/v1/tasks' })).resolves.toMatchObject({
      path: '/v1/workspaces',
      requestHash: 'hash-a'
    });

    const retry = { ...input, idempotencyKey: 'stable-key-0002' };
    await expect(store.beginOperation(retry)).resolves.toBeNull();
    await store.failOperation(user.id, retry.idempotencyKey);
    await expect(store.beginOperation(retry)).resolves.toBeNull();
  });

  it('queues only undelivered generic notification references for new device subscriptions', async () => {
    const user = await store.createUser({ username: 'lin', displayName: 'Lin' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Cloud',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'session-hash',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/opaque',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'private-title', tag: 'title-tag', ciphertext: 'title-data' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'browser.submit',
      sideEffect: 'external_write',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'completed');

    const pending = await store.listPendingNotifications();
    // The approval leads. Both land in the same instant here, and the agent is stopped until the
    // approval is answered while a finished task is only news - so ordering by timestamp alone left
    // it to chance which one the owner's phone showed first, and left two reads of the same page
    // disagreeing about their order.
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'approval_required', resourceId: approvalId },
      { kind: 'task_finished', resourceId: task.id }
    ]);
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(pending.map((row) => row.kind));
    expect(JSON.stringify(pending)).not.toContain('private-title');
    await store.recordNotificationDelivery(subscription.id, 'task_finished', task.id);
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'approval_required', resourceId: approvalId }
    ]);
    await store.deleteSessionForUser(user.id, (await store.listSessions(user.id))[0]!.id as string);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('wakes a reader on the write rather than making it ask again a second later', async () => {
    const user = await store.createUser({ username: 'signal', displayName: 'Signal' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Signal'));

    // A worker with nothing to do waits on the queue, and a send ends that wait immediately -
    // this is what used to cost up to a full poll interval before the model was even called.
    const startedAt = Date.now();
    const waited = store.waitForQueuedTask(5_000);
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await waited;
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    // And an open activity stream is told about its own conversation, and only its own.
    const woken: string[] = [];
    const other = await store.createTask(taskInput(user.id, workspace.id));
    const unsubscribe = store.onTaskEvent(task.id, () => woken.push('woken'));
    await store.appendTaskEvent({ taskId: other.id, kind: 'status', summary: 'Elsewhere' });
    expect(woken).toEqual([]);
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_delta', summary: 'Reply' });
    expect(woken).toEqual(['woken']);

    unsubscribe();
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_delta', summary: 'More' });
    expect(woken).toEqual(['woken']);
  });

  it('raises a spend pause, names the conversation, and keeps titles sealed without a key', async () => {
    const masterKey = Buffer.alloc(32, 5);
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const dataKey = generateDataKey();
    // The key is wrapped against the workspace id, so the id is chosen before the row is written.
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf1';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Cloud'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'spend-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/spend',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson(
        { title: 'Rebuild the invoice script' },
        dataKey,
        `task-title:${workspace.id}`
      )
    });

    // An ordinary Pause is the owner's own decision and needs no notification.
    await store.updateTask({ id: task.id, status: 'paused' });
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // A pause at a spending ceiling is the one nobody chose, and it waits forever unheard.
    await store.updateTask({ id: task.id, status: 'paused', spendPausedAt: new Date() });
    const pending = await store.listPendingNotifications(100, masterKey);
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'spend_paused', resourceId: task.id }
    ]);
    expect(pending[0]!.taskTitle).toBe('Rebuild the invoice script');

    // Without the master key the row still describes the pause and reveals nothing about it.
    const sealed = await store.listPendingNotifications();
    expect(sealed[0]!.taskTitle).toBeNull();
    expect(JSON.stringify(sealed)).not.toContain('invoice');

    await store.recordNotificationDelivery(subscription.id, 'spend_paused', task.id);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // Resuming answers the pause, so it can never be raised a second time for the same stop.
    await store.setTaskStatusForUser(user.id, task.id, 'queued');
    await store.updateTask({ id: task.id, status: 'paused', spendPausedAt: new Date() });
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('stores the kinds the owner kept and the window the box may not wake them in', async () => {
    const user = await store.createUser({ username: 'quiet', displayName: 'Quiet' });
    // Nothing stored is not "notify nothing": it is the default, and the caller supplies it.
    await expect(store.notificationSettings(user.id)).resolves.toBeNull();

    // Every kind that can reach a device has a switch, the two the agent raises included: the one
    // notification the owner asked for should not also be the one they cannot turn down.
    const kinds = {
      approval_required: true,
      task_finished: false,
      spend_paused: true,
      agent_message: true,
      takeover_needed: false
    };
    await store.setNotificationSettings(user.id, {
      kinds,
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
      quietHoursAllowApprovals: false
    });
    await expect(store.notificationSettings(user.id)).resolves.toEqual({
      kinds,
      quietHours: { startMinute: 1320, endMinute: 420 },
      quietHoursAllowApprovals: false
    });

    // A null window is how quiet hours are switched off; there is no second flag to disagree with.
    await store.setNotificationSettings(user.id, {
      kinds: { ...kinds, task_finished: true, takeover_needed: true },
      quietHours: null,
      quietHoursAllowApprovals: true
    });
    await expect(store.notificationSettings(user.id)).resolves.toMatchObject({
      kinds: { ...kinds, task_finished: true, takeover_needed: true },
      quietHours: null
    });
  });

  it('keeps a private preview alive while it is used and closes it once it is not', async () => {
    const user = await store.createUser({ username: 'persistent', displayName: 'Persistent' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'App'));
    const daysAway = (value: string | null): number =>
      (new Date(String(value)).getTime() - Date.now()) / 86_400_000;

    // Created with no lifetime to choose: the deadline is an idle window, not a countdown.
    const preview = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Club site',
      port: 3000,
      slug: '0123456789abcdef0123456789abcdef',
      accessTokenHash: 'hash'
    });
    expect(daysAway(preview.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);

    // A month of silence would end it, and one visit puts the whole window back.
    await database.query(
      "UPDATE workspace_previews SET expires_at=NOW()+INTERVAL '2 hours' WHERE id=$1",
      [preview.id]
    );
    await store.touchWorkspacePreview(preview.id);
    const visited = await store.getWorkspacePreviewBySlug(preview.slug);
    expect(daysAway(visited!.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);
    expect(visited!.lastAccessedAt).not.toBeNull();

    // Publishing is not a lease: a public address stays until it is taken down.
    const published = await store.publishWorkspacePreview(
      user.id,
      preview.id,
      'public',
      'public-hash'
    );
    expect(published?.expiresAt).toBeNull();
    // ...and a published site has no deadline for a visit to move.
    await store.touchWorkspacePreview(preview.id);
    await expect(store.getWorkspacePreviewBySlug(preview.slug)).resolves.toMatchObject({
      expiresAt: null
    });

    // Taking it private again restores the idle window rather than a grace period.
    const unpublished = await store.publishWorkspacePreview(
      user.id,
      preview.id,
      'private',
      'private-hash'
    );
    expect(daysAway(unpublished!.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);
  });

  it('pushes what the agent asked to say, and nothing when a scheduled run merely ends', async () => {
    const masterKey = Buffer.alloc(32, 7);
    const user = await store.createUser({ username: 'watcher', displayName: 'Watcher' });
    const dataKey = generateDataKey();
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf2';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Watch'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'watch-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/watch',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: encryptJson(
        { title: 'Watch the permit page' },
        dataKey,
        `task-title:${workspace.id}`
      ),
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-watch');
    const runId = '00000000-0000-4000-8000-0000000000a1';
    await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-watch',
      taskId: runId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });

    // Ninety-six times a day, this used to be a notification saying only that a timer had fired.
    await store.setTaskStatusForUser(user.id, runId, 'completed');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    const raised = await store.createAgentNotification({
      userId: user.id,
      taskId: runId,
      kind: 'agent_message',
      messageCiphertext: encryptJson(
        { message: 'Three September slots opened on the permit page.' },
        dataKey,
        agentNotificationAad(runId)
      )
    });
    const pending = await store.listPendingNotifications(100, masterKey);
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'agent_message', resourceId: raised.id }
    ]);
    expect(pending[0]!.message).toBe('Three September slots opened on the permit page.');
    expect(pending[0]!.taskTitle).toBe('Watch the permit page');

    // Without the master key the row still routes the push and says nothing about its contents.
    const sealed = await store.listPendingNotifications();
    expect(sealed[0]!.message).toBeNull();
    expect(JSON.stringify(sealed)).not.toContain('September');

    await store.recordNotificationDelivery(
      (await store.listPendingNotifications())[0]!.id,
      'agent_message',
      raised.id
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // A takeover is the agent stopped, so it goes ahead of news that merely happened.
    const takeover = await store.createAgentNotification({
      userId: user.id,
      taskId: runId,
      kind: 'takeover_needed',
      messageCiphertext: encryptJson(
        { message: 'A bot check is blocking the permit page.' },
        dataKey,
        agentNotificationAad(runId)
      )
    });
    await database.query(
      'UPDATE agent_notifications SET created_at=(SELECT completed_at FROM tasks WHERE id=$1) WHERE id=$2',
      [runId, takeover.id]
    );
    const manual = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson({ title: 'By hand' }, dataKey, `task-title:${workspace.id}`)
    });
    await store.setTaskStatusForUser(user.id, manual.id, 'completed');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['takeover_needed', 'task_finished']);
  });

  it('keeps a standing record of everything the agent has said, whether or not it was pushed', async () => {
    const masterKey = Buffer.alloc(32, 9);
    const user = await store.createUser({ username: 'reader', displayName: 'Reader' });
    const dataKey = generateDataKey();
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf3';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Watching'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson({ title: 'Permit watch' }, dataKey, `task-title:${workspaceId}`)
    });
    const say = async (message: string) =>
      store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: encryptJson({ message }, dataKey, agentNotificationAad(task.id))
      });
    await say('Three September slots opened.');
    const newest = await say('They went again overnight.');

    // Newest first, and settled deliveries do not remove anything: a push having reached a phone
    // says nothing about whether the owner read it.
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'record-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/record',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    await store.recordNotificationDelivery(subscription.id, 'agent_message', newest.id);
    const read = await store.listAgentNotifications(user.id, 50, masterKey);
    expect(read.map((row) => row.message)).toEqual([
      'They went again overnight.',
      'Three September slots opened.'
    ]);
    expect(read[0]).toMatchObject({ kind: 'agent_message', taskTitle: 'Permit watch' });

    // Without the key the rows are still there and still say nothing.
    const sealed = await store.listAgentNotifications(user.id);
    expect(sealed.map((row) => row.message)).toEqual([null, null]);
    expect(JSON.stringify(sealed)).not.toContain('September');

    // Another account's conversations are not part of this owner's record.
    const stranger = await store.createUser({ username: 'elsewhere', displayName: 'Elsewhere' });
    await expect(store.listAgentNotifications(stranger.id, 50, masterKey)).resolves.toEqual([]);
  });

  it('bounds how many notifications one conversation can raise', async () => {
    const user = await store.createUser({ username: 'loop', displayName: 'Loop' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Loop'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    for (let raised = 0; raised < MAX_AGENT_NOTIFICATIONS_PER_TASK; raised += 1) {
      await store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      });
    }
    await expect(
      store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      })
    ).rejects.toThrow('notifications');
    await expect(
      database.query('SELECT COUNT(*) AS count FROM agent_notifications WHERE task_id=$1', [
        task.id
      ])
    ).resolves.toMatchObject({ rows: [{ count: MAX_AGENT_NOTIFICATIONS_PER_TASK }] });

    // A conversation belonging to somebody else is not a conversation to notify about.
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    await expect(
      store.createAgentNotification({
        userId: stranger.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      })
    ).rejects.toThrow('Conversation not found');
  });

  it('tells the owner when a scheduled run breaks, and stops re-offering stale news', async () => {
    const user = await store.createUser({ username: 'broken', displayName: 'Broken' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Broken'));
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'broken-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/broken',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-broken');
    const runId = '00000000-0000-4000-8000-0000000000b1';
    await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-broken',
      taskId: runId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    // Silence about a watcher that has stopped watching is the one silence that costs something.
    await store.setTaskStatusForUser(user.id, runId, 'failed');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['task_finished']);

    // A terminal task stays terminal, so without a horizon it would be offered forever and the
    // ledger row that settles it could never be pruned.
    await database.query(
      "UPDATE tasks SET completed_at=NOW()-INTERVAL '20 days', updated_at=NOW()-INTERVAL '20 days' WHERE id=$1",
      [runId]
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    await store.recordNotificationDelivery(subscription.id, 'task_finished', runId);
    await database.query(
      "UPDATE notification_deliveries SET delivered_at=NOW()-INTERVAL '45 days'"
    );
    await store.cleanupExpired();
    await expect(
      database.query('SELECT COUNT(*) AS count FROM notification_deliveries')
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('replaces the recovery code for an owner who still holds a passkey', async () => {
    const user = await store.createUser({
      username: 'lost-paper',
      displayName: 'Lost Paper',
      recoveryHash: await hashRecoveryCode('original-code')
    });
    await expect(
      store.setRecoveryHash(user.id, await hashRecoveryCode('replacement'))
    ).resolves.toBe(true);
    const stored = (await store.getUserByUsername('lost-paper'))!.recoveryHash!;
    await expect(verifyRecoveryCode('original-code', stored)).resolves.toBe(false);
    await expect(verifyRecoveryCode('replacement', stored)).resolves.toBe(true);
  });

  it('round-trips live catalogue enrichment, and leaves pre-enrichment rows undefined', async () => {
    const base = {
      id: 'openrouter/z-ai/glm-5.2',
      providerModelId: 'z-ai/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'available',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 200_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools'],
      usageClass: 'high',
      recommendationTags: ['Tools'],
      measuredQuality: 0.7,
      measuredLatencyMs: 900,
      inputUsdPerMillionTokens: 4,
      outputUsdPerMillionTokens: 12,
      benchmarkRank: 3,
      benchmarkSource: 'artificial-analysis',
      benchmarkUpdatedAt: '2026-07-01T00:00:00.000Z'
    };
    await store.upsertModels([
      {
        ...base,
        agenticQuality: 0.81,
        codingQuality: 0.74,
        intelligenceQuality: 0.66,
        providerAvailable: true,
        zeroDataRetentionAvailable: false
      }
    ]);

    await expect(store.listModels()).resolves.toMatchObject([
      {
        id: base.id,
        agenticQuality: 0.81,
        codingQuality: 0.74,
        intelligenceQuality: 0.66,
        providerAvailable: true,
        zeroDataRetentionAvailable: false
      }
    ]);

    // The fields an unattended server routes on used to be written by one hand-kept list and read
    // back by another, so anything the two disagreed about was dropped in transit and the whole
    // routing layer ran on defaults it had never been told to use. They now share one contract.
    await store.upsertModels([
      {
        ...base,
        metadataSource: 'declared',
        promptCacheStyle: 'explicit',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxOutputTokens: 32_768,
        uptimeLast1dPercent: 99.4
      }
    ]);
    await expect(store.listModels()).resolves.toMatchObject([
      {
        id: base.id,
        metadataSource: 'declared',
        promptCacheStyle: 'explicit',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxOutputTokens: 32_768,
        uptimeLast1dPercent: 99.4
      }
    ]);

    // A row written before enrichment existed carries only the price and benchmark keys.
    await database.query(`UPDATE model_releases SET metadata=$1::jsonb`, [
      JSON.stringify({ inputUsdPerMillionTokens: 4, benchmarkRank: 3 })
    ]);
    const [legacy] = await store.listModels();
    expect(legacy).toMatchObject({ id: base.id, agenticQuality: null, codingQuality: null });
    expect(legacy).not.toHaveProperty('providerAvailable');
    expect(legacy).not.toHaveProperty('zeroDataRetentionAvailable');
  });

  it('applies every migration exactly once when two services migrate at the same moment', async () => {
    const shared = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    try {
      await Promise.all([migrateDatabase(shared), migrateDatabase(shared)]);
      const applied = await shared.query<{ version: number; applications: string }>(
        'SELECT version,COUNT(*) AS applications FROM schema_migrations GROUP BY version'
      );
      expect(applied.rows).toHaveLength(migrations.length);
      expect(applied.rows.filter((row) => Number(row.applications) !== 1)).toEqual([]);
    } finally {
      await shared.close();
    }
    // Migrating a second database inside one test file is minutes of embedded-PostgreSQL work on a
    // loaded machine; the ceiling is the suite's, not the default five seconds.
  }, 60_000);

  it('refuses to run against a database a newer build has already migrated', async () => {
    const newer = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    try {
      await migrateDatabase(newer);
      // What an update that migrated and was then rolled back by hand leaves behind: a schema this
      // build has never seen. Starting anyway is the expensive mistake, because an older build
      // writes rows that satisfy the constraints it remembers and nothing complains until later.
      const ahead = Math.max(...migrations.map((migration) => migration.version)) + 1;
      await newer.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [
        ahead,
        'from_a_newer_build'
      ]);
      await expect(migrateDatabase(newer)).rejects.toThrow(/migrated by a newer athanor/);
      await expect(migrateDatabase(newer)).rejects.toThrow(new RegExp(`version ${ahead}`));
    } finally {
      await newer.close();
    }
  }, 60_000);

  it('deletes an account and everything hanging off it', async () => {
    const owner = await store.createUser({ username: 'departing', displayName: 'Departing' });
    const workspace = await store.createWorkspace(workspaceInput(owner.id, 'Everything'));
    const task = await store.createTask(taskInput(owner.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Do it' });

    await expect(store.deleteUser(owner.id)).resolves.toBe(true);

    // The account is the root of the graph on a one-owner box, so nothing survives it: no orphan
    // workspace holding a wrapped key, and no transcript nobody can reach.
    for (const table of ['workspaces', 'workspace_keys', 'tasks', 'task_events'])
      await expect(
        database
          .query(`SELECT COUNT(*) AS count FROM ${table}`)
          .then((r) => Number(r.rows[0]!.count))
      ).resolves.toBe(0);
  });

  it('drops streamed deltas as soon as the message that closes them lands', async () => {
    const user = await store.createUser({ username: 'retention', displayName: 'Retention' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long answers'));
    const live = await store.createTask(taskInput(user.id, workspace.id));
    const interrupted = await store.createTask(taskInput(user.id, workspace.id));
    const legacy = await store.createTask(taskInput(user.id, workspace.id));

    for (const summary of ['Thinking', 'Thinking again'])
      await store.appendTaskEvent({ taskId: live.id, kind: 'assistant_delta', summary });
    const closing = await store.appendTaskEvent({
      taskId: live.id,
      kind: 'assistant_message',
      summary: 'Answer'
    });
    // A second reply on the same still-running task streams and closes the same way.
    await store.appendTaskEvent({ taskId: live.id, kind: 'assistant_delta', summary: 'More' });
    await store.appendTaskEvent({ taskId: live.id, kind: 'user_message', summary: 'Follow-up' });

    await store.appendTaskEvent({
      taskId: interrupted.id,
      kind: 'assistant_delta',
      summary: 'Thinking'
    });
    await database.query("UPDATE tasks SET status='failed' WHERE id=$1", [interrupted.id]);

    // Rows a previous version of the writer left behind still need the retention sweep.
    for (const [sequence, kind] of [
      [1, 'assistant_delta'],
      [2, 'assistant_delta'],
      [3, 'assistant_message']
    ] as const)
      await database.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary)
         VALUES (gen_random_uuid(),$1,$2,$3,'Encrypted event')`,
        [legacy.id, sequence, kind]
      );
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [legacy.id]);

    const kinds = async (taskId: string): Promise<string[]> =>
      (await store.listTaskEvents(taskId)).map((event) => event.kind);
    // The task is still running and its deltas are already gone: the closing message is the
    // authoritative text, so replaying the superseded snapshots would only cost bytes.
    await expect(kinds(live.id)).resolves.toEqual([
      'assistant_message',
      'assistant_delta',
      'user_message'
    ]);
    expect(closing.sequence).toBe(3);
    // Nothing superseded this one: the partial answer is all the failed task ever produced.
    await expect(kinds(interrupted.id)).resolves.toEqual(['assistant_delta']);

    await store.cleanupExpired();
    await expect(kinds(legacy.id)).resolves.toEqual(['assistant_message']);
    await expect(kinds(interrupted.id)).resolves.toEqual(['assistant_delta']);
  });

  it('drops the thinking frames as soon as the row carrying the whole of it lands', async () => {
    const user = await store.createUser({ username: 'thinker', displayName: 'Thinker' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long thoughts'));
    const task = await store.createTask(taskInput(user.id, workspace.id));

    for (const summary of ['Consider', 'Reconsider'])
      await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_reasoning', summary });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_reasoning',
      summary: 'All of it',
      replacesEarlierFrames: true
    });
    // Unlike the answer, the thinking has no closing row of another kind to supersede its frames,
    // so nothing pruned them and a high-effort turn left hundreds behind for good.
    const summaries = async (): Promise<string[]> =>
      (await store.listTaskEvents(task.id)).map((event) => event.summary);
    await expect(summaries()).resolves.toEqual(['All of it']);

    // The next step thinks, and closes its own thinking the same way. What it carries is its own
    // run, so the step that already closed has to survive it: the consolidating row is the same
    // kind as the frames, and taking every earlier one would leave a long task holding only the
    // thinking of whichever step ran last.
    await store.appendTaskEvent({ taskId: task.id, kind: 'tool_result', summary: 'Read it' });
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_reasoning', summary: 'More' });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_reasoning',
      summary: 'All of that too',
      replacesEarlierFrames: true
    });
    await expect(summaries()).resolves.toEqual(['All of it', 'Read it', 'All of that too']);
  });

  it('serves a task timeline as bounded pages in both directions', async () => {
    const user = await store.createUser({ username: 'pager', displayName: 'Pager' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Busy'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      `INSERT INTO task_events(id,task_id,sequence,kind,summary)
       SELECT gen_random_uuid(), $1, g, 'tool_result', 'Encrypted event'
       FROM generate_series(1, 450) g`,
      [task.id]
    );

    // Opening the task costs a page, not the 450-event history it happens to have.
    const newest = await store.listRecentTaskEvents(task.id, 100);
    expect(newest.events).toHaveLength(100);
    expect(newest.events[0]!.sequence).toBe(351);
    expect(newest.oldestSequence).toBe(351);
    expect(newest.nextCursor).toBe(450);
    expect(newest.hasMore).toBe(true);

    // Older material is reachable on demand, oldest first however it was fetched.
    const older = await store.listTaskEventPage(task.id, {
      before: newest.oldestSequence!,
      limit: 100
    });
    expect(older.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => 251 + index)
    );
    expect(older.hasMore).toBe(true);

    // Forward paging from a cursor is what the live stream resumes with.
    const forward = await store.listTaskEventPage(task.id, { after: 440, limit: 100 });
    expect(forward.events).toHaveLength(10);
    expect(forward.hasMore).toBe(false);
    expect(forward.nextCursor).toBe(450);

    // A page is never unbounded, whatever it is asked for.
    const capped = await store.listTaskEventPage(task.id, { limit: 10_000 });
    expect(capped.events.length).toBeLessThanOrEqual(500);

    const empty = await store.listRecentTaskEvents(
      (await store.createTask(taskInput(user.id, workspace.id))).id
    );
    expect(empty).toEqual({ events: [], hasMore: false, oldestSequence: null, nextCursor: 0 });
  });

  it('prunes a withdrawn model and never empties the catalogue on a failed refresh', async () => {
    const release = (id: string, provider: string): Record<string, unknown> => ({
      id,
      providerModelId: id.split('/').slice(1).join('/'),
      displayName: id,
      provider,
      revision: 'r1',
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'Provider-defined',
      commercialUse: true,
      privacyRoute: 'external',
      contextTokens: 128_000,
      modalities: ['text'],
      capabilities: ['chat'],
      usageClass: 'medium',
      recommendationTags: [],
      measuredQuality: null,
      measuredLatencyMs: null
    });
    await store.upsertModels([
      release('openrouter/vendor/kept', 'openrouter'),
      release('openrouter/vendor/withdrawn', 'openrouter'),
      release('custom/local-model', 'custom')
    ]);

    const refreshed = await store.replaceModelCatalog([
      release('openrouter/vendor/kept', 'openrouter'),
      release('openrouter/vendor/new', 'openrouter')
    ]);
    expect(refreshed).toEqual({ upserted: 2, removed: 1, retired: 0 });
    // The withdrawn model is gone; a provider the refresh said nothing about is untouched.
    await expect(
      store.listModels().then((models) => models.map((model) => model.id))
    ).resolves.toEqual(['custom/local-model', 'openrouter/vendor/kept', 'openrouter/vendor/new']);

    // A provider outage returns nothing, and nothing is what it is allowed to remove.
    await expect(store.replaceModelCatalog([])).resolves.toEqual({
      upserted: 0,
      removed: 0,
      retired: 0
    });
    await expect(store.listModels()).resolves.toHaveLength(3);
  });

  it('retires rather than deletes a withdrawn model something is still pinned to', async () => {
    const user = await store.createUser({ username: 'pinner', displayName: 'Pinner' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Pinned room'));
    const release = (id: string): Record<string, unknown> => ({
      id,
      providerModelId: id.split('/').slice(1).join('/'),
      displayName: id,
      provider: 'openrouter',
      revision: 'r1',
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'Provider-defined',
      commercialUse: true,
      privacyRoute: 'external',
      contextTokens: 128_000,
      modalities: ['text'],
      capabilities: ['chat'],
      usageClass: 'medium',
      recommendationTags: [],
      measuredQuality: null,
      measuredLatencyMs: null
    });
    await store.upsertModels([
      release('openrouter/vendor/scheduled'),
      release('openrouter/vendor/running'),
      release('openrouter/vendor/finished'),
      release('openrouter/vendor/survivor')
    ]);
    await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'i', tag: 't', ciphertext: 'c' },
      promptCiphertext: { v: 1, iv: 'i', tag: 't', ciphertext: 'c' },
      modelId: 'openrouter/vendor/scheduled',
      privacyRoute: 'external',
      maxComputeCredits: 10,
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      nextRunAt: new Date(Date.now() + 3_600_000)
    });
    const live = await store.createTask({
      ...taskInput(user.id, workspace.id),
      modelId: 'openrouter/vendor/running'
    });
    const done = await store.createTask({
      ...taskInput(user.id, workspace.id),
      modelId: 'openrouter/vendor/finished'
    });
    await store.updateTask({ id: done.id, status: 'completed' });
    expect(live.status).not.toBe('completed');

    // The provider now offers only one of the four.
    const refreshed = await store.replaceModelCatalog([release('openrouter/vendor/survivor')]);
    expect(refreshed).toEqual({ upserted: 1, removed: 1, retired: 2 });
    const after = await store.listModels();
    expect(after.map((model) => [model.id, model.availability])).toEqual([
      ['openrouter/vendor/running', 'unavailable'],
      ['openrouter/vendor/scheduled', 'unavailable'],
      ['openrouter/vendor/survivor', 'available']
    ]);

    // And when the provider brings one back it is live again, not a permanent tombstone.
    await store.replaceModelCatalog([
      release('openrouter/vendor/survivor'),
      release('openrouter/vendor/scheduled')
    ]);
    await expect(
      store
        .listModels()
        .then((models) => models.find((model) => model.id === 'openrouter/vendor/scheduled'))
    ).resolves.toMatchObject({ availability: 'available' });
  });

  it('drops memories whose expiry passed long ago and keeps the rest', async () => {
    const user = await store.createUser({ username: 'memory-keeper', displayName: 'Keeper' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Memory room'));
    const memory = (validUntil?: string): Parameters<DataStore['createWorkspaceMemory']>[0] => ({
      userId: user.id,
      workspaceId: workspace.id,
      target: 'workspace',
      contentCiphertext: { v: 1, iv: 'memory', tag: 'tag', ciphertext: 'cipher' },
      ...(validUntil === undefined ? {} : { validUntil })
    });
    const day = 24 * 60 * 60 * 1000;
    const stale = await store.createWorkspaceMemory(
      memory(new Date(Date.now() - 120 * day).toISOString())
    );
    const recentlyExpired = await store.createWorkspaceMemory(
      memory(new Date(Date.now() - day).toISOString())
    );
    const evergreen = await store.createWorkspaceMemory(memory());
    expect(recentlyExpired.validUntil).not.toBeNull();
    expect(evergreen.validUntil).toBeNull();

    await store.cleanupExpired();

    const remaining = await store.listWorkspaceMemories(user.id, workspace.id);
    expect(remaining.map((record) => record.id).sort()).toEqual(
      [recentlyExpired.id, evergreen.id].sort()
    );
    expect(remaining.map((record) => record.id)).not.toContain(stale.id);
  });

  /**
   * Three tables nothing ever swept. A watcher on a quarter-hour writes a schedule run every
   * fifteen minutes for as long as the box is owned, and the owner is also the operator: nobody
   * else is going to notice the disk.
   */
  it('gives a horizon to the three records that used to be kept forever', async () => {
    const user = await store.createUser({ username: 'housekeeper', displayName: 'Housekeeper' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 15 },
      nextRunAt: new Date(Date.now() - 60_000)
    });
    const connector = await store.createConnector({
      id: '00000000-0000-4000-8000-0000000000c1',
      userId: user.id,
      kind: 'webdav',
      authMode: 'secret',
      label: 'Files',
      baseUrl: 'https://files.example/dav',
      scopes: ['webdav:files.read'],
      secretCiphertext: envelope
    });

    const runs: string[] = [];
    for (const runId of [
      '00000000-0000-4000-8000-0000000000d1',
      '00000000-0000-4000-8000-0000000000d2'
    ]) {
      await store.leaseDueTaskSchedule('scheduler');
      await store.materializeTaskSchedule({
        scheduleId: schedule.id,
        workerId: 'scheduler',
        taskId: runId,
        nextRunAt: new Date(Date.now() - 60_000),
        resourceClass: 'medium',
        preparingEventCiphertext: envelope,
        failureEventCiphertext: envelope
      });
      await store.createAgentNotification({
        userId: user.id,
        taskId: runId,
        kind: 'agent_message',
        messageCiphertext: envelope
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: user.id,
        taskId: runId,
        operation: 'GET /calendar.ics',
        outcome: 'succeeded'
      });
      runs.push(runId);
    }

    const count = async (table: string): Promise<number> =>
      Number((await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]?.count ?? 0);
    const age = async (table: string, column: string, days: number): Promise<unknown> =>
      database.query(
        `UPDATE ${table} SET created_at=NOW() - ($2 * INTERVAL '1 day') WHERE ${column}=$1`,
        [runs[0], days]
      );

    // Each one is aged past its own horizon and no further, so this fails if a horizon moves.
    await age('task_schedule_runs', 'task_id', 31);
    await age('agent_notifications', 'task_id', 91);
    await age('connector_audit_events', 'task_id', 31);

    await store.cleanupExpired();

    for (const table of ['task_schedule_runs', 'agent_notifications', 'connector_audit_events'])
      expect(await count(table), table).toBe(1);
    // The conversation each run produced is not a record of the run and is not swept with it: the
    // sidebar groups these by the schedule the task itself names.
    await expect(store.getTask(user.id, runs[0]!)).resolves.toMatchObject({
      scheduleId: schedule.id
    });
    // And the ledger the owner's money reconciles against is not a retention question at all.
    await expect(count('usage_entries')).resolves.toBe(2);
  });

  it('bounds the backfills the API runs before it serves traffic', async () => {
    const user = await store.createUser({ username: 'backfill', displayName: 'Backfill' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Legacy room'));
    for (const title of ['First', 'Second', 'Third']) {
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await database.query('UPDATE tasks SET title=$2 WHERE id=$1', [task.id, title]);
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'status',
        summary: `plaintext ${title}`
      });
    }

    await expect(store.listLegacyTaskTitles(2)).resolves.toHaveLength(2);
    await expect(store.listLegacyTaskTitles()).resolves.toHaveLength(3);

    // One batch of one row cannot finish three, and the caller is told so rather than the store
    // silently walking the whole table.
    await expect(store.scrubLegacyContentSummaries(1, 1)).resolves.toBe(true);
    const scrubbed = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM task_events WHERE summary NOT LIKE 'Encrypted % event'`
    );
    expect(Number(scrubbed.rows[0]?.count)).toBe(2);
    await expect(store.scrubLegacyContentSummaries()).resolves.toBe(false);
    await expect(
      database.query(`SELECT id FROM task_events WHERE summary NOT LIKE 'Encrypted % event'`)
    ).resolves.toMatchObject({ rows: [] });
  });
  it('redeems a device grant exactly once and honours expiry and revocation', async () => {
    const user = await store.createUser({ username: 'owner-dev', displayName: 'Owner' });

    const granted = await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-1',
      label: 'Phone',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    expect(granted.id).toBeTruthy();

    // First redemption wins.
    await expect(store.consumeDeviceEnrollment('grant-hash-1')).resolves.toEqual({
      userId: user.id
    });
    // A second device scanning the same code must not also get in.
    await expect(store.consumeDeviceEnrollment('grant-hash-1')).resolves.toBeNull();

    // Expiry is enforced independently of consumption.
    await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-2',
      label: 'Laptop',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    await database.query(
      "UPDATE device_enrollments SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash='grant-hash-2'"
    );
    await expect(store.consumeDeviceEnrollment('grant-hash-2')).resolves.toBeNull();

    // Revoking a pending grant makes a photographed code useless.
    const revocable = await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-3',
      label: 'Tablet',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    await expect(store.revokeDeviceEnrollment(user.id, revocable.id)).resolves.toBe(true);
    await expect(store.consumeDeviceEnrollment('grant-hash-3')).resolves.toBeNull();
    // Revoking twice is not an error, but reports that nothing changed.
    await expect(store.revokeDeviceEnrollment(user.id, revocable.id)).resolves.toBe(false);

    // An unknown token never resolves to an account.
    await expect(store.consumeDeviceEnrollment('never-issued')).resolves.toBeNull();

    const listed = await store.listDeviceEnrollments(user.id);
    expect(listed.map((entry) => entry.status).sort()).toEqual(['expired', 'revoked', 'used']);
  });
});

describe('tiered agent memory', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  const key = memoryIndexKey(Buffer.alloc(32, 7));
  const now = new Date('2026-07-31T08:00:00.000Z');
  const at = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  const sealed = (value: string): EncryptedEnvelope => ({
    v: 1,
    iv: 'iv',
    tag: 'tag',
    ciphertext: Buffer.from(value, 'utf8').toString('base64')
  });
  const opened = (envelope: EncryptedEnvelope): string =>
    Buffer.from(envelope.ciphertext, 'base64').toString('utf8');

  const addItem = async (
    kind: MemoryKind,
    content: MemoryItemContent,
    extra: Partial<Parameters<DataStore['createMemoryItem']>[0]> = {}
  ) =>
    store.createMemoryItem({
      userId,
      workspaceId,
      kind,
      trust: 'stated',
      documentCiphertext: sealed(content.body),
      index: buildMemoryItemIndex(content, key),
      observedAt: now,
      validFrom: now,
      ...extra
    });

  const addSource = async (body: string, occurredAt: Date = now, locator?: string) => {
    const index = buildMemorySourceIndex(body, key);
    return store.createMemorySource({
      userId,
      workspaceId,
      channel: 'terminal',
      bodyCiphertext: sealed(body),
      bodyTokens: index.bodyTokens,
      tokensEst: index.tokensEst,
      indexed: index.indexed,
      occurredAt,
      ...(locator
        ? { originCiphertext: sealed(locator), originKey: memoryOriginKey(locator, key) }
        : {})
    });
  };

  const recall = async (query: string, options: Partial<RecallMemoryInput> = {}) =>
    store.recallMemoryCandidates({
      workspaceId,
      plan: planMemoryQuery(query, key),
      now,
      ...options
    });

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'computer'));
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  it('runs the whole lexical floor with no extensions installed', async () => {
    // PGlite ships without pg_trgm, which is exactly the degraded case the design requires to keep
    // working: fuzzy recall and fused ranking must not need it.
    await expect(store.memoryCapabilities()).resolves.toEqual({ trigram: false });

    await addItem(
      'fact',
      {
        title: 'default shell',
        body: 'The owner uses fish on this computer.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', {
      title: 'Rotated the certificate',
      body: 'Renewed the TLS certificate and reloaded nginx.'
    });

    const hits = await recall('which shell does the owner use');
    expect(hits.map((hit) => opened(hit.documentCiphertext))).toEqual([
      'The owner uses fish on this computer.'
    ]);
  });

  it('fuses lexical, fuzzy, structural and verbatim channels into one ranked result', async () => {
    await addItem(
      'fact',
      {
        title: 'preview port',
        body: 'The preview gateway listens on 8443.',
        subject: 'preview gateway',
        object: '8443'
      },
      { predicate: 'runs_on' }
    );
    await addItem('episode', {
      title: 'Restarted athanor',
      body: 'Ran systemctl restart athanor.target after the deploy.'
    });
    await addItem('procedure', {
      title: 'Deploy athanor',
      tags: ['deploy', 'athanor'],
      body: 'pnpm build then systemctl restart athanor.target'
    });
    await addSource('$ systemctl restart athanor.target\nJob for athanor.target succeeded.');
    await addItem('episode', { title: 'Wrote the brief', body: 'Edited PREFERENCES.md by hand.' });

    const hits = await recall('restart athanor.target after a deploy');
    const bodies = hits.map((hit) => opened(hit.documentCiphertext));
    expect(hits.map((hit) => hit.layer)).toContain('source');
    expect(bodies).toContain('pnpm build then systemctl restart athanor.target');
    expect(bodies).toContain('Ran systemctl restart athanor.target after the deploy.');
    // The unrelated episode never entered the candidate set at all.
    expect(bodies).not.toContain('Edited PREFERENCES.md by hand.');
    // Ordering is deterministic (kind, id), never by score - that is what the cached prefix needs.
    const rank = (hit: (typeof hits)[number]) => `${MEMORY_KINDS.indexOf(hit.kind)}:${hit.id}`;
    expect(hits.map(rank)).toEqual([...hits.map(rank)].sort());
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it('prefers a stated recent fact over an old derived one carrying the same words', async () => {
    const fresh = await addItem(
      'fact',
      {
        title: 'backup target',
        body: 'Backups go to the encrypted volume.',
        subject: 'backups',
        object: 'encrypted volume'
      },
      { trust: 'stated', predicate: 'located_at', observedAt: at(2), validFrom: at(2) }
    );
    const stale = await addItem(
      'fact',
      {
        title: 'backup target',
        body: 'Backups go to the encrypted disk instead.',
        subject: 'backups',
        object: 'encrypted disk'
      },
      { trust: 'derived', predicate: 'located_at', observedAt: at(900), validFrom: at(900) }
    );

    const hits = await recall('where do the backups go');
    const scores = new Map(hits.map((hit) => [hit.id, hit.score]));
    expect(scores.get(fresh.id)!).toBeGreaterThan(scores.get(stale.id)!);
  });

  it('supersedes a functional fact instead of deleting it and keeps it reachable as of a date', async () => {
    const first = await store.recordMemoryFact({
      userId,
      workspaceId,
      trust: 'stated',
      predicate: 'default_shell',
      documentCiphertext: sealed('owner default_shell fish'),
      index: buildMemoryItemIndex(
        { title: 'default shell', body: 'The owner uses fish.', subject: 'owner', object: 'fish' },
        key
      ),
      observedAt: at(30),
      validFrom: at(30)
    });
    expect(first.supersededIds).toEqual([]);

    const second = await store.recordMemoryFact({
      userId,
      workspaceId,
      trust: 'stated',
      predicate: 'default_shell',
      documentCiphertext: sealed('owner default_shell zsh'),
      index: buildMemoryItemIndex(
        {
          title: 'default shell',
          body: 'The owner uses zsh now.',
          subject: 'owner',
          object: 'zsh'
        },
        key
      ),
      observedAt: at(1),
      validFrom: at(1)
    });
    expect(second.supersededIds).toEqual([first.item.id]);

    // Retired, not removed: status, valid_to and a supersedes link all record what happened.
    const retired = await store.getMemoryItem(workspaceId, first.item.id);
    expect(retired?.status).toBe('superseded');
    expect(retired?.validTo).toBe(at(1).toISOString());
    expect(retired?.retiredAt).not.toBeNull();
    await expect(store.listMemoryLinks(second.item.id)).resolves.toEqual([
      expect.objectContaining({ srcId: second.item.id, dstId: first.item.id, rel: 'supersedes' })
    ]);

    // A present-tense question gets the current value only.
    const present = await recall('which shell does the owner use');
    expect(present.map((hit) => hit.id)).toEqual([second.item.id]);

    // "What did I use before?" reaches the retired one, and as_of answers it exactly.
    const past = await recall('which shell did the owner use previously', {
      includeSuperseded: true
    });
    expect(past.map((hit) => hit.id).sort()).toEqual([first.item.id, second.item.id].sort());
    const asOf = await recall('which shell does the owner use', {
      asOf: at(10),
      includeSuperseded: true
    });
    expect(asOf.map((hit) => hit.id)).toEqual([first.item.id]);
  });

  it('refuses a predicate that is not in the vetted in-repo registry', async () => {
    await expect(
      store.recordMemoryFact({
        userId,
        workspaceId,
        trust: 'stated',
        predicate: 'favourite_colour',
        documentCiphertext: sealed('x'),
        index: buildMemoryItemIndex({ body: 'x', subject: 'owner', object: 'blue' }, key)
      })
    ).rejects.toThrow('favourite_colour');
    await expect(store.syncMemoryPredicates()).resolves.toBe(MEMORY_PREDICATES.length);
  });

  it('marks two conflicting owner statements disputed rather than picking a winner', async () => {
    const left = await addItem(
      'fact',
      {
        title: 'deploy host',
        body: 'Deploys go to alpha.',
        subject: 'deploys',
        object: 'alpha'
      },
      { predicate: 'located_at' }
    );
    const right = await addItem(
      'fact',
      {
        title: 'deploy host',
        body: 'Deploys go to beta.',
        subject: 'deploys',
        object: 'beta'
      },
      { predicate: 'located_at' }
    );
    await expect(store.markMemoryFactsDisputed(workspaceId, [left.id, right.id])).resolves.toBe(2);

    // Neither is retrieved by default; both are still there for the review queue.
    await expect(recall('where do deploys go')).resolves.toEqual([]);
    const disputed = await recall('where do deploys go', { includeSuperseded: true });
    expect(disputed.map((hit) => hit.status)).toEqual(['disputed', 'disputed']);
    await expect(store.listMemoryLinks(left.id)).resolves.toEqual([
      expect.objectContaining({ rel: 'contradicts' })
    ]);
  });

  it('holds a repeated observation back until two episodes a day apart have seen it', async () => {
    const episodeOne = await addItem('episode', { body: 'Noticed the agent using ripgrep.' });
    const episodeTwo = await addItem('episode', { body: 'Noticed ripgrep again.' });
    const observation = {
      workspaceId,
      subjectKey: 'subject-owner',
      predicate: 'prefers',
      objectKey: 'object-ripgrep'
    };

    const first = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3)
    });
    expect(first.episodeCount).toBe(1);

    // The same episode saying it twice is one observation, not two.
    const repeat = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3)
    });
    expect(repeat.episodeCount).toBe(1);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);

    const second = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeTwo.id,
      observedAt: at(1)
    });
    expect(second.episodeCount).toBe(2);
    expect(second.episodeIds).toEqual([episodeOne.id, episodeTwo.id]);
    const promotable = await store.listPromotableMemoryFactCandidates(workspaceId);
    expect(promotable.map((candidate) => candidate.objectKey)).toEqual(['object-ripgrep']);

    // Two sightings inside the same day are still one observation as far as promotion goes.
    await expect(
      store.listPromotableMemoryFactCandidates(workspaceId, { minGapHours: 72 })
    ).resolves.toEqual([]);
    await expect(
      store.deleteMemoryFactCandidate(workspaceId, 'subject-owner', 'prefers', 'object-ripgrep')
    ).resolves.toBe(true);
  });

  it('promotes an observation that cleared the gate and never promotes it twice', async () => {
    const episodeOne = await addItem('episode', { body: 'Noticed the agent using ripgrep.' });
    const episodeTwo = await addItem('episode', { body: 'Noticed ripgrep again.' });
    const content = {
      title: 'preferred search tool',
      body: 'The owner prefers ripgrep.',
      subject: 'owner',
      object: 'ripgrep'
    };
    const index = buildMemoryItemIndex(content, key);
    const observation = {
      workspaceId,
      subjectKey: index.subjectKey!,
      predicate: 'prefers',
      objectKey: index.objectKey!
    };
    await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3),
      draftCiphertext: sealed('owner prefers ripgrep')
    });
    await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeTwo.id,
      observedAt: at(1)
    });

    // A caller that cannot open the draft leaves the candidate exactly where it was.
    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toHaveLength(1);

    // What gets minted has to be what was observed twice, not something else.
    await expect(
      store.promoteMemoryFactCandidates(workspaceId, () => ({
        userId,
        documentCiphertext: sealed(content.body),
        index: buildMemoryItemIndex({ ...content, subject: 'somebody else' }, key)
      }))
    ).rejects.toThrow(/subject and object/);

    const promoted = await store.promoteMemoryFactCandidates(workspaceId, (candidate) => {
      expect(opened(candidate.draftCiphertext!)).toBe('owner prefers ripgrep');
      return { userId, documentCiphertext: sealed(content.body), index };
    });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.item).toMatchObject({ kind: 'fact', trust: 'derived', status: 'active' });

    // The candidate is consumed, so the same observation cannot be minted a second time...
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);

    // ...and the episodes that vouched for it are cited, which is also what exempts them from
    // the archive sweep that would otherwise take the evidence away from a live fact.
    const links = await store.listMemoryLinks(promoted[0]!.item.id);
    expect(links.map((link) => link.rel)).toEqual(['derived_from', 'derived_from']);
    expect(links.map((link) => link.dstId).sort()).toEqual([episodeOne.id, episodeTwo.id].sort());

    const hits = await recall('what does the owner prefer');
    expect(hits.map((hit) => opened(hit.documentCiphertext))).toContain(
      'The owner prefers ripgrep.'
    );
  });

  it('drops a candidate whose predicate has left the vetted registry', async () => {
    const episode = await addItem('episode', { body: 'Noticed something.' });
    await database.query(
      `INSERT INTO mem.fact_candidate(
         workspace_id,subject_key,predicate,object_key,n_episodes,first_seen,last_seen,episode_ids)
       VALUES ($1,'subject-owner','retired_predicate','object-thing',2,$2,$3,ARRAY[$4::uuid])`,
      [workspaceId, at(3), at(1), episode.id]
    );

    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);
    // It can never become a fact, so it is not held for a review that will never come.
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
  });

  it('rebuilds drifted corpus statistics on its own cadence, not on every pass', async () => {
    await addItem('episode', { body: 'The owner uses fish and fish and fish.' });
    await addItem('episode', { body: 'The owner uses fish for scripting.' });

    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: false
    });

    // The AFTER INSERT trigger only ever adds, so document frequency drifts high over time and
    // the full rebuild is the only thing that corrects it.
    await database.query(
      'UPDATE mem.corpus_stats SET n_docs=999, refreshed_at=$2 WHERE workspace_id=$1',
      [workspaceId, at(45)]
    );
    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: true
    });
    const stats = await database.query<{ n_docs: string }>(
      'SELECT n_docs FROM mem.corpus_stats WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(stats.rows[0]?.n_docs)).toBe(2);

    // Having just been rebuilt, the next nightly pass leaves it alone.
    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: false
    });
  });

  it('scores a bounded slice of the corpus in the fuzzy channel however large it grows', async () => {
    // Every stored row shares every query trigram, which is the shape the GIN overlap probe is
    // useless against and the reason the channel needs a cap of its own.
    const grams = Array.from({ length: 40 }, (_, index) => `trg${String(index).padStart(4, '0')}`);
    const grow = async (rows: number, tag: string): Promise<void> => {
      await database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,trust,document_ciphertext,title_tokens,
                              tag_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,observed_at,
                              valid_from,tokens_est,indexed)
         SELECT gen_random_uuid(), $1, $2, 'episode', 'stated',
                '{"v":1,"iv":"i","tag":"t","ciphertext":"YQ=="}'::jsonb, '', '', '', '{}',
                $4::text[], $5 || '-' || g, NOW(), NOW(), 10, TRUE
         FROM generate_series(1, $3::int) g`,
        [userId, workspaceId, rows, grams, tag]
      );
      await database.exec('ANALYZE mem.item');
    };

    const plan = { ...planMemoryQuery('irrelevant', key), lexemes: [], trigrams: grams };
    /** Runs the real recall statement and returns EXPLAIN ANALYZE for it, params and all. */
    const explainRecall = async (): Promise<string> => {
      let captured: { sql: string; params: unknown[] } | null = null;
      const probe: Database = {
        query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          if (sql.includes('trg_cand')) captured = { sql, params };
          return database.query<T>(sql, params);
        },
        exec: (sql: string) => database.exec(sql),
        transaction: (callback) => database.transaction(callback),
        withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
          database.withAdvisoryLock(lock, callback),
        notify: (channel, payload) => database.notify(channel, payload),
        listen: (channel, handler) => database.listen(channel, handler),
        close: async () => undefined
      };
      await new DataStore(probe).recallMemoryCandidates({ workspaceId, plan, now });
      const explained = await database.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${captured!.sql}`,
        captured!.params
      );
      return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    const scored = (plan: string): number =>
      Number(/on unnest g \(actual[^)]*loops=(\d+)\)/.exec(plan)?.[1] ?? -1);
    const overlapping = async (): Promise<number> => {
      const rows = await database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM mem.item WHERE workspace_id=$1 AND trigrams && $2::text[]',
        [workspaceId, grams]
      );
      return Number(rows.rows[0]!.count);
    };

    await grow(800, 'small');
    expect(await overlapping()).toBe(800);
    const small = scored(await explainRecall());

    await grow(2400, 'large');
    expect(await overlapping()).toBe(3200);
    const large = scored(await explainRecall());

    // Four times the corpus, the same amount of exact-similarity work.
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(600);
  }, 120_000);

  it('still returns a kind the quota table has never heard of', async () => {
    // The recall query used to inner-join the quota table by kind, so a row whose kind had no quota
    // entry was scored, ranked and then dropped with no error and no log line. 'entity' is the
    // specimen because it is real at the database level and unknown to everything above it: it was
    // a declared kind that nothing ever wrote, and removing it from TypeScript left the enum value
    // behind, which is the exact shape of the row this join must not discard.
    await addItem('entity' as MemoryKind, {
      title: 'athanor-relay',
      body: 'The SNI relay that fronts every published service on this computer.'
    });
    const hits = await recall('what is the relay');
    expect(hits.map((hit) => hit.kind)).toContain('entity');
  });

  it('cuts to maxItems by fused score, not alphabetically by row id', async () => {
    await addItem('episode', {
      title: 'Restarted athanor.target',
      body: 'Ran systemctl restart athanor.target after the deploy and watched journalctl for it.'
    });
    await addItem('episode', { body: 'Mentioned athanor.target once while writing the brief.' });
    await addItem('episode', { body: 'A note that only mentions the deploy in passing.' });

    const all = await recall('systemctl restart athanor.target after a deploy');
    expect(all.length).toBeGreaterThan(1);
    const best = [...all].sort((left, right) => right.score - left.score)[0]!;
    // The item cap used to be a trailing LIMIT after the (kind, id) sort, so what it discarded was
    // the alphabetically last row rather than the least relevant one.
    const capped = await recall('systemctl restart athanor.target after a deploy', { maxItems: 1 });
    expect(capped.map((hit) => hit.id)).toEqual([best.id]);
  });

  it('returns an interactive recall in relevance order and dereferences only real ids', async () => {
    await addItem('episode', {
      title: 'Rotated the certificate',
      body: 'Renewed the TLS certificate with acme.sh and reloaded nginx afterwards.'
    });
    await addItem('episode', { body: 'The nginx access log filled the disk once.' });

    const question = 'renewed the TLS certificate and reloaded nginx';
    const ranked = await recall(question, { order: 'relevance' });
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked.map((hit) => hit.score)).toEqual(
      [...ranked.map((hit) => hit.score)].sort((left, right) => right - left)
    );
    // Same rows either way: only the order the caller reads them in changes.
    const stable = await recall(question);
    expect(stable.map((hit) => hit.id).sort()).toEqual(ranked.map((hit) => hit.id).sort());

    const itemHit = ranked.find((hit) => hit.layer === 'item')!;
    const fetched = await store.getMemoryItems(workspaceId, [itemHit.id, 'not-a-uuid', '']);
    expect(fetched.map((item) => item.id)).toEqual([itemHit.id]);
    // An id the model quoted back imprecisely must be an empty result, never a failed turn.
    await expect(store.getMemoryItems(workspaceId, ['mem.item#3'])).resolves.toEqual([]);
  });

  it('stops injecting a procedure that keeps failing without ever deleting it', async () => {
    const procedure = await addItem('procedure', {
      title: 'Rebuild the search index',
      tags: ['search'],
      body: 'Run the reindex script against the search index.'
    });
    await expect(recall('rebuild the search index')).resolves.toHaveLength(1);

    for (const outcome of ['fail', 'fail', 'ok'] as const)
      await store.recordMemoryUse({ workspaceId, itemIds: [procedure.id], outcome });

    await expect(recall('rebuild the search index')).resolves.toEqual([]);
    await expect(store.listStaleMemoryProcedures(workspaceId, { now })).resolves.toMatchObject([
      { id: procedure.id, status: 'active' }
    ]);

    // It comes back the moment it succeeds again - nothing was thrown away.
    for (const outcome of ['ok', 'ok', 'ok', 'ok'] as const)
      await store.recordMemoryUse({ workspaceId, itemIds: [procedure.id], outcome });
    await expect(recall('rebuild the search index')).resolves.toHaveLength(1);
  });

  it('drops a procedure that has not been verified inside the staleness window', async () => {
    await addItem(
      'procedure',
      { title: 'Rotate the keys', tags: ['keys'], body: 'Rotate the signing keys yearly.' },
      { observedAt: at(400), validFrom: at(400), lastVerified: at(400) }
    );
    await expect(recall('rotate the signing keys')).resolves.toEqual([]);
    await expect(
      recall('rotate the signing keys', { procedureStaleDays: 500 })
    ).resolves.toHaveLength(1);
  });

  it('packs to a fixed budget with per-kind quotas instead of taking the top scores', async () => {
    const body = (label: string) => `Encrypted archive rotation note ${label}`;
    for (let index = 0; index < 12; index += 1)
      await addItem(
        'fact',
        {
          title: `archive ${index}`,
          body: body(`fact-${index}`),
          subject: `archive-${index}`,
          object: `value-${index}`
        },
        { predicate: 'located_at' }
      );
    for (let index = 0; index < 12; index += 1)
      await addItem('episode', { title: `rotation ${index}`, body: body(`episode-${index}`) });

    const generous = await recall('encrypted archive rotation', { budgetTokens: 6_000 });
    expect(generous.length).toBeGreaterThan(8);
    expect(new Set(generous.map((hit) => hit.kind))).toEqual(new Set(['fact', 'episode']));
    // Episodes are capped at eight even when they would otherwise sweep the ranking.
    expect(generous.filter((hit) => hit.kind === 'episode')).toHaveLength(8);

    const tight = await recall('encrypted archive rotation', { budgetTokens: 40 });
    expect(tight.length).toBeLessThan(generous.length);
    expect(tight.reduce((total, hit) => total + hit.tokensEst, 0)).toBeLessThanOrEqual(40);
  });

  it('caps how much of the fact slot a single loud subject can take', async () => {
    for (let index = 0; index < 8; index += 1)
      await addItem(
        'fact',
        {
          title: `nginx note ${index}`,
          body: `The nginx config sets header number ${index}.`,
          subject: 'nginx',
          object: `header-${index}`
        },
        { predicate: 'related_to' }
      );
    const hits = await recall('nginx config header');
    expect(hits).toHaveLength(4);
  });

  it('returns the same order twice, which is what keeps the cached prefix alive', async () => {
    await addItem(
      'fact',
      {
        title: 'shell',
        body: 'The owner uses fish.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', { title: 'shell change', body: 'Switched the login shell to fish.' });
    await addSource('$ chsh -s /usr/bin/fish');

    const first = await recall('which shell does the owner use');
    const second = await recall('which shell does the owner use');
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));

    const pack = renderMemoryPack(
      first.map((hit) => ({
        id: hit.id,
        kind: hit.kind,
        trust: hit.trust,
        observedAt: hit.observedAt,
        validFrom: hit.validFrom,
        validTo: hit.validTo,
        title: null,
        tags: [],
        body: opened(hit.documentCiphertext)
      }))
    );
    const stored = await store.saveMemoryPack({
      taskId: (await store.createTask(taskInput(userId, workspaceId))).id,
      workspaceId,
      bodyCiphertext: sealed(pack.body),
      sha256: pack.sha256,
      itemIds: pack.itemIds,
      tokensEst: pack.tokensEst
    });

    // A worker that restarts mid-task must re-read the bytes it already emitted, not re-rank.
    const rewritten = await store.saveMemoryPack({
      taskId: stored.taskId,
      workspaceId,
      bodyCiphertext: sealed('a different pack'),
      sha256: 'different',
      itemIds: [],
      tokensEst: 0
    });
    expect(rewritten.sha256).toBe(pack.sha256);
    await expect(store.getMemoryPack(stored.taskId)).resolves.toMatchObject({
      sha256: pack.sha256,
      itemIds: pack.itemIds
    });
  });

  it('records provenance from a curated item back to the verbatim rows behind it', async () => {
    const source = await addSource('owner: I always deploy with pnpm, never npm.');
    const fact = await addItem(
      'fact',
      {
        title: 'deploy tool',
        body: 'The owner deploys with pnpm.',
        subject: 'owner',
        object: 'pnpm'
      },
      { predicate: 'uses_tool' }
    );
    await expect(
      store.attachMemoryEvidence(fact.id, [{ sourceId: source.id, span: [7, 40] }])
    ).resolves.toBe(1);
    await expect(store.listMemoryEvidence(fact.id)).resolves.toEqual([
      { sourceId: source.id, span: '[7,40)', occurredAt: now.toISOString() }
    ]);
  });

  it('consolidates by demoting and trimming, never by dropping cited verbatim text', async () => {
    const cited = await addSource('$ nginx -t\nconfiguration file test is successful', at(900));
    const uncited = await addSource('$ ls /tmp\nnothing interesting here', at(900));
    const recent = await addSource('$ uptime\nup 3 days', at(1));
    const fact = await addItem(
      'fact',
      {
        title: 'nginx config',
        body: 'The nginx config passes its own test.',
        subject: 'nginx',
        object: 'valid'
      },
      { predicate: 'related_to', observedAt: at(900), validFrom: at(900) }
    );
    await store.attachMemoryEvidence(fact.id, [{ sourceId: cited.id }]);
    const pinned = await addItem(
      'fact',
      { title: 'owner name', body: 'The owner is Ada.', subject: 'owner', object: 'ada' },
      { predicate: 'related_to', observedAt: at(900), validFrom: at(900), pin: true }
    );
    await store.recordMemoryUse({ workspaceId, itemIds: [fact.id], cited: true, outcome: 'ok' });

    const report = await store.consolidateMemory(workspaceId, { now });
    expect(report.itemsArchived).toBeGreaterThan(0);
    expect(report.sourcesUnindexed).toBe(1);

    const indexedNow = await database.query<{ id: string; indexed: boolean }>(
      'SELECT id, indexed FROM mem.source ORDER BY occurred_at'
    );
    const indexState = new Map(indexedNow.rows.map((row) => [row.id, row.indexed]));
    // Verbatim text is never deleted; only the uncited old row leaves the lexical index.
    expect(indexState.size).toBe(3);
    expect(indexState.get(cited.id)).toBe(true);
    expect(indexState.get(uncited.id)).toBe(false);
    expect(indexState.get(recent.id)).toBe(true);

    // A pinned fact is exempt, and salience reflects use rather than a stored decayed score.
    await expect(store.getMemoryItem(workspaceId, pinned.id)).resolves.toMatchObject({
      status: 'active'
    });
    const scored = await store.getMemoryItem(workspaceId, fact.id);
    expect(scored!.salience).toBeGreaterThan(0);
    expect(scored!.useCount).toBe(1);
    expect(scored!.citedCount).toBe(1);
  });

  it('seals provenance and still reaches a compacted source by where it came from', async () => {
    const locator = '/srv/athanor/deploy.log';
    const source = await addSource('deploy finished in 41s', at(900), locator);
    await addSource('unrelated output', at(900), '/tmp/other.log');

    // Compaction takes the row out of the lexical index without deleting a byte of it.
    await store.consolidateMemory(workspaceId, { now });
    const compacted = await store.listMemorySourcesByOrigin(
      workspaceId,
      memoryOriginKey(locator, key)
    );
    expect(compacted).toHaveLength(1);
    expect(compacted[0]!.id).toBe(source.id);
    expect(compacted[0]!.indexed).toBe(false);
    expect(opened(compacted[0]!.bodyCiphertext)).toBe('deploy finished in 41s');
    expect(opened(compacted[0]!.originCiphertext!)).toBe(locator);

    // The path itself is never written in the clear, only its keyed handle.
    const stored = await database.query<{ origin_ciphertext: unknown; origin_key: string }>(
      'SELECT origin_ciphertext, origin_key FROM mem.source WHERE id=$1',
      [source.id]
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain('srv');
    expect(stored.rows[0]?.origin_key).toBe(memoryOriginKey(locator, key));
  });

  it('rebuilds corpus statistics from the stored index without touching plaintext', async () => {
    await addItem(
      'fact',
      {
        title: 'shell',
        body: 'The owner uses fish and fish and fish.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', { body: 'The owner uses fish for scripting.' });
    await store.rebuildMemoryCorpusStats(workspaceId);

    const stats = await database.query<{ n_docs: string; sum_len: string }>(
      'SELECT n_docs, sum_len FROM mem.corpus_stats WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(stats.rows[0]?.n_docs)).toBe(2);
    expect(Number(stats.rows[0]?.sum_len)).toBeGreaterThan(0);

    // Every lexeme is kept, including the ones that occur once. A term in exactly one document is
    // the most discriminative term there is; a term in none cannot match at all. Dropping the df=1
    // rows made those two cases indistinguishable, and the query planner has to tell them apart to
    // choose which of a long request's terms to search on.
    const df = await database.query<{ lexeme: string; df: string }>(
      'SELECT lexeme, df FROM mem.lexeme_df WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(df.rows.length).toBeGreaterThan(0);
    expect(df.rows.some((row) => Number(row.df) === 1)).toBe(true);
    expect(df.rows.some((row) => Number(row.df) > 1)).toBe(true);
    // The statistics table holds keyed tokens, never words.
    expect(df.rows.every((row) => /^[a-p]{16}$/.test(row.lexeme))).toBe(true);
  });

  it('returns what the caller does not already hold, not a second copy of it', async () => {
    // The whole point of a mid-task recall: the pack is frozen and already in the prompt, so the
    // rows it printed are the one set the agent gains nothing by being sent again.
    const held = await addItem(
      'fact',
      {
        title: 'relay listen address',
        body: 'athanor-relay binds 0.0.0.0:8443.',
        subject: 'athanor-relay',
        object: '0.0.0.0:8443'
      },
      { predicate: 'runs_on' }
    );
    const other = await addItem('episode', {
      title: 'relay would not start',
      body: 'athanor-relay was not enabled at boot, so a reboot left it stopped.'
    });

    const everything = await recall('what do we know about athanor-relay');
    expect(everything.map((row) => row.id).sort()).toEqual([held.id, other.id].sort());

    const remaining = await recall('what do we know about athanor-relay', {
      excludeIds: [held.id]
    });
    expect(remaining.map((row) => row.id)).toEqual([other.id]);

    // A pack id the model quoted back imprecisely must narrow nothing rather than fail the turn.
    const garbled = await recall('what do we know about athanor-relay', {
      excludeIds: ['not-a-uuid']
    });
    expect(garbled.map((row) => row.id).sort()).toEqual([held.id, other.id].sort());
  });

  it('excludes a verbatim row by id as well as a curated one', async () => {
    const source = await addSource('athanor-relay is listening on 0.0.0.0:8443 again.');
    expect((await recall('is athanor-relay listening')).map((row) => row.id)).toContain(source.id);
    expect(
      (await recall('is athanor-relay listening', { excludeIds: [source.id] })).map((row) => row.id)
    ).not.toContain(source.id);
  });

  it('spreads a verbatim search across conversations instead of returning one thread', async () => {
    // Turns inside one thread share its vocabulary, so raw BM25 over a transcript returns the same
    // conversation several times over and the other threads that also answer never appear.
    // Real task rows: mem.source.task_id is a foreign key, so deleting a conversation deletes the
    // verbatim turns it produced. Invented ids can no longer stand in for one.
    const conversations: string[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const conversation = await store.createTask({
        userId,
        workspaceId,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        titleCiphertext: sealed(`thread ${suffix}`),
        nameIndex: UNINDEXED_NAME,
        promptCiphertext: sealed(`thread ${suffix}`)
      });
      conversations.push(conversation.id);
    }
    let minute = 0;
    for (const taskId of conversations)
      for (const line of [
        'the certificate renewal failed validation again last night',
        'acme.sh asked for validation before the record had propagated',
        'the renewal went through after a wait was added before validation',
        'validation succeeded on the retry'
      ]) {
        const index = buildMemorySourceIndex(line, key);
        minute += 1;
        await store.createMemorySource({
          userId,
          workspaceId,
          channel: 'chat',
          taskId,
          bodyCiphertext: sealed(line),
          bodyTokens: index.bodyTokens,
          tokensEst: index.tokensEst,
          indexed: index.indexed,
          occurredAt: new Date(now.getTime() - minute * 60_000)
        });
      }
    await store.rebuildMemoryCorpusStats(workspaceId);

    const spread = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('why did the certificate renewal fail validation', key),
      limit: 6
    });
    expect(spread).toHaveLength(6);
    expect(new Set(spread.map((hit) => hit.taskId)).size).toBe(conversations.length);
    for (const taskId of conversations)
      expect(spread.filter((hit) => hit.taskId === taskId).length).toBeLessThanOrEqual(
        MEMORY_SOURCE_SEARCH_PER_TASK
      );
    // Score order still decides; the cap only ever moves a row down.
    expect(spread.map((hit) => hit.score)).toEqual(
      [...spread.map((hit) => hit.score)].sort((left, right) => right - left)
    );

    // Inside one conversation there is no second thread to make room for, so the cap lifts.
    const inside = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('why did the certificate renewal fail validation', key),
      taskId: conversations[0]!,
      limit: 6
    });
    expect(inside.length).toBeGreaterThan(MEMORY_SOURCE_SEARCH_PER_TASK);
    expect(inside.every((hit) => hit.taskId === conversations[0])).toBe(true);
  });

  it('reports how far back the verbatim layer reaches, so an empty search can be honest', async () => {
    await expect(store.memorySourceCoverage(workspaceId)).resolves.toEqual({
      turns: 0,
      conversations: 0,
      earliest: null
    });

    // A real task row, because mem.source.task_id now cascades from it.
    const conversation = await store.createTask({
      userId,
      workspaceId,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      titleCiphertext: sealed('reach'),
      nameIndex: UNINDEXED_NAME,
      promptCiphertext: sealed('reach')
    });
    const taskId = conversation.id;
    for (const [line, days] of [
      ['the relay stopped after the reboot', 40],
      ['I enabled it at boot', 40]
    ] as const) {
      const index = buildMemorySourceIndex(line, key);
      await store.createMemorySource({
        userId,
        workspaceId,
        channel: 'chat',
        taskId,
        bodyCiphertext: sealed(line),
        bodyTokens: index.bodyTokens,
        tokensEst: index.tokensEst,
        indexed: index.indexed,
        occurredAt: at(days)
      });
    }
    await expect(store.memorySourceCoverage(workspaceId)).resolves.toEqual({
      turns: 2,
      conversations: 1,
      earliest: at(40).toISOString()
    });
  });

  it('carries no embedding surface, because nothing ever wrote one', async () => {
    // Migration 35 created halfvec columns, two HNSW indexes and an embed_state enum for a queue
    // that was never built; migration 54 removes them. A dead index is worse than no index - it
    // reads as a component the retrieval path depends on, and no query has ever had a branch for
    // it. This asserts the removal actually ran rather than being described in a comment.
    const columns = await database.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='mem' AND column_name IN ('embedding','embed_state')`
    );
    expect(columns.rows).toEqual([]);
    const type = await database.query<{ typname: string }>(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname='mem' AND t.typname='embed_state'`
    );
    expect(type.rows).toEqual([]);
  });
});

describe('spending caps in real currency', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  const envelope: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
  const now = new Date('2026-07-15T12:00:00.000Z');
  const bounds = spendWindowBounds('UTC', now);

  /** One settled model call, backdated so the window arithmetic can be asserted exactly. */
  const bill = async (input: {
    key: string;
    costUsd: number;
    taskId?: string;
    at?: Date;
    modelRef?: string;
  }) => {
    await store.recordUsage({
      userId,
      workspaceId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1_000,
      unit: 'tokens',
      credits: 0.25,
      state: 'settled',
      idempotencyKey: input.key,
      providerRef: input.modelRef ?? 'openrouter:z-ai/glm-5.2',
      costUsd: input.costUsd
    });
    await database.query('UPDATE usage_entries SET created_at=$2 WHERE idempotency_key=$1', [
      input.key,
      (input.at ?? now).toISOString()
    ]);
  };

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'payer', displayName: 'Payer' });
    userId = user.id;
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Spending'));
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  it('aggregates what the provider actually billed per task, per day and per month', async () => {
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 5 });
    const other = await store.createTask(taskInput(userId, workspaceId));
    await bill({ key: 'call-1', costUsd: 0.5, taskId: task.id });
    await bill({ key: 'call-2', costUsd: 0.25, taskId: task.id });
    await bill({
      key: 'call-3',
      costUsd: 2,
      taskId: other.id,
      modelRef: 'openrouter:anthropic/claude'
    });
    // Earlier in the same month but a different day, so it counts monthly and not daily.
    await bill({
      key: 'call-4',
      costUsd: 4,
      taskId: other.id,
      at: new Date('2026-07-02T09:00:00Z')
    });
    // Last month, so it counts in neither window.
    await bill({ key: 'call-5', costUsd: 90, at: new Date('2026-06-30T09:00:00Z') });

    await expect(store.taskSpend(task.id)).resolves.toBeCloseTo(0.75, 6);
    await expect(
      store.spendTotal(userId, bounds.daily.start, bounds.daily.end)
    ).resolves.toBeCloseTo(2.75, 6);
    await expect(
      store.spendTotal(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toBeCloseTo(6.75, 6);

    await expect(
      store.spendByModel(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toEqual([
      { key: 'z-ai/glm-5.2', costUsd: 4.75, calls: 3 },
      { key: 'anthropic/claude', costUsd: 2, calls: 1 }
    ]);
    await expect(
      store.spendByTask(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toEqual([
      { key: other.id, costUsd: 6, calls: 2 },
      { key: task.id, costUsd: 0.75, calls: 2 }
    ]);
    await expect(
      store.spendByDay(userId, bounds.monthly.start, bounds.monthly.end, 'UTC')
    ).resolves.toEqual([
      { key: '2026-07-02', costUsd: 4, calls: 1 },
      { key: '2026-07-15', costUsd: 2.75, calls: 3 }
    ]);
  });

  it('refuses to start work that would take the day past its cap, and warns before that', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5, warnAtPercent: 60 });
    await bill({ key: 'spent-today', costUsd: 2 });

    await expect(store.spendGuard({ userId, estimateUsd: 0.5, now })).resolves.toMatchObject({
      outcome: 'allow'
    });
    const warned = await store.spendGuard({ userId, estimateUsd: 1, now });
    expect(warned).toMatchObject({ outcome: 'warn', warnedBy: ['daily'], blockedBy: null });
    const denied = await store.spendGuard({ userId, estimateUsd: 4, now });
    expect(denied).toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    expect(denied.windows.find((window) => window.name === 'daily')).toMatchObject({
      spentUsd: 2,
      capUsd: 5,
      warnAtUsd: 3,
      projectedUsd: 6
    });
  });

  it('stops a task at its own ceiling even when the account caps are unset', async () => {
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 2 });
    await bill({ key: 'task-spend', costUsd: 1.95, taskId: task.id });
    // Close to the ceiling is a warning, not a refusal: the work still runs.
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 0.02, now })
    ).resolves.toMatchObject({ outcome: 'warn', blockedBy: null });
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 0.5, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'task' });
  });

  it('counts the unspent headroom of open work against something else starting', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5 });
    const running = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 4 });
    await bill({ key: 'partial', costUsd: 1, taskId: running.id });

    // $4 promised minus $1 already billed leaves $3 that this task may still spend.
    await expect(store.openSpendCommitment(userId)).resolves.toBeCloseTo(3, 6);
    await expect(
      store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'daily' });

    // The running task must not be blocked by its own reservation.
    await expect(
      store.spendGuard({
        userId,
        taskId: running.id,
        estimateUsd: 2,
        includeOpenCommitments: true,
        now
      })
    ).resolves.toMatchObject({ outcome: 'allow' });

    // A finished task releases what it never spent.
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [running.id]);
    await expect(store.openSpendCommitment(userId)).resolves.toBe(0);
    await expect(
      store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
    ).resolves.toMatchObject({ outcome: 'allow' });
  });

  /**
   * A conversation the owner left open overnight has no worker and will spend nothing until they
   * come back to it, at which point the ceiling is priced again. Holding its whole ceiling against
   * the day would have them sitting down to a limit reached by work that never ran.
   */
  it('reserves only what a worker is about to spend, not what a parked conversation might', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5 });
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 4 });
    await bill({ key: 'partial', costUsd: 1, taskId: task.id });

    for (const status of ['awaiting_user', 'awaiting_resource', 'paused']) {
      await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [task.id, status]);
      await expect(store.openSpendCommitment(userId)).resolves.toBe(0);
      await expect(
        store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
      ).resolves.toMatchObject({ outcome: 'allow' });
    }

    // Back in the queue, and the rest of the ceiling is committed again: a worker is about to
    // spend it, and two starts in the same second must not both fit under the same cap.
    for (const status of ['queued', 'planning', 'running']) {
      await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [task.id, status]);
      await expect(store.openSpendCommitment(userId)).resolves.toBeCloseTo(3, 6);
      await expect(
        store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
      ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    }
  });

  it('will not materialise a scheduled run that would breach the cap', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 1 });
    const schedule = await store.createTaskSchedule({
      userId,
      workspaceId,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 5,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    expect(schedule.maxSpendUsd).toBe(5);
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-spend');
    const blocked = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-spend',
      taskId: '00000000-0000-4000-8000-0000000000a1',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(blocked).toMatchObject({ outcome: 'failed', errorCode: 'spend_cap_reached' });
    expect(blocked?.task.status).toBe('failed');
    expect(blocked?.task.maxSpendUsd).toBe(5);
    // Nothing was reserved for a run that never started.
    await expect(store.reservedUsageForTask(blocked!.task.id)).resolves.toBe(0);

    // Raising the cap lets the very same schedule through.
    await store.setSpendLimits({ userId, dailyCapUsd: 50 });
    await database.query(
      "UPDATE task_schedules SET enabled=TRUE,next_run_at=NOW()-INTERVAL '1 minute'"
    );
    await store.leaseDueTaskSchedule('scheduler-spend');
    const allowed = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-spend',
      taskId: '00000000-0000-4000-8000-0000000000a2',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(allowed).toMatchObject({ outcome: 'queued', errorCode: null });
    expect(allowed?.task.maxSpendUsd).toBe(5);
  });

  it('raises one alert per window occurrence rather than one per model call', async () => {
    const claim = (level: 'warning' | 'exceeded', windowStart: Date) =>
      store.claimSpendAlert({
        userId,
        windowName: 'daily',
        windowStart,
        level,
        spentUsd: 4,
        capUsd: 5
      });
    await expect(claim('warning', bounds.daily.start)).resolves.toBe(true);
    await expect(claim('warning', bounds.daily.start)).resolves.toBe(false);
    // Crossing the hard cap on the same day is a separate thing worth saying.
    await expect(claim('exceeded', bounds.daily.start)).resolves.toBe(true);
    // Tomorrow starts over.
    await expect(claim('warning', bounds.daily.end)).resolves.toBe(true);
    await expect(store.listSpendAlerts(userId)).resolves.toHaveLength(3);
  });

  it('updates only the caps it was given and validates the zone the windows roll over in', async () => {
    await store.setSpendLimits({
      userId,
      dailyCapUsd: 3,
      monthlyCapUsd: 40,
      timeZone: 'Asia/Tokyo'
    });
    await store.setSpendLimits({ userId, dailyCapUsd: null });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: null,
      monthlyCapUsd: 40,
      warnAtPercent: 80,
      timeZone: 'Asia/Tokyo'
    });
    await store.setSpendLimits({ userId, warnAtPercent: 50 });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      monthlyCapUsd: 40,
      warnAtPercent: 50,
      timeZone: 'Asia/Tokyo'
    });
    await expect(store.setSpendLimits({ userId, timeZone: 'Mars/Olympus' })).rejects.toThrow(
      /Unknown IANA time zone/
    );
  });

  it('reports defaults for an owner who never opened the settings', async () => {
    await expect(store.getSpendLimits(userId)).resolves.toBeNull();
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: null,
      monthlyCapUsd: null,
      defaultTaskCapUsd: null,
      warnAtPercent: 80,
      timeZone: 'UTC'
    });
    // With no cap anywhere, nothing is ever refused.
    await expect(store.spendGuard({ userId, estimateUsd: 10_000, now })).resolves.toMatchObject({
      outcome: 'allow'
    });
  });

  it('anchors a follow-up ceiling to what the task already spent', async () => {
    const task = await store.createTask(taskInput(userId, workspaceId));
    expect(task.maxSpendUsd).toBeNull();
    await bill({ key: 'first-turn', costUsd: 1.5, taskId: task.id });
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [task.id]);
    const continued = await store.continueTask({
      id: task.id,
      userId,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      additionalSpendUsd: 2,
      agentStateCiphertext: envelope,
      reservationKey: `task:${task.id}:turn-2`,
      resourceClass: 'medium',
      userMessageCiphertext: envelope
    });
    // $1.50 already gone plus the $2 this follow-up was granted.
    expect(continued?.maxSpendUsd).toBeCloseTo(3.5, 6);
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 1.9, now })
    ).resolves.toMatchObject({ blockedBy: null });
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 2.1, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'task' });
  });

  it('serves the whole spend surface from one call', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5, monthlyCapUsd: 50 });
    const task = await store.createTask(taskInput(userId, workspaceId));
    await bill({ key: 'summary-1', costUsd: 1.25, taskId: task.id });
    const summary = await store.spendSummary(userId, now);
    expect(summary.limits).toMatchObject({ dailyCapUsd: 5, monthlyCapUsd: 50 });
    expect(summary.windows.map((window) => window.name)).toEqual(['daily', 'monthly']);
    expect(summary.windows[0]).toMatchObject({ spentUsd: 1.25, capUsd: 5 });
    expect(summary.byDay).toEqual([{ key: '2026-07-15', costUsd: 1.25, calls: 1 }]);
    expect(summary.byModel).toEqual([{ key: 'z-ai/glm-5.2', costUsd: 1.25, calls: 1 }]);
    expect(summary.byTask).toEqual([{ key: task.id, costUsd: 1.25, calls: 1 }]);
  });
});

describe('schema migrations against a populated database', () => {
  let database: Database;
  let store: DataStore;

  const envelope: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
  const key = memoryIndexKey(Buffer.alloc(32, 3));

  /**
   * Every table a migration deletes from, rewrites or re-constrains, plus the encrypted bodies,
   * ordered so the comparison is stable. This is the thing a replay must not change.
   */
  const snapshot = async () => {
    const rows = async (sql: string) => (await database.query(sql)).rows;
    return {
      users: await rows('SELECT id,username,display_name FROM users ORDER BY username'),
      workspaces: await rows('SELECT id,name,security_mode,region FROM workspaces ORDER BY name'),
      workspaceKeys: await rows(
        'SELECT workspace_id,wrapping_mode,wrapped_key FROM workspace_keys ORDER BY workspace_id'
      ),
      tasks: await rows(
        `SELECT id,title,status,privacy_route,max_compute_credits,max_spend_usd,prompt_ciphertext
         FROM tasks ORDER BY created_at,id`
      ),
      taskEvents: await rows(
        'SELECT task_id,sequence,kind,payload_ciphertext FROM task_events ORDER BY task_id,sequence'
      ),
      schedules: await rows(
        'SELECT id,privacy_route,max_compute_credits,max_spend_usd,spec FROM task_schedules ORDER BY id'
      ),
      models: await rows(
        'SELECT id,privacy_route,provider_model_id,usage_class FROM model_releases ORDER BY id'
      ),
      providers: await rows(
        'SELECT user_id,provider,status,external_ref FROM managed_provider_credentials ORDER BY user_id,provider'
      ),
      challenges: await rows('SELECT id,kind,challenge FROM auth_challenges ORDER BY challenge'),
      usage: await rows(
        'SELECT idempotency_key,kind,credits,cost_usd,model_id,state FROM usage_entries ORDER BY idempotency_key'
      ),
      spendLimits: await rows(
        'SELECT user_id,daily_cap_usd,monthly_cap_usd,time_zone FROM spend_limits ORDER BY user_id'
      ),
      connectors: await rows('SELECT id,kind,auth_mode,label FROM connectors ORDER BY id'),
      previews: await rows('SELECT id,slug,visibility FROM workspace_previews ORDER BY slug'),
      memoryItems: await rows(
        'SELECT id,kind,status,document_ciphertext,tsv_len FROM mem.item ORDER BY created_at,id'
      ),
      memorySources: await rows(
        'SELECT id,channel,body_ciphertext,tsv_len FROM mem.source ORDER BY created_at,id'
      ),
      corpusStats: await rows(
        'SELECT workspace_id,n_docs,sum_len FROM mem.corpus_stats ORDER BY workspace_id'
      )
    };
  };

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();

    const user = await store.createUser({ username: 'resident', displayName: 'Resident' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long lived'));
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      maxSpendUsd: 3
    });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'user_message',
      summary: 'Encrypted user_message event',
      payloadCiphertext: envelope
    });
    await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 2,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await store.upsertModels([
      {
        id: 'openrouter/z-ai/glm-5.2',
        providerModelId: 'z-ai/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'openrouter',
        revision: 'openrouter-live',
        availability: 'available',
        openness: 'permissive_open_weight',
        license: 'MIT',
        commercialUse: true,
        privacyRoute: 'provider_zdr',
        contextTokens: 200_000,
        modalities: ['text'],
        capabilities: ['chat', 'tools'],
        usageClass: 'high',
        recommendationTags: ['Tools'],
        measuredQuality: 0.7,
        measuredLatencyMs: 900
      }
    ]);
    await store.upsertManagedProviderCredential({
      userId: user.id,
      provider: 'inference',
      secretCiphertext: envelope,
      externalRef: 'self-hosted',
      monthlyLimitUsd: 0,
      status: 'active'
    });
    // Live challenges of the two kinds that were added after the constraint was first written:
    // an earlier, narrower version of that constraint cannot be re-applied over either of them.
    await store.createChallenge({
      username: 'resident',
      challenge: 'recover-me',
      kind: 'recovery'
    });
    await store.createChallenge({
      username: 'resident',
      challenge: 'add-a-key',
      kind: 'passkey_add'
    });
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'high',
      quantity: 2_000,
      unit: 'tokens',
      credits: 0.5,
      state: 'settled',
      idempotencyKey: 'replay-usage-1',
      providerRef: 'openrouter:z-ai/glm-5.2',
      costUsd: 1.5
    });
    await store.setSpendLimits({ userId: user.id, dailyCapUsd: 7, monthlyCapUsd: 70 });
    await store.createConnector({
      id: '00000000-0000-4000-8000-0000000000c1',
      userId: user.id,
      kind: 'mcp_http',
      authMode: 'bearer',
      label: 'Docs',
      baseUrl: 'https://mcp.example.test',
      scopes: ['mcp:tools.execute'],
      secretCiphertext: envelope
    });
    await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Site',
      port: 5173,
      slug: 'site-slug',
      accessTokenHash: 'preview-hash',
      maxPreviews: 2
    });
    const sourceIndex = buildMemorySourceIndex('the owner runs athanor on one server', key);
    const source = await store.createMemorySource({
      userId: user.id,
      workspaceId: workspace.id,
      channel: 'chat',
      bodyCiphertext: envelope,
      bodyTokens: sourceIndex.bodyTokens,
      tokensEst: sourceIndex.tokensEst,
      indexed: sourceIndex.indexed,
      occurredAt: new Date()
    });
    const item = await store.createMemoryItem({
      userId: user.id,
      workspaceId: workspace.id,
      kind: 'episode',
      trust: 'stated',
      documentCiphertext: envelope,
      index: buildMemoryItemIndex(
        { title: 'set up the server', body: 'installed athanor on the box' },
        key
      ),
      observedAt: new Date(),
      validFrom: new Date()
    });
    await store.attachMemoryEvidence(item.id, [{ sourceId: source.id }]);
  });

  afterEach(async () => database.close());

  it('survives every migration being re-applied over live data, twice', async () => {
    const before = await snapshot();
    expect(before.tasks).toHaveLength(1);
    expect(before.models).toHaveLength(1);
    expect(before.memoryItems).toHaveLength(1);

    for (let pass = 0; pass < 2; pass += 1)
      for (const migration of migrations)
        await database.transaction(async (transaction) => transaction.exec(migration.sql));

    expect(await snapshot()).toEqual(before);
  });

  /*
   * The box this update lands on already has the runs. A watcher that has been firing every fifteen
   * minutes for a month is thousands of conversations that would stay uncollapsed if the column only
   * ever filled for runs made after the update, so the migration reads the pairing out of
   * task_schedule_runs, which has carried it since version 11.
   */
  it('gives a run that already exists the schedule it came from', async () => {
    // The state of a live box before this version: no column, and the pairing only in the run row.
    await database.exec('ALTER TABLE tasks DROP COLUMN schedule_id');
    const owner = await database.query<{ id: string; user_id: string; workspace_id: string }>(
      'SELECT id,user_id,workspace_id FROM tasks LIMIT 1'
    );
    const existing = owner.rows[0]!;
    const scheduleId = '00000000-0000-4000-8000-0000000000f1';
    await database.query(
      `INSERT INTO task_schedules(id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,
         model_id,privacy_route,max_compute_credits,spec)
       VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,'qwen','provider_zdr',1,$5::jsonb)`,
      [
        scheduleId,
        existing.user_id,
        existing.workspace_id,
        JSON.stringify(envelope),
        JSON.stringify({ kind: 'interval', everyMinutes: 15 })
      ]
    );
    await database.query(
      `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome)
       VALUES ($1,NOW(),$2,'queued')`,
      [scheduleId, existing.id]
    );

    const arrival = migrations.find((migration) => migration.version === 62)!;
    await database.transaction(async (transaction) => transaction.exec(arrival.sql));

    const filed = await database.query<{ id: string; schedule_id: string | null }>(
      'SELECT id,schedule_id FROM tasks ORDER BY id'
    );
    expect(filed.rows.find((row) => row.id === existing.id)?.schedule_id).toBe(scheduleId);
    // Nothing the owner started is claimed by a schedule it never came from.
    expect(
      filed.rows.filter((row) => row.id !== existing.id).every((row) => row.schedule_id === null)
    ).toBe(true);
  });

  it('is a no-op when a second start migrates the same populated database', async () => {
    const before = await snapshot();
    await migrateDatabase(database);
    await migrateDatabase(database);
    expect(await snapshot()).toEqual(before);
    const applied = await database.query<{ version: number; applications: string }>(
      'SELECT version,COUNT(*) AS applications FROM schema_migrations GROUP BY version'
    );
    expect(applied.rows).toHaveLength(migrations.length);
    expect(applied.rows.filter((row) => Number(row.applications) !== 1)).toEqual([]);
  });
});

describe('task spend on the owner-facing reads', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  it('carries the task ceiling and what it has cost so far', async () => {
    const user = await store.createUser({ username: 'reader', displayName: 'Reader' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Reading'));
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      maxSpendUsd: 2.5
    });
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 500,
      unit: 'tokens',
      credits: 0.1,
      state: 'settled',
      idempotencyKey: 'read-1',
      providerRef: 'openrouter:z-ai/glm-5.2',
      costUsd: 0.4
    });
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({
      maxSpendUsd: 2.5,
      spentUsd: 0.4
    });
    // The sidebar reads across every workspace and is paged; listTasks is the unpaged whole-set
    // read for one workspace, which is what the "is anything still running here" checks need.
    await expect(store.listTaskPage(user.id)).resolves.toMatchObject({
      tasks: [{ id: task.id, maxSpendUsd: 2.5, spentUsd: 0.4 }],
      hasMore: false
    });
    await expect(store.listTasks(user.id, workspace.id)).resolves.toMatchObject([
      { id: task.id, spentUsd: 0.4 }
    ]);
  });

  /*
   * The cursor is a position in an ordering, and it has to be able to express that position
   * exactly. PostgreSQL keeps microseconds; the cursor was built from the mapped ISO string, which
   * keeps milliseconds - so every conversation sharing a millisecond with the last row of a page
   * sorted "after" a cursor that had been rounded up past it, and vanished from the list. Nothing
   * about it was visible: the page came back short, and the conversation was still there.
   */
  it('pages the conversation list without losing one that shares a millisecond', async () => {
    const user = await store.createUser({ username: 'pager', displayName: 'Pager' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Paging'));
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push((await store.createTask(taskInput(user.id, workspace.id))).id);
    // The same millisecond, a hundred microseconds apart, which is a perfectly ordinary way for
    // three conversations to be touched by one turn of work.
    const stamps = [
      '2026-08-01T09:00:00.123456+00',
      '2026-08-01T09:00:00.123400+00',
      '2026-08-01T09:00:00.123100+00'
    ];
    for (const [index, id] of ids.entries())
      await database.query(
        'UPDATE tasks SET updated_at=$2::timestamptz, created_at=$2::timestamptz WHERE id=$1',
        [id, stamps[index]]
      );

    const first = await store.listTaskPage(user.id, { limit: 2 });
    expect(first.tasks.map((task) => task.id)).toEqual([ids[0], ids[1]]);
    expect(first.hasMore).toBe(true);
    const second = await store.listTaskPage(user.id, { cursor: first.nextCursor! });
    expect(second.tasks.map((task) => task.id)).toEqual([ids[2]]);
    expect(second.hasMore).toBe(false);
  });

  /**
   * A fifteen-minute watcher is ninety-six conversations a day, and the list is ordered by
   * activity, so the schedule the owner set up once used to take the whole first page inside two
   * days. What fell off the end was the only thing on it they had done themselves.
   */
  it('keeps one schedule from taking the list the owner finds their own work in', async () => {
    const user = await store.createUser({ username: 'watched', displayName: 'Watched' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Watched'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf2';
    const mine = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      'UPDATE tasks SET created_at=$2::timestamptz, updated_at=$2::timestamptz WHERE id=$1',
      [mine.id, '2026-08-01T09:00:00+00']
    );
    const runs: string[] = [];
    for (let fired = 0; fired < 12; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 2, fired)).toISOString()]
      );
      runs.push(run.id);
    }
    const newest = [...runs].reverse();

    const page = await store.listTaskPage(user.id, { limit: 10 });
    expect(page.tasks.filter((task) => task.scheduleId).map((task) => task.id)).toEqual(
      newest.slice(0, 5)
    );
    // The whole point: the owner's own conversation is still on the page they read.
    expect(page.tasks.map((task) => task.id)).toContain(mine.id);
    // And the folded line can say how many runs there are rather than how many it is holding.
    expect(page.scheduleRunCounts).toEqual({ [scheduleId]: 12 });

    // Nothing is hidden by this, only kept out of the way: the schedule's own list is all of them.
    const history = await store.listTaskPage(user.id, { scheduleId });
    expect(history.tasks.map((task) => task.id)).toEqual(newest);

    // A run the owner pinned is theirs now, so it is neither capped away nor counted as the
    // schedule's - which is exactly what the client does with a pinned run.
    await store.updateTaskFiling(user.id, runs[0]!, { pinned: true });
    const pinned = await store.listTaskPage(user.id, { limit: 10 });
    expect(pinned.tasks.map((task) => task.id)).toContain(runs[0]);
    expect(pinned.scheduleRunCounts).toEqual({ [scheduleId]: 11 });
  });

  /**
   * The ceiling has to rank over the rows the page is drawn from and not over every run there has
   * ever been, or filing a run away hides the ones behind it.
   *
   * An owner who archives the newest few runs of a noisy watcher - the most ordinary thing anyone
   * does with one - was setting the boundary with rows that were then not on the page to occupy it,
   * and the schedule disappeared from the list while the count beside it still said hundreds.
   * Pinning the newest few did the same thing, and the client leaves pinned runs out of the fold,
   * so the folded line was left with nothing behind it at all.
   */
  it('does not hide a schedule behind the runs of it the owner has filed or pinned', async () => {
    const user = await store.createUser({ username: 'filed', displayName: 'Filed' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Filed'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf4';
    const runs: string[] = [];
    for (let fired = 0; fired < 20; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 4, fired)).toISOString()]
      );
      runs.push(run.id);
    }
    const newest = [...runs].reverse();

    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { pinned: true });
    const withPinned = await store.listTaskPage(user.id, { limit: 50 });
    expect(
      withPinned.tasks.filter((task) => task.scheduleId === scheduleId && !task.pinned)
    ).toHaveLength(5);
    expect(withPinned.scheduleRunCounts).toEqual({ [scheduleId]: 15 });

    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { pinned: false });
    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { archived: true });
    const active = await store.listTaskPage(user.id, { limit: 50, include: 'active' });
    expect(active.tasks.filter((task) => task.scheduleId === scheduleId)).toHaveLength(5);
    expect(active.scheduleRunCounts).toEqual({ [scheduleId]: 15 });
  });

  /**
   * The ceiling is a fact about each run rather than about the page, which is the only way it can
   * live alongside a cursor: a page boundary that fell inside a schedule's runs would otherwise
   * show one twice or step over one.
   */
  it('pages a capped list without showing a run twice or stepping over one', async () => {
    const user = await store.createUser({ username: 'capped', displayName: 'Capped' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Capped'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf3';
    for (let fired = 0; fired < 8; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 3, fired)).toISOString()]
      );
      const mine = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        'UPDATE tasks SET created_at=$2::timestamptz, updated_at=$2::timestamptz WHERE id=$1',
        [mine.id, new Date(Date.UTC(2026, 7, 3, fired, 30)).toISOString()]
      );
    }
    const whole = await store.listTaskPage(user.id, { limit: 100 });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10 && (page === 0 || cursor); page += 1) {
      const next: Awaited<ReturnType<typeof store.listTaskPage>> = await store.listTaskPage(
        user.id,
        { limit: 2, ...(cursor ? { cursor } : {}) }
      );
      walked.push(...next.tasks.map((task) => task.id));
      cursor = next.nextCursor;
    }
    expect(walked).toEqual(whole.tasks.map((task) => task.id));
    expect(whole.tasks.filter((task) => task.scheduleId)).toHaveLength(5);
  });

  it('finds a conversation by a name the owner gave it, however old the conversation is', async () => {
    const user = await store.createUser({ username: 'namer', displayName: 'Namer' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Naming'));
    const key = memoryIndexKey(generateDataKey());
    const named = (title: string, prompt: string) => buildConversationNameIndex(title, prompt, key);

    // Renamed by the owner, and then buried under two thousand conversations. Its new name shares
    // no word with the request it started from, so nothing about it is in the verbatim corpus.
    const renamed = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Check the thing', 'Check the thing')
    });
    await store.renameTask(
      user.id,
      renamed.id,
      { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      named('Kitchen rewire', 'Check the thing')
    );
    // Only mentions the words in its opening request, so it must lose to the one called that.
    const mentioned = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Weekend jobs', 'Get a quote for the kitchen rewire before the holiday')
    });
    for (let index = 0; index < 20; index += 1)
      await store.createTask({
        ...taskInput(user.id, workspace.id),
        nameIndex: named(`Unrelated ${index}`, 'Something else entirely')
      });
    await database.query(
      `UPDATE tasks SET created_at='2026-03-02T09:00:00Z', updated_at='2026-03-02T09:00:00Z'
       WHERE id = ANY($1::uuid[])`,
      [[renamed.id, mentioned.id]]
    );

    const hits = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('kitchen rewire', key).lexemes,
      limit: 10
    });
    expect(hits.map((hit) => hit.id)).toEqual([renamed.id, mentioned.id]);
    expect(hits[0]).toMatchObject({ wholeName: true, inName: true });
    // Nothing of the query is in this one's name, so it is carried entirely by the opening.
    expect(hits[1]).toMatchObject({ wholeName: false, inName: false });

    // Stemming reaches a name because the name went through the corpus tokenizer, not because
    // anything here reimplemented it.
    const restarted = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Relay restart', 'Look at the relay')
    });
    const stemmed = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('restarted the relays', key).lexemes,
      limit: 10
    });
    expect(stemmed.map((hit) => hit.id)).toEqual([restarted.id]);
    expect(stemmed[0]).toMatchObject({ wholeName: true });

    const other = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    await expect(
      store.searchTaskNames(other.id, { lexemes: planMemoryQuery('kitchen rewire', key).lexemes })
    ).resolves.toEqual([]);
  });

  it('leaves a conversation written before the index existed for the boot pass to pick up', async () => {
    const user = await store.createUser({ username: 'backfill', displayName: 'Backfill' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Backfill'));
    const key = memoryIndexKey(generateDataKey());
    const task = await store.createTask(taskInput(user.id, workspace.id));
    // What every row on a box that predates the column looks like.
    await database.query('UPDATE tasks SET name_tsv = NULL WHERE id=$1', [task.id]);

    const waiting = await store.listTasksMissingNameIndex();
    expect(waiting.map((row) => row.id)).toEqual([task.id]);
    await store.setTaskNameIndex(
      task.id,
      buildConversationNameIndex('Sailing trip', 'Plan the crossing', key)
    );

    await expect(store.listTasksMissingNameIndex()).resolves.toEqual([]);
    const hits = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('sailing trip', key).lexemes
    });
    expect(hits.map((hit) => hit.id)).toEqual([task.id]);
  });

  it('anchors a turn checkpoint to the point in the transcript it was taken at', async () => {
    const user = await store.createUser({ username: 'rewind', displayName: 'Rewind' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Rewind'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Build it' });

    const first = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be1',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 0,
      mechanism: 'content',
      fileCount: 120,
      totalBytes: 4096,
      storedBytes: 512,
      durationMs: 180
    });
    expect(first).toMatchObject({ eventSequence: 1, mechanism: 'content', storedBytes: 512 });

    const midpoint = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'tool_started',
      summary: 'Running shell'
    });
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Actually...' });
    const second = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be2',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 1,
      mechanism: 'btrfs',
      fileCount: null,
      totalBytes: null,
      storedBytes: 0,
      durationMs: 12
    });
    const last = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Done'
    });

    // A checkpoint sits in front of the work its turn is about to do, so the one that answers
    // "put the computer back to this event" is the newest at or before it - never a later one.
    await expect(
      store.checkpointForTaskEvent(user.id, task.id, midpoint.id)
    ).resolves.toMatchObject({ id: first.id });
    await expect(store.checkpointForTaskEvent(user.id, task.id, last.id)).resolves.toMatchObject({
      id: second.id,
      fileCount: null,
      totalBytes: null
    });

    // The shape a real turn has: the message, the status lines the worker writes before it does
    // anything, and only then the undo point. Anchoring on the message the owner sent has to find
    // the point for the work that message caused - recording where the checkpoint happened to be
    // taken put it beyond that anchor, so a first turn reported nothing to undo and a later one
    // silently handed back the previous turn's point, discarding a turn nobody asked to undo.
    const thirdMessage = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'user_message',
      summary: 'One more thing'
    });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'status',
      summary: 'Agent started work'
    });
    const third = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be3',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 2,
      mechanism: 'content',
      fileCount: 3,
      totalBytes: 64,
      storedBytes: 64,
      durationMs: 5
    });
    await expect(
      store.checkpointForTaskEvent(user.id, task.id, thirdMessage.id)
    ).resolves.toMatchObject({ id: third.id });

    // Another account's identifier answers nothing, and neither does an event of another task.
    const other = await store.createUser({ username: 'other', displayName: 'Other' });
    await expect(store.getWorkspaceCheckpoint(other.id, first.id)).resolves.toBeNull();
    await expect(store.checkpointForTaskEvent(other.id, task.id, last.id)).resolves.toBeNull();
    const otherTask = await store.createTask(taskInput(user.id, workspace.id));
    const strayEvent = await store.appendTaskEvent({
      taskId: otherTask.id,
      kind: 'user_message',
      summary: 'Elsewhere'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, strayEvent.id)).resolves.toBeNull();

    await expect(
      store.deleteWorkspaceCheckpoints(workspace.id, [first.id, second.id, third.id])
    ).resolves.toBe(3);
    await expect(store.checkpointForTaskEvent(user.id, task.id, last.id)).resolves.toBeNull();
  });

  it('rewinds to the checkpoint in front of the work when two share a transcript position', async () => {
    const user = await store.createUser({ username: 'tied', displayName: 'Tied' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Tied'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Change it' });

    /**
     * A checkpoint's `event_sequence` is the transcript position at the moment it was taken, so a
     * turn that checkpoints twice before writing an event produces two rows carrying the same
     * number. Only the first of them is in front of all the work at that position; the second
     * already contains whatever happened in between - the very changes an undo is asking to drop.
     */
    const write = async (id: string) =>
      store.recordWorkspaceCheckpoint({
        id,
        workspaceId: workspace.id,
        taskId: task.id,
        turn: 0,
        mechanism: 'content',
        fileCount: 1,
        totalBytes: 10,
        storedBytes: 10,
        durationMs: 1
      });
    // Deliberately descending ids: the answer must come from when each was taken, not from which
    // identifier happens to sort first.
    const inFront = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff9');
    const afterSomeWork = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff1');
    expect([inFront.eventSequence, afterSomeWork.eventSequence]).toEqual([1, 1]);

    const target = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Changed it'
    });
    /**
     * Which of the two the undo lands on, and that the answer cannot depend on anything but when
     * each was taken. The ids above descend deliberately: the ordering used to fall through to
     * them whenever two rows shared a created_at, which is a wrong restore that only appears on a
     * machine that has been lived in. The order is now a sequence, which cannot tie.
     */
    await expect(store.checkpointForTaskEvent(user.id, task.id, target.id)).resolves.toMatchObject({
      id: inFront.id
    });
    // The same answer from a later point in the transcript: the tiebreaker is a property of the
    // two checkpoints, not of where the question was asked from.
    const later = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Later still'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, later.id)).resolves.toMatchObject({
      id: inFront.id
    });
  });

  it('orders two checkpoints taken in the same instant by which was taken first', async () => {
    // The failure this removes is invisible: give two rows the same created_at and the old ordering
    // fell through to the identifier, so an undo restored the checkpoint that already contained the
    // work it was asked to drop. A sequence cannot tie, so the wrong answer is no longer reachable.
    const user = await store.createUser({ username: 'tied-clock', displayName: 'Tied clock' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Tied clock'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Change it' });
    const write = async (id: string) =>
      store.recordWorkspaceCheckpoint({
        id,
        workspaceId: workspace.id,
        taskId: task.id,
        turn: 0,
        mechanism: 'content',
        fileCount: 1,
        totalBytes: 10,
        storedBytes: 10,
        durationMs: 1
      });
    const inFront = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ffa');
    const afterSomeWork = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff2');
    // Force the collision the clock only produces occasionally, so this is a property of the
    // ordering rather than of how fast the machine happened to be.
    await database.query(
      'UPDATE workspace_checkpoints SET created_at = $1 WHERE id = ANY($2::uuid[])',
      [new Date('2026-01-01T00:00:00.000Z'), [inFront.id, afterSomeWork.id]]
    );
    const target = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Changed it'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, target.id)).resolves.toMatchObject({
      id: inFront.id
    });
  });

  it('records which of the two a fork rewound, and survives its checkpoint being pruned', async () => {
    const user = await store.createUser({ username: 'forked', displayName: 'Forked' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Forked'));
    const parent = await store.createTask(taskInput(user.id, workspace.id));
    const anchor = await store.appendTaskEvent({
      taskId: parent.id,
      kind: 'user_message',
      summary: 'Start'
    });
    const checkpoint = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf1',
      workspaceId: workspace.id,
      taskId: parent.id,
      turn: 0,
      mechanism: 'content',
      fileCount: 10,
      totalBytes: 100,
      storedBytes: 100,
      durationMs: 5
    });

    // The default is what the product has always done: a new conversation path, machine untouched.
    const conversationOnly = await store.createTaskBranch({
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: anchor.id,
      forkKind: 'branch',
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      agentStateCiphertext: null
    });
    expect(conversationOnly).toMatchObject({
      rewindScope: 'conversation',
      restoredCheckpointId: null
    });

    const both = await store.createTaskBranch({
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: anchor.id,
      forkKind: 'edit',
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      agentStateCiphertext: null,
      status: 'queued',
      rewindScope: 'both',
      restoredCheckpointId: checkpoint.id
    });
    expect(both).toMatchObject({ rewindScope: 'both', restoredCheckpointId: checkpoint.id });
    await expect(store.getTask(user.id, both.id)).resolves.toMatchObject({
      rewindScope: 'both',
      restoredCheckpointId: checkpoint.id
    });

    // Checkpoints are pruned on a retention policy; the fork that used one must outlive it.
    await store.deleteWorkspaceCheckpoints(workspace.id, [checkpoint.id]);
    await expect(store.getTask(user.id, both.id)).resolves.toMatchObject({
      rewindScope: 'both',
      restoredCheckpointId: null
    });
  });
});

/**
 * Media is the one thing the agent can start on its own that spends money outside a model call, so
 * the owner's list and the owner's stop are the whole of their control over it.
 */

/**
 * A query that orders by a column with repeats and then cuts the result off has two legal answers,
 * and PostgreSQL is free to give either. It normally gives the friendly one - rows come back in the
 * order they were written, so a fresh table looks deterministic and a test written against it
 * passes. The order only changes once the table has been lived in: a row updated in place moves to
 * the end of the heap, the planner switches from a sequential scan to an index scan as the table
 * grows, or a second worker reads a different snapshot. That is why this is checked by reading the
 * statements rather than by running them - the failure cannot be reproduced on a small table, which
 * is exactly what makes it expensive to find later.
 *
 * The rule is narrow on purpose: only orderings that feed a LIMIT, because those are the ones where
 * a tie changes which rows the caller is given rather than only what order they arrive in.
 */
describe('the statements themselves', () => {
  it('never cuts off an ordering that could resolve two ways', async () => {
    const source = await readFile(new URL('./store.ts', import.meta.url), 'utf8');
    /**
     * A term that can hold only one value per row. Reaching one breaks every remaining tie, so its
     * position in the clause does not matter - `1` is the ordinal a GROUP BY collapsed the rows to.
     */
    const decisive = /(^|[\s.(])(id|[a-z_]+_id|sequence|version|1)\b/i;
    /**
     * Orderings whose totality comes from a composite natural key instead of a surrogate id. Each
     * one is listed rather than pattern-matched, because whether a set of columns is a key is a
     * fact about the schema that no amount of reading the clause can establish.
     */
    const totalByNaturalKey = new Map([
      [
        'COALESCE(d.df, 1) ASC, t.lexeme ASC',
        'the rows are the query lexemes, so two that tie on df and lexeme are the same row twice'
      ],
      [
        'n_episodes DESC, last_seen DESC, subject_key, predicate, object_key',
        'mem.fact_candidate is keyed on (workspace_id, subject_key, predicate, object_key), and the workspace is fixed by the WHERE'
      ],
      [
        'created_at DESC, window_name, window_start DESC, level',
        'spend_alerts is keyed on (user_id, window_name, window_start, level), and the user is fixed by the WHERE'
      ],
      [
        'c.event_sequence DESC, c.taken_seq ASC',
        'workspace_checkpoints.taken_seq is NOT NULL and defaults from a sequence, so no two rows carry the same value'
      ]
    ]);
    const ambiguous: string[] = [];
    for (const match of source.matchAll(/ORDER BY\s+([^`]+?)(?:FOR UPDATE[^\n]*?)?\bLIMIT\b/gs)) {
      const clause = match[1]!.replace(/\s+/g, ' ').trim();
      // Anything this long has run past the end of its own statement into the next one.
      if (clause.length > 200) continue;
      if (totalByNaturalKey.has(clause)) continue;
      const terms = clause
        .split(',')
        .map((term) => term.replace(/\b(ASC|DESC|NULLS (FIRST|LAST))\b/gi, '').trim());
      if (!terms.some((term) => decisive.test(term)))
        ambiguous.push(
          `line ${source.slice(0, match.index).split('\n').length}: ORDER BY ${clause}`
        );
    }
    expect(ambiguous).toEqual([]);
  });
});

/**
 * The wake-up path between processes.
 *
 * On a real box the API, the worker and the notifier are separate units, and "a reply just arrived"
 * reaches all three over LISTEN/NOTIFY. None of that is exercised by the suites above: they run on
 * PGlite, which is a single backend in a single process, so its `listen` and `notify` are no-ops
 * and every signal is delivered locally. What can be tested without a server is the store's own
 * half - which channels it subscribes to, and what it does when subscribing fails partway.
 */
describe('the cross-process signal bridge', () => {
  const stubDatabase = (listen: (channel: string) => Promise<() => Promise<void>>): Database => {
    const database: Database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      exec: async () => undefined,
      transaction: async (callback) => callback(database),
      withAdvisoryLock: async (_key, callback) => callback(),
      notify: async () => undefined,
      listen,
      close: async () => undefined
    };
    return database;
  };

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  it('retries only the channels a failed subscription never reached', async () => {
    const subscribed: string[] = [];
    let allowed = 2;
    const store = new DataStore(
      stubDatabase(async (channel) => {
        if (subscribed.length >= allowed) throw new Error('listener connection dropped');
        subscribed.push(channel);
        return async () => undefined;
      })
    );

    // The first subscriber starts the bridge; the third channel fails, which clears the retry flag.
    store.onTaskEvent('a-task', () => undefined);
    await settle();
    expect(subscribed).toHaveLength(2);

    // The next subscriber retries. It must pick up where the first left off: subscribing to the
    // first two channels again would deliver every task event twice, then three times, and so on
    // for as long as the connection kept flapping.
    allowed = 99;
    store.onTaskEvent('another-task', () => undefined);
    await settle();
    expect(subscribed).toHaveLength(3);
    expect(new Set(subscribed).size).toBe(3);
  });
});
