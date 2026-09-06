import { describe, expect, it, vi } from 'vitest';
import { describeOpenRouterImageModel, refreshOpenRouterMediaCatalog } from './media-catalog.js';

const image = {
  id: 'vendor/draw',
  name: 'Draw',
  architecture: { output_modalities: ['image', 'text'] },
  supported_parameters: {
    n: { type: 'range', min: 1, max: 2 },
    input_references: { type: 'range', min: 0, max: 4 }
  }
};
const speech = {
  id: 'vendor/speak',
  architecture: { output_modalities: ['speech'] },
  pricing: { prompt: '0.000015' }
};
const transcription = {
  id: 'vendor/hear',
  architecture: { output_modalities: ['transcription'] },
  pricing: { prompt: '0.1' }
};
const video = {
  id: 'vendor/move',
  supported_durations: [5, 10],
  supported_resolutions: ['480p', '720p'],
  supported_aspect_ratios: ['16:9'],
  pricing_skus: { duration_seconds_480p: '0.05', duration_seconds_720p: '0.08' },
  generate_audio: true
};
const fixture = () =>
  vi.fn(async (url: string | URL | Request) => {
    const path = url instanceof Request ? url.url : String(url);
    const data = path.endsWith('/images/models')
      ? [image]
      : path.includes('output_modalities=speech')
        ? [speech]
        : path.includes('output_modalities=transcription')
          ? [transcription]
          : path.endsWith('/videos/models')
            ? [video]
            : path.endsWith('/endpoints/zdr')
              ? [image, speech, transcription].map((m) => ({ model_id: m.id, status: 0 }))
              : [];
    return new Response(JSON.stringify({ data }));
  });
const options = { baseUrl: 'https://provider.example/v1', apiKey: 'offline-fixture' };

describe('dedicated media discovery', () => {
  it('offers documented duration transcription with explicit external retention under a private default', async () => {
    const base = fixture();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('output_modalities=transcription'))
        return Response.json({
          data: [{ ...transcription, id: 'openai/whisper-1', pricing: { prompt: '.00001' } }]
        });
      if (url.endsWith('/models/openai/whisper-1/endpoints'))
        return Response.json({
          data: {
            id: 'openai/whisper-1',
            endpoints: [
              {
                model_id: 'openai/whisper-1',
                tag: 'openai',
                status: 0,
                pricing: { prompt: '.006', completion: '0' }
              }
            ]
          }
        });
      if (url.endsWith('/endpoints/zdr'))
        return Response.json({
          data: [{ model_id: 'openai/whisper-1', tag: 'openai', status: 0 }]
        });
      return base(input);
    });
    const models = await refreshOpenRouterMediaCatalog({
      ...options,
      fetch,
      requireZeroDataRetention: true
    });
    const found = models.find((model) => model.providerModelId === 'openai/whisper-1');
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      usdPerMinute: 0.006,
      priceSource: 'provider',
      unavailableReason: null,
      zeroDataRetentionAvailable: false,
      requiresRetentionApproval: true
    });
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('discovers all four media families without relying on the text catalogue', async () => {
    const fetch = fixture();
    const models = await refreshOpenRouterMediaCatalog({
      ...options,
      fetch,
      requireZeroDataRetention: true
    });
    expect(models.length).toBeGreaterThan(0);
    const live = models.filter((model) => model.providerModelId.startsWith('vendor/'));
    expect(live.map((model) => model.modality)).toEqual([
      'image',
      'audio',
      'transcription',
      'video'
    ]);
    expect(live[0]?.capabilities?.parameters.input_references).toEqual({
      type: 'range',
      min: 0,
      max: 4
    });
    expect(live[1]).toMatchObject({
      usdPerMillionCharacters: 15,
      priceSource: 'provider',
      pricing: [{ billable: 'input_text', unit: 'character', costUsd: 0.000015 }]
    });
    expect(live[2]).toMatchObject({
      usdPerMinute: null,
      priceSource: 'unknown',
      zeroDataRetentionAvailable: false,
      requiresRetentionApproval: true
    });
    expect(live[2]?.recommendationTags).not.toContain('Provider prices this route per token');
    expect(live[3]).toMatchObject({
      zeroDataRetentionAvailable: false,
      unavailableReason: 'Video requires approval for temporary provider retention',
      capabilities: { parameters: { duration: { type: 'enum', values: ['5', '10'] } } }
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(
      fetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : String(url)))
    ).not.toContain(`${options.baseUrl}/models`);
  });
  it('does not silently weaken privacy when video becomes selectable', async () => {
    const models = await refreshOpenRouterMediaCatalog({
      ...options,
      fetch: fixture(),
      requireZeroDataRetention: false
    });
    const found = models.find((model) => model.modality === 'video');
    expect(found).toBeDefined();
    expect(found).toMatchObject({ zeroDataRetentionAvailable: false });
    expect(found?.unavailableReason).toBeUndefined();
  });
  it('hydrates only the selected image route with provider-specific prices and constraints', async () => {
    const models = await refreshOpenRouterMediaCatalog({ ...options, fetch: fixture() });
    const chosen = models.find((model) => model.providerModelId === image.id);
    expect(chosen).toBeDefined();
    const fetch = vi.fn<(url: string | URL | Request) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            endpoints: [
              {
                provider_tag: 'image-endpoint',
                supported_parameters: image.supported_parameters,
                pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.014 }]
              }
            ]
          })
        )
    );
    const endpoints = await describeOpenRouterImageModel(chosen!, { ...options, fetch });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatchObject({
      providerEndpointTag: 'image-endpoint',
      usdPerImage: null,
      priceSource: 'provider',
      pricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: 0.014 }]
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const requested = fetch.mock.calls[0]?.[0];
    expect(requested instanceof Request ? requested.url : String(requested)).toBe(
      `${options.baseUrl}/images/models/vendor/draw/endpoints`
    );
  });
  it('pins only an available endpoint with its own verified private route', async () => {
    const models = await refreshOpenRouterMediaCatalog({ ...options, fetch: fixture() });
    const chosen = models.find((model) => model.providerModelId === image.id);
    expect(chosen).toBeDefined();
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            (url instanceof Request ? url.url : String(url)).endsWith('/endpoints/zdr')
              ? {
                  data: [
                    { model_id: image.id, tag: 'private', status: 0 },
                    { model_id: image.id, tag: 'down', status: -2 },
                    { model_id: 'other/model', tag: 'foreign', status: 0 }
                  ]
                }
              : {
                  endpoints: ['retaining', 'private', 'down', 'foreign'].map((tag) => ({
                    provider_tag: tag,
                    pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.01 }]
                  }))
                }
          )
        )
    );
    const endpoints = await describeOpenRouterImageModel(chosen!, {
      ...options,
      fetch,
      requireZeroDataRetention: true
    });
    expect(endpoints.map((endpoint) => endpoint.providerEndpointTag)).toEqual(['private']);
    expect(endpoints[0]?.zeroDataRetentionAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
