import { z } from 'zod';
import { deliveryFilePath } from './delivery-path.js';

const OutputPath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => deliveryFilePath(value) !== null, 'Use a relative workspace path');

/** Declared output shape guides presentation and delivery, never execution authority. */
export const TaskOutputIntent = z
  .object({
    kind: z.enum(['app', 'document', 'dataset', 'media', 'answer']),
    title: z.string().trim().min(1).max(120),
    files: z.array(OutputPath).max(50).optional(),
    directories: z.array(OutputPath).max(4).optional(),
    delivery: z.enum(['preview', 'package']).optional(),
    run: z
      .object({
        command: z.string().trim().min(1).max(2_000),
        acceptanceCheckId: z.string().trim().min(1).max(80)
      })
      .optional()
  })
  .superRefine((output, context) => {
    if (output.kind !== 'app' && (output.delivery || output.run))
      context.addIssue({
        code: 'custom',
        message: 'Only app outputs declare preview or package delivery'
      });
    if (output.kind === 'answer' && (output.files?.length || output.directories?.length))
      context.addIssue({
        code: 'custom',
        message: 'An inline answer does not declare file outputs'
      });
  });
export type TaskOutputIntent = z.infer<typeof TaskOutputIntent>;
export const TaskOutputIntents = z
  .array(TaskOutputIntent)
  .max(8)
  .superRefine((outputs, context) => {
    if (
      outputs.reduce((sum, output) => sum + (output.files?.length ?? 0), 0) > 50 ||
      outputs.reduce((sum, output) => sum + (output.directories?.length ?? 0), 0) > 4
    )
      context.addIssue({
        code: 'custom',
        message: 'A task output manifest may declare at most 50 files and 4 project directories'
      });
  });
