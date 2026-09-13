import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeEventFrame } from './event-stream-write.js';

afterEach(() => vi.useRealTimers());

describe('event-stream backpressure', () => {
  it('waits for a real writable to drain before accepting another frame', async () => {
    const stream = new PassThrough({ highWaterMark: 8 });
    const controller = new AbortController();
    let settled = false;
    const pending = writeEventFrame(stream, 'a long synthetic frame', controller.signal).then(
      (result) => {
        settled = true;
        return result;
      }
    );
    await Promise.resolve();
    expect(stream.writableNeedDrain).toBe(true);
    expect(settled).toBe(false);
    const received: unknown = stream.read();
    if (!Buffer.isBuffer(received)) throw new Error('Expected the buffered synthetic frame');
    expect(received.toString()).toBe('a long synthetic frame');
    expect(await pending).toBe(true);
    expect(stream.listenerCount('drain')).toBe(0);
    stream.destroy();
  });

  it('releases a pending write when the client is evicted', async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    const controller = new AbortController();
    const pending = writeEventFrame(stream, 'synthetic', controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(stream.listenerCount('drain')).toBe(0);
    stream.destroy();
  });

  it('bounds a peer that never drains', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough({ highWaterMark: 1 });
    const pending = writeEventFrame(stream, 'synthetic', new AbortController().signal, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(false);
    expect(stream.listenerCount('drain')).toBe(0);
    stream.destroy();
  });

  it('settles a transport error without an unhandled stream error', async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    const pending = writeEventFrame(stream, 'synthetic', new AbortController().signal);
    stream.destroy(new Error('synthetic disconnect'));
    expect(await pending).toBe(false);
    expect(stream.listenerCount('drain')).toBe(0);
  });
});
