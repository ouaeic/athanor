import { describe, expect, it, vi } from 'vitest';
import { configuredModelCatalog } from './catalog.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

const official = 'https://api.openai.com/v1';
const discover = (entries: unknown[], baseUrl = official) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: entries })));
  const adapter = new OpenAICompatibleAdapter({
    baseUrl,
    provider: 'custom',
    privacyRoute: 'external',
    fetch: fetcher
  });
  return { adapter, fetcher };
};

const options = {
  privacyRoute: 'external' as const,
  contextTokens: 4096,
  capabilities: ['chat', 'tools'] as const,
  modalities: ['text'] as const,
  tag: 'Owner provider'
};
const catalog = (models: Parameters<typeof configuredModelCatalog>[0]) =>
  configuredModelCatalog(models, {
    ...options,
    capabilities: [...options.capabilities],
    modalities: [...options.modalities]
  });

describe('documented native OpenAI input discovery', () => {
  it('makes the account-listed exact audio model usable with documented cost bounds', async () => {
    const { adapter, fetcher } = discover(
      [{ id: 'gpt-audio-1.5' }, { id: 'unknown' }],
      `${official}/`
    );
    const described = await adapter.describe();
    const models = catalog(described);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'custom/gpt-audio-1.5',
      providerModelId: 'gpt-audio-1.5',
      provider: 'custom',
      contextTokens: 128_000,
      maxOutputTokens: 16_384,
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 10,
      nativeInputPricing: { audioUsdPerMillionTokens: 32, videoUsdPerMillionTokens: null },
      modalities: ['text', 'audio'],
      capabilities: ['chat', 'tools'],
      supportsReasoningEffort: false,
      metadataSource: 'declared',
      privacyRoute: 'external',
      measuredQuality: null
    });
    expect(described[0]!.unknownFields).toEqual([]);
    expect(models[1]).toMatchObject({ metadataSource: 'unknown', modalities: ['text'] });
    expect(adapter.privacyRoute).toBe('external');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${official}/models`, {
      headers: { 'content-type': 'application/json' },
      redirect: 'error'
    });
  });

  it('does not append account-unavailable models or guess aliases and snapshots', async () => {
    expect(await discover([]).adapter.describe()).toEqual([]);
    const ids = [
      'unknown',
      'gpt-audio',
      'gpt-audio-mini',
      'gpt-audio-1.5-2026-09-06',
      'gpt-audio-1.5:free'
    ];
    expect(ids.length).toBeGreaterThan(0);
    const models = catalog(await discover(ids.map((id) => ({ id }))).adapter.describe());
    expect(models.map((model) => model.providerModelId)).toEqual(ids);
    for (const model of models) {
      expect(model).toMatchObject({
        metadataSource: 'unknown',
        inputUsdPerMillionTokens: null,
        nativeInputPricing: { audioUsdPerMillionTokens: null },
        modalities: ['text']
      });
    }
  });

  it.each([
    'https://api.openai.com.evil.test/v1',
    'https://proxy.test/v1',
    'http://api.openai.com/v1',
    'https://api.openai.com/v1/proxy',
    'https://api.openai.com/v1?proxy=true',
    'https://api.openai.com/v1#proxy',
    'https://owner@api.openai.com/v1'
  ])('does not attach native declarations to another endpoint: %s', async (baseUrl) => {
    const models = catalog(await discover([{ id: 'gpt-audio-1.5' }], baseUrl).adapter.describe());
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      metadataSource: 'unknown',
      nativeInputPricing: { audioUsdPerMillionTokens: null },
      modalities: ['text']
    });
  });

  it('retains stricter advertised limits, higher prices and explicit capability denials', async () => {
    const described = await discover([
      {
        id: 'gpt-audio-1.5',
        context_length: 64_000,
        max_output_tokens: 2048,
        pricing: { prompt: '0.000004', completion: '0.000015', audio: '0.000040' },
        supported_parameters: [],
        architecture: { input_modalities: ['text', 'image', 'video'] }
      }
    ]).adapter.describe();
    expect(catalog(described)[0]).toMatchObject({
      contextTokens: 64_000,
      maxOutputTokens: 2048,
      inputUsdPerMillionTokens: 4,
      outputUsdPerMillionTokens: 15,
      nativeInputPricing: { audioUsdPerMillionTokens: 40, videoUsdPerMillionTokens: null },
      capabilities: ['chat'],
      modalities: ['text']
    });
    const lower = await discover([
      {
        id: 'gpt-audio-1.5',
        context_length: 256_000,
        max_output_tokens: 32_768,
        pricing: { prompt: '0', completion: '0', audio: '0' }
      }
    ]).adapter.describe();
    expect(catalog(lower)[0]).toMatchObject({
      contextTokens: 128_000,
      maxOutputTokens: 16_384,
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 10,
      nativeInputPricing: { audioUsdPerMillionTokens: 32 }
    });
  });

  it('preserves owner privacy and tools restrictions', async () => {
    const described = await discover([{ id: 'gpt-audio-1.5' }]).adapter.describe();
    const models = configuredModelCatalog(described, {
      ...options,
      privacyRoute: 'provider_zdr',
      capabilities: ['chat'],
      modalities: ['text']
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ privacyRoute: 'provider_zdr', capabilities: ['chat'] });
  });
});

const wav = Buffer.alloc(48);
wav.write('RIFF');
wav.writeUInt32LE(40, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(4, 40);

describe('direct OpenAI native input request', () => {
  it.each([false, true])(
    'sends real bounded audio with text-only standard output; owner ZDR=%s',
    async (zdr) => {
      const bodies: Record<string, unknown>[] = [];
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('Unexpected discovery during chat');
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"Heard."},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":3,"total_tokens":83}}',
            'data: [DONE]'
          ].join('\n\n') + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      });
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: official,
        provider: 'custom',
        apiKey: 'test-key',
        privacyRoute: zdr ? 'provider_zdr' : 'external',
        enforceZeroDataRetention: zdr,
        fetch: fetcher as typeof fetch
      });
      const delta = vi.fn();
      const response = await adapter.chat({
        model: 'gpt-audio-1.5',
        sessionId: 'local-task-id',
        nativeInputRequestId: 'source-proof',
        inputModalities: ['text', 'audio'],
        messages: [
          {
            role: 'user',
            content: 'Describe this recording',
            nativeInputs: [
              {
                kind: 'audio',
                mimeType: 'audio/wav',
                data: wav.toString('base64')
              }
            ]
          }
        ],
        tools: [
          { name: 'set_plan', description: 'Plan', parameters: { type: 'object', properties: {} } }
        ],
        temperature: 0,
        maxTokens: 4096,
        maxOutputTokens: 16_384,
        onTextDelta: delta
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]![0]).toBe(`${official}/chat/completions`);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        model: 'gpt-audio-1.5',
        modalities: ['text'],
        store: false,
        service_tier: 'default',
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true },
        tools: [{ type: 'function', function: { name: 'set_plan' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this recording' },
              { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }
            ]
          }
        ]
      });
      expect(bodies[0]).not.toHaveProperty('provider');
      expect(bodies[0]).not.toHaveProperty('session_id');
      expect(bodies[0]).not.toHaveProperty('audio');
      expect(response.text).toBe('Heard.');
      expect(response.usage.totalTokens).toBe(83);
      expect(delta).toHaveBeenCalledWith('Heard.');
      expect(adapter.privacyRoute).toBe(zdr ? 'provider_zdr' : 'external');
    }
  );
});
