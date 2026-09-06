import { z } from 'zod';

export const ReasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ReasoningOptions = z.object({
  supportedEfforts: z.array(ReasoningEffort).nullable().optional(),
  defaultEffort: ReasoningEffort.optional(),
  defaultEnabled: z.boolean().optional(),
  mandatory: z.boolean(),
  supportsMaxTokens: z.boolean().optional()
});
export type ReasoningOptions = z.infer<typeof ReasoningOptions>;

export const TaskReasoningEffort = z.enum(['auto', ...ReasoningEffort.options]);
export type TaskReasoningEffort = z.infer<typeof TaskReasoningEffort>;
