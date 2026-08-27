/**
 * What the model was shown, kept so a stale edit can be told apart from an invented one.
 *
 * A line-addressed edit is only meaningful against a particular version of a file, and the model
 * carries that version as four hex characters. Three things can arrive:
 *
 *   - a tag that resolves to a snapshot whose text is what is on disk now: the numbers are live;
 *   - a tag that resolves to a snapshot whose text has since changed: STALE, and recoverable,
 *     because the snapshot says exactly what the model was looking at;
 *   - a tag that resolves to nothing at all: FABRICATED, or carried over from a session whose
 *     snapshots are gone. Not recoverable, and a different sentence has to be said about it.
 *
 * The third case is why this store exists rather than a bare hash comparison. "Tag mismatch,
 * re-read the file" is the same message for a file somebody else edited and for a tag the model
 * made up, and those need opposite responses: the first is re-ground and retry, the second is stop
 * inventing anchors. `resolve` reports which one happened.
 *
 * Seen ranges are recorded beside the text for the same reason. A model that edits line 400 of a
 * file it read lines 1-120 of is guessing, and a guess that happens to parse is the failure mode
 * that costs the most - it lands, silently, on the wrong lines.
 */
import { fileTag } from './format.js';

export interface Snapshot {
  readonly path: string;
  readonly tag: string;
  /** The exact text the tag was computed from - the verifier, where the tag is only the key. */
  readonly text: string;
  /** One-based inclusive line windows this snapshot was actually shown through. */
  readonly seen: ReadonlyArray<{ from: number; to: number }>;
}

/**
 * How many versions of one file are remembered.
 *
 * A turn that reads, edits, reads and edits again generates a snapshot per read, and only the ones
 * a still-in-flight edit could name matter. Four is two round trips of headroom; beyond that the
 * anchor is old enough that failing closed is the right answer anyway.
 */
export const SNAPSHOTS_PER_PATH = 4;

export type Resolution =
  | { readonly kind: 'live'; readonly snapshot: Snapshot }
  | { readonly kind: 'stale'; readonly snapshot: Snapshot }
  | { readonly kind: 'unknown' };

const merged = (
  ranges: ReadonlyArray<{ from: number; to: number }>
): Array<{ from: number; to: number }> => {
  const sorted = [...ranges].sort((left, right) => left.from - right.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    // Adjacent windows join: reading 1-40 and then 41-80 means the model has seen 1-80, and an
    // edit spanning the join is not a guess.
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else out.push({ ...range });
  }
  return out;
};

export class SnapshotStore {
  private readonly byPath = new Map<string, Snapshot[]>();

  /** Records a version of a file and returns the tag the model will quote back. */
  record(path: string, text: string, window?: { startLine: number; endLine: number }): string {
    const tag = fileTag(text);
    const lineCount = text.split('\n').length;
    const seen = window
      ? [{ from: Math.max(1, window.startLine), to: Math.min(lineCount, window.endLine) }]
      : [{ from: 1, to: lineCount }];
    const existing = this.byPath.get(path) ?? [];
    const already = existing.find((snapshot) => snapshot.tag === tag && snapshot.text === text);
    if (already) {
      const grown: Snapshot = { ...already, seen: merged([...already.seen, ...seen]) };
      this.byPath.set(
        path,
        existing.map((snapshot) => (snapshot === already ? grown : snapshot))
      );
      return tag;
    }
    const next = [...existing, { path, tag, text, seen: merged(seen) }];
    this.byPath.set(path, next.slice(-SNAPSHOTS_PER_PATH));
    return tag;
  }

  /**
   * What this tag means against the file as it is now.
   *
   * A tag can key more than one snapshot - sixteen bits over an editing session will collide
   * eventually - so every candidate is checked against the live text and the one that matches
   * wins. That is the whole collision defence, and it is why the store keeps text rather than
   * hashes.
   */
  resolve(path: string, tag: string, live: string): Resolution {
    const candidates = (this.byPath.get(path) ?? []).filter((snapshot) => snapshot.tag === tag);
    if (!candidates.length) return { kind: 'unknown' };
    const exact = candidates.find((snapshot) => snapshot.text === live);
    if (exact) return { kind: 'live', snapshot: exact };
    return { kind: 'stale', snapshot: candidates[candidates.length - 1] as Snapshot };
  }

  /** Whether every line in this one-based inclusive range was actually shown to the model. */
  wasSeen(snapshot: Snapshot, from: number, to: number): boolean {
    return snapshot.seen.some((range) => range.from <= from && range.to >= to);
  }

  /** Test and diagnostic access; the applier never needs it. */
  versions(path: string): readonly Snapshot[] {
    return this.byPath.get(path) ?? [];
  }
}
