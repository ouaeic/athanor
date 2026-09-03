/**
 * Every way a model can get the line-addressed edit format wrong, and what each way COSTS.
 *
 * ── Why cost and not pass/fail ─────────────────────────────────────────────────────────────────
 *
 * The format shipped on the argument that its measured saving survives an imperfect model: the
 * harness forgives what it can recognise, and refuses the rest with the file's real text inside the
 * refusal, so a malformed emission is re-emitted rather than re-derived from a second read. That is
 * a claim about PRICE, not about correctness, and "the applier returned an error" says nothing
 * about it. So every case here is scored in the currency the ship decision is priced in:
 *
 *   0  the edit landed and the file is byte-identical to what the model asked for. Nothing extra.
 *   1  refused, and the refusal is SELF-SUFFICIENT: the model's very next call can be the corrected
 *      patch. One extra generation, no extra tool call, and nothing new in the window.
 *   2  refused, and the model has to read the file again before it can retry. One extra generation
 *      AND one extra tool call, and the read puts the whole region back into the window - which is
 *      the failure the incumbent's `oldText` misses were made of and the whole reason this format
 *      exists.
 *   X  the tool reported success and the bytes on disk are not what the model asked for. This is
 *      not a round trip, it is a wrong file, and it is the only outcome that cannot be priced.
 *
 *   X-echo  the same, EXCEPT that the result's `wrote` echo displays the lines that came out wrong,
 *      so a model reading its own tool result sees the damage on the turn it did it. Still wrong
 *      bytes; still counted as a defect; separated because the recovery is one more edit rather
 *      than a test failure a week later, and pretending those are the same thing would be dishonest
 *      in the direction that flatters the format.
 *
 * ── Why "self-sufficient" is decided by a program and not by reading the message ────────────────
 *
 * "The refusal is actionable" is exactly the kind of claim a lane grades itself on and passes. So
 * it is mechanical here, and each case declares which of the two tests it must satisfy BEFORE the
 * run - `content` for a fault about what is in the file, `shape` for a fault about how the patch is
 * spelt:
 *
 *   content - the message must quote the live file back under its real line numbers, at least three
 *             consecutive rows of it (or the whole file, when the file is shorter than that), and
 *             every quoted row must match the file as it actually reads. One number is a coincidence;
 *             three consecutive correct rows is a window.
 *   shape   - the message must name a legal spelling or the argument the model must change, so the
 *             model can fix the patch out of what it already has.
 *
 * The same two tests are applied to the incumbent in `incumbent.ts`, with only the shape vocabulary
 * changed, so neither format is graded on a scale written for it.
 *
 * ── What this corpus is NOT ────────────────────────────────────────────────────────────────────
 *
 * It runs no model. Every emission here is one a model plausibly produces - a dropped marker, a
 * unified diff, an anchor counted off a header - but the RATE at which models produce them is not
 * measured anywhere in athanor and is not measured here. This bounds the cost of each failure; it
 * does not weight them.
 */
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { normaliseLine, toLines } from '../../apps/worker/src/edit/format.js';
import { forgetReads, readsOf, recordRead } from '../../apps/worker/src/edit/snapshots.js';
import { fileText } from './corpus.js';

/* ------------------------------------------------------------------------------- the currency */

/** `X` is a wrong file; `X-echo` is a wrong file the tool result displays on the same turn. */
export type Cost = 0 | 1 | 2 | 'X' | 'X-echo';

export const isDefect = (cost: Cost): boolean => cost === 'X' || cost === 'X-echo';

/** Round trips, for arithmetic. A wrong file is not a round trip and is counted separately. */
export const roundTrips = (cost: Cost): number => (typeof cost === 'number' ? cost : 0);

/* --------------------------------------------------------------------------------- the tests */

/**
 * Line numbers the message quotes back that the live file really reads that way.
 *
 * Both spellings are accepted - `N:TEXT`, which this format's refusals use, and `N| TEXT`, which
 * the incumbent's explainer uses - because the same function has to price both formats or the
 * comparison is graded on a scale written for one of them.
 */
export const quotedRows = (message: string, live: readonly string[]): number[] => {
  const found: number[] = [];
  for (const row of message.split('\n')) {
    // `[\s\S]` rather than `.`, because `.` does not match a carriage return and every row of a
    // window quoted out of a CRLF file ends in one - which made this scorer report that the
    // incumbent's refusal carried no file text at all on exactly the file where it does.
    const match = /^\s*(\d+)(?::|\| ?)([\s\S]*)$/.exec(row);
    if (!match) continue;
    const number = Number(match[1]);
    const actual = live[number - 1];
    if (actual === undefined) continue;
    if (normaliseLine(actual) === normaliseLine(match[2] as string)) found.push(number);
  }
  return found;
};

/** Three consecutive true rows, or the whole file when the file is shorter than three lines. */
export const carriesLiveText = (message: string, live: readonly string[]): boolean => {
  const rows = quotedRows(message, live);
  const wanted = Math.min(3, live.length);
  if (rows.length < wanted) return false;
  let run = 1;
  for (let index = 1; index < rows.length; index += 1) {
    run = (rows[index] as number) === (rows[index - 1] as number) + 1 ? run + 1 : 1;
    if (run >= wanted) return true;
  }
  return wanted <= 1;
};

/** The message names a legal spelling of this dialect, or the rule the offending row broke. */
export const namesAShape = (message: string): boolean =>
  /PUT\s*[<>N\d]|CUT\s*[N\d]|Body rows begin with \+|Use shell/.test(message);

/* --------------------------------------------------------------------------------- the cases */

export type Group =
  | 'anchor'
  | 'header'
  | 'body'
  | 'whitespace'
  | 'register'
  | 'encoding'
  | 'scale'
  | 'dialect';

export interface ConformanceCase {
  readonly id: string;
  readonly group: Group;
  /** What the model did, in the words a reader of the table needs. */
  readonly what: string;
  readonly path?: string;
  /** The file, when it is not one of the corpus files. */
  readonly file?: string;
  /** The windows a read displayed, oldest first. Absent means one whole-file read. */
  readonly reads?: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  /** No read at all - a cold snapshot store, or an anchor invented from nothing. */
  readonly noRead?: boolean;
  /** What another writer did to the file between the read and the edit. */
  readonly drift?: (text: string) => string;
  /** Exactly what the model emitted, byte for byte. */
  readonly edit: string;
  /**
   * What a forgiving harness must do, declared before the run.
   *
   * `apply` carries the file the model asked for, computed here and never by the applier. `refuse`
   * carries which of the two message tests the refusal has to pass.
   */
  readonly want:
    | { readonly kind: 'apply'; readonly after: (live: string) => string }
    | { readonly kind: 'refuse'; readonly fixableFrom: 'content' | 'shape' };
  /** Where this lane disagrees with what the applier does. Printed beside the row. */
  readonly finding?: string;
}

export interface ConformanceRow {
  readonly id: string;
  readonly group: Group;
  readonly what: string;
  readonly cost: Cost;
  /**
   * What happened, against what a forgiving harness had to do.
   *
   * `over-refused` is its own verdict and it is the one this lane exists to count: the harness
   * refused an emission it had the evidence to recover, so the round trip is real and avoidable.
   * A cost of 1 on an over-refusal is still a cost of 1 that nobody had to pay.
   */
  readonly verdict: 'landed' | 'refused' | 'over-refused' | 'landed-wrong';
  /** The refusal kind, or the notes the applier reported on a landing. */
  readonly detail: string;
  readonly finding?: string;
}

/** Replace one-based lines `from..to` with `lines`, which is how every expectation is written. */
const splice = (text: string, from: number, to: number, lines: readonly string[]): string => {
  const out = toLines(text);
  out.splice(from - 1, to - from + 1, ...lines);
  return out.join('\n');
};

const QUEUE = 'src/queue.ts';
const YAML = 'infra/services.yml';

const SMALL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n');
/** Fifty thousand lines, so the applier is asked to do this at a size a real repository reaches. */
const HUGE = Array.from({ length: 50_000 }, (_, index) => `line ${index + 1} of the file`).join(
  '\n'
);

export const CASES: readonly ConformanceCase[] = [
  /* ------------------------------------------------------------------------- anchor errors */
  {
    id: 'anchor-off-by-one-unique-evidence',
    group: 'anchor',
    what: 'anchor one line late, quoting a line that occurs once in the file',
    edit: "PUT 15:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-one-repeated-evidence',
    group: 'anchor',
    what: 'anchor one line late, quoting one of six identical `return null;` lines',
    edit: 'PUT 12:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'THE CORRECTION INHERITS THE INCUMBENT’S UNIQUENESS REQUIREMENT. `placeWithEvidence` searches the WHOLE file for the quoted text and gives up when it is not unique, so on the repetitive file this format was bought for, the off-by-one it is proudest of correcting is a refusal instead. Searching the three lines the correction radius already allows would resolve it: within that window the text occurs once. Cheap refusal, but a needless one'
  },
  {
    id: 'anchor-off-by-one-backwards',
    group: 'anchor',
    what: 'anchor one line early, quoting a unique line',
    edit: "PUT 13:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-one-no-evidence',
    group: 'anchor',
    what: 'anchor one line late, with nothing in the patch saying what it meant',
    edit: 'PUT 12:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'THE FORMAT’S ONE UNAVOIDABLE HOLE: nothing in the patch says what line 12 was, so an off-by-one is indistinguishable from a correct edit and it lands as written. The result’s echo shows the written line and its neighbours, so it is visible on the same turn'
  },
  {
    id: 'anchor-off-by-three-with-evidence',
    group: 'anchor',
    what: 'anchor three lines out - the far edge of what is corrected',
    edit: "PUT 17:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"])
    }
  },
  {
    id: 'anchor-off-by-many-with-evidence',
    group: 'anchor',
    what: 'anchor nine lines from the text it quoted',
    edit: "PUT 23:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-past-eof',
    group: 'anchor',
    what: 'PUT 900: on a 57-line file',
    edit: 'PUT 900:\n+  return job.payload ?? undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-zero',
    group: 'anchor',
    what: 'PUT 0: - counted from zero, the way an array is',
    edit: 'PUT 0:\n+// header',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-negative',
    group: 'anchor',
    what: 'PUT -3: - a negative line number',
    edit: 'PUT -3:\n+// header',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'anchor-reversed-range',
    group: 'anchor',
    what: 'PUT 12.=10: - the range written back to front',
    edit: 'PUT 12.=10:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'anchor-overlapping-ranges',
    group: 'anchor',
    what: 'two operations in one patch covering the same lines',
    edit: 'PUT 10.=12:\n+    return undefined;\nPUT 12.=13:\n+  if (job.expiresAt < Date.now()) {',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'the right refusal, priced at 2 by the corpus because the message names no legal spelling and quotes no file text: "write one operation covering both" is advice a person acts on and a mechanical test cannot separate from "read the file again". Adding `PUT N.=M:` to that sentence costs eight characters and moves the row to 1'
  },
  {
    id: 'anchor-outside-the-window',
    group: 'anchor',
    what: 'a window read of lines 1-20, then an edit at 44',
    reads: [{ from: 1, to: 20 }],
    edit: 'PUT 44:\n+export const readyCount = (queue: Job[]): number | undefined => {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-window-counted-from-one',
    group: 'anchor',
    what: 'a window read of lines 20-30, and the model counts inside the window instead of the file',
    reads: [{ from: 20, to: 30 }],
    edit: 'PUT 3:\n+  const job = queue.at(0);',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-never-read',
    group: 'anchor',
    what: 'an edit to a file no read of this task has shown',
    noRead: true,
    edit: 'PUT 11:\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'the only refusal in the corpus that carries NO text of the file - the store has no record, so it has nothing to quote. It names the file’s length and says to read it, which is a genuine second round trip and the price of a cold cache'
  },
  {
    id: 'anchor-evicted-by-five-reads',
    group: 'anchor',
    what: 'five reads of one file, then an edit against the numbers of the first',
    reads: [
      { from: 1, to: 10 },
      { from: 11, to: 20 },
      { from: 21, to: 30 },
      { from: 31, to: 40 },
      { from: 41, to: 50 }
    ],
    edit: 'PUT 5:\n+export const drain = (queue: Job[]): Payload | undefined => {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  /*
   * THE TWO RELOCATION CASES BELOW ARE A PAIR AND ONLY MEAN ANYTHING TOGETHER.
   *
   * `placeRange` has a recovery nothing else in this corpus reaches: when the addressed lines no
   * longer hold the text the read recorded, it looks for that text elsewhere in the live file and
   * follows it. The recovery is guarded by `hits.length !== 1`, because text that now stands in two
   * places has no unambiguous home and picking one writes into a region the model never saw.
   *
   * Every case here drove the guard in one direction only. `scale-fifty-thousand-lines-shifted`
   * relocates uniquely and lands, so it passes whether the guard counts matches or not; nothing
   * made the recorded text ambiguous. Relaxing `!== 1` to `< 1` therefore changed no row of this
   * rig, and the applier silently wrote into the FIRST of two matches while reporting a note that
   * said it had followed the text.
   *
   * The pair fixes that. Both cases apply the identical drift - two lines prepended, so the numbers
   * shift by two and the direct match fails in both. The only difference is the addressed range.
   * 10-12 is the `if (!job.ready) { return null; }` stanza, which `src/queue.ts` also holds at
   * 26-28, so after the shift it stands twice: refuse. 13-15 holds the one `logger.warn` line and
   * stands once: land, and report the shift. A change that breaks the guard fails the first; a
   * change that makes it refuse ordinary drift fails the second.
   */
  {
    id: 'anchor-relocation-ambiguous',
    group: 'anchor',
    what: 'the file shifted under the read and the recorded lines now stand in two places',
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 10.=12:\n+  if (job.ready === false) {',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'anchor-relocation-unique',
    group: 'anchor',
    what: 'the same shift, where the recorded lines still stand in exactly one place',
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 13.=15:\n+  if (job.expiresAt < Date.now()) {',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 15, 17, ['  if (job.expiresAt < Date.now()) {'])
    }
  },

  /* ------------------------------------------------------------------------- header errors */
  {
    id: 'header-from-another-dialect',
    group: 'header',
    what: 'a `[path#tag]` section header this format has no use for',
    edit: '[src/queue.ts#3f9a]\nPUT 11:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'header-names-another-file',
    group: 'header',
    what: 'a section header naming a DIFFERENT file from the one the call addresses',
    edit: '[src/somewhere-else.ts]\nPUT 11:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'the header is dropped and the edit lands in the path the JSON field names, which is the contract - but the note says only "dropped a [path] section header" and never echoes the path it dropped, so a model that believed the header chose the file gets no signal that it edited a different one'
  },
  {
    id: 'header-only',
    group: 'header',
    what: 'a header and nothing else - the operations did not survive generation',
    edit: '[src/queue.ts]',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'header-git-diff-preamble',
    group: 'header',
    what: 'a whole `git diff`, `diff --git` line and all',
    edit: 'diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -11 +11 @@\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'THE LARGEST HOLE IN THE FORGIVENESS. A bare `@@` hunk is recovered; the same hunk with the `diff --git` and `---`/`+++` headers a model actually emits around it is refused, and the message never mentions the lines that caused it. Three more lines in the parser’s skip list closes it'
  },
  {
    id: 'header-unified-diff-file-rows',
    group: 'header',
    what: 'the `---`/`+++` rows without the `diff --git` line',
    edit: '--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -11 +11 @@\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) },
    finding:
      'refused as "a body row with no operation above it", because `--- a/...` begins with a minus - a message about bodies for a fault about headers'
  },

  /* --------------------------------------------------------------------------- body errors */
  {
    id: 'body-minus-rows-carried-over',
    group: 'body',
    what: '`-` rows from the unified diff the model was thinking in',
    edit: 'PUT 11:\n-    return null;\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'body-whole-hunk-with-context',
    group: 'body',
    what: 'a whole `@@` hunk, space-prefixed context rows included',
    edit: '@@ -10,3 +10,3 @@\n   if (!job.ready) {\n-    return null;\n+    return undefined;\n   }',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'body-zero-context-hunk-insert',
    group: 'body',
    what: 'a zero-context unified-diff hunk that INSERTS - `@@ -11,0 +12,1 @@`',
    edit: '@@ -11,0 +12,1 @@\n+    logger.debug({ id: job.id });',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(11, 0, '    logger.debug({ id: job.id });');
        return out.join('\n');
      }
    },
    finding:
      'THE ONE SILENT CORRUPTION. `-N,0` is unified diff for "insert, remove nothing"; the parser reads the count through `Math.max(1, count)` and turns it into a replacement of line N. Line 11 is destroyed and the tool reports success. The note it prints reads `PUT 11.=10:`, a range the dialect cannot express, which is the bug visible in its own output'
  },
  {
    id: 'body-dropped-plus-marker',
    group: 'body',
    what: 'one body row whose `+` did not survive generation',
    edit: 'PUT 10.=12:\n+  if (!job.ready) {\n    return undefined;\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  /*
   * THE CASE ABOVE DOES NOT TEST THE GUARD IT LOOKS LIKE IT TESTS, AND THIS ONE DOES.
   *
   * `parse.ts` refuses a space-prefixed body row in a body with no `-` rows, because the row is
   * either context or a `+` that was dropped and the two put different text in the file. Disabling
   * that refusal leaves the case above still refused - measured, `kind` goes from `parse` to
   * `evidence` - because its space row reads `   return undefined;`, text that is nowhere in the
   * file, so `placeWithEvidence` throws it out for an unrelated reason. The baseline records cost
   * and verdict, both of which stay where they were, so the row cannot see the guard go.
   *
   * Here the space row is `   if (!job.ready) {`, which after the marker is stripped is exactly
   * what line 10 holds. The evidence check is then satisfied and stops covering for the parser.
   * Measured with the guard disabled: `ok: true`, the 10-12 range collapses onto line 10 alone
   * because the one quoted line becomes the anchor evidence, the three body rows are spliced in
   * over it, and the file grows from 57 lines to 59 with `    return null;` and `  }` orphaned
   * below the replacement. The result carries a note reading "the quoted lines are what was
   * replaced", which is a false sentence about a file the tool has just corrupted while reporting
   * success.
   */
  {
    id: 'body-dropped-plus-that-matches-the-file',
    group: 'body',
    what: 'a dropped `+` on a row whose text really is what the addressed line holds',
    edit: 'PUT 10.=12:\n   if (!job.ready) {\n+    return undefined;\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-unmarked-content',
    group: 'body',
    what: 'no markers at all - the new lines written straight under the range',
    edit: 'PUT 11:\n    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    /*
     * Watched on the box, twice in one turn. The model put the body on the operation's own line -
     * `PUT 3:+from ivl.intervals import merge` - so the operation row did not parse and the next
     * real body row was then read as an operation. Two refusals from one habit, and neither of the
     * two `body-unmarked-*` rows above has it: those put the body on its own line and drop only the
     * marker.
     */
    id: 'body-on-the-operation-row',
    group: 'body',
    what: 'the body written after the colon on the operation row itself',
    edit: 'PUT 11:+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-unmarked-content-that-reads-as-a-verb',
    group: 'body',
    what: 'an unmarked body row that happens to begin `delete `',
    edit: 'PUT 11:\ndelete job.payload;',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'refused with "this tool edits inside a file and cannot delete one. Use shell for that." - a message about deleting FILES for a JavaScript statement that deletes a property. Still one round trip, and still the wrong sentence'
  },
  {
    id: 'body-blank-row-inside',
    group: 'body',
    what: 'a blank line in the new content emitted bare instead of as `+`',
    edit: 'PUT 10.=12:\n+  if (!job.ready) {\n\n+  }',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-empty-on-replace',
    group: 'body',
    what: 'a replace with no body at all',
    edit: 'PUT 10.=12:',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, []) }
  },
  {
    id: 'body-carries-the-dialect',
    group: 'body',
    what: 'new content that is itself made of this format’s own operations',
    edit: 'PUT 11:\n+// PUT 9: and CUT 1.=2 @x are not operations here\n+@@ -1 +1 @@',
    want: {
      kind: 'apply',
      after: (live) =>
        splice(live, 11, 11, ['// PUT 9: and CUT 1.=2 @x are not operations here', '@@ -1 +1 @@'])
    }
  },
  {
    id: 'body-plus-rows-under-a-cut',
    group: 'body',
    what: 'a CUT with `+` rows under it',
    edit: 'CUT 10.=12\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-minus-rows-under-an-insert',
    group: 'body',
    what: 'an insert with a `-` row under it, which describes a deletion nobody asked for',
    edit: 'PUT >11:\n-    return null;\n+    logger.debug({ id: job.id });',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'body-evidence-does-not-match',
    group: 'body',
    what: 'a correct anchor whose `-` row the model typed from memory and got wrong',
    edit: 'PUT 11:\n-    return null\n+    return undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'the anchor was RIGHT. Volunteering evidence turned an edit that would have landed into a refusal, which is the price of checking evidence and is paid only by the model that writes more than the format asks for'
  },

  /* ---------------------------------------------------------------------------- whitespace */
  {
    id: 'ws-crlf-file',
    group: 'whitespace',
    what: 'every line of the file ends CRLF; the read displayed LF',
    drift: (text) => text.replace(/\n/g, '\r\n'),
    edit: 'PUT 11:\n+    return undefined;',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 11, 11, ['    return undefined;'])
    }
  },
  {
    id: 'ws-trailing-spaces',
    group: 'whitespace',
    what: 'the file carries trailing spaces the display could not show',
    drift: (text) =>
      toLines(text)
        .map((line) => (line ? `${line}  ` : line))
        .join('\n'),
    edit: 'PUT 11:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 11, 11, ['    return undefined;']) }
  },
  {
    id: 'ws-tabs-in-evidence',
    group: 'whitespace',
    what: 'the file is tab-indented and the `-` row was retyped with spaces',
    file: 'export const run = () => {\n\tconst value = 1;\n\treturn value;\n};\n',
    edit: 'PUT 2:\n-  const value = 1;\n+  const value = 2;',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'leading whitespace is content and is not normalised, deliberately - a tab and two spaces are different indentation in Python. The refusal quotes the real line, so the retry is a re-emit, but the model cannot SEE the difference and its second attempt is likely to be the same one'
  },
  {
    id: 'ws-no-trailing-newline',
    group: 'whitespace',
    what: 'a file that does not end in a newline, edited on its last line',
    file: 'alpha\nbeta\ngamma',
    edit: 'PUT 3:\n+GAMMA',
    want: { kind: 'apply', after: () => 'alpha\nbeta\nGAMMA' }
  },
  {
    id: 'ws-blank-line-anchor',
    group: 'whitespace',
    what: 'an insert hung off a blank line, in a file that has since shifted',
    file: SMALL,
    drift: (text) => `prepended\n${text}`,
    edit: 'PUT >3:\n+inserted',
    want: {
      kind: 'apply',
      after: (live) => {
        const out = toLines(live);
        out.splice(4, 0, 'inserted');
        return out.join('\n');
      }
    }
  },

  /* ------------------------------------------------------------------------ register errors */
  {
    id: 'register-never-cut',
    group: 'register',
    what: 'pasting a register nothing filled',
    edit: 'PUT >20 @block',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'register-filled-twice',
    group: 'register',
    what: 'two CUTs into the same register and one paste',
    edit: 'CUT 1.=2 @m\nCUT 43.=56 @m\nPUT >20 @m',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'SILENT DATA LOSS. The second CUT overwrites the register, both blocks are deleted, and only the second is pasted back - so lines 1-2 vanish, the tool reports success, and nothing in the notes mentions it. Refusing a second fill of a live register is one comparison'
  },
  {
    id: 'register-pasted-into-its-own-cut',
    group: 'register',
    what: 'a block cut and pasted back inside the hole it left',
    edit: 'CUT 5.=18 @drain\nPUT >10 @drain',
    want: { kind: 'refuse', fixableFrom: 'shape' },
    finding:
      'refused by the overlap check rather than by anything that knows about registers, so the message talks about ranges that must not overlap and never mentions @drain. Right answer, wrong sentence, and priced at 2 for the same reason the overlap row is'
  },
  {
    id: 'register-pasted-twice',
    group: 'register',
    what: 'one CUT and two PUTs of the same register - a copy the format never declared',
    edit: 'CUT 1.=2 @head\nPUT >20 @head\nPUT >40 @head',
    want: {
      kind: 'apply',
      after: (live) => {
        const lines = toLines(live);
        const moved = lines.slice(0, 2);
        const out = [...lines];
        out.splice(40, 0, ...moved);
        out.splice(20, 0, ...moved);
        out.splice(0, 2);
        return out.join('\n');
      }
    },
    finding:
      'a register pasted twice duplicates the block. Nothing declares that and nothing refuses it, so it is a capability the model can only find by accident - harmless, but undocumented behaviour is behaviour nobody can rely on or delete'
  },
  {
    id: 'register-name-with-a-dot',
    group: 'register',
    what: 'a register named `@job.block`',
    edit: 'CUT 1.=2 @job.block\nPUT >20 @job.block',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },

  /* -------------------------------------------------------------------------- encoding */
  {
    id: 'encoding-non-ascii',
    group: 'encoding',
    what: 'a line of non-ASCII text replaced by another',
    file: 'const greeting = "こんにちは";\nconst farewell = "さようなら";\n',
    edit: 'PUT 1:\n+const greeting = "你好";',
    want: { kind: 'apply', after: (live) => splice(live, 1, 1, ['const greeting = "你好";']) }
  },
  {
    id: 'encoding-combining-characters',
    group: 'encoding',
    what: 'the file holds `e` + U+0301 and the `-` row was retyped as the precomposed `é`',
    file: 'const label = "café";\nconst other = 1;\n',
    edit: 'PUT 1:\n-const label = "café";\n+const label = "coffee";',
    want: { kind: 'refuse', fixableFrom: 'content' },
    finding:
      'normalisation is whitespace-only, not Unicode. Two strings that render identically compare different, and the refusal quotes back a line that LOOKS like the one the model sent - the same invisible-difference trap the format closed for CRLF, still open for NFC. It costs nothing when the model sends no evidence, which is the format’s own cheapest form'
  },
  {
    id: 'encoding-lone-surrogate',
    group: 'encoding',
    what: 'a lone surrogate in the line above the edit',
    file: 'const broken = "\ud800";\nconst other = 1;\n',
    edit: 'PUT 2:\n+const other = 2;',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['const other = 2;']) }
  },
  {
    id: 'encoding-very-long-line',
    group: 'encoding',
    what: 'a 200,000-character single line beside the edit',
    file: `const data = '${'x'.repeat(200_000)}';\nconst other = 1;\n`,
    edit: 'PUT 2:\n+const other = 2;',
    want: { kind: 'apply', after: (live) => splice(live, 2, 2, ['const other = 2;']) }
  },

  /* ----------------------------------------------------------------------------- scale */
  {
    id: 'scale-first-line',
    group: 'scale',
    what: 'an edit at line 1',
    edit: "PUT 1:\n+import type { Job, Payload } from './job.js';",
    want: {
      kind: 'apply',
      after: (live) => splice(live, 1, 1, ["import type { Job, Payload } from './job.js';"])
    }
  },
  {
    id: 'scale-last-line',
    group: 'scale',
    what: 'an edit at the last line of the file',
    file: SMALL,
    edit: 'PUT 6:\n+ZETA',
    want: { kind: 'apply', after: (live) => splice(live, 6, 6, ['ZETA']) }
  },
  {
    id: 'scale-append-past-last-line',
    group: 'scale',
    what: 'an insert after the last line',
    file: SMALL,
    edit: 'PUT >6:\n+eta',
    want: { kind: 'apply', after: (live) => `${live}\neta` }
  },
  {
    id: 'scale-one-line-file',
    group: 'scale',
    what: 'the whole file is one line',
    file: 'only',
    edit: 'PUT 1:\n+ONLY',
    want: { kind: 'apply', after: () => 'ONLY' }
  },
  {
    id: 'scale-empty-file',
    group: 'scale',
    what: 'the file is empty',
    file: '',
    edit: 'PUT 1:\n+first line',
    want: { kind: 'apply', after: () => 'first line' }
  },
  {
    id: 'scale-empty-file-insert',
    group: 'scale',
    what: 'the file is empty and the model inserts after its one empty line',
    file: '',
    edit: 'PUT >1:\n+first line',
    want: { kind: 'apply', after: () => '\nfirst line' },
    finding:
      'an empty file reads as one empty line, so inserting after it leaves a leading blank. That is the numbering being consistent rather than a bug, and it is the shape a model will get wrong on a new file'
  },
  {
    id: 'scale-fifty-thousand-lines',
    group: 'scale',
    what: 'an edit near the end of a 50,000-line file',
    file: HUGE,
    edit: 'PUT 49999:\n+line 49999 of the file, changed',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 49_999, 49_999, ['line 49999 of the file, changed'])
    }
  },
  {
    id: 'scale-fifty-thousand-lines-shifted',
    group: 'scale',
    what: 'the same, after another writer prepended two lines',
    file: HUGE,
    drift: (text) => `// added\n// by somebody else\n${text}`,
    edit: 'PUT 49999:\n+line 49999 of the file, changed',
    want: {
      kind: 'apply',
      after: (live) => splice(live, 50_001, 50_001, ['line 49999 of the file, changed'])
    }
  },

  /* --------------------------------------------------------------------------- dialect */
  {
    id: 'dialect-space-separated-range',
    group: 'dialect',
    what: 'PUT 10 12: - the separator the parser’s own comment says is forgiven',
    edit: 'PUT 10 12:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) },
    finding:
      '`parse.ts` lists `PUT 40 42:` among the spellings it forgives and the regex has no bare-space separator, so it does not. The refusal is cheap and the comment is wrong; one of the two has to change'
  },
  {
    id: 'dialect-dash-range-lowercase',
    group: 'dialect',
    what: 'put 10-12 - lower case, dash separator, no colon',
    edit: 'put 10-12\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'dialect-double-dot-range',
    group: 'dialect',
    what: 'PUT 10..12:',
    edit: 'PUT 10..12:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    /*
     * Watched on the box. A turn wrote `PUT 40.:=42:` and was refused with "unexpected `.:=` after
     * the range" - it had blended the two spellings this parser already accepted separately. The
     * three dialect rows above are each ONE separator; none of them is a mixture, which is what the
     * gap in the list was.
     */
    id: 'dialect-blended-range-separator',
    group: 'dialect',
    what: 'PUT 10.:=12: - two accepted separators run together',
    edit: 'PUT 10.:=12:\n+    return undefined;',
    want: { kind: 'apply', after: (live) => splice(live, 10, 12, ['    return undefined;']) }
  },
  {
    id: 'dialect-prose-instruction',
    group: 'dialect',
    what: 'REPLACE LINE 11 WITH ... - no dialect at all',
    edit: 'REPLACE LINE 11 WITH "    return undefined;"',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-rem-a-file',
    group: 'dialect',
    what: 'REM - an operation the reference dialect has and this one does not declare',
    edit: 'REM',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-mv-a-file',
    group: 'dialect',
    what: 'MV src/queue.ts src/jobs.ts',
    edit: 'MV src/queue.ts src/jobs.ts',
    want: { kind: 'refuse', fixableFrom: 'shape' }
  },
  {
    id: 'dialect-block-never-closes',
    group: 'dialect',
    what: 'PUT N*: on a block that runs past the window the model was shown',
    reads: [{ from: 1, to: 8 }],
    edit: 'PUT 5*:\n+export const drain = () => undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'dialect-block-above-the-window',
    group: 'dialect',
    what: 'PUT N*: addressed above the window the model was shown',
    reads: [{ from: 20, to: 40 }],
    edit: 'PUT 5*:\n+export const drain = () => undefined;',
    want: { kind: 'refuse', fixableFrom: 'content' }
  },
  {
    id: 'dialect-repeated-stanza',
    group: 'dialect',
    what: 'a line changed inside the second of three byte-identical YAML stanzas',
    path: YAML,
    edit: 'PUT 23:\n+      interval: 15s',
    want: { kind: 'apply', after: (live) => splice(live, 23, 23, ['      interval: 15s']) }
  },
  {
    id: 'dialect-renumbered-after-own-hunk',
    group: 'dialect',
    what: 'two hunks, the second addressed in the numbering the FIRST one would leave',
    edit: "PUT 7.=9:\n+  if (!job) return undefined;\nPUT 12:\n-    logger.warn('job expired', { id: job.id });\n+    logger.error('job expired', { id: job.id });",
    want: {
      kind: 'apply',
      after: (live) =>
        splice(splice(live, 14, 14, ["    logger.error('job expired', { id: job.id });"]), 7, 9, [
          '  if (!job) return undefined;'
        ])
    },
    finding:
      'the classic multi-hunk miscount, and the case that justifies accepting `-` rows at all: with one the anchor is pulled back to the original numbering the spec asks for, without one it lands two lines out and nothing in the harness can tell'
  }
];

/* ------------------------------------------------------------------------------- the runner */

let sequence = 0;

/** The file as the read showed it, and as the edit meets it. One definition, used by both runners. */
export const sourceOf = (item: ConformanceCase): { read: string; live: string } => {
  const read = item.file ?? fileText(item.path ?? QUEUE);
  return { read, live: item.drift ? item.drift(read) : read };
};

/**
 * One case, driven through the real applier with the real snapshot store.
 *
 * `forgetReads()` between cases, because the store is process-global and a record left behind by an
 * earlier case would make a later one pass for the wrong reason - which is the failure mode of every
 * shared fixture and the reason this is not a `beforeEach` somebody can forget.
 */
export const runCase = (item: ConformanceCase): ConformanceRow => {
  forgetReads();
  sequence += 1;
  const taskId = `conformance-${sequence}`;
  const path = item.path ?? QUEUE;
  const { read, live } = sourceOf(item);
  const lines = toLines(read);
  if (!item.noRead)
    for (const window of item.reads ?? [{ from: 1, to: lines.length }])
      recordRead(taskId, path, window.from, lines.slice(window.from - 1, window.to).join('\n'));
  if (item.drift && live === read)
    throw new Error(`${item.id}: drift() changed nothing, so the stale case is not being tested`);

  const outcome = applyEdit(path, item.edit, live, readsOf(taskId, path));
  if (!outcome.ok) {
    const message = outcome.refusal.message;
    const sufficient =
      item.want.kind === 'refuse' && item.want.fixableFrom === 'content'
        ? carriesLiveText(message, toLines(live))
        : carriesLiveText(message, toLines(live)) || namesAShape(message);
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: sufficient ? 1 : 2,
      verdict: item.want.kind === 'apply' ? 'over-refused' : 'refused',
      detail: outcome.refusal.kind,
      ...(item.finding ? { finding: item.finding } : {})
    };
  }
  if (item.want.kind === 'refuse')
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: 'X',
      verdict: 'landed-wrong',
      detail: 'applied a patch that had to be refused',
      ...(item.finding ? { finding: item.finding } : {})
    };
  const wanted = item.want.after(live);
  if (outcome.text === wanted)
    return {
      id: item.id,
      group: item.group,
      what: item.what,
      cost: 0,
      verdict: 'landed',
      detail: outcome.notes.length ? `${outcome.notes.length} note(s)` : 'no notes',
      ...(item.finding ? { finding: item.finding } : {})
    };

  /*
   * A wrong file, and the one question left is whether the model can SEE it.
   *
   * The result carries the line ranges it wrote, and the arm echoes them back numbered. If every
   * line that came out wrong is inside one of those ranges, the damage is on the same turn's tool
   * result and the recovery is one more edit. If it is not, the first thing that notices is a test.
   */
  const before = toLines(live);
  const after = toLines(outcome.text);
  const intended = toLines(wanted);
  const wrong: number[] = [];
  for (let index = 0; index < Math.max(after.length, intended.length); index += 1)
    if (after[index] !== intended[index]) wrong.push(index + 1);
  const echoed = wrong.every((line) =>
    outcome.wrote.some((region) => line >= region.from - 1 && line <= region.to + 1)
  );
  return {
    id: item.id,
    group: item.group,
    what: item.what,
    cost: echoed && wrong.length ? 'X-echo' : 'X',
    verdict: 'landed-wrong',
    detail: `${wrong.length} line(s) wrong, file was ${before.length} lines`,
    ...(item.finding ? { finding: item.finding } : {})
  };
};

export const runConformance = (): readonly ConformanceRow[] => CASES.map(runCase);
