import { z } from 'zod';

const Ref = z.number().int().nonnegative();
export const DebuggerRequest = z
  .object({
    action: z.enum([
      'launch',
      'list',
      'status',
      'stop',
      'breakpoints',
      'continue',
      'next',
      'stepIn',
      'stepOut',
      'pause',
      'stack',
      'scopes',
      'variables',
      'evaluate'
    ]),
    sessionId: z
      .string()
      .regex(/^debug-[a-f0-9-]{36}$/)
      .optional(),
    language: z.enum(['python', 'javascript']).optional(),
    program: z.string().min(1).max(4096).optional(),
    cwd: z.string().max(4096).default('workspace'),
    args: z.array(z.string().max(4096)).max(64).default([]),
    lifetimeSeconds: z.number().int().min(30).max(3600).default(600),
    breakpoints: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            condition: z.string().max(4096).optional(),
            logMessage: z.string().max(4096).optional()
          })
          .strict()
      )
      .max(64)
      .optional(),
    path: z.string().min(1).max(4096).optional(),
    epoch: Ref.optional(),
    frameId: Ref.optional(),
    variablesReference: Ref.optional(),
    expression: z.string().min(1).max(4096).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const require = (key: keyof typeof value) => {
      if (value[key] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for ${value.action}`
        });
    };
    if (value.action === 'launch') {
      require('language');
      require('program');
    } else if (value.action !== 'list') require('sessionId');
    if (
      [
        'stack',
        'scopes',
        'variables',
        'evaluate',
        'continue',
        'next',
        'stepIn',
        'stepOut'
      ].includes(value.action)
    )
      require('epoch');
    if (['scopes', 'evaluate'].includes(value.action)) require('frameId');
    if (value.action === 'variables') require('variablesReference');
    if (value.action === 'evaluate') require('expression');
    if (value.action === 'breakpoints') {
      require('path');
      require('breakpoints');
    }
  });
export type DebuggerRequest = z.infer<typeof DebuggerRequest>;

export const DebugSessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  language: z.enum(['python', 'javascript']),
  program: z.string(),
  cwd: z.string(),
  state: z.enum([
    'initializing',
    'configuring',
    'running',
    'stopped',
    'stopping',
    'terminated',
    'lost'
  ]),
  createdAt: z.string(),
  deadlineAt: z.string(),
  updatedAt: z.string(),
  cleanupPending: z.boolean().optional(),
  stopEpoch: Ref,
  reason: z.string().nullable(),
  frames: z.array(
    z.object({
      id: Ref,
      name: z.string(),
      path: z.string(),
      line: Ref,
      column: Ref,
      sourceHash: z.string()
    })
  ),
  variables: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      type: z.string().optional(),
      variablesReference: Ref
    })
  ),
  excludedFrames: Ref,
  output: z.string(),
  note: z.string().nullable()
});
export type DebugSession = z.infer<typeof DebugSessionSchema>;
