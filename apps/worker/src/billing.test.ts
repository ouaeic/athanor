import { describe, expect, it } from 'vitest';
import { delegateBudget } from './billing.js';

describe('delegate budget', () => {
  it('gives a delegated mission a share of the parent budget', () => {
    expect(delegateBudget(20)).toBeCloseTo(5);
  });

  it('divides that share between the missions actually in flight', () => {
    // The share is of the whole task. The parameter existed and the call site never passed it, so
    // three specialists each checked the full quarter independently and could jointly spend three
    // quarters of the task's compute before the lead had done anything with their reports.
    expect(delegateBudget(20, 3)).toBeCloseTo(20 * 0.25 * (1 / 3));
    expect(delegateBudget(20, 3)).toBeLessThan(delegateBudget(20, 1));
  });

  it('never returns a zero or negative budget', () => {
    expect(delegateBudget(0)).toBeGreaterThan(0);
    expect(delegateBudget(-5)).toBeGreaterThan(0);
  });
});
