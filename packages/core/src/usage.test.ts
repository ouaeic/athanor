import { describe, expect, it } from 'vitest';
import { reserveUsage, storageThreshold } from './usage.js';

describe('usage policy', () => {
  it('never crosses the explicit overage allowance', () => {
    expect(
      reserveUsage({
        availableIncluded: 1,
        availableOverage: 0,
        estimate: 2,
        hardMaximum: 3
      }).allowed
    ).toBe(false);
  });

  it('emits storage warning bands', () => {
    expect(storageThreshold(84, 100)).toBe(70);
    expect(storageThreshold(96, 100)).toBe(95);
    expect(storageThreshold(100, 100)).toBe(100);
  });
});
