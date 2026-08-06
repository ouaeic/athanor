import type { ModelRelease } from '@athanor/contracts';

type Seed = Omit<ModelRelease, 'updatedAt'>;

/**
 * Commercially usable open-weight allowlist. Live OpenRouter metadata can
 * improve capabilities, prices, performance, and benchmark signals, but it
 * cannot add a model that has not passed our independent licence review.
 */
export const seedModels = (now = new Date()): ModelRelease[] => {
  const updatedAt = now.toISOString();
  const seeds: Seed[] = [
    {
      id: 'openrouter/deepseek/deepseek-v4-flash',
      providerModelId: 'deepseek/deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 1_000_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'light',
      recommendationTags: ['Fast default', 'Efficient', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/z-ai/glm-5.2',
      providerModelId: 'z-ai/glm-5.2',
      displayName: 'GLM-5.2',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 1_000_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'high',
      recommendationTags: ['Best for long agent work', 'Coding', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/qwen/qwen3.6-35b-a3b',
      providerModelId: 'qwen/qwen3.6-35b-a3b',
      displayName: 'Qwen 3.6 Vision',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'Apache-2.0',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 262_144,
      // Images and text only, because that is the whole of what athanor ever sends a model: the
      // only non-text part any request carries is an `image_url`. A seed that advertised video
      // would put a modality in the picker that nothing on this computer can put a model's way.
      modalities: ['text', 'image'],
      capabilities: ['chat', 'vision', 'tools', 'reasoning'],
      usageClass: 'medium',
      recommendationTags: ['Vision specialist', 'Screenshots and images', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    },
    {
      id: 'openrouter/openai/gpt-oss-120b',
      providerModelId: 'openai/gpt-oss-120b',
      displayName: 'gpt-oss 120B',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'review',
      openness: 'permissive_open_weight',
      license: 'Apache-2.0',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 131_072,
      modalities: ['text'],
      capabilities: ['chat', 'tools', 'reasoning'],
      usageClass: 'medium',
      recommendationTags: ['Reliable reasoning', 'Tools', 'Included'],
      measuredQuality: null,
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      benchmarkRank: null,
      benchmarkSource: null,
      benchmarkUpdatedAt: null
    }
  ];
  return seeds.map((model) => ({ ...model, updatedAt }));
};
