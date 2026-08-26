/**
 * The two cards this pane grew, rendered.
 *
 * The whole pane fetches in an effect and so cannot be rendered without a browser; what is
 * asserted here is the part an owner reads — the ceiling the conversation in front of them is
 * under, and the day the money went on. Both were figures the server had already computed and
 * nothing drew.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DailySpend, SpendCard } from './UsagePane.js';
import { conversationMeter, spendDays } from './spend-pane.js';
import type { SpendSummary } from './types.js';

const spend: SpendSummary = {
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
  windows: [],
  byDay: [
    { key: '2026-07-30', costUsd: 0.9, calls: 8 },
    { key: '2026-07-31', costUsd: 12, calls: 210 }
  ],
  byModel: [],
  byTask: []
};

const card = (conversation: { spentUsd: number; maxSpendUsd: number | null }): string => {
  const meter = conversationMeter(spend, conversation)!;
  return renderToStaticMarkup(
    <SpendCard
      label={meter.label}
      spentUsd={meter.spentUsd}
      capUsd={meter.capUsd}
      pendingUsd={meter.pendingUsd}
      percent={meter.percent}
      state={meter.state}
      resetsAt={meter.resetsAt}
      capNote="No ceiling on this conversation"
    />
  );
};

describe('the ceiling the conversation in front of the owner is under', () => {
  it('names the conversation, its ceiling and how much of it is gone', () => {
    const markup = card({ spentUsd: 1.6, maxSpendUsd: 2 });
    expect(markup).toContain('This conversation');
    expect(markup).toContain('$1.60');
    expect(markup).toContain('80% of the $2.00 cap');
    /* The card is drawn in the state the money is in, or the colour says one thing while the
       figure beside it says another. */
    expect(markup).toContain('spend-card warning');
  });

  /* The answer that matters most is the one where nothing stops the run, so it is said rather
     than left as a card that does not appear. */
  it('says when there is no ceiling on this conversation at all', () => {
    const markup = card({ spentUsd: 0.4, maxSpendUsd: null });
    expect(markup).toContain('No ceiling on this conversation');
    expect(markup).not.toContain('No cap set for this window');
    /* A conversation is bounded by the conversation, so nothing here claims it resets. */
    expect(markup).not.toContain('resets');
  });

  it('never prints a percentage it does not have', () => {
    const markup = renderToStaticMarkup(
      <SpendCard
        label="This conversation"
        spentUsd={0.5}
        capUsd={0}
        pendingUsd={0}
        percent={null}
        state="exceeded"
        resetsAt={null}
      />
    );
    expect(markup).not.toContain('null%');
    expect(markup).toContain('0% of the $0.00 cap');
  });
});

describe('the day the money went on', () => {
  it('draws the days newest first, each keeping the key the server grouped it under', () => {
    const markup = renderToStaticMarkup(<DailySpend days={spendDays(spend)} />);
    expect(markup).toContain('title="2026-07-31"');
    expect(markup.indexOf('2026-07-31')).toBeLessThan(markup.indexOf('2026-07-30'));
    expect(markup).toContain('$12.00');
    expect(markup).toContain('210 calls');
    expect(markup).toContain('The most recent 2 days');
  });

  it('draws nothing rather than an empty card on a box that has spent nothing', () => {
    expect(renderToStaticMarkup(<DailySpend days={[]} />)).toBe('');
  });
});
