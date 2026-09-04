/**
 * The kind map on its own: one event in, the line a reader sees out, or nothing.
 *
 * `routes/shares.test.ts` drives the same function through a real server and a real conversation;
 * this file pins the two decisions that are easiest to get wrong one event at a time, with the
 * exact sentences and payload shapes the worker writes.
 */
import { describe, expect, it } from 'vitest';
import { snapshotLine } from './share-snapshot.js';

const off = { includeReasoning: false, includeToolResults: false };

describe('the line a viewer reads for one event', () => {
  /**
   * `recordToolFailure` writes `<tool> failed` with the error's message beside it. The summary is
   * the per-step activity line every link carries; the message can quote the path or the page
   * that failed, and stays behind the way a tool result does.
   */
  it('carries a failed tool step as its one-line summary and leaves the error detail behind', () => {
    const line = snapshotLine(
      'error',
      'read_file failed',
      { toolCallId: 'call-1', message: 'ENOENT: /home/owner/private/ledger.csv DETAIL-MARKER' },
      off
    );
    expect(line).toEqual({ kind: 'error', text: 'read_file failed' });
  });

  it('carries a notice and a warning the same way, with what was attached left behind', () => {
    expect(
      snapshotLine('notice', 'Build finished', { headline: 'Build finished', detail: 'D' }, off)
    ).toEqual({ kind: 'notice', text: 'Build finished' });
    expect(snapshotLine('warning', 'Stopped a repeating answer', { repeated: 3 }, off)).toEqual({
      kind: 'warning',
      text: 'Stopped a repeating answer'
    });
  });

  /**
   * The spend ceiling narrates itself through a `status` line that quotes the owner's spend and
   * cap, and a `warning` line before it that does the same. Cost is on the list of what a link
   * never carries, so the fact of the halt is shown and the figures are not.
   */
  it('names a spend halt and a spend warning without the figures', () => {
    const windows = [{ name: 'daily', spentUsd: 0.98, capUsd: 1, pendingUsd: 0 }];
    expect(
      snapshotLine(
        'status',
        'Paused at $0.98 of the $1.00 limit for today. Raise the limit to carry on, or leave it here.',
        { blockedBy: 'daily', windows, estimateUsd: 0.05 },
        off
      )
    ).toEqual({ kind: 'status', text: 'Paused at a spending limit.' });
    expect(
      snapshotLine(
        'warning',
        '$0.80 of the $1.00 limit for today has been spent.',
        { windows, estimateUsd: 0.05 },
        off
      )
    ).toEqual({ kind: 'warning', text: 'Approaching a spending limit.' });
    // A halt with no cap on the blocking window has no figures to quote, and reads the same.
    expect(
      snapshotLine(
        'status',
        'Paused: this task would go over its spending limit.',
        { blockedBy: 'task', windows: [{ name: 'task', spentUsd: 0.1, pendingUsd: 0 }] },
        off
      )
    ).toEqual({ kind: 'status', text: 'Paused at a spending limit.' });
  });

  /** The net under the shape check: any worker line that quotes an amount is not shown at all. */
  it('drops any other worker line that carries a money figure', () => {
    expect(snapshotLine('status', 'Spent $3.10 so far', undefined, off)).toBeUndefined();
    expect(snapshotLine('notice', 'This run cost $ 4', { headline: 'x' }, off)).toBeUndefined();
    expect(snapshotLine('error', 'Refused a $12 purchase', undefined, off)).toBeUndefined();
    // And a plain status line, with no figure in it, is carried as it is.
    expect(snapshotLine('status', 'Waiting for approval', undefined, off)).toEqual({
      kind: 'status',
      text: 'Waiting for approval'
    });
  });
});
