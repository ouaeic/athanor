/**
 * The line-addressed edit format: how a file is shown, and how two versions of a line are compared.
 *
 * athanor's editor used to be oldText/newText with an exactly-once guard. That guard is what made
 * it safe and also what made it expensive: to change one line inside a function that says
 * `return null;` eleven times, the model had to quote enough surrounding text to be unique and then
 * quote all of it back with one word different. The cost of an edit was set by how repetitive the
 * file is, not by how large the edit is. Measured over fifteen tasks on this repository's own
 * corpus, addressing by line number instead cost 61% fewer characters of tool arguments, winning
 * fourteen of the fourteen rows where both formats did what the task asked.
 *
 * Two decisions in this file are load-bearing.
 *
 * 1. NORMALISATION strips trailing spaces, tabs and carriage returns before any two lines are
 *    compared. A file written on a machine that ends lines with CRLF, or a line the model copied
 *    back through a display that trims, must not be a different line. Leading whitespace is
 *    indentation and is content; inner whitespace is content. Only the tail is invisible to a
 *    reader, and therefore only the tail may vary. Every comparison in `apply.ts` goes through
 *    `sameLine`, so this is not advice - there is no other way to compare lines here.
 *
 * 2. THERE IS NO TAG. The reference dialect this was measured against heads every read and every
 *    patch with a short whole-file hash, and its own harness carries a hand-maintained list of
 *    models that "drop the tag header" often enough to be routed to a lenient parser. A header the
 *    model can drop is a header the harness can do without: the path arrives in a JSON field the
 *    schema guarantees, and freshness is proved by comparing the harness's own record of what it
 *    displayed against the file as it reads now - which is strictly better evidence than sixteen
 *    bits of hash, because it can also say WHERE the lines went. The named failure mode is designed
 *    out rather than tolerated, which is the whole thesis of this lane.
 *
 *    Dropping it is also a read-side saving: a header line on every read is bytes on every read,
 *    and forcing a whole-file digest would make a windowed read of a two-gigabyte log walk to the
 *    end of the file. `services/workspace-runner/src/files.ts` reads a window in a fixed buffer and
 *    stops as soon as it has one, deliberately, after a database dump buffered a gigabyte and the
 *    OOM killer took the runner down with every other tool on it. Nothing here reopens that.
 */

/**
 * Trailing space, tab and CR are dropped; nothing else is.
 *
 * `\r` is stripped along with the spaces rather than separately because a CRLF file whose lines
 * also have trailing spaces ends them `" \r"`, and a rule that only knew about `\r` would leave
 * the space behind and call the line different.
 */
export const normaliseLine = (line: string): string => line.replace(/[ \t\r]+$/, '');

/** Whether two lines are the same line, once the invisible tail is discounted. */
export const sameLine = (left: string, right: string): boolean =>
  normaliseLine(left) === normaliseLine(right);

/** Whether two runs of lines are the same run. */
export const sameLines = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((line, index) => sameLine(line, right[index] ?? ''));

/**
 * Splitting text into lines, once, in the one way the whole vertical agrees on.
 *
 * Lines are separated by newlines, not terminated by them, so a file ending in a newline has a
 * final empty line and a two-line file that ends in one reads as three. That is what
 * `String.split('\n')` does, what the runner's ranged reader does (it says so), and therefore what
 * the numbers in a read mean. Anything that trimmed it here would number the file differently from
 * the way the runner numbers it, and every edit near the end of a file would be off by one.
 */
export const toLines = (text: string): string[] => text.split('\n');

/**
 * A file as the model is shown it: `LINE:TEXT`, one-based, no header.
 *
 * This is the whole read-side cost of the format and it is not hidden anywhere - it is the decimal
 * line number and one colon per line, and `docs/design/edit/BUILD.md` measures it on this
 * repository rather than asserting it.
 */
export const renderNumbered = (lines: readonly string[], startLine = 1): string =>
  lines.map((line, index) => `${startLine + index}:${line}`).join('\n');

/**
 * A numbered window of a file, clamped, for handing evidence back inside a refusal.
 *
 * Every refusal in `apply.ts` carries one of these. A refusal that costs a round trip is barely
 * better than the wrong edit it prevented: the model re-reads, re-derives the same patch, and the
 * owner pays for two turns to get one edit.
 */
export const numberedWindow = (
  lines: readonly string[],
  around: { from: number; to: number },
  radius: number
): string => {
  const from = Math.max(1, around.from - radius);
  const to = Math.min(lines.length, around.to + radius);
  if (to < from) return '';
  return renderNumbered(lines.slice(from - 1, to), from);
};

/** `41` for a single line, `41-48` for a run - the spelling every message in this module uses. */
export const sayRange = (from: number, to: number): string =>
  from === to ? `${from}` : `${from}-${to}`;
