// Copied across the client bundle boundary; scripts/check-repository.mjs holds these to their owners.
export const MAX_SPEND_CAP_USD = 1_000_000;
export const MAX_TASK_SPEND_USD = 10_000;
export const MAX_PRICE_CEILING_USD_PER_MILLION = 100;
const GIB = 1024 ** 3;
export const hostStorageFloorBytes = (hostStorageTotalBytes: number): number =>
  Math.min(20 * GIB, Math.max(2 * GIB, hostStorageTotalBytes * 0.02));
