/**
 * Rate limiting and connection accounting primitives.
 *
 * All of these are deliberately allocation-light and O(1): they run on the accept path, which is
 * exactly where an abusive client wants to make the relay do work.
 */

/**
 * A token bucket measured in bytes (or in discrete events, where one event costs one token).
 * A rate of `Infinity` means unlimited and short-circuits to zero wait.
 */
export class TokenBucket {
  private tokens: number;
  private ratePerSecond: number;
  private burst: number;
  private updatedAt: number;

  constructor(ratePerSecond: number, burst: number, now: number = Date.now()) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
    this.updatedAt = now;
  }

  get rate(): number {
    return this.ratePerSecond;
  }

  setRate(ratePerSecond: number, burst: number, now: number = Date.now()): void {
    this.refill(now);
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    if (this.tokens > burst) this.tokens = burst;
  }

  private refill(now: number): void {
    if (!Number.isFinite(this.ratePerSecond)) {
      this.tokens = this.burst;
      this.updatedAt = now;
      return;
    }
    const elapsed = Math.max(0, now - this.updatedAt);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSecond) / 1000);
    this.updatedAt = now;
  }

  /**
   * Consumes `amount` unconditionally and returns how long the caller must wait before the
   * consumption is "paid for". Going into deficit is intentional: the caller has already received
   * the bytes, and delaying the downstream write is what actually applies backpressure.
   */
  consume(amount: number, now: number = Date.now()): number {
    if (!Number.isFinite(this.ratePerSecond)) return 0;
    this.refill(now);
    this.tokens -= amount;
    if (this.tokens >= 0) return 0;
    return Math.ceil((-this.tokens / this.ratePerSecond) * 1000);
  }

  /** True once the bucket has refilled completely, i.e. the source has gone quiet. */
  isFull(now: number = Date.now()): boolean {
    if (!Number.isFinite(this.ratePerSecond)) return true;
    this.refill(now);
    return this.tokens >= this.burst;
  }

  /** Consumes only if affordable. For discrete events where refusal is the right answer. */
  tryConsume(amount: number, now: number = Date.now()): boolean {
    if (!Number.isFinite(this.ratePerSecond)) return true;
    this.refill(now);
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }
}

/**
 * Normalises a remote address into a rate-limiting key: /32 for IPv4, /64 for IPv6.
 *
 * /64 matters because a single IPv6 customer routinely holds a /64 (or larger) and limiting per
 * /128 would let one host rotate through billions of addresses for free.
 */
export const sourceKey = (address: string): string => {
  const value = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return mapped[1] ?? value;
  if (!value.includes(':')) return value;
  const withoutZone = value.split('%')[0] ?? value;
  const groups = expandIpv6(withoutZone);
  return groups === null ? withoutZone : `${groups.slice(0, 4).join(':')}::/64`;
};

const expandIpv6 = (address: string): string[] | null => {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '').split(':').filter((part) => part.length > 0);
  const tail = halves.length === 2 ? (halves[1] ?? '').split(':').filter((p) => p.length > 0) : [];
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<string>(missing).fill('0'), ...tail];
};

/**
 * Per-source-IP connection rate limiter with a hard bound on its own memory.
 *
 * When the table is full the oldest entry is evicted rather than new sources being refused: an
 * attacker who could fill the table would otherwise be able to lock every legitimate user out,
 * which turns the defence into the attack.
 */
export class SourceRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly perMinute: number;
  private readonly burst: number;
  private readonly maxEntries: number;

  constructor(perMinute: number, burst: number, maxEntries: number) {
    this.perMinute = perMinute;
    this.burst = burst;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.buckets.size;
  }

  allow(address: string, now: number = Date.now()): boolean {
    const key = sourceKey(address);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxEntries) this.evictOldest();
      bucket = new TokenBucket(this.perMinute / 60, this.burst, now);
    } else {
      // Re-insert so Map iteration order is least-recently-used first.
      this.buckets.delete(key);
    }
    this.buckets.set(key, bucket);
    return bucket.tryConsume(1, now);
  }

  private evictOldest(): void {
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }

  /** Drops entries that have fully refilled, i.e. sources that have gone quiet. */
  sweep(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) this.buckets.delete(key);
    }
  }
}

/** A counter with a hard ceiling, used for half-open connections and enrolling sessions. */
export class Semaphore {
  private value = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get count(): number {
    return this.value;
  }

  tryAcquire(): boolean {
    if (this.value >= this.limit) return false;
    this.value += 1;
    return true;
  }

  release(): void {
    if (this.value > 0) this.value -= 1;
  }
}
