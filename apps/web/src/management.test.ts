import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { stepUp } from './auth.js';
import { numberOrNull, sensitive } from './management.js';

vi.mock('./auth.js', () => ({ stepUp: vi.fn() }));

describe('sensitive settings writes', () => {
  beforeEach(() => vi.mocked(stepUp).mockReset());

  it('retries only after an explicit pre-action step-up refusal', async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('step_up_required', 'Verify', 403))
      .mockResolvedValueOnce({ saved: true });
    vi.mocked(stepUp).mockResolvedValueOnce();
    await expect(sensitive(work)).resolves.toEqual({ saved: true });
    expect(stepUp).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledTimes(2);
    expect(work.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(stepUp).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(stepUp).mock.invocationCallOrder[0]).toBeLessThan(
      work.mock.invocationCallOrder[1]!
    );
  });

  it('does not repeat an uncertain mutation or reinterpret a version conflict as permission', async () => {
    for (const error of [
      new TypeError('Network lost'),
      new ApiError('request_failed', 'Timeout', 504),
      new ApiError('owner_block_conflict', 'Reload saved words', 409)
    ]) {
      const work = vi.fn().mockRejectedValue(error);
      await expect(sensitive(work)).rejects.toBe(error);
      expect(work).toHaveBeenCalledOnce();
    }
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('stops when verification is cancelled and never loops on a second refusal', async () => {
    const refusal = new ApiError('step_up_required', 'Verify', 403);
    const cancelled = new DOMException('Cancelled', 'NotAllowedError');
    const work = vi.fn().mockRejectedValue(refusal);
    vi.mocked(stepUp).mockRejectedValueOnce(cancelled);
    await expect(sensitive(work)).rejects.toBe(cancelled);
    expect(work).toHaveBeenCalledOnce();
    vi.mocked(stepUp).mockResolvedValueOnce();
    await expect(sensitive(work)).rejects.toBe(refusal);
    expect(work).toHaveBeenCalledTimes(3);
    expect(stepUp).toHaveBeenCalledTimes(2);
  });
});

describe('optional money fields', () => {
  it('distinguishes an empty ceiling from an explicit zero', () => {
    expect(numberOrNull('')).toBeNull();
    expect(numberOrNull('  ')).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull('0')).toBe(0);
    expect(numberOrNull('0.01')).toBe(0.01);
  });
  it('refuses invalid numbers before JSON could turn them into an unlimited null ceiling', () => {
    expect(() => numberOrNull('not a number')).toThrow('finite number');
    expect(() => numberOrNull('Infinity')).toThrow('finite number');
  });
});
