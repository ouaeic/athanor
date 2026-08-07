import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspaceCheckpoints,
  parseInstalledPackages,
  type CheckpointConfig,
  type CheckpointRunner
} from './checkpoints.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const WORKSPACE_ID = '018f3dd3-899f-7e3d-8d92-8fdbf65f8301';

const workspace = async (): Promise<{ workspaceRoot: string; root: string }> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-checkpoints-'));
  temporary.push(workspaceRoot);
  const root = path.join(workspaceRoot, WORKSPACE_ID);
  for (const relative of ['workspace', '.athanor/artifacts', '.athanor/browser'])
    await mkdir(path.join(root, relative), { recursive: true });
  return { workspaceRoot, root };
};

const config = (
  workspaceRoot: string,
  overrides: Partial<CheckpointConfig> = {}
): CheckpointConfig => ({
  workspaceRoot,
  btrfsExecutable: '/nonexistent/btrfs',
  zfsExecutable: '/nonexistent/zfs',
  packageManifestPath: path.join(workspaceRoot, 'dpkg-status'),
  includeBrowserProfile: false,
  retainTurns: 3,
  retainDailyDays: 14,
  maxFiles: 250_000,
  maxFileBytes: 2 * 1024 ** 3,
  ...overrides
});

const storeSize = async (workspaceRoot: string): Promise<number> => {
  let total = 0;
  const pending = [path.join(workspaceRoot, '.athanor-checkpoints', WORKSPACE_ID, 'blobs')];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else total += (await stat(child)).size;
    }
  }
  return total;
};

const blobCount = async (workspaceRoot: string): Promise<number> => {
  let count = 0;
  const blobs = path.join(workspaceRoot, '.athanor-checkpoints', WORKSPACE_ID, 'blobs');
  for (const shard of await readdir(blobs).catch(() => []))
    count += (await readdir(path.join(blobs, shard))).length;
  return count;
};

describe('turn checkpoints', () => {
  it('previews exactly what a restore would change, then changes exactly that', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'report.md'), 'first draft\n');
    await writeFile(path.join(root, 'workspace', 'keep.txt'), 'untouched\n');
    await mkdir(path.join(root, 'workspace', 'src'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'src', 'old.ts'), 'export const a = 1;\n');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.mechanism).toBe('content');
    expect(created.fileCount).toBe(3);

    await writeFile(path.join(root, 'workspace', 'report.md'), 'rewritten by the agent\n');
    await writeFile(path.join(root, 'workspace', 'stray.log'), 'created by the agent\n');
    await rm(path.join(root, 'workspace', 'src', 'old.ts'));

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.added.map((change) => change.path)).toEqual(['workspace/stray.log']);
    expect(preview.modified.map((change) => change.path)).toEqual(['workspace/report.md']);
    expect(preview.deleted.map((change) => change.path)).toEqual(['workspace/src/old.ts']);
    expect(preview.modifiedCount).toBe(1);

    const restored = await checkpoints.restore(WORKSPACE_ID, root, created.id);
    expect(restored.restoredFileCount).toBe(2);
    expect(restored.removedFileCount).toBe(1);
    await expect(readFile(path.join(root, 'workspace', 'report.md'), 'utf8')).resolves.toBe(
      'first draft\n'
    );
    await expect(readFile(path.join(root, 'workspace', 'src', 'old.ts'), 'utf8')).resolves.toBe(
      'export const a = 1;\n'
    );
    await expect(readFile(path.join(root, 'workspace', 'keep.txt'), 'utf8')).resolves.toBe(
      'untouched\n'
    );
    await expect(stat(path.join(root, 'workspace', 'stray.log'))).rejects.toThrow();

    // Nothing left to differ, and a checkpoint taken straight after a restore stores no bytes.
    const after = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect([after.addedCount, after.modifiedCount, after.deletedCount]).toEqual([0, 0, 0]);
  });

  it('leaves the browser profile alone, so a rewind does not sign the owner out', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=before\n');
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=after-login\n');
    await writeFile(path.join(root, '.athanor', 'browser', 'Login Data'), 'signed in\n');
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'after\n');

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.added.concat(preview.modified, preview.deleted).map((c) => c.path)).toEqual([
      'workspace/note.txt'
    ]);

    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=after-login\n'
    );
    await expect(
      readFile(path.join(root, '.athanor', 'browser', 'Login Data'), 'utf8')
    ).resolves.toBe('signed in\n');
    await expect(readFile(path.join(root, 'workspace', 'note.txt'), 'utf8')).resolves.toBe(
      'before\n'
    );
  });

  it('includes the browser profile only when the host is configured to', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { includeBrowserProfile: true })
    );
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=after\n');

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.modified.map((change) => change.path)).toEqual(['.athanor/browser/Cookies']);
  });

  it('costs no bytes for an unchanged turn and stores one copy of repeated content', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    const body = randomBytes(256 * 1024);
    await writeFile(path.join(root, 'workspace', 'dataset.bin'), body);

    const first = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(first.changedFileCount).toBe(1);
    expect(first.storedBytes).toBe(body.length);

    const second = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(second.changedFileCount).toBe(0);
    expect(second.storedBytes).toBe(0);

    // A second file with content the store already holds is deduplicated, not copied again.
    await writeFile(path.join(root, 'workspace', 'copy.bin'), body);
    const third = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(third.changedFileCount).toBe(1);
    expect(third.storedBytes).toBe(0);
    expect(await storeSize(workspaceRoot)).toBe(body.length);
  });

  it('survives a turn whose new files hold identical content, which share one blob', async () => {
    // The copies run in parallel and a blob is named by its content, so duplicates that are new in
    // the same turn all reach for the one destination at once. They used to share a scratch name
    // too: the second writer deleted the first one's finished copy, the first one's rename failed,
    // and the turn ran with no undo point because the workspace happened to contain two identical
    // files. Sixteen of them, which is the width of the copy pass.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    const body = randomBytes(64 * 1024);
    for (let index = 0; index < 16; index += 1)
      await writeFile(path.join(root, 'workspace', `copy-${index}.bin`), body);

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.changedFileCount).toBe(16);
    expect(await blobCount(workspaceRoot)).toBe(1);
    expect(await storeSize(workspaceRoot)).toBe(body.length);
    // The point of the checkpoint: it can still put the workspace back.
    await rm(path.join(root, 'workspace', 'copy-7.bin'));
    await expect(checkpoints.restore(WORKSPACE_ID, root, created.id)).resolves.toMatchObject({
      restoredFileCount: 1
    });
  });

  it('runs one at a time per workspace, so two concurrent turns cannot tear a checkpoint', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'dataset.bin'), randomBytes(128 * 1024));

    // Two tasks can share a workspace. Interleaved, the second would find no manifest to compare
    // against and re-hash the whole tree - and its content collection could delete blobs the first
    // had written but not yet named. Sequenced, the second sees a settled store and hashes nothing.
    const [first, second] = await Promise.all([
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID(), turn: 0 }),
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID(), turn: 1 })
    ]);
    expect(first.changedFileCount).toBe(1);
    expect(second.changedFileCount).toBe(0);
    expect(await blobCount(workspaceRoot)).toBe(1);
    await expect(checkpoints.restore(WORKSPACE_ID, root, first.id)).resolves.toMatchObject({
      restoredFileCount: 0
    });
  });

  it('names the packages a rewind will not uninstall', async () => {
    const { workspaceRoot, root } = await workspace();
    const status = path.join(workspaceRoot, 'dpkg-status');
    await writeFile(
      status,
      'Package: curl\nStatus: install ok installed\nVersion: 8.5.0\n\nPackage: ripgrep\nStatus: deinstall ok config-files\nVersion: 14.0.0\n\n'
    );
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });

    await writeFile(
      status,
      'Package: curl\nStatus: install ok installed\nVersion: 8.6.0\n\nPackage: postgresql\nStatus: install ok installed\nVersion: 16.2\n\n'
    );
    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.packagesInstalled).toEqual([
      { name: 'curl', version: '8.6.0', previousVersion: '8.5.0' },
      { name: 'postgresql', version: '16.2' }
    ]);
    expect(preview.packagesRemoved).toEqual([]);
  });

  it('reads a package database once and reuses it while it is unchanged', () => {
    const packages = parseInstalledPackages(
      'Package: curl\nStatus: install ok installed\nVersion: 8.5.0\n\n' +
        'Package: half-installed\nStatus: install ok half-configured\nVersion: 1.0\n\n' +
        'Package: last\nStatus: install ok installed\nVersion: 2.0'
    );
    expect(packages).toEqual([
      ['curl', '8.5.0'],
      ['last', '2.0']
    ]);
  });

  it('records a file too large to hold instead of pretending it is covered', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { maxFileBytes: 1024 }));
    await writeFile(path.join(root, 'workspace', 'disk.img'), randomBytes(4096));
    await writeFile(path.join(root, 'workspace', 'small.txt'), 'covered\n');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.uncoveredFileCount).toBe(1);
    await writeFile(path.join(root, 'workspace', 'disk.img'), randomBytes(4096));

    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    expect(preview.uncovered.map((change) => change.path)).toEqual(['workspace/disk.img']);
    expect(preview.added).toEqual([]);
    expect(preview.modified).toEqual([]);

    const before = await readFile(path.join(root, 'workspace', 'disk.img'));
    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, 'workspace', 'disk.img'))).resolves.toEqual(before);
  });

  it('keeps the recent turns and collects the content nothing names any more', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { retainTurns: 2 }));
    const ids: string[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${turn}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, {
        checkpointId: randomUUID(),
        turn
      });
      ids.push(created.id);
      await checkpoints.prune(WORKSPACE_ID);
    }
    const kept = (await checkpoints.list(WORKSPACE_ID)).map((entry) => entry.id);
    expect(kept).toEqual([ids[9], ids[8]]);
    // Ten revisions were written; only what the survivors name is still on disk.
    expect(await blobCount(workspaceRoot)).toBe(2);
  });

  it('leaves blobs alone when a manifest cannot be read, rather than deleting what it cannot see', async () => {
    // The silent loss this locks out: an unreadable manifest used to be skipped, which said "this
    // checkpoint names no content", and the sweep then deleted every blob only it was holding. Its
    // .json survived, so the checkpoint stayed in the list and was still offered - and the owner
    // found out when the restore they were relying on could not find its content. Keeping
    // unreferenced blobs costs disk. Deleting referenced ones costs them the undo.
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot, { retainTurns: 2 }));
    const directory = path.join(workspaceRoot, '.athanor-checkpoints', WORKSPACE_ID);
    const ids: string[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${turn}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, {
        checkpointId: randomUUID(),
        turn
      });
      ids.push(created.id);
      // Corrupt a survivor's manifest just before the sweep that would collect: not absent, which
      // means an already-incomplete checkpoint, but present and unreadable - a truncated write, a
      // bad read, a half-flushed file.
      if (turn === 9)
        await writeFile(path.join(directory, `${ids[8]!}.manifest.json.gz`), 'not gzip');
      await checkpoints.prune(WORKSPACE_ID);
    }
    // The surviving checkpoint's content is still there. Without the fix the sweep kept only what
    // the one readable manifest named.
    expect(await blobCount(workspaceRoot)).toBeGreaterThan(1);
    // And pruning still did its job rather than failing outright.
    expect((await checkpoints.list(WORKSPACE_ID)).map((entry) => entry.id)).toEqual([
      ids[9],
      ids[8]
    ]);
  });

  it('keeps one checkpoint a day once the recent turns have rolled past', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { retainTurns: 2, retainDailyDays: 30 })
    );
    const directory = path.join(workspaceRoot, '.athanor-checkpoints', WORKSPACE_ID);
    const made: string[] = [];
    const day = 24 * 60 * 60 * 1000;
    for (let index = 0; index < 8; index += 1) {
      await writeFile(path.join(root, 'workspace', 'draft.md'), `revision ${index}\n`);
      const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
      // Two checkpoints a day over the last four days, aged in place: the only way to exercise a
      // rule whose whole point is what happens once a day has passed. Anchored at midday UTC
      // because the rule buckets by UTC date - measured from Date.now(), the second checkpoint of
      // each pair lands in the next bucket whenever the suite runs near a UTC midnight.
      const noon = new Date();
      noon.setUTCHours(12, 0, 0, 0);
      const at = new Date(
        noon.getTime() - (3 - Math.floor(index / 2)) * day + (index % 2) * 60 * 60 * 1000
      ).toISOString();
      const metaPath = path.join(directory, `${created.id}.json`);
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { createdAt: string };
      await writeFile(metaPath, JSON.stringify({ ...meta, createdAt: at }));
      made.push(created.id);
    }
    await checkpoints.prune(WORKSPACE_ID);

    const kept = await checkpoints.list(WORKSPACE_ID);
    // The two most recent, and then the newest of each earlier day.
    expect(kept.map((entry) => entry.id)).toEqual([made[7], made[6], made[5], made[3], made[1]]);
  });

  it('uses a btrfs snapshot when the host proves it can create and delete one', async () => {
    const { workspaceRoot, root } = await workspace();
    const calls: string[][] = [];
    const run: CheckpointRunner = async (executable, args) => {
      calls.push([executable, ...args]);
      if (executable !== '/usr/bin/btrfs') throw new Error('not installed');
      if (args[0] === 'subvolume' && args[1] === 'show') return '';
      if (args[0] === 'subvolume' && args[1] === 'snapshot') {
        await cp(args[3]!, args[4]!, { recursive: true });
        return '';
      }
      if (args[0] === 'subvolume' && args[1] === 'delete') {
        await rm(args[2]!, { recursive: true, force: true });
        return '';
      }
      throw new Error(`unexpected btrfs call ${args.join(' ')}`);
    };
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { btrfsExecutable: '/usr/bin/btrfs' }),
      run
    );
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'before\n');
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=before\n');

    expect(await checkpoints.mechanism(root)).toBe('btrfs');
    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    expect(created.mechanism).toBe('btrfs');
    // A filesystem snapshot does not walk the tree, which is the whole reason it is instant.
    expect(created.fileCount).toBeNull();
    expect(calls.some((call) => call.includes('snapshot') && call.includes('-r'))).toBe(true);

    await writeFile(path.join(root, 'workspace', 'note.txt'), 'after\n');
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=after\n');
    const preview = await checkpoints.preview(WORKSPACE_ID, root, created.id);
    // The snapshot holds the profile too; the exclusion still keeps it out of the rewind.
    expect(preview.modified.map((change) => change.path)).toEqual(['workspace/note.txt']);

    await checkpoints.restore(WORKSPACE_ID, root, created.id);
    await expect(readFile(path.join(root, 'workspace', 'note.txt'), 'utf8')).resolves.toBe(
      'before\n'
    );
    await expect(readFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=after\n'
    );
  });

  it('refuses a snapshot mechanism it cannot also delete', async () => {
    const { workspaceRoot, root } = await workspace();
    const run: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/bin/btrfs') throw new Error('not installed');
      if (args[0] === 'subvolume' && args[1] === 'show') return '';
      if (args[0] === 'subvolume' && args[1] === 'snapshot') {
        await mkdir(args[4]!, { recursive: true });
        return '';
      }
      // Exactly what a btrfs mounted without user_subvol_rm_allowed does to an unprivileged user.
      throw new Error('ERROR: Could not destroy subvolume: Operation not permitted');
    };
    const checkpoints = new WorkspaceCheckpoints(
      config(workspaceRoot, { btrfsExecutable: '/usr/bin/btrfs' }),
      run
    );
    expect(await checkpoints.mechanism(root)).toBe('content');
  });

  it('uses a ZFS snapshot only when the workspace is the dataset itself', async () => {
    const { workspaceRoot, root } = await workspace();
    const higher: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/sbin/zfs') throw new Error('not installed');
      if (args[0] === 'list') return `tank/athanor\t${workspaceRoot}\n`;
      throw new Error('unexpected');
    };
    expect(
      await new WorkspaceCheckpoints(
        config(workspaceRoot, { zfsExecutable: '/usr/sbin/zfs' }),
        higher
      ).mechanism(root)
    ).toBe('content');

    const exact: CheckpointRunner = async (executable, args) => {
      if (executable !== '/usr/sbin/zfs') throw new Error('not installed');
      if (args[0] === 'list') return `tank/athanor/workspace\t${root}\n`;
      if (args[0] === 'snapshot' || args[0] === 'destroy') return '';
      throw new Error('unexpected');
    };
    expect(
      await new WorkspaceCheckpoints(
        config(workspaceRoot, { zfsExecutable: '/usr/sbin/zfs' }),
        exact
      ).mechanism(root)
    ).toBe('zfs');
  });

  it('rejects identifiers and manifest paths that would leave the workspace', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await expect(
      checkpoints.create(WORKSPACE_ID, root, { checkpointId: '../escape' })
    ).rejects.toThrow('Invalid checkpoint ID');
    await expect(checkpoints.list('../outside')).rejects.toThrow('Invalid workspace ID');

    const created = await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    const manifest = path.join(
      workspaceRoot,
      '.athanor-checkpoints',
      WORKSPACE_ID,
      `${created.id}.manifest.json.gz`
    );
    await writeFile(
      manifest,
      gzipSync(
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: [['../../../etc/passwd', 0o644, 3, 1, 'a'.repeat(64)]],
            directories: [],
            links: [],
            uncovered: []
          })
        )
      )
    );
    await expect(checkpoints.restore(WORKSPACE_ID, root, created.id)).rejects.toThrow(
      'workspace-relative'
    );
  });

  it('forgets a workspace completely when it is deleted', async () => {
    const { workspaceRoot, root } = await workspace();
    const checkpoints = new WorkspaceCheckpoints(config(workspaceRoot));
    await writeFile(path.join(root, 'workspace', 'note.txt'), 'content\n');
    await checkpoints.create(WORKSPACE_ID, root, { checkpointId: randomUUID() });
    await checkpoints.deleteAll(WORKSPACE_ID);
    expect(await checkpoints.list(WORKSPACE_ID)).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, '.athanor-checkpoints', WORKSPACE_ID))
    ).rejects.toThrow();
  });
});
