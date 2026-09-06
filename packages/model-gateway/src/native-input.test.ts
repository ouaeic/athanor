import { describe, expect, it, vi } from 'vitest';
import { nativeInputBlocks, NATIVE_INPUT_MAX_BYTES, type NativeInputPart } from './native-input.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';

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
const audio: NativeInputPart = {
  kind: 'audio',
  mimeType: 'audio/wav',
  data: wav.toString('base64')
};
const mp4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2UlsBEAAAAMAQAAADIPEiWWAAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAMAwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsoAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAONAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAAAIZnJlZQAAAuptZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAFGWIhAAz//727L4FNhTIUJZ5xxfBAAAACEGaImxCv/5WAAAACAGeQXkK/1rB',
  'base64'
);
const video: NativeInputPart = {
  kind: 'video',
  mimeType: 'video/mp4',
  data: mp4.toString('base64')
};

describe('native model input transport', () => {
  it('serializes exact audio and private video bytes on OpenRouter with ZDR and reasoning continuity', async () => {
    const bodies: Array<{
      messages: Array<{ content: unknown; reasoning_details?: unknown }>;
      provider: unknown;
    }> = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.body)
        return new Response(
          JSON.stringify({ data: [{ supported_parameters: ['tools', 'max_tokens'] }] })
        );
      bodies.push(JSON.parse(init.body as string) as (typeof bodies)[number]);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'heard and seen' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, cost: 0.001 }
        })
      );
    });
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      privacyRoute: 'provider_zdr',
      enforceZeroDataRetention: true,
      fetch: fetcher as typeof fetch
    });
    const response = await adapter.chat({
      model: 'test/model',
      nativeInputRequestId: 'source-1',
      nativeInputCreditLimit: 1,
      nativeInputCredentialBinding: 'a'.repeat(64),
      nativeInputMaxPrice: { prompt: 3, completion: 2 },
      inputModalities: ['audio', 'video'],
      messages: [
        { role: 'user', content: 'Listen and watch', nativeInputs: [audio, video] },
        {
          role: 'assistant',
          content: 'thinking',
          reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque' }]
        }
      ],
      tools: [],
      temperature: 0
    });
    expect(response.text).toBe('heard and seen');
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'Listen and watch' },
      { type: 'input_audio', input_audio: { data: audio.data, format: 'wav' } },
      {
        type: 'video_url',
        video_url: { url: `data:video/mp4;base64,${video.data}` },
        processing: 'static'
      }
    ]);
    expect(body.messages[1]!.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', data: 'opaque' }
    ]);
    expect(body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
    expect(body.provider).toMatchObject({
      allow_fallbacks: false,
      max_price: { prompt: 3, completion: 2 }
    });
    expect(body).not.toHaveProperty('nativeInputRequestId');

    expect(fetcher.mock.calls.filter((call) => call[1]?.body)).toHaveLength(1);
  });
  it('accepts direct compatible audio but refuses unsupported models, video protocols, roles, and forged bytes before fetch', async () => {
    expect(nativeInputBlocks([audio], 'custom', ['audio'])).toEqual([
      { type: 'input_audio', input_audio: { data: audio.data, format: 'wav' } }
    ]);
    const fetcher = vi.fn();
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://api.openai.com/v1',
      provider: 'custom',
      privacyRoute: 'external',
      fetch: fetcher
    });
    for (const entry of [
      { role: 'user' as const, nativeInputs: [audio], inputModalities: ['text'] as const },
      { role: 'user' as const, nativeInputs: [video], inputModalities: ['video'] as const },
      { role: 'system' as const, nativeInputs: [audio], inputModalities: ['audio'] as const },
      {
        role: 'user' as const,
        nativeInputs: [{ ...audio, data: Buffer.from('not a recording').toString('base64') }],
        inputModalities: ['audio'] as const
      }
    ])
      await expect(
        adapter.chat({
          model: 'x',
          messages: [{ role: entry.role, content: 'read', nativeInputs: entry.nativeInputs }],
          inputModalities: [...entry.inputModalities],
          tools: [],
          temperature: 0
        })
      ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses aggregate media and assembled transport bounds without silently dropping the requested recording', async () => {
    const huge = Buffer.alloc(NATIVE_INPUT_MAX_BYTES);
    wav.copy(huge);
    expect(() =>
      nativeInputBlocks([{ ...audio, data: huge.toString('base64') }, audio], 'openrouter', [
        'audio'
      ])
    ).toThrow(/combined/);
    const fetcher = vi.fn();
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'https://provider.invalid/v1',
      provider: 'custom',
      privacyRoute: 'external',
      maxRequestBytes: 100,
      fetch: fetcher
    });
    await expect(
      adapter.chat({
        model: 'x',
        messages: [{ role: 'user', content: 'listen', nativeInputs: [audio] }],
        inputModalities: ['audio'],
        tools: [],
        temperature: 0
      })
    ).rejects.toMatchObject({ code: 'native_input_too_large' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
