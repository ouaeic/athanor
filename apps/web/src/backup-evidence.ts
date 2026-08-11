/**
 * What the box's last backup actually did, said in one line.
 *
 * This replaces a sentence that asserted "a backup is taken daily, at a randomised hour, when
 * nothing is running". It was true of the timer and of nothing else. A run that stands down
 * because the worker is still busy exits cleanly and says so only to the journal, and a run that
 * fails leaves no directory behind at all, because a copy with no checksum manifest cannot restore
 * anything and gets pruned. Both of those left the sentence standing. An owner who reads
 * "yesterday, 2.1 GB" knows something about their computer; an owner who reads a promise knows
 * nothing, and finds out which of the two it was on the day they need to restore.
 *
 * Kept out of the component because the wording and the thresholds are the parts worth pinning.
 */
import { timeAgo } from './file-rows.js';
import { formatBytes } from './timeline-state.js';

export interface BackupStatus {
  /** When the last run happened. */
  at: string;
  outcome: 'ok' | 'skipped' | 'failed' | 'running';
  /** Why it stood down or failed, in the host script's own words. Empty when it succeeded. */
  reason: string;
  /** When the newest copy that actually exists was taken, which is the question underneath. */
  copyAt: string | null;
  copyBytes: number | null;
}

/**
 * Three days, matching `athanor doctor` exactly.
 *
 * The window is daily, so one missed night is the design working - the copy is skipped over
 * somebody's running task and taken tomorrow. Three is where "it was busy last night" stops being
 * the explanation, and it must be the same number in both places: an owner who reads a quiet line
 * here and a warning at the shell has been told two different things about one machine.
 */
const STALE_DAYS = 3;
const DAY = 86_400_000;
const MONTH = 30 * DAY;

/**
 * How long ago the copy was taken.
 *
 * `timeAgo` gives a plain date past a month, which is the right call for a file: "412 days ago" is
 * a number rather than a fact about a document. For a backup it is exactly the fact — the span is
 * how much of this computer would be gone — and a date leaves the owner doing the subtraction on
 * the worst possible morning.
 */
const copyAge = (iso: string, nowMs: number): string => {
  const elapsed = Math.max(0, nowMs - Date.parse(iso));
  if (elapsed < MONTH) return timeAgo(iso, nowMs);
  const months = Math.floor(elapsed / MONTH);
  return months < 12 ? `${months} month${months === 1 ? '' : 's'} ago` : 'over a year ago';
};

export interface BackupLine {
  text: string;
  /**
   * Whether this is the owner's move.
   *
   * Caution rather than ember, and the distinction is the house rule rather than a preference:
   * ember is small, bright and moving, and it means something is happening this second. A backup
   * that has not run for a month is not alive - it is a static condition that needs attention,
   * which is what the large, dim, still caution colour is for.
   */
  attention: boolean;
}

/**
 * @param status what the box last wrote down, or null on a box that has not reached a window yet
 * @param nowMs the clock, passed in so the same second can be asserted against
 *
 * Null and not undefined, deliberately: "the box says it has nothing" and "the box has not told us
 * yet" are different facts and only the first of them has a sentence. A caller holding a request
 * that has not come back - or one that failed, which looks the same from here - has to decide that
 * for itself rather than have this answer as though a server with a year of copies had none.
 */
export const backupLine = (status: BackupStatus | null, nowMs: number): BackupLine => {
  // A box installed an hour ago has written nothing, and that is the ordinary state rather than a
  // fault. Saying so plainly beats an empty row, which reads as something that failed to load.
  if (!status) {
    return {
      text: 'No backup yet. The first one is taken in the next daily window.',
      attention: false
    };
  }
  const copyAt = status.copyAt;
  const copiedAt = copyAt ? Date.parse(copyAt) : Number.NaN;

  // Nothing has ever been copied, and the last run explains why. This is the case the old sentence
  // hid completely: a busy box can stand down every night for a year and look exactly like a box
  // that was installed this morning.
  if (!copyAt || Number.isNaN(copiedAt)) {
    if (status.outcome === 'running')
      return { text: 'The first backup is running now.', attention: false };
    if (status.outcome === 'ok')
      return { text: 'A backup was taken, but this server cannot find the copy.', attention: true };
    // The host always writes a reason, down to a fallback sentence when it has nothing better, so
    // an empty one means the file was written by something else - and a dangling dash reads as a
    // line that broke rather than as a machine with nothing to add.
    return {
      text: status.reason ? `No backup yet — ${status.reason}` : 'No backup yet.',
      attention: true
    };
  }

  const stale = nowMs - copiedAt >= STALE_DAYS * DAY;
  const size = status.copyBytes ? formatBytes(status.copyBytes) : '';
  const copy = [`Last backup ${copyAge(copyAt, nowMs)}`, size].filter(Boolean).join(', ');
  if (status.outcome === 'ok' || status.outcome === 'running')
    return { text: `${copy}.`, attention: stale };
  // A copy exists and the run after it did not add one. Both facts, in that order: how far back the
  // owner can restore to comes first, and why it has not moved since comes second.
  const verb = status.outcome === 'failed' ? 'failed' : 'stood down';
  return {
    text: `${copy}. The run ${timeAgo(status.at, nowMs)} ${verb} — ${status.reason}`,
    attention: stale || status.outcome === 'failed'
  };
};
