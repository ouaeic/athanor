import { Transform, type TransformCallback } from 'node:stream';
import type { TokenBucket } from './limits.js';

/** Matches the 32 KiB copy buffers the design budgets per active stream. */
export const COPY_BUFFER_BYTES = 32 * 1024;

export interface ThrottleOptions {
  readonly bucket: TokenBucket;
  readonly onBytes: (bytes: number) => void;
}

/**
 * Rate limits one direction of a relayed connection and meters it for quota accounting.
 *
 * Delaying the callback rather than dropping data is what makes this safe for memory: a Transform
 * that has not called back stops pulling from its source, so TCP backpressure propagates to the
 * client and HTTP/2 flow control (WINDOW_UPDATE) propagates to the box. Nothing accumulates here
 * beyond one highWaterMark.
 */
export class Throttle extends Transform {
  private readonly bucket: TokenBucket;
  private readonly onBytes: (bytes: number) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ThrottleOptions) {
    super({ highWaterMark: COPY_BUFFER_BYTES, allowHalfOpen: false });
    this.bucket = options.bucket;
    this.onBytes = options.onBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.onBytes(chunk.length);
    const waitMs = this.bucket.consume(chunk.length);
    if (waitMs <= 0) {
      callback(null, chunk);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      callback(null, chunk);
    }, waitMs);
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    callback(error);
  }
}
