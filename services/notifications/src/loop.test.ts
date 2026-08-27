import { describe, expect, it } from 'vitest';
import { createNotifier } from './loop.js';
import type { SweepResult } from './sweep.js';

const result = (overrides: Partial<SweepResult> = {}): SweepResult => ({
  pending: 0,
  delivered: 0,
  failed: 0,
  suppressed: 0,
  retired: 0,
  deferred: 0,
  held: 0,
  idle: true,
  ...overrides
});

describe('the notifier loop', () => {
  it('does not run at all on a box with no Web Push signing keys', async () => {
    /*
     * `deliveryEnabled` is derived once, at startup, from configuration read once, and nothing in
     * the process can change it - so on a box without signing keys there is no sequence of events
     * that ends in a delivery. The loop nonetheless woke every two seconds for the life of the box
     * to re-read that constant: 43,200 timer firings a day, each one keeping a small VPS out of a
     * deep idle state, to reach a `continue`. Zero sweeps and zero timers is the bound; the process
     * still has to stay up, which is what the pending promise below is.
     */
    const timers = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    let sweeps = 0;
    const shutdown = new AbortController();
    const before = timers();
    const notifier = createNotifier({
      sweep: async () => {
        sweeps += 1;
        return result();
      },
      // Long enough that a loop which schedules a wait is certainly inside one when this test
      // looks, so the assertion is about whether a timer exists at all and not about catching it.
      pollMs: 60_000,
      deliveryEnabled: false,
      signal: shutdown.signal
    });
    const running = notifier.run();
    let finished = false;
    void running.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sweeps).toBe(0);
    // The bound. Not "it did no work" - the old loop did no work either - but "it armed nothing":
    // a parked notifier holds an abort listener and no timer, so the box can reach a deep idle.
    expect(timers()).toBe(before);
    // And it is parked, not finished: the health port has to keep answering with the reason.
    expect(finished).toBe(false);
    shutdown.abort();
    await running;
    expect(sweeps).toBe(0);
  });

  it('stops during its poll wait rather than after it', async () => {
    /*
     * The registry hit this first and wrote it down: almost all of a timer service's life is the
     * wait, and a flag set by the signal handler is not read until the wait is over, so every
     * restart - and every update, which restarts each service in turn - waited out
     * `TimeoutStopSec=30` and was then killed. The fix was never carried across to this service.
     * A poll wait of a full minute has to end in the same tick the signal arrives.
     */
    const shutdown = new AbortController();
    const notifier = createNotifier({
      sweep: async () => result({ idle: true }),
      pollMs: 60_000,
      deliveryEnabled: true,
      signal: shutdown.signal
    });
    const started = Date.now();
    const running = notifier.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    shutdown.abort();
    await running;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('accumulates totals but reports waits and holds as levels', async () => {
    // `deferred` widens the next page and `held` is what is standing in front of the owner right
    // now; both are the last pass's answer, not a running total, and the metrics port reports them
    // beside four counters that are. Adding them up made a device that refused all afternoon look
    // like an ever-growing backlog on a queue that was in fact one item.
    const passes = [
      result({ delivered: 2, failed: 1, suppressed: 3, retired: 1, deferred: 5, held: 4 }),
      result({ delivered: 1, failed: 0, suppressed: 1, retired: 0, deferred: 2, held: 1 })
    ];
    const shutdown = new AbortController();
    const seen: number[] = [];
    const notifier = createNotifier({
      sweep: async (deferredLastSweep) => {
        seen.push(deferredLastSweep);
        const next = passes.shift() ?? result();
        if (!passes.length) shutdown.abort();
        return next;
      },
      pollMs: 0,
      deliveryEnabled: true,
      signal: shutdown.signal
    });
    await notifier.run();
    expect(notifier.totals).toMatchObject({
      delivered: 3,
      failed: 1,
      suppressed: 4,
      retired: 1,
      deferred: 2,
      held: 1
    });
    // The previous pass's waits are what the next pass is told about, so it can reach past them.
    expect(seen).toEqual([0, 5]);
  });
});
