import { z } from 'zod';

const label = z.string().trim().min(1).max(240);
const body = z.string().max(2_000);
export const WorkEvidence = z
  .object({
    toolCallId: z.string().min(1).max(240),
    pointer: z
      .string()
      .max(512)
      .refine(
        (value) =>
          (!value || value.startsWith('/')) &&
          ![...value].some((character) => character.charCodeAt(0) < 32) &&
          value.split('/').length <= 17,
        'Use a JSON pointer with at most 16 segments.'
      )
  })
  .strict();
export type WorkEvidence = z.infer<typeof WorkEvidence>;
const evidence = z.array(WorkEvidence).max(8).optional();
const item = z
  .object({
    title: label,
    text: body.optional(),
    label: label.optional(),
    evidence
  })
  .strict();
export const WorkBlock = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('sections'),
      title: label,
      layout: z.enum(['cards', 'timeline']),
      items: z.array(item).min(1).max(24)
    })
    .strict(),
  z
    .object({
      kind: z.literal('table'),
      title: label,
      columns: z.array(label).min(1).max(8),
      rows: z
        .array(
          z
            .object({
              cells: z
                .array(z.union([body, z.number().finite()]))
                .min(1)
                .max(8),
              evidence
            })
            .strict()
        )
        .min(1)
        .max(40)
    })
    .strict(),
  z
    .object({
      kind: z.literal('checklist'),
      title: label,
      items: z
        .array(item.extend({ status: z.enum(['planned', 'active', 'done', 'blocked']) }))
        .min(1)
        .max(30)
    })
    .strict(),
  z
    .object({
      kind: z.literal('chart'),
      title: label,
      unit: label,
      points: z
        .array(z.object({ label, value: WorkEvidence }).strict())
        .min(1)
        .max(40)
    })
    .strict(),
  z
    .object({
      kind: z.literal('result'),
      title: label,
      result: z
        .object({ kind: z.enum(['artifact', 'preview']), id: z.string().min(1).max(240) })
        .strict(),
      text: body.optional()
    })
    .strict()
]);
export type WorkBlock = z.infer<typeof WorkBlock>;
export const WorkSurfaceInput = z
  .object({
    title: label,
    acknowledgment: z.string().trim().min(1).max(600),
    blocks: z.array(WorkBlock).max(8)
  })
  .strict()
  .superRefine((surface, context) => {
    if (new TextEncoder().encode(JSON.stringify(surface)).length > 24_000)
      context.addIssue({
        code: 'custom',
        message: 'Keep the whole presentation within 24 KB; summarize or use fewer blocks.'
      });
    for (const block of surface.blocks)
      if (
        block.kind === 'table' &&
        block.rows.some((row) => row.cells.length !== block.columns.length)
      )
        context.addIssue({
          code: 'custom',
          message: 'Every table row must match its column count.'
        });
  });
export type WorkSurfaceInput = z.infer<typeof WorkSurfaceInput>;
export const WorkSurfaceReport = z
  .object({ directionEventId: z.string(), content: WorkSurfaceInput })
  .strict();
export type WorkSurfaceReport = z.infer<typeof WorkSurfaceReport>;

export const WorkDirection = z.object({
  eventId: z.string(),
  messageId: z.string().max(240).optional(),
  sequence: z.number().int(),
  text: z.string(),
  truncated: z.boolean(),
  queued: z.boolean(),
  acknowledgment: z.string().max(600).optional()
});
export const WorkSurfaceView = z.object({
  direction: WorkDirection.nullable(),
  directions: z.array(WorkDirection),
  report: WorkSurfaceReport.nullable(),
  references: z.array(
    WorkEvidence.extend({
      eventId: z.string(),
      sequence: z.number().int(),
      label: z.string(),
      url: z.string().optional(),
      value: z.union([z.number().finite(), z.string(), z.boolean()]).optional()
    })
  ),
  currentResultIds: z.array(z.string()),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      eventId: z.string(),
      sequence: z.number().int(),
      state: z.enum(['discovered', 'read'])
    })
  ),
  unavailableReferences: z.number().int().nonnegative()
});
export type WorkSurfaceView = z.infer<typeof WorkSurfaceView>;

/** References select a recorded value; they never execute a path or grant authority. */
export function workEvidenceValue(value: unknown, pointer: string): unknown {
  if (!pointer) return value;
  let current = value;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function workSurfaceReferences(surface: WorkSurfaceInput): WorkEvidence[] {
  return surface.blocks.flatMap((block) =>
    block.kind === 'chart'
      ? block.points.map((point) => point.value)
      : block.kind === 'table'
        ? block.rows.flatMap((row) => row.evidence ?? [])
        : block.kind === 'result'
          ? []
          : block.items.flatMap((item) => item.evidence ?? [])
  );
}
