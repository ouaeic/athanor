/**
 * What the card offers to raise a ceiling to.
 *
 * The figure has to clear the work already committed, or the owner presses "raise and carry on" and
 * the run stops again on the same window a step later - which is the exact behaviour the card was
 * built to end. It also has to look like a decision rather than an arithmetic result, because it is
 * one: this is the number the owner is agreeing to.
 */
import { describe, expect, it } from 'vitest';
import type { SpendWindow } from '@athanor/contracts';
import { suggestedCeiling } from './SpendBlock';

const window = (over: Partial<SpendWindow>): SpendWindow =>
  ({
    name: 'monthly',
    spentUsd: 0,
    pendingUsd: 0,
    capUsd: null,
    state: 'exceeded',
    ...over
  }) as SpendWindow;

describe('the ceiling a spend card offers', () => {
  it('doubles a ceiling that has been reached', () => {
    expect(suggestedCeiling(window({ spentUsd: 100, capUsd: 100 }))).toBe(200);
  });

  it('always clears what is already committed, held money included', () => {
    // Doubling a ceiling that sits just under a large spend would land below it and stop again.
    const next = suggestedCeiling(window({ spentUsd: 98, pendingUsd: 40, capUsd: 100 }));
    expect(next).toBeGreaterThan(98 + 40);
  });

  it('moves somewhere useful from a ceiling of nothing', () => {
    expect(suggestedCeiling(window({ spentUsd: 0, capUsd: 0 }))).toBeGreaterThanOrEqual(1);
  });

  it('offers a round figure rather than a fraction of a cent', () => {
    const next = suggestedCeiling(window({ spentUsd: 3.37, capUsd: 3.5 }));
    expect(Number.isInteger(next)).toBe(true);
  });
});
