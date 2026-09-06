import { z } from 'zod';
import { TaskOutputIntents } from './output-intent.js';

export const TaskResult = z.object({
  id: z.string(),
  kind: z.enum(['preview', 'artifact', 'file']),
  title: z.string(),
  status: z.enum(['ready', 'unavailable', 'unknown']),
  url: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  /** POST here on an explicit Open action to obtain a fresh private preview URL. */
  accessPath: z.string().nullable(),
  previewId: z.string().optional(),
  artifactId: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
  detail: z.string().optional(),
  evidenceEventIds: z.array(z.string())
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskMilestone = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['change', 'source', 'check', 'result', 'approval', 'process', 'checkpoint']),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(['observed', 'passed', 'failed', 'waiting']),
  createdAt: z.string()
});
export type TaskMilestone = z.infer<typeof TaskMilestone>;

/** A projection of recorded work. Counts never imply a percentage of the owner's objective. */
export const TaskPresentation = z.object({
  version: z.literal(1),
  taskId: z.string(),
  eventCursor: z.number().int().nonnegative(),
  results: z.array(TaskResult),
  outputs: TaskOutputIntents.optional(),
  delivery: z
    .object({
      status: z.enum(['pending', 'ready', 'incomplete']),
      pendingJobs: z.number().int().nonnegative(),
      failedJobs: z.number().int().nonnegative(),
      completedJobs: z.number().int().nonnegative()
    })
    .optional(),
  sourceBundle: z
    .object({
      downloadUrl: z.string(),
      fileCount: z.number().int().positive().nullable(),
      scope: z.enum(['recorded_files', 'declared_directories']),
      directories: z.array(z.string()).optional()
    })
    .optional(),
  coverage: z
    .object({
      scope: z.enum(['complete', 'recent']),
      eventCount: z.number().int().nonnegative(),
      omittedPayloads: z.number().int().nonnegative(),
      resultLimitReached: z.boolean().optional()
    })
    .optional(),
  progress: z.object({
    kind: z.enum(['general', 'build', 'research', 'analysis', 'design']),
    phases: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped'])
      })
    ),
    current: z.object({ title: z.string(), eventId: z.string(), startedAt: z.string() }).nullable(),
    metrics: z.array(
      z.object({ key: z.string(), label: z.string(), value: z.number().nonnegative() })
    ),
    milestones: z.array(TaskMilestone),
    updatedAt: z.string().nullable()
  })
});
export type TaskPresentation = z.infer<typeof TaskPresentation>;

export { deliveryFilePath } from './delivery-path.js';
