import { describe, expect, it } from 'vitest';
import { catalogueFrozenLine, refreshFailureReason, refreshLogLine } from './refresh-log.js';

describe('refreshFailureReason', () => {
  it('reads the message off an Error and keeps it to one line', () => {
    expect(refreshFailureReason(new Error('OpenRouter models\n  returned 401'))).toBe(
      'OpenRouter models returned 401'
    );
  });

  it('bounds a message that a provider made arbitrarily long', () => {
    const reason = refreshFailureReason(new Error('x'.repeat(500)));
    expect(reason).toHaveLength(200);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('says something rather than nothing for a thrown value with no message', () => {
    expect(refreshFailureReason(new Error(''))).toBe('no reason given');
  });
});

describe('refreshLogLine', () => {
  it('reports the first failure with what happens next', () => {
    const line = refreshLogLine({
      previousFailures: 0,
      reason: 'OpenRouter models returned 503',
      intervalSeconds: 3600
    });
    expect(line).toContain('OpenRouter models returned 503');
    expect(line).toContain('stays in use');
    expect(line).toContain('3600 seconds');
  });

  it('stays quiet while a failure continues, so an outage cannot bury the log', () => {
    expect(
      refreshLogLine({ previousFailures: 1, reason: 'fetch failed', intervalSeconds: 3600 })
    ).toBeNull();
    expect(
      refreshLogLine({ previousFailures: 48, reason: 'fetch failed', intervalSeconds: 3600 })
    ).toBeNull();
  });

  it('says nothing at all while refreshes are succeeding', () => {
    expect(refreshLogLine({ previousFailures: 0, reason: null, intervalSeconds: 3600 })).toBeNull();
  });

  it('closes the loop when the catalogue recovers', () => {
    expect(refreshLogLine({ previousFailures: 1, reason: null, intervalSeconds: 3600 })).toContain(
      'after 1 failed attempt.'
    );
    expect(refreshLogLine({ previousFailures: 7, reason: null, intervalSeconds: 3600 })).toContain(
      'after 7 failed attempts.'
    );
  });
});

describe('catalogueFrozenLine', () => {
  const frozen = {
    alreadySaid: false,
    state: 'frozen' as const,
    models: 312,
    lastRefreshAt: new Date('2026-02-14T04:00:00.000Z')
  };

  it('says once that there is nothing to refresh from, which was the one silence indistinguishable from health', () => {
    const line = catalogueFrozenLine(frozen);
    expect(line).toContain('no provider key');
    expect(line).toContain('312 models');
    expect(line).toContain('2026-02-14T04:00:00.000Z');
  });

  it('names the box rather than a date when a provider has never answered here at all', () => {
    expect(catalogueFrozenLine({ ...frozen, lastRefreshAt: null })).toContain('never refreshed');
  });

  it('stays quiet while it goes on being true, so months of it cannot bury the log', () => {
    expect(catalogueFrozenLine({ ...frozen, alreadySaid: true })).toBeNull();
  });

  it('leaves a failure to the line that already reports one, and a new box to its seed', () => {
    expect(catalogueFrozenLine({ ...frozen, state: 'failed' })).toBeNull();
    expect(catalogueFrozenLine({ ...frozen, state: 'seeded', models: 0 })).toBeNull();
  });

  it('closes the loop when a key appears, and says nothing when one was there all along', () => {
    expect(catalogueFrozenLine({ ...frozen, state: 'refreshed', alreadySaid: true })).toContain(
      'provider key again'
    );
    expect(catalogueFrozenLine({ ...frozen, state: 'refreshed' })).toBeNull();
  });
});
