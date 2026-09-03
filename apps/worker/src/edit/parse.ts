/**
 * The dialect, and the only place that knows its spelling. Deliberately forgiving.
 *
 * One operation per line; body rows that begin with `+` and carry the FINAL text of the line. There
 * are no old rows and no context rows in the canonical form, and that is the entire source of the
 * saving: the range says what goes, the body says what arrives.
 *
 *   PUT 40.=42:
 *   +  if (!job) return null;
 *   +  return job.payload;
 *   CUT 88.=95 @helper
 *   PUT >12 @helper
 *
 * WHY THIS PARSER IS LENIENT, when the version it replaces was deliberately strict.
 *
 * The strict argument is good and it is wrong here. It says a parser that guesses at `PUT 40 - 42`
 * teaches the model that spelling does not matter, and then the guess is wrong once on a line that
 * mattered. But the reference harness this format was measured against maintains a hand-written
 * list of four models that "miscount anchors or drop the tag header" and silently routes them to a
 * lenient parser - which is that harness conceding, in code, that strictness costs round trips on
 * real models and buys nothing. A round trip is not a free correction: it is a whole billed
 * generation, and on the highest-traffic tool in the harness it is the single largest thing
 * standing between a measured 61% saving and a real one.
 *
 * So every leniency here obeys one rule: IT MAY NEVER CHANGE WHICH LINES ARE TOUCHED OR WHAT LANDS
 * IN THEM. It may only recognise a different spelling of the same operation. Anything that would
 * require guessing at intent is a refusal, and `apply.ts` makes every refusal actionable in one
 * turn by handing back the file's real text at the anchor. What is forgiven:
 *
 *   - a `[path]` or `[path#tag]` section header, which other dialects require and this one does not
 *     need at all, because the path arrives in a field of the call;
 *   - `PUT 40-42:`, `PUT 40..42:`, `PUT 40,42:`, `PUT 40 to 42:`, `PUT 40 42:` - every plausible
 *     spelling of a range separator, all meaning `PUT 40.=42:`;
 *   - a missing trailing colon, and lower-case verbs;
 *   - a reversed range, `PUT 42.=40:`;
 *   - `-` rows in the body, which every model has written a thousand of in unified diffs. They are
 *     not noise and they are not an error: they are the model stating what it believes it is
 *     replacing, which is EVIDENCE, and `apply.ts` checks the numbers against it. An off-by-one
 *     that would otherwise be silent corruption becomes a provable correction;
 *   - a whole unified-diff hunk, `@@ -40,3 +40,2 @@` and context rows included. A model that falls
 *     back to the format it knows best gets its edit applied rather than a lecture - and a WHOLE
 *     `git diff`, `diff --git` and `--- a/path` rows and all, which is the more likely emission of
 *     the two and was the one being refused;
 *   - `@@ -40,0 +41,2 @@`, the zero-context insertion hunk `git diff -U0` writes. It removes
 *     nothing, and reading it as a replacement of line 40 destroyed a line and reported success.
 *
 * What is NOT forgiven, and the line is drawn here on purpose: a body row that begins with a space
 * when nothing in the body begins with `-`. It is either a context row or a `+` the model dropped,
 * those two readings put different text in the file, and there is no evidence to choose between
 * them. That is a refusal naming the row.
 */
import { toLines } from './format.js';

export type EditOp =
  | {
      readonly kind: 'replace';
      readonly from: number;
      readonly to: number;
      readonly body: readonly string[];
      /** What the model said it was replacing, if it said - the anchor evidence. */
      readonly old: readonly string[];
      readonly row: number;
    }
  | {
      readonly kind: 'block';
      readonly at: number;
      readonly body: readonly string[];
      readonly row: number;
    }
  | {
      readonly kind: 'insert';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly body: readonly string[];
      readonly row: number;
    }
  | {
      readonly kind: 'paste';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly register: string;
      readonly row: number;
    }
  | {
      readonly kind: 'cut';
      readonly from: number;
      readonly to: number;
      readonly register?: string;
      readonly old: readonly string[];
      readonly row: number;
    };

export interface ParseFailure {
  readonly kind: 'parse';
  /** One-based row of the offending line within the patch text. */
  readonly row: number;
  readonly message: string;
}

export type ParseResult =
  | {
      readonly ok: true;
      readonly ops: readonly EditOp[];
      /**
       * Spellings that were accepted but are not the canonical one, in the model's own words.
       * Reported in the result so the next patch is written the short way without a round trip
       * being spent teaching it.
       */
      readonly forgave: readonly string[];
    }
  | { readonly ok: false; readonly failure: ParseFailure };

/** `[path]` or `[path#tag]` - other dialects need it, this one does not. Accepted and dropped. */
const SECTION = /^\s*\[[^\]]+\]\s*$/;
/**
 * The rows `git diff` puts above a hunk, which this dialect has no use for.
 *
 * A bare `@@` hunk was already forgiven and a WHOLE `git diff` was not, which is backwards: the
 * whole diff is the more likely emission of the two, because it is what the tool a model has seen a
 * million times actually prints. It failed on `--- a/src/queue.ts`, which begins with a minus and
 * was therefore read as a body row with no operation above it - a message about bodies, for a fault
 * about headers, that never named the row that caused it.
 *
 * Dropping them is safe in the one way that matters: the path is a field of the call, so a preamble
 * naming a file cannot move the edit to it. That is the same reason `SECTION` above is dropped.
 */
const PREAMBLE =
  /^\s*(?:diff --git |index [0-9a-f]{4,}\.\.|old mode |new mode |similarity index |rename (?:from|to) |new file mode |deleted file mode |--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null))/;
/** `@@ -40,3 +40,2 @@` - the old side is the only half that addresses anything. */
const HUNK = /^\s*@@+\s*-(\d+)(?:,(\d+))?\s+\+\d+(?:,\d+)?\s*@@/;
const VERB = /^\s*(put|cut|rem|rm|del|delete|mv|move|rename)\b\s*(.*?)\s*$/i;
const REGISTER = /\s*@([A-Za-z0-9_-]+)\s*$/;
/**
 * A line number, then optionally a separator and a second one.
 *
 * The second number is only consumed when a separator IS followed by digits, so `PUT 40:` reads as
 * the single line 40 with a terminator rather than as a range with a missing end.
 */
const RANGE = /^(\d+)(?:(?:\s*(?:\.=|\.\.|\.|-|–|—|,|to|:)\s*|\s+)(\d+))?\s*/i;

const CANONICAL =
  'expected PUT N:, PUT N.=M:, PUT N*:, PUT <N:, PUT >N:, CUT N.=M, CUT N.=M @name or PUT >N @name';

/**
 * One patch, written out, appended to every parse failure.
 *
 * `CANONICAL` above is a grammar, and a grammar is what a reader who already knows the format needs.
 * Measured on the box: nine `file_patch` calls in one turn, five of them refused, and three of those
 * five were a body row that never reached its operation - `PUT 3:+from x import y` with the body on
 * the operation's own line, and a bare `def test_split(): ` read as an operation because the PUT
 * above it had not opened a body. Each refusal restated the same list of forms, and the list does
 * not show the one thing all three got wrong, which is that the operation and its body are on
 * SEPARATE LINES and every body row carries a marker.
 *
 * So the shape goes out with the rule. It is on the failure path only and costs nothing resident,
 * which is the whole reason it can afford to be this long.
 */
const WORKED_EXAMPLE = [
  'A whole patch looks like this - the operation on its own line, the body indented under it, one',
  'marker per body row (+ adds, - is the line you claim is there now, a space is context):',
  '  PUT 12.=14:',
  '  -    return None',
  '  +    return merge(rest)',
  '  PUT >40:',
  '  +def split(intervals, at):',
  '  +    return intervals'
].join('\n');

export const parseEdit = (source: string): ParseResult => {
  const rows = toLines(source);
  const ops: EditOp[] = [];
  const forgave: string[] = [];
  const note = (message: string): void => {
    if (!forgave.includes(message)) forgave.push(message);
  };
  const fail = (row: number, message: string): ParseResult => ({
    ok: false,
    // The example rides on every parse failure rather than on the three that earned it: a reader
    // that could not write a valid operation needs to see one whichever rule it tripped.
    failure: { kind: 'parse', row: row + 1, message: `${message}\n${WORKED_EXAMPLE}` }
  });

  let index = 0;
  /**
   * The body of the operation that opens at `index`, and the two sides it describes.
   *
   * `next` is the text that will be in the file. `old` is what the model claims is there now, which
   * exists only when it wrote `-` or context rows; empty means it made no claim and `apply.ts` has
   * no evidence to check the numbers against.
   */
  const takeBody = (opRow: number): { next: string[]; old: string[] } | ParseResult => {
    const marked: string[] = [];
    let cursor = index + 1;
    while (cursor < rows.length) {
      const row = rows[cursor] as string;
      if (!(row.startsWith('+') || row.startsWith('-') || row.startsWith(' '))) break;
      marked.push(row);
      cursor += 1;
    }
    const removals = marked.some((row) => row.startsWith('-'));
    const contexts = marked.filter((row) => row.startsWith(' '));
    if (contexts.length && !removals) {
      const offender = marked.findIndex((row) => row.startsWith(' '));
      return fail(
        index + 1 + offender,
        `a body row beginning with a space, in a body with no - rows. It is either unchanged context or a line whose + was dropped, and those put different text in the file. Body rows begin with + and carry the final text of the line.`
      );
    }
    index = cursor;
    if (removals || contexts.length)
      note(
        `read the body at patch row ${opRow + 1} as a unified-diff hunk; - and context rows are optional here, + rows alone are enough`
      );
    return {
      next: marked
        .filter((row) => row.startsWith('+') || row.startsWith(' '))
        .map((row) => row.slice(1)),
      old: marked
        .filter((row) => row.startsWith('-') || row.startsWith(' '))
        .map((row) => row.slice(1))
    };
  };

  while (index < rows.length) {
    const row = rows[index] as string;
    if (!row.trim()) {
      index += 1;
      continue;
    }
    if (SECTION.test(row)) {
      note(
        'dropped a [path] section header; the path comes from the call, so a patch here is operations only'
      );
      index += 1;
      continue;
    }
    if (PREAMBLE.test(row)) {
      note(
        'dropped the git diff header rows; the path comes from the call, so a patch here is operations only'
      );
      index += 1;
      continue;
    }

    // A bare unified-diff hunk header, with no PUT above it. Its old side names a real range, so it
    // is a complete operation on its own rather than something to skip.
    const hunk = HUNK.exec(row);
    if (hunk) {
      const from = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const opRow = index;
      const body = takeBody(opRow);
      if ('ok' in body) return body;
      /*
       * `@@ -11,0 +12,1 @@` REMOVES NOTHING. It is what `git diff -U0` writes for a pure insertion,
       * and it is the single most likely hunk a model that reaches for diff will emit, because a
       * zero-context diff has no other way to say "add a line here".
       *
       * This clamped the count to one and applied the hunk as a REPLACEMENT of line 11, destroying
       * a line while reporting success - and printing a note that read `PUT 11.=10:`, a range this
       * dialect cannot express, so the defect was legible in the harness's own output and nothing
       * looked at it. Caught by the ruling gate driving the shape rather than reading a table.
       *
       * Git's own convention for the old side of an insertion hunk is the line the new text goes
       * AFTER, so this is `PUT >11` and nothing here has to guess.
       */
      if (count === 0) {
        if (body.old.length)
          return fail(
            opRow,
            `@@ -${from},0 removes no lines, but this hunk carries - rows saying it removes some. Those two readings put different text in the file. Write PUT >${from}: to insert after line ${from}, or PUT ${from}.=M: to replace lines.`
          );
        note(`read the @@ hunk header at patch row ${opRow + 1} as PUT >${from}`);
        ops.push({ kind: 'insert', at: from, side: 'after', body: body.next, row: opRow + 1 });
        continue;
      }
      note(
        `read the @@ hunk header at patch row ${opRow + 1} as PUT ${from}${count === 1 ? '' : `.=${from + count - 1}`}:`
      );
      ops.push({
        kind: 'replace',
        from,
        to: from + count - 1,
        body: body.next,
        old: body.old,
        row: opRow + 1
      });
      continue;
    }

    if (row.startsWith('+') || row.startsWith('-'))
      return fail(
        index,
        `a body row with no operation above it. Every body follows a PUT that says which lines it replaces - ${CANONICAL}.`
      );

    const verb = VERB.exec(row);
    if (!verb) return fail(index, `not an operation: ${row.slice(0, 60)} - ${CANONICAL}.`);
    const spelt = (verb[1] as string).toLowerCase();
    let rest = verb[2] as string;
    if (verb[1] !== verb[1]?.toUpperCase())
      note('accepted a lower-case verb; the canonical spelling is upper case');

    /*
     * Whole-file deletion and rename are recognised only so they can be refused by name.
     *
     * The dialect this was measured from carries `REM` and `MV`, and they are not declared here
     * because the worker's runner client has no delete or rename route to carry them out - see
     * `prompt.ts`. Recognising them costs nothing resident and turns "not an operation" into an
     * answer the model can act on in the same turn, which is the whole discipline of this parser.
     */
    if (spelt !== 'put' && spelt !== 'cut')
      return fail(
        index,
        `this tool edits inside a file and cannot ${spelt === 'mv' || spelt === 'move' || spelt === 'rename' ? 'rename or move one' : 'delete one'}. Use shell for that.`
      );

    // From here it is PUT or CUT, and everything after the verb is an address.
    const opRow = index;
    let register: string | undefined;
    const named = REGISTER.exec(rest);
    if (named) {
      register = named[1] as string;
      rest = rest.slice(0, named.index);
    }
    rest = rest.trim();

    const gap = /^([<>])\s*(\d+)/.exec(rest);
    if (gap && spelt === 'put') {
      const at = Number(gap[2]);
      const side = gap[1] === '<' ? 'before' : 'after';
      if (register) {
        ops.push({ kind: 'paste', at, side, register, row: opRow + 1 });
        index += 1;
        continue;
      }
      const body = takeBody(opRow);
      if ('ok' in body) return body;
      if (body.old.length)
        return fail(
          opRow,
          `PUT ${gap[1]}${at} inserts and replaces nothing, so a - row under it describes a deletion nobody asked for. Use PUT N.=M: to replace lines.`
        );
      ops.push({ kind: 'insert', at, side, body: body.next, row: opRow + 1 });
      continue;
    }

    const block = /^(\d+)\s*\*/.exec(rest);
    if (block && spelt === 'put') {
      const body = takeBody(opRow);
      if ('ok' in body) return body;
      ops.push({ kind: 'block', at: Number(block[1]), body: body.next, row: opRow + 1 });
      continue;
    }

    const range = RANGE.exec(rest);
    if (!range) return fail(index, `${spelt.toUpperCase()} needs a line number - ${CANONICAL}.`);
    let from = Number(range[1]);
    let to = range[2] === undefined ? from : Number(range[2]);
    const trailing = rest.slice(range[0].length).trim();
    if (trailing && trailing !== ':')
      return fail(index, `unexpected "${trailing.slice(0, 40)}" after the range - ${CANONICAL}.`);
    if (range[2] !== undefined && !/^\d+\.=\d+$/.test(rest.replace(/\s*:?\s*$/, '')))
      note(`read the range at patch row ${opRow + 1} as ${from}.=${to}`);
    if (to < from) {
      // Reversed is a spelling, not an intent: the same two lines are named either way, and the
      // alternative is refusing an edit whose meaning nobody is in any doubt about.
      note(`read the reversed range at patch row ${opRow + 1} as ${to}.=${from}`);
      [from, to] = [to, from];
    }
    if (spelt === 'cut') {
      const body = takeBody(opRow);
      if ('ok' in body) return body;
      if (body.next.length)
        return fail(
          opRow,
          `CUT ${from}.=${to} only deletes, so the + rows under it would go nowhere. Use PUT ${from}.=${to}: to replace those lines, or CUT ... @name and PUT >N @name to move them.`
        );
      ops.push({
        kind: 'cut',
        from,
        to,
        ...(register ? { register } : {}),
        old: body.old,
        row: opRow + 1
      });
      continue;
    }
    if (register)
      return fail(
        index,
        `PUT ${from} @${register} pastes a register, which needs a gap to paste into: PUT >${from} @${register} or PUT <${from} @${register}.`
      );
    const body = takeBody(opRow);
    if ('ok' in body) return body;
    ops.push({ kind: 'replace', from, to, body: body.next, old: body.old, row: opRow + 1 });
  }

  if (!ops.length) return fail(0, `this patch has no operations in it - ${CANONICAL}.`);
  return { ok: true, ops, forgave };
};
