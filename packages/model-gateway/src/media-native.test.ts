import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG as PngImage } from 'pngjs';
import { MediaClient, type MediaRequest } from './media.js';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg==',
  'base64'
);
const client = () =>
  new MediaClient({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'fixture',
    appUrl: 'https://garden.test',
    apiProtocol: 'openai'
  });
const request: MediaRequest = {
  id: 'output',
  kind: 'image',
  model: 'gpt-image-2',
  prompt: 'A field',
  width: 1024,
  height: 1024,
  seed: 1
};
afterEach(() => vi.unstubAllGlobals());
describe('native media controls and receipts', () => {
  it('delivers a billable receipt before rejecting invalid provider output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [{ b64_json: Buffer.from('<html>invalid</html>').toString('base64') }],
          usage: { cost: 0.04 }
        })
      )
    );
    const onUsage = vi.fn(async () => undefined);
    await expect(client().generate({ ...request, onUsage })).rejects.toThrow('declared format');
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      costUsd: 0.04,
      costFromProvider: true,
      costKnown: true
    });
  });
  it('validates current image geometry before reserving or calling the provider', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onBeforeSubmit = vi.fn();
    await expect(
      client().generate({ ...request, width: 4096, height: 4096, onBeforeSubmit })
    ).rejects.toThrow('pixel area');
    expect(fetch).not.toHaveBeenCalled();
    expect(onBeforeSubmit).not.toHaveBeenCalled();
    await expect(
      client().generate({
        ...request,
        outputFormat: 'jpeg',
        background: 'transparent',
        onBeforeSubmit
      })
    ).rejects.toThrow('PNG or WebP');
    expect(onBeforeSubmit).not.toHaveBeenCalled();
  });
  it('sends a prepared mask and image references to the native edit endpoint', async () => {
    const mask = PngImage.sync.write(new PngImage({ width: 1, height: 1, fill: true }));
    const fetch = vi.fn(async () =>
      Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
    );
    vi.stubGlobal('fetch', fetch);
    await client().generate({
      ...request,
      inputReferences: [`data:image/png;base64,${PNG.toString('base64')}`],
      mask: `data:image/png;base64,${mask.toString('base64')}`
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('mask')).toBeInstanceOf(Blob);
    expect((init.body as FormData).getAll('image[]')).toHaveLength(1);
    expect((init.body as FormData).has('input_fidelity')).toBe(false);
  });
  it.each([
    ['mp3', 'audio/mpeg', Buffer.from('ID3speech')],
    ['wav', 'audio/x-wav', Buffer.from('RIFF0000WAVEdata')],
    ['flac', 'audio/flac', Buffer.from('fLaCdata')],
    ['opus', 'audio/ogg', Buffer.from('OggS0000OpusHead0000')],
    ['aac', 'audio/aac', Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0xff])],
    ['pcm', 'application/octet-stream', Buffer.from([0x10, 0, 0x20, 0])]
  ] as const)(
    'serves validated %s speech with native instructions',
    async (outputFormat, mime, bytes) => {
      const fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-type': mime } }));
      vi.stubGlobal('fetch', fetch);
      const result = await client().generate({
        ...request,
        kind: 'audio',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        instructions: 'Speak calmly',
        outputFormat
      });
      expect(result.outputs).toHaveLength(1);
      expect(result.outputs[0]?.filename).toBe(`output.${outputFormat}`);
      expect(result.costKnown).toBe(false);
      const requestBody = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body;
      expect(JSON.parse(typeof requestBody === 'string' ? requestBody : '')).toMatchObject({
        instructions: 'Speak calmly',
        response_format: outputFormat
      });
    }
  );
});
