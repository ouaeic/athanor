import { describe, expect, it } from 'vitest';
import {
  scheduleDescription,
  scheduleSpecFromForm,
  scheduleStanding,
  type ScheduleForm
} from './schedule-rows.js';

const form = (overrides: Partial<ScheduleForm> = {}): ScheduleForm => ({
  kind: 'daily',
  runAt: '2026-09-01T09:00',
  localTime: '09:00',
  everyMinutes: 60,
  weekdays: [1],
  timeZone: 'Europe/London',
  ...overrides
});

describe('what a schedule says it does', () => {
  it('reads back every shape the form can make', () => {
    expect(
      scheduleDescription({ kind: 'daily', timeZone: 'Europe/London', localTime: '09:00' })
    ).toBe('Daily · 09:00 · Europe/London');
    expect(
      scheduleDescription({
        kind: 'weekly',
        timeZone: 'Europe/London',
        localTime: '18:30',
        weekdays: [5, 1]
      })
    ).toBe('Mon, Fri · 18:30 · Europe/London');
  });

  /* Cron is never offered by the form, but the agent can create one and it has to read back. */
  it('reads back a schedule the agent made that the form cannot', () => {
    expect(scheduleDescription({ kind: 'cron', timeZone: 'UTC', expression: '0 6 * * 1-5' })).toBe(
      'Advanced · 0 6 * * 1-5 · UTC'
    );
  });

  it('says an interval the way a person would say it', () => {
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 90 })).toBe('Every 90 minutes');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 360 })).toBe('Every 6 hours');
    expect(scheduleDescription({ kind: 'interval', everyMinutes: 1_440 })).toBe('Every day');
  });

  it('does not print seconds nobody plans around', () => {
    expect(scheduleDescription({ kind: 'once', runAt: '2026-09-01T09:00:00.000Z' })).not.toMatch(
      /:\d\d:\d\d/
    );
  });
});

describe('where a schedule stands', () => {
  const schedule = { enabled: true, nextRunAt: '2026-09-01T09:00:00.000Z', lastErrorCode: null };

  it('separates paused from finished, which are not the same thing', () => {
    expect(scheduleStanding({ ...schedule, enabled: false })).toBe('Paused');
    expect(scheduleStanding({ ...schedule, nextRunAt: null })).toBe(
      'Finished — nothing left to run'
    );
    expect(scheduleStanding(schedule)).toContain('Next');
  });

  it('says the last run failed and that the schedule is still standing', () => {
    expect(scheduleStanding({ ...schedule, lastErrorCode: 'spend_cap_reached' })).toContain(
      'last run failed'
    );
    // The stored code belongs in the log, not on a row the owner reads.
    expect(scheduleStanding({ ...schedule, lastErrorCode: 'spend_cap_reached' })).not.toContain(
      'spend_cap'
    );
  });
});

describe('turning the form into a schedule the box will accept', () => {
  it('builds each of the four shapes the form offers', () => {
    expect(scheduleSpecFromForm(form())).toEqual({
      ok: true,
      spec: { kind: 'daily', timeZone: 'Europe/London', localTime: '09:00' }
    });
    expect(scheduleSpecFromForm(form({ kind: 'interval', everyMinutes: 120 }))).toEqual({
      ok: true,
      spec: { kind: 'interval', everyMinutes: 120 }
    });
  });

  it('orders the weekdays, so the row does not read back in click order', () => {
    const built = scheduleSpecFromForm(form({ kind: 'weekly', weekdays: [5, 0, 3] }));
    expect(built.ok && built.spec.kind === 'weekly' && built.spec.weekdays).toEqual([0, 3, 5]);
  });

  /*
   * The box refuses these, and a refusal that arrives as a 400 from a schema the owner cannot see
   * teaches nothing about which field to change.
   */
  it('refuses what the box would refuse, in words about the field', () => {
    const refusal = (overrides: Partial<ScheduleForm>): string => {
      const built = scheduleSpecFromForm(form(overrides));
      return built.ok ? '' : built.message;
    };
    expect(refusal({ kind: 'interval', everyMinutes: 5 })).toContain('15 minutes');
    expect(refusal({ kind: 'interval', everyMinutes: 20_000 })).toContain('week');
    expect(refusal({ localTime: '9am' })).toContain('hours and minutes');
    expect(refusal({ kind: 'weekly', weekdays: [] })).toContain('at least one day');
    expect(refusal({ kind: 'once', runAt: 'not a date' })).toContain('when this should run');
  });

  it('will not schedule something for a time that has already gone', () => {
    const built = scheduleSpecFromForm(form({ kind: 'once', runAt: '2020-01-01T09:00' }));
    expect(built.ok ? '' : built.message).toContain('already passed');
  });
});
