export const PENDING_MEDIA_DELIVERY = new Set([
  'queued',
  'submitting',
  'pending',
  'in_progress',
  'delivering'
]);

/** The latest attempt for an output path determines its delivery state. */
export const mediaDeliveryState = <T extends { status: string; outputPath: string | null }>(
  jobs: readonly T[]
) => {
  const latest = new Map<string, T>();
  jobs.forEach((job, index) => {
    const key = deliveryFilePath(job.outputPath) ?? job.outputPath ?? `unknown:${index}`;
    if (!latest.has(key)) latest.set(key, job);
  });
  const pending = [...latest.values()].filter((job) => PENDING_MEDIA_DELIVERY.has(job.status));
  const failed = [...latest.values()].filter(
    (job) => !PENDING_MEDIA_DELIVERY.has(job.status) && job.status !== 'completed'
  );
  const completedJobs = [...latest.values()].filter((job) => job.status === 'completed').length;
  return {
    pending,
    failed,
    summary: {
      status: failed.length
        ? ('incomplete' as const)
        : pending.length
          ? ('pending' as const)
          : ('ready' as const),
      pendingJobs: pending.length,
      failedJobs: failed.length,
      completedJobs
    }
  };
};
import { deliveryFilePath } from './delivery-path.js';
