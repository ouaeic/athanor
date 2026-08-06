/**
 * The worker's lease-and-run loops.
 *
 * Kept out of the entry point so the concurrency behaviour is exercisable: the entry point owns
 * process wiring, this owns the rule that one slow task must not hold the queue.
 */

/** Live gauges the health endpoint reports. Mutated in place so /metrics never lags reality. */
export interface WorkerCounters {
  active: number;
  completed: number;
  failed: number;
  /**
   * Leases that threw rather than returning a task. A failing lease is indistinguishable from an
   * empty queue at this level - both mean "no work" - so without a count the worker reports itself
   * healthy forever while accepting nothing, and the release gate that reads these numbers clears
   * on a process that has done nothing for hours.
   */
  leaseErrors: number;
}

export interface LeaseLoopInput<T> {
  /** How many tasks may be in flight at once. */
  concurrency: number;
  pollMs: number;
  counters: WorkerCounters;
  running: () => boolean;
  lease: () => Promise<T | null>;
  run: (task: T) => Promise<void>;
  fail: (task: T, error: unknown) => Promise<void>;
  idle: (milliseconds: number) => Promise<void>;
  /**
   * Called when leasing itself failed, and again when it next succeeds. Reported rather than
   * logged here so this file keeps no dependency on a logger and stays directly testable.
   */
  onLeaseHealth?: (healthy: boolean, error?: unknown) => void;
}

/**
 * Runs `concurrency` lease-and-run loops side by side until `running()` turns false.
 *
 * Running more than one is safe because the lease is claimed with `FOR UPDATE SKIP LOCKED` and
 * renewed for as long as a step is in flight, so two loops can never hold the same task; and
 * nothing in the agent is shared between the tasks in a process. It matters because almost all of
 * a step is spent waiting on the model provider or the workspace runner: with a single slot, one
 * long build or one stalled provider blocks every scheduled run and every follow-up message behind
 * it, for as long as an hour, with nothing to distinguish a blocked queue from a slow task.
 */
export const runLeaseLoops = async <T>(input: LeaseLoopInput<T>): Promise<void> => {
  const loop = async (slot: number): Promise<void> => {
    // Stagger the polls so an idle queue is not woken by every slot in the same millisecond.
    if (slot > 0) await input.idle(Math.round((slot * input.pollMs) / input.concurrency));
    while (input.running()) {
      let leaseError: unknown;
      const task = await input.lease().catch((error: unknown) => {
        leaseError = error;
        return null;
      });
      if (leaseError !== undefined) {
        // Counted before it is reported, so a reporter that throws cannot hide the count.
        input.counters.leaseErrors += 1;
        input.onLeaseHealth?.(false, leaseError);
      } else if (input.counters.leaseErrors > 0) {
        input.onLeaseHealth?.(true);
      }
      if (!task) {
        await input.idle(input.pollMs);
        continue;
      }
      input.counters.active += 1;
      try {
        await input.run(task);
        input.counters.completed += 1;
      } catch (error) {
        input.counters.failed += 1;
        // Recording the failure needs the store, which is exactly what may have just become
        // unreachable. Letting that reject would end the process and take every other task running
        // in it down as well; the lease simply expires and the task is leased again.
        await input.fail(task, error).catch(() => undefined);
      } finally {
        input.counters.active -= 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, input.concurrency) }, (_slot, index) => loop(index))
  );
};
