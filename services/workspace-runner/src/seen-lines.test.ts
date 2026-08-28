import { beforeEach, describe, expect, it } from 'vitest';
import {
  discloseUnseen,
  displayedLines,
  forgetDisplayedLines,
  lineEdit,
  readerFor,
  recordDisplayedLines,
  rememberWrite,
  sayRanges,
  SEEN_LINE_HORIZON_MS,
  unseenWithin
} from './seen-lines.js';

const IDENTITY = '1:2:3:4';
/** Two tasks in one workspace, which is the arrangement the key exists to tell apart. */
const A = { task: 'task-a' };
const B = { task: 'task-b' };

describe('what an edit rests on', () => {
  it('finds the replaced span and nothing either side of it', () => {
    const before = ['a', 'b', 'c', 'd', 'e'];
    const edit = lineEdit(before, ['a', 'b', 'C', 'd', 'e']);
    expect(edit.anchors).toEqual([{ start: 3, end: 3 }]);
    expect(edit.hunks).toEqual([{ oldFrom: 3, oldTo: 3, newFrom: 3, newTo: 3 }]);
  });

  /*
   * A pure insertion replaces nothing, so it has no changed span of its own - and reporting no
   * anchors for it would let the blindest edit of all through: appending to a file whose end was
   * never displayed. It rests on the lines it was slid between, and that is what must have been
   * seen.
   */
  it('anchors an insertion on the lines it was slid between', () => {
    expect(lineEdit(['a', 'b', 'c'], ['a', 'b', 'new', 'c']).anchors).toEqual([
      { start: 2, end: 3 }
    ]);
    expect(lineEdit(['a', 'b', 'c'], ['a', 'b', 'c', 'tail']).anchors).toEqual([
      { start: 3, end: 3 }
    ]);
  });

  it('rests on nothing when nothing changed, and when the file was empty', () => {
    expect(lineEdit(['a', 'b'], ['a', 'b']).anchors).toEqual([]);
    expect(lineEdit([], ['a', 'b']).anchors).toEqual([]);
  });

  /*
   * THE FALSE REFUSAL, measured before this reported more than one span. Walking in from both ends
   * alone answers with the hull from the first change to the last, so a write that changes line 20
   * and line 320 of a 400-line file claimed to change lines 20 to 320 - and the guard refused it
   * with "this edit changes app.ts at line 51-299", 249 lines it does not touch, on an edit whose
   * every changed line had been displayed.
   */
  it('reports the two places a write touched, and nothing in the middle', () => {
    const before = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`);
    const after = [...before];
    after[19] = 'line 20 // touched';
    after[319] = 'line 320 // touched';
    expect(lineEdit(before, after).anchors).toEqual([
      { start: 20, end: 20 },
      { start: 320, end: 320 }
    ]);
  });

  /*
   * The imprecision has a direction, and this is it. A line reported as changed that was not costs
   * a refusal the caller lifts by reading; a line reported as unchanged that was not would vouch
   * for text nobody has seen. Every span the old file loses is inside an anchor, whatever the shape
   * of the edit - here a block deleted, a block inserted somewhere else, and the file's length
   * changed by both.
   */
  it('covers every line the write destroys, on an edit that moves and resizes', () => {
    const before = Array.from({ length: 200 }, (_, line) => `line ${line + 1}`);
    const after = [
      ...before.slice(0, 40),
      'new one',
      'new two',
      ...before.slice(60, 120),
      ...before.slice(150)
    ];
    const edit = lineEdit(before, after);
    const covered = (line: number): boolean =>
      edit.anchors.some((anchor) => anchor.start <= line && line <= anchor.end);
    for (const gone of [41, 50, 60, 121, 140, 150]) expect(covered(gone)).toBe(true);
    for (const kept of [1, 20, 40, 61, 100, 120, 151, 200]) expect(covered(kept)).toBe(false);
  });

  it('subtracts what was seen from what the edit touches', () => {
    expect(unseenWithin({ start: 1, end: 10 }, [{ start: 1, end: 10 }])).toEqual([]);
    expect(unseenWithin({ start: 1, end: 10 }, [{ start: 3, end: 5 }])).toEqual([
      { start: 1, end: 2 },
      { start: 6, end: 10 }
    ]);
    expect(unseenWithin({ start: 300, end: 300 }, [{ start: 1, end: 50 }])).toEqual([
      { start: 300, end: 300 }
    ]);
    expect(
      sayRanges([
        { start: 6, end: 10 },
        { start: 12, end: 12 }
      ])
    ).toBe('6-10, 12');
  });
});

describe('the seen-line record', () => {
  beforeEach(() => forgetDisplayedLines());

  it('says nothing at all about a file no read has shown, which is not the same as saying no', () => {
    expect(displayedLines(A, '/w/a.ts', IDENTITY)).toBeUndefined();
  });

  it('merges adjacent windows into one run', () => {
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 50 });
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 51, end: 60 });
    expect(displayedLines(A, '/w/a.ts', IDENTITY)).toEqual([{ start: 1, end: 60 }]);
  });

  /*
   * The bytes moved under the record, so line 300 is no longer the line 300 that was displayed. A
   * record that outlived its content would vouch for text nobody has seen, which is the exact
   * failure it exists to catch.
   */
  it('is void once the file it described has changed', () => {
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 50 });
    expect(displayedLines(A, '/w/a.ts', '1:2:3:9')).toBeUndefined();
    // And dropped, not merely disbelieved: a record that cannot be true again is not worth holding.
    expect(displayedLines(A, '/w/a.ts', IDENTITY)).toBeUndefined();
  });

  it('is void past the retention horizon', () => {
    const now = Date.now();
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 50 }, now);
    expect(displayedLines(A, '/w/a.ts', IDENTITY, now + SEEN_LINE_HORIZON_MS)).toEqual([
      { start: 1, end: 50 }
    ]);
    expect(displayedLines(A, '/w/a.ts', IDENTITY, now + SEEN_LINE_HORIZON_MS + 1)).toBeUndefined();
  });

  /*
   * This box runs for months. Both caps below are memory bounds, and both fail towards "no
   * opinion": what a full store loses is the guard, never the write.
   */
  it('keeps a bounded working set of records, evicting the least recently read', () => {
    for (let file = 0; file < 1_200; file += 1)
      recordDisplayedLines(A, `/w/${file}.ts`, IDENTITY, { start: 1, end: 10 });
    expect(displayedLines(A, '/w/1199.ts', IDENTITY)).toEqual([{ start: 1, end: 10 }]);
    expect(displayedLines(A, '/w/0.ts', IDENTITY)).toBeUndefined();
    let kept = 0;
    for (let file = 0; file < 1_200; file += 1)
      if (displayedLines(A, `/w/${file}.ts`, IDENTITY)) kept += 1;
    expect(kept).toBe(1_024);
  });

  /*
   * A slot is one file for ONE READER, which is what the key cost and why the cap moved with it.
   * Two tasks reading the same file hold a record each, and the LRU is one queue across all of
   * them - so a busy task can push out a quiet one's record. Stated rather than hidden: what a full
   * store loses is an opinion and never a write, and it loses a whole record rather than half of
   * one, so no reader is ever left credited with lines it did not see.
   */
  it('spends a slot per reader of the same file, and evicts across readers', () => {
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 10 });
    recordDisplayedLines(B, '/w/a.ts', IDENTITY, { start: 90, end: 99 });
    expect(displayedLines(A, '/w/a.ts', IDENTITY)).toEqual([{ start: 1, end: 10 }]);
    expect(displayedLines(B, '/w/a.ts', IDENTITY)).toEqual([{ start: 90, end: 99 }]);
    for (let file = 0; file < 1_024; file += 1)
      recordDisplayedLines(A, `/w/${file}.ts`, IDENTITY, { start: 1, end: 10 });
    expect(displayedLines(B, '/w/a.ts', IDENTITY)).toBeUndefined();
    expect(displayedLines(A, '/w/1023.ts', IDENTITY)).toEqual([{ start: 1, end: 10 }]);
  });

  /*
   * The key is a pair and has to be read back as one. Run together, `a` reading `b/x` and `ab`
   * reading `/x` spell one string - the same defect arriving by collision rather than by design,
   * and the worse version because nothing in the shape of the code would show it. No pair reachable
   * today collides, since `sub` is a UUID and a target is an absolute path; the separator is what
   * makes that a property of the key rather than of two callers this module does not own.
   */
  it('cannot be spelled the same way by a different reader and file', () => {
    recordDisplayedLines({ task: 'a' }, 'b/x', IDENTITY, { start: 1, end: 10 });
    expect(displayedLines({ task: 'ab' }, '/x', IDENTITY)).toBeUndefined();
    expect(displayedLines({ task: 'a' }, 'b/x', IDENTITY)).toEqual([{ start: 1, end: 10 }]);
  });

  /*
   * WHO A CAPABILITY IS, and the deliberate answer for a holder that is not an agent.
   *
   * The owner in the Files pane and a `control` caller are never held to what they were shown, so a
   * record filed under either could not be read back by anybody - it would only spend a slot the
   * records doing the guarding need. `sub` is the task the worker minted the token for, and it is
   * signed, so the task cannot pick its own.
   */
  it('is a reader only for an agent, and is the task the capability names', () => {
    expect(readerFor({ role: 'agent', sub: 'task-a' })).toEqual({ task: 'task-a' });
    expect(readerFor({ role: 'user', sub: 'owner-1' })).toBeUndefined();
    expect(readerFor({ role: 'control', sub: 'worker' })).toBeUndefined();
  });

  it('caps the intervals per file by dropping the oldest, never by coalescing them', () => {
    for (let window = 0; window < 200; window += 1)
      recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: window * 2 + 1, end: window * 2 + 1 });
    const seen = displayedLines(A, '/w/a.ts', IDENTITY)!;
    expect(seen).toHaveLength(128);
    // The newest survive; the oldest are gone rather than swallowed into a hull that would vouch
    // for every line between them.
    expect(seen.at(-1)).toEqual({ start: 399, end: 399 });
    expect(unseenWithin({ start: 1, end: 1 }, seen)).toEqual([{ start: 1, end: 1 }]);
    expect(unseenWithin({ start: 145, end: 145 }, seen)).toEqual([]);
  });
});

describe('handing back what was never shown', () => {
  it('inlines the real text with its line numbers', () => {
    const before = ['one', 'two', 'three', 'four'];
    const disclosure = discloseUnseen(before, [{ start: 2, end: 3 }])!;
    expect(disclosure.text).toBe('2| two\n3| three');
    expect(disclosure.disclosed).toEqual([{ start: 2, end: 3 }]);
  });

  /*
   * The worker reads 4,000 bytes of a failure body and no more. Past the caps the honest answer is
   * different in kind - go and read it - because dribbling a screenful per round trip costs the
   * owner more than the read would have.
   */
  it('refuses to inline more than a glance, so the answer becomes go and read it', () => {
    const before = Array.from({ length: 200 }, (_, line) => `line ${line + 1}`);
    expect(discloseUnseen(before, [{ start: 1, end: 41 }])).toBeUndefined();
    expect(discloseUnseen([`${'z'.repeat(4_000)}`], [{ start: 1, end: 1 }])).toBeUndefined();
  });

  it('discloses only what fits, and says so by naming a shorter range', () => {
    const before = Array.from({ length: 40 }, () => 'y'.repeat(200));
    const disclosure = discloseUnseen(before, [{ start: 1, end: 30 }])!;
    expect(Buffer.byteLength(disclosure.text, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(disclosure.disclosed[0]!.end).toBeLessThan(30);
  });
});

describe('carrying a record across the write it just allowed', () => {
  beforeEach(() => forgetDisplayedLines());

  /*
   * Without this the guard is one edit deep per file: the write changes the file, the identity
   * stops matching, and the next patch - the one aimed at line 300 after the first one tidied line
   * 20 - goes through unexamined.
   */
  it('shifts the seen lines by what the edit changed, and keeps the far end unseen', () => {
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 50 });
    const before = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`);
    const after = [...before.slice(0, 20), 'inserted', ...before.slice(20)];
    rememberWrite(A, '/w/a.ts', 'after', lineEdit(before, after));
    const seen = displayedLines(A, '/w/a.ts', 'after')!;
    // Fifty lines seen, one line inserted among them: fifty-one lines are now accounted for.
    expect(unseenWithin({ start: 1, end: 51 }, seen)).toEqual([]);
    expect(unseenWithin({ start: 300, end: 300 }, seen)).toEqual([{ start: 300, end: 300 }]);
  });

  /*
   * A write must never be the thing that starts guarding a file. The file browser reads whole files
   * and writes them back and never reads a window; if its first save created a record, its second
   * would be refused for lines the first had not touched.
   */
  it('never starts guarding a file that no read had shown', () => {
    rememberWrite(A, '/w/b.ts', 'after', lineEdit(['a'], ['b']));
    expect(displayedLines(A, '/w/b.ts', 'after')).toBeUndefined();
  });

  /*
   * And it carries the writer's own record and nobody else's. Task B's record of the same file
   * describes the bytes as they were before A's write; shifting it by hunks B never saw would be
   * this module inventing a reading for B. It is left to go stale, and B's identity check finds it.
   */
  it("leaves another reader's record where it is, to be found stale by its own check", () => {
    recordDisplayedLines(A, '/w/a.ts', IDENTITY, { start: 1, end: 50 });
    recordDisplayedLines(B, '/w/a.ts', IDENTITY, { start: 1, end: 50 });
    const before = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`);
    const after = [...before.slice(0, 20), 'inserted', ...before.slice(20)];
    rememberWrite(A, '/w/a.ts', 'after', lineEdit(before, after));
    expect(displayedLines(A, '/w/a.ts', 'after')).toBeDefined();
    // B was shown the file that used to be there, and the file that used to be there is gone.
    expect(displayedLines(B, '/w/a.ts', 'after')).toBeUndefined();
  });
});
