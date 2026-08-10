import { describe, expect, it, vi } from 'vitest';
import { createUndoQueue, type PendingUndo } from './undo-queue.js';

const controllableTimers = () => {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void) => {
      const handle = next;
      next += 1;
      timers.set(handle, run);
      return handle;
    },
    clearTimer: (handle: number) => {
      timers.delete(handle);
    },
    run: (handle: number) => {
      const run = timers.get(handle);
      timers.delete(handle);
      run?.();
    },
    size: () => timers.size
  };
};

const harness = () => {
  const timers = controllableTimers();
  let pending: PendingUndo[] = [];
  let ids = 0;
  const errors: unknown[] = [];
  const queue = createUndoQueue({
    onChange: (next) => {
      pending = next;
    },
    onError: (cause) => errors.push(cause),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    createId: () => `undo-${(ids += 1)}`
  });
  return { queue, timers, errors, pending: () => pending };
};

describe('createUndoQueue', () => {
  it('does not touch the server until the undo window closes', async () => {
    const { queue, timers, pending } = harness();
    const commit = vi.fn(async () => undefined);
    queue.push({ message: 'Conversation deleted', commit });

    expect(commit).not.toHaveBeenCalled();
    expect(pending()).toEqual([{ id: 'undo-1', message: 'Conversation deleted' }]);

    timers.run(1);
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
  });

  it('undo cancels the request entirely and restores the row', () => {
    const { queue, timers, pending } = harness();
    const commit = vi.fn(async () => undefined);
    const restore = vi.fn();
    const id = queue.push({ message: 'Skill deleted', commit, restore });

    queue.undo(id);
    expect(commit).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  it('undoing one entry leaves the others pending', () => {
    const { queue, pending } = harness();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const id = queue.push({ message: 'First', commit: first });
    queue.push({ message: 'Second', commit: second });

    queue.undo(id);
    expect(pending()).toEqual([{ id: 'undo-2', message: 'Second' }]);
  });

  it('commits everything still waiting when the surface goes away', async () => {
    const { queue, timers, pending } = harness();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    queue.push({ message: 'First', commit: first });
    queue.push({ message: 'Second', commit: second });

    queue.commitAll();
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
    expect(timers.size()).toBe(0);
  });

  it('reports a failed commit instead of swallowing it', async () => {
    const { queue, timers, errors } = harness();
    queue.push({
      message: 'Token revoked',
      commit: async () => {
        throw new Error('offline');
      }
    });
    timers.run(1);
    await Promise.resolve();
    await Promise.resolve();
    expect((errors[0] as Error).message).toBe('offline');
  });

  /**
   * The row leaves the interface the moment the undo window opens, on the promise that the call
   * behind it will happen. When it fails that promise is broken - the thing is still on the
   * computer and gone from the screen - and `restore` existed for exactly this and was never run.
   */
  it('puts the row back when the commit fails', async () => {
    const { queue, timers } = harness();
    const restore = vi.fn();
    queue.push({
      message: 'File deleted',
      commit: async () => {
        throw new Error('offline');
      },
      restore
    });
    timers.run(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('ignores an undo for an entry that already committed', async () => {
    const { queue, timers } = harness();
    const commit = vi.fn(async () => undefined);
    const restore = vi.fn();
    const id = queue.push({ message: 'Memory deleted', commit, restore });
    timers.run(1);
    await Promise.resolve();

    queue.undo(id);
    expect(restore).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
