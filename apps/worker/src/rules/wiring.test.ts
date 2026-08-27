/**
 * Where the dormant rules are read, and why the position is the assertion.
 *
 * The rules themselves are pure and tested as such next door. What cannot be tested that way is the
 * only thing about them that can break a turn: *when* the loop asks. Two positions are wrong and
 * one is right, and the difference is invisible in the rule.
 *
 * Too early - at the point the assistant message is pushed - and a correction lands between an
 * assistant's tool calls and their results, which is a malformed request every provider refuses.
 * `applyDormantRules` refuses that shape itself, so the damage would be silent rather than fatal:
 * the rules would simply stop firing on every step that called a tool, which is nearly every step.
 * Too late - after `refreshRuntimeContext` - and the block that carries the clock stops being last
 * in the window, which is the one thing that keeps it free: it was moved to the tail precisely
 * because a message that changes every turn rewrites the bytes of everything behind it, and a
 * measured cache rate of 84% is what that cost the last time.
 *
 * Read from the source rather than from a driven turn, for the reason `preamble-ownership.test.ts`
 * gives about ordering: the failure is which statement comes before which, and a turn-level probe
 * observes it only by arranging a step boundary at exactly the right instant, which measures the
 * arrangement at least as much as the program.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../agent.ts', import.meta.url)), 'utf8').split(
  '\n'
);

/** One-based, so a failure reads against the file without arithmetic. */
const lineOf = (needle: string): number => {
  const index = source.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`anchor not found in agent.ts: ${needle}`);
  return index + 1;
};

describe('the dormant rules are read at the step boundary', () => {
  it('asks exactly once, in the step loop', () => {
    const calls = source.filter((line) => line.includes('applyDormantRules(')).length;
    expect(calls).toBe(1);
  });

  it('asks after the step budget notice and before the runtime block', () => {
    const budget = lineOf(
      'await this.#noteStepBudget(task, key, state, this.#stepCeiling(state));'
    );
    const rules = lineOf('applyDormantRules(state.messages');
    const runtime = lineOf('      refreshRuntimeContext();');
    expect(rules).toBeGreaterThan(budget);
    expect(rules).toBeLessThan(runtime);
  });

  it('is handed what the turn ran rather than what it asked for', () => {
    expect(source[lineOf('applyDormantRules(state.messages') - 1]).toContain(
      'toolsRunThisTurn(state.turnToolResults)'
    );
  });
});
