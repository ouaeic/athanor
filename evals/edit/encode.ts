/**
 * The two pieces of the quoted editor's encoding that outlived it.
 *
 * This file used to hold both dialects and derive each one from a declared change, so that the
 * comparison it fed could not be won by whoever wrote the encodings. That comparison answered its
 * question - `docs/design/edit/BUILD.md` carries the ruling - and the line-addressed format is now
 * what `file_patch` IS, so there is no second dialect left to encode. What remains is the arithmetic
 * of the quote:
 *
 *   `region`        - a whole-line block, newline-terminated, which is how a model quotes lines;
 *   `minimalUnique` - the SMALLEST such block containing the target that occurs exactly once.
 *
 * `minimalUnique` is kept because it is the only honest way to price the quoted editor's recovery.
 * When a quote is ambiguous the arm's answer is "extend oldText with enough surrounding lines to
 * make it unique", and the size of that extension is what the recovery costs. Searched over every
 * split of the context between the two sides, so a target that is unique with one line above and
 * none below is never charged for one below as well: the retired format is priced at its best, not
 * at a plausible one.
 */
import { countOccurrences } from '../../apps/worker/src/values.js';

/** A whole-line region, newline-terminated, which is how a model quotes lines out of a file. */
export const region = (lines: readonly string[], from: number, to: number): string =>
  lines
    .slice(from - 1, to)
    .map((line) => `${line}\n`)
    .join('');

/**
 * The smallest whole-line block containing `from..to` that occurs exactly once in `text`.
 *
 * Grown by total context first and then over every split of that context between the two sides.
 * Undefined when no amount of context makes it unique, which is a file the quoted editor could not
 * edit at that place at all.
 */
export const minimalUnique = (
  lines: readonly string[],
  text: string,
  from: number,
  to: number
): { readonly from: number; readonly to: number } | undefined => {
  const last = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  for (let total = 0; total <= last; total += 1) {
    for (let up = 0; up <= total; up += 1) {
      const down = total - up;
      const start = from - up;
      const end = to + down;
      if (start < 1 || end > last) continue;
      if (countOccurrences(text, region(lines, start, end)) === 1) return { from: start, to: end };
    }
  }
  return undefined;
};

/** One hunk in the shape the quoted editor took. */
export interface ReplacePatch {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}
