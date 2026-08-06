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
        seed: 3
      })
    ).resolves.toMatchObject({ outputs: [{ filename: 'gen-3.mp3' }] });
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
