/**
 * The schedule row, rendered.
 *
 * `schedule-rows.ts` is held to the sentences; this holds the row to actually printing them. Four
 * fields the box has always served were rendered by nothing — the standing instruction, when it
 * last ran, the conversation that run became, and what one run may spend — and a watcher that fires
 * unattended is the one thing whose row is the only chance anyone has to notice what it says.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleRow } from './ScheduleModal.js';
import { scheduleRunHref } from './schedule-rows.js';
import type { TaskSchedule } from './types.js';

const schedule = (patch: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  title: 'Morning report',
  prompt: 'Read the overnight logs and write up anything that went wrong.',
  modelId: 'openrouter/openai/gpt-oss-120b',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 5,
  maxSpendUsd: 2,
  spec: { kind: 'daily', timeZone: 'Asia/Tokyo', localTime: '07:00' },
  enabled: true,
  nextRunAt: '2026-09-01T07:00:00.000Z',
  lastRunAt: '2026-08-20T07:00:00.000Z',
  lastTaskId: '00000000-0000-4000-8000-0000000000aa',
  lastErrorCode: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-20T07:00:00.000Z',
  ...patch
});

const render = (patch: Partial<TaskSchedule> = {}): string => {
  const row = schedule(patch);
  return renderToStaticMarkup(
    <ScheduleRow
      schedule={row}
      modelName="GPT-OSS 120B"
      runHref={
        row.lastTaskId
          ? scheduleRunHref('https://box.example/?task=other', row.workspaceId, row.lastTaskId)
          : null
      }
      editing={false}
      busy={false}
      onOpenRun={() => undefined}
      onEdit={() => undefined}
      onRun={() => undefined}
      onPauseOrResume={() => undefined}
      onDelete={() => undefined}
    />
  );
};

describe('a schedule as the owner reads it', () => {
  /*
   * The instruction was sealed at creation and answered with to the model and to nobody else, so
   * the one thing most worth reading about a three-in-the-morning watcher was the one thing no
   * screen could show. The title is a nine-word slug of it, which is a label and not the
   * instruction.
   */
  it('shows the standing instruction the box will act on, folded', () => {
    const markup = render();
    expect(markup).toContain('Read the overnight logs and write up anything that went wrong.');
    expect(markup).toContain('<details');
    // Folded: five schedules with their instructions unfolded is a wall where a list should be.
    expect(markup).not.toContain('<details open');
  });

  /* A schedule whose instruction this server cannot decrypt still runs. Say so, rather than blank. */
  it('says an unreadable instruction is unreadable rather than showing nothing', () => {
    const markup = render({ prompt: '' });
    expect(markup).toContain('cannot read the instruction');
    expect(markup).toContain('It will still run');
  });

  it('shows when it last ran, and the timing it keeps in its own zone', () => {
    expect(render()).toContain('Last run');
    expect(render()).toContain('Asia/Tokyo');
  });

  /*
   * The row could say "last run failed" and offer no way to find out why: `lastTaskId` was served
   * beside it and read by nothing, so the only route left was scrolling the sidebar for a
   * conversation the owner did not start.
   */
  it('carries a link to the failed run in its href, named as the run that failed', () => {
    const markup = render({ lastErrorCode: 'spend_cap_reached' });
    expect(markup).toContain('task=00000000-0000-4000-8000-0000000000aa');
    // The workspace goes with it, because a reload reads that too.
    expect(markup).toContain('workspace=00000000-0000-4000-8000-000000000002');
    expect(markup).toContain('Open the run that failed');
  });

  it('offers nothing to open when the schedule has never run', () => {
    const markup = render({ lastRunAt: null, lastTaskId: null });
    expect(markup).toContain('Has not run yet');
    expect(markup).not.toContain('<a');
  });

  /* Which model spends the money every night, and how much of it one run may spend. */
  it('names the model and the ceiling one run of it may spend', () => {
    expect(render()).toContain('GPT-OSS 120B');
    expect(render()).toContain('$2.00 a run');
    expect(render({ maxSpendUsd: null })).toContain('5 credits a run');
  });

  /* The affordance itself: the README has promised schedule editing since before the route existed. */
  it('offers an edit control naming the schedule it edits', () => {
    expect(render()).toContain('aria-label="Edit Morning report"');
  });
});
