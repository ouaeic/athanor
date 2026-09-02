import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';

/**
 * The candidate set, asked the one question its four original branches could not answer: what
 * happens to a conversation whose approval nobody answered.
 *
 * The whole path is exercised rather than the branch alone. `cleanupExpired` is what marks a lapsed
 * approval 'expired'; the API's approval sweep is what then moves the task to 'paused'. Standing
 * that pair up in order is the check that the new branch lands on the path that already runs, and
 * not one step early - a task whose approval has expired but which the sweep has not reached yet is
 * still `awaiting_user`, and telling the owner it gave up before the credits are back would be a
 * notice about a state the box has not finished leaving.
 */
describe('a candidate for an approval that expired unanswered', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  /** User, workspace, a device registered two days ago, a conversation, and one approval. */
  const stranded = async () => {
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
    // The device was here before the approval ran out, which is what makes this its news. Every
    // branch of the candidate set is bounded by the subscription's own age so that registering a
    // phone today does not deliver a fortnight of history to it, and this one is bounded by the
    // expiry rather than by the approval's creation: the expiry is when the thing happened.
    await database.query(
      "UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '2 days'",
      []
    );
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'private-title', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'shell',
      sideEffect: 'external_consequential',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      // Written 24 hours before it lapsed, in the past, which is the state the sweep finds.
      expiresAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'awaiting_user');
    return { user, task, approvalId, subscription };
  };

  it('says nothing until the sweep has actually paused the conversation', async () => {
    const { user, task } = await stranded();
    // Past its deadline and still `pending`: the approval branch requires `expires_at > NOW()`, so
    // there is nothing to send even though the card on screen has stopped working.
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.cleanupExpired();
    // Marked expired, and the task is still `awaiting_user` because the API sweep has not run. The
    // credits are still reserved; this is not yet a conversation the owner can restart.
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['takeover_needed']);
  });

  it('names the approval, the conversation and the hour it lapsed', async () => {
    const { user, task, approvalId } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    const pending = await store.listPendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'takeover_needed',
      resourceId: approvalId,
      taskId: task.id,
      taskStatus: 'paused'
    });
    // The expiry, not the task's last write. The staleness horizon in the notifier is measured
    // against exactly this, and the task row was touched again when the sweep paused it.
    expect(Date.parse(pending[0]!.eventAt)).toBeLessThan(Date.now() - 59 * 60 * 1000);
    // No key was handed in, so nothing encrypted may be readable on the row.
    expect(JSON.stringify(pending)).not.toContain('private-title');
  });

  it('is not settled by the ledger row the original approval push wrote', async () => {
    const { user, task, approvalId, subscription } = await stranded();
    // What the owner was told when the agent first asked. Same approval id, different news.
    await store.recordNotificationDelivery(subscription.id, 'approval_required', approvalId);
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'takeover_needed', resourceId: approvalId }
    ]);
    await store.recordNotificationDelivery(subscription.id, 'takeover_needed', approvalId);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('stops offering it once the owner restarts the conversation', async () => {
    const { user, task } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(store.listPendingNotifications()).resolves.toHaveLength(1);
    // Resumed. The news was "it gave up and is waiting for you", and it is not waiting any more.
    await store.setTaskStatusForUser(user.id, task.id, 'queued');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('does not hand a device a stranding that happened before it was registered', async () => {
    const { user, task } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await database.query('UPDATE push_subscriptions SET created_at = NOW()', []);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });
});

/**
 * What this box can tell an owner who has never registered a device.
 *
 * Every branch of the candidate set starts `FROM push_subscriptions ps`, so the answer is nothing,
 * for every kind, for ever. That is not a bug in the query - it is what "content-free push" means,
 * and each branch is correctly bounded by the subscription's own age. It is the shape of the
 * product's only notification channel, and it is worth an executable statement of it, because the
 * owners it silences are the ones the feature exists for: an iPhone in a Safari tab has no
 * `PushManager` and so has no subscription to register, a browser that refused a self-signed
 * certificate runs no service worker, and a retired endpoint is deleted outright by the notifier
 * after a day of refusals - which removes the last subscription and, with it, every candidate.
 *
 * A second transport is what changes this answer. Whatever builds one must not extend the query
 * below, because the query cannot reach these rows: it has to select on the owner rather than on
 * the owner's devices, and carry its own delivery ledger, since `notification_deliveries` is keyed
 * by a subscription id that a mail transport does not have.
 */
describe('an owner with no subscribed device', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  /** Two live things the owner would want: an approval it is stopped on, and a notice it raised. */
  const waiting = async () => {
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Cloud',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'shell',
      sideEffect: 'external_consequential',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'awaiting_user');
    await store.createAgentNotification({
      userId: user.id,
      taskId: task.id,
      kind: 'agent_message',
      messageCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    return { user, task, approvalId };
  };

  it('is offered nothing at all, however much is waiting for them', async () => {
    await waiting();
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  /*
   * The other direction, so the case above is evidence about subscriptions rather than about a
   * fixture that never had anything to report. Same rows, one device, two notifications.
   */
  it('is offered all of it the moment one device is registered', async () => {
    const { user } = await waiting();
    await store.upsertPushSubscription({
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
    // Registered before the events it is being offered, which every branch requires.
    await database.query("UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '1 day'", []);
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind).sort())
    ).resolves.toEqual(['agent_message', 'approval_required']);
  });

  /*
   * The path that takes the channel away from an owner who did everything right. The notifier
   * deletes an endpoint that has refused every notification for a day (`sweep.ts`, the `exhausted`
   * arm), and deleting the row cascades the ledger with it - so the queue does not merely stop
   * draining, it stops existing, and the approval below is waiting for a person who will not be
   * told. Nothing here is wrong; there is simply no second place for it to go.
   */
  it('is offered nothing again once its last endpoint is retired', async () => {
    const { user } = await waiting();
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
    await database.query("UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '1 day'", []);
    await expect(store.listPendingNotifications()).resolves.toHaveLength(2);
    await expect(store.deletePushSubscriptionById(subscription.id)).resolves.toBe(true);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });
});
