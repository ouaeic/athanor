/**
 * The edit vertical, held to the two things it claims: it applies the cheap dialect correctly, and
 * it recovers from every named way of writing that dialect wrongly WITHOUT a second read.
 *
 * The second half is the one that decides whether the format ships. The offline comparison priced a
 * line-addressed edit at 61% fewer output characters than the quoted editor it replaces, and every
 * one of those numbers is an upper bound available only to a model that emits the dialect perfectly.
 * The harness this format was measured from answers that by maintaining a list of models that
 * cannot, and routing them elsewhere. Each test under "forgiveness" is one entry off that list,
 * turned into a case that lands.
 *
 * Every refusal here is asserted to CARRY THE FILE'S REAL TEXT, not merely to refuse. A refusal that
 * costs a round trip is barely better than the wrong edit it prevented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEdit } from './apply.js';
import { blockAt } from './block.js';
import { normaliseLine, renderNumbered, sameLine, toLines } from './format.js';
import { parseEdit } from './parse.js';
import { EDIT_FORMAT_SPEC } from './prompt.js';
import {
  displayedRanges,
  firstUnshownLine,
  forgetReads,
  readsOf,
  recordRead,
  recordWrite,
  SNAPSHOTS_PER_PATH
} from './snapshots.js';

const TASK = 'task-1';
const PATH = 'workspace/queue.ts';

const FILE = [
  'export const drain = (queue: Job[]) => {',
  '  const job = queue.shift();',
  '  if (!job) return null;',
  '  return job.payload;',
  '};',
  '',
  'export const size = (queue: Job[]) => {',
  '  if (!queue) return null;',
  '  return queue.length;',
  '};'
].join('\n');

/** A read, exactly as `file_read` performs one: number the lines, remember what was shown. */
const read = (text = FILE, path = PATH, startLine = 1): string => {
  const lines = toLines(text).slice(startLine - 1);
  recordRead(TASK, path, startLine, lines.join('\n'));
  return renderNumbered(lines, startLine);
};

const apply = (patch: string, live = FILE, path = PATH) =>
  applyEdit(path, patch, live, readsOf(TASK, path));

const applied = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.text;
};

/** A patch, exactly as `file_patch` performs one: apply it, then record what it authored. */
const patched = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  recordWrite(TASK, path, result.text, result.changed);
  return result.text;
};

const refused = (patch: string, live = FILE, path = PATH): string => {
  const result = apply(patch, live, path);
  if (result.ok) throw new Error(`applied when it should have refused:\n${result.text}`);
  return result.refusal.message;
};

beforeEach(() => forgetReads());

describe('the read side', () => {
  it('numbers every line from one, which is what the format addresses', () => {
    expect(read().split('\n')[0]).toBe('1:export const drain = (queue: Job[]) => {');
    expect(read().split('\n')[9]).toBe('10:};');
  });

  it('numbers a window by its own start, so a partial read is still addressable', () => {
    expect(read(FILE, PATH, 7).split('\n')[0]).toBe('7:export const size = (queue: Job[]) => {');
  });

  it('keeps the trailing empty line a file ending in a newline has', () => {
    // The runner's ranged reader says so explicitly, and an applier that disagreed with it would be
    // off by one on every edit near the end of a file.
    expect(toLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(renderNumbered(toLines('a\nb\n'), 1)).toBe('1:a\n2:b\n3:');
  });
});

describe('the canonical dialect', () => {
  it('replaces a range, emitting only the new text', () => {
    read();
    expect(
      applied('PUT 3.=4:\n+  if (!job) return undefined;\n+  return job.payload ?? null;')
    ).toBe(
      FILE.replace(
        '  if (!job) return null;\n  return job.payload;',
        '  if (!job) return undefined;\n  return job.payload ?? null;'
      )
    );
  });

  it('replaces one line inside a repeated stanza, which is the case the quote was worst at', () => {
    // Line 8 is byte-identical to line 3. A quoted editor has to grow its quote past both of them;
    // the number is the whole address.
    read();
    const out = toLines(applied('PUT 8:\n+  if (!queue) return 0;'));
    expect(out[2]).toBe('  if (!job) return null;');
    expect(out[7]).toBe('  if (!queue) return 0;');
  });

  it('inserts before and after a line without repeating it', () => {
    read();
    expect(toLines(applied('PUT <1:\n+// header'))[0]).toBe('// header');
    expect(toLines(applied('PUT >5:\n+// tail'))[5]).toBe('// tail');
  });

  it('deletes a range with CUT, and with a PUT that has no body', () => {
    read();
    expect(toLines(applied('CUT 6')).length).toBe(9);
    expect(toLines(applied('PUT 6:')).length).toBe(9);
  });

  it('replaces the whole block that opens at a line', () => {
    read();
    const out = toLines(applied('PUT 7*:\n+export const size = () => 0;'));
    expect(out.slice(6)).toEqual(['export const size = () => 0;']);
  });

  it('moves a block with one copy of it on the wire', () => {
    read();
    const out = applied('CUT 7.=10 @size\nPUT <1 @size');
    expect(toLines(out)[0]).toBe('export const size = (queue: Job[]) => {');
    expect(out).not.toContain('export const size = (queue: Job[]) => {\n  const job');
    // The saving is the whole reason the operation exists: the moved lines are named, not typed.
    expect('CUT 7.=10 @size\nPUT <1 @size'.length).toBeLessThan(40);
  });

  it('resolves every range against the file as READ, not against its own earlier hunks', () => {
    read();
    const out = toLines(applied('PUT 1:\n+A\n+B\nPUT 9:\n+  return 0;'));
    // The first hunk added a line. A front-to-back applier would put the second one at line 8.
    expect(out[9]).toBe('  return 0;');
  });
});

describe('forgiveness - a dropped or malformed header', () => {
  it('needs no header at all, because the path is a field of the call', () => {
    read();
    expect(apply('PUT 3:\n+  if (!job) return undefined;').ok).toBe(true);
  });

  it('accepts and drops a [path#tag] header a model brought from another dialect', () => {
    read();
    const result = apply('[workspace/queue.ts#3f9a]\nPUT 3:\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.join(' ')).toMatch(/dropped a \[path\] section header/);
  });

  it('accepts a header naming a different file without letting it choose the file', () => {
    // The path in the call is the authority. A header that disagreed with it used to be the one way
    // a patch could be applied to a file the approval card had never named.
    read();
    const out = applied('[some/other/file.ts]\nPUT 3:\n+  if (!job) return undefined;');
    expect(toLines(out)[2]).toBe('  if (!job) return undefined;');
  });
});

describe('forgiveness - a misspelt operation', () => {
  const bodies = '\n+  if (!job) return undefined;\n+  return job.payload ?? null;';
  for (const spelling of [
    'PUT 3.=4:',
    'PUT 3-4:',
    'PUT 3..4:',
    'PUT 3,4:',
    'PUT 3 to 4:',
    'PUT 3.=4',
    'put 3.=4:',
    'PUT 4.=3:'
  ])
    it(`reads "${spelling}" as PUT 3.=4:`, () => {
      read();
      const out = toLines(applied(spelling + bodies));
      expect(out[2]).toBe('  if (!job) return undefined;');
      expect(out[3]).toBe('  return job.payload ?? null;');
      expect(out.length).toBe(10);
    });

  it('says which spellings it forgave, so the next patch is written the short way', () => {
    read();
    const result = apply('put 3-4:' + bodies);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.join(' ')).toMatch(/as 3\.=4/);
  });

  it('refuses an unreadable operation by naming the row and the shapes that exist', () => {
    read();
    const message = refused('REPLACE 3 WITH X');
    expect(message).toMatch(/not an operation/);
    expect(message).toMatch(/PUT N\.=M:/);
  });

  it('points a REM or an MV at the tool that can actually do it', () => {
    read();
    expect(refused('REM')).toMatch(/cannot delete one\. Use shell/);
    expect(refused('MV workspace/other.ts')).toMatch(/cannot rename or move one\. Use shell/);
  });
});

describe('forgiveness - a model that reached for a unified diff', () => {
  it('takes - rows as evidence and applies the edit', () => {
    read();
    const result = apply(
      'PUT 3.=4:\n-  if (!job) return null;\n-  return job.payload;\n+  return job?.payload ?? null;'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  return job?.payload ?? null;');
      expect(result.notes.join(' ')).toMatch(/unified-diff hunk/);
    }
  });

  it('applies a whole @@ hunk with context rows and no PUT at all', () => {
    read();
    const out = toLines(
      applied(
        '@@ -2,3 +2,3 @@\n   const job = queue.shift();\n-  if (!job) return null;\n+  if (!job) return undefined;\n   return job.payload;'
      )
    );
    expect(out[1]).toBe('  const job = queue.shift();');
    expect(out[2]).toBe('  if (!job) return undefined;');
    expect(out[3]).toBe('  return job.payload;');
    expect(out.length).toBe(10);
  });

  it('refuses a space-prefixed row when nothing says it is context, and says why', () => {
    // The one place leniency is refused on purpose: a leading space is either a context marker or a
    // + the model dropped, and the two readings put different text in the file.
    read();
    expect(refused('PUT 3:\n+  if (!job) return undefined;\n   return job.payload;')).toMatch(
      /either unchanged context or a line whose \+ was dropped/
    );
  });

  it('refuses + rows under a CUT rather than quietly throwing them away', () => {
    read();
    expect(refused('CUT 3.=4\n+  return null;')).toMatch(/only deletes/);
  });
});

describe('forgiveness - a model that pasted the whole diff', () => {
  it('drops the git diff preamble and applies the hunk under it', () => {
    /*
     * A bare `@@` hunk was forgiven and a whole `git diff` was not, which is backwards: the whole
     * diff is what the tool a model has seen a million times actually prints. `--- a/path` begins
     * with a minus, so it was refused as "a body row with no operation above it" - a message about
     * bodies for a fault about headers, which never named the row that caused it.
     */
    read();
    const result = apply(
      [
        'diff --git a/workspace/queue.ts b/workspace/queue.ts',
        'index 1a2b3c4d..5e6f7a8b 100644',
        '--- a/workspace/queue.ts',
        '+++ b/workspace/queue.ts',
        '@@ -3,1 +3,1 @@',
        '-  if (!job) return null;',
        '+  if (!job) return undefined;'
      ].join('\n')
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(result.notes.join(' ')).toMatch(/dropped the git diff header rows/);
    }
  });

  it('does not let a preamble naming another file move the edit to it', () => {
    // The same guarantee the `[path]` header gets: the path is a field of the call, and nothing in
    // the patch text may choose a different one.
    read();
    const out = applied('--- a/some/other/file.ts\n+++ b/some/other/file.ts\nPUT 3:\n+  changed;');
    expect(toLines(out)[2]).toBe('  changed;');
  });

  it('reads a space-separated range, which the header comment already promised', () => {
    // A comment that lies about behaviour is the same defect as behaviour that lies about itself,
    // and of the two spellings the cheaper one to fix is the one that costs a round trip.
    read();
    const out = toLines(applied('PUT 3 4:\n+  a;\n+  b;'));
    expect(out[2]).toBe('  a;');
    expect(out[3]).toBe('  b;');
    expect(out.length).toBe(10);
  });
});

describe('forgiveness - a miscounted anchor', () => {
  it('corrects an off-by-one when the model quoted what it meant to replace', () => {
    read();
    // Addressed line 4, quoted line 3. The quote is a statement of intent the harness can check.
    const result = apply('PUT 4:\n-  if (!job) return null;\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[2]).toBe('  if (!job) return undefined;');
      expect(toLines(result.text)[3]).toBe('  return job.payload;');
      expect(result.notes.join(' ')).toMatch(/off by 1/);
    }
  });

  it('corrects an off-by-one on a file that repeats the quoted line, which is the case bought', () => {
    /*
     * The correction searched the WHOLE FILE and gave up unless the quote occurred exactly once in
     * it - so on a file that says `if (!job) return null;` three times, an off-by-one whose quote
     * named the right line was refused. The recovery had inherited the exact requirement the format
     * was bought to escape, and it failed on precisely the file shape the 61% was measured on: a
     * quoted editor cannot edit inside a repeated stanza cheaply, and that is the whole argument.
     *
     * `CORRECTION_RADIUS` was already the only distance an anchor could move, so searching the
     * window rather than the file is strictly narrower in reach and strictly wider in recovery.
     */
    const repetitive = [
      'export const a = (q: Job[]) => {', //  1
      '  const job = q.shift();', //         2
      '  if (!job) return null;', //         3
      '  return job;', //                    4
      '};', //                               5
      '', //                                 6
      'export const b = (q: Job[]) => {', // 7
      '  const job = q[0];', //              8
      '  if (!job) return null;', //         9
      '  return job;', //                   10
      '};', //                              11
      '', //                                12
      'export const c = (q: Job[]) => {', //13
      '  const job = q.pop();', //          14
      '  if (!job) return null;', //        15
      '  return job;', //                   16
      '};' //                               17
    ].join('\n');
    read(repetitive);
    // Addressed line 8, quoted line 9 - and that quote is in the file three times.
    const result = apply(
      'PUT 8:\n-  if (!job) return null;\n+  if (!job) return undefined;',
      repetitive
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[8]).toBe('  if (!job) return undefined;');
      // The other two stanzas are untouched: the correction reaches three lines, never the file.
      expect(toLines(result.text)[2]).toBe('  if (!job) return null;');
      expect(toLines(result.text)[14]).toBe('  if (!job) return null;');
      expect(result.notes.join(' ')).toMatch(/off by 1/);
    }
  });

  it('still refuses when the quoted line repeats INSIDE the window it may correct within', () => {
    // The bound the case above rests on. Two identical lines three apart leave the harness no
    // unambiguous answer, and an ambiguous correction is how a format like this corrupts code.
    const twins = ['const x = 1;', '  same();', '  same();', 'const y = 2;'].join('\n');
    read(twins);
    const message = refused('PUT 1:\n-  same();\n+  same(2);', twins);
    expect(message).toMatch(/appears more than once/);
    expect(message).toMatch(/1:const x = 1;/);
    // Untouched, which is the assertion that matters: an ambiguous correction writes nothing.
    expect(applyEdit(PATH, 'PUT 1:\n+const x = 2;', twins, readsOf(TASK, PATH)).ok).toBe(true);
  });

  it('refuses when the quoted text is too far from the anchor to be a miscount', () => {
    read();
    const message = refused('PUT 1:\n-  return queue.length;\n+  return queue.length ?? 0;');
    expect(message).toMatch(/too far to correct without guessing/);
    expect(message).toMatch(/1:export const drain/);
  });

  it('refuses when the quoted text is nowhere, and shows what is actually there', () => {
    read();
    const message = refused(
      'PUT 3:\n-  if (!job) throw new Error();\n+  if (!job) return undefined;'
    );
    expect(message).toMatch(/not in the file/);
    expect(message).toMatch(/3: {2}if \(!job\) return null;/);
  });

  it('accepts a plain off-by-one it has no evidence about, and shows what it wrote', () => {
    /*
     * The deliberate ruling, and the one that had to go either way. With no - rows there is nothing
     * in the patch that says what the model believed was at line 4, so an off-by-one is
     * indistinguishable from a correct edit and refusing every plain range would be refusing the
     * format. It lands, and the result carries the numbered text of what was written with a line of
     * context on each side, so the miscount is visible on the same turn.
     */
    read();
    const result = apply('PUT 4:\n+  if (!job) return undefined;');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wrote).toEqual([{ from: 4, to: 4 }]);
  });
});

describe('an anchor nobody was shown', () => {
  it('refuses a line outside the window that was read, with the real text inlined', () => {
    read(FILE, PATH, 1);
    forgetReads();
    read(FILE, PATH, 1);
    // A window read of the first four lines only.
    forgetReads();
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 4).join('\n'));
    const message = refused('PUT 8:\n+  if (!queue) return 0;');
    expect(message).toMatch(/No read has shown you/);
    expect(message).toMatch(/8: {2}if \(!queue\) return null;/);
  });

  it('refuses when no read of the file is on record at all', () => {
    expect(refused('PUT 3:\n+x')).toMatch(/No read of .* is on record/);
  });

  it('refuses a line past the end of the file, and shows where the file ends', () => {
    read();
    const message = refused('PUT 40:\n+x');
    expect(message).toMatch(/has 10 lines, and this patch addresses line 40/);
    expect(message).toMatch(/10:};/);
  });
});

describe('a file that moved under the edit', () => {
  const shifted = `// added\n// added\n${FILE}`;

  it('follows the text when the file shifted, rather than refusing', () => {
    read();
    const result = apply('PUT 3.=4:\n+  return job?.payload ?? null;', shifted);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toLines(result.text)[4]).toBe('  return job?.payload ?? null;');
      expect(result.notes.join(' ')).toMatch(/had moved to 5-6/);
    }
  });

  it('follows an insert too, by widening its one-line anchor', () => {
    read();
    const result = apply('PUT >4:\n+  // done', shifted);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[6]).toBe('  // done');
  });

  it('fails closed when the lines it read are gone, and shows the file as it reads now', () => {
    read();
    const rewritten = toLines(FILE)
      .map((line, index) => (index === 2 || index === 3 ? '  // gone' : line))
      .join('\n');
    const message = refused('PUT 3.=4:\n+x', rewritten);
    expect(message).toMatch(/no longer there/);
    expect(message).toMatch(/3: {2}\/\/ gone/);
  });

  it('fails closed when the shifted lines now appear twice, so there is no unambiguous place', () => {
    read();
    const duplicated = `// added\n// added\n${FILE}\n${toLines(FILE).slice(2, 4).join('\n')}`;
    expect(refused('PUT 3.=4:\n+x', duplicated)).toMatch(/gone or now appears more than once/);
  });

  it('does not care that the text is repeated when the numbers are still live', () => {
    /*
     * The quoted editor refuses this, and refusing it is the defect the line address removes. Line 3
     * IS line 3; another copy of its text at the bottom of the file says nothing about that.
     * Uniqueness is only needed to RELOCATE, and nothing needs relocating when nothing moved.
     */
    read();
    const duplicated = `${FILE}\n${toLines(FILE).slice(2, 4).join('\n')}`;
    expect(toLines(applied('PUT 3.=4:\n+x', duplicated))[2]).toBe('x');
  });
});

describe('whitespace, tabs and line endings', () => {
  it('never lets a trailing space or a CR invalidate an anchor', () => {
    expect(sameLine('  return job.payload;  ', '  return job.payload;\r')).toBe(true);
    expect(normaliseLine('a\t \r')).toBe('a');
    // Leading whitespace is indentation and is content; only the tail may vary.
    expect(sameLine('  a', '    a')).toBe(false);
  });

  it('recovers a shifted anchor across a CRLF rewrite of the file', () => {
    read();
    const crlf = toLines(FILE)
      .map((line) => `${line}\r`)
      .join('\n');
    const result = apply('PUT 3:\n+  if (!job) return undefined;', `// added\n${crlf}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(toLines(result.text)[3]).toBe('  if (!job) return undefined;');
  });
});

describe('the bounds that stop a patch corrupting a file', () => {
  it('refuses two operations that touch the same lines, and writes nothing', () => {
    read();
    expect(refused('PUT 3.=4:\n+a\nPUT 4:\n+b')).toMatch(/touch the same lines/);
  });

  it('refuses a paste whose register was never cut', () => {
    read();
    expect(refused('PUT >1 @nothing')).toMatch(/was never filled/);
  });

  it('refuses a block that does not close within the lines that were shown', () => {
    // A window that stops inside a function: claiming the rest of the file would be destructive, so
    // the scanner claims nothing and the applier says so by name.
    recordRead(TASK, PATH, 1, toLines(FILE).slice(0, 3).join('\n'));
    expect(refused('PUT 1*:\n+x')).toMatch(/does not close within the lines you have been shown/);
  });

  it('leaves the file untouched on every refusal', () => {
    read();
    for (const patch of ['PUT 3.=4:\n+a\nPUT 4:\n+b', 'PUT >1 @nothing', 'PUT 400:\n+x'])
      expect(apply(patch).ok).toBe(false);
  });
});

describe('what the store remembers, and what it forgets', () => {
  it('keeps only the last few reads of one file', () => {
    for (let version = 0; version < SNAPSHOTS_PER_PATH + 3; version += 1)
      recordRead(TASK, PATH, 1, `line ${version}`);
    expect(readsOf(TASK, PATH)).toHaveLength(SNAPSHOTS_PER_PATH);
  });

  it('does not spend that budget on identical re-reads', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) recordRead(TASK, PATH, 1, FILE);
    expect(readsOf(TASK, PATH)).toHaveLength(1);
  });

  it('lets a second edit follow the first with no read between them', () => {
    read();
    const once = patched('PUT <1:\n+// header');
    // Line 4 in the NEW numbering is line 3 of the original.
    const twice = applied('PUT 4:\n+  if (!job) return undefined;', once);
    expect(toLines(twice)[3]).toBe('  if (!job) return undefined;');
  });

  /*
   * WHAT A PATCH VOUCHES FOR IS THE SPAN IT WROTE. This re-recorded the entire new file on the
   * argument that a caller has seen what it authored - true of a whole-file write and false of a
   * line-addressed patch, which authors a span and reproduces the rest of a file it may have been
   * shown two hundred lines of. One successful patch therefore made every line of the file
   * editable, so an anchor the record had refused a moment earlier landed silently.
   */
  it('vouches for the span a patch wrote, and for no more of the file than the reads did', () => {
    const long = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`).join('\n');
    recordRead(TASK, PATH, 1, toLines(long).slice(0, 50).join('\n'));
    const after = patched('PUT 10:\n+line 10 // touched', long);

    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 50 }]);
    expect(apply('PUT 300:\n+blind', after).ok).toBe(false);
    expect(apply('PUT 20:\n+line 20 // also touched', after).ok).toBe(true);
  });

  /*
   * The lines a read showed keep meaning what they meant, at whatever numbers the edit moved them
   * to. Three lines replace one at line 10, so the fifty lines that were shown are now fifty-two,
   * and the last of them is line 52.
   */
  it('moves the lines a read showed by what the edit changed the length by', () => {
    const long = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`).join('\n');
    recordRead(TASK, PATH, 1, toLines(long).slice(0, 50).join('\n'));
    const after = patched('PUT 10:\n+one\n+two\n+three', long);

    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 52 }]);
    expect(apply('PUT 52:\n+line 50 // touched', after).ok).toBe(true);
    expect(apply('PUT 53:\n+blind', after).ok).toBe(false);
  });

  it('keeps one task from vouching for another task reads', () => {
    read();
    expect(readsOf('some-other-task', PATH)).toHaveLength(0);
  });

  /*
   * WHICH LINES HAVE BEEN SHOWN IS NOT A QUESTION ABOUT THE SNAPSHOTS. They carry text, so only a
   * few of them can be kept, and answering coverage off them meant a file read from its first line
   * to its last was still reported unread past the last four windows - 37 of this repository's 946
   * tracked files were long enough that no sequence of reads could ever cover them. Runs of numbers
   * cost nothing to keep, and windows that continue one another merge into one.
   */
  it('remembers every line shown, past the few windows whose text it can hold', () => {
    for (let window = 0; window < 40; window += 1)
      recordRead(TASK, PATH, window * 20 + 1, Array.from({ length: 20 }, () => 'x').join('\n'));
    expect(readsOf(TASK, PATH)).toHaveLength(SNAPSHOTS_PER_PATH);
    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 800 }]);
    expect(firstUnshownLine(displayedRanges(TASK, PATH), 800)).toBeUndefined();
    expect(firstUnshownLine(displayedRanges(TASK, PATH), 801)).toBe(801);
  });

  it('names the first line of the first gap, so a refusal can say where to read from', () => {
    expect(firstUnshownLine([], 10)).toBe(1);
    expect(firstUnshownLine([{ start: 1, end: 200 }], 8_332)).toBe(201);
    expect(firstUnshownLine([{ start: 1, end: 200 }], 200)).toBeUndefined();
    // A run that starts past the gap does not close it, and is not what the model is sent to read.
    expect(
      firstUnshownLine(
        [
          { start: 1, end: 200 },
          { start: 400, end: 900 }
        ],
        900
      )
    ).toBe(201);
  });

  /*
   * A whole-file write is the one caller for which "you have seen what you authored" is true of the
   * whole file, so it replaces the record rather than adding to it: the numbers of the version it
   * discarded describe nothing now.
   */
  it('lets a whole-file write replace the record with what it wrote', () => {
    recordRead(
      TASK,
      PATH,
      1,
      Array.from({ length: 50 }, (_, line) => `line ${line + 1}`).join('\n')
    );
    recordWrite(TASK, PATH, 'one\ntwo\nthree');
    expect(displayedRanges(TASK, PATH)).toEqual([{ start: 1, end: 3 }]);
    expect(readsOf(TASK, PATH)[0]?.lines).toEqual(['one', 'two', 'three']);
  });
});

describe('the resident cost', () => {
  it('states the whole format in under 1,200 bytes', () => {
    /*
     * The only part of this vertical that is resident on every request, and therefore the only part
     * whose size is an argument. The reference dialect spends 5,268 bytes on the same job; three of
     * its paragraphs describe a version tag, what to do when it does not match, and how to recover -
     * and nothing here needs the model to carry a tag.
     *
     * A ceiling and not a licence. If it grows, the thing to ask is whether an operation was added
     * or whether prose was.
     */
    expect(Buffer.byteLength(EDIT_FORMAT_SPEC)).toBeLessThan(1_200);
  });

  it('describes every operation the parser accepts, and no operation it does not', () => {
    // A spec that named an operation the parser refuses is a round trip the model cannot avoid; a
    // parser that accepts one the spec omits is a capability nothing can find by reading.
    for (const shape of [
      'PUT N:',
      'PUT N.=M:',
      'PUT N*:',
      'PUT <N:',
      'PUT >N:',
      'CUT N.=M',
      'PUT >N @x'
    ])
      expect(EDIT_FORMAT_SPEC).toContain(shape);
    expect(EDIT_FORMAT_SPEC).not.toContain('REM');
    expect(EDIT_FORMAT_SPEC).not.toContain('MV ');
  });

  it('says nothing about what the parser forgives', () => {
    /*
     * Deliberate, and the reason is that a leniency is not a feature. Documenting `-` rows would
     * spend resident bytes teaching a longer way to write the same edit, and the model would then
     * write it that way on every hunk - which is the whole cost the format exists to remove. The
     * leniency is for a model that reaches for a habit anyway.
     */
    for (const leniency of ['@@', 'unified', 'lower-case', 'optional'])
      expect(EDIT_FORMAT_SPEC.toLowerCase()).not.toContain(leniency.toLowerCase());
  });
});

describe('the block scanner', () => {
  it('finds a braced block and says it closed', () => {
    const found = blockAt(toLines(FILE), 0);
    expect(found).toEqual({ from: 0, to: 4, closed: true });
  });

  it('claims nothing, and says so, when the brackets never balance', () => {
    expect(blockAt(['function f() {', '  return 1;'], 0)).toEqual({
      from: 0,
      to: 0,
      closed: false
    });
  });

  it('finds an indented suite with no brackets at all', () => {
    expect(blockAt(['def f():', '    return 1', '', 'x = 2'], 0)).toEqual({
      from: 0,
      to: 1,
      closed: true
    });
  });
});

describe('the parser, on its own', () => {
  it('reports the row of the failure, so a message can point at it', () => {
    const result = parseEdit('PUT 3:\n+a\nNOT AN OP');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.row).toBe(3);
  });

  it('refuses a body with no operation above it', () => {
    const result = parseEdit('+a\n+b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toMatch(/no operation above it/);
  });

  it('refuses an empty patch rather than writing an empty file', () => {
    const result = parseEdit('   \n\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toMatch(/no operations in it/);
  });
});
