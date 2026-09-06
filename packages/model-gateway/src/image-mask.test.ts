import { crc32, deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateImageMask } from './image-mask.js';
import { MediaClient } from './media.js';

function png(width = 2, height = 1, alpha = 0, colorType: 2 | 6 = 6): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(255);
  image.data[3] = alpha;
  return PNG.sync.write(image, { colorType });
}
function chunk(kind: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(body.length + 12);
  bytes.writeUInt32BE(body.length);
  bytes.write(kind, 4, 'ascii');
  body.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function interlaced(extra = 0): Buffer {
  const header = png(1, 1).subarray(16, 29);
  header[12] = 1;
  return Buffer.concat([
    png().subarray(0, 8),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5 + extra))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
const data = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local image edit preflight', () => {
  it('accepts matching masks with editable pixels including interlaced PNG', () => {
    expect(() => validateImageMask(png(), png())).not.toThrow();
    expect(() => validateImageMask(interlaced(), png(1, 1))).not.toThrow();
  });
  it.each([
    ['dimension mismatch', () => png(1, 1), /first reference image dimensions/],
    ['no alpha channel', () => png(2, 1, 0, 2), /alpha channel/],
    ['opaque alpha', () => png(2, 1, 255), /fully transparent area/],
    ['only partial alpha', () => png(2, 1, 128), /fully transparent area/],
    [
      'corrupted checksum',
      () => {
        const bytes = png();
        bytes[bytes.length - 1]! ^= 1;
        return bytes;
      },
      /checksums/
    ],
    ['truncated pixels', () => png().subarray(0, 40), /checksums/],
    [
      'oversized mask',
      () => Buffer.concat([png(), Buffer.alloc(4 * 1024 * 1024)]),
      /oversized base64/
    ]
  ] as const)('rejects %s before reservation or provider upload', async (_name, mask, expected) => {
    const fetch = vi.fn(),
      onBeforeSubmit = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const client = new MediaClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'fixture',
      appUrl: 'https://garden.test',
      apiProtocol: 'openai'
    });
    await expect(
      client.generate({
        id: 'mask-test',
        kind: 'image',
        model: 'gpt-image-2',
        prompt: 'Edit the selected area',
        width: 1024,
        height: 1024,
        seed: 1,
        inputReferences: [data(png())],
        mask: data(mask()),
        onBeforeSubmit
      })
    ).rejects.toThrow(expected);
    expect(onBeforeSubmit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves sixteen-bit alpha precision when deciding which pixels are editable', () => {
    const image = new PNG({ width: 2, height: 1 });
    image.data = Buffer.alloc(16, 255);
    image.data.writeUInt16LE(1, 6);
    expect(() => validateImageMask(PNG.sync.write(image, { bitDepth: 16 }), png())).toThrow(
      'fully transparent area'
    );
    image.data.writeUInt16LE(0, 6);
    expect(() => validateImageMask(PNG.sync.write(image, { bitDepth: 16 }), png())).not.toThrow();
  });
  it('bounds interlaced inflation before invoking the pixel decoder', () => {
    const decoder = vi.spyOn(PNG.sync, 'read');
    expect(() => validateImageMask(interlaced(100_000), png(1, 1))).toThrow('valid pixels');
    expect(decoder).not.toHaveBeenCalled();
  });
  it('bounds declared pixel allocation before invoking the decoder', () => {
    const image = png();
    image.writeUInt32BE(5000, 16);
    image.writeUInt32BE(5000, 20);
    image.writeUInt32BE(crc32(image.subarray(12, 29)), 29);
    const decoder = vi.spyOn(PNG.sync, 'read');
    expect(() => validateImageMask(image, image)).toThrow('decoded pixel limit');
    expect(decoder).not.toHaveBeenCalled();
  });
});
