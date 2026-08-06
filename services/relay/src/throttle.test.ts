import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TokenBucket } from './limits.js';
import { COPY_BUFFER_BYTES, Throttle } from './throttle.js';

const source = (chunks: number, size: number): Readable => {
  let remaining = chunks;
  return new Readable({
    read(): void {
      this.push(remaining-- > 0 ? Buffer.alloc(size, 1) : null);
    }
  });
};

const sink = (): { stream: Writable; total: () => number } => {
  let total = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      total += chunk.length;
      callback();
    }
  });
  return { stream, total: () => total };
};

describe('Throttle', () => {
  it('passes every byte through and meters it exactly once', async () => {
    let metered = 0;
    const bucket = new TokenBucket(Number.POSITIVE_INFINITY, 1);
    const destination = sink();
    await pipeline(
      source(16, 4096),
      new Throttle({ bucket, onBytes: (bytes) => (metered += bytes) }),
      destination.stream
    );
    expect(destination.total()).toBe(16 * 4096);
    expect(metered).toBe(16 * 4096);
  });

  it('holds the transfer to the bucket rate', async () => {
    // 64 KiB of budget, then 64 KiB more at 64 KiB/s: the second half must cost about a second.
    const bucket = new TokenBucket(65536, 65536);
    const destination = sink();
    const started = Date.now();
    await pipeline(
      source(4, 32768),
      new Throttle({ bucket, onBytes: () => undefined }),
      destination.stream
    );
    const elapsed = Date.now() - started;
    expect(destination.total()).toBe(4 * 32768);
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });

  it('buffers no more than one copy buffer, so a slow reader cannot inflate memory', () => {
    const throttle = new Throttle({
      bucket: new TokenBucket(Number.POSITIVE_INFINITY, 1),
      onBytes: () => undefined
    });
    expect(throttle.writableHighWaterMark).toBe(COPY_BUFFER_BYTES);
    expect(throttle.readableHighWaterMark).toBe(COPY_BUFFER_BYTES);
    throttle.destroy();
  });

  it('clears its pending timer when destroyed mid-delay', async () => {
    const throttle = new Throttle({
      bucket: new TokenBucket(1024, 0),
      onBytes: () => undefined
    });
    throttle.write(Buffer.alloc(1024 * 60));
    // Destroying while a chunk is parked must not leave a timer holding the event loop open.
    throttle.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(throttle.destroyed).toBe(true);
  });
});
