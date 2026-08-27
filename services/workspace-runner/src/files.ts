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
import {
  discloseUnseen,
  displayedLines,
  fileIdentity,
  lineEdit,
  recordDisplayedLines,
  rememberWrite,
  sayRanges,
  unseenWithin,
  type LineEdit
} from './seen-lines.js';

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

/**
 * A step upwards is `..` on its own or `..` followed by a separator - it is not "the name begins
 * with two dots". `path.relative` answers `..gitignore` for a file of that name sitting in the
 * root, and reading that as an escape refused every top-level entry whose name happens to start
 * that way: `..backup`, a `cwd` called `..build`, `..gitignore` itself. The agent creates
 * `workspace/..backup/` from a shell command, asks to list it, and is told its path escapes the
 * workspace - an accusation instead of a correction, and `assertUserDataPath` runs this check
 * before the fold that exists precisely to stop the agent guessing at prefixes.
 */
export const resolveInside = (root: string, requested = '.'): string => {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
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
  await mkdir(path.join(root, '.athanor', 'artifacts'), {
    recursive: true,
    mode: RUNNER_ONLY_MODE
  });
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
        /*
         * The one honest thing a folder can say about itself.
         *
         * `details.size` on a directory is the size of the directory record - 64 or 96 bytes on
         * APFS, 4096 on ext4 - so the file browser had nothing to print on a folder row and printed
         * the word "Folder". A count is one extra `readdir` per folder in the listing, alongside
         * the `lstat` each entry already costs, and it is bounded by what is on screen. A folder
         * the agent's account cannot read is left without a count rather than failing the listing
         * it appears in: the row is still real, it just says less.
         */
        const itemCount = entry.isDirectory()
          ? await readdir(entryPath).then(
              (names) => names.filter((name) => name !== '.athanor').length,
              () => undefined
            )
          : undefined;
        return {
          name: entry.name,
          path: path.relative(root, entryPath),
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          sizeBytes: details.size,
          modifiedAt: details.mtime.toISOString(),
          ...(itemCount === undefined ? {} : { itemCount })
        };
      })
  );
};

/**
 * The whole file, and deliberately not a display.
 *
 * This route answers two callers that look identical on the wire and are opposites in meaning: an
 * unbounded `file_read`, which puts every line in front of the model, and the read-modify-write
 * that `file_patch` does one call before its write, which puts nothing in front of anybody. If this
 * recorded what it returned, every patch would announce that the model had just seen the whole
 * file - and the seen-line guard below would be inert for the one tool it exists to guard. So
 * nothing is recorded here, and only a window read, which no internal caller makes, counts as
 * having been shown.
 *
 * The cost of that choice is one case: a window read followed by an unbounded read followed by an
 * edit outside the window is refused once, on a file the model really had seen all of. It is
 * refused with the text inlined, so the retry lands immediately - one refusal, no extra read, and
 * the alternative was a guard that never fires.
 */
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
    /*
     * What this read actually put in front of its caller, remembered so a later write can be held
     * to it. A read cut short by its byte budget stopped mid-line, and that line was not displayed:
     * counting it would vouch for the half that never arrived, which is precisely the kind of
     * half-seen text this record exists to refuse an edit on.
     */
    recordDisplayedLines(target, fileIdentity(details), {
      start: window.startLine,
      end: truncated ? lastKept - 1 : lastKept
    });
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
 * Above this, a write is not held to the seen-line record: splitting the old file into an array of
 * strings costs several times its size in this process, and the read that feeds the guard is a read
 * the hash check would not otherwise have paid for. Comfortably larger than any file a model edits
 * by hand and far below the 2 GiB read ceiling the installer sets.
 */
const MAX_GUARDED_FILE_BYTES = 8 * 1024 ** 2;

/**
 * `expectSha256` is the caller's claim about what it is replacing, checked under the same open
 * descriptor that then does the writing.
 *
 * `file_write` is a read-modify-write with the read done in a previous step, and at least three
 * other writers share this tree: the agent's own shell, a second slot of the same worker, and the
 * owner in the file browser. Between the read and the write, any of them can land - and a whole-
 * file write does not fail, it silently discards what they wrote.
 *
 * `file_patch` reaches this same route and now claims its read too: it keeps the runner's hash from
 * the read it makes before matching `oldText` and passes it here. Until it did, the exactly-once
 * match on `oldText` proved the text it replaced was there and proved nothing about the file still
 * being the one it read.
 *
 * The hash rather than a modification time: it is exact, it says the content is what was read
 * rather than that nothing touched the inode, and both sides already compute it. Absent means the
 * caller is not claiming anything - creating a new file, or a caller that never read it - and the
 * write proceeds, because demanding it everywhere would break every first write.
 *
 * The hash answers "is this still the file you read". The seen-line guard beneath it answers the
 * question that survives a clean hash: "did you ever read the part of it you are changing". A
 * window read of lines 1-50 and a patch anchored at line 300 agree about every byte in the file and
 * still describe an edit made blind.
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
  let edit: LineEdit | undefined;
  try {
    await assertOpenedInPlace(root, target, handle);
    // Read through the descriptor already proven to be the intended file, so nothing can swap the
    // path between the check and the write. One read serves both checks below.
    const details = expectSha256 === undefined ? undefined : await handle.stat();
    const existing = details === undefined ? undefined : await handle.readFile();
    if (expectSha256 !== undefined && existing !== undefined) {
      const actual = createHash('sha256').update(existing).digest('hex');
      // A file that did not exist reads as empty; the caller claiming a hash for it is claiming
      // something that was true and is not, which is the same disagreement.
      if (actual !== expectSha256)
        throw new WorkspaceFileError(
          'This file changed after you read it, so writing the whole file would discard that change. Read it again and reapply your edit, or use file_patch, which matches on the surrounding text.',
          409
        );
    }
    /*
     * The seen-line guard, and it runs second on purpose. A file that moved under the caller is a
     * different failure with a different answer - read it again - and answering it with a lecture
     * about anchors would send the model back to patch a version that no longer exists.
     *
     * It rides on the same claim rather than on the record alone, and that is what keeps it aimed
     * at editing. A caller with no hash to offer is not editing from a read: it is an upload
     * replacing a file, a printed document landing on a name, the first write of anything. Held to
     * a seen-line record those would be refused for lines they never pretended to have read - the
     * owner pressing Replace on a file the pane had once paged through, told about anchors it has
     * no idea it has. A claim about the old bytes is exactly the caller saying "I read this", and
     * only that caller can be asked which part of it.
     *
     * Binary content is skipped for the same reason: lines are not what it is made of, and a file
     * with a zero byte in it has no anchors to have seen. A file too large to hold as lines is
     * skipped because the ceiling is about this process's memory - and the guard's whole discipline
     * is that losing the opinion is always allowed and losing the write never is.
     */
    if (
      details !== undefined &&
      existing !== undefined &&
      details.size <= MAX_GUARDED_FILE_BYTES &&
      !existing.includes(0) &&
      !content.includes(0)
    ) {
      const seen = displayedLines(target, fileIdentity(details));
      if (seen) {
        const before = existing.toString('utf8').split('\n');
        edit = lineEdit(before, content.toString('utf8').split('\n'));
        if (edit.anchors) {
          const unseen = unseenWithin(edit.anchors, seen);
          if (unseen.length) {
            const name = path.relative(root, target);
            const disclosure = discloseUnseen(before, unseen);
            if (!disclosure)
              throw new WorkspaceFileError(
                `This edit changes ${name} at line ${sayRanges(unseen)}, and no read has shown you those lines. That is too much unread file to hand back here. Read it with file_read using startLine and endLine over that range, then send the edit again.`,
                428
              );
            /*
             * The refusal is a display. Recording it is what stops the guard looping: the model is
             * shown the truth once and the same edit, sent again, applies. Only the lines that
             * actually fit in the message are recorded - a range the byte budget cut short was not
             * shown, and the next attempt is refused again with the rest of it, which terminates
             * because every round hands over more.
             */
            for (const range of disclosure.disclosed)
              recordDisplayedLines(target, fileIdentity(details), range);
            throw new WorkspaceFileError(
              `This edit changes ${name} at line ${sayRanges(unseen)}, and no read has shown you those lines - so it is being made from memory of a file you have only seen part of. Here is what is actually there. Check your edit against it and send the same call again; these lines now count as read, so it will apply.\n\n${disclosure.text}`,
              428
            );
          }
        }
      }
    }
    await handle.truncate(0);
    /*
     * Written at an offset this function names, because a descriptor carries a position and this
     * one has been read from.
     *
     * `handle.writeFile` writes at the descriptor's current position, and the compare-and-swap
     * above leaves that position at the end of the old file: every write that claimed a hash landed
     * after a hole, producing the old file's length in zero bytes followed by the new content. It
     * was invisible from the outside because a corrupted file still contains every string a test
     * looked for, and the two callers that claim a hash are the two that matter most - the owner
     * saving in the file browser, and every `file_patch` since the patch path started claiming its
     * read. The loop is not defensive dressing: a single `write` is allowed to take fewer bytes
     * than it was offered, and a partial write here is a truncated file.
     */
    for (let written = 0; written < content.length; ) {
      const { bytesWritten } = await handle.write(
        content,
        written,
        content.length - written,
        written
      );
      if (bytesWritten <= 0) throw new Error('The file could not be written in full');
      written += bytesWritten;
    }
    // The record follows the file across its own write, so a second edit in the same turn is still
    // held to what was read. A file with no record gains none - see `rememberWrite`.
    if (edit) rememberWrite(target, fileIdentity(await handle.stat()), edit);
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
