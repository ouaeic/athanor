/**
 * Applying a line-addressed patch, and refusing one that cannot be applied honestly.
 *
 * The editor this replaces proved an edit was fresh by making the model quote the text it was
 * replacing: if the quote was not there exactly once, nothing landed. That proof was carried in
 * output tokens, on every hunk, inflated by whatever it took to be unique.
 *
 * Here the proof is carried by the HARNESS. `snapshots.ts` remembers the exact lines a read put in
 * front of the model, so at apply time there are two texts to compare - what was shown, and what is
 * on disk now - and the range needs to carry no evidence at all. That is strictly stronger than a
 * quote: a quote is the model's memory of the file, and a snapshot is the harness's record of what
 * it actually sent.
 *
 * FORGIVENESS IS THE POINT, and it is built before the format rather than bolted onto it. The
 * measured 61% saving is an upper bound available only to a model that emits the dialect perfectly;
 * a round trip spent on a miscounted anchor costs a whole generation and eats the saving several
 * times over. So every failure mode of a line-addressed dialect is answered here without a second
 * read:
 *
 *   - A DROPPED HEADER costs nothing, because there is no header. The path is a field of the call.
 *   - A MISCOUNTED ANCHOR is caught and the correction is IN the refusal: every refusal carries the
 *     file's real text, numbered, around the lines that were addressed. The retry is a re-emit, not
 *     a re-read.
 *   - A SHIFTED FILE - somebody else wrote to it between the read and the edit - is recovered
 *     rather than refused: the recorded lines are found again by content and the edit lands where
 *     the model meant it, with the shift reported.
 *   - AN OFF-BY-ONE is the single most likely error, and it gets the most deliberate answer of the
 *     lot. See `placeWithEvidence` below.
 *   - WHITESPACE, CRLF AND TRAILING SPACES never invalidate an anchor: every comparison in this
 *     file goes through `sameLine`.
 *
 * A patch is ATOMIC per file. The quoted editor applied the hunks that matched and reported the
 * ones that did not, which is right for independent quoted edits and wrong here: half a patch
 * applied means every remaining number in the model's head is off by the delta, so the retry is
 * worse than the failure.
 */
import { blockAt } from './block.js';
import { normaliseLine, numberedWindow, sameLine, sameLines, sayRange, toLines } from './format.js';
import { parseEdit, type EditOp, type ParseFailure } from './parse.js';
import { type LineChange, type Snapshot } from './snapshots.js';

export type EditRefusal =
  | ParseFailure
  | { readonly kind: 'unseen'; readonly message: string }
  | { readonly kind: 'out_of_range'; readonly message: string }
  | { readonly kind: 'moved'; readonly message: string }
  | { readonly kind: 'evidence'; readonly message: string }
  | { readonly kind: 'block_open'; readonly message: string }
  | { readonly kind: 'overlap'; readonly message: string }
  | { readonly kind: 'register'; readonly message: string };

export type EditResult =
  | {
      readonly ok: true;
      /** The file afterwards. */
      readonly text: string;
      /** Line ranges of the new file the patch wrote, for the echo the result carries back. */
      readonly wrote: ReadonlyArray<{ from: number; to: number }>;
      /**
       * Every span this patch replaced, in both numberings, ascending.
       *
       * The ledger needs the OLD numbers as well as the new ones: it is holding ranges of the file
       * as it was read, and to carry them across this write it has to know which of them this patch
       * removed and how far the rest moved. `wrote` cannot answer that - it says where the new text
       * is and not what it displaced.
       */
      readonly changed: readonly LineChange[];
      /** Spellings forgiven and anchors corrected, in the words the model gets back. */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly refusal: EditRefusal };

/** How much of the live file a refusal hands back on each side of the anchor. */
const CONTEXT_LINES = 8;

/**
 * How far an anchor may be corrected when the model supplied evidence for where it meant to be.
 *
 * Three lines, because an off-by-one is what this is for and an off-by-three is the outside edge of
 * a miscount a model makes while counting a header or a blank line. Beyond that, "I found your text
 * somewhere else in the file" stops being a correction and becomes a guess about intent, and a
 * guess about intent is how a format like this corrupts code.
 */
const CORRECTION_RADIUS = 3;

interface Placement {
  readonly from: number;
  readonly to: number;
  readonly note?: string;
}

/** Every one-based inclusive window of `live` whose lines equal `wanted`, up to two of them. */
const occurrences = (live: readonly string[], wanted: readonly string[]): number[] => {
  const hits: number[] = [];
  if (!wanted.length) return hits;
  for (let index = 0; index + wanted.length <= live.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1)
      if (!sameLine(live[index + offset] ?? '', wanted[offset] ?? '')) {
        same = false;
        break;
      }
    if (same) {
      hits.push(index + 1);
      if (hits.length > 1) return hits;
    }
  }
  return hits;
};

/** The recorded text of file lines `from..to`, or undefined when this read never showed them. */
const shown = (snapshot: Snapshot, from: number, to: number): readonly string[] | undefined => {
  const first = from - snapshot.startLine;
  const last = to - snapshot.startLine;
  if (first < 0 || last >= snapshot.lines.length || last < first) return undefined;
  return snapshot.lines.slice(first, last + 1);
};

/**
 * Where an addressed range actually is in the live file, and why.
 *
 * Tried in this order, because each step is a weaker claim than the one before it:
 *
 *   1. THE NUMBERS ARE LIVE. What the read showed at those lines is still what is there. Nothing to
 *      recover; this is the overwhelmingly common case and it costs one comparison.
 *   2. THE FILE SHIFTED. The recorded text is somewhere else in the live file, exactly once. The
 *      model is not wrong; the file moved under it, and refusing would send it back to read a file
 *      whose contents it already knows. Applied, and the shift is reported.
 *   3. NOTHING, and that is a refusal - the recorded text is gone (somebody rewrote that region) or
 *      duplicated (there is no unambiguous answer). Guessing here is the one failure that corrupts
 *      code rather than wasting a round trip.
 */
const placeRange = (
  live: readonly string[],
  snapshot: Snapshot,
  from: number,
  to: number
): Placement | undefined => {
  const wanted = shown(snapshot, from, to);
  if (!wanted) return undefined;
  const here = live.slice(from - 1, to);
  if (sameLines(here, wanted)) return { from, to };
  const hits = occurrences(live, wanted);
  if (hits.length !== 1) return undefined;
  const at = hits[0] as number;
  return {
    from: at,
    to: at + wanted.length - 1,
    note: `${sayRange(from, to)} had moved to ${sayRange(at, at + wanted.length - 1)} since you read it; the edit followed the text and landed there`
  };
};

/**
 * The deliberate answer to an off-by-one, which is the error this format is most likely to meet.
 *
 * There are two cases and they get opposite answers, because the difference between them is whether
 * the harness has evidence or is guessing.
 *
 * WITH EVIDENCE - the model wrote `-` rows, or a whole unified-diff hunk, saying what it believes it
 * is replacing. That is not noise to be stripped: it is a statement of intent the harness can check.
 * If the claimed text is not at the addressed lines but IS within a few lines of them, exactly once,
 * then the model's numbers are off and its intent is not in doubt. The anchor is corrected, the edit
 * lands, and the correction is reported in the result. Refusing here would be refusing an edit whose
 * meaning is written out in the patch itself.
 *
 * WITHOUT EVIDENCE - `PUT 40.=42:` and three `+` rows. Nothing in the patch says what the model
 * thought was at 40. An off-by-one is then INDISTINGUISHABLE from a correct edit, and every
 * available response to it is wrong in one direction or the other. Silently accepting it is
 * corruption. Refusing every plain range would be refusing the format. So it is accepted, and the
 * result carries back the numbered text of what was written with a line of context on each side, so
 * a model that miscounted sees it on the same turn and fixes it with one more edit rather than
 * discovering it when the tests run. Report-after, because guess-before is not available.
 *
 * The claimed text is also allowed to be a different LENGTH from the addressed range - a model that
 * writes four `-` rows under `PUT 40.=42:` has miscounted the range, not the text, and the text is
 * the better evidence of the two.
 */
const placeWithEvidence = (
  live: readonly string[],
  placed: Placement,
  claimed: readonly string[]
): Placement | { refusal: string } => {
  if (!claimed.length) return placed;
  const here = live.slice(placed.from - 1, placed.to);
  if (sameLines(here, claimed)) return placed;
  /*
   * THE CORRECTION IS LOOKED FOR IN THE WINDOW IT IS ALLOWED TO REACH, NOT IN THE WHOLE FILE.
   *
   * This searched the entire file and gave up unless the quoted text occurred exactly once in it -
   * so on `src/queue.ts`, which says `if (!job) return null;` three times, an off-by-one whose
   * quote named the right line was REFUSED. The recovery had inherited the exact requirement the
   * format was bought to escape: text that has to be unique across a file the model did not choose
   * the repetitiveness of. And the refusal fell on the file shape the whole 61% was measured on.
   *
   * `CORRECTION_RADIUS` was already the only distance an anchor could be moved, so the whole-file
   * search was never able to use a hit outside this window anyway: it could only turn one into a
   * refusal. Searching the window instead is strictly narrower in reach and strictly wider in
   * recovery, and ambiguity INSIDE the window is still a refusal, which is the case that matters.
   */
  const low = Math.max(1, placed.from - CORRECTION_RADIUS);
  const high = Math.min(live.length, placed.from + CORRECTION_RADIUS + claimed.length - 1);
  const near = occurrences(live.slice(low - 1, high), claimed).map((at) => at + low - 1);
  const hits = near.length === 1 ? near : occurrences(live, claimed);
  if (hits.length === 1) {
    const at = hits[0] as number;
    const distance = Math.abs(at - placed.from);
    if (distance <= CORRECTION_RADIUS) {
      const to = at + claimed.length - 1;
      return {
        from: at,
        to,
        note:
          distance === 0
            ? `the lines you quoted run ${sayRange(at, to)}, one line ${claimed.length > here.length ? 'longer' : 'shorter'} than the range you wrote; the quoted lines are what was replaced`
            : `the lines you quoted are at ${sayRange(at, to)}, not ${sayRange(placed.from, placed.to)} - your anchor was off by ${distance}. The quoted lines are what was replaced; count from the numbers in the read`
      };
    }
    return {
      refusal: `The lines you quoted are at ${sayRange(at, at + claimed.length - 1)}, but you addressed ${sayRange(placed.from, placed.to)} - ${distance} lines away, which is too far to correct without guessing at what you meant. Send the same body against ${sayRange(at, at + claimed.length - 1)}. The file now reads:\n\n${numberedWindow(live, { from: Math.min(at, placed.from), to: Math.max(at + claimed.length - 1, placed.to) }, CONTEXT_LINES)}`
    };
  }
  return {
    refusal: `You quoted ${hits.length ? 'text that appears more than once' : 'text that is not in the file'}, and ${sayRange(placed.from, placed.to)} does not hold it either, so nothing was written. Here is what is actually at those lines:\n\n${numberedWindow(live, placed, CONTEXT_LINES)}`
  };
};

interface Splice {
  readonly start: number;
  readonly remove: number;
  readonly insert: readonly string[];
  readonly order: number;
  readonly kind: EditOp['kind'];
}

/** The lines an operation rests on, in the numbering the model addressed it with. */
const spanOf = (
  op: EditOp,
  snapshot: Snapshot
): { from: number; to: number; closed?: boolean } | undefined => {
  switch (op.kind) {
    case 'replace':
    case 'cut':
      return { from: op.from, to: op.to };
    case 'block': {
      const found = blockAt(snapshot.lines, op.at - snapshot.startLine);
      return {
        from: found.from + snapshot.startLine,
        to: found.to + snapshot.startLine,
        closed: found.closed
      };
    }
    case 'insert':
    case 'paste':
      return { from: op.at, to: op.at };
    default:
      return undefined;
  }
};

/**
 * Applies one file's patch.
 *
 * `reads` is every read of this file this task remembers, newest last. Each operation is resolved
 * against the newest read that actually displayed the lines it addresses, so a turn that read a
 * file twice can still edit against either set of numbers without saying which.
 */
export const applyEdit = (
  path: string,
  patch: string,
  liveText: string,
  reads: readonly Snapshot[]
): EditResult => {
  const parsed = parseEdit(patch);
  if (!parsed.ok) return { ok: false, refusal: parsed.failure };
  const notes = [...parsed.forgave];
  const live = toLines(liveText);
  const ops = parsed.ops;

  const lineOps = ops;
  const newest = [...reads].sort((left, right) => right.at - left.at);
  const splices: Splice[] = [];
  const registers = new Map<string, readonly string[]>();

  /*
   * A range no read displayed is a range the model is guessing at, and the refusal below carries
   * the real text at those lines so the retry is a re-emit rather than a re-derivation.
   *
   * IT IS NOT A DISPLAY THAT COUNTS. `services/workspace-runner/src/seen-lines.ts` records what its
   * refusal handed over, so the identical call sent again applies there; nothing here records
   * anything, so the identical call sent again is refused again. Both messages used to say "send it
   * again" and only one of them meant it. Either the disclosure is recorded or the message names
   * the read - and recording it here would mean vouching for a window whose width is set by the
   * range the model addressed, in a result that may carry forty of them and is cut to
   * `RECENT_TOOL_OUTPUT_CHARS` two layers downstream, which is the same over-claim this ledger
   * exists to remove. So the message names the read.
   */
  // Registers are filled from the live file before anything moves, so a CUT and the PUT that pastes
  // it can be written in either order and mean the same thing.
  const placements = new Map<EditOp, Placement>();

  for (const op of lineOps) {
    const anySnapshot = newest[0];
    if (!anySnapshot) {
      /*
       * No read of this file at all, which is the one refusal that used to cost a SECOND round trip
       * - it said "read the file and address those numbers" and quoted nothing, so the retry was a
       * read and then a re-emit. But this arm has just read the file itself in order to patch it,
       * and the branch eight lines below already hands back the live text when a read exists and
       * did not cover the anchor. Quoting here too makes every refusal in this file cost exactly one
       * generation, which is the property the whole format is bought on; leaving one branch out of
       * it was the difference between "malformed emissions cost nothing extra" being a claim and
       * being true.
       */
      const asked =
        op.kind === 'replace' || op.kind === 'cut'
          ? { from: op.from, to: op.to }
          : { from: op.at, to: op.at };
      return {
        ok: false,
        refusal: {
          kind: 'unseen',
          message: `No read of ${path} is on record for this task, so the line numbers in this patch are not from anything you have been shown here. The file has ${live.length} lines. Read the lines you are aiming at with file_read, using startLine and endLine - that is what puts them on record here - and send the patch again. This is what is actually at the lines you addressed:\n\n${numberedWindow(live, asked, CONTEXT_LINES)}`
        }
      };
    }

    // The block operation needs the file's own shape, so it is resolved against the read rather
    // than against the addressed numbers alone.
    let span: { from: number; to: number; closed?: boolean } | undefined;
    let against: Snapshot | undefined;
    for (const snapshot of newest) {
      const candidate = spanOf(op, snapshot);
      if (!candidate) continue;
      if (shown(snapshot, candidate.from, candidate.to) === undefined) continue;
      span = candidate;
      against = snapshot;
      break;
    }
    if (!span || !against) {
      const asked = spanOf(op, anySnapshot) ?? { from: 0, to: 0 };
      const at = op.kind === 'insert' || op.kind === 'paste' ? op.at : asked.from;
      if (at > live.length + 1 || at < 1)
        return {
          ok: false,
          refusal: {
            kind: 'out_of_range',
            message: `${path} has ${live.length} lines, and this patch addresses line ${at}. The last lines of the file are:\n\n${numberedWindow(live, { from: live.length, to: live.length }, CONTEXT_LINES)}`
          }
        };
      return {
        ok: false,
        refusal: {
          kind: 'unseen',
          message: `No read has shown you ${path} at ${sayRange(asked.from, asked.to)}, so editing there would land on whatever happens to be at those numbers. Read that range with file_read, using startLine and endLine - that is what puts it on record here, and sending this patch again without doing so is refused again. Here is what is actually there, to check your edit against:\n\n${numberedWindow(live, asked, CONTEXT_LINES)}`
        }
      };
    }
    if (op.kind === 'block' && span.closed === false)
      return {
        ok: false,
        refusal: {
          kind: 'block_open',
          message: `The block opening at ${path} line ${op.at} does not close within the lines you have been shown, so replacing it would either stop short or run past its end. Read further, or replace an explicit range with PUT ${op.at}.=M:. What was read there:\n\n${numberedWindow(against.lines, { from: op.at - against.startLine + 1, to: op.at - against.startLine + 1 }, CONTEXT_LINES)}`
        }
      };

    /*
     * An insert hangs off ONE line, and one line is very often `}` or a blank - not unique enough
     * to find again if the file has shifted. So the anchor for an insert is widened to the lines
     * around it before it is relocated, and the insertion point is derived back from wherever that
     * run landed. Without this, an insert is the one operation a shifted file cannot recover.
     */
    let placed: Placement | undefined;
    if (op.kind === 'insert' || op.kind === 'paste') {
      const direct = placeRange(live, against, op.at, op.at);
      if (direct && !direct.note) placed = direct;
      else {
        const low = Math.max(against.startLine, op.at - 2);
        const high = Math.min(against.startLine + against.lines.length - 1, op.at + 2);
        const wide = placeRange(live, against, low, high);
        if (wide)
          placed = {
            from: wide.from + (op.at - low),
            to: wide.from + (op.at - low),
            ...(wide.note ? { note: wide.note } : {})
          };
        else placed = direct;
      }
    } else placed = placeRange(live, against, span.from, span.to);

    if (!placed)
      return {
        ok: false,
        refusal: {
          kind: 'moved',
          message: `${path} has changed since you read it, and the lines you read at ${sayRange(span.from, span.to)} are no longer there - that text is gone or now appears more than once, so there is no unambiguous place for this edit. Nothing was written. The file now reads:\n\n${numberedWindow(live, span, CONTEXT_LINES)}`
        }
      };
    if (placed.note) notes.push(placed.note);

    if (op.kind === 'replace' || op.kind === 'cut') {
      const checked = placeWithEvidence(live, placed, op.old);
      if ('refusal' in checked)
        return { ok: false, refusal: { kind: 'evidence', message: checked.refusal } };
      if (checked.note) notes.push(checked.note);
      placed = checked;
    }
    placements.set(op, placed);
    if (op.kind === 'cut' && op.register) {
      /*
       * A SECOND CUT INTO A FILLED REGISTER IS A REFUSAL, not a last-wins overwrite.
       *
       * `registers.set` used to overwrite, so `CUT a @x / CUT b @x / PUT >N @x` deleted both blocks
       * and pasted only the second one back: two hundred lines gone, `ok: true`, and an empty
       * notes array. It is the shape a model reaches for when told to gather two helpers together,
       * and it is the worst failure this vertical can have - silent data loss reported as success.
       * Caught by the ruling gate driving the shape rather than reading a table.
       *
       * Refusing rather than appending, because appending would have to guess whether the second
       * block goes above or below the first, and a guess about intent is exactly what the rest of
       * this file refuses to make. Nothing has been written at this point.
       */
      if (registers.has(op.register))
        return {
          ok: false,
          refusal: {
            kind: 'register',
            message: `Two CUTs in this patch both hold their lines as @${op.register}, so the first block would be deleted and never pasted back. Give them different names - CUT ... @${op.register}1 and CUT ... @${op.register}2 - and paste each one. Nothing was written. The second block reads:\n\n${numberedWindow(live, placed, 0)}`
          }
        };
      registers.set(op.register, live.slice(placed.from - 1, placed.to));
    }
  }

  for (const [order, op] of lineOps.entries()) {
    const placed = placements.get(op);
    if (!placed) continue;
    switch (op.kind) {
      case 'replace':
      case 'block':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: op.body,
          order,
          kind: op.kind
        });
        break;
      case 'cut':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: [],
          order,
          kind: op.kind
        });
        break;
      case 'insert':
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: 0,
          insert: op.body,
          order,
          kind: op.kind
        });
        break;
      case 'paste': {
        const value = registers.get(op.register);
        if (!value)
          return {
            ok: false,
            refusal: {
              kind: 'register',
              /*
               * The two intents, shown apart, because naming the rule was not enough to recover
               * from. Measured on the box: a turn asked to add a `split` function wrote
               * `PUT >N @split` four times in a row, was told the register was never filled each
               * time, and rewrote the same patch each time until the repeated-failure bound
               * stopped it. The register sigil reads as a LABEL for the edit - and the register
               * is very often named after the thing being written, which makes it read that way
               * even harder - when it actually means "paste back what a CUT is holding".
               *
               * So the refusal now separates writing new lines from moving lines you have read,
               * and gives the shape of each at the line the patch was already addressing. It
               * costs nothing resident: this text exists only on the failure that needs it.
               */
              message: [
                `@${op.register} was never filled: a PUT that pastes a register needs a CUT N.=M @${op.register} in the same patch. Nothing was written.`,
                'To write NEW lines, leave the register off and give the lines in the body:',
                `  PUT ${op.side === 'before' ? '<' : '>'}${op.at}:`,
                '  <the lines you want written>',
                `To MOVE lines you have already read, cut them first and paste in the same patch:`,
                `  CUT 40.=52 @${op.register}`,
                `  PUT ${op.side === 'before' ? '<' : '>'}${op.at} @${op.register}`
              ].join('\n')
            }
          };
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: value.length ? 0 : 0,
          insert: value,
          order,
          kind: op.kind
        });
        break;
      }
    }
  }

  /*
   * Applied from the end of the file backwards, so every range still names the line it named when
   * the model wrote it. Ranges address the file as it was READ, never the file as the patch's own
   * earlier operations left it - which is the counting error this format exists to remove, and
   * which a front-to-back applier would silently reintroduce on every multi-hunk patch.
   */
  const sorted = [...splices].sort((left, right) =>
    left.start === right.start ? right.order - left.order : right.start - left.start
  );
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const later = sorted[index] as Splice;
    const earlier = sorted[index + 1] as Splice;
    if (earlier.start + earlier.remove > later.start)
      return {
        ok: false,
        refusal: {
          kind: 'overlap',
          message: `Two operations in this patch touch the same lines of ${path} (${earlier.start + 1} and ${later.start + 1}). Ranges name the lines of the file you read and must not overlap; write one operation covering both. Nothing was written.`
        }
      };
  }

  const out = [...live];
  const wrote: Array<{ from: number; to: number }> = [];
  for (const splice of sorted) {
    out.splice(splice.start, splice.remove, ...splice.insert);
    // The echo below reports the NEW numbering, and splices run back to front, so everything
    // already recorded sits after this one and shifts by exactly this operation's delta.
    const delta = splice.insert.length - splice.remove;
    for (const region of wrote) {
      region.from += delta;
      region.to += delta;
    }
    if (splice.insert.length)
      wrote.unshift({ from: splice.start + 1, to: splice.start + splice.insert.length });
    else wrote.unshift({ from: Math.max(1, splice.start), to: Math.max(1, splice.start + 1) });
  }
  /*
   * The same splices again, front to back, in the two numberings the ledger needs.
   *
   * This is what the record is carried across, and it is derived here rather than diffed back out
   * of the two texts because this function is the one place that knows exactly what it moved. A
   * splice that inserts and removes nothing at line N reports `oldTo = oldFrom - 1`, which is the
   * shape an insertion has everywhere in this vertical.
   */
  const changed: LineChange[] = [];
  let moved = 0;
  for (const splice of [...splices].sort((left, right) =>
    left.start === right.start ? left.order - right.order : left.start - right.start
  )) {
    const oldFrom = splice.start + 1;
    const newFrom = oldFrom + moved;
    changed.push({
      oldFrom,
      oldTo: splice.start + splice.remove,
      newFrom,
      newTo: newFrom + splice.insert.length - 1
    });
    moved += splice.insert.length - splice.remove;
  }
  // De-duplicated because one operation can be forgiven twice for the same reason - a relocation
  // reported once by the placement and once again by the evidence check that passed it through -
  // and a result that says the same sentence twice reads as two different findings.
  return { ok: true, text: out.join('\n'), wrote, changed, notes: [...new Set(notes)] };
};

export { normaliseLine, numberedWindow };
