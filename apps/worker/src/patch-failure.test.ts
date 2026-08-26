import { describe, expect, it } from 'vitest';
import { patchFailure } from './patch-failure.js';

describe('explaining a patch that did not apply', () => {
  const file = ['const a = 1;', '', 'export const run = () => {', '  return a + 1;', '};', ''].join(
    '\n'
  );

  it('names the whitespace difference and shows the region as it is now', () => {
    // "expected oldText exactly once, found 0" distinguishes a trailing space from a moved block.
    const failure = patchFailure('src/run.ts', file, 'export const run = ()  => {');
    expect(failure.occurrences).toBe(0);
    expect(failure.difference).toBe('inner whitespace');
    expect(failure.reason).toContain('line 3');
    expect(failure.nearestMatch?.text).toContain('3| export const run = () => {');
  });

  it('names an indentation difference for what it is', () => {
    const failure = patchFailure('src/run.ts', file, '      return a + 1;');
    expect(failure.difference).toBe('leading whitespace');
  });

  it('points at the nearest region when the file has genuinely moved on', () => {
    const failure = patchFailure(
      'src/run.ts',
      file,
      'export const run = async () => {\n  await go();\n};'
    );
    expect(failure.difference).toBeUndefined();
    expect(failure.reason).toMatch(/closest region is line \d+/);
    expect(failure.nearestMatch).toBeDefined();
  });

  it('says the text is ambiguous rather than reporting a bare count', () => {
    const repeated = 'value = 1;\nvalue = 1;\n';
    const failure = patchFailure('src/run.ts', repeated, 'value = 1;');
    expect(failure.occurrences).toBe(2);
    expect(failure.reason).toContain('appears 2 times');
    expect(failure.reason).toContain('unique');
  });

  it('says so plainly when nothing in the file resembles the patch', () => {
    const failure = patchFailure('src/run.ts', file, 'completely unrelated content here');
    expect(failure.nearestMatch).toBeUndefined();
    expect(failure.reason).toContain('Check the path');
  });
});
