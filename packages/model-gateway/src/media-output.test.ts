import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
type OutputResponse = Readable & { statusCode: number; headers: Record<string, string> };
type RequestOptions = {
  lookup: (
    hostname: string,
    options: object,
    callback: (error: null, address: string, family: number) => void
  ) => void;
  headers?: Record<string, string>;
};
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request:
    vi.fn<
      (
        url: URL,
        options: RequestOptions,
        callback: (response: OutputResponse) => void
      ) => EventEmitter & { end: () => void }
    >()
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import {
  decodeMediaBase64,
  downloadMedia,
  mediaMimeType,
  readBoundedMediaBody
} from './media-output.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg==',
  'base64'
);
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockReset();
});
const answer = (status: number, headers: Record<string, string>, chunks: Buffer[] = [PNG]) => {
  mocks.request.mockImplementation((_url, _options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() =>
          callback(Object.assign(Readable.from(chunks), { statusCode: status, headers }))
        )
    });
    return req;
  });
};

describe('bounded provider media', () => {
  it('stops a stream without a content length at the byte ceiling and cancels it', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (chunks++ < 3) controller.enqueue(new Uint8Array(8));
        else controller.close();
      },
      cancel
    });
    await expect(readBoundedMediaBody(new Response(body), 12)).rejects.toThrow('download limit');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('checks decoded bytes, MIME and canonical base64 rather than trusting a filename', () => {
    expect(decodeMediaBase64(PNG.toString('base64'))).toEqual(PNG);
    expect(mediaMimeType(PNG, 'image/png', 'image')).toBe('image/png');
    expect(() => mediaMimeType(PNG, 'image/jpeg', 'image')).toThrow('declared format');
    expect(() => decodeMediaBase64('aGVsbG8=!')).toThrow('base64');
    expect(() => decodeMediaBase64(PNG.toString('base64'), 8)).toThrow('base64');
    expect(() => mediaMimeType(Buffer.from('<html>login</html>'), 'image/png', 'image')).toThrow(
      'declared format'
    );
  });
  it.each([
    'https://127.0.0.1/image',
    'https://169.254.169.254/image',
    'http://example.com/image',
    'https://owner:secret@example.com/image'
  ])('refuses unsafe output %s before opening a socket', async (url) => {
    await expect(downloadMedia(url, AbortSignal.timeout(1000))).rejects.toThrow(
      'unsafe download URL'
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects private DNS answers and pins a validated public answer into the socket lookup', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(
      downloadMedia('https://cdn.example/image', AbortSignal.timeout(1000))
    ).rejects.toThrow('private or reserved');
    expect(mocks.request).not.toHaveBeenCalled();
    answer(200, { 'content-type': 'image/png' });
    await expect(
      downloadMedia('https://cdn.example/image', AbortSignal.timeout(1000))
    ).resolves.toEqual({ bytes: PNG, mimeType: 'image/png' });
    const options = mocks.request.mock.calls[0]![1];
    const callback = vi.fn();
    options.lookup('cdn.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(options.headers).toBeUndefined();
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
  it('validates redirect targets before following them', async () => {
    answer(302, { location: 'https://127.0.0.1/private' });
    await expect(
      downloadMedia('https://cdn.example/image', AbortSignal.timeout(1000))
    ).rejects.toThrow('unsafe download URL');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
