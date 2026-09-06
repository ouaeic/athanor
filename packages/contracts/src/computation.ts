import { z } from 'zod';

export const ComputationRequest = z
  .object({
    action: z.enum([
      'start',
      'list',
      'status',
      'cell',
      'interrupt',
      'stop',
      'checkpoint',
      'restore'
    ]),
    sessionId: z.string().max(120).optional(),
    language: z.enum(['python', 'javascript']).optional(),
    name: z.string().min(1).max(120).optional(),
    cwd: z.string().max(4096).default('workspace'),
    lifetimeSeconds: z.number().int().positive().optional(),
    cellId: z.string().min(1).max(120).optional(),
    code: z.string().max(100_000).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    variables: z.array(z.string().min(1).max(200)).max(100).optional(),
    path: z.string().max(4096).optional()
  })
  .strict();
export type ComputationRequest = z.infer<typeof ComputationRequest>;

export const ComputationState = z.enum([
  'starting',
  'idle',
  'busy',
  'interrupted',
  'stopped',
  'expired',
  'lost'
]);
export type ComputationState = z.infer<typeof ComputationState>;

export const ComputationCellSchema = z
  .object({
    cellId: z.string().min(1).max(120),
    state: z.enum(['running', 'completed', 'failed', 'interrupted']),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    stdout: z.string().max(40_000),
    stderr: z.string().max(40_000),
    result: z.unknown().optional(),
    error: z.string().max(8000).optional(),
    artifacts: z
      .array(
        z.object({
          path: z.string().max(4096),
          mimeType: z.string().max(100),
          bytes: z.number().int().nonnegative()
        })
      )
      .max(4)
  })
  .strict();
export type ComputationCell = z.infer<typeof ComputationCellSchema>;
export const ComputationSessionSchema = z
  .object({
    sessionId: z.string().regex(/^kernel-[a-f0-9-]{36}$/),
    taskId: z.string().max(256),
    workspaceId: z.string().uuid(),
    name: z.string().max(120),
    language: z.enum(['python', 'javascript']),
    cwd: z.string().max(4096),
    state: ComputationState,
    createdAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    stateRetained: z.boolean(),
    variables: z
      .array(
        z.object({
          name: z.string().max(200),
          type: z.string().max(200),
          preview: z.string().max(300).optional()
        })
      )
      .max(100),
    latestCell: ComputationCellSchema.optional(),
    note: z.string().max(8000).optional()
  })
  .strict();
export type ComputationSession = z.infer<typeof ComputationSessionSchema>;
