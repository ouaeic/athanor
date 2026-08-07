import { describe, expect, it } from 'vitest';
import { storageThreshold } from './usage.js';

describe('usage policy', () => {
  it('emits storage warning bands', () => {
    expect(storageThreshold(84, 100)).toBe(70);
    expect(storageThreshold(96, 100)).toBe(95);
    expect(storageThreshold(100, 100)).toBe(100);
  });
});
