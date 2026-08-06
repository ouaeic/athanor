import { describe, expect, it } from 'vitest';
import { buildFileDiff, diffLines, diffStat, fileChangesFromTool } from './diff.js';

const render = (before: string, after: string) =>
  diffLines(before, after).lines.map(
    (line) => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`
  );

describe('diffLines', () => {
  it('marks only the changed line', () => {
    expect(render('a\nb\nc\n', 'a\nB\nc\n')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('treats a trailing newline as terminating the last line', () => {
    expect(render('a\n', 'a')).toEqual([' a']);
  });

  it('reports an insertion without rewriting the surrounding lines', () => {
    expect(render('a\nc\n', 'a\nb\nc\n')).toEqual([' a', '+b', ' c']);
  });

  it('reports a deletion', () => {
    expect(render('a\nb\nc\n', 'a\nc\n')).toEqual([' a', '-b', ' c']);
  });

  it('numbers both sides so the gutters line up', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nx\ny\nc\n').lines;
    expect(lines.map((line) => [line.kind, line.before, line.after])).toEqual([
      ['context', 1, 1],
      ['remove', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4]
    ]);
  });

  it('creating a file shows every line as added', () => {
    expect(render('', 'one\ntwo\n')).toEqual(['+one', '+two']);
  });

  it('falls back to a whole rewrite when alignment would be too expensive', () => {
    const before = Array.from({ length: 900 }, (_, index) => `before ${index}`).join('\n');
    const after = Array.from({ length: 900 }, (_, index) => `after ${index}`).join('\n');
    const result = diffLines(before, after);
    expect(result.coarse).toBe(true);
    expect(result.lines.filter((line) => line.kind === 'remove')).toHaveLength(900);
    expect(result.lines.filter((line) => line.kind === 'add')).toHaveLength(900);
  });
});

describe('buildFileDiff', () => {
  it('keeps three lines of context around a change and splits distant edits', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 5', 'LINE 5').replace('line 30', 'LINE 30');
    const diff = buildFileDiff('workspace/app.ts', before, after);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toEqual([
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'LINE 5',
      'line 6',
      'line 7',
      'line 8'
    ]);
    expect(diff.hunks[0]?.header).toBe('@@ -3,7 +3,7 @@');
  });

  it('marks a file that does not exist yet as created', () => {
    const diff = buildFileDiff('workspace/new.md', undefined, 'hello\n');
    expect(diff.created).toBe(true);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it('reports an edit that changes nothing rather than rendering an empty hunk', () => {
    const diff = buildFileDiff('workspace/a.txt', 'same\n', 'same\n');
    expect(diff.unchanged).toBe(true);
    expect(diff.hunks).toEqual([]);
    expect(diffStat(diff)).toBe('no change');
  });

  it('summarises counts for the collapsed header', () => {
    expect(diffStat(buildFileDiff('a', 'a\nb\n', 'a\nB\nC\n'))).toBe('+2 −1');
  });
});

describe('fileChangesFromTool', () => {
  it('reads both sides of every conflict-checked patch', () => {
    expect(
      fileChangesFromTool('file_patch', {
        patches: [
          { path: 'workspace/a.ts', oldText: 'const a = 1;', newText: 'const a = 2;' },
          { path: 'workspace/b.ts', oldText: 'x', newText: 'y' }
        ]
      })
    ).toEqual([
      { path: 'workspace/a.ts', before: 'const a = 1;', after: 'const a = 2;' },
      { path: 'workspace/b.ts', before: 'x', after: 'y' }
    ]);
  });

  it('leaves the current contents unknown for a whole-file write', () => {
    expect(fileChangesFromTool('file_write', { path: 'workspace/a.ts', content: 'hello' })).toEqual(
      [{ path: 'workspace/a.ts', after: 'hello' }]
    );
  });

  it('ignores tools and arguments that describe no file change', () => {
    expect(fileChangesFromTool('shell', { command: 'ls' })).toEqual([]);
    expect(fileChangesFromTool('file_write', { path: 'a' })).toEqual([]);
    expect(fileChangesFromTool('file_patch', { patches: [{ path: 'a' }] })).toEqual([]);
    expect(fileChangesFromTool(undefined, undefined)).toEqual([]);
  });
});
