import { z } from 'zod';

export const BrowserTabState = z.object({
  tabId: z.string(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  owner: z.enum(['agent', 'user']),
  taskId: z.string().nullable(),
  pinned: z.boolean(),
  lastUsedAt: z.string(),
  protectedReason: z.enum(['active', 'owner', 'pinned', 'download', 'dialog', 'control']).nullable()
});
export type BrowserTabState = z.infer<typeof BrowserTabState>;

export const BrowserTabCleanup = z.object({
  closed: z.number().int().nonnegative(),
  lastClosedAt: z.string().nullable()
});
export type BrowserTabCleanup = z.infer<typeof BrowserTabCleanup>;

export const BrowserTabRetentionRequest = z.object({ pinned: z.boolean() });
export type BrowserTabRetentionRequest = z.infer<typeof BrowserTabRetentionRequest>;
