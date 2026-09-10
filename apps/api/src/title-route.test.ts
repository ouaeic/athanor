import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoutableModel } from '@athanor/core';
import { seedModels } from '@athanor/model-gateway';
import type { ServerBase } from './http/server-context.js';
import { createServerSupport } from './routes/support.js';
import { selectTitleRoute, TITLE_MAX_COST_USD, TITLE_OUTPUT_TOKENS } from './title-route.js';

const model = (overrides: Partial<RoutableModel> = {}): RoutableModel => ({
  ...seedModels()[0]!,
  id: 'openrouter/title',
  providerModelId: 'title',
  availability: 'available',
  contextTokens: 8_192,
  capabilities: ['chat'],
  supportsReasoningEffort: false,
  inputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 0.2,
  ...overrides
});
const select = (models: RoutableModel[]) =>
  selectTitleRoute(models, { provider: 'openrouter', privacyRoute: 'provider_zdr', ceiling: {} });
const support = (models: RoutableModel[], native = false) =>
  createServerSupport({
    store: {
      getManagedProviderCredential: async () => null,
      // Nothing saved: the credential comes from the environment, which is the shape a self-hosted
      // box configured through `control.env` has. A double missing this method fails on the store
      // call that looks for saved connections rather than on what the case is about.
      listManagedProviderCredentials: async () => [],
      rerouteTaskModel: async () => false,
      recordModelThroughputCeiling: async () => undefined,
      modelThroughputCeiling: async () => null,
      listModels: async () => models,
      effectiveSpendLimits: async () => ({})
    },
    overrides: {},
    config: {
      AI_PROVIDER: native ? 'openai-compatible' : 'openrouter',
      AI_BASE_URL: native ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1',
      AI_API_KEY: 'fixture',
      AI_REQUIRE_ZDR: true,
      PUBLIC_APP_URL: 'https://garden.example'
    }
  } as unknown as ServerBase);
afterEach(() => vi.unstubAllGlobals());

describe('bounded auxiliary title route', () => {
  it('chooses the cheapest eligible nonreasoning route and sends none only when advertised', () => {
    const expensive = model({ id: 'expensive', inputUsdPerMillionTokens: 0.3 });
    const mandatory = model({
      id: 'mandatory',
      inputUsdPerMillionTokens: 0,
      reasoning: { mandatory: true, supportedEfforts: ['low'] }
    });
    const selected = select([expensive, mandatory, model()]);
    expect(selected?.model.id).toBe('openrouter/title');
    expect(selected?.reasoningEffort).toBeUndefined();
    expect(selected?.maxTokens).toBe(TITLE_OUTPUT_TOKENS);
    expect(selected!.maxCostUsd).toBeLessThanOrEqual(TITLE_MAX_COST_USD);
    expect(
      select([
        model({
          capabilities: ['chat', 'reasoning'],
          reasoning: { mandatory: false, supportedEfforts: ['none', 'high'] }
        })
      ])?.reasoningEffort
    ).toBe('none');
  });

  it('skips mandatory, unknown, retired, wrong-provider, over-cap and unpriced routes', () => {
    const invalid = [
      model({ reasoning: { mandatory: true } }),
      model({ capabilities: ['chat', 'reasoning'] }),
      model({ expiresAt: '2000-01-01' }),
      model({ provider: 'different' }),
      model({ contextTokens: 1_000_000 }),
      model({ inputUsdPerMillionTokens: null }),
      model({
        priceTiers: [
          { minPromptTokens: 500, inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 100 }
        ]
      }),
      model({ maxOutputTokens: 32 })
    ];
    expect(invalid.length).toBeGreaterThan(0);
    for (const entry of invalid) expect(select([entry])).toBeNull();
  });

  it.each([false, true])(
    'uses the actual builder with price, output and explicit reasoning controls (native=%s)',
    async (native) => {
      const calls: Record<string, unknown>[] = [];
      const beforeSubmit = vi.fn(async () => undefined);
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method !== 'POST')
          return new Response(
            JSON.stringify({
              data: [
                { model_id: 'title', status: 0, supported_parameters: ['reasoning', 'max_tokens'] }
              ]
            })
          );
        expect(beforeSubmit).toHaveBeenCalledOnce();
        calls.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: 'Complete release pipeline repair' }, finish_reason: 'stop' }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 7, cost: 0.0001 }
          })
        );
      });
      vi.stubGlobal('fetch', fetch);
      const result = await support(
        [
          model({
            provider: native ? 'custom' : 'openrouter',
            capabilities: ['chat', 'reasoning'],
            reasoning: { mandatory: false, supportedEfforts: ['none', 'high'] }
          })
        ],
        native
      ).titleCompletion({
        userId: 'owner',
        modelId: 'unfit-mandatory-model',
        privacyRoute: 'provider_zdr',
        prompt: 'Fix the release pipeline',
        beforeSubmit
      });
      expect(result).toMatchObject({ text: 'Complete release pipeline repair', costUsd: 0.0001 });
      expect(calls).toHaveLength(1);
      if (native) {
        expect(calls[0]).toMatchObject({
          max_completion_tokens: TITLE_OUTPUT_TOKENS,
          reasoning_effort: 'none'
        });
        expect(calls[0]).not.toHaveProperty('max_tokens');
        expect(calls[0]).not.toHaveProperty('provider');
      } else
        expect(calls[0]).toMatchObject({
          max_tokens: TITLE_OUTPUT_TOKENS,
          reasoning: { effort: 'none' },
          provider: {
            zdr: true,
            data_collection: 'deny',
            require_parameters: true,
            allow_fallbacks: false,
            max_price: { prompt: 0.1, completion: 0.2, request: 0 }
          }
        });
    }
  );

  it('does no provider work or reservation when only mandatory reasoning is available', async () => {
    const fetch = vi.fn(),
      beforeSubmit = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      await support([model({ reasoning: { mandatory: true } })]).titleCompletion({
        userId: 'owner',
        modelId: 'title',
        privacyRoute: 'provider_zdr',
        prompt: 'Repair',
        beforeSubmit
      })
    ).toEqual({ skipped: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeSubmit).not.toHaveBeenCalled();
  });
  it.each([{ parameters: ['reasoning'] }, { parameters: ['max_tokens'] }])(
    'refuses an endpoint missing a required title control: %j',
    async ({ parameters }) => {
      const beforeSubmit = vi.fn();
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ model_id: 'title', supported_parameters: parameters }] })
          )
      );
      vi.stubGlobal('fetch', fetch);
      await expect(
        support([
          model({ reasoning: { mandatory: false, supportedEfforts: ['none', 'high'] } })
        ]).titleCompletion({
          userId: 'owner',
          modelId: 'task-model',
          privacyRoute: 'provider_zdr',
          prompt: 'Repair',
          beforeSubmit
        })
      ).rejects.toMatchObject({
        code: parameters.includes('reasoning')
          ? 'provider_output_limit_unsupported'
          : 'provider_reasoning_control_unsupported'
      });
      expect(beforeSubmit).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
});
