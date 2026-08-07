import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A file error the caller should answer with something other than "bad request". The runner's
 * error handler reads the status off it, so "there is already a folder called that" arrives as a
 * conflict the file browser can explain instead of a generic failure it cannot.
 */
export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

export const workspacePath = (root: string, workspaceId: string): string => {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('Invalid workspace ID');
  return path.join(path.resolve(root), workspaceId.toLowerCase());
};

export const resolveInside = (root: string, requested = '.'): string => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Path escapes workspace');
  return resolved;
};

const ARTIFACTS = path.join('.athanor', 'artifacts');

const isUserData = (relative: string): boolean =>
  relative === 'workspace' ||
  relative.startsWith(`workspace${path.sep}`) ||
  relative === ARTIFACTS ||
  relative.startsWith(`${ARTIFACTS}${path.sep}`);

/**
 * The container's own directories, which are not the agent's and are never a bare name's meaning.
 * `.athanor` holds the runner's private state - the browser profile among it - and `.config` the
 * guest's settings. `workspace` is left out on purpose: a path already rooted there is user data
 * and is accepted above before this is consulted.
 */
const CONTAINER_ONLY = new Set(['.athanor', '.config']);

/**
 * Where a path the agent gave means what the agent meant by it.
 *
 * Commands run in `workspace/`, so an agent that has just listed its own directory and asks to
 * write `notes.md` means `workspace/notes.md`. This resolved against the container one level up
 * instead, where nothing of the agent's lives and nothing is writable, so the write was refused -
 * and the agent, told only that the path was wrong, guessed at prefixes and spent the owner's
 * money doing it. A plain relative name is therefore read the way the shell reads it.
 *
 * Only a plain one. A path that is absolute, that steps upwards through `..`, or that names one of
 * the container's own directories is resolved and checked exactly as before, and refused if it
 * lands outside the two roots. Folding those back inside would answer an attempt worth seeing with
 * a write worth nothing: an agent reaching for `.athanor/browser/Cookies` should be told no, not
 * quietly handed `workspace/.athanor/browser/Cookies`. This changes which directory a bare name
 * starts from, not what any path is allowed to reach.
 */
export const assertUserDataPath = (root: string, requested = 'workspace'): string => {
  const resolvedRoot = path.resolve(root);
  const asGiven = path.relative(resolvedRoot, resolveInside(root, requested));
  if (isUserData(asGiven)) return asGiven;
  const segments = requested.split(/[/\\]/).filter(Boolean);
  const bareName =
    !path.isAbsolute(requested) &&
    !segments.includes('..') &&
    !CONTAINER_ONLY.has(segments[0] ?? '');
  if (bareName) {
    const nested = path.relative(
      resolvedRoot,
      resolveInside(root, path.join('workspace', requested))
    );
    if (isUserData(nested)) return nested;
  }
  throw new Error('Only workspace files and published artifacts are accessible');
};

const rejectSymlinkComponents = async (
  root: string,
  target: string,
  allowMissing = false
): Promise<void> => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  let current = path.resolve(root);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Symbolic links are not allowed');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
};

/**
 * Proves that the descriptor just opened is the file the path described, rather than one a
 * symbolic link swapped in between the check and the open.
 *
 * The walk above answers the question at the time it runs, and the kernel answers it again when
 * `open` resolves the path — and in between, every directory under `workspace/` is writable by the
 * agent's own account, so a component that passed can become a link into `.athanor`, where the
 * browser profile the agent may not read lives. `O_NOFOLLOW` covers only the last component. These
 * two checks cover the rest: the walk again, which refuses a component that is a link now, and the
 * identity comparison, which refuses a descriptor that is not what the path names now. A swap has
 * to survive both at once, and one that has been put back no longer leads to the file the
 * descriptor is holding.
 */
export const assertOpenedInPlace = async (
  root: string,
  target: string,
  handle: FileHandle
): Promise<void> => {
  await rejectSymlinkComponents(root, target);
  const [opened, named] = await Promise.all([handle.stat(), lstat(target)]);
  if (opened.dev !== named.dev || opened.ino !== named.ino)
    throw new Error('The path changed while it was being opened');
};

/**
 * Agent commands run as a different Unix account than the runner, in a group both belong to, so
 * the home and the project tree are group-accessible and everything under `.athanor` is not.
 * That single distinction is what keeps the browser profile - the cookie jar for every site the
 * owner has signed into - out of reach of a command, while leaving the agent free to work on its
 * own files. The parent directory carries the set-group-ID bit so the group is inherited by
 * everything created below, whichever account created it.
 */
const SHARED_MODE = 0o770;
const RUNNER_ONLY_MODE = 0o700;

export const ensureWorkspace = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true, mode: SHARED_MODE });
  await mkdir(path.join(root, 'workspace'), { recursive: true, mode: SHARED_MODE });
  await mkdir(path.join(root, '.athanor', 'browser'), { recursive: true, mode: RUNNER_ONLY_MODE });
  await mkdir(path.join(root, '.athanor', 'desktop'), { recursive: true, mode: RUNNER_ONLY_MODE });
  await mkdir(path.join(root, '.athanor', 'artifacts'), { recursive: true, mode: RUNNER_ONLY_MODE });
};

export const listFiles = async (root: string, requested = '.'): Promise<unknown[]> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const entries = await readdir(target, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.name !== '.athanor')
      .map(async (entry) => {
        const entryPath = path.join(target, entry.name);
        const details = await lstat(entryPath);
        return {
          name: entry.name,
          path: path.relative(root, entryPath),
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          sizeBytes: details.size,
          modifiedAt: details.mtime.toISOString()
        };
      })
  );
};

export const readWorkspaceFile = async (
  root: string,
  requested: string,
  maxBytes: number
): Promise<{ content: Buffer; sha256: string }> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertOpenedInPlace(root, target, handle);
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('Requested path is not a regular file');
    if (details.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte read limit`);
    const content = await handle.readFile();
    return { content, sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await handle.close();
  }
};

/** Big enough that an ordinary source file arrives in one read, small enough to cost nothing. */
const LINE_SCAN_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * A window of lines, read without the whole file ever being in memory.
 *
 * `readWorkspaceFile` is the right shape for a caller that needs every byte - a patch, an upload -
 * and the wrong one for a glance at a log. `file_read` asks for a few hundred lines and used to be
 * answered with the file: against the 2 GiB ceiling the installer sets, one look at a database
 * dump buffered a gigabyte inside a service the unit file caps at 80% of host memory, and the OOM
 * killer takes the runner down with every other tool on it. This walks the file in a fixed buffer,
 * keeps only the requested lines and only `maxBytes` of them, and stops as soon as it has them, so
 * what a read costs follows what was asked for rather than what the file happens to weigh.
 *
 * `totalLines` is therefore only there when the read reached the end of the file: counting the rest
 * would mean reading everything this exists to avoid, and `nextStartLine` and `sizeBytes` are what
 * the caller needs anyway. Lines are separated by newlines, not terminated by them, so a file
 * ending in one has a final empty line, exactly as splitting the whole string on newlines would.
 */
export const readWorkspaceFileLines = async (
  root: string,
  requested: string,
  window: { startLine: number; endLine: number; maxBytes: number }
): Promise<{
  content: Buffer;
  startLine: number;
  endLine: number;
  totalLines?: number;
  nextStartLine?: number;
  truncated: boolean;
  sizeBytes: number;
}> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertOpenedInPlace(root, target, handle);
    const details = await handle.stat();
    if (!details.isFile()) throw new Error('Requested path is not a regular file');
    const buffer = Buffer.allocUnsafe(LINE_SCAN_BYTES);
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let line = 1;
    let lastKept = window.startLine;
    // Whether the newline that ended the last kept line was kept with it. It is a separator, so it
    // belongs to the answer only when another line follows it in the window.
    let lastKeptTerminated = false;
    let truncated = false;
    let position = 0;
    let eof = false;
    while (!truncated && line <= window.endLine) {
      const { bytesRead } = await handle.read(buffer, 0, LINE_SCAN_BYTES, position);
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytesRead && !truncated && line <= window.endLine) {
        const newline = chunk.indexOf(NEWLINE, cursor);
        const end = newline === -1 ? bytesRead : newline + 1;
        if (line >= window.startLine) {
          const take = Math.min(end - cursor, Math.max(0, window.maxBytes - keptBytes));
          if (take > 0) {
            // The buffer is reused by the next read, so what is kept has to be a copy of it.
            kept.push(Buffer.from(chunk.subarray(cursor, cursor + take)));
            keptBytes += take;
            lastKept = line;
            lastKeptTerminated = newline !== -1 && take === end - cursor;
          }
          if (take < end - cursor) truncated = true;
        }
        cursor = end;
        if (newline !== -1) line += 1;
      }
    }
    // The final line of a file that ends in a newline is empty and holds no bytes, so nothing above
    // records it, and a whole-file read has to end where splitting the whole string would.
    if (eof && !truncated && line >= window.startLine && line <= window.endLine) {
      lastKept = line;
      lastKeptTerminated = false;
    }
    const content = Buffer.concat(kept);
    return {
      content: lastKeptTerminated ? content.subarray(0, content.length - 1) : content,
      startLine: window.startLine,
      endLine: lastKept,
      ...(eof ? { totalLines: line } : {}),
      // Where to carry on, whether the window ended or the budget did. A read that stopped on its
      // budget mid-line resumes AT that line rather than after it, so the half that did not fit is
      // not silently dropped - the caller reads it again whole with a larger budget or a narrower
      // window. The one case with nowhere to go is a single line longer than the whole budget:
      // resuming at it would return the same half forever, so that one advances past it and says so
      // through `truncated`, which is the only honest answer when one line cannot be delivered.
      ...(eof
        ? {}
        : truncated && !lastKeptTerminated
          ? { nextStartLine: lastKept === window.startLine ? lastKept + 1 : lastKept }
          : { nextStartLine: lastKept + 1 }),
      truncated,
      sizeBytes: details.size
    };
  } finally {
    await handle.close();
  }
};

/** Where a file is copied to before the browser is given its name. Runner-owned, 0700. */
const UPLOAD_STAGING = path.join('.athanor', 'uploads');

/**
 * A copy of a workspace file, in a directory only the runner can write, whose absolute path is
 * handed to the browser for an upload.
 *
 * The browser opens that path when the form is actually submitted, which can be minutes after this
 * call and is nowhere this module can guard. Handing it a name inside the agent's own tree meant
 * handing it a name the agent could still repoint at the cookie jar in the meantime; every
 * component of this one belongs to the runner. The file name is preserved exactly, because it is
 * what the site is told the attachment is called.
 */
export const stageUserFileForUpload = async (
  root: string,
  requested: string,
  maxBytes: number
): Promise<string> => {
  const relative = assertUserDataPath(root, requested);
  const { content } = await readWorkspaceFile(root, relative, maxBytes);
  const directory = path.join(root, UPLOAD_STAGING, randomUUID());
  await mkdir(directory, { recursive: true, mode: RUNNER_ONLY_MODE });
  const staged = path.join(directory, path.basename(relative));
  await writeFile(staged, content, { mode: 0o600 });
  return staged;
};

/** Staged copies live as long as the browser session that may still submit them, and no longer. */
export const clearStagedUploads = async (root: string): Promise<void> => {
  await rm(path.join(root, UPLOAD_STAGING), { recursive: true, force: true });
};

/**
 * `expectSha256` is the caller's claim about what it is replacing, checked under the same open
 * descriptor that then does the writing.
 *
 * `file_write` is a read-modify-write with the read done in a previous step, and at least three
 * other writers share this tree: the agent's own shell, a second slot of the same worker, and the
 * owner in the file browser. Between the read and the write, any of them can land - and a whole-
 * file write does not fail, it silently discards what they wrote. `file_patch` already has the
 * stronger version of this guard (it re-reads at apply time and requires an exactly-once match),
 * which is why this is the tool that needed one and that one is left alone.
 *
 * The hash rather than a modification time: it is exact, it says the content is what was read
 * rather than that nothing touched the inode, and both sides already compute it. Absent means the
 * caller is not claiming anything - creating a new file, or a caller that never read it - and the
 * write proceeds, because demanding it everywhere would break every first write.
 */
export const writeWorkspaceFile = async (
  root: string,
  requested: string,
  content: Buffer,
  maxBytes: number,
  expectSha256?: string
): Promise<{ sha256: string; sizeBytes: number }> => {
  if (content.length > maxBytes) throw new Error(`File exceeds ${maxBytes} byte write limit`);
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target, true);
  await mkdir(path.dirname(target), { recursive: true, mode: SHARED_MODE });
  await rejectSymlinkComponents(root, target, true);
  // Deliberately not O_TRUNC: the descriptor is only known to be the intended file once it has
  // been checked, and truncating first would empty whatever a raced path led to before the check
  // could refuse it.
  const handle = await open(
    target,
    // Read-write only when there is a claim to check, so the check reads through the very
    // descriptor that then writes and no path swap can happen between the two.
    (expectSha256 === undefined ? constants.O_WRONLY : constants.O_RDWR) |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o660
  );
  try {
    await assertOpenedInPlace(root, target, handle);
    if (expectSha256 !== undefined) {
      // Read through the descriptor already proven to be the intended file, so nothing can swap the
      // path between the check and the write.
      const existing = await handle.readFile();
      const actual = createHash('sha256').update(existing).digest('hex');
      // A file that did not exist reads as empty; the caller claiming a hash for it is claiming
      // something that was true and is not, which is the same disagreement.
      if (actual !== expectSha256)
        throw new WorkspaceFileError(
          'This file changed after you read it, so writing the whole file would discard that change. Read it again and reapply your edit, or use file_patch, which matches on the surrounding text.',
          409
        );
    }
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return { sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length };
};

export const deleteWorkspaceFile = async (root: string, requested: string): Promise<void> => {
  const target = resolveInside(root, requested);
  const protectedRoot = path.resolve(root, 'workspace');
  if (target === path.resolve(root) || target === protectedRoot)
    throw new Error('Workspace root cannot be deleted');
  await rejectSymlinkComponents(root, target);
  await rm(target, { recursive: true, force: true });
};

const assertNotWorkspaceRoot = (root: string, target: string, verb: string): void => {
  if (target === path.resolve(root) || target === path.resolve(root, 'workspace'))
    throw new WorkspaceFileError(`Workspace root cannot be ${verb}`, 400);
};

export const createWorkspaceFolder = async (
  root: string,
  requested: string
): Promise<{ path: string }> => {
  const target = resolveInside(root, requested);
  await rejectSymlinkComponents(root, target, true);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isDirectory())
    throw new WorkspaceFileError('A file already exists at that path', 409);
  await mkdir(target, { recursive: true, mode: SHARED_MODE });
  return { path: path.relative(root, target) };
};

/**
 * Renaming never overwrites. A silent overwrite is the one outcome the file browser must not
 * produce: the owner asked for a new name, not for the file already using it to disappear.
 */
export const renameWorkspaceEntry = async (
  root: string,
  from: string,
  to: string
): Promise<{ path: string }> => {
  const source = resolveInside(root, from);
  const destination = resolveInside(root, to);
  assertNotWorkspaceRoot(root, source, 'renamed');
  assertNotWorkspaceRoot(root, destination, 'replaced');
  // Asked before the symlink walk, which would otherwise report a missing file as a failed stat.
  if (!(await lstat(source).catch(() => null)))
    throw new WorkspaceFileError('Workspace file not found', 404);
  await rejectSymlinkComponents(root, source);
  await rejectSymlinkComponents(root, destination, true);
  if (await lstat(destination).catch(() => null))
    throw new WorkspaceFileError('Something already exists at the new name', 409);
  await mkdir(path.dirname(destination), { recursive: true, mode: SHARED_MODE });
  await rename(source, destination);
  return { path: path.relative(root, destination) };
};

/**
 * Bytes actually on this disk under `root`. Symlinks are skipped, so nothing is counted twice.
 *
 * A directory the runner may not open is skipped rather than allowed to fail the whole figure.
 * The agent's own account owns part of this tree - `~/.cache` arrives at mode 0700 the first time
 * a GUI program runs, because GLib creates it that way - and refusing to report any number at all
 * because of it would take the storage reading away from the owner entirely. The host-level
 * measurement is what actually protects the disk; this figure is the per-workspace view.
 */
export const workspaceUsage = async (root: string): Promise<number> => {
  let total = 0;
  const unreadable = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    ['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '');
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (unreadable(error)) return null;
      throw error;
    });
    if (!entries) return;
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile())
        total += (
          await stat(target).catch((error: unknown) => {
            if (unreadable(error)) return { size: 0 };
            throw error;
          })
        ).size;
    }
  };
  await visit(root);
  return total;
};
