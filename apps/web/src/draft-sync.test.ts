import { describe, expect, it, vi } from 'vitest';
import {
  DraftConflict,
  DraftSync,
  type DraftRecovery,
  type DraftStorage,
  type DraftWrite
} from './draft-sync';
import { openDraft, sealDraft } from './draft-storage';
import type { Draft } from './model';
const draft = (body: string, revision = 0): Draft => ({
  workspaceId: 'workspace',
  taskId: 'task',
  body,
  attachments: [],
  revision
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function memoryStorage() {
  const rows = new Map<string, DraftRecovery>();
  const storage: DraftStorage = {
    save: async (record) => {
      rows.set(record.id, structuredClone(record));
    },
    remove: async (id, version) => {
      if (!version || rows.get(id)?.version === version) rows.delete(id);
    }
  };
  return { rows, storage };
}
function harness(
  write: (input: DraftWrite) => Promise<{ revision: number; updatedAt: string }>,
  recovery?: DraftRecovery
) {
  const { rows, storage } = memoryStorage();
  if (recovery) rows.set(recovery.id, structuredClone(recovery));
  const onStatus = vi.fn(),
    onSynced = vi.fn();
  const sync = new DraftSync({
    draft: draft(''),
    write,
    storage,
    onStatus,
    onSynced,
    ...(recovery ? { recovery } : {})
  });
  return { sync, rows, onStatus, onSynced };
}
describe('durable draft synchronization', () => {
  it('persists the unanswered request and newer edits before a network call settles', async () => {
    const pending = deferred<{ revision: number; updatedAt: string }>();
    const write = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ revision: 2, updatedAt: 'later' });
    const h = harness(write);
    const first = h.sync.save(draft('first'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const second = h.sync.save(draft('second'));
    await vi.waitFor(() => {
      expect(h.rows.size).toBe(1);
      expect([...h.rows.values()][0]).toMatchObject({
        head: { draft: { body: 'first' } },
        latest: { body: 'second' }
      });
    });
    pending.resolve({ revision: 1, updatedAt: 'first' });
    await Promise.all([first, second]);
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      draft: { body: 'second' },
      expectedRevision: 1
    });
    expect(h.rows.size).toBe(0);
    expect(h.onSynced.mock.calls.at(-1)?.[0]).toMatchObject({ body: 'second', revision: 2 });
  });
  it('replays a committed but unacknowledged save after reload before applying a newer edit', async () => {
    const receipts = new Map<string, { revision: number; updatedAt: string }>();
    let revision = 0;
    let loseAck = true;
    const write = vi.fn(async (input: DraftWrite) => {
      const prior = receipts.get(input.key);
      if (prior) return prior;
      expect(input.expectedRevision).toBe(revision);
      const receipt = { revision: ++revision, updatedAt: 'now' };
      receipts.set(input.key, receipt);
      if (loseAck) {
        loseAck = false;
        throw new Error('connection closed after commit');
      }
      return receipt;
    });
    const before = harness(write);
    await expect(before.sync.save(draft('original'))).rejects.toThrow('after commit');
    const saved = [...before.rows.values()][0]!;
    expect(saved.head?.key).toBeTruthy();
    const after = harness(write, saved);
    await after.sync.save(draft('newer'));
    expect(revision).toBe(2);
    expect(write.mock.calls[0]?.[0].key).toBe(write.mock.calls[1]?.[0].key);
    expect(write.mock.calls[2]?.[0]).toMatchObject({
      expectedRevision: 1,
      draft: { body: 'newer' }
    });
    expect(after.rows.size).toBe(0);
  });
  it('retains both versions on conflict and changes the cloud only after the owner chooses', async () => {
    const server = draft('from another device', 7);
    const write = vi
      .fn<Parameters<typeof harness>[0]>()
      .mockRejectedValueOnce(new DraftConflict(server))
      .mockResolvedValue({ revision: 8, updatedAt: 'now' });
    const h = harness(write);
    await expect(h.sync.save(draft('my draft'))).rejects.toBeInstanceOf(DraftConflict);
    await expect(h.sync.save(draft('my newest draft'))).rejects.toBeInstanceOf(DraftConflict);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.sync.serverConflict).toEqual(server);
    const result = await h.sync.resolve('device');
    expect(result).toMatchObject({ body: 'my newest draft', revision: 8 });
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 7,
      draft: { body: 'my newest draft' }
    });
    expect(write.mock.calls[0]?.[0].key).not.toBe(write.mock.calls[1]?.[0].key);
  });
  it('choosing the server version never sends the local draft', async () => {
    const server = draft('cloud', 4);
    const write = vi.fn().mockRejectedValue(new DraftConflict(server));
    const h = harness(write);
    await expect(h.sync.save(draft('device'))).rejects.toBeInstanceOf(DraftConflict);
    expect(await h.sync.resolve('server')).toEqual(server);
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.rows.size).toBe(0);
  });
  it('recovers the sent payload when clearing its draft was interrupted', async () => {
    const write = vi.fn().mockRejectedValue(new Error('offline'));
    const before = harness(write);
    const sent = draft('sent but clearing not confirmed');
    const key = await before.sync.prepareSubmission(JSON.stringify({ prompt: sent.body }), sent);
    await expect(before.sync.finishSubmission(draft(''))).rejects.toThrow('offline');
    const saved = [...before.rows.values()][0]!;
    expect(saved.head?.draft.body).toBe('');
    const after = harness(write, saved);
    expect(after.sync.recoveredDraft?.body).toBe(sent.body);
    expect(after.sync.pendingSubmission?.key).toBe(key);
  });

  it('does not claim device durability or send a write when storage refuses it', async () => {
    const write = vi.fn();
    const status = vi.fn();
    const sync = new DraftSync({
      draft: draft(''),
      write,
      onStatus: status,
      onSynced: vi.fn(),
      storage: {
        save: async () => {
          throw new Error('quota');
        },
        remove: async () => undefined
      }
    });
    await expect(sync.save(draft('keep me'))).rejects.toThrow('quota');
    expect(write).not.toHaveBeenCalled();
    expect(status.mock.calls.at(-1)?.[0]).toBe('unsaved');
  });
  it('keeps the send key after reload without submitting work automatically', async () => {
    const write = vi.fn().mockResolvedValue({ revision: 1, updatedAt: 'now' });
    const h = harness(write);
    await h.sync.save(draft('send this'));
    const key = await h.sync.prepareSubmission('exact request', draft('send this'));
    const recovery = [...h.rows.values()][0]!;
    expect(recovery.submission?.key).toBe(key);
    const restored = harness(write, recovery);
    await restored.sync.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await restored.sync.prepareSubmission('exact request', draft('send this'))).toBe(key);
    await restored.sync.finishSubmission(draft(''));
    expect(restored.rows.size).toBe(0);
  });
  it('does not remove a source record changed by another editor', async () => {
    const h = harness(async () => {
      throw new Error('offline');
    });
    await expect(h.sync.save(draft('first'))).rejects.toThrow('offline');
    const source = [...h.rows.values()][0]!;
    const after = harness(async () => ({ revision: 1, updatedAt: 'now' }), source);
    after.rows.set(source.id, { ...source, version: 'new-editor', latest: draft('another tab') });
    await after.sync.flush();
    expect(after.rows.get(source.id)?.latest?.body).toBe('another tab');
  });
});
describe('encrypted device drafts', () => {
  it('seals content and binds ciphertext to its device, record and version', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    const record: DraftRecovery = {
      id: 'record',
      version: 'v1',
      revision: 0,
      updatedAt: 1,
      latest: draft('PRIVATE DRAFT')
    };
    const sealed = await sealDraft(record, key, 'owner/session');
    expect(JSON.stringify(sealed)).not.toContain('PRIVATE DRAFT');
    expect(await openDraft(sealed, key, 'owner/session')).toEqual(record);
    await expect(openDraft({ ...sealed, id: 'other' }, key, 'owner/session')).rejects.toThrow();
    await expect(
      openDraft({ ...sealed, version: 'other' }, key, 'owner/session')
    ).rejects.toThrow();
    await expect(openDraft(sealed, key, 'other/session')).rejects.toThrow();
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ]);
    await expect(openDraft(sealed, other, 'owner/session')).rejects.toThrow();
  });
});
