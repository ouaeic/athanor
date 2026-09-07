import { afterEach, expect, it, vi } from 'vitest';
import { imageCapabilities, resolveImageDimensions } from './image-dimensions.js';
import { MediaClient } from './media.js';
import { describeOpenRouterImageModel, refreshOpenRouterMediaCatalog } from './media-catalog.js';

const model = 'bytedance-seed/seedream-4.5';
const parameters = {
  resolution: { type: 'enum' as const, values: ['1K', '2K', '4K'] },
  n: { type: 'range' as const, min: 1, max: 10 }
};
const capabilities = { parameters, supportsStreaming: false };
const options = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'offline' };
afterEach(() => vi.unstubAllGlobals());

it('intersects discovery and selected endpoint metadata with documented model geometry', async () => {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const path = url instanceof Request ? url.url : String(url);
    return path.endsWith('/images/models')
      ? Response.json({
          data: [
            {
              id: model,
              architecture: { output_modalities: ['image'] },
              supported_parameters: parameters
            }
          ]
        })
      : path.endsWith('/endpoints')
        ? Response.json({
            endpoints: [{ provider_tag: 'seed', supported_parameters: parameters }]
          })
        : Response.json({ data: [] });
  });
  const models = await refreshOpenRouterMediaCatalog({ ...options, fetch });
  const selected = models.find((entry) => entry.providerModelId === model);
  expect(selected).toBeDefined();
  const endpoints = await describeOpenRouterImageModel(selected!, { ...options, fetch });
  expect(endpoints).toHaveLength(1);
  for (const entry of [selected!, endpoints[0]!]) {
    expect(entry.capabilities?.parameters.resolution).toEqual({
      type: 'enum',
      values: ['2K', '4K']
    });
    expect(entry.capabilities?.imageDimensions).toMatchObject({
      defaultWidth: 2048,
      defaultHeight: 2048,
      minPixels: 3_686_400,
      maxPixels: 16_777_216
    });
  }
  expect(imageCapabilities('bytedance-seed/seedream-4', capabilities)).toBe(capabilities);
  expect(
    imageCapabilities(model, {
      ...capabilities,
      parameters: {
        resolution: { type: 'enum', values: ['2K'] }
      }
    }).parameters.resolution
  ).toEqual({ type: 'enum', values: ['2K'] });
});

it('uses valid defaults and admits documented non-square dimensions without inventing another model', () => {
  expect(resolveImageDimensions({ model })).toEqual({ width: 2048, height: 2048 });
  expect(resolveImageDimensions({ model, resolution: '4K' })).toEqual({
    width: 4096,
    height: 4096
  });
  expect(resolveImageDimensions({ model, width: 6240, height: 2656 })).toEqual({
    width: 6240,
    height: 2656
  });
  expect(resolveImageDimensions({ model: 'other/image' })).toEqual({ width: 1024, height: 1024 });
});

it.each([
  { width: 1024, height: 1024 },
  { width: 8192, height: 8192 },
  { width: 8192, height: 480 },
  { width: 2048, height: 2048, resolution: '1K' }
])('refuses invalid geometry before reservation and provider contact: %j', async (geometry) => {
  const fetch = vi.fn(),
    onBeforeSubmit = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    new MediaClient({ ...options, appUrl: 'https://garden.example' }).generate({
      id: 'image',
      kind: 'image',
      model,
      prompt: 'A blue circle',
      seed: 1,
      ...geometry,
      capabilities,
      onBeforeSubmit
    })
  ).rejects.toThrow(/pixels|resolution/);
  expect(onBeforeSubmit).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('omits an unselected format and detects the actual returned image format', async () => {
  const bytes = Buffer.from(
    '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Kf//Z',
    'base64'
  );
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON image request');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model,
      size: '2048x2048',
      provider: { only: ['seed'], allow_fallbacks: false }
    });
    expect(body).not.toHaveProperty('output_format');
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }], usage: { cost: 0.04 } });
  });
  vi.stubGlobal('fetch', fetch);
  const onBeforeSubmit = vi.fn();
  await expect(
    new MediaClient({ ...options, appUrl: 'https://garden.example' }).generate({
      id: 'image',
      kind: 'image',
      model,
      prompt: 'A blue circle',
      seed: 1,
      ...resolveImageDimensions({ model }),
      capabilities,
      providerEndpointTag: 'seed',
      onBeforeSubmit
    })
  ).resolves.toMatchObject({
    costUsd: 0.04,
    outputs: [{ filename: 'image-1.jpeg', mimeType: 'image/jpeg', bytes }]
  });
  expect(onBeforeSubmit).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});
