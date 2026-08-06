import { describe, expect, it } from 'vitest';
import { containsMath } from './markdown-math.js';

describe('maths detection', () => {
  it('recognises inline and display maths', () => {
    expect(containsMath('The identity $e^{i\\pi} + 1 = 0$ closes it.')).toBe(true);
    expect(containsMath('$$\n\\int_0^1 x^2 dx\n$$')).toBe(true);
    expect(containsMath('$x$')).toBe(true);
  });

  it('does not mistake money for maths', () => {
    // The whole point of the detector: a transcript that talks about cost must not drag in KaTeX.
    expect(containsMath('The run cost $5 and the next one cost $7.')).toBe(false);
    expect(containsMath('Prices range from $50-$70 per month.')).toBe(false);
    expect(containsMath('Spend today: $0.42')).toBe(false);
    expect(containsMath('It cost $12.')).toBe(false);
  });

  it('ignores text with no delimiter at all', () => {
    expect(containsMath('Nothing mathematical here.')).toBe(false);
    expect(containsMath('')).toBe(false);
  });
});
