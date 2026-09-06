import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettings } from './Providers';
import type * as Management from '../management.js';

vi.mock('../management.js', async (importOriginal) => {
  const original = await importOriginal<typeof Management>();
  return {
    ...original,
    useResource: (path: string) => ({
      value:
        path === '/v1/media/models'
          ? {
              approvalThresholdUsd: 1,
              modalities: [
                {
                  modality: 'video',
                  available: true,
                  choice: { automatic: false, modelId: 'openai/sora-2', preference: 'balanced' },
                  effective: null,
                  options: [
                    {
                      id: 'openai/sora-2',
                      displayName: 'Sora 2',
                      retirementAt: '2026-09-24T00:00:00.000Z',
                      usdPerImage: null,
                      usdPerSecond: 0.1,
                      usdPerMinute: null,
                      usdPerMillionCharacters: null
                    }
                  ]
                }
              ]
            }
          : null,
      error: null,
      loading: false,
      refresh: () => undefined
    }),
    useAction: () => ({ busy: false, error: null, message: '', run: vi.fn() })
  };
});
afterEach(() => vi.useRealTimers());
describe('retired generation selection', () => {
  it('shows the retirement date ahead of time and disables the same route after retirement while retaining the owner selection', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
    const upcoming = renderToStaticMarkup(<ProviderSettings onChange={() => undefined} />);
    expect(upcoming).toContain('Scheduled to retire');
    expect(upcoming).toContain('September 24, 2026');
    expect(upcoming).not.toMatch(/<option[^>]*value="openai\/sora-2"[^>]*disabled/);
    vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
    const retired = renderToStaticMarkup(<ProviderSettings onChange={() => undefined} />);
    expect(retired).toMatch(/<option[^>]*value="openai\/sora-2"[^>]*disabled=""[^>]*selected=""/);
    expect(retired).toContain('Retired');
    expect(retired).toContain('No replacement is selected automatically');
  });
});
