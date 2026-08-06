import { describe, expect, it } from 'vitest';
import { promptCacheStyle, promptCacheStyleFor, readCacheUsage } from './prompt-cache.js';

describe('promptCacheStyle', () => {
  it('requires explicit breakpoints only for routes that bill them', () => {
    expect(promptCacheStyle('anthropic/claude-opus-5')).toBe('explicit');
    expect(promptCacheStyle('google/gemini-3-pro')).toBe('explicit');
    expect(promptCacheStyle('Anthropic/Claude-Sonnet-5')).toBe('explicit');
  });

  it('sees past the tilde on an alias id, which is the id an unattended server should prefer', () => {
    expect(promptCacheStyle('~anthropic/claude-opus-latest')).toBe('explicit');
    expect(promptCacheStyle('~google/gemini-pro-latest')).toBe('explicit');
  });

  it('treats automatic and unrecognised routes the same, so no unknown field is sent', () => {
    expect(promptCacheStyle('openai/gpt-6')).toBe('automatic');
    expect(promptCacheStyle('deepseek/deepseek-v4-flash')).toBe('automatic');
    expect(promptCacheStyle('z-ai/glm-5.2')).toBe('automatic');
    expect(promptCacheStyle('some-local-model')).toBe('automatic');
    expect(promptCacheStyle('')).toBe('automatic');
  });
});

describe('promptCacheStyleFor', () => {
  it('reads the pricing table rather than the vendor prefix', () => {
    // A route that charges to write the cache will not cache without a breakpoint.
    expect(
      promptCacheStyleFor({
        providerModelId: 'openai/gpt-5.6-terra',
        cacheReadUsdPerMillionTokens: 0.1,
        cacheWriteUsdPerMillionTokens: 1.25,
        catalogued: true
      })
    ).toBe('explicit');
    // A read price with no write price is a route that caches on its own.
    expect(
      promptCacheStyleFor({
        providerModelId: 'deepseek/deepseek-v4-flash',
        cacheReadUsdPerMillionTokens: 0.018,
        catalogued: true
      })
    ).toBe('automatic');
    expect(
      promptCacheStyleFor({
        providerModelId: 'z-ai/glm-5.2',
        supportsImplicitCaching: true,
        catalogued: true
      })
    ).toBe('automatic');
    // Neither price and no implicit caching: a breakpoint would be wasted bytes.
    expect(promptCacheStyleFor({ providerModelId: 'z-ai/glm-5.2', catalogued: true })).toBe('none');
  });

  it('falls back to the slug only for a route the catalogue never described', () => {
    expect(promptCacheStyleFor({ providerModelId: '~anthropic/claude-opus-latest' })).toBe(
      'explicit'
    );
    expect(promptCacheStyleFor({ providerModelId: 'my-local-llama' })).toBe('automatic');
  });
});

describe('readCacheUsage', () => {
  it('reads OpenAI-shaped cached prompt tokens', () => {
    expect(readCacheUsage({ prompt_tokens_details: { cached_tokens: 4_096 } })).toEqual({
      cachedInputTokens: 4_096
    });
  });

  it('reads Anthropic-shaped read and write counters', () => {
    expect(
      readCacheUsage({ cache_read_input_tokens: 12_000, cache_creation_input_tokens: 800 })
    ).toEqual({ cachedInputTokens: 12_000, cacheWriteTokens: 800 });
  });

  it('prefers the OpenAI-shaped field when a provider reports both', () => {
    expect(
      readCacheUsage({
        prompt_tokens_details: { cached_tokens: 10 },
        cache_read_input_tokens: 99
      })
    ).toEqual({ cachedInputTokens: 10 });
  });

  it('reports nothing rather than zero when a provider omits cache accounting', () => {
    expect(readCacheUsage(undefined)).toEqual({});
    expect(readCacheUsage({})).toEqual({});
    expect(readCacheUsage({ prompt_tokens_details: null })).toEqual({});
  });

  it('ignores values that are not usable token counts', () => {
    expect(
      readCacheUsage({
        prompt_tokens_details: { cached_tokens: Number.NaN },
        cache_creation_input_tokens: -5
      })
    ).toEqual({});
  });
});
