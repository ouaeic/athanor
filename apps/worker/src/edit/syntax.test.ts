/**
 * The fast syntax gate: the first fault, with its line, for the two languages it can read, and
 * silence for everything else.
 */
import { describe, expect, it } from 'vitest';
import { checkSyntax } from './syntax.js';

describe('the syntax gate', () => {
  it('names the line of a JSON fault, and says nothing about valid JSON', async () => {
    const fault = await checkSyntax('config/settings.json', '{\n  "a": 1,\n  "b": 2,\n}');
    expect(fault).toBeDefined();
    expect(fault?.line).toBe(4);
    expect(fault?.message.length).toBeLessThanOrEqual(200);
    expect(await checkSyntax('config/settings.json', '{\n  "a": 1\n}')).toBeUndefined();
  });

  it('names the line of a TypeScript fault, through the compiler on this box', async () => {
    const fault = await checkSyntax(
      'src/queue.ts',
      'export const drain = (queue: Job[]) => {\n  const job = queue.shift(;\n  return job;\n};'
    );
    expect(fault).toBeDefined();
    expect(fault?.line).toBe(2);
    expect(fault?.message).toMatch(/expected/i);
    expect(
      await checkSyntax('src/queue.ts', 'export const drain = (queue: Job[]) => queue.shift();')
    ).toBeUndefined();
  });

  it('reads JavaScript and JSX too, and says nothing about a type error', async () => {
    expect(await checkSyntax('src/app.jsx', 'export const App = () => <div>;')).toBeDefined();
    expect(await checkSyntax('src/app.mjs', 'export const a = (;')).toBeDefined();
    // Syntactic only: a wrong type is the deferred checker's question, not this one.
    expect(await checkSyntax('src/typed.ts', 'const n: number = "text";')).toBeUndefined();
  });

  it('has no opinion about a language it cannot parse', async () => {
    expect(await checkSyntax('report.py', 'def f(:\n  pass')).toBeUndefined();
    expect(await checkSyntax('Makefile', 'all:\n\techo')).toBeUndefined();
  });
});
