import { describe, expect, it } from 'vitest';
import { seedModels } from './catalog.js';

describe('cloud-only model catalog', () => {
  it('contains only independently reviewed OpenRouter open-weight routes', () => {
    const models = seedModels(new Date('2026-07-21T00:00:00.000Z'));
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every(
        (model) =>
          model.provider === 'openrouter' &&
          model.privacyRoute === 'provider_zdr' &&
          model.openness === 'permissive_open_weight' &&
          model.commercialUse &&
          !`${model.id} ${model.displayName} ${model.provider}`.toLowerCase().includes('local')
      )
    ).toBe(true);
  });

  it('offers a compact catalog from fast default through specialist vision and high-end work', () => {
    const aliases = seedModels().map((model) => [model.providerModelId, model.usageClass]);
    expect(aliases).toEqual(
      expect.arrayContaining([
        ['deepseek/deepseek-v4-flash', 'light'],
        ['qwen/qwen3.6-35b-a3b', 'medium'],
        ['openai/gpt-oss-120b', 'medium'],
        ['z-ai/glm-5.2', 'high']
      ])
    );
  });

  it('advertises only the modalities athanor can put into a request', () => {
    // The gateway builds exactly one non-text content block, `image_url`, so a reviewed seed that
    // offered audio or video would show the owner a capability nothing on this computer can reach:
    // a screenshot is sent to a vision model, a recording never is.
    const offered = new Set(seedModels().flatMap((model) => model.modalities));
    expect([...offered].sort()).toEqual(['image', 'text']);
  });

  it('keeps provider model ids separate from stable athanor ids', () => {
    expect(seedModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openrouter/z-ai/glm-5.2',
          provider: 'openrouter',
          providerModelId: 'z-ai/glm-5.2'
        })
      ])
    );
  });
});
