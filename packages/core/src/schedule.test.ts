import { describe, expect, it } from 'vitest';
import { assertCronExpression, assertTimeZone, nextScheduleRun } from './schedule.js';

describe('task schedules', () => {
  it('calculates interval and one-time occurrences without catch-up ambiguity', () => {
    const after = new Date('2026-07-21T10:00:00.000Z');
    expect(nextScheduleRun({ kind: 'interval', everyMinutes: 30 }, after)?.toISOString()).toBe(
      '2026-07-21T10:30:00.000Z'
    );
    expect(
      nextScheduleRun({ kind: 'once', runAt: '2026-07-21T10:05:00.000Z' }, after)?.toISOString()
    ).toBe('2026-07-21T10:05:00.000Z');
    expect(nextScheduleRun({ kind: 'once', runAt: '2026-07-21T09:00:00.000Z' }, after)).toBeNull();
  });

  it('uses IANA wall-clock time and skips nonexistent DST minutes safely', () => {
    expect(
      nextScheduleRun(
        { kind: 'daily', timeZone: 'Africa/Johannesburg', localTime: '09:15' },
        new Date('2026-07-21T06:00:00.000Z')
      )?.toISOString()
    ).toBe('2026-07-21T07:15:00.000Z');
    expect(
      nextScheduleRun(
        {
          kind: 'weekly',
          timeZone: 'America/New_York',
          localTime: '02:30',
          weekdays: [0]
        },
        new Date('2026-03-08T06:55:00.000Z')
      )?.toISOString()
    ).toBe('2026-03-15T06:30:00.000Z');
    expect(() => assertTimeZone('Not/A_Zone')).toThrow('Unknown IANA time zone');
  });

  it('supports standard five-field cron syntax without losing time-zone or DST semantics', () => {
    expect(
      nextScheduleRun(
        {
          kind: 'cron',
          timeZone: 'Africa/Johannesburg',
          expression: '30 8 * * MON-FRI'
        },
        new Date('2026-07-26T12:00:00.000Z')
      )?.toISOString()
    ).toBe('2026-07-27T06:30:00.000Z');
    expect(
      nextScheduleRun(
        {
          kind: 'cron',
          timeZone: 'America/New_York',
          expression: '30 2 * * SUN'
        },
        new Date('2026-03-08T06:55:00.000Z')
      )?.toISOString()
    ).toBe('2026-03-15T06:30:00.000Z');
    expect(
      nextScheduleRun(
        {
          kind: 'cron',
          timeZone: 'UTC',
          expression: '0 0 29 FEB *'
        },
        new Date('2026-03-01T00:00:00.000Z')
      )?.toISOString()
    ).toBe('2028-02-29T00:00:00.000Z');
    expect(() => assertCronExpression('*/0 * * * *')).toThrow('step');
    expect(() => assertCronExpression('* * *')).toThrow('minute');
  });
});
