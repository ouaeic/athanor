import { describe, expect, it, vi } from 'vitest';
import { seedMediaModels } from './catalog.js';
import {
  openRouterTranscriptionDurationRate,
  refreshOpenRouterTranscriptionModel,
  isOpenRouterEndpoint
} from './openrouter-transcription.js';

const modelId = 'openai/whisper-1';
const endpoint = (prompt: string, tag = 'openai') => ({
  model_id: modelId,
  tag,
  status: 0,
  pricing: { prompt, completion: '0', discount: 0 }
});
const body = (endpoints: unknown[]) => ({ data: { id: modelId, endpoints } });

describe('documented OpenRouter transcription duration units', () => {
  it('normalizes seconds, minutes and hours before taking the most expensive routed price', () => {
    const id = 'openai/whisper-large-v3';
    const endpoints = [
      endpoint('.0000075', 'deepinfra'),
      endpoint('.0015', 'together'),
      endpoint('.111', 'groq')
    ].map((value) => ({ ...value, model_id: id }));
    expect(openRouterTranscriptionDurationRate(id, { data: { id, endpoints } })).toBeCloseTo(
      0.00185,
      10
    );
    expect(
      openRouterTranscriptionDurationRate(id, { data: { id, endpoints: endpoints.slice(0, 2) } })
    ).toBe(0.0015);
    expect(
      openRouterTranscriptionDurationRate(id, { data: { id, endpoints: endpoints.slice(0, 1) } })
    ).toBe(0.00045);
  });
  it('normalizes the documented per-minute rate and bounds every possible endpoint, including recovering routes', () => {
    expect(
      openRouterTranscriptionDurationRate(
        modelId,
        body([endpoint('0.006'), { ...endpoint('0.009'), status: -2 }])
      )
    ).toBe(0.009);
    expect(openRouterTranscriptionDurationRate(modelId, body([endpoint('0.006')]))).toBe(0.006);
  });
  it.each([
    body([]),
    body([endpoint('0.006'), endpoint('0.0001', 'unknown')]),
    body([{ ...endpoint('0.006'), pricing: { prompt: '.006', completion: '.1' } }]),
    body([{ ...endpoint('0.006'), pricing: { prompt: '.006', completion: '0', request: '.01' } }]),
    body([{ ...endpoint('0.006'), model_id: 'other/model' }]),
    body([endpoint('-1')]),
    { data: { id: 'other/model', endpoints: [endpoint('.006')] } }
  ])('rejects incomplete or differently billed endpoint metadata %#', (value) => {
    expect(openRouterTranscriptionDurationRate(modelId, value)).toBeNull();
  });
  it('does not guess duration units from a token or newly introduced model', () => {
    expect(
      openRouterTranscriptionDurationRate('openai/gpt-4o-transcribe', body([endpoint('.006')]))
    ).toBeNull();
  });
  it('refreshes legacy private metadata with a live all-endpoint price and never pins routing', async () => {
    const seeds = seedMediaModels();
    expect(seeds.length).toBeGreaterThan(0);
    const model = {
      ...seeds[0]!,
      id: `openrouter/${modelId}`,
      providerModelId: modelId,
      modality: 'transcription' as const,
      providerEndpointTag: 'old-pin',
      zeroDataRetentionAvailable: true
    };
    const fetch = vi.fn(async () => Response.json(body([endpoint('.006')])));
    const result = await refreshOpenRouterTranscriptionModel(model, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'fixture',
      fetch
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toBeDefined();
    expect(result).toMatchObject({
      usdPerMinute: 0.006,
      priceSource: 'provider',
      zeroDataRetentionAvailable: false,
      requiresRetentionApproval: true,
      unavailableReason: null,
      pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.006 }]
    });
    expect(result).not.toHaveProperty('providerEndpointTag');
    const failed = await refreshOpenRouterTranscriptionModel(result, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'fixture',
      fetch: async () => Response.json(body([endpoint('.006', 'new-provider')]))
    });
    expect(failed).toMatchObject({ priceSource: 'unknown', usdPerMinute: null, pricing: [] });
    expect(failed.unavailableReason).toBeTruthy();
  });
  it('recognizes only the exact OpenRouter API origin and path', () => {
    expect(isOpenRouterEndpoint('https://openrouter.ai/api/v1/')).toBe(true);
    expect(isOpenRouterEndpoint('https://openrouter.ai.attacker.test/api/v1')).toBe(false);
    expect(isOpenRouterEndpoint('https://openrouter.ai/api/v1?proxy=1')).toBe(false);
  });
});
