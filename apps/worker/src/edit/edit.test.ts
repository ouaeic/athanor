/**
 * What a consumer observes if the line-addressed editor regresses.
 *
 * Every case here is a way an edit can land on the wrong lines or be refused when it should not
 * be, because those are the only two things this code can get wrong. Nothing pins the spelling of
 * a message; the assertions are on which refusal fired and on the text that came out, so the words
 * can be rewritten without a test having to be edited to allow it.
 */
import { describe, expect, it } from 'vitest';

import { applyEdit } from './apply.js';
import { blockAt } from './block.js';
import { EDIT_FORMAT_SPEC } from './prompt.js';
import { fileTag, normalise, renderNumbered } from './format.js';
import { parseEdit } from './parse.js';
import { SnapshotStore } from './snapshots.js';

const QUEUE = [
  'export const drain = (queue: Job[]): Payload | null => {',
  '  const job = queue.shift();',
  '  if (!job) return null;',
  '  if (!job.ready) return null;',
  '  return job.payload;',
  '};',
  '',
  'export const peek = (queue: Job[]): Payload | null => {',
  '  const job = queue[0];',
  '  if (!job) return null;',
  '  return job.payload;',
  '};'
].join('\n');

const seeded = (path = 'src/queue.ts', text = QUEUE) => {
  const store = new SnapshotStore();
  const tag = store.record(path, text);
  return { store, tag, files: new Map([[path, text]]) };
};

describe('the file tag', () => {
  it('survives what a display or a Windows checkout changes, and nothing else', () => {
    const trailing = QUEUE.split('\n')
      .map((line) => `${line}  `)
      .join('\n');
    expect(fileTag(trailing)).toBe(fileTag(QUEUE));
    expect(fileTag(QUEUE.replace(/\n/g, '\r\n'))).toBe(fileTag(QUEUE));
    // Indentation is content: a re-indented file is a different file and must not tag the same.
    expect(fileTag(QUEUE.replace(/^ {2}/gm, '    '))).not.toBe(fileTag(QUEUE));
    expect(normalise('a \t\r\nb')).toBe('a\nb');
  });

  it('is a lookup key and not a verifier, so a collision is caught by the text', () => {
    // Sixteen bits collide constantly - these two differ by one digit and tag identically, found
    // by walking `export const limit = N;` for N under 300. Whatever resolves a tag has to compare
    // the recorded text, and `resolve` does.
    const one = 'export const limit = 184;';
    const two = 'export const limit = 274;';
    expect(fileTag(one)).toBe(fileTag(two));

    const store = new SnapshotStore();
    store.record('src/limit.ts', one);
    store.record('src/limit.ts', two);
    expect(store.resolve('src/limit.ts', fileTag(one), one).kind).toBe('live');
    expect(store.resolve('src/limit.ts', fileTag(two), two).kind).toBe('live');
    expect(store.resolve('src/limit.ts', fileTag(one), 'export const limit = 999;').kind).toBe(
      'stale'
    );
  });
});

describe('rendering a read', () => {
  it('numbers from one and carries the whole file tag even for a window', () => {
    const rendered = renderNumbered('src/queue.ts', QUEUE, { startLine: 2, endLine: 4 });
    expect(rendered.split('\n')).toEqual([
      `[src/queue.ts#${fileTag(QUEUE)}]`,
      '2:  const job = queue.shift();',
      '3:  if (!job) return null;',
      '4:  if (!job.ready) return null;'
    ]);
  });
});

describe('applying an edit', () => {
  it('replaces a range without the model quoting any of it', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 4:\n+  if (!job.ready) return undefined;`,
      files,
      store
    );
    expect(result.ok).toBe(true);
    expect(result.files.get('src/queue.ts')).toContain('return undefined;');
    // The response carries the next tag, so a second edit needs no second read.
    expect(result.tags.get('src/queue.ts')).toBe(
      fileTag(result.files.get('src/queue.ts') as string)
    );
  });

  it('resolves every range against the original numbering, not against its own earlier hunks', () => {
    const { store, tag, files } = seeded();
    // The first hunk grows the file by two lines. If the second were resolved after it, it would
    // land on line 10 of the new file - `if (!job) return null;` - instead of line 11.
    const result = applyEdit(
      [
        `[src/queue.ts#${tag}]`,
        'PUT 3:',
        '+  if (!job) {',
        '+    return null;',
        '+  }',
        'PUT 11:',
        '+  return job.payload ?? null;'
      ].join('\n'),
      files,
      store
    );
    expect(result.ok).toBe(true);
    const after = (result.files.get('src/queue.ts') as string).split('\n');
    expect(after[2]).toBe('  if (!job) {');
    expect(after.filter((line) => line === '  return job.payload ?? null;')).toHaveLength(1);
    expect(after[12]).toBe('  return job.payload ?? null;');
  });

  it('inserts at a gap on either side of a line', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT <1:\n+import type { Job, Payload } from './types.js';\n+`,
      files,
      store
    );
    expect(result.ok).toBe(true);
    expect((result.files.get('src/queue.ts') as string).split('\n')[0]).toBe(
      "import type { Job, Payload } from './types.js';"
    );
  });

  it('moves a run of lines through a register in one patch', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(`[src/queue.ts#${tag}]\nCUT 8.=12 @peek\nPUT <1 @peek`, files, store);
    expect(result.ok).toBe(true);
    const after = result.files.get('src/queue.ts') as string;
    expect(after.startsWith('export const peek')).toBe(true);
    expect(after.trimEnd().endsWith('};')).toBe(true);
  });

  it('replaces a whole block from its opening line', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 8*:\n+export const peek = (queue: Job[]) => queue[0]?.payload ?? null;`,
      files,
      store
    );
    expect(result.ok).toBe(true);
    expect(result.files.get('src/queue.ts')).toBe(
      [
        ...QUEUE.split('\n').slice(0, 7),
        'export const peek = (queue: Job[]) => queue[0]?.payload ?? null;'
      ].join('\n')
    );
  });

  it('renames and deletes', () => {
    const { store, tag, files } = seeded();
    const renamed = applyEdit(`[src/queue.ts#${tag}]\nMV src/jobs.ts`, files, store);
    expect(renamed.files.get('src/queue.ts')).toBeNull();
    expect(renamed.files.get('src/jobs.ts')).toBe(QUEUE);

    const removed = applyEdit(`[src/queue.ts#${tag}]\nREM`, files, store);
    expect(removed.files.get('src/queue.ts')).toBeNull();
  });
});

describe('refusing an edit', () => {
  it('refuses a tag this session never issued, before it looks at any line number', () => {
    const { store, files } = seeded();
    const result = applyEdit(`[src/queue.ts#beef]\nPUT 3:\n+  return null;`, files, store);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe('tag_unknown');
    expect(result.files.size).toBe(0);
  });

  it('refuses lines the model has not been shown', () => {
    const store = new SnapshotStore();
    const tag = store.record('src/queue.ts', QUEUE, { startLine: 1, endLine: 6 });
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 10:\n+  if (!job) return undefined;`,
      new Map([['src/queue.ts', QUEUE]]),
      store
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe('unseen');
  });

  it('joins adjacent windows, so an edit spanning two reads is not a guess', () => {
    const store = new SnapshotStore();
    store.record('src/queue.ts', QUEUE, { startLine: 1, endLine: 6 });
    const tag = store.record('src/queue.ts', QUEUE, { startLine: 7, endLine: 12 });
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 5.=9:\n+  return job.payload;`,
      new Map([['src/queue.ts', QUEUE]]),
      store
    );
    expect(result.ok).toBe(true);
  });

  it('refuses two operations that touch the same lines', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 3.=5:\n+  return null;\nPUT 4:\n+  return undefined;`,
      files,
      store
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe('overlap');
  });

  it('refuses a range past the end of the file it was read at', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(`[src/queue.ts#${tag}]\nPUT 40:\n+x`, files, store);
    expect(result.failures[0]?.kind).toBe('out_of_range');
  });

  it('refuses a paste with no cut to fill it', () => {
    const { store, tag, files } = seeded();
    const result = applyEdit(`[src/queue.ts#${tag}]\nPUT >2 @absent`, files, store);
    expect(result.failures[0]?.kind).toBe('missing_register');
  });

  it('names the row a malformed operation is on', () => {
    const parsed = parseEdit(`[src/queue.ts#3f9a]\nPUT 3 - 5\n+x`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.row).toBe(2);
  });
});

describe('a stale anchor', () => {
  const shifted = ['// added by somebody else', '// and another line', ...QUEUE.split('\n')].join(
    '\n'
  );

  it('is re-located by content when the target still exists exactly once', () => {
    const { store, tag } = seeded();
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 4:\n+  if (!job.ready) return undefined;`,
      new Map([['src/queue.ts', shifted]]),
      store
    );
    expect(result.ok).toBe(true);
    expect(result.recovered).toEqual(['src/queue.ts']);
    const after = (result.files.get('src/queue.ts') as string).split('\n');
    // Line 4 of the read is line 6 now; the two lines somebody else added are still there.
    expect(after[5]).toBe('  if (!job.ready) return undefined;');
    expect(after[0]).toBe('// added by somebody else');
  });

  it('fails closed, with the file as it reads now, when the target is gone', () => {
    const { store, tag } = seeded();
    const rewritten = QUEUE.replace('  if (!job.ready) return null;', '  if (job.ready) {');
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 4:\n+  if (!job.ready) return undefined;`,
      new Map([['src/queue.ts', rewritten]]),
      store
    );
    expect(result.ok).toBe(false);
    const failure = result.failures[0];
    expect(failure?.kind).toBe('tag_stale');
    expect(failure && 'context' in failure ? failure.context : '').toContain('if (job.ready) {');
    expect(result.files.size).toBe(0);
  });

  it('fails closed when the target now appears twice', () => {
    const { store, tag } = seeded();
    // The target line is duplicated, so relocating it is a coin flip. A coin flip that lands is
    // the failure this whole guard exists to prevent.
    const duplicated = QUEUE.replace(
      '  return job.payload;\n};\n\nexport const peek',
      '  return job.payload;\n  if (!job.ready) return null;\n};\n\nexport const peek'
    );
    const result = applyEdit(
      `[src/queue.ts#${tag}]\nPUT 4:\n+  if (!job.ready) return undefined;`,
      new Map([['src/queue.ts', duplicated]]),
      store
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe('tag_stale');
  });
});

describe('finding the block that opens at a line', () => {
  const lines = QUEUE.split('\n');

  it('runs a braced block to its closing brace', () => {
    expect(blockAt(lines, 0)).toEqual({ from: 0, to: 5 });
  });

  it('falls back to indentation where there are no brackets', () => {
    const python = ['def drain(queue):', '    job = queue.pop()', '    return job', '', 'x = 1'];
    expect(blockAt(python, 0)).toEqual({ from: 0, to: 2 });
  });

  it('claims only itself rather than the rest of the file when brackets never balance', () => {
    expect(blockAt(['function broken() {', '  return 1;'], 0)).toEqual({ from: 0, to: 0 });
  });

  it('is not fooled by a brace inside a string or a comment', () => {
    const tricky = ['const open = "{";', 'const next = 1;'];
    expect(blockAt(tricky, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('the model-facing spec', () => {
  it('documents every operation the parser accepts', () => {
    for (const op of ['PUT N:', 'PUT N.=M:', 'PUT N*:', 'PUT <N:', 'PUT >N:', 'CUT N.=M', 'REM'])
      expect(EDIT_FORMAT_SPEC).toContain(op);
  });
});
