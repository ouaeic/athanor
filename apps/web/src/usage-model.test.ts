import { describe, expect, it } from 'vitest';
import type { SpendSummary } from './types.js';
import {
  bucketShare,
  formatUsd,
  hostStoragePercent,
  modelLabel,
  modelsBySpend,
  spendBreakdown,
  spendLimitsDraft,
  spendLimitsPatch,
  spendMeters,
  tasksBySpend,
  type UsageEntry,
  type UsageResponse
} from './usage-model.js';

const usage = (history: UsageEntry[] = []): UsageResponse => ({
  subscription: {
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    storageLimitBytes: 50_000_000_000
  },
  totals: { settled: 12, reserved: 0 },
  providerSpend: {
    windows: {
      daily: { used: 0.42, resetsAt: '2026-08-01T00:00:00.000Z' },
      weekly: { used: 2.75, resetsAt: '2026-08-03T00:00:00.000Z' },
      monthly: { used: 9.5, resetsAt: '2026-08-01T00:00:00.000Z' }
    }
  },
  storageBytes: 4_000_000_000,
  storageThreshold: 0,
  history
});

const entry = (partial: Partial<UsageEntry>): UsageEntry => ({
  id: 'u1',
  kind: 'model_inference',
  resourceClass: 'inference',
  quantity: 1,
  unit: 'call',
  credits: 1,
  costUsd: 0,
  state: 'settled',
  createdAt: '2026-07-31T09:00:00.000Z',
  ...partial
});

const summary = (overrides: Partial<SpendSummary> = {}): SpendSummary => ({
  limits: {
    dailyCapUsd: 5,
    monthlyCapUsd: 60,
    defaultTaskCapUsd: 2,
    warnAtPercent: 80,
    timeZone: 'Europe/London',
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
    },
    {
      name: 'monthly',
      spentUsd: 61,
      pendingUsd: 0,
      capUsd: 60,
      warnAtUsd: 48,
      projectedUsd: 61,
      state: 'exceeded',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-01T00:00:00.000Z'
    }
  ],
  byDay: [{ key: '2026-07-31', costUsd: 4.2, calls: 30 }],
  byModel: [{ key: 'openrouter/z-ai/glm-5.2', costUsd: 40, calls: 200 }],
  byTask: [{ key: 'task-a', costUsd: 25, calls: 90 }],
  ...overrides
});

describe('money formatting', () => {
  it('reports to the cent and never rounds a real charge to nothing', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(9.5)).toBe('$9.50');
    expect(formatUsd(1_234.56)).toBe('$1,235');
  });

  /* A single turn usually costs less than a cent. "<$0.01" beside every one of them says nothing,
     and the same conversation's total was printed to four places a pane away. */
  it('shows a sub-cent charge as a number rather than as a threshold', () => {
    expect(formatUsd(0.004)).toBe('$0.0040');
    expect(formatUsd(0.00012)).toBe('$0.0001');
    expect(formatUsd(-1)).toBe('$0.00');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });

  it('shows the part of a model id people recognise', () => {
    expect(modelLabel('openrouter/z-ai/glm-5.2')).toBe('glm-5.2');
    expect(modelLabel('local-model')).toBe('local-model');
  });
});

describe('spend windows', () => {
  it('measures today and this month against the owner caps when the server serves them', () => {
    const [today, week, month] = spendMeters(usage(), summary());
    expect(today).toMatchObject({ spentUsd: 4.2, capUsd: 5, percent: 84, state: 'warning' });
    expect(today?.pendingUsd).toBe(0.3);
    expect(month).toMatchObject({ spentUsd: 61, capUsd: 60, percent: 100, state: 'exceeded' });
    // Spend limits are deliberately daily and monthly only, so the week reports without a ceiling.
    expect(week).toMatchObject({ spentUsd: 2.75, capUsd: null, percent: null });
  });

  it('still reports real spend on a server with no spend route at all', () => {
    const meters = spendMeters(usage(), null);
    expect(meters.map((meter) => meter.spentUsd)).toEqual([0.42, 2.75, 9.5]);
    expect(meters.every((meter) => meter.capUsd === null && meter.percent === null)).toBe(true);
    expect(meters[0]?.resetsAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('spend breakdown', () => {
  it('prefers the server aggregate, which covers the whole capped month', () => {
    const breakdown = spendBreakdown(usage(), summary());
    expect(breakdown.complete).toBe(true);
    expect(breakdown.byModel[0]?.key).toBe('openrouter/z-ai/glm-5.2');
    expect(breakdown.byTask[0]?.key).toBe('task-a');
  });

  it('falls back to the usage history and says so', () => {
    const breakdown = spendBreakdown(
      usage([
        entry({ id: 'a', taskId: 't1', modelId: 'm/one', costUsd: 0.5 }),
        entry({ id: 'b', taskId: 't1', modelId: 'm/one', costUsd: 0.25 }),
        entry({ id: 'c', taskId: 't2', modelId: 'm/two', costUsd: 1.5 })
      ]),
      null
    );
    expect(breakdown.complete).toBe(false);
    expect(breakdown.byTask).toEqual([
      { key: 't2', costUsd: 1.5, calls: 1 },
      { key: 't1', costUsd: 0.75, calls: 2 }
    ]);
    expect(breakdown.byModel[0]).toEqual({ key: 'm/two', costUsd: 1.5, calls: 1 });
  });

  it('ignores reservations and zero-cost records, which are not charges', () => {
    const history = [
      entry({ id: 'a', taskId: 't1', costUsd: 3, state: 'reserved' }),
      entry({ id: 'b', taskId: 't1', costUsd: 0 }),
      entry({ id: 'c', taskId: 't2', costUsd: 0.2 })
    ];
    expect(tasksBySpend(history)).toEqual([{ key: 't2', costUsd: 0.2, calls: 1 }]);
    expect(modelsBySpend(history)).toEqual([{ key: 'model_inference', costUsd: 0.2, calls: 1 }]);
  });

  it('caps each list at five so the pane stays a summary', () => {
    const history = Array.from({ length: 9 }, (_, index) =>
      entry({ id: `u${index}`, taskId: `t${index}`, costUsd: index + 1 })
    );
    expect(tasksBySpend(history)).toHaveLength(5);
    expect(tasksBySpend(history)[0]?.key).toBe('t8');
  });
});

describe('spend limits form', () => {
  const draft = {
    dailyCapUsd: '5',
    monthlyCapUsd: '60',
    defaultTaskCapUsd: '2',
    warnAtPercent: '80',
    timeZone: 'Europe/London'
  };

  it('round-trips the stored limits into editable text', () => {
    expect(spendLimitsDraft(summary().limits)).toEqual(draft);
    expect(
      spendLimitsDraft({ ...summary().limits, dailyCapUsd: null, defaultTaskCapUsd: null })
    ).toMatchObject({ dailyCapUsd: '', defaultTaskCapUsd: '', monthlyCapUsd: '60' });
  });

  it('sends a blank field as an explicit null, so a cap can actually be removed', () => {
    const patch = spendLimitsPatch({ ...draft, dailyCapUsd: '  ' });
    expect(patch).toEqual({
      ok: true,
      body: {
        dailyCapUsd: null,
        monthlyCapUsd: 60,
        defaultTaskCapUsd: 2,
        warnAtPercent: 80,
        timeZone: 'Europe/London'
      }
    });
  });

  it('refuses what the server would reject, with the reason', () => {
    expect(spendLimitsPatch({ ...draft, dailyCapUsd: 'lots' })).toEqual({
      ok: false,
      message: 'The daily cap must be an amount in dollars, or blank for no cap.'
    });
    expect(spendLimitsPatch({ ...draft, monthlyCapUsd: '2000000' })).toMatchObject({ ok: false });
    expect(spendLimitsPatch({ ...draft, defaultTaskCapUsd: '0' })).toMatchObject({ ok: false });
    expect(spendLimitsPatch({ ...draft, warnAtPercent: '120' })).toMatchObject({ ok: false });
    expect(spendLimitsPatch({ ...draft, timeZone: '' })).toMatchObject({ ok: false });
  });

  it('catches a daily cap that can never bind because it exceeds the monthly one', () => {
    expect(spendLimitsPatch({ ...draft, dailyCapUsd: '90' })).toEqual({
      ok: false,
      message: 'The daily cap cannot be higher than the monthly cap.'
    });
  });
});

describe('bar widths', () => {
  it('scales against the largest bucket and keeps the smallest visible', () => {
    const buckets = [
      { key: 'a', costUsd: 10, calls: 1 },
      { key: 'b', costUsd: 5, calls: 1 },
      { key: 'c', costUsd: 0.01, calls: 1 }
    ];
    expect(bucketShare(buckets[0]!, buckets)).toBe(100);
    expect(bucketShare(buckets[1]!, buckets)).toBe(50);
    expect(bucketShare(buckets[2]!, buckets)).toBe(2);
    expect(bucketShare({ key: 'z', costUsd: 0, calls: 0 }, [])).toBe(0);
  });
});

describe('how full the disk is', () => {
  it('reports the share used, once the box has said what it has', () => {
    expect(hostStoragePercent({ hostStorageTotalBytes: 100, hostStorageAvailableBytes: 25 })).toBe(
      75
    );
    expect(hostStoragePercent({ hostStorageTotalBytes: 100, hostStorageAvailableBytes: 100 })).toBe(
      0
    );
  });

  /* The composer's warning strip and the usage pane each carried this arithmetic, which is how the
     strip and the meter come to disagree about the same disk. */
  it('says nothing rather than zero when the box has not reported a disk', () => {
    expect(hostStoragePercent({})).toBeUndefined();
    expect(hostStoragePercent({ hostStorageTotalBytes: 100 })).toBeUndefined();
    expect(hostStoragePercent({ hostStorageAvailableBytes: 25 })).toBeUndefined();
    expect(
      hostStoragePercent({ hostStorageTotalBytes: 0, hostStorageAvailableBytes: 0 })
    ).toBeUndefined();
  });

  it('stays inside the meter when the box reports more free than it has', () => {
    expect(hostStoragePercent({ hostStorageTotalBytes: 100, hostStorageAvailableBytes: 140 })).toBe(
      0
    );
  });
});
