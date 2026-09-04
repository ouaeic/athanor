import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';

/**
 * The rows behind a share link, asked the questions the public route asks and the owner asks.
 *
 * The lookup is the one that matters: a revoked link, an expired link and a link that never
 * existed have to be one answer from one statement, because the route above turns that answer into
 * a 404 and must not be able to tell them apart. The rest is the owner's side - the list, the
 * badge count, revocation taking the bytes with it - and the cascade from the conversation.
 */
describe('share links in the store', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  const envelope = { v: 1, iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y2lwaGVy', aad: 'share:hash' };

  const seed = async () => {
    const user = await store.createUser({ username: 'lin', displayName: 'Lin' });
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
      titleCiphertext: { v: 1, iv: 'private-title', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    return { user, workspace, task };
  };

  const share = (
    seeded: Awaited<ReturnType<typeof seed>>,
    hash: string,
    expiresAt: Date | null = null
  ) =>
    store.createShare({
      userId: seeded.user.id,
      taskId: seeded.task.id,
      workspaceId: seeded.workspace.id,
      lookupHash: hash,
      envelope,
      manifest: [{ n: 0, sizeBytes: 5 }],
      snapshotBytes: 120,
      expiresAt,
      artifacts: [
        {
          n: 0,
          envelopeMeta: { v: 1, iv: 'aXY=', tag: 'dGFn', aad: `share:${hash}:artifact:0` },
          ciphertext: Buffer.from([1, 2, 3, 4, 5]),
          sizeBytes: 5
        }
      ]
    });

  it('finds a live link by its hash and nothing else', async () => {
    const seeded = await seed();
    const created = await share(seeded, 'hash-live');
    const found = await store.findLiveShareByHash('hash-live');
    expect(found?.id).toBe(created.id);
    expect(found?.envelope).toEqual(envelope);
    expect(found?.manifest).toEqual([{ n: 0, sizeBytes: 5 }]);
    await expect(store.findLiveShareByHash('hash-other')).resolves.toBeNull();
  });

  it('answers null for a revoked link, an expired link and a missing link alike', async () => {
    const seeded = await seed();
    const revoked = await share(seeded, 'hash-revoked');
    await store.revokeShare(seeded.user.id, revoked.id);
    await share(seeded, 'hash-expired', new Date(Date.now() - 1000));
    await share(seeded, 'hash-future', new Date(Date.now() + 60_000));
    await expect(store.findLiveShareByHash('hash-revoked')).resolves.toBeNull();
    await expect(store.findLiveShareByHash('hash-expired')).resolves.toBeNull();
    await expect(store.findLiveShareByHash('hash-missing')).resolves.toBeNull();
    await expect(store.findLiveShareByHash('hash-future')).resolves.not.toBeNull();
  });

  it('keeps the artifact bytes whole and hands them back by index', async () => {
    const seeded = await seed();
    const created = await share(seeded, 'hash-bytes');
    const artifact = await store.getShareArtifact(created.id, 0);
    expect(artifact?.ciphertext.equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true);
    expect(artifact?.envelopeMeta).toEqual({
      v: 1,
      iv: 'aXY=',
      tag: 'dGFn',
      aad: 'share:hash-bytes:artifact:0'
    });
    await expect(store.getShareArtifact(created.id, 1)).resolves.toBeNull();
    await expect(store.listShareArtifactEnvelopes(created.id)).resolves.toEqual([
      { n: 0, sizeBytes: 5, envelopeMeta: artifact!.envelopeMeta }
    ]);
  });

  it('counts a view without recording who viewed', async () => {
    const seeded = await seed();
    const created = await share(seeded, 'hash-views');
    expect(created.viewCount).toBe(0);
    expect(created.lastViewedAt).toBeNull();
    await store.recordView(created.id);
    await store.recordView(created.id);
    const after = await store.getShareForOwner(seeded.user.id, created.id);
    expect(after?.viewCount).toBe(2);
    expect(after?.lastViewedAt).not.toBeNull();
    // The whole row, so a column that recorded an address or an agent string would show up here.
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='task_shares'`
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'created_at',
      'envelope',
      'expires_at',
      'id',
      'last_viewed_at',
      'lookup_hash',
      'manifest',
      'revoked_at',
      'snapshot_bytes',
      'task_id',
      'updated_at',
      'user_id',
      'version',
      'view_count',
      'workspace_id'
    ]);
  });

  it('revokes one link and takes its bytes, and revokes all of them at once', async () => {
    const seeded = await seed();
    const first = await share(seeded, 'hash-one');
    const second = await share(seeded, 'hash-two');
    const stranger = await store.createUser({ username: 'kai', displayName: 'Kai' });
    // Somebody else cannot revoke it, and the answer is the same as for a link that does not exist.
    await expect(store.revokeShare(stranger.id, first.id)).resolves.toBe(false);
    await expect(store.revokeShare(seeded.user.id, first.id)).resolves.toBe(true);
    await expect(store.revokeShare(seeded.user.id, first.id)).resolves.toBe(false);
    await expect(store.getShareArtifact(first.id, 0)).resolves.toBeNull();
    await expect(store.getShareArtifact(second.id, 0)).resolves.not.toBeNull();
    await expect(store.countSharesForTask(seeded.task.id)).resolves.toBe(1);
    await expect(store.revokeAllShares(seeded.user.id, seeded.task.id)).resolves.toBe(1);
    await expect(store.countSharesForTask(seeded.task.id)).resolves.toBe(0);
    const listed = await store.listSharesForTask(seeded.user.id, seeded.task.id);
    expect(listed.map((row) => row.revokedAt !== null)).toEqual([true, true]);
    expect(await store.listShares(seeded.user.id)).toHaveLength(2);
    expect(await store.listShares(stranger.id)).toHaveLength(0);
  });

  it('carries the live count on the task record', async () => {
    const seeded = await seed();
    expect((await store.getTask(seeded.user.id, seeded.task.id))?.shareCount).toBe(0);
    await share(seeded, 'hash-count-a');
    await share(seeded, 'hash-count-b', new Date(Date.now() - 1000));
    expect((await store.getTask(seeded.user.id, seeded.task.id))?.shareCount).toBe(1);
  });

  it('deletes every share row and artifact row with the conversation', async () => {
    const seeded = await seed();
    const created = await share(seeded, 'hash-cascade');
    await expect(store.deleteTask(seeded.user.id, seeded.task.id)).resolves.toBe(true);
    await expect(store.findLiveShareByHash('hash-cascade')).resolves.toBeNull();
    await expect(store.getShareForOwner(seeded.user.id, created.id)).resolves.toBeNull();
    const artifacts = await database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM task_share_artifacts WHERE share_id=$1',
      [created.id]
    );
    expect(Number(artifacts.rows[0]!.count)).toBe(0);
  });

  it('sweeps a closed link a month after it closed and not before', async () => {
    const seeded = await seed();
    const revoked = await share(seeded, 'hash-old-revoked');
    await store.revokeShare(seeded.user.id, revoked.id);
    const expired = await share(seeded, 'hash-old-expired', new Date(Date.now() - 1000));
    const fresh = await share(seeded, 'hash-fresh');
    await store.cleanupExpired();
    expect((await store.listShares(seeded.user.id)).map((row) => row.lookupHash).sort()).toEqual([
      'hash-fresh',
      'hash-old-expired',
      'hash-old-revoked'
    ]);
    await database.query(
      `UPDATE task_shares SET revoked_at = NOW() - INTERVAL '31 days' WHERE id=$1`,
      [revoked.id]
    );
    await database.query(
      `UPDATE task_shares SET expires_at = NOW() - INTERVAL '31 days' WHERE id=$1`,
      [expired.id]
    );
    await store.cleanupExpired();
    expect((await store.listShares(seeded.user.id)).map((row) => row.id)).toEqual([fresh.id]);
  });
});
