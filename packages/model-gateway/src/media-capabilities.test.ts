import { describe, expect, it } from 'vitest';
import { quoteMediaPrice, readMediaCapabilities, readMediaPricing } from './media-capabilities.js';

describe('media capability and pricing contracts', () => {
  it('reads typed capabilities without widening malformed or empty choices', () => {
    expect(
      readMediaCapabilities(
        {
          aspect_ratio: { type: 'enum', values: ['1:1', null, '16:9'] },
          n: { type: 'range', min: 1, max: 4 },
          seed: { type: 'boolean' },
          broken: { type: 'range', min: 5, max: 2 },
          blank: { type: 'enum', values: [] }
        },
        true
      )
    ).toEqual({
      parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
        n: { type: 'range', min: 1, max: 4 },
        seed: { type: 'boolean' }
      },
      supportsStreaming: true
    });
  });
  it('prices output area, image count and prepared references in the published units', () => {
    const pricing = readMediaPricing([
      { billable: 'output_image', unit: 'megapixel', cost_usd: 0.014 },
      { billable: 'input_reference', unit: 'image', cost_usd: 0.01 }
    ]);
    expect(pricing).toHaveLength(2);
    expect(
      quoteMediaPrice(pricing, { width: 4096, height: 4096, count: 2, inputImageMegapixels: [1] })
    ).toBeCloseTo(0.479762048, 9);
    expect(
      quoteMediaPrice([{ billable: 'output_image', unit: 'token', costUsd: 0.01 }], {
        width: 1024,
        height: 1024
      })
    ).toBeNull();
    expect(
      readMediaPricing([
        { billable: 'output_image', unit: 'image', cost_usd: -1 },
        { billable: 'output_image', unit: 'image', cost_usd: Infinity },
        null
      ])
    ).toEqual([]);
  });
  it('uses the selected video tier once and refuses unpriced variants', () => {
    const pricing = [
      { billable: 'output_video', unit: 'second' as const, costUsd: 0.08 },
      { billable: 'output_video', unit: 'second' as const, costUsd: 0.05, variant: '480p' }
    ];
    expect(quoteMediaPrice(pricing, { seconds: 5, variant: '480p' })).toBe(0.25);
    expect(quoteMediaPrice(pricing, { seconds: 5, variant: '4K' })).toBeNull();
    expect(quoteMediaPrice(pricing, { seconds: 5 })).toBeNull();
    expect(quoteMediaPrice([], { seconds: 5 })).toBeNull();
  });
});
