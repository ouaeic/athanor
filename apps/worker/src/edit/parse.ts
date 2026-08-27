/**
 * The dialect, and the only place that knows its spelling.
 *
 * One section per file, headed by the path and the tag the model read it at; one operation per
 * line; and body rows that are `+` followed by the final text of the line. There are no `-old`
 * rows and no context rows, which is the entire source of the token saving being measured: the
 * range says what is deleted, so the body only has to say what the file should read afterwards.
 *
 *   [src/queue.ts#3f9a]
 *   PUT 40.=42:
 *   +  if (!job) return null;
 *   +  return job.payload;
 *   CUT 88.=95 @helper
 *   PUT >12 @helper
 *
 * Ranges name ORIGINAL line numbers - the ones in the read this section's tag belongs to. Every
 * operation in a section is resolved against that same numbering, so a model does not have to
 * simulate the effect of its own earlier hunks. `apply.ts` is what makes that true; this file only
 * has to refuse anything ambiguous, and it refuses by line number so the message can point at the
 * row that is wrong.
 *
 * Deliberately no leniency. A parser that guesses at `PUT 40 - 42` teaches the model that the
 * spelling does not matter, and then the guess is wrong once on a line that mattered. Malformed
 * input comes back as a parse failure naming the row and the expected shape.
 */

export type EditOp =
  | {
      readonly kind: 'replace';
      readonly from: number;
      readonly to: number;
      readonly body: string[];
    }
  | { readonly kind: 'replaceBlock'; readonly at: number; readonly body: string[] }
  | {
      readonly kind: 'insert';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly body: string[];
    }
  | {
      readonly kind: 'paste';
      readonly at: number;
      readonly side: 'before' | 'after';
      readonly register: string;
    }
  | {
      readonly kind: 'cut';
      readonly from: number;
      readonly to: number;
      readonly register?: string;
    }
  | { readonly kind: 'remove' }
  | { readonly kind: 'rename'; readonly to: string };

export interface EditSection {
  readonly path: string;
  /** Absent only when the model deliberately edits a file it is creating; `apply.ts` decides. */
  readonly tag?: string;
  readonly ops: readonly EditOp[];
  /** One-based row of the header in the patch text, so a failure can be pointed at. */
  readonly row: number;
}

export interface ParseFailure {
  readonly kind: 'parse';
  readonly row: number;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly sections: readonly EditSection[] }
  | { readonly ok: false; readonly failure: ParseFailure };

const HEADER = /^\[([^\]#]+)(?:#([0-9a-f]+))?\]$/;
const PUT_RANGE = /^PUT (\d+)(?:\.=(\d+))?:$/;
const PUT_BLOCK = /^PUT (\d+)\*:$/;
const PUT_GAP = /^PUT ([<>])(\d+):$/;
const PASTE = /^PUT ([<>])(\d+) @([A-Za-z0-9_-]+)$/;
const CUT = /^CUT (\d+)(?:\.=(\d+))?(?: @([A-Za-z0-9_-]+))?$/;
const MV = /^MV (.+)$/;

/** Parses a patch. Body rows are consumed by whichever operation opened them. */
export const parseEdit = (source: string): ParseResult => {
  const rows = source.split('\n');
  const sections: Array<{ path: string; tag?: string; ops: EditOp[]; row: number }> = [];
  let current: { path: string; tag?: string; ops: EditOp[]; row: number } | undefined;
  const fail = (row: number, message: string): ParseResult => ({
    ok: false,
    failure: { kind: 'parse', row: row + 1, message }
  });

  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as string;
    if (!row.trim()) {
      index += 1;
      continue;
    }
    const header = HEADER.exec(row);
    if (header) {
      current = {
        path: header[1] as string,
        ...(header[2] ? { tag: header[2] } : {}),
        ops: [],
        row: index + 1
      };
      sections.push(current);
      index += 1;
      continue;
    }
    if (!current)
      return fail(
        index,
        'every operation belongs to a file section; open one with [path#tag] before it'
      );
    if (row.startsWith('+'))
      return fail(index, 'a +body row with no operation above it; every body follows a PUT');

    // A body is every following row that starts with `+`, and stops at the first row that does
    // not. An operation with no body is an empty body, which is how a range is deleted with PUT.
    const takeBody = (): string[] => {
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < rows.length && (rows[cursor] as string).startsWith('+')) {
        body.push((rows[cursor] as string).slice(1));
        cursor += 1;
      }
      index = cursor;
      return body;
    };

    const block = PUT_BLOCK.exec(row);
    if (block) {
      const at = Number(block[1]);
      current.ops.push({ kind: 'replaceBlock', at, body: takeBody() });
      continue;
    }
    const gap = PUT_GAP.exec(row);
    if (gap) {
      current.ops.push({
        kind: 'insert',
        at: Number(gap[2]),
        side: gap[1] === '<' ? 'before' : 'after',
        body: takeBody()
      });
      continue;
    }
    const paste = PASTE.exec(row);
    if (paste) {
      current.ops.push({
        kind: 'paste',
        at: Number(paste[2]),
        side: paste[1] === '<' ? 'before' : 'after',
        register: paste[3] as string
      });
      index += 1;
      continue;
    }
    const range = PUT_RANGE.exec(row);
    if (range) {
      const from = Number(range[1]);
      const to = range[2] === undefined ? from : Number(range[2]);
      if (to < from) return fail(index, `range ends before it starts: ${from}.=${to}`);
      current.ops.push({ kind: 'replace', from, to, body: takeBody() });
      continue;
    }
    const cut = CUT.exec(row);
    if (cut) {
      const from = Number(cut[1]);
      const to = cut[2] === undefined ? from : Number(cut[2]);
      if (to < from) return fail(index, `range ends before it starts: ${from}.=${to}`);
      current.ops.push({
        kind: 'cut',
        from,
        to,
        ...(cut[3] ? { register: cut[3] } : {})
      });
      index += 1;
      continue;
    }
    if (row === 'REM') {
      current.ops.push({ kind: 'remove' });
      index += 1;
      continue;
    }
    const move = MV.exec(row);
    if (move) {
      current.ops.push({ kind: 'rename', to: (move[1] as string).trim() });
      index += 1;
      continue;
    }
    return fail(
      index,
      `not an operation: ${row.slice(0, 60)} - expected PUT N:, PUT N.=M:, PUT N*:, PUT <N:, PUT >N:, PUT >N @name, CUT N.=M, REM or MV path`
    );
  }

  if (!sections.length) return fail(0, 'empty patch: no [path#tag] section');
  return { ok: true, sections };
};
