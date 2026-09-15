import { z } from 'zod';

export const Project = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentWorkspaceId: z.uuid(),
  title: z.string(),
  brief: z.string(),
  securityMode: z.enum(['review', 'balanced', 'autonomous']),
  revision: z.number().int().positive(),
  pinned: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  conversationCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
  spentUsd: z.number().nonnegative(),
  latestTaskId: z.uuid().nullable()
});
export type Project = z.infer<typeof Project>;

export const UpdateProjectRequest = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(160).optional(),
  brief: z.string().max(20_000).optional(),
  securityMode: z.enum(['review', 'balanced', 'autonomous']).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional()
});

export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const ConversationSource = z.object({
  taskId: z.uuid(),
  result: z
    .object({
      id: z.string().min(1).max(1024),
      kind: z.enum(['preview', 'artifact', 'file']),
      title: z.string().max(1000),
      version: z.number().int().positive().optional(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
      workspaceId: z.uuid().optional(),
      artifactId: z.uuid().optional(),
      previewId: z.uuid().optional()
    })
    .optional(),
  eventId: z.uuid().optional(),
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        path.startsWith('workspace/') &&
        !path.split('/').includes('..') &&
        !path.includes('\\') &&
        !path.includes('\0'),
      'Choose a project file'
    )
    .optional()
});
export type ConversationSource = z.infer<typeof ConversationSource>;

export const ProjectNote = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: z.enum(['finding', 'decision', 'question']),
  body: z.string(),
  source: ConversationSource.nullable(),
  replacesId: z.uuid().nullable(),
  supersededBy: z.uuid().nullable(),
  createdAt: z.string()
});
export type ProjectNote = z.infer<typeof ProjectNote>;
export const CreateProjectNoteRequest = z.object({
  kind: z.enum(['finding', 'decision', 'question']).default('finding'),
  body: z.string().trim().min(1).max(8000),
  source: ConversationSource.optional(),
  replacesId: z.uuid().optional()
});
export type CreateProjectNoteRequest = z.infer<typeof CreateProjectNoteRequest>;
