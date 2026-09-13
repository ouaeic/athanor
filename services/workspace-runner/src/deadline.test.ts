import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleDeadline } from './deadline.js';

afterEach(() => vi.useRealTimers());
describe('long job deadlines', () => {
  it('waits across timer segments without expiring early and fires only once', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    scheduleDeadline(Date.now() + 90 * 24 * 3600_000, expired);
    await vi.advanceTimersByTimeAsync(89 * 24 * 3600_000);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(expired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it('cancels a rearmed deadline', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const deadline = scheduleDeadline(Date.now() + 90 * 24 * 3600_000, expired);
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    deadline.cancel();
    await vi.advanceTimersByTimeAsync(100 * 24 * 3600_000);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses dates that cannot be represented before starting a timer', () => {
    expect(() => scheduleDeadline(Infinity, vi.fn())).toThrow('date range');
    expect(() => scheduleDeadline(Number.MAX_VALUE, vi.fn())).toThrow('date range');
  });
});
