import { describe, expect, it } from 'vitest';
import {
  assertHostStorageWrite,
  belowHostStorageFloor,
  hostStorage,
  hostStorageFloorBytes
} from './host-storage.js';

const GIB = 1024 ** 3;

describe('host disk floor', () => {
  it('keeps two per cent of a large disk, bounded at both ends', () => {
    expect(hostStorageFloorBytes(50 * GIB)).toBe(2 * GIB);
    expect(hostStorageFloorBytes(400 * GIB)).toBe(8 * GIB);
    expect(hostStorageFloorBytes(4000 * GIB)).toBe(20 * GIB);
  });

  it('refuses a write that would cross the floor', async () => {
    const probe = async () => ({
      hostStorageTotalBytes: 100 * GIB,
      hostStorageAvailableBytes: 2 * GIB + 1024
    });
    await expect(assertHostStorageWrite('/workspace', 4096, probe)).rejects.toThrow('Host disk');
    await expect(assertHostStorageWrite('/workspace', 0, probe)).resolves.toBeUndefined();
  });

  it('names the amount of headroom it wants so the message is actionable', async () => {
    await expect(
      assertHostStorageWrite('/workspace', 0, async () => ({
        hostStorageTotalBytes: 400 * GIB,
        hostStorageAvailableBytes: GIB
      }))
    ).rejects.toThrow('at least 8 GiB free');
  });

  it('treats a nearly full disk as below the floor with no pending write', () => {
    expect(
      belowHostStorageFloor({
        hostStorageTotalBytes: 100 * GIB,
        hostStorageAvailableBytes: 128 * 1024 ** 2
      })
    ).toBe(true);
    expect(
      belowHostStorageFloor({
        hostStorageTotalBytes: 100 * GIB,
        hostStorageAvailableBytes: 40 * GIB
      })
    ).toBe(false);
  });

  it('reads a real filesystem', async () => {
    const storage = await hostStorage(process.cwd());
    expect(storage.hostStorageTotalBytes).toBeGreaterThan(0);
    expect(storage.hostStorageAvailableBytes).toBeGreaterThanOrEqual(0);
  });
});
