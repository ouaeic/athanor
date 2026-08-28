/**
 * Which lines of a file were actually put in front of the model, so an edit cannot rest on a line
 * it never saw.
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
 * Nothing here is a fact about the file - that is `files.ts` and the filesystem. This module holds
 * only the record of what was shown, the arithmetic of which lines an edit rests on, and the
 * refusal's text.
 */

/** A closed, 1-indexed line range. `start` and `end` are both lines that exist. */
export type LineRange = { start: number; end: number };

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
 * Paths: an LRU of the files recently read in windows, which is a working set, not a history.
 * Ranges per path: a file read in many small windows would otherwise accumulate one interval per
 * read forever. When the cap is reached the oldest intervals are dropped rather than coalesced -
 * dropping makes the guard stricter and the worst case is one extra refusal that hands over the
 * text, whereas coalescing two intervals into their hull would silently vouch for every line
 * between them.
 *
 * Adjacent windows merge, so the count only grows on reads that leave gaps between them - and a
 * write now adds one interval per span it authored, up to the forty operations a single patch may
 * carry. Thirty-two was inside that: one forty-hunk patch could evict every interval the reads
 * before it had put there, and refuse the next write for lines that had been shown. A hundred and
 * twenty-eight is past what a patch can spend and still four kilobytes per path at worst.
 *
 * Both are memory bounds, not correctness bounds: losing a record loses the opinion, never the
 * write. That direction is deliberate. A guard that starts refusing work because a cache filled up
 * is a worse failure than the one it exists to prevent.
 */
const MAX_TRACKED_PATHS = 512;
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
  // Insertion order is recency order: recording a path deletes and re-sets it.
  while (displayed.size > MAX_TRACKED_PATHS) {
    const oldest = displayed.keys().next();
    if (oldest.done) break;
    displayed.delete(oldest.value);
  }
};

/**
 * Notes that these lines of this exact file were returned to a caller whole.
 *
 * "Whole" is the load-bearing word: a line the read cut in half on its byte budget was not
 * displayed, and counting it would vouch for the half that never arrived.
 */
export const recordDisplayedLines = (
  key: string,
  identity: string,
  range: LineRange,
  now = Date.now()
): void => {
  if (range.start < 1 || range.end < range.start) return;
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
 * What this file has shown, or `undefined` for "no opinion".
 *
 * The two are not the same and the difference is the whole safety of this: an empty array would
 * mean every line is unseen and every write refused. `undefined` means nothing was recorded, or the
 * record has expired, or the bytes moved under it - and a caller with no opinion writes exactly as
 * it did before this module existed.
 */
export const displayedLines = (
  key: string,
  identity: string,
  now = Date.now()
): LineRange[] | undefined => {
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
 */
export const rememberWrite = (
  key: string,
  identity: string,
  edit: LineEdit,
  now = Date.now()
): void => {
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
