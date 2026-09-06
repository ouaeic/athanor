import { z } from 'zod';

export const MediaParameter = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enum'), values: z.array(z.string().max(128)).min(1).max(128) }),
  z
    .object({
      type: z.literal('range'),
      min: z.number().nonnegative(),
      max: z.number().nonnegative()
    })
    .refine((value) => value.max >= value.min),
  z.object({ type: z.literal('boolean') })
]);
export type MediaParameter = z.infer<typeof MediaParameter>;
export const MediaCapabilities = z.object({
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), MediaParameter),
  supportsStreaming: z.boolean()
});
export type MediaCapabilities = z.infer<typeof MediaCapabilities>;
export const MediaPriceLine = z.object({
  billable: z.string().regex(/^[a-z_]{1,64}$/),
  unit: z.enum(['image', 'megapixel', 'token', 'character', 'second', 'minute']),
  costUsd: z.number().nonnegative().max(1_000_000),
  variant: z.string().max(64).optional()
});
export type MediaPriceLine = z.infer<typeof MediaPriceLine>;

export const MediaJobStatus = z.enum([
  'queued',
  'submitting',
  'submission_uncertain',
  'pending',
  'in_progress',
  'delivering',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'delivery_failed'
]);
export type MediaJobStatus = z.infer<typeof MediaJobStatus>;
export const MediaJob = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  modality: z.literal('video'),
  operation: z.enum(['generate', 'edit', 'extend']).default('generate'),
  sourceJobId: z.string().uuid().nullable().default(null),
  batchId: z.string().uuid().nullable().default(null),
  durationSeconds: z.number().int().min(1).max(120).nullable().default(null),
  extensionCount: z.number().int().min(0).max(6).default(0),
  status: MediaJobStatus,
  modelId: z.string(),
  progress: z.number().min(0).max(100).nullable(),
  watching: z.boolean(),
  reservationUsd: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(['provider', 'quote', 'unresolved']),
  outputPath: z.string().nullable(),
  artifactId: z.string().uuid().nullable(),
  retentionApprovedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().nullable(),
  cancellationSupported: z.literal(false)
});
export type MediaJob = z.infer<typeof MediaJob>;

export const MediaCharacterAsset = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(200),
  providerAssetId: z.string().nullable(),
  status: z.enum(['submitting', 'completed', 'submission_uncertain', 'failed']),
  reservationUsd: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MediaCharacterAsset = z.infer<typeof MediaCharacterAsset>;
export const MediaBatch = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  status: z.enum([
    'queued',
    'uploading',
    'file_uploaded',
    'submitting',
    'submission_uncertain',
    'pending',
    'delivering',
    'completed',
    'failed',
    'cancelled'
  ]),
  total: z.number().int().min(1).max(100),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reservationUsd: z.number().nonnegative(),
  watching: z.boolean(),
  cancelRequested: z.boolean(),
  providerStatus: z.string().nullable(),
  reconciliation: z.enum(['input_file', 'batch']).nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  cancellationSupported: z.literal(true)
});
export type MediaBatch = z.infer<typeof MediaBatch>;
