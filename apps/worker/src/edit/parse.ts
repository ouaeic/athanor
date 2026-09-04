/**
 * The dialect, and the only place that knows its spelling. Deliberately forgiving.
 *
 * One operation per line; body rows that begin with `+` and carry the FINAL text of the line, and
 * one optional `-` row first, quoting the start of the first addressed line. There are no context
 * rows in the canonical form, and that is the entire source of the saving: the range says what
 * goes, the body says what arrives, and the anchor says which line the number was counted at.
 *
 *   PUT 40.=42:
 *   -  if (!job) return null;
 *   +  if (!job) return undefined;
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
 *   - the body written on the operation's own row, `PUT 3:+text`. Watched on the box twice in one
 *     turn: refusing that row leaves the next real body row to be read as an operation, so one
 *     habit costs two refusals. The text after the colon is the first body row;
 *   - a carriage return at the end of a patch row, which a CRLF surface puts there and no display
 *     shows;
 *   - a line-number prefix copied out of the read into a body or anchor row, `+12:text`, taken off
 *     only when the number is the one the row already stands at - see `stripLeakedPrefix`;
 *   - several `-` rows, or `-` rows with context, which every model has written a thousand of in
 *     unified diffs. They are not noise and they are not an error: they are the model stating what
 *     it believes it is replacing, which is EVIDENCE, and `apply.ts` checks the numbers against
 *     it. One `-` row first is the anchor the spec teaches; more than one is the whole quote;
 *   - a whole unified-diff hunk, `@@ -40,3 +40,2 @@` and context rows included. A model that falls
 *     back to the format it knows best gets its edit applied rather than a lecture - and a WHOLE
 *     `git diff`, `diff --git` and `--- a/path` rows and all, which is the more likely emission of
 *     the two and was the one being refused;
 *   - `@@ -40,0 +41,2 @@`, the zero-context insertion hunk `git diff -U0` writes. It removes
 *     nothing, and reading it as a replacement of line 40 destroyed a line and reported success;
 *   - a body row with NO marker at all, standing between rows that have one - after at least one
 *     marked row, and with a `+` row directly under it - when the row is not itself an operation.
 *     Watched live three times in one turn from a cheap model: `+`, `+`, `def nth_prime(n):`, then
 *     `+    """..."""`. A row like that has exactly one reading, a `+` that did not survive
 *     generation: prose cannot stand there, because a `+` row cannot follow prose without an
 *     operation between them. Reading it as a body row touches the same lines the patch already
 *     named - see `droppedMarkerAhead`.
 *
 * What is NOT forgiven, and the line is drawn here on purpose: a body row that begins with a space
 * when nothing in the body begins with `-`. It is either a context row or a `+` the model dropped,
 * those two readings put different text in the file, and there is no evidence to choose between
 * them. That is a refusal naming the row. The same holds for an unmarked row at the END of a body,
 * with no `+` row under it: that is where the sentence a model writes after its patch lives, and
 * it too is refused by name.
 */
import { stripLeakedPrefix, toLines } from './format.js';

export type EditOp =
  | {
      readonly kind: 'replace';
      readonly from: number;
      readonly to: number;
      readonly body: readonly string[];
      /** The whole quote of what the model said it was replacing - two or more rows of evidence. */
      readonly old: readonly string[];
      /** The one `-` row first: the start of line `from`, as the model read it. */
      readonly anchor?: string;
      readonly row: number;
    }
  | {
      readonly kind: 'block';
      readonly at: number;
      readonly body: readonly string[];
      readonly anchor?: string;
      readonly row: number;
    }
  | {
      readonly kind: 'insert';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly body: readonly string[];
      readonly anchor?: string;
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
      readonly anchor?: string;
      readonly row: number;
    };

export interface ParseFailure {
  readonly kind: 'parse';
  /** One-based row of the offending line within the patch text. */
  readonly row: number;
  readonly message: string;
  /** The one change that makes the patch parse, for the message a repeated patch gets. */
  readonly fix: string;
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
 * the single line 40 with a terminator rather than as a range with a missing end. That property is
 * what makes the separator safe to widen: between two numbers a run of these characters can only be
 * a range, and everywhere else it is not matched at all.
 *
 * A RUN rather than one of a list, because the list was a list of the spellings someone thought of.
 * Measured on the box: `PUT 40.:=42:` was refused with "unexpected `.:=` after the range" - the
 * model had blended the two spellings this file already accepts separately, `.=` and `:`, and the
 * refusal cost a step and a retry to say so. `=`, `:=`, `...` and `. = ` fall out of the same gap.
 * There is nothing to be gained by being strict here: the numbers are what carry the meaning.
 */
const RANGE = /^(\d+)(?:(?:\s*(?:to|(?:[.=:,\-–—]\s*)+)\s*|\s+)(\d+))?\s*/i;

/**
 * A PUT or CUT carrying an address - the shape of the NEXT operation, which is the one kind of
 * unmarked row inside a body that is not a dropped marker.
 *
 * The verb alone is not enough: `put(x)` and `cut = 3` are lines of code, and a body row of code
 * that lost its `+` is exactly what this predicate exists to tell apart from an operation. The
 * address is what an operation cannot be written without. No word boundary after the verb, so
 * `PUT15:` is an operation attempt too.
 */
const OPENS = /^\s*(?:put|cut)\s*(?:[<>]\s*)?\d+/i;
/**
 * A row that is an operation attempt whatever follows the verb: the verb in upper case, standing
 * alone or before whitespace. `PUT line 15:` and a bare `REM 5` are the next operation misspelt,
 * and a body that swallowed either would land the words as text and report success on a file with
 * the wrong line in it. The row is left for the operation loop, which refuses it by name at its
 * own row. `put(x)`, `cut = 3` and `del cache[key]` are lines of code and are not matched: the
 * case and the boundary are what tell the two apart.
 */
const OPERATION_ATTEMPT = /^\s*(?:PUT|CUT|REM|RM|DEL|DELETE|MV|MOVE|RENAME)(?:\s|$)/;

/**
 * Whether the unmarked row at `cursor` is a body row that lost its `+`, decided on the rows around
 * it and never on its text.
 *
 * Three things have to hold, and each one closes a different wrong reading. At least one marked
 * row must stand above it, so the row is inside a body and not the first thing under an operation.
 * A `+` row must stand DIRECTLY under it, so it cannot be prose written after the patch - prose
 * ends the patch, and a `+` row after prose has no operation to belong to. And the row must not
 * be an operation, an attempt at one, a hunk header or a diff preamble in its own right, because
 * those are the next operation and a body that swallowed one would land it as text.
 *
 * Only one row at a time, on purpose: two unmarked rows in a run are refused at the first, and
 * the refusal names it. The leniency is sized to the shape that was watched, not to every shape
 * that could be argued for.
 */
const droppedMarkerAhead = (rows: readonly string[], cursor: number, marked: number): boolean => {
  const row = rows[cursor] as string;
  if (!marked || !row.trim()) return false;
  if (OPENS.test(row) || OPERATION_ATTEMPT.test(row)) return false;
  if (HUNK.test(row) || SECTION.test(row) || PREAMBLE.test(row)) return false;
  return rows[cursor + 1]?.startsWith('+') === true;
};

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
  'marker per body row (+ adds, - quotes the start of the line you are replacing, a space is context):',
  '  PUT 12.=14:',
  '  -    return None',
  '  +    return merge(rest)',
  '  PUT >40:',
  '  +def split(intervals, at):',
  '  +    return intervals'
].join('\n');

/** The fix every parse failure names, because every parse failure is answered by the example. */
const PARSE_FIX =
  'write the operation on its own row and every body row with a + marker, exactly as the example shows';

/**
 * A body, split into the three things it can say.
 *
 * `next` is the text that will be in the file. `anchor` is the one `-` row first, quoting the
 * start of the first addressed line - the taught form. `old` is the whole quote, present only when
 * the model wrote two or more `-` rows or any context rows; it is the unified-diff habit, and
 * `apply.ts` checks the numbers against all of it.
 */
interface Body {
  readonly next: string[];
  readonly old: string[];
  readonly anchor?: string;
}

/**
 * Where the body's rows will stand, so a leaked line-number prefix can be recognised as leaked.
 *
 * `anchorLine` is the line a `-` row quotes. `firstBodyLine` is where the first `+` row lands in
 * the file the read numbered: the addressed line for a replacement, the line after for an insert
 * after it. Neither is used to place anything - only to decide whether a `12:` at the start of a
 * row is the display's number or the row's own text.
 */
interface Standing {
  readonly anchorLine: number;
  readonly firstBodyLine: number;
}

/**
 * What the applier knows and the parser does not: the text standing at a line of the file.
 *
 * Only `stripLeakedPrefix` asks, and only to keep its hands off a row whose leading digits are the
 * file's own. Absent, every same-number prefix is read as leaked, which is what a caller with no
 * file in hand can honestly say.
 */
export interface ParseOptions {
  readonly lineAt?: (line: number) => string | undefined;
}

export const parseEdit = (source: string, options: ParseOptions = {}): ParseResult => {
  // A trailing CR is what a CRLF surface puts on every row and what no display shows. It is taken
  // off the patch here and never off the file: the file's line endings are the file's.
  const rows = toLines(source).map((row) => row.replace(/\r$/, ''));
  const ops: EditOp[] = [];
  const forgave: string[] = [];
  const note = (message: string): void => {
    if (!forgave.includes(message)) forgave.push(message);
  };
  const fail = (row: number, message: string): ParseResult => ({
    ok: false,
    // The example rides on every parse failure rather than on the three that earned it: a reader
    // that could not write a valid operation needs to see one whichever rule it tripped.
    failure: {
      kind: 'parse',
      row: row + 1,
      message: `${message}\n${WORKED_EXAMPLE}`,
      fix: PARSE_FIX
    }
  });

  let index = 0;
  /**
   * The body of the operation that opens at `index`, plus one row the operation row itself may
   * have carried after its colon.
   */
  const takeBody = (opRow: number, standing: Standing, inline?: string): Body | ParseResult => {
    const marked: string[] = inline === undefined ? [] : [inline];
    let cursor = index + 1;
    while (cursor < rows.length) {
      const row = rows[cursor] as string;
      if (row.startsWith('+') || row.startsWith('-') || row.startsWith(' ')) {
        marked.push(row);
        cursor += 1;
        continue;
      }
      if (!droppedMarkerAhead(rows, cursor, marked.length)) break;
      note(
        `read patch row ${cursor + 1} as a body row whose + was dropped - it stands between marked rows and is not an operation; every body row carries a marker`
      );
      marked.push(`+${row}`);
      cursor += 1;
    }
    const minus = marked.filter((row) => row.startsWith('-'));
    const contexts = marked.filter((row) => row.startsWith(' '));
    if (contexts.length && !minus.length) {
      const offender = marked.findIndex((row) => row.startsWith(' '));
      return fail(
        index + 1 + offender - (inline === undefined ? 0 : 1),
        `a body row beginning with a space, in a body with no - rows. It is either unchanged context or a line whose + was dropped, and those put different text in the file. Body rows begin with + and carry the final text of the line.`
      );
    }
    index = cursor;

    let leaked = false;
    /** The row's text with its marker off, and with a leaked display number off when it is one. */
    const unmark = (row: string, expected: number): string => {
      const { text, stripped } = stripLeakedPrefix(
        row.slice(1),
        expected,
        options.lineAt?.(expected)
      );
      if (stripped) leaked = true;
      return text;
    };
    const next: string[] = [];
    for (const row of marked)
      if (row.startsWith('+') || row.startsWith(' '))
        next.push(unmark(row, standing.firstBodyLine + next.length));

    /*
     * ONE `-` row, first, is the anchor: the start of the first addressed line, as the model read
     * it. Anything else that says what is there now - several `-` rows, context rows, a `-` row
     * after a `+` - is the unified-diff habit, and is carried whole as `old` for the full-quote
     * check. The two are kept apart because they are checked differently: a whole quote has to
     * match the whole span, an anchor only has to find its line.
     */
    const anchored = minus.length === 1 && !contexts.length && marked[0]?.startsWith('-');
    if (anchored) {
      const anchor = unmark(marked[0] as string, standing.anchorLine);
      if (leaked)
        note(
          'stripped a leaked line-number prefix from a row that repeated the number it was addressed at; rows carry text only'
        );
      return { next, old: [], anchor };
    }
    const old: string[] = [];
    for (const row of marked)
      if (row.startsWith('-') || row.startsWith(' '))
        old.push(unmark(row, standing.anchorLine + old.length));
    if (leaked)
      note(
        'stripped a leaked line-number prefix from a row that repeated the number it was addressed at; rows carry text only'
      );
    if (old.length)
      note(
        `read the body at patch row ${opRow + 1} as a unified-diff hunk; one - row quoting the start of the first line is enough`
      );
    return { next, old };
  };

  /**
   * What follows the operation's own terminator, which is nothing, or a body row that should have
   * been on the next line. `PUT 3: junk` is neither and is refused by name.
   */
  const inlineBody = (
    opRow: number,
    remainder: string
  ): { readonly inline?: string } | ParseResult => {
    const after = remainder.replace(/^\s+/, '');
    if (!after) return {};
    if (after !== ':' && !after.startsWith(':'))
      return fail(opRow, `unexpected "${after.slice(0, 40)}" after the range - ${CANONICAL}.`);
    const carried = after.slice(1);
    if (!carried.trim()) return {};
    const row = carried.startsWith(' ') ? carried.slice(1) : carried;
    if (!(row.startsWith('+') || row.startsWith('-')))
      return fail(
        opRow,
        `unexpected "${carried.trim().slice(0, 40)}" after the range - ${CANONICAL}.`
      );
    note(
      `read the text after the colon at patch row ${opRow + 1} as the first body row; the body belongs on the rows below the operation`
    );
    return { inline: row };
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
      const body = takeBody(opRow, {
        anchorLine: from,
        firstBodyLine: count === 0 ? from + 1 : from
      });
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
        if (body.old.length || body.anchor !== undefined)
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
        ...(body.anchor === undefined ? {} : { anchor: body.anchor }),
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
      const carried = inlineBody(opRow, rest.slice(gap[0].length));
      if ('ok' in carried) return carried;
      const body = takeBody(
        opRow,
        { anchorLine: at, firstBodyLine: side === 'after' ? at + 1 : at },
        carried.inline
      );
      if ('ok' in body) return body;
      if (body.old.length)
        return fail(
          opRow,
          `PUT ${gap[1]}${at} inserts and replaces nothing, so the - rows under it describe a deletion nobody asked for. One - row quoting the start of line ${at} is an anchor; use PUT N.=M: to replace lines.`
        );
      ops.push({
        kind: 'insert',
        at,
        side,
        body: body.next,
        ...(body.anchor === undefined ? {} : { anchor: body.anchor }),
        row: opRow + 1
      });
      continue;
    }

    const block = /^(\d+)\s*\*/.exec(rest);
    if (block && spelt === 'put') {
      const at = Number(block[1]);
      const carried = inlineBody(opRow, rest.slice(block[0].length));
      if ('ok' in carried) return carried;
      const body = takeBody(opRow, { anchorLine: at, firstBodyLine: at }, carried.inline);
      if ('ok' in body) return body;
      ops.push({
        kind: 'block',
        at,
        body: body.next,
        ...(body.anchor === undefined ? {} : { anchor: body.anchor }),
        row: opRow + 1
      });
      continue;
    }

    const range = RANGE.exec(rest);
    if (!range) return fail(index, `${spelt.toUpperCase()} needs a line number - ${CANONICAL}.`);
    let from = Number(range[1]);
    let to = range[2] === undefined ? from : Number(range[2]);
    const carried = inlineBody(opRow, rest.slice(range[0].length));
    if ('ok' in carried) return carried;
    if (range[2] !== undefined && !/^\d+\.=\d+$/.test(rest.replace(/\s*:.*$/, '').trim()))
      note(`read the range at patch row ${opRow + 1} as ${from}.=${to}`);
    if (to < from) {
      // Reversed is a spelling, not an intent: the same two lines are named either way, and the
      // alternative is refusing an edit whose meaning nobody is in any doubt about.
      note(`read the reversed range at patch row ${opRow + 1} as ${to}.=${from}`);
      [from, to] = [to, from];
    }
    if (spelt === 'cut') {
      const body = takeBody(opRow, { anchorLine: from, firstBodyLine: from }, carried.inline);
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
        ...(body.anchor === undefined ? {} : { anchor: body.anchor }),
        row: opRow + 1
      });
      continue;
    }
    if (register)
      return fail(
        index,
        `PUT ${from} @${register} pastes a register, which needs a gap to paste into: PUT >${from} @${register} or PUT <${from} @${register}.`
      );
    const body = takeBody(opRow, { anchorLine: from, firstBodyLine: from }, carried.inline);
    if ('ok' in body) return body;
    ops.push({
      kind: 'replace',
      from,
      to,
      body: body.next,
      old: body.old,
      ...(body.anchor === undefined ? {} : { anchor: body.anchor }),
      row: opRow + 1
    });
  }

  if (!ops.length) return fail(0, `this patch has no operations in it - ${CANONICAL}.`);
  return { ok: true, ops, forgave };
};
