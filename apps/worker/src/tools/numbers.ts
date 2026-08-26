/**
 * Reading a number the model sent, and holding it inside the bounds the tool advertises.
 *
 * This file exists because of what became visible when the dispatch switch was cut into nine
 * domain modules and the arms ended up next to each other for the first time. There were
 * twenty-six clamps of the shape `Math.min(cap, Math.max(floor, Number(call.arguments.x ?? d)))`
 * across those nine files, and exactly three of them defended against the one input that walks
 * through both bounds untouched. `Number('abc')` is `NaN`; `Math.max(0.01, NaN)` is `NaN`;
 * `Math.min(100, NaN)` is `NaN` again. A clamp that reads as a floor and a cap is transparent to
 * the only value that has neither, and what came out the far end was worse than a wrong number in
 * three separate places:
 *
 *   - `scheduling.ts` wrote it as the compute ceiling of an unattended schedule. The dispatcher
 *     copies that onto every task the schedule creates and the loop's ceiling is
 *     `state.credits >= task.maxComputeCredits`, which is false for every value of credits when
 *     the right-hand side is `NaN`. The ceiling never fired at all.
 *   - `repository.ts` put it in a request body, where `JSON.stringify` writes `NaN` as `null` -
 *     so the coding agent's timeout reached the runner as an absent field rather than as the
 *     ten-second floor it had just been clamped by.
 *   - `publishing.ts` built a capability scope out of it, minting `preview:NaN`, and its
 *     `port === 4300` refusal of the port the workspace runtime keeps for itself is false against
 *     `NaN` like every other comparison.
 *
 * So the parse lives in one place and the arms name their bounds. The point is not that the
 * arithmetic here is cleverer than the arithmetic it replaced - it is that there is one of it, and
 * the arm that gets added next year gets the `NaN` arm whether or not its author had ever heard of
 * this.
 */

/**
 * The number the model actually sent, or `null` when it did not send one.
 *
 * Stricter than `Number()` on purpose, in both directions. `Number(null)` is `0`, `Number('')` is
 * `0`, `Number([])` is `0` and `Number(true)` is `1`: four spellings of "the model said nothing
 * useful here" that arrive as real, in-range numbers and sail past every `?? default` written
 * beside them - the same absence-becomes-zero shape that put a confident `$0` on the spend ledger
 * one package over. A tool argument is either a number or a string holding one; everything else is
 * absence, and absence is what the caller's fallback is for.
 */
export const finiteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

export interface NumberBounds {
  /** The floor. Applied last, so it holds against anything the fallback or the cap produced. */
  readonly min: number;
  readonly max: number;
  /** What an unreadable or absent argument becomes, before the bounds are applied to it. */
  readonly fallback: number;
  /**
   * Cut to a whole number before clamping, for the arguments the catalogue declares as integers
   * and something downstream reads as one - a port that becomes a capability scope, a result count
   * the runner slices with. Truncation happens before the bounds so that the bounds are the last
   * word, which is the order the two arms that already did this used.
   */
  readonly integer?: boolean;
}

/**
 * One tool argument, read as a number and held inside the tool's own bounds.
 *
 * The fallback is a value rather than an option because there is no such thing here as "no
 * opinion": every one of these call sites already had a default written into a `??` beside it, and
 * the whole failure this replaces was a default that a mistyped argument could slip past. An arm
 * with no sensible default - `publish_preview`'s port, which is required and has nowhere to fall
 * back to - reaches for `finiteNumber` and refuses, rather than publishing something the owner did
 * not ask about.
 */
export const clampNumber = (value: unknown, bounds: NumberBounds): number => {
  const parsed = finiteNumber(value);
  const named = parsed === null ? bounds.fallback : bounds.integer ? Math.trunc(parsed) : parsed;
  return Math.max(bounds.min, Math.min(bounds.max, named));
};
