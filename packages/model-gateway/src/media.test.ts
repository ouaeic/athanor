import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaClient } from './media.js';

afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new MediaClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'managed-key',
    appUrl: 'https://athanor.example'
  });

describe('managed media generation', () => {
  it('requires ZDR and data-collection denial for image generation', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'black-forest-labs/flux.2-klein-4b',
        provider: { zdr: true, data_collection: 'deny', allow_fallbacks: true }
      });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('image').toString('base64') }],
          usage: { cost: 0.014 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-2',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 2
      })
    ).resolves.toMatchObject({ costUsd: 0.014, outputs: [{ filename: 'gen-2-1.png' }] });
  });

  it('uses the commercially reviewed Kokoro route and voice for speech', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'hexgrad/kokoro-82m',
        voice: 'af_heart',
        provider: { zdr: true, data_collection: 'deny' }
      });
      return new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-3',
        kind: 'audio',
        model: 'hexgrad/kokoro-82m',
        prompt: 'Private speech',
        width: 0,
        height: 0,
        seed: 3,
        voice: 'af_heart'
      })
    ).resolves.toMatchObject({ outputs: [{ filename: 'gen-3.mp3' }] });
  });

  it('sends no voice to a speech route whose voices athanor does not know', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as object) : {};
      expect(body).not.toHaveProperty('voice');
      return new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-6',
        kind: 'audio',
        model: 'some-other/speech-model',
        prompt: 'Private speech',
        width: 0,
        height: 0,
        seed: 6,
        usdPerMillionCharacters: 2
      })
    ).resolves.toMatchObject({ costUsd: (14 * 2) / 1_000_000 });
  });

  it('prices an image from the chosen route rather than from the compiled-in default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );
    await expect(
      client().generate({
        id: 'gen-7',
        kind: 'image',
        model: 'some-other/image-model',
        prompt: 'A private image',
        width: 1000,
        height: 1000,
        seed: 7,
        usdPerImage: 0.09
      })
    ).resolves.toMatchObject({ costUsd: 0.09 });
  });

  it('refuses to fetch an output the provider offered over plain HTTP', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/images'))
        return new Response(JSON.stringify({ data: [{ url: 'http://cdn.example/img.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      throw new Error('the download should never have been attempted');
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().generate({
        id: 'gen-4',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 4
      })
    ).rejects.toThrow('unsafe download URL');
  });

  it('carries the provider error body, so a refusal says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no such model', { status: 404 }))
    );
    await expect(
      client().generate({
        id: 'gen-5',
        kind: 'image',
        model: 'black-forest-labs/flux.2-klein-4b',
        prompt: 'A private image',
        width: 1024,
        height: 1024,
        seed: 5
      })
    ).rejects.toThrow('no such model');
  });
});

describe('reading a recording back as text', () => {
  it('sends the prepared audio over the same private route as everything else', async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      expect(body).toMatchObject({
        model: 'a-transcription-route',
        input_audio: { data: Buffer.from('ogg-bytes').toString('base64'), format: 'ogg' },
        temperature: 0,
        provider: { zdr: true, data_collection: 'deny', allow_fallbacks: true }
      });
      return new Response(
        JSON.stringify({ text: '  the meeting starts now  ', usage: { seconds: 61, cost: 0.007 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', request);
    await expect(
      client().transcribe({
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 60,
        usdPerMinute: 0.02
      })
    ).resolves.toEqual({
      text: 'the meeting starts now',
      billedSeconds: 61,
      // The provider's own figure, not the per-minute arithmetic: a duration price is quoted per
      // minute and rounded in ways this side cannot see, so a derived number in the ledger would be
      // a guess sitting where a billed amount belongs.
      costUsd: 0.007,
      costFromProvider: true
    });
  });

  it('prices from the route when the provider says nothing, and says which it was', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: 'two minutes of talking' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    await expect(
      client().transcribe({
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 120,
        usdPerMinute: 0.006
      })
    ).resolves.toMatchObject({ billedSeconds: null, costUsd: 0.012, costFromProvider: false });
  });

  it('refuses an answer with no speech in it rather than reporting an empty reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: '   ' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    await expect(
      client().transcribe({
        model: 'a-transcription-route',
        audio: Buffer.from('ogg-bytes'),
        format: 'ogg',
        seconds: 30
      })
    ).rejects.toThrow(/no speech/i);
  });

  it('asks the provider which models read recordings, and only for those', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe('/api/v1/models');
      expect(url.searchParams.get('output_modalities')).toBe('transcription');
      return new Response(JSON.stringify({ data: [{ id: 'one' }, {}, { id: 'two' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', request);
    await expect(client().transcriptionModels()).resolves.toEqual(['one', 'two']);
  });
});
