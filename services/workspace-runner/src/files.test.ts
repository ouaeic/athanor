import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertOpenedInPlace,
  assertUserDataPath,
  clearStagedUploads,
  createWorkspaceFolder,
  ensureWorkspace,
  listFiles,
  readWorkspaceFile,
  readWorkspaceFileLines,
  renameWorkspaceEntry,
  resolveInside,
  stageUserFileForUpload,
  workspacePath,
  workspaceUsage,
  writeWorkspaceFile,
  WorkspaceFileError
} from './files.js';

describe('workspace files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('rejects path traversal', () => {
    expect(() => resolveInside(root, '../escape')).toThrow('escapes workspace');
    expect(() => resolveInside(root, '..')).toThrow('escapes workspace');
    expect(() => resolveInside(root, 'workspace/../../escape')).toThrow('escapes workspace');
    expect(() => workspacePath(root, '..')).toThrow('Invalid workspace ID');
    expect(() => workspacePath(root, 'release-drill')).toThrow('Invalid workspace ID');
    expect(workspacePath(root, '00000000-0000-4000-8000-000000000001')).toBe(
      path.join(root, '00000000-0000-4000-8000-000000000001')
    );
  });

  /*
   * A step upwards is `..` followed by a separator, or `..` alone. It is not "the name begins with
   * two dots": `..gitignore` and `..backup` are ordinary files inside the tree, and refusing them
   * as an escape answered the agent with an accusation instead of a correction - which is exactly
   * the failure the bare-name fold below exists to stop, arriving through the check that runs
   * before it. The agent creates `workspace/..backup/` from a shell command and then cannot list it.
   */
  it('treats a name that merely starts with two dots as a name, not as a step upwards', () => {
    expect(resolveInside(root, '..gitignore')).toBe(path.join(root, '..gitignore'));
    expect(resolveInside(root, 'workspace/..backup')).toBe(
      path.join(root, 'workspace', '..backup')
    );
    expect(assertUserDataPath(root, '..backup')).toBe(path.join('workspace', '..backup'));
    expect(assertUserDataPath(root, 'workspace/..gitignore')).toBe(
      path.join('workspace', '..gitignore')
    );
  });

  it('exposes user files and artifacts without exposing the guest system or credentials', () => {
    expect(assertUserDataPath(root, 'workspace/project/file.txt')).toBe(
      'workspace/project/file.txt'
    );
    expect(assertUserDataPath(root, '.athanor/artifacts/result.png')).toBe(
      '.athanor/artifacts/result.png'
    );
    expect(() => assertUserDataPath(root, '/etc/shadow')).toThrow('escapes workspace');
    expect(() => assertUserDataPath(root, '.athanor/browser/Cookies')).toThrow(
      'Only workspace files'
    );
    expect(() => assertUserDataPath(root, '.config/gh/hosts.yml')).toThrow('Only workspace files');
  });

  /*
   * Commands run in `workspace/`, so a bare name has to mean there and not in the container above
   * it. It used to mean the container, which is unwritable, and the agent was told only that the
   * path was wrong - so it burned turns guessing prefixes. The refusals above are the other half:
   * a name that reaches for the container's own directories is still answered, not redirected.
   */
  it('reads a bare name from the directory commands actually run in', () => {
    expect(assertUserDataPath(root, 'machine.md')).toBe(path.join('workspace', 'machine.md'));
    expect(assertUserDataPath(root, 'notes/today.md')).toBe(
      path.join('workspace', 'notes', 'today.md')
    );
    expect(assertUserDataPath(root, '.')).toBe('workspace');
    expect(assertUserDataPath(root)).toBe('workspace');
    // Unchanged: an explicit root still means itself rather than a copy nested under workspace.
    expect(assertUserDataPath(root, 'workspace/machine.md')).toBe(
      path.join('workspace', 'machine.md')
    );
    expect(() => assertUserDataPath(root, 'workspace/../.athanor/browser/Cookies')).toThrow(
      'Only workspace files'
    );
  });

  /*
   * The file browser had nothing to print on a folder row and printed the word "Folder" - beside a
   * folder icon - because `lstat` on a directory reports the size of the directory record rather
   * than of what is in it. The count is the one honest thing a folder can say about itself, and it
   * is what the row now shows next to when the folder last changed.
   */
  it('counts what is in a folder, and reports no size for one', async () => {
    await mkdir(path.join(root, 'workspace', 'reports'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'reports', 'q1.csv'), 'a,b\n');
    await writeFile(path.join(root, 'workspace', 'reports', 'q2.csv'), 'a,b\n');
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'hello');
    const entries = (await listFiles(root, 'workspace')) as {
      name: string;
      type: string;
      itemCount?: number;
      modifiedAt: string;
    }[];
    const folder = entries.find((entry) => entry.name === 'reports');
    const file = entries.find((entry) => entry.name === 'notes.md');
    expect(folder).toMatchObject({ type: 'directory', itemCount: 2 });
    // Files carry no count at all, so nothing downstream can mistake one for a size.
    expect(file?.itemCount).toBeUndefined();
    expect(Date.parse(folder?.modifiedAt ?? '')).not.toBeNaN();
  });

  /* A folder the listing cannot read still appears - the row says less rather than the whole
     listing failing on one directory the agent's account was denied. */
  it('leaves an unreadable folder without a count instead of failing the listing', async () => {
    await mkdir(path.join(root, 'workspace', 'locked'));
    await chmod(path.join(root, 'workspace', 'locked'), 0o000);
    try {
      const entries = (await listFiles(root, 'workspace')) as {
        name: string;
        itemCount?: number;
      }[];
      const locked = entries.find((entry) => entry.name === 'locked');
      expect(locked).toBeDefined();
      // Running as root reads it anyway, which is a legitimate outcome rather than a failure.
      expect(locked?.itemCount === undefined || locked?.itemCount === 0).toBe(true);
    } finally {
      await chmod(path.join(root, 'workspace', 'locked'), 0o700);
    }
  });

  it('writes inside the workspace, leaving nothing of a longer earlier version', async () => {
    const result = await writeWorkspaceFile(
      root,
      'workspace/result.txt',
      Buffer.from('the long first draft'),
      100
    );
    expect(result.sizeBytes).toBe(20);
    // The descriptor is opened without O_TRUNC so a raced path can be refused before anything is
    // destroyed, which makes the truncation this file's own job rather than the kernel's.
    await writeWorkspaceFile(root, 'workspace/result.txt', Buffer.from('ok'), 100);
    expect(await readFile(path.join(root, 'workspace', 'result.txt'), 'utf8')).toBe('ok');
  });

  /*
   * A compare-and-swap write must land the bytes it was given and nothing else.
   *
   * `handle.writeFile` writes at the descriptor's current position, and reading the old content to
   * check the hash leaves that position at the end of the file - so every write that claimed a hash
   * produced the old file's length in zero bytes followed by the new content. Both callers that
   * claim one are the ones that matter: the owner saving in the file browser, and every `file_patch`
   * since the patch path started claiming its read. Nothing caught it because a file with a hole in
   * front of it still contains every string a test looked for, so this one weighs the file.
   */
  it('replaces the file with exactly the bytes it was given, hash claimed or not', async () => {
    await writeWorkspaceFile(root, 'workspace/notes.md', Buffer.from('the long first draft'), 100);
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 100);
    await writeWorkspaceFile(root, 'workspace/notes.md', Buffer.from('short'), 100, read.sha256);
    const after = await readFile(path.join(root, 'workspace', 'notes.md'));
    expect(after.length).toBe(5);
    expect(after.toString('utf8')).toBe('short');
  });

  it('hands the browser only files the user could already see in the file browser', async () => {
    await writeWorkspaceFile(root, 'workspace/cv.pdf', Buffer.from('cv'), 10);
    const staged = await stageUserFileForUpload(root, 'workspace/cv.pdf', 1024);
    // The name the site is told, and the bytes, are the file's own.
    expect(path.basename(staged)).toBe('cv.pdf');
    expect(await readFile(staged, 'utf8')).toBe('cv');
    // The browser opens this name when the form is submitted, so no part of it may be a name the
    // agent's account can repoint: the copy sits under the runner-only half of the workspace.
    expect(staged.startsWith(path.join(root, '.athanor', 'uploads') + path.sep)).toBe(true);
    expect(path.relative(root, staged).startsWith('workspace')).toBe(false);
    expect((await lstat(path.dirname(staged))).mode & 0o077).toBe(0);

    // An upload must never become a way to read the host or the browser profile.
    await expect(stageUserFileForUpload(root, '../../../etc/passwd', 1024)).rejects.toThrow(
      'escapes workspace'
    );
    await expect(stageUserFileForUpload(root, '/etc/passwd', 1024)).rejects.toThrow(
      'escapes workspace'
    );
    await expect(stageUserFileForUpload(root, '.athanor/browser/Cookies', 1024)).rejects.toThrow(
      'Only workspace files'
    );
    await expect(stageUserFileForUpload(root, 'workspace', 1024)).rejects.toThrow(
      'not a regular file'
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'athanor-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside');
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        stageUserFileForUpload(root, 'workspace/escape/secret.txt', 1024)
      ).rejects.toThrow('Symbolic links are not allowed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    await clearStagedUploads(root);
    await expect(stat(path.join(root, '.athanor', 'uploads'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('refuses a descriptor the path no longer names', async () => {
    // The symbolic-link walk and the kernel's own resolution are two separate answers to the same
    // question, and between them the agent's account can turn a directory it owns into a link into
    // `.athanor`. An open that resolved through such a component hands back a descriptor for a
    // file the path does not name - which is exactly the second case here.
    await writeWorkspaceFile(root, 'workspace/mine.md', Buffer.from('mine'), 100);
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=live');
    const handle = await open(path.join(root, 'workspace', 'mine.md'), 'r');
    try {
      await expect(
        assertOpenedInPlace(root, path.join(root, 'workspace', 'mine.md'), handle)
      ).resolves.toBeUndefined();
      await expect(
        assertOpenedInPlace(root, path.join(root, '.athanor', 'browser', 'Cookies'), handle)
      ).rejects.toThrow('changed while it was being opened');
    } finally {
      await handle.close();
    }
  });

  it('rejects symbolic-link escapes for reads and writes', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'athanor-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'outside');
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        writeWorkspaceFile(root, 'workspace/escape/changed.txt', Buffer.from('no'), 10)
      ).rejects.toThrow('Symbolic links are not allowed');
      await expect(readWorkspaceFile(root, 'workspace/escape/secret.txt', 100)).rejects.toThrow(
        'Symbolic links are not allowed'
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('a whole-file write that claims what it is replacing', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  /*
   * `file_write` is a read-modify-write with the read done in an earlier step, and at least three
   * writers share this tree: the agent's own shell, a second worker slot, and the owner in the file
   * browser. A whole-file write does not fail on a concurrent change - it silently discards it.
   */
  it('refuses when the file moved on after it was read', async () => {
    const target = path.join(root, 'workspace', 'notes.md');
    await writeFile(target, 'the version that was read\n');
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 1_000_000);

    // Somebody else writes between the read and the write.
    await writeFile(target, 'a change made by the owner in the file browser\n');

    await expect(
      writeWorkspaceFile(
        root,
        'workspace/notes.md',
        Buffer.from('agent rewrite\n'),
        1_000_000,
        read.sha256
      )
    ).rejects.toThrow(/changed after you read it/);
    // And the other writer's change is still there.
    expect(await readFile(target, 'utf8')).toContain('file browser');
  });

  it('writes when the claim still holds, and when nothing is claimed at all', async () => {
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'original\n');
    const read = await readWorkspaceFile(root, 'workspace/notes.md', 1_000_000);
    await expect(
      writeWorkspaceFile(
        root,
        'workspace/notes.md',
        Buffer.from('rewritten\n'),
        1_000_000,
        read.sha256
      )
    ).resolves.toMatchObject({ sizeBytes: 10 });

    // No claim: a first write, or a write to something this turn never read. Demanding a hash
    // everywhere would refuse every file this computer creates.
    await expect(
      writeWorkspaceFile(root, 'workspace/new.md', Buffer.from('fresh\n'), 1_000_000)
    ).resolves.toMatchObject({ sizeBytes: 6 });
  });
});

describe('reading a window of a file', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  /*
   * `file_read` asks for a few hundred lines. It used to be answered by reading the whole file:
   * against the 2 GiB ceiling the installer sets, one look at a database dump buffered a gigabyte
   * inside a service the unit caps at 80% of host memory, and the OOM killer takes the runner down
   * with every other tool running on it. What a read costs must follow what was asked for.
   */
  it('reads a window without pulling the rest of the file into memory', async () => {
    const line = `${'x'.repeat(999)}\n`;
    // 40 MB: small enough to write quickly, large enough that buffering it would show.
    const lines = 40_000;
    await writeFile(path.join(root, 'workspace', 'huge.log'), line.repeat(lines));

    const before = process.memoryUsage().heapUsed;
    const window = await readWorkspaceFileLines(root, 'workspace/huge.log', {
      startLine: 10,
      endLine: 14,
      maxBytes: 1_000_000
    });
    const grew = process.memoryUsage().heapUsed - before;

    expect(window.content.toString('utf8').split('\n')).toHaveLength(5);
    expect(window.startLine).toBe(10);
    expect(window.endLine).toBe(14);
    expect(window.sizeBytes).toBe(lines * 1000);
    // Stopped early, so it cannot know the total without reading what it exists to avoid.
    expect(window.totalLines).toBeUndefined();
    expect(window.nextStartLine).toBe(15);
    // The whole file is 40 MB; a read of five lines must not have cost anything like it.
    expect(grew).toBeLessThan(8 * 1024 * 1024);
  });

  it('reports the total only when it actually reached the end', async () => {
    await writeFile(path.join(root, 'workspace', 'small.txt'), 'one\ntwo\nthree');
    const all = await readWorkspaceFileLines(root, 'workspace/small.txt', {
      startLine: 1,
      endLine: 100,
      maxBytes: 1_000_000
    });
    expect(all.content.toString('utf8')).toBe('one\ntwo\nthree');
    expect(all.totalLines).toBe(3);
    expect(all.nextStartLine).toBeUndefined();
    expect(all.truncated).toBe(false);
  });

  it('stops at maxBytes and says where to continue', async () => {
    await writeFile(
      path.join(root, 'workspace', 'wide.txt'),
      Array.from({ length: 50 }, (_, index) => `${index}:${'y'.repeat(200)}`).join('\n')
    );
    const capped = await readWorkspaceFileLines(root, 'workspace/wide.txt', {
      startLine: 1,
      endLine: 50,
      maxBytes: 500
    });
    expect(capped.truncated).toBe(true);
    expect(capped.content.length).toBeLessThanOrEqual(500);
    // Resumes AT the line the budget cut in half, not after it: the half that did not fit is read
    // again whole rather than silently dropped. Without this the caller is told the read was
    // truncated and given nowhere to continue from, which is a dead end dressed as a bound.
    expect(capped.nextStartLine).toBeGreaterThan(1);
    const rest = await readWorkspaceFileLines(root, 'workspace/wide.txt', {
      startLine: capped.nextStartLine!,
      endLine: 50,
      maxBytes: 1_000_000
    });
    expect(rest.content.toString('utf8').split('\n')[0]).toMatch(/^\d+:y+$/);
  });

  it('advances past one line that is longer than the whole budget, rather than looping on it', () => {
    // The single case with nowhere clean to go: resuming at the line would return the same half
    // forever. It advances and reports `truncated`, which is the only honest answer left.
    return writeFile(path.join(root, 'workspace', 'one-long.txt'), `${'z'.repeat(4_000)}\nnext\n`)
      .then(() =>
        readWorkspaceFileLines(root, 'workspace/one-long.txt', {
          startLine: 1,
          endLine: 10,
          maxBytes: 100
        })
      )
      .then((first) => {
        expect(first.truncated).toBe(true);
        expect(first.nextStartLine).toBe(2);
      });
  });
});

describe('renaming and folders', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-runner-'));
    await ensureWorkspace(root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('creates a folder, and creating it twice is not an error', async () => {
    expect(await createWorkspaceFolder(root, 'workspace/applications/acme')).toEqual({
      path: path.join('workspace', 'applications', 'acme')
    });
    expect((await stat(path.join(root, 'workspace', 'applications', 'acme'))).isDirectory()).toBe(
      true
    );
    await expect(createWorkspaceFolder(root, 'workspace/applications/acme')).resolves.toEqual({
      path: path.join('workspace', 'applications', 'acme')
    });
  });

  it('refuses to make a folder where a file already lives', async () => {
    await writeWorkspaceFile(root, 'workspace/cv.pdf', Buffer.from('cv'), 100);
    await expect(createWorkspaceFolder(root, 'workspace/cv.pdf')).rejects.toThrow(
      'A file already exists at that path'
    );
    await expect(createWorkspaceFolder(root, 'workspace/cv.pdf')).rejects.toMatchObject({
      status: 409
    });
  });

  it('renames a file and leaves its contents alone', async () => {
    await writeWorkspaceFile(root, 'workspace/draft.md', Buffer.from('# draft'), 100);
    expect(
      await renameWorkspaceEntry(root, 'workspace/draft.md', 'workspace/cover-letter.md')
    ).toEqual({ path: path.join('workspace', 'cover-letter.md') });
    expect(await readFile(path.join(root, 'workspace', 'cover-letter.md'), 'utf8')).toBe('# draft');
  });

  it('never overwrites, because the owner asked for a new name not for a deletion', async () => {
    await writeWorkspaceFile(root, 'workspace/a.md', Buffer.from('keep me'), 100);
    await writeWorkspaceFile(root, 'workspace/b.md', Buffer.from('other'), 100);
    await expect(renameWorkspaceEntry(root, 'workspace/b.md', 'workspace/a.md')).rejects.toThrow(
      'Something already exists at the new name'
    );
    expect(await readFile(path.join(root, 'workspace', 'a.md'), 'utf8')).toBe('keep me');
  });

  it('reports a missing source as missing rather than as a bad request', async () => {
    await expect(
      renameWorkspaceEntry(root, 'workspace/gone.md', 'workspace/here.md')
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the workspace boundary on both ends of a rename', async () => {
    await writeWorkspaceFile(root, 'workspace/a.md', Buffer.from('x'), 100);
    await expect(renameWorkspaceEntry(root, 'workspace/a.md', '../escaped.md')).rejects.toThrow(
      'escapes workspace'
    );
    await expect(renameWorkspaceEntry(root, 'workspace', 'workspace-2')).rejects.toThrow(
      'Workspace root cannot be renamed'
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'athanor-outside-'));
    try {
      await symlink(outside, path.join(root, 'workspace', 'escape'));
      await expect(
        renameWorkspaceEntry(root, 'workspace/a.md', 'workspace/escape/a.md')
      ).rejects.toThrow('Symbolic links are not allowed');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes a print target inside the workspace, creating its folder', async () => {
    // What print-to-PDF does now that the bytes come back to the runner instead of the browser
    // being handed a path to open on its own: the boundary check, then an ordinary write.
    const relative = assertUserDataPath(root, 'workspace/applications/cv.pdf');
    expect(relative).toBe(path.join('workspace', 'applications', 'cv.pdf'));
    await writeWorkspaceFile(root, relative, Buffer.from('%PDF-1.7'), 100);
    expect((await stat(path.join(root, 'workspace', 'applications'))).isDirectory()).toBe(true);
    expect(await readFile(path.join(root, 'workspace', 'applications', 'cv.pdf'), 'utf8')).toBe(
      '%PDF-1.7'
    );
    expect(() => assertUserDataPath(root, '../../etc/cron.d/athanor')).toThrow('escapes workspace');
    expect(() => assertUserDataPath(root, '.athanor/browser/Cookies')).toThrow(
      'Only workspace files'
    );
    // A traversal that lands back inside is still refused rather than folded into a write.
    expect(() => assertUserDataPath(root, '../athanor/escape.pdf')).toThrow('escapes workspace');
  });

  it('carries a status the file browser can act on', () => {
    expect(new WorkspaceFileError('taken', 409).status).toBe(409);
  });

  it('still reports storage when part of the tree belongs to the agent account', async () => {
    // On a real box the agent's own account owns ~/.cache, and GLib creates it at mode 0700 the
    // first time a GUI program runs - so the runner cannot open it. Refusing to report any figure
    // because of one unreadable directory would take the storage reading away from the owner for
    // every workspace that had ever opened a document. chmod 0 reproduces that here without
    // needing two accounts.
    await writeWorkspaceFile(root, 'workspace/notes.txt', Buffer.from('12345'), 100);
    const opaque = path.join(root, '.cache');
    await mkdir(opaque, { recursive: true });
    await writeFile(path.join(opaque, 'inside'), 'hidden');
    await chmod(opaque, 0o000);
    try {
      expect(await workspaceUsage(root)).toBeGreaterThanOrEqual(5);
    } finally {
      await chmod(opaque, 0o700);
    }
  });
});

/*
 * The line a read actually put on screen, and an edit that rests on one it never did.
 *
 * `file_patch` proves `oldText` occurs exactly once in the file. It does not prove the model ever
 * read that part of the file, so a window read of lines 1-50 followed by an anchor at line 300 was
 * indistinguishable from an anchor at line 20: both match, both apply, and one of them is an edit
 * made from memory of a region that was never displayed. Every sequence below is the worker's real
 * one - window read, then the whole-file read `file_patch` makes to match on, then the write that
 * claims the hash from it.
 */
describe('the seen-line guard', () => {
  let root: string;
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
  const file = 'workspace/app.ts';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'athanor-runner-'));
    await ensureWorkspace(root);
    await writeFile(path.join(root, 'workspace', 'app.ts'), `${lines.join('\n')}\n`);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  const look = (startLine: number, endLine: number, maxBytes = 400_000): Promise<unknown> =>
    readWorkspaceFileLines(root, file, { startLine, endLine, maxBytes });
  // What `file_patch` does: read the whole file to match `oldText` on, keep the runner's hash.
  const prepare = async (
    find: string,
    replace: string
  ): Promise<{ content: Buffer; expect: string }> => {
    const read = await readWorkspaceFile(root, file, 10_000_000);
    return {
      content: Buffer.from(read.content.toString('utf8').replace(find, replace)),
      expect: read.sha256
    };
  };
  const write = (patch: { content: Buffer; expect: string }): Promise<unknown> =>
    writeWorkspaceFile(root, file, patch.content, 10_000_000, patch.expect);

  it('applies an edit anchored on a line the read displayed', async () => {
    await look(1, 50);
    await write(await prepare('line 20', 'line 20 // touched'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 20 // touched'
    );
  });

  /*
   * The refusal has to carry the truth with it. A refusal that costs a round trip is barely better
   * than the wrong edit it prevented: the model re-reads, re-derives the same patch, and the owner
   * pays for two turns to get one edit. So the real text arrives inline, the refusal counts as
   * having shown it, and the same call sent again applies.
   */
  it('refuses an edit anchored on a line no read displayed, and hands back what is there', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // touched');
    // One attempt, both assertions: the second attempt is the retry, and it is meant to succeed.
    const refusal = await write(patch).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 428 });
    expect((refusal as Error).message).toContain('no read has shown you those lines');
    expect((refusal as Error).message).toContain('300| line 300');
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).not.toContain('touched');
  });

  it('lets the very same call through once the refusal has shown those lines', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // touched');
    await expect(write(patch)).rejects.toMatchObject({ status: 428 });
    await write(patch);
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain(
      'line 300 // touched'
    );
  });

  /*
   * A file that moved under the caller is a different failure with a different answer, and the
   * compare-and-swap must still be the one that answers it. Telling the model about anchors here
   * would send it back to patch a version that no longer exists, and merging silently would lose
   * the other writer's work - which is what this tree has three other writers to worry about.
   */
  it('lets the compare-and-swap answer a file that changed on disk, rather than the guard', async () => {
    await look(1, 50);
    const patch = await prepare('line 300', 'line 300 // mine');
    await writeFile(
      path.join(root, 'workspace', 'app.ts'),
      `${lines.join('\n')}\n`.replace('line 300', 'line 300 // theirs')
    );
    await expect(write(patch)).rejects.toMatchObject({ status: 409 });
    await expect(write(patch)).rejects.toThrow('changed after you read it');
    // And still, once a fresh window read has given the guard something to say about the file it
    // is now. Both refusals are live at this point and only one of them is true: the model's read
    // is stale, and telling it about anchors would send it back to patch a version that is gone.
    await look(1, 50);
    await expect(write(patch)).rejects.toThrow('changed after you read it');
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('// theirs');
  });

  /* A line the byte budget cut in half was not displayed; counting it would vouch for the half
   * that never arrived. */
  it('does not vouch for the line a read stopped in the middle of', async () => {
    await writeFile(
      path.join(root, 'workspace', 'app.ts'),
      ['aaa', 'bbb', 'c'.repeat(500), 'ddd', 'eee'].join('\n')
    );
    await look(1, 5, 20);
    await expect(write(await prepare('ccc', 'xxx'))).rejects.toMatchObject({ status: 428 });
    await write(await prepare('bbb', 'BBB'));
  });

  /*
   * Without the record following the file across its own write, the guard is one edit deep: the
   * write changes size and modification time, the identity stops matching, and the next patch - the
   * one aimed at line 300 after the first one tidied line 20 - goes through unexamined.
   */
  it('still guards the second edit of a turn, after its own write moved the file', async () => {
    await look(1, 50);
    await write(await prepare('line 20', 'line 20 // touched'));
    await expect(write(await prepare('line 300', 'line 300 // blind'))).rejects.toMatchObject({
      status: 428
    });
  });

  /*
   * The file browser reads whole files and writes them back and never reads a window. It must be
   * exactly as unguarded as it was, or the owner's second save is refused for lines the first did
   * not touch - and `file_read` without a window is the same request on the wire, so neither can
   * be treated as a display.
   */
  it('has no opinion at all about a file no window read has shown', async () => {
    await write(await prepare('line 300', 'line 300 // from the file browser'));
    await write(await prepare('line 7', 'line 7 // and again'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('and again');
  });

  /*
   * A caller with no hash to offer is not editing from a read. The owner pressing Replace on a file
   * the pane once paged through, an upload landing on a name, a printed document: none of them
   * claimed to have read anything, and refusing them for lines they never pretended to have seen
   * would put a lecture about anchors in front of a person who has no idea what one is.
   */
  it('has nothing to say to a writer that never claimed to have read the file', async () => {
    await look(1, 50);
    await writeWorkspaceFile(root, file, Buffer.from('replaced wholesale\n'), 10_000_000);
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toBe(
      'replaced wholesale\n'
    );
  });

  /* Lines are not what binary is made of, so there are no anchors in it to have seen. */
  it('has nothing to say about binary content', async () => {
    const binary = Buffer.concat([Buffer.from('PDF'), Buffer.from([0]), Buffer.alloc(64, 7)]);
    await writeFile(path.join(root, 'workspace', 'app.ts'), binary);
    await look(1, 5);
    const read = await readWorkspaceFile(root, file, 10_000_000);
    await writeWorkspaceFile(
      root,
      file,
      Buffer.concat([binary, Buffer.from([0, 9, 9])]),
      10_000_000,
      read.sha256
    );
  });

  /*
   * Past a glance, inlining the truth is the wrong answer: dribbling a screenful per round trip
   * costs the owner more than the read would have. The refusal names the range instead, and
   * discloses nothing - so it does not quietly become a pass on the retry.
   */
  it('sends the model to read a range too wide to hand back, and stays refused until it does', async () => {
    await look(1, 5);
    const patch = await prepare(lines.slice(99, 200).join('\n'), 'collapsed');
    await expect(write(patch)).rejects.toThrow('Read it with file_read');
    await expect(write(patch)).rejects.toMatchObject({ status: 428 });
    await look(100, 200);
    await write(await prepare(lines.slice(99, 200).join('\n'), 'collapsed'));
    expect(await readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).toContain('collapsed');
  });
});
