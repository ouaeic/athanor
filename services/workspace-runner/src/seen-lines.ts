/**
 * Which lines of a file were actually put in front of WHICH MODEL, so an edit cannot rest on a line
 * that reader never saw.
 *
 * `file_patch` proves that `oldText` occurs exactly once in the file. It does not prove the model
 * ever read that part of the file. A window read of lines 1-50 followed by a patch anchored at line
 * 300 is indistinguishable, at the moment of the write, from a patch anchored at line 20: both
 * match once, both apply, and the second one is an edit made from memory of a region that was never
 * displayed. Where the model remembers an older version of that region - a different turn, a
 * compaction, a plain guess that happens to match - the edit lands on text whose surroundings it
 * has mis-modelled, and nothing on the way in says so.
 *
 * This is the record that says so. A window read notes the lines it returned; a write compares the
 * lines it changes against that record; an edit that touches a line no read displayed is refused
 * with the real text at that line inlined into the refusal, which is what keeps the guard from
 * costing a round trip. The refusal is itself a display, so the same edit sent again applies: the
 * price of an unseen anchor is being shown the truth once, not being sent back to read.
 *
 * EVERY RECORD IS ABOUT A READER AND A FILE, never about a file alone - see `Reader`. One workspace
 * is shared by however many tasks are running in it, and "this file has been read" is not a fact
 * about the file: it is a fact about one context window. Keyed by path alone, the record answered
 * the question it was asked with somebody else's answer.
 *
 * Nothing here is a fact about the file - that is `files.ts` and the filesystem. This module holds
 * only the record of who was shown what, the arithmetic of which lines an edit rests on, and the
 * refusal's text.
 */

/** A closed, 1-indexed line range. `start` and `end` are both lines that exist. */
export type LineRange = { start: number; end: number };

/**
 * Who was shown the lines. A task - one agent's run, with its own context window and its own memory
 * of the file - and never a path, a workspace or a person.
 *
 * A record exists to answer "has THIS WRITER been shown these lines", and a workspace has more than
 * one writer in it: a second slot of the same worker, the owner in the Files pane, the agent's own
 * shell. Two tasks reading the same file are two readers, and what one of them has on screen says
 * nothing whatever about what the other has. Keyed by resolved path alone the record claimed
 * otherwise, and the claim was false in the direction that costs: measured through the shipped
 * write, task B reading lines 1-50 of a 400-line file and then whole-writing line 300 was refused,
 * and the same B whole-writing line 300 after task A had read 1-400 of the same file LANDED. The
 * only difference between the two runs was another task's read, and the second one changed a line
 * only A had ever seen.
 *
 * The task is taken from the capability token the request already carries - the worker stamps `sub`
 * with the task it is running for every runner call it makes - rather than from a new query
 * parameter or header. A parameter is something every call site has to remember to send, and a
 * guard whose identity can be forgotten by a caller is the same class of defect as one that is
 * keyed by the wrong thing; `sub` is signed, is already checked, and cannot be chosen by the code
 * running inside the task.
 *
 * AND ONE TASK CAN HOLD SEVERAL WINDOWS. A delegated specialist runs inside the lead's task with a
 * context window of its own, and what it was shown is no evidence of what the lead has seen; the
 * worker signs a specialist's calls with the task id and the specialist's window joined, so here
 * they are two readers. `task` is therefore the name of a window, which for the lead is its task.
 */
export type Reader = { readonly task: string };

/**
 * The reader a capability holder is, or `undefined` for a holder that is not one.
 *
 * THE DELIBERATE DECISION ABOUT THE OWNER IN THE FILES PANE, and about `control`: they get no
 * record at all. They file none on a read and are held to none on a write.
 *
 * It is a decision and not a tidy-up, because the pane does read this way. It pages a file through
 * the ranged reader - `apps/api` forwards `startLine`, `endLine` and `maxBytes` to the same route
 * the agent uses - and that reader recorded whatever it delivered, under the path, for whoever
 * wrote next to be measured against. The owner looking at half a log therefore left a record that
 * said half that log had been read, and the agent's next write to it was held to her reading.
 *
 * Filing it under her name instead of the path would fix that half and start a worse one: her save
 * would then be inside a guard built for a model editing from a window, and the second save of a
 * file the pane had paged would be refused for lines the first did not touch - a lecture about
 * anchors in front of a person who has no idea what one is. She is not held to reads, so a record
 * about her has no reader; it would only spend slots in a bounded store that the records doing the
 * guarding need. Not recording takes nothing from her and leaves the slots to the tasks.
 */
export const readerFor = (capability: { role: string; sub: string }): Reader | undefined =>
  capability.role === 'agent' ? { task: capability.sub } : undefined;

/**
 * The key: who, and then which file.
 *
 * Joined on a NUL because it is the one byte neither a task id nor a POSIX path can contain, so no
 * two pairs can spell one key. Run together, `a` reading `b/x` and `ab` reading `/x` are the same
 * string, and one reader's record would answer for another's again - by collision this time rather
 * than by design, which is the worse version because nothing in the shape of the code shows it.
 *
 * Priced honestly: no pair reachable today collides, because `sub` is a UUID and a target is always
 * an absolute resolved path. That is a fact about two callers this module does not own, and the
 * separator makes it a fact about the key instead.
 */
const keyFor = (reader: Reader, target: string): string => `${reader.task}\0${target}`;

/** A range plus when it was recorded, which is the only thing the per-file cap can rank on. */
type Recorded = LineRange & { at: number };

type Displayed = {
  /**
   * The file this record is about, as the filesystem identified it at the moment of the read. A
   * record survives only as long as the bytes under it do: if another writer has been through the
   * file, line 300 is no longer the line 300 that was displayed, and a record that outlived its
   * content would vouch for text nobody has seen. Device and inode catch a replacement, size and
   * modification time catch an edit in place.
   */
  identity: string;
  ranges: Recorded[];
  recordedAt: number;
};

/**
 * Per-process, and bounded on both axes because this box runs for months.
 *
 * Records: an LRU of the reader-and-file pairs recently read in windows, which is a working set,
 * not a history. A SLOT IS ONE FILE FOR ONE READER, which is what the key change cost: two tasks
 * reading the same three hundred files hold six hundred records between them where the same reads
 * from one task hold three hundred. Five hundred and twelve was chosen as a per-file working set
 * and would have been half of one the moment a second slot started work - so the fix would have
 * traded a record that answered for the wrong reader for no record at all, which is quieter and
 * just as unguarded. A thousand and twenty-four holds two concurrent tasks at the working set the
 * number was picked for, and the worker leases at most eight (`WORKER_CONCURRENCY` caps there);
 * past that the busiest task evicts the quietest, and what that costs is stated below.
 *
 * Ranges per record: a file read in many small windows would otherwise accumulate one interval per
 * read forever. When the cap is reached the oldest intervals are dropped rather than coalesced -
 * dropping makes the guard stricter and the worst case is one extra refusal that hands over the
 * text, whereas coalescing two intervals into their hull would silently vouch for every line
 * between them.
 *
 * Adjacent windows merge, so the count only grows on reads that leave gaps between them - and a
 * write now adds one interval per span it authored, up to the forty operations a single patch may
 * carry. Thirty-two was inside that: one forty-hunk patch could evict every interval the reads
 * before it had put there, and refuse the next write for lines that had been shown. A hundred and
 * twenty-eight is past what a patch can spend and still four kilobytes per record at worst, so the
 * store is four megabytes full.
 *
 * Both are memory bounds, not correctness bounds: losing a record loses the opinion, never the
 * write. That direction is deliberate. A guard that starts refusing work because a cache filled up
 * is a worse failure than the one it exists to prevent.
 */
const MAX_TRACKED_RECORDS = 1_024;
const MAX_RANGES_PER_PATH = 128;

/**
 * How long a record can vouch for a read, matching the retention horizon the notification sweep
 * uses. It is generous because it is not what makes the record safe - the identity above is. A
 * window read of a file nothing has touched since is as true a day later as it was a second later;
 * the horizon is here so a workspace that is opened once and abandoned does not hold a record for
 * the life of the process.
 */
export const SEEN_LINE_HORIZON_MS = 24 * 60 * 60_000;

/**
 * At most this much of the file is handed back in a refusal, and at most this many lines.
 *
 * The worker reads 4,000 bytes of a runner failure body and no more, so a disclosure that ignored
 * this would be cut in the middle of a line by a layer that cannot say it was. Beyond the line cap
 * the honest answer is different in kind: an edit that rests on more unseen lines than a person
 * would read in a glance is not a slip to be corrected inline, it is a file the model needs to
 * actually look at, and the refusal says which lines to look at instead of dribbling them out a
 * screenful per round trip.
 */
const MAX_DISCLOSED_BYTES = 2_048;
const MAX_DISCLOSED_LINES = 40;

const displayed = new Map<string, Displayed>();

/** Monotonic within the process; only ever compared, never read as a time. */
let sequence = 0;

export const fileIdentity = (details: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): string => `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}`;

/** Adjacent ranges merge: lines 1-50 and 51-60 are one run of seen lines, not two. */
const merge = (ranges: Recorded[]): Recorded[] => {
  const merged: Recorded[] = [];
  for (const range of [...ranges].sort((first, second) => first.start - second.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      last.at = Math.max(last.at, range.at);
    } else merged.push({ ...range });
  }
  return merged;
};

const capRanges = (ranges: Recorded[]): Recorded[] =>
  ranges.length <= MAX_RANGES_PER_PATH
    ? ranges
    : [...ranges]
        .sort((first, second) => second.at - first.at)
        .slice(0, MAX_RANGES_PER_PATH)
        .sort((first, second) => first.start - second.start);

const evict = (now: number): void => {
  for (const [key, record] of displayed)
    if (now - record.recordedAt > SEEN_LINE_HORIZON_MS) displayed.delete(key);
  // Insertion order is recency order: recording a file deletes and re-sets it.
  while (displayed.size > MAX_TRACKED_RECORDS) {
    const oldest = displayed.keys().next();
    if (oldest.done) break;
    displayed.delete(oldest.value);
  }
};

/**
 * Notes that these lines of this exact file were returned to THIS READER whole.
 *
 * "Whole" is the load-bearing word: a line the read cut in half on its byte budget was not
 * displayed, and counting it would vouch for the half that never arrived. "This reader" is the
 * other one: what it records is that one task has these lines in front of it, which is the only
 * thing a read is evidence of.
 */
export const recordDisplayedLines = (
  reader: Reader,
  target: string,
  identity: string,
  range: LineRange,
  now = Date.now()
): void => {
  if (range.start < 1 || range.end < range.start) return;
  const key = keyFor(reader, target);
  const existing = displayed.get(key);
  const previous =
    existing && existing.identity === identity && now - existing.recordedAt <= SEEN_LINE_HORIZON_MS
      ? existing.ranges
      : [];
  displayed.delete(key);
  sequence += 1;
  displayed.set(key, {
    identity,
    recordedAt: now,
    ranges: capRanges(merge([...previous, { start: range.start, end: range.end, at: sequence }]))
  });
  evict(now);
};

/**
 * What this file has shown THIS READER, or `undefined` for "no opinion".
 *
 * The two are not the same and the difference is the whole safety of this: an empty array would
 * mean every line is unseen and every write refused. `undefined` means nothing was recorded, or the
 * record has expired, or the bytes moved under it - and a caller with no opinion writes exactly as
 * it did before this module existed.
 *
 * A reader that has read nothing is therefore in the same position as one this module has never
 * heard of, and that is on purpose: the re-key stops one task's reads answering for another's, and
 * does not invent an opinion where there was none. A first write to a file nobody has read still
 * lands, exactly as it must - see `rememberWrite` on why a write may never be the thing that starts
 * guarding a file. What the concurrent second writer is held by is the compare-and-swap on
 * `expectSha256`, which is a different bound answering a different question.
 */
export const displayedLines = (
  reader: Reader,
  target: string,
  identity: string,
  now = Date.now()
): LineRange[] | undefined => {
  const key = keyFor(reader, target);
  const record = displayed.get(key);
  if (!record) return undefined;
  if (now - record.recordedAt > SEEN_LINE_HORIZON_MS || record.identity !== identity) {
    displayed.delete(key);
    return undefined;
  }
  return record.ranges.map(({ start, end }) => ({ start, end }));
};

/**
 * One span the write replaced, and what took its place. Both ends are 1-indexed and inclusive.
 *
 * `oldTo === oldFrom - 1` removes nothing - a pure insertion before `oldFrom`. `newTo === newFrom -
 * 1` inserts nothing - a pure deletion.
 */
export type Hunk = {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
};

/** What a whole-file replacement did, in lines, from the two versions of the text. */
export type LineEdit = {
  oldLines: number;
  newLines: number;
  /** Every span the write replaced, ascending and non-overlapping. Empty when nothing changed. */
  hunks: readonly Hunk[];
  /**
   * The lines of the old file this edit rests on, and must therefore have been shown. Empty when it
   * rests on nothing: an unchanged write, or the first content of an empty file.
   */
  anchors: readonly LineRange[];
};

/**
 * How deep the split below will look for unchanged text before giving up and calling the rest of a
 * block changed.
 *
 * Only precision is at stake, never safety: every line a shallower answer fails to align is
 * reported as changed, which refuses more and vouches for less. Twenty-four is far past what any
 * real edit reaches - each level needs a nested run of unique lines inside the last one - and it
 * bounds the work at twenty-four passes over the file for a pathological input.
 */
const MAX_SPLIT_DEPTH = 24;

/** The longest run of pairs that ascends in both coordinates, by patience. */
const ascendingRun = (
  pairs: ReadonlyArray<readonly [number, number]>
): Array<readonly [number, number]> => {
  const tails: number[] = [];
  const previous: number[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const value = (pairs[index] as readonly [number, number])[1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const at = tails[mid] as number;
      if ((pairs[at] as readonly [number, number])[1] < value) low = mid + 1;
      else high = mid;
    }
    previous[index] = low > 0 ? (tails[low - 1] as number) : -1;
    tails[low] = index;
  }
  const run: Array<readonly [number, number]> = [];
  for (
    let at = tails.length ? (tails[tails.length - 1] as number) : -1;
    at >= 0;
    at = previous[at] as number
  )
    run.push(pairs[at] as readonly [number, number]);
  return run.reverse();
};

/**
 * Lines that occur exactly once on each side of a block, paired up, longest ascending run kept.
 *
 * A line that is unique in both versions and appears in both is the same line: nothing else it
 * could be. Those pairs are the fixed points the block is split around, which is what turns "one
 * span from the first change to the last" into the several spans an edit actually touched.
 */
const fixedPoints = (
  before: readonly string[],
  after: readonly string[],
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  newTo: number
): Array<readonly [number, number]> => {
  const once = (lines: readonly string[], from: number, to: number): Map<string, number> => {
    const where = new Map<string, number>();
    for (let line = from; line <= to; line += 1) {
      const text = lines[line - 1] as string;
      where.set(text, where.has(text) ? -1 : line);
    }
    return where;
  };
  const inOld = once(before, oldFrom, oldTo);
  const inNew = once(after, newFrom, newTo);
  const pairs: Array<readonly [number, number]> = [];
  for (let line = oldFrom; line <= oldTo; line += 1) {
    const text = before[line - 1] as string;
    if (inOld.get(text) !== line) continue;
    const at = inNew.get(text);
    if (at === undefined || at === -1) continue;
    pairs.push([line, at]);
  }
  return ascendingRun(pairs);
};

/** Splits one block into the spans that really changed, trimming what matches at either end. */
const splitBlock = (
  before: readonly string[],
  after: readonly string[],
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  newTo: number,
  depth: number,
  into: Hunk[]
): void => {
  let firstOld = oldFrom;
  let lastOld = oldTo;
  let firstNew = newFrom;
  let lastNew = newTo;
  while (
    firstOld <= lastOld &&
    firstNew <= lastNew &&
    before[firstOld - 1] === after[firstNew - 1]
  ) {
    firstOld += 1;
    firstNew += 1;
  }
  while (firstOld <= lastOld && firstNew <= lastNew && before[lastOld - 1] === after[lastNew - 1]) {
    lastOld -= 1;
    lastNew -= 1;
  }
  if (firstOld > lastOld && firstNew > lastNew) return;
  if (firstOld > lastOld || firstNew > lastNew || depth >= MAX_SPLIT_DEPTH) {
    into.push({ oldFrom: firstOld, oldTo: lastOld, newFrom: firstNew, newTo: lastNew });
    return;
  }
  const points = fixedPoints(before, after, firstOld, lastOld, firstNew, lastNew);
  if (!points.length) {
    into.push({ oldFrom: firstOld, oldTo: lastOld, newFrom: firstNew, newTo: lastNew });
    return;
  }
  let old = firstOld;
  let fresh = firstNew;
  for (const [atOld, atNew] of points) {
    splitBlock(before, after, old, atOld - 1, fresh, atNew - 1, depth + 1, into);
    old = atOld + 1;
    fresh = atNew + 1;
  }
  splitBlock(before, after, old, lastOld, fresh, lastNew, depth + 1, into);
};

/**
 * The spans an edit rests on, recovered from the two versions of the file.
 *
 * A patch is a whole-file write by the time it reaches the runner, so the runner recovers the edit
 * rather than being told it - which means this guard needs no cooperation from the caller and
 * cannot be turned off by one.
 *
 * IT IS SEVERAL SPANS AND NOT ONE, and that is the whole of this function. Walking in from both
 * ends alone reports the hull from the first change to the last, which is a lie about any edit that
 * touches two places: measured on a 400-line file with lines 1-50 and 300-350 displayed, one write
 * changing line 20 and line 320 - both of them lines a read had shown - was refused with "this edit
 * changes app.ts at line 51-299", naming 249 lines it does not change. A guard that refuses
 * legitimate work gets deleted by the first person it inconveniences. So the block between the
 * matching ends is split again around the lines that are unique to both versions, and what is left
 * over is what actually moved.
 *
 * The direction of the imprecision is fixed and deliberate. A line reported as changed that was not
 * costs a refusal the caller can lift by reading; a line reported as unchanged that was not would
 * vouch for text nobody has seen. Every fixed point is a line present in BOTH versions, so a line
 * this calls unchanged is a line the write kept - never a line it destroyed.
 *
 * A pure insertion replaces nothing, so it has no changed span of its own. It still rests on
 * something: the two lines it was slid between. An append to a file whose end was never displayed
 * is the same blind edit as a replacement, and reporting no anchors for it would let exactly that
 * case through.
 */
export const lineEdit = (before: string[], after: string[]): LineEdit => {
  const oldLines = before.length;
  const newLines = after.length;
  const hunks: Hunk[] = [];
  splitBlock(before, after, 1, oldLines, 1, newLines, 0, hunks);
  const anchors: LineRange[] = [];
  if (oldLines > 0)
    for (const hunk of hunks) {
      const span =
        hunk.oldTo >= hunk.oldFrom
          ? { start: hunk.oldFrom, end: hunk.oldTo }
          : { start: Math.max(1, hunk.oldFrom - 1), end: Math.min(oldLines, hunk.oldFrom) };
      if (span.end >= span.start) anchors.push(span);
    }
  return { oldLines, newLines, hunks, anchors };
};

/** The parts of `span` no range in `seen` covers, in order, as ranges rather than as lines. */
export const unseenWithin = (span: LineRange, seen: LineRange[]): LineRange[] => {
  const gaps: LineRange[] = [];
  let cursor = span.start;
  for (const range of [...seen].sort((first, second) => first.start - second.start)) {
    if (range.end < cursor) continue;
    if (range.start > span.end) break;
    if (range.start > cursor) gaps.push({ start: cursor, end: range.start - 1 });
    cursor = Math.max(cursor, range.end + 1);
    if (cursor > span.end) return gaps;
  }
  if (cursor <= span.end) gaps.push({ start: cursor, end: span.end });
  return gaps;
};

/**
 * The real text at the lines the caller never saw, ready to be read straight out of the refusal.
 *
 * A refusal that costs a round trip is barely better than the wrong edit it prevented: the model
 * re-reads, re-derives the same patch, and the owner pays for two turns to get one edit. Handing
 * back the text means the retry needs no read at all.
 *
 * `undefined` when the gap is too wide to hand over - see the caps above. That case is not a
 * failure to disclose, it is a different answer: go and read it.
 */
export const discloseUnseen = (
  before: string[],
  gaps: LineRange[]
): { text: string; disclosed: LineRange[] } | undefined => {
  const total = gaps.reduce((sum, gap) => sum + (gap.end - gap.start + 1), 0);
  if (total === 0 || total > MAX_DISCLOSED_LINES) return undefined;
  const rendered: string[] = [];
  const disclosed: LineRange[] = [];
  let bytes = 0;
  for (const gap of gaps) {
    let last = gap.start - 1;
    for (let line = gap.start; line <= gap.end; line += 1) {
      const row = `${line}| ${before[line - 1] ?? ''}`;
      const cost = Buffer.byteLength(row, 'utf8') + 1;
      if (bytes + cost > MAX_DISCLOSED_BYTES) break;
      bytes += cost;
      rendered.push(row);
      last = line;
    }
    if (last >= gap.start) disclosed.push({ start: gap.start, end: last });
    if (last < gap.end) break;
  }
  // One line wider than the whole budget discloses nothing, and "go and read it" is then the only
  // answer that can terminate.
  if (!rendered.length) return undefined;
  return { text: rendered.join('\n'), disclosed };
};

export const sayRanges = (ranges: LineRange[]): string =>
  ranges
    .map((range) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`))
    .join(', ');

/**
 * Carries a record across the write that has just landed, so a second edit to the same file in the
 * same turn is still guarded.
 *
 * Without this the guard is one edit deep per file: the write changes size and modification time,
 * the identity stops matching, the record is void, and the next patch - the one aimed at line 300
 * after the first one tidied line 20 - goes through unexamined. Every stretch the write left alone
 * keeps its lines, at the numbers the hunks before it shifted them to, and each span the caller
 * actually authored is added: it wrote those lines, so it has seen them.
 *
 * WHAT IT ADDS IS THE AUTHORED SPANS AND NOT THE FILE. The two are the same thing only for a
 * caller that supplied the whole file from nothing, and a line-addressed patch is the opposite of
 * that: it authored a span and reproduced the rest. Recording the file would mean one successful
 * patch vouched for every line of it, which is a licence to edit anywhere - and to discard
 * everything - for the rest of the turn.
 *
 * A file with no record gains none. A write must never be the thing that starts guarding a file,
 * or the file browser - which reads whole files and writes them back, and never reads a window -
 * would find its second save refused for lines its first save had not touched.
 *
 * It carries THIS WRITER'S record and no other. Another task's record of the same file is left
 * where it is, to be found stale by its own identity check the next time that task is asked about:
 * this write moved the bytes, so line 300 is no longer the line 300 that task was shown, and
 * shifting its ranges by hunks it never saw would be this module inventing a reading for it.
 */
export const rememberWrite = (
  reader: Reader,
  target: string,
  identity: string,
  edit: LineEdit,
  now = Date.now()
): void => {
  const key = keyFor(reader, target);
  const record = displayed.get(key);
  if (!record) return;
  const carried: Recorded[] = [];
  /** The seen lines inside one untouched stretch of the old file, at their new numbers. */
  const carry = (from: number, to: number, by: number): void => {
    for (const range of record.ranges) {
      const start = Math.max(range.start, from);
      const end = Math.min(range.end, to);
      if (end >= start) carried.push({ start: start + by, end: end + by, at: range.at });
    }
  };
  let cursor = 1;
  let shift = 0;
  for (const hunk of edit.hunks) {
    if (hunk.oldFrom - 1 >= cursor) carry(cursor, hunk.oldFrom - 1, shift);
    if (hunk.newTo >= hunk.newFrom) {
      sequence += 1;
      carried.push({ start: hunk.newFrom, end: hunk.newTo, at: sequence });
    }
    shift += hunk.newTo - hunk.newFrom - (hunk.oldTo - hunk.oldFrom);
    cursor = hunk.oldTo + 1;
  }
  if (cursor <= edit.oldLines) carry(cursor, edit.oldLines, shift);
  displayed.delete(key);
  displayed.set(key, {
    identity,
    recordedAt: now,
    ranges: capRanges(merge(carried))
  });
  evict(now);
};

/** Drops every record. Only a test that wants a cold store has any business calling it. */
export const forgetDisplayedLines = (): void => displayed.clear();
