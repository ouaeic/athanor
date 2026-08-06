import { describe, expect, it, vi } from 'vitest';
import type { ModelRelease } from '@athanor/contracts';
import { seedModels } from './catalog.js';
import { applyOpenRouterPrivacyPolicy, refreshOpenRouterCatalog } from './openrouter-catalog.js';

const NOW = new Date('2026-08-03T01:00:00.000Z');

/** Three measured models, one unmeasured, one measured only by the design arena. */
const modelsPayload = {
  data: [
    {
      id: 'z-ai/glm-5.2',
      context_length: 250_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.000001', completion: '0.000004' },
      supported_parameters: ['tools', 'reasoning'],
      benchmarks: {
        artificial_analysis: { intelligence_index: 40, coding_index: 50, agentic_index: 30 }
      }
    },
    {
      id: 'anthropic/claude-opus-5',
      name: 'Anthropic: Claude Opus 5',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625'
      },
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      top_provider: { max_completion_tokens: 128_000 },
      knowledge_cutoff: '2026-02-16',
      benchmarks: {
        artificial_analysis: { intelligence_index: 60.7, coding_index: 78, agentic_index: 55.3 }
      }
    },
    {
      id: 'openai/gpt-5.6-terra',
      name: 'OpenAI: GPT-5.6 Terra',
      context_length: 500_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000001',
        completion: '0.000006',
        input_cache_read: '0.0000001',
        input_cache_write: '0.00000125',
        overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000002', completion: '0.000012' }]
      },
      supported_parameters: ['tools', 'reasoning_effort'],
      benchmarks: {
        artificial_analysis: { intelligence_index: 55, coding_index: 76.7, agentic_index: 47.4 }
      }
    },
    {
      id: 'unreviewed/new-model',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }
    },
    {
      id: 'designer/pixel-1',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: {
        design_arena: [
          { arena: 'models', category: 'dataviz', elo: 1379, win_rate: 66.2, rank: 2 },
          { arena: 'agents', category: 'webapps', elo: 900, win_rate: 20, rank: 40 }
        ]
      }
    },
    {
      id: 'designer/pixel-0',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: { design_arena: [{ arena: 'models', category: 'dataviz', elo: 1000, rank: 30 }] }
    },
    {
      id: '~anthropic/claude-opus-latest',
      name: 'Anthropic: Claude Opus (latest)',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: {
        prompt: '0.000005',
        completion: '0.000025',
        input_cache_read: '0.0000005',
        input_cache_write: '0.00000625'
      },
      supported_parameters: ['tools', 'reasoning'],
      alias_target: { name: 'Anthropic: Claude Opus 5', slug: 'anthropic/claude-opus-5' },
      benchmarks: null
    },
    {
      id: 'openai/gpt-5.3-chat',
      context_length: 128_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000005', completion: '0.0000015' },
      supported_parameters: ['tools'],
      expiration_date: '2026-08-10'
    },
    {
      id: 'black-forest-labs/flux-2',
      architecture: { input_modalities: ['text'], output_modalities: ['image'] }
    }
  ]
};

const zdrPayload = {
  data: [
    {
      model_id: 'z-ai/glm-5.2',
      status: 0,
      latency_last_30m: null,
      uptime_last_1d: 99.8,
      supports_implicit_caching: false
    },
    {
      model_id: 'anthropic/claude-opus-5',
      status: 0,
      latency_last_30m: null,
      uptime_last_1d: 99.99
    },
    { model_id: 'anthropic/claude-opus-5', status: 0, latency_last_30m: null, uptime_last_1d: 88 },
    { model_id: 'openai/gpt-5.6-terra', status: 0, latency_last_30m: 250, uptime_last_1d: 99.5 },
    { model_id: 'z-ai/glm-5.2', status: -2, latency_last_30m: null, uptime_last_1d: 12 }
  ]
};

const respondWith = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

const liveFetch = (options: { zdrStatus?: number } = {}) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/models')) return respondWith(modelsPayload);
    if (url.endsWith('/endpoints/zdr'))
      return options.zdrStatus && options.zdrStatus !== 200
        ? new Response('{"error":{"code":401}}', { status: options.zdrStatus })
        : respondWith(zdrPayload);
    throw new Error(`unexpected request to ${url}`);
  });

describe('OpenRouter live catalog', () => {
  it('reads the benchmarks that ship with the models response and asks for nothing else', async () => {
    const request = liveFetch();
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: request as typeof fetch,
      now: NOW
    });

    // The undocumented, user-scoped /benchmarks call is gone: two requests, both documented.
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(([input]) =>
        (input instanceof Request ? input.url : String(input)).replace(
          'https://openrouter.ai/api/v1',
          ''
        )
      )
    ).toEqual(['/models', '/endpoints/zdr']);
    expect(
      result.find((model) => model.providerModelId === 'anthropic/claude-opus-5')
    ).toBeDefined();
  });

  it('normalises quality to a percentile of the live catalogue instead of dividing an index by 100', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    const terra = result.find((model) => model.providerModelId === 'openai/gpt-5.6-terra');
    const glm = result.find((model) => model.providerModelId === 'z-ai/glm-5.2');

    // The best model in the world scores 1.0, not 0.607, and the raw index is kept for display.
    expect(opus?.agenticQuality).toBe(1);
    expect(opus?.codingQuality).toBe(1);
    expect(opus?.intelligenceQuality).toBe(1);
    expect(opus?.agenticIndex).toBe(55.3);
    expect(opus?.intelligenceIndex).toBe(60.7);
    expect(opus?.benchmarkPopulation).toBe(3);
    expect(opus?.benchmarkRank).toBe(1);
    expect(opus?.benchmarkSource).toBe('artificial-analysis');

    expect(terra?.agenticQuality).toBeCloseTo(2 / 3, 3);
    expect(terra?.benchmarkRank).toBe(2);
    expect(glm?.agenticQuality).toBeCloseTo(1 / 3, 3);
    expect(glm?.benchmarkRank).toBe(3);

    // Every measured model now sits above the unmeasured prior of 0.4 except the weakest, which is
    // the point: the ordering is by measurement, not by the absence of it.
    const unmeasured = result.find((model) => model.providerModelId === 'unreviewed/new-model');
    expect(unmeasured?.measuredQuality).toBeNull();
    expect(unmeasured?.benchmarkRank).toBeNull();
  });

  it('uses a design-arena standing where it is the only measurement, bounded so it cannot outrank a hard eval', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const best = result.find((model) => model.providerModelId === 'designer/pixel-1');
    const worst = result.find((model) => model.providerModelId === 'designer/pixel-0');
    expect(best?.benchmarkSource).toBe('design-arena');
    expect(best?.measuredQuality).toBeCloseTo(0.8, 6);
    expect(worst?.measuredQuality).toBeCloseTo(0.6, 6);
    // No hard-eval column is invented from an arena placing, and it claims no rank in that table.
    expect(best?.agenticQuality).toBeNull();
    expect(best?.benchmarkRank).toBeNull();
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(best?.measuredQuality ?? 0).toBeLessThan(opus?.measuredQuality ?? 0);
  });

  it('resolves an alias to its target so the "latest" id is not a metadata-free duplicate', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const alias = result.find((model) => model.providerModelId === '~anthropic/claude-opus-latest');
    expect(alias?.intelligenceQuality).toBe(1);
    expect(alias?.intelligenceIndex).toBe(60.7);
    // ...and the tilde no longer hides an explicit-cache route from the breakpoint logic.
    expect(alias?.promptCacheStyle).toBe('explicit');
  });

  it('decides prompt caching from what the route charges, not from its vendor prefix', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const byId = new Map(result.map((model) => [model.providerModelId, model]));
    expect(byId.get('anthropic/claude-opus-5')?.promptCacheStyle).toBe('explicit');
    // The whole openai/gpt-5.6 family bills cache writes and used to be sent nothing at all.
    expect(byId.get('openai/gpt-5.6-terra')?.promptCacheStyle).toBe('explicit');
    expect(byId.get('openai/gpt-5.6-terra')?.cacheReadUsdPerMillionTokens).toBeCloseTo(0.1, 6);
    expect(byId.get('openai/gpt-5.6-terra')?.cacheWriteUsdPerMillionTokens).toBeCloseTo(1.25, 6);
    expect(byId.get('z-ai/glm-5.2')?.promptCacheStyle).toBe('none');
  });

  it('carries the fields that keep an unattended server working', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    const byId = new Map(result.map((model) => [model.providerModelId, model]));
    const opus = byId.get('anthropic/claude-opus-5');
    expect(opus?.maxOutputTokens).toBe(128_000);
    expect(opus?.knowledgeCutoff).toBe('2026-02-16');
    expect(opus?.supportsReasoningEffort).toBe(true);
    expect(opus?.recommendationTags).toContain('Documents');
    // The worst endpoint decides, because the provider may route to it.
    expect(opus?.uptimeLast1dPercent).toBe(88);

    const retiring = byId.get('openai/gpt-5.3-chat');
    expect(retiring?.expiresAt).toBe('2026-08-10');
    expect(retiring?.recommendationTags).toContain('Retires 2026-08-10');
    expect(byId.get('z-ai/glm-5.2')?.recommendationTags).not.toContain('Retires 2026-08-10');

    const terra = byId.get('openai/gpt-5.6-terra');
    expect(terra?.priceTiers).toEqual([
      { minPromptTokens: 200_000, inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 12 }
    ]);
    // Scaling a per-token decimal by a million must land exactly on the published rate.
    expect(terra?.inputUsdPerMillionTokens).toBe(1);
    expect(terra?.outputUsdPerMillionTokens).toBe(6);
    // latency_last_30m is a scalar on the wire, not an object with a p50.
    expect(terra?.measuredLatencyMs).toBe(250);
    expect(opus?.measuredLatencyMs).toBeNull();
  });

  it('keeps prices and benchmarks when the endpoint feed fails, and carries the previous privacy flags', async () => {
    const previous: ModelRelease[] = [
      {
        ...seedModels(NOW)[1]!,
        id: 'openrouter/z-ai/glm-5.2',
        providerModelId: 'z-ai/glm-5.2',
        zeroDataRetentionAvailable: true,
        providerAvailable: true
      }
    ];
    const request = liveFetch({ zdrStatus: 401 });
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: request as typeof fetch,
      now: NOW,
      previous
    });

    // One 401 used to reject the whole Promise.all and blank the catalogue back to seeds.
    const opus = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(opus?.inputUsdPerMillionTokens).toBe(5);
    expect(opus?.intelligenceQuality).toBe(1);
    // Nothing was verified, so nothing is claimed: the flag stays absent rather than becoming false.
    expect(opus?.zeroDataRetentionAvailable).toBeUndefined();
    // ...except where the previous refresh had an answer, which is carried forward.
    const glm = result.find((model) => model.id === 'openrouter/z-ai/glm-5.2');
    expect(glm?.zeroDataRetentionAvailable).toBe(true);
    expect(glm?.availability).toBe('available');
  });

  it('still fails when the model list itself cannot be read, because there is no catalogue without it', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/models')) return new Response('nope', { status: 500 });
      return respondWith(zdrPayload);
    });
    await expect(
      refreshOpenRouterCatalog(seedModels(NOW), {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'registry-key',
        fetch: request as typeof fetch,
        now: NOW
      })
    ).rejects.toThrow('OpenRouter models returned 500');
  });

  it('never expands the reviewed allowlist in strict scope and requires a live ZDR endpoint', async () => {
    const reviewed = seedModels(NOW);
    const result = await refreshOpenRouterCatalog(reviewed, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW,
      scope: 'reviewed_open_weight'
    });
    expect(result).toHaveLength(reviewed.length);
    expect(result.some((model) => model.providerModelId === 'unreviewed/new-model')).toBe(false);
    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      availability: 'available',
      contextTokens: 250_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 4,
      providerAvailable: true,
      zeroDataRetentionAvailable: true
    });
    expect(
      result
        .filter((model) => model.providerModelId !== 'z-ai/glm-5.2')
        .every((model) => model.availability === 'unavailable')
    ).toBe(true);
  });

  it('fails closed in strict scope when the independent model-license review expires', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: new Date('2026-10-21T00:00:00.000Z'),
      scope: 'reviewed_open_weight'
    });
    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')?.availability).toBe(
      'review'
    );
  });

  it('offers the provider catalogue by default so new models need no code change', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(NOW), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });

    const claude = result.find((model) => model.providerModelId === 'anthropic/claude-opus-5');
    expect(claude).toMatchObject({
      id: 'openrouter/anthropic/claude-opus-5',
      displayName: 'Claude Opus 5',
      availability: 'available',
      openness: 'remote_proprietary',
      commercialUse: true,
      usageClass: 'high',
      contextTokens: 1_000_000,
      zeroDataRetentionAvailable: true
    });
    expect(claude?.capabilities).toEqual(
      expect.arrayContaining(['chat', 'tools', 'vision', 'reasoning'])
    );
    expect(claude?.recommendationTags).toEqual(
      expect.arrayContaining(['Tools', 'Reasoning', 'Vision', 'Long context'])
    );
    // A media-only route is not a chat model and must not reach the model picker.
    expect(result.some((model) => model.providerModelId === 'black-forest-labs/flux-2')).toBe(
      false
    );
    // The reviewed seed keeps its open-weight badge and its live ZDR route.
    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      openness: 'permissive_open_weight',
      availability: 'available',
      zeroDataRetentionAvailable: true
    });
  });

  it('keeps a model selectable after its weight-licence review lapses, without the open-weight claim', async () => {
    const result = await refreshOpenRouterCatalog(seedModels(), {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: new Date('2026-10-21T00:00:00.000Z')
    });

    expect(result.find((model) => model.providerModelId === 'z-ai/glm-5.2')).toMatchObject({
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'provider-hosted'
    });
  });

  it('keeps non-ZDR models visible but unavailable until the owner permits provider policy', () => {
    const model = {
      ...seedModels()[0]!,
      availability: 'unavailable' as const,
      providerAvailable: true,
      zeroDataRetentionAvailable: false
    };
    expect(applyOpenRouterPrivacyPolicy(model, true)).toMatchObject({
      privacyRoute: 'provider_zdr',
      availability: 'unavailable'
    });
    expect(applyOpenRouterPrivacyPolicy(model, false)).toMatchObject({
      privacyRoute: 'external',
      availability: 'available'
    });
  });
});

describe('benchmark populations', () => {
  /**
   * The three columns do not cover the same models. A live catalogue read on 2026-08-03 carried 117
   * coding scores, 108 agentic and 107 intelligence, so a percentile that borrows the largest count
   * tells the owner a number that never measured the column being reported.
   */
  const unevenColumns = {
    data: [
      {
        id: 'vendor/all-three',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: {
          artificial_analysis: { intelligence_index: 60, coding_index: 78, agentic_index: 55 }
        }
      },
      {
        id: 'vendor/coding-only-high',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: { artificial_analysis: { coding_index: 70 } }
      },
      {
        id: 'vendor/coding-only-low',
        context_length: 200_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0.000001', completion: '0.000004' },
        benchmarks: { artificial_analysis: { coding_index: 10 } }
      }
    ]
  };

  it('counts each benchmark column separately, because they measure different models', async () => {
    const result = await refreshOpenRouterCatalog([], {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith('/models')) return respondWith(unevenColumns);
        return respondWith({ data: [] });
      }) as typeof fetch,
      now: NOW
    });

    const all = result.find((model) => model.providerModelId === 'vendor/all-three');
    expect(all?.benchmarkPopulations).toEqual({ coding: 3, agentic: 1, intelligence: 1 });
    // The single number stays the widest column, which is the population behind the overall score.
    expect(all?.benchmarkPopulation).toBe(3);
    // ...and the percentiles are computed within each column, not against a pooled distribution.
    expect(all?.codingQuality).toBe(1);
    expect(all?.agenticQuality).toBe(1);
    const partial = result.find((model) => model.providerModelId === 'vendor/coding-only-high');
    expect(partial?.codingQuality).toBeCloseTo(2 / 3, 3);
    expect(partial?.agenticQuality).toBeNull();
    expect(partial?.benchmarkPopulations).toEqual({ coding: 3, agentic: 1, intelligence: 1 });
  });

  it('claims no hard-eval column for a model measured only by the arena', async () => {
    const result = await refreshOpenRouterCatalog([], {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'registry-key',
      fetch: liveFetch() as typeof fetch,
      now: NOW
    });
    expect(
      result.find((model) => model.providerModelId === 'designer/pixel-1')?.benchmarkPopulations
    ).toBeNull();
    expect(
      result.find((model) => model.providerModelId === 'unreviewed/new-model')?.benchmarkPopulations
    ).toBeNull();
  });
});
