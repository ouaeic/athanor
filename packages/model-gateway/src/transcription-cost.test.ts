import { describe, expect, it } from 'vitest';
import { refreshOpenAIMediaCatalog } from './openai-media-catalog';
import { nativeTranscriptionBound } from './transcription-cost';

async function routes() {
  return refreshOpenAIMediaCatalog({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'fixture',
    requireZeroDataRetention: true,
    fetch: async () =>
      Response.json({
        data: [
          'gpt-4o-transcribe',
          'gpt-4o-mini-transcribe',
          'gpt-4o-mini-transcribe-2025-12-15',
          'gpt-4o-transcribe-diarize',
          'whisper-1'
        ].map((id) => ({ id }))
      })
  });
}

describe('bounded native transcription quotes', () => {
  it('prices every input token in the published context and every possible output token without duration guesses', async () => {
    const catalogue = await routes();
    expect(catalogue).toHaveLength(5);
    const standard = nativeTranscriptionBound(
      catalogue.find((route) => route.providerModelId === 'gpt-4o-transcribe')
    );
    expect(standard).toEqual({
      reservationUsd: 0.06,
      maxSeconds: 300,
      contextTokens: 16000,
      maxOutputTokens: 2000
    });
    expect(
      nativeTranscriptionBound(
        catalogue.find((route) => route.providerModelId === 'gpt-4o-mini-transcribe')
      )?.reservationUsd
    ).toBe(0.03);
    expect(
      nativeTranscriptionBound(
        catalogue.find((route) => route.providerModelId === 'gpt-4o-mini-transcribe-2025-12-15')
      )?.reservationUsd
    ).toBe(0.03);
    expect(
      nativeTranscriptionBound(
        catalogue.find((route) => route.providerModelId === 'gpt-4o-transcribe-diarize')
      )
    ).toMatchObject({ maxSeconds: 30, reservationUsd: 0.06 });
    expect(
      nativeTranscriptionBound(catalogue.find((route) => route.providerModelId === 'whisper-1'))
    ).toBeNull();
  });

  it('refuses unknown providers, model variants, missing rates and unaccounted billable categories', async () => {
    const catalogue = await routes();
    expect(catalogue.length).toBeGreaterThan(0);
    const route = catalogue[0]!;
    expect(nativeTranscriptionBound({ ...route, apiProtocol: 'openrouter' })).toBeNull();
    expect(
      nativeTranscriptionBound({ ...route, providerModelId: 'gpt-4o-transcribe-future' })
    ).toBeNull();
    expect(nativeTranscriptionBound({ ...route, priceSource: 'unknown' })).toBeNull();
    expect(nativeTranscriptionBound({ ...route, pricing: route.pricing!.slice(0, 1) })).toBeNull();
    expect(
      nativeTranscriptionBound({
        ...route,
        pricing: [...route.pricing!, { billable: 'extra', unit: 'token', costUsd: 0.01 }]
      })
    ).toBeNull();
    expect(
      nativeTranscriptionBound({
        ...route,
        pricing: [{ billable: 'input_tokens', unit: 'token', costUsd: NaN }, route.pricing![1]!]
      })
    ).toBeNull();
  });

  it('uses the reviewed route prices rather than a hard-coded cached price', async () => {
    const catalogue = await routes();
    expect(catalogue.length).toBeGreaterThan(0);
    const route = catalogue[0]!;
    const changed = nativeTranscriptionBound({
      ...route,
      pricing: [
        { billable: 'input_tokens', unit: 'token', costUsd: 0.000004 },
        { billable: 'output_tokens', unit: 'token', costUsd: 0.000012 }
      ]
    });
    expect(changed?.reservationUsd).toBe(0.088);
  });
});
