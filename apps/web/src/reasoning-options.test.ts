import { describe, expect, it } from 'vitest';
import { effortChoices } from './reasoning-options';

describe('provider reasoning controls', () => {
  it('does not imply adjustable effort when the provider does not advertise it', () => {
    expect(effortChoices()).toEqual(['auto']);
    expect(effortChoices({ mandatory: true })).toEqual(['auto']);
  });
  it('only exposes advertised levels and preserves their order', () => {
    expect(effortChoices({ mandatory: false, supportedEfforts: ['high', 'low', 'none'] })).toEqual([
      'auto',
      'none',
      'low',
      'high'
    ]);
  });
  it('never offers disabling mandatory reasoning even for unrestricted effort', () => {
    const choices = effortChoices({ mandatory: true, supportedEfforts: null });
    expect(choices.length).toBeGreaterThan(1);
    expect(choices).not.toContain('none');
    expect(choices).toContain('xhigh');
    expect(choices).toContain('max');
  });
});
