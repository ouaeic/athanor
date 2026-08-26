import { describe, expect, it } from 'vitest';
import { clampNumber, finiteNumber } from './numbers.js';

/**
 * The `NaN` arm, tested once and properly.
 *
 * Twenty-six copies of one clamp is how three of them came to be missing this, so the value of
 * these cases is that they are the only ones: an arm that names its bounds here inherits every
 * assertion below, including the ones its author never thought about.
 */
describe('reading a number a model sent', () => {
  it.each([
    ['a word', 'abc'],
    ['a number with a word stuck to it', '4300ish'],
    ['a number with a space in it', '80 80'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a JSON null', null],
    ['an omitted argument', undefined],
    ['an object', { value: 4 }],
    // `Number([])` is 0 and `Number(true)` is 1: real, in-range numbers standing in for an
    // argument the model never gave, which is exactly the absence the fallback exists to answer.
    ['an empty array', []],
    ['a boolean', true],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a NaN of its own', Number.NaN]
  ])('reads %s as no number at all', (_name, value) => {
    expect(finiteNumber(value)).toBeNull();
  });

  it.each([
    ['an integer', 12, 12],
    ['a fraction', 0.5, 0.5],
    ['a negative', -3, -3],
    ['a zero', 0, 0],
    ['a numeric string', '4300', 4300],
    ['a numeric string with padding', ' 4300 ', 4300],
    ['a fractional string', '1.5', 1.5]
  ])('reads %s as the number it is', (_name, value, expected) => {
    expect(finiteNumber(value)).toBe(expected);
  });
});

describe('holding a tool argument inside its bounds', () => {
  const bounds = { min: 0.01, max: 100, fallback: 5 };

  it('answers an unreadable argument with the tool’s own default', () => {
    // Not the floor. An unreadable number is an absent number, and every one of these call sites
    // already carried the default the absent case was meant to get.
    expect(clampNumber('abc', bounds)).toBe(5);
    expect(clampNumber(undefined, bounds)).toBe(5);
    expect(clampNumber(null, bounds)).toBe(5);
  });

  it('never answers with a value that is not a number', () => {
    // The property the whole file is for, stated as a property: `Math.max(0.01, NaN)` is `NaN` and
    // `NaN >= anything` is false, so a ceiling that is `NaN` is not a high ceiling, it is no
    // ceiling. Nothing that leaves here can be compared against and lose.
    for (const value of ['abc', '', null, undefined, {}, [], true, Number.NaN, Infinity])
      expect(Number.isFinite(clampNumber(value, bounds))).toBe(true);
  });

  it('clamps a readable argument to the floor and the cap', () => {
    expect(clampNumber(0, bounds)).toBe(0.01);
    expect(clampNumber(1_000, bounds)).toBe(100);
    expect(clampNumber(3, bounds)).toBe(3);
  });

  it('clamps a fallback that sits outside the bounds it was given', () => {
    // A defensive property rather than a live case: the bounds are the last word, so a call site
    // whose default drifts outside its own clamp still cannot produce an out-of-range value.
    expect(clampNumber('abc', { min: 1, max: 10, fallback: 40 })).toBe(10);
  });

  it('cuts to a whole number before clamping, when the argument is declared as one', () => {
    // Before, not after: `4300.5` has to become the reserved port `4300` and be refused, rather
    // than staying `4300.5` and being minted into the capability scope `preview:4300.5`.
    expect(clampNumber(4300.5, { min: 1024, max: 65_535, fallback: 1024, integer: true })).toBe(
      4300
    );
    expect(clampNumber('10.9', { min: 1, max: 10, fallback: 10, integer: true })).toBe(10);
    expect(clampNumber(-4.5, { min: 0, max: 60, fallback: 0, integer: true })).toBe(0);
  });

  it('leaves a fraction alone when the argument is not declared as an integer', () => {
    expect(clampNumber(2.5, bounds)).toBe(2.5);
  });
});
