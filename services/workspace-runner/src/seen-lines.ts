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
 * Both are memory bounds, not correctness bounds: losing a record loses the opinion, never the
 * write. That direction is deliberate. A guard that starts refusing work because a cache filled up
 * is a worse failure than the one it exists to prevent.
 */
const MAX_TRACKED_PATHS = 512;
const MAX_RANGES_PER_PATH = 32;

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

/** What a whole-file replacement did, in lines, from the two versions of the text. */
export type LineEdit = {
  /** Lines unchanged at the head, and at the tail, of the old file. */
  prefix: number;
  suffix: number;
  oldLines: number;
  newLines: number;
  /** How many lines longer the new file is; negative when it is shorter. */
  delta: number;
  /**
   * The lines of the old file this edit rests on, and must therefore have been shown. `undefined`
   * when it rests on nothing: an unchanged write, or the first content of an empty file.
   */
  anchors: LineRange | undefined;
};

/**
 * The span an edit rests on, found by walking in from both ends.
 *
 * A patch is a whole-file write by the time it reaches the runner, so the runner recovers the edit
 * rather than being told it - which means this guard needs no cooperation from the caller and
 * cannot be turned off by one. Matching prefix and suffix bound the change exactly, and everything
 * between them is text the caller replaced and therefore had to be looking at.
 *
 * A pure insertion replaces nothing, so it has no changed span of its own. It still rests on
 * something: the two lines it was slid between. An append to a file whose end was never displayed
 * is the same blind edit as a replacement, and reporting no anchors for it would let exactly that
 * case through.
 */
export const lineEdit = (before: string[], after: string[]): LineEdit => {
  const oldLines = before.length;
  const newLines = after.length;
  let prefix = 0;
  while (prefix < oldLines && prefix < newLines && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines - prefix &&
    suffix < newLines - prefix &&
    before[oldLines - 1 - suffix] === after[newLines - 1 - suffix]
  )
    suffix += 1;
  const start = prefix + 1;
  const end = oldLines - suffix;
  const anchors =
    end >= start
      ? { start, end }
      : // Nothing was replaced. Either the two files are identical - prefix and suffix cover the
        // whole of an old file the same length as the new one - or lines were inserted, and the
        // insertion point is what the caller aimed at.
        oldLines === 0 || oldLines === newLines
        ? undefined
        : { start: Math.max(1, prefix), end: Math.min(oldLines, prefix + 1) };
  return { prefix, suffix, oldLines, newLines, delta: newLines - oldLines, anchors };
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
 * after the first one tidied line 20 - goes through unexamined. Lines before the change keep their
 * numbers, lines after it shift by the change in length, and the lines the caller has just written
 * are seen by definition: it authored them.
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
  const tailStart = edit.oldLines - edit.suffix + 1;
  for (const range of record.ranges) {
    const headEnd = Math.min(range.end, edit.prefix);
    if (headEnd >= range.start) carried.push({ start: range.start, end: headEnd, at: range.at });
    const tail = Math.max(range.start, tailStart);
    if (range.end >= tail)
      carried.push({ start: tail + edit.delta, end: range.end + edit.delta, at: range.at });
  }
  const authoredEnd = edit.newLines - edit.suffix;
  if (authoredEnd >= edit.prefix + 1) {
    sequence += 1;
    carried.push({ start: edit.prefix + 1, end: authoredEnd, at: sequence });
  }
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
