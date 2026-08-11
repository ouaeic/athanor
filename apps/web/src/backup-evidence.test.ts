import { describe, expect, test } from 'vitest';
import { backupLine, type BackupStatus } from './backup-evidence.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

const status = (over: Partial<BackupStatus>): BackupStatus => ({
  at: daysAgo(1),
  outcome: 'ok',
  reason: '',
  copyAt: daysAgo(1),
  copyBytes: 2_100_000_000,
  ...over
});

describe('the backup line', () => {
  /* The row exists to answer "can I get my computer back", and the answer is a date and a size. */
  test('says when the last copy was taken and how big it is', () => {
    expect(backupLine(status({}), NOW)).toEqual({
      text: 'Last backup 1 day ago, 2.1 GB.',
      attention: false
    });
  });

  /* A backup that ran is a fact, and facts are as quiet as the rest of the furniture. */
  test('stays quiet while the copies keep coming', () => {
    expect(backupLine(status({ copyAt: daysAgo(2), at: daysAgo(2) }), NOW).attention).toBe(false);
  });

  /*
   * Three days, the same threshold `athanor doctor` uses. One missed night is the design working;
   * a month is the owner's move, and the two places must not disagree about which is which.
   */
  test('asks for attention once the newest copy is three days old', () => {
    expect(backupLine(status({ copyAt: daysAgo(3), at: daysAgo(3) }), NOW)).toEqual({
      text: 'Last backup 3 days ago, 2.1 GB.',
      attention: true
    });
  });

  /*
   * A long gap is reported as a span, not as a date. `timeAgo` switches to the date past a month,
   * which is right for a file and wrong here: the span is how much of the computer would be gone,
   * and a date leaves the owner doing the subtraction on the worst possible morning.
   */
  test('reports a long gap as how much would be lost', () => {
    expect(backupLine(status({ copyAt: daysAgo(34), at: daysAgo(34) }), NOW).text).toBe(
      'Last backup 1 month ago, 2.1 GB.'
    );
    expect(backupLine(status({ copyAt: daysAgo(400), at: daysAgo(400) }), NOW).text).toBe(
      'Last backup over a year ago, 2.1 GB.'
    );
  });

  /*
   * The first of the two silent paths. The run exits zero, the timer schedules tomorrow, and a box
   * that is busy every time the window comes round stands down every night while the screen went on
   * promising a daily copy.
   */
  test('names the run that stood down, and how far back the owner can still restore', () => {
    expect(
      backupLine(
        status({
          outcome: 'skipped',
          reason: 'a task was still running when the window came round',
          at: daysAgo(1),
          copyAt: daysAgo(9)
        }),
        NOW
      )
    ).toEqual({
      text: 'Last backup 9 days ago, 2.1 GB. The run 1 day ago stood down — a task was still running when the window came round',
      attention: true
    });
  });

  /*
   * The second. A failed run leaves nothing behind - a copy with no checksum manifest cannot
   * restore anything, so it is pruned as wreckage - and the box carries on serving perfectly.
   */
  test('names a failure even while a recent copy still stands', () => {
    expect(
      backupLine(
        status({
          outcome: 'failed',
          reason: 'not enough room for a backup: 900 MiB free, about 4200 MiB needed',
          at: daysAgo(1),
          copyAt: daysAgo(2)
        }),
        NOW
      )
    ).toEqual({
      text: 'Last backup 2 days ago, 2.1 GB. The run 1 day ago failed — not enough room for a backup: 900 MiB free, about 4200 MiB needed',
      attention: true
    });
  });

  /* Installed an hour ago. Plain, and specifically not a row that looks like it failed to load. */
  test('says so plainly when nothing has run yet', () => {
    expect(backupLine(null, NOW)).toEqual({
      text: 'No backup yet. The first one is taken in the next daily window.',
      attention: false
    });
  });

  /* The year-old box that has never once copied itself, which used to be indistinguishable from
     the hour-old one on this screen and in `athanor doctor` alike. */
  test('tells a box that has never backed up apart from one that has just been installed', () => {
    expect(
      backupLine(
        status({
          outcome: 'skipped',
          reason: 'a task was still running when the window came round',
          copyAt: null,
          copyBytes: null
        }),
        NOW
      )
    ).toEqual({
      text: 'No backup yet — a task was still running when the window came round',
      attention: true
    });
  });

  /* The host always writes a reason, down to a fallback sentence, so an empty one is a file
     somebody else wrote - and a sentence ending in a dash reads as a line that broke. */
  test('says the plain thing when the box gave no reason at all', () => {
    expect(
      backupLine(status({ outcome: 'failed', reason: '', copyAt: null, copyBytes: null }), NOW)
    ).toEqual({ text: 'No backup yet.', attention: true });
  });

  /* The archive stops the services, so nobody sees this from a browser - but the disk check that
     precedes it does not, and a run in progress is not a run that failed. */
  test('does not report a run in progress as a fault', () => {
    expect(backupLine(status({ outcome: 'running', copyAt: null, copyBytes: null }), NOW)).toEqual({
      text: 'The first backup is running now.',
      attention: false
    });
    expect(backupLine(status({ outcome: 'running' }), NOW).attention).toBe(false);
  });
});
