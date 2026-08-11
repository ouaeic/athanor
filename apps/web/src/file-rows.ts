/**
 * A row in the file browser, said the way the owner of the computer would say it.
 *
 * The runner has always sent `modifiedAt` on every entry (services/workspace-runner/src/files.ts)
 * and the pane printed a name, a size and nothing else, alphabetically, with no way to reorder it.
 * So three ordinary questions had no answer on this screen: what the agent just made, what is
 * taking up the disk the storage banner is complaining about, and where that CSV went. All three
 * are one sort and one extra clause per line.
 *
 * Kept out of the component because the ordering and the wording are the parts worth pinning.
 */
import { formatBytes } from './timeline-state.js';
import type { FileEntry } from './types.js';

export type FileOrder = 'name' | 'size' | 'recent';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * How long ago, in the words a person uses for it.
 *
 * The clock is passed in rather than read, so the same second can be asserted against. Past a
 * month the span stops being the useful fact and the date is, and a clock skewed a few seconds
 * ahead of the box must not produce "in 4 minutes" on a file that has just been written.
 */
export const timeAgo = (iso: string, nowMs: number): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const elapsed = Math.max(0, nowMs - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), 'minute')} ago`;
  if (elapsed < DAY) return `${plural(Math.floor(elapsed / HOUR), 'hour')} ago`;
  if (elapsed < 30 * DAY) return `${plural(Math.floor(elapsed / DAY), 'day')} ago`;
  return new Date(at).toLocaleDateString();
};

/**
 * The small line under a name.
 *
 * A folder has no size here, and inventing one would be worse than the "Folder" this replaces: the
 * runner reports `sizeBytes` from `lstat`, which for a directory is the size of the directory
 * record itself - 64 or 96 bytes on APFS, 4096 on ext4 - and has nothing to do with what is inside
 * it. What a folder can honestly say is how many things are in it, which the runner now counts, and
 * when it last changed.
 */
export const fileLine = (entry: FileEntry, nowMs: number): string => {
  const when = timeAgo(entry.modifiedAt, nowMs);
  const what =
    entry.type === 'directory'
      ? entry.itemCount === undefined
        ? ''
        : plural(entry.itemCount, 'item')
      : formatBytes(entry.sizeBytes);
  return [what, when].filter(Boolean).join(' · ');
};

/**
 * The order the owner asked for, without mutating the array the pane is holding.
 *
 * Name keeps the folders-first grouping the pane has always had, because that is what a directory
 * listing is. Recent deliberately drops it: "what did the agent just make" is not a question about
 * folders and files separately. Size cannot rank a folder at all - see `fileLine` - so folders fall
 * to the end in name order rather than being ranked by a number that means nothing.
 */
export const sortEntries = (entries: FileEntry[], order: FileOrder): FileEntry[] => {
  const byName = (left: FileEntry, right: FileEntry): number => left.name.localeCompare(right.name);
  const folder = (entry: FileEntry): boolean => entry.type === 'directory';
  const copy = [...entries];
  if (order === 'recent')
    return copy.sort(
      (left, right) =>
        (Date.parse(right.modifiedAt) || 0) - (Date.parse(left.modifiedAt) || 0) ||
        byName(left, right)
    );
  if (order === 'size')
    return copy.sort((left, right) =>
      folder(left) !== folder(right)
        ? folder(left)
          ? 1
          : -1
        : folder(left)
          ? byName(left, right)
          : right.sizeBytes - left.sizeBytes || byName(left, right)
    );
  return copy.sort((left, right) =>
    folder(left) === folder(right) ? byName(left, right) : folder(left) ? -1 : 1
  );
};
