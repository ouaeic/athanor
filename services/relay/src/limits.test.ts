import { describe, expect, it } from 'vitest';
import { Semaphore, SourceRateLimiter, TokenBucket, sourceKey } from './limits.js';

describe('TokenBucket', () => {
  it('starts full and refills at the configured rate', () => {
    const bucket = new TokenBucket(1000, 1000, 0);
    expect(bucket.consume(1000, 0)).toBe(0);
    // Empty: another 1000 bytes needs a full second of refill.
    expect(bucket.consume(1000, 0)).toBe(1000);
    expect(bucket.tryConsume(1, 0)).toBe(false);
    expect(bucket.tryConsume(1, 3000)).toBe(true);
  });

  it('never lets the burst exceed its ceiling', () => {
    const bucket = new TokenBucket(1000, 1000, 0);
    expect(bucket.consume(1000, 0)).toBe(0);
    expect(bucket.isFull(1_000_000)).toBe(true);
    expect(bucket.consume(2000, 1_000_000)).toBe(1000);
  });

  it('treats an infinite rate as unlimited', () => {
    const bucket = new TokenBucket(Number.POSITIVE_INFINITY, 1, 0);
    expect(bucket.consume(1e9, 0)).toBe(0);
    expect(bucket.tryConsume(1e9, 0)).toBe(true);
  });

  it('applies a new rate without losing accumulated debt', () => {
    const bucket = new TokenBucket(1000, 1000, 0);
    bucket.consume(1000, 0);
    bucket.setRate(100, 100, 0);
    expect(bucket.consume(100, 0)).toBe(1000);
  });
});

describe('sourceKey', () => {
  it('keys IPv4 per address and IPv6 per /64', () => {
    expect(sourceKey('203.0.113.9')).toBe('203.0.113.9');
    expect(sourceKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(sourceKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    // A whole /64 is one customer; limiting per /128 would be free to evade.
    expect(sourceKey('2001:db8:1:2:aaaa::1')).toBe(sourceKey('2001:db8:1:2:bbbb::2'));
    expect(sourceKey('2001:db8:1:3::1')).not.toBe(sourceKey('2001:db8:1:2::1'));
    expect(sourceKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
  });
});

describe('SourceRateLimiter', () => {
  it('allows a burst then refuses until the bucket refills', () => {
    const limiter = new SourceRateLimiter(60, 3, 100);
    expect(limiter.allow('198.51.100.4', 0)).toBe(true);
    expect(limiter.allow('198.51.100.4', 0)).toBe(true);
    expect(limiter.allow('198.51.100.4', 0)).toBe(true);
    expect(limiter.allow('198.51.100.4', 0)).toBe(false);
    // A different source is unaffected.
    expect(limiter.allow('198.51.100.5', 0)).toBe(true);
    expect(limiter.allow('198.51.100.4', 2000)).toBe(true);
  });

  it('bounds its own memory by evicting the least recently used source', () => {
    const limiter = new SourceRateLimiter(60, 1, 4);
    for (let index = 0; index < 50; index += 1) limiter.allow(`10.0.0.${index}`, 0);
    expect(limiter.size).toBeLessThanOrEqual(4);
    // Eviction, not refusal: a fresh source must still be served even under table pressure, or the
    // defence becomes the denial of service.
    expect(limiter.allow('10.9.9.9', 0)).toBe(true);
  });

  it('sweeps sources that have gone quiet', () => {
    const limiter = new SourceRateLimiter(60, 2, 100);
    limiter.allow('192.0.2.1', 0);
    expect(limiter.size).toBe(1);
    limiter.sweep(0);
    expect(limiter.size).toBe(1);
    limiter.sweep(60_000);
    expect(limiter.size).toBe(0);
  });
});

describe('Semaphore', () => {
  it('caps concurrent holders and releases cleanly', () => {
    const semaphore = new Semaphore(2);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(true);
    expect(semaphore.tryAcquire()).toBe(false);
    semaphore.release();
    expect(semaphore.tryAcquire()).toBe(true);
    semaphore.release();
    semaphore.release();
    semaphore.release();
    expect(semaphore.count).toBe(0);
  });
});
