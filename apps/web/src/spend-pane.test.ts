/**
 * The two figures the usage pane grew: the ceiling the open conversation is under, and the day the
 * money went on. Both were already computed by the server on every request and drawn by nothing.
 */
import { describe, expect, it } from 'vitest';
import { conversationMeter, dayLabel, spendDays } from './spend-pane.js';
import type { SpendSummary } from './types.js';

const summary = (overrides: Partial<SpendSummary> = {}): SpendSummary => ({
  limits: {
    dailyCapUsd: 5,
    monthlyCapUsd: 60,
    defaultTaskCapUsd: 2,
    warnAtPercent: 80,
    timeZone: 'Europe/London',
    maxInputUsdPerMillionTokens: 3,
    maxOutputUsdPerMillionTokens: 15,
    updatedAt: '2026-07-20T00:00:00.000Z'
  },
  windows: [
    {
      name: 'daily',
      spentUsd: 4.2,
      pendingUsd: 0.3,
      capUsd: 5,
      warnAtUsd: 4,
      projectedUsd: 4.5,
      state: 'warning',
      startsAt: '2026-07-31T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z'
    }
  ],
  byDay: [{ key: '2026-07-31', costUsd: 4.2, calls: 30 }],
  byModel: [],
  byTask: [],
  ...overrides
});

describe('the ceiling the conversation being looked at is under', () => {
  it('prefers the summary’s own task window, which is the only one that counts what is in flight', () => {
    const withTask = summary({
      windows: [
        {
          name: 'task',
          spentUsd: 1.5,
          pendingUsd: 0.25,
          capUsd: 2,
          warnAtUsd: 1.6,
          projectedUsd: 1.75,
          state: 'warning',
          // Bounded by the conversation rather than by the clock, so the server sends no dates.
          startsAt: null,
          endsAt: null
        },
        ...summary().windows
      ]
    });
    expect(conversationMeter(withTask, null)).toEqual({
      id: 'task',
      label: 'This conversation',
      spentUsd: 1.5,
      capUsd: 2,
      pendingUsd: 0.25,
      percent: 75,
      state: 'warning',
      resetsAt: null
    });
  });

  /* `/v1/spend` asks the guard without a conversation, so no summary carries a `task` window
     today. The task row holds the same two figures and is what actually answers. */
  it('reads the ceiling off the task row when the summary carries no task window', () => {
    expect(conversationMeter(summary(), { spentUsd: 1.6, maxSpendUsd: 2 })).toMatchObject({
      id: 'task',
      spentUsd: 1.6,
      capUsd: 2,
      percent: 80,
      state: 'warning',
      resetsAt: null
    });
  });

  it('says a conversation under no ceiling has none, instead of leaving the card out', () => {
    expect(conversationMeter(summary(), { spentUsd: 0.4, maxSpendUsd: null })).toMatchObject({
      capUsd: null,
      percent: null,
      state: 'ok'
    });
  });

  it('marks a conversation past its own ceiling as exceeded', () => {
    expect(conversationMeter(summary(), { spentUsd: 2.5, maxSpendUsd: 2 })?.state).toBe('exceeded');
  });

  /* Without the owner's own warn percentage there is no soft line to draw, and inventing one here
     would be a further copy of a threshold that already lives in the contract and the store. */
  it('draws no warning band on a box that served no limits at all', () => {
    expect(conversationMeter(null, { spentUsd: 1.9, maxSpendUsd: 2 })).toMatchObject({
      state: 'ok',
      percent: 95
    });
  });

  it('draws nothing when this pane cannot see the conversation', () => {
    expect(conversationMeter(summary(), null)).toBe(null);
  });
});

describe('the day the money went on', () => {
  const series = [
    { key: '2026-07-29', costUsd: 0.4, calls: 3 },
    { key: '2026-07-30', costUsd: 0.9, calls: 8 },
    { key: '2026-07-31', costUsd: 12, calls: 210 }
  ];

  it('reads newest first, which is where a night that ran away shows up', () => {
    const days = spendDays(summary({ byDay: series }));
    expect(days.map((day) => day.key)).toEqual(['2026-07-31', '2026-07-30', '2026-07-29']);
    expect(days[0]).toMatchObject({ costUsd: 12, calls: 210 });
  });

  it('keeps the pane a summary and leaves the answer it was handed alone', () => {
    const long = Array.from({ length: 31 }, (_, index) => ({
      key: `2026-07-${String(index + 1).padStart(2, '0')}`,
      costUsd: index,
      calls: 1
    }));
    const spend = summary({ byDay: long });
    expect(spendDays(spend)).toHaveLength(14);
    expect(spendDays(spend, 3).map((day) => day.key)).toEqual([
      '2026-07-31',
      '2026-07-30',
      '2026-07-29'
    ]);
    // Reversing the response itself would hand the next reader the series upside down.
    expect(spend.byDay[0]?.key).toBe('2026-07-01');
  });

  it('has nothing to draw on a server with no spend route', () => {
    expect(spendDays(null)).toEqual([]);
  });

  /* The bug this is here to stop: `new Date('2026-08-01')` is UTC midnight by specification, so
     every owner west of Greenwich would read the first of the month as the thirty-first of the one
     before - on the surface whose whole job is to say which day the money went on. */
  it('names the day the server grouped, not the one UTC midnight lands on locally', () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const label = dayLabel('2026-08-01');
      expect(label).toMatch(/\b1\b/);
      expect(label).not.toMatch(/31|jul/i);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it('hands back a key it cannot read rather than a date it made up', () => {
    expect(dayLabel('not-a-day')).toBe('not-a-day');
    expect(dayLabel('')).toBe('');
  });
});
