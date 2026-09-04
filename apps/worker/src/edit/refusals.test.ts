/**
 * The bound on a patch sent again byte for byte: the second refusal is a different sentence, it
 * names the fix, and it still carries the file's text.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEdit, type EditRefusal } from './apply.js';
import { toLines } from './format.js';
import {
  boundRepeatedRefusal,
  forgetRefusal,
  forgetRefusals,
  WHOLE_FILE_FALLBACK_LINES
} from './refusals.js';
import { forgetReads, readsOf, recordRead } from './snapshots.js';

const TASK = 'task-1';
const PATH = 'workspace/small.ts';
const FILE = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n');

const refusalOf = (patch: string, live = FILE): EditRefusal => {
  const result = applyEdit(PATH, patch, live, readsOf(TASK, PATH));
  if (result.ok) throw new Error('applied when it should have refused');
  return result.refusal;
};

beforeEach(() => {
  forgetReads();
  forgetRefusals();
  recordRead(TASK, PATH, 1, FILE);
});

describe('a patch refused twice', () => {
  it('is answered the first time with the reason and the second time with the fix', () => {
    const patch = 'PUT 2:\n-const z = 9;\n+const b = 3;';
    const first = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    const second = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    expect(first.message).not.toMatch(/byte-for-byte/);
    expect(second.message).toMatch(/byte-for-byte the patch just refused/);
    expect(second.message).toMatch(/The one change that fixes it: drop the - row/);
    expect(second.message).not.toBe(first.message);
    // The file's text still travels, so the retry is still a re-emit.
    expect(second.message).toMatch(/2:const b = 2;/);
    expect(second.kind).toBe(first.kind);
  });

  it('names file_write as the way out of a short file the model has seen all of', () => {
    const patch = 'PUT 2:\n-const z = 9;\n+const b = 3;';
    boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    const second = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    expect(second.message).toMatch(/send the whole 4-line file with file_write/);
  });

  it('does not offer file_write for a file not fully shown, or one that is long', () => {
    const patch = 'PUT 2:\n-const z = 9;\n+const b = 3;';
    boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), false);
    const partial = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), false);
    expect(partial.message).not.toMatch(/file_write/);

    forgetRefusals();
    const long = Array.from({ length: WHOLE_FILE_FALLBACK_LINES }, (_, at) => `line ${at + 1};`);
    boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), long, true);
    const tall = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), long, true);
    expect(tall.message).not.toMatch(/file_write/);
  });

  it('treats a different patch, or the same patch failing differently, as a first refusal', () => {
    const one = 'PUT 2:\n-const z = 9;\n+const b = 3;';
    const other = 'PUT 3:\n-const z = 9;\n+const c = 4;';
    boundRepeatedRefusal(TASK, PATH, one, refusalOf(one), toLines(FILE), true);
    const second = boundRepeatedRefusal(TASK, PATH, other, refusalOf(other), toLines(FILE), true);
    expect(second.message).not.toMatch(/byte-for-byte/);
  });

  it('forgets the refusal once a patch to that file lands, and per task', () => {
    const patch = 'PUT 2:\n-const z = 9;\n+const b = 3;';
    boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    forgetRefusal(TASK, PATH);
    const again = boundRepeatedRefusal(TASK, PATH, patch, refusalOf(patch), toLines(FILE), true);
    expect(again.message).not.toMatch(/byte-for-byte/);
    const elsewhere = boundRepeatedRefusal(
      'task-2',
      PATH,
      patch,
      refusalOf(patch),
      toLines(FILE),
      true
    );
    expect(elsewhere.message).not.toMatch(/byte-for-byte/);
  });

  it('names a spelling for a parse failure, and the merged range for an overlap', () => {
    const bad = 'PUT 2:\nconst b = 3;';
    boundRepeatedRefusal(TASK, PATH, bad, refusalOf(bad), toLines(FILE), true);
    const parse = boundRepeatedRefusal(TASK, PATH, bad, refusalOf(bad), toLines(FILE), true);
    expect(parse.message).toMatch(/every body row with a \+ marker/);
    expect(parse.message).toMatch(/PUT 12\.=14:/);

    const overlapping = 'PUT 1.=2:\n+x\nPUT 2:\n+y';
    boundRepeatedRefusal(TASK, PATH, overlapping, refusalOf(overlapping), toLines(FILE), true);
    const overlap = boundRepeatedRefusal(
      TASK,
      PATH,
      overlapping,
      refusalOf(overlapping),
      toLines(FILE),
      true
    );
    expect(overlap.message).toMatch(/write one operation PUT 1\.=2:/);
  });
});
