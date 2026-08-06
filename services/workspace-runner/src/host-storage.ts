import { statfs } from 'node:fs/promises';

export interface HostStorage {
  hostStorageTotalBytes: number;
  hostStorageAvailableBytes: number;
}

const GIB = 1024 ** 3;

export const hostStorage = async (root: string): Promise<HostStorage> => {
  const details = await statfs(root);
  const bounded = (blocks: number): number =>
    Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, blocks * details.bsize));
  return {
    hostStorageTotalBytes: bounded(details.blocks),
    hostStorageAvailableBytes: bounded(details.bavail)
  };
};

/**
 * The floor is what the rest of the box needs to keep working. This is a single-machine product:
 * PostgreSQL's data directory, the journal and the workspace share one filesystem, so an agent
 * that fills the disk does not degrade itself, it stops the database and takes the interface with
 * it. Two per cent of a large disk, never less than 2 GiB and never more than 20.
 */
export const hostStorageFloorBytes = (hostStorageTotalBytes: number): number =>
  Math.min(20 * GIB, Math.max(2 * GIB, hostStorageTotalBytes * 0.02));

export const hostStorageFloorMessage = (floorBytes: number): string =>
  `Host disk is too full for this write. Keep at least ${Math.ceil(floorBytes / GIB)} GiB free for the operating system.`;

export const belowHostStorageFloor = (storage: HostStorage, additionalBytes = 0): boolean =>
  storage.hostStorageAvailableBytes - Math.max(0, additionalBytes) <
  hostStorageFloorBytes(storage.hostStorageTotalBytes);

export const assertHostStorageWrite = async (
  root: string,
  additionalBytes = 0,
  probe: (path: string) => Promise<HostStorage> = hostStorage
): Promise<void> => {
  const storage = await probe(root);
  if (belowHostStorageFloor(storage, additionalBytes)) {
    throw new Error(hostStorageFloorMessage(hostStorageFloorBytes(storage.hostStorageTotalBytes)));
  }
};
