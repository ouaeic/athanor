import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { ModelRequest } from './protocol.js';
import { readReasoningOptions } from './reasoning.js';

describe('provider reasoning choices', () => {
  it('preserves accepted levels, default state and token-budget support without inventing missing values', () => {
    expect(
      readReasoningOptions({
        mandatory: true,
        supported_efforts: ['max', 'xhigh', 'high', 'low', 'future', 'low'],
        default_effort: 'high',
        default_enabled: true,
        supports_max_tokens: false
      })
    ).toEqual({
      mandatory: true,
      supportedEfforts: ['max', 'xhigh', 'high', 'low'],
      defaultEffort: 'high',
      defaultEnabled: true,
      supportsMaxTokens: false
    });
    expect(readReasoningOptions({ mandatory: false, supported_efforts: null })).toEqual({
      mandatory: false,
      supportedEfforts: null
    });
    expect(readReasoningOptions({ mandatory: false })).toEqual({ mandatory: false });
    expect(readReasoningOptions(null)).toBeNull();
    expect(readReasoningOptions({ supported_efforts: [null, 'future'] })).toEqual({
      mandatory: false,
      supportedEfforts: []
    });
  });

  it('sends a supported maximum effort without changing the model or buying an extra request', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(typeof init?.body).toBe('string');
      const body: unknown = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        model: 'chosen-model',
        reasoning: { effort: 'max' }
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      provider: 'openrouter',
      privacyRoute: 'external',
      baseUrl: 'https://provider.example/v1',
      fetch
    });
    const input = ModelRequest.parse({
      model: 'chosen-model',
      messages: [{ role: 'user', content: 'work' }],
      reasoningEffort: 'max',
      reasoningOptions: { supportedEfforts: ['low', 'max'], mandatory: true }
    });
    await expect(adapter.chat(input)).resolves.toMatchObject({ text: 'done' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'medium'] as const)(
    'rejects %s before any provider request when the selected route cannot honor it',
    async (reasoningEffort) => {
      const fetch = vi.fn();
      const adapter = new OpenAICompatibleAdapter({
        provider: 'test',
        privacyRoute: 'external',
        baseUrl: 'https://provider.example/v1',
        fetch
      });
      const input = ModelRequest.parse({
        model: 'chosen-model',
        messages: [{ role: 'user', content: 'work' }],
        reasoningEffort,
        reasoningOptions: { supportedEfforts: ['high', 'max'], mandatory: true }
      });
      await expect(adapter.chat(input)).rejects.toThrow(/requires reasoning|does not support/);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each(['openai', 'custom'])(
    'uses the native chat reasoning field for %s and omits unsupported controls',
    async (provider) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(typeof init?.body).toBe('string');
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
        );
      });
      const adapter = new OpenAICompatibleAdapter({
        provider,
        privacyRoute: 'external',
        baseUrl: 'https://api.openai.com/v1',
        fetch
      });
      const input = ModelRequest.parse({
        model: 'chosen-model',
        messages: [{ role: 'user', content: 'work' }],
        reasoningEffort: 'high',
        reasoningOptions: { supportedEfforts: ['high'], mandatory: true }
      });
      await adapter.chat(input);
      await adapter.chat({ ...input, supportsReasoningEffort: false });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' });
      expect(bodies[0]).not.toHaveProperty('reasoning');
      expect(bodies[1]).not.toHaveProperty('reasoning_effort');
      expect(bodies[1]).not.toHaveProperty('reasoning');
    }
  );
});
