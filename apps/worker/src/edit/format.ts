/**
 * The line-addressed edit format: how a file is shown, and how it is fingerprinted.
 *
 * athanor's shipped editor is `file_patch`: oldText/newText with an exactly-once guard. That guard
 * is what makes it safe and also what makes it expensive - to change one line inside a function
 * that says `return null;` eleven times, the model has to quote enough surrounding text to be
 * unique, and then quote all of it back with one word different. The cost of an edit is therefore
 * set by how repetitive the file is, not by how large the edit is.
 *
 * This module is the other half of an alternative that is being MEASURED, not shipped: address by
 * line number, and prove freshness with one whole-file tag instead of with quoted context. Nothing
 * here is on the tool catalogue and nothing here is resident in a prompt. See `evals/edit/` for
 * the comparison this exists to make possible, and `docs/design/exec3/L2.md` for the ruling.
 *
 * Two decisions are load-bearing and both are here:
 *
 * 1. Normalisation strips trailing spaces, tabs and carriage returns from every line before the
 *    tag is computed. A file read through a display that trims, or written on a machine that ends
 *    lines with CRLF, produces the same tag as the same file without those. Without this the tag
 *    is a line-ending detector, which is not what it is for.
 *
 * 2. The tag is four hex characters - sixteen bits. That is a LOOKUP KEY, never the verifier. The
 *    applier resolves the tag to a recorded snapshot and then compares the snapshot's text to the
 *    live text; a collision produces a mismatch, not a corrupt file. Anything that treats four hex
 *    characters as proof of identity is wrong once in every 65,536 stale edits, which on a machine
 *    that edits all day is a corrupted file per month.
 */

/** Four hex characters, the same width the format's line headers are laid out for. */
export const TAG_HEX_LENGTH = 4;

/**
 * Trailing space, tab and CR are dropped; nothing else is.
 *
 * Leading whitespace is indentation and is content. Inner whitespace is content. Only the tail is
 * invisible to a reader and therefore only the tail may vary without changing the tag.
 */
export const normaliseLine = (line: string): string => line.replace(/[ \t\r]+$/, '');

/** The text the tag is computed over: every line detrailed, newlines kept exactly. */
export const normalise = (text: string): string => text.split('\n').map(normaliseLine).join('\n');

/**
 * FNV-1a, 32 bits, folded to 16.
 *
 * A dependency-free non-cryptographic hash, chosen because the tag's job is to be a short cache
 * key a model can copy back without miscounting, and because adding a hashing dependency to the
 * worker to save four bytes of catalogue would be the wrong trade in both directions. Collision
 * safety comes from `snapshots.ts` verifying the resolved text, not from this.
 */
export const fileTag = (text: string): string => {
  const source = normalise(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    // Code points above U+00FF contribute their high byte too, so a file that differs only in a
    // non-Latin character does not tag identically.
    const high = source.charCodeAt(index) >>> 8;
    if (high) {
      hash ^= high;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return ((hash ^ (hash >>> 16)) & 0xffff).toString(16).padStart(TAG_HEX_LENGTH, '0');
};

/** The header a rendered file carries: the path the edit addresses, and the tag it was read at. */
export const sectionHeader = (path: string, tag: string): string => `[${path}#${tag}]`;

/**
 * A file as the model is shown it, so the numbers it edits by are numbers it has actually seen.
 *
 * `LINE:TEXT`, one-based, with the whole-file tag in the header even when the window is partial -
 * the tag says which version of the file these numbers belong to, and a window's own bytes cannot
 * say that. This is the integration cost of the format and it is real: athanor's runner answers
 * `file_read` by walking the file in a fixed buffer and STOPPING once the window is filled, and a
 * whole-file tag forces that walk to the end of the file. The walk stays O(1) in memory; it stops
 * being O(window) in time.
 */
export const renderNumbered = (
  path: string,
  text: string,
  window?: { startLine: number; endLine: number }
): string => {
  const lines = text.split('\n');
  const from = Math.max(1, window?.startLine ?? 1);
  const to = Math.min(lines.length, window?.endLine ?? lines.length);
  const rows: string[] = [sectionHeader(path, fileTag(text))];
  for (let line = from; line <= to; line += 1) rows.push(`${line}:${lines[line - 1] ?? ''}`);
  return rows.join('\n');
};
