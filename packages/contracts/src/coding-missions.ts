import { z } from 'zod';
import { deliveryFilePath } from './delivery-path.js';

const MissionPath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((path) => deliveryFilePath(path) !== null, 'Use a relative workspace path');
export const CodingMissionState = z.enum([
  'preparing',
  'queued',
  'running',
  'awaiting_approval',
  'paused',
  'ready',
  'failed',
  'cancelled',
  'conflicted',
  'integrating',
  'integrated'
]);
export type CodingMissionState = z.infer<typeof CodingMissionState>;

export const CodingMissionStart = z.object({
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(12_000),
  sourceRoot: MissionPath,
  outputPaths: z.array(MissionPath).min(1).max(20),
  maxComputeCredits: z.number().finite().positive().max(100)
});
export type CodingMissionStart = z.infer<typeof CodingMissionStart>;

export const CodingMission = z.object({
  id: z.uuid(),
  parentTaskId: z.uuid(),
  taskId: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  state: CodingMissionState,
  sourceRoot: z.string(),
  outputPaths: z.array(z.string()),
  allocatedCredits: z.number().nonnegative(),
  usedCredits: z.number().nonnegative(),
  reservedCredits: z.number().nonnegative(),
  spentUsd: z.number().nonnegative().optional(),
  reservedUsd: z.number().nonnegative().optional(),
  pendingApprovals: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative().nullable(),
  conflicts: z.number().int().nonnegative().nullable(),
  generation: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  detail: z.string().nullable()
});
export type CodingMission = z.infer<typeof CodingMission>;

export const CodingMissionChange = z.object({
  path: z.string(),
  kind: z.enum(['added', 'modified', 'deleted']),
  bytes: z.number().int().nonnegative(),
  baseHash: z.string().nullable(),
  resultHash: z.string().nullable(),
  baseExecutable: z.boolean().nullable().optional(),
  resultExecutable: z.boolean().nullable().optional(),
  conflict: z.boolean(),
  permitted: z.boolean(),
  diff: z.string().nullable(),
  binary: z.boolean(),
  diffOmitted: z.boolean()
});
export type CodingMissionChange = z.infer<typeof CodingMissionChange>;
export const CodingMissionReview = z.object({
  mission: CodingMission,
  digest: z.string(),
  changes: z.array(CodingMissionChange),
  canIntegrate: z.boolean(),
  detail: z.string()
});
export type CodingMissionReview = z.infer<typeof CodingMissionReview>;
