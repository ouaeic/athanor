/**
 * What the agent is allowed to remember and what it has been taught.
 *
 * Memories, the agent's own written-down items, the review queue, and skills. Everything written
 * through here passes `KnowledgeText` first: normalised, stripped of hidden control and
 * bidirectional characters, and refused outright if it looks like a credential - a memory is read
 * back to a model as instructions, so it is the one input where a hidden direction would be
 * obeyed rather than displayed.
 */

import { createHmac } from 'node:crypto';
import {
  AthanorError,
  assertMemoryValidity,
  decryptJson,
  encryptJson,
  memoryExcerpt,
  memoryTemporalStatus
} from '@athanor/core';
import type { MemoryDocument } from '@athanor/core';
import type { MemoryItemRecord } from '@athanor/data';
import { z } from 'zod';
import { UNREADABLE_MEMORY_ITEM } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

const KnowledgeText = z
  .string()
  .trim()
  .min(1)
  .max(24_000)
  .transform((value) => value.normalize('NFKC'))
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
        );
      }) && !/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(value),
    'Hidden control and bidirectional text are not allowed'
  )
  .refine(
    (value) =>
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S{12,}/i.test(
        value
      ),
    'Keep credentials out of memory and skills'
  );

const SkillDocumentInput = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: KnowledgeText.pipe(z.string().max(240)),
    content: KnowledgeText
  })
  .superRefine((value, context) => {
    for (const heading of ['When to use', 'Procedure', 'Pitfalls', 'Verification']) {
      if (!new RegExp(`^#{1,3}\\s+${heading}\\s*$`, 'im').test(value.content))
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: `Skill is missing ${heading}`
        });
    }
  });

export const registerKnowledgeRoutes = (context: RouteContext): void => {
  const { app, store, workspaceKnowledgeKey, idempotent } = context;
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/memories',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return (await store.listWorkspaceMemories(user.id, request.params.workspaceId)).map(
        (record) => {
          const document = decryptJson<MemoryDocument>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          );
          return {
            id: record.id,
            target: record.target,
            content: document.content,
            status: memoryTemporalStatus(document),
            validFrom: document.validFrom ?? null,
            validUntil: document.validUntil ?? null,
            source: document.source ?? 'owner',
            sourceTaskId: document.sourceTaskId ?? null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
          };
        }
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { target: 'workspace' | 'user'; content: string; validUntil?: string };
  }>('/v1/workspaces/:workspaceId/memories', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        target: z.enum(['workspace', 'user']),
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).optional()
      })
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const targetTotal = records
      .filter((record) => {
        if (record.target !== input.target) return false;
        const document = decryptJson<MemoryDocument>(
          record.contentCiphertext,
          key,
          `workspace-memory:${request.params.workspaceId}`
        );
        return memoryTemporalStatus(document) !== 'expired';
      })
      .reduce(
        (total, record) =>
          total +
          decryptJson<{ content: string }>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          ).content.length,
        0
      );
    const limit = input.target === 'user' ? 6_000 : 12_000;
    if (targetTotal + input.content.length > limit)
      throw new AthanorError(
        'memory_full',
        `${input.target} memory is full. Consolidate or remove an entry first.`
      );
    const document: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      ...(input.validUntil ? { validUntil: input.validUntil } : {})
    };
    assertMemoryValidity(document);
    const created = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      target: input.target,
      contentCiphertext: encryptJson(
        document,
        key,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    return {
      id: created.id,
      target: created.target,
      content: input.content,
      status: memoryTemporalStatus(document),
      validFrom: document.validFrom ?? null,
      validUntil: document.validUntil ?? null,
      source: document.source ?? 'owner',
      sourceTaskId: document.sourceTaskId ?? null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    };
  });

  app.patch<{
    Params: { workspaceId: string; memoryId: string };
    Body: { content: string; validUntil?: string | null };
  }>('/v1/workspaces/:workspaceId/memories/:memoryId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).nullable().optional()
      })
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const existing = records.find((record) => record.id === request.params.memoryId);
    if (!existing) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    const existingDocument = decryptJson<MemoryDocument>(
      existing.contentCiphertext,
      key,
      `workspace-memory:${request.params.workspaceId}`
    );
    const otherTotal = records
      .filter((record) => {
        if (record.target !== existing.target || record.id === existing.id) return false;
        const document = decryptJson<MemoryDocument>(
          record.contentCiphertext,
          key,
          `workspace-memory:${request.params.workspaceId}`
        );
        return memoryTemporalStatus(document) !== 'expired';
      })
      .reduce(
        (total, record) =>
          total +
          decryptJson<{ content: string }>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          ).content.length,
        0
      );
    const limit = existing.target === 'user' ? 6_000 : 12_000;
    if (otherTotal + input.content.length > limit)
      throw new AthanorError('memory_full', 'Replacement would exceed the memory limit');
    const updatedDocument: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      previousUpdatedAt: existing.updatedAt,
      ...(input.validUntil === null
        ? {}
        : input.validUntil
          ? { validUntil: input.validUntil }
          : existingDocument.validUntil
            ? { validUntil: existingDocument.validUntil }
            : {})
    };
    assertMemoryValidity(updatedDocument);
    const updated = await store.updateWorkspaceMemory({
      id: existing.id,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      contentCiphertext: encryptJson(
        updatedDocument,
        key,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    if (!updated) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    return {
      id: updated.id,
      target: updated.target,
      content: input.content,
      status: memoryTemporalStatus(updatedDocument),
      validFrom: updatedDocument.validFrom ?? null,
      validUntil: updatedDocument.validUntil ?? null,
      source: updatedDocument.source ?? 'owner',
      sourceTaskId: updatedDocument.sourceTaskId ?? null,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete<{ Params: { workspaceId: string; memoryId: string } }>(
    '/v1/workspaces/:workspaceId/memories/:memoryId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceMemory(
          user.id,
          request.params.workspaceId,
          request.params.memoryId
        )
      };
    }
  );

  /**
   * One line of what a stored row actually says.
   *
   * A row this key will not open is still listed, and says so, exactly as the standing notice log
   * does with a sentence it cannot read. The point of the list is that nothing this computer holds
   * about its owner is invisible to them, and a row dropped for being unreadable would be the one
   * row they would most want to reach.
   */
  const memoryItemExcerpt = (
    record: MemoryItemRecord,
    key: Buffer,
    workspaceId: string
  ): string => {
    try {
      const document = decryptJson<{ title?: string | null; body: string }>(
        record.documentCiphertext,
        key,
        `memory-item:${workspaceId}`
      );
      return memoryExcerpt(document.body, '', { maxChars: 200 }) || (document.title ?? '');
    } catch {
      return UNREADABLE_MEMORY_ITEM;
    }
  };

  /**
   * What the agent has written down for itself, which until now had no route at all.
   *
   * Every turn that finishes files what was asked and what came of it, so this grows on its own and
   * has no natural end: newest first and capped, with the owner asking for more when they want it.
   * Every status is served, including the retired ones - a line the agent has stopped believing is
   * still a line about the owner, still on their disk, and hiding it here is the defect this route
   * exists to fix.
   */
  app.get<{ Params: { workspaceId: string }; Querystring: { limit?: string } }>(
    '/v1/workspaces/:workspaceId/memory-items',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      const limit = z.coerce.number().int().min(1).max(200).default(20).parse(request.query.limit);
      return (await store.listMemoryItems(request.params.workspaceId, { limit })).map((record) => ({
        id: record.id,
        kind: record.kind,
        status: record.status,
        excerpt: memoryItemExcerpt(record, key, request.params.workspaceId),
        observedAt: record.observedAt
      }));
    }
  );

  app.delete<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.forgetMemoryItem(request.params.workspaceId, request.params.itemId)
      };
    }
  );

  /**
   * The memory review queue, which three documents promise and nothing has ever served.
   *
   * It was built at three layers and reached nobody: the store computes which procedures have gone
   * stale or started failing, the consolidation pass calls it and keeps the ids, and no route
   * existed - so "verify or delete" was a thing this computer decided about the owner's own notes
   * and never asked them about. Two lists, because they are two different questions:
   *
   * `procedures` is "this remembered command may no longer work" - either nobody has confirmed it
   * in a season (`unverified`), or it lost more of its last five uses than it won (`failing`), and
   * `recentOkCount` of `recentGradedCount` is the evidence for the second.
   *
   * `disputed` is "two things you said contradict each other", and it carries `contradicts` - the
   * ids of the other side - because "this is disputed" with no answer to "with what" is not
   * something a person can act on.
   *
   * The projection is deliberately wider than `/memory-items`, which returns five fields and drops
   * everything a decision would rest on: which conversation wrote this, how far it is trusted, when
   * it was last confirmed, what it has been worth. This is the screen where those matter.
   */
  const memoryReviewFields = (record: MemoryItemRecord, key: Buffer, workspaceId: string) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    excerpt: memoryItemExcerpt(record, key, workspaceId),
    observedAt: record.observedAt,
    taskId: record.taskId,
    trust: record.trust,
    validFrom: record.validFrom,
    validTo: record.validTo,
    lastVerified: record.lastVerified,
    okCount: record.okCount,
    failCount: record.failCount,
    useCount: record.useCount,
    pin: record.pin
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { staleDays?: string; limit?: string };
  }>('/v1/workspaces/:workspaceId/memory-review', async (request) => {
    const user = requireUser(request.user);
    const workspaceId = request.params.workspaceId;
    const { key } = await workspaceKnowledgeKey(user.id, workspaceId);
    const query = z
      .object({
        // Bounded on both sides: a horizon of zero would list every procedure on the box as stale,
        // and one of ten thousand years would list none, both silently.
        staleDays: z.coerce.number().int().min(1).max(3_650).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50)
      })
      .parse(request.query);
    const [procedures, disputed] = await Promise.all([
      store.listStaleMemoryProcedures(workspaceId, {
        ...(query.staleDays === undefined ? {} : { staleDays: query.staleDays })
      }),
      store.listDisputedMemoryItems(workspaceId, query.limit)
    ]);
    return {
      procedures: procedures.slice(0, query.limit).map((record) => ({
        ...memoryReviewFields(record, key, workspaceId),
        reason: record.reason,
        recentOkCount: record.recentOkCount,
        recentGradedCount: record.recentGradedCount
      })),
      disputed: disputed.map((record) => ({
        ...memoryReviewFields(record, key, workspaceId),
        contradicts: record.contradicts
      }))
    };
  });

  /**
   * "This is still right." Moves the procedure out of the queue by moving the clock the queue reads.
   *
   * 404 rather than `{verified:false}` because the store returns false for exactly two reasons - no
   * such row in this workspace, or the row is not a procedure - and both are the caller naming
   * something that is not there. A client that showed a row and then got 200-with-false would have
   * to guess.
   */
  app.post<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId/verify',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        await workspaceKnowledgeKey(user.id, request.params.workspaceId);
        if (!(await store.verifyMemoryProcedure(request.params.workspaceId, request.params.itemId)))
          throw new AthanorError('memory_item_not_found', 'Memory item not found', 404);
        return { verified: true };
      });
    }
  );

  /**
   * "Stop believing this", which is not "delete this".
   *
   * `DELETE …/memory-items/:id` next door removes the row and every trace of it, which is what an
   * owner means when they say a line is gone. Retracting keeps the row, stops it being recalled and
   * records that it stopped being true - the audit trail the queue exists to protect. Both are
   * offered because they are different decisions, and the difference is the whole reason the review
   * queue is not a delete button.
   */
  app.post<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId/retract',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        await workspaceKnowledgeKey(user.id, request.params.workspaceId);
        if (!(await store.retractMemoryItem(request.params.workspaceId, request.params.itemId)))
          throw new AthanorError(
            'memory_item_not_found',
            'Memory item not found, or already retracted',
            404
          );
        return { retracted: true };
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/skills',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      await store.curateWorkspaceSkills(request.params.workspaceId);
      return (await store.listWorkspaceSkills(user.id, request.params.workspaceId)).map(
        (record) => ({
          id: record.id,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          pinned: record.pinned,
          useCount: record.useCount,
          lastUsedAt: record.lastUsedAt,
          ...decryptJson<{ name: string; description: string; content: string }>(
            record.documentCiphertext,
            key,
            `workspace-skill:${request.params.workspaceId}`
          ),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { name: string; description: string; content: string };
  }>('/v1/workspaces/:workspaceId/skills', async (request) => {
    const user = requireUser(request.user);
    const input = SkillDocumentInput.parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const nameHash = createHmac('sha256', key).update(`athanor-skill:${input.name}`).digest('hex');
    const saved = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      nameHash,
      documentCiphertext: encryptJson(input, key, `workspace-skill:${request.params.workspaceId}`)
    });
    return {
      id: saved.id,
      version: saved.version,
      enabled: saved.enabled,
      status: saved.status,
      pinned: saved.pinned,
      useCount: saved.useCount,
      lastUsedAt: saved.lastUsedAt,
      ...input,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt
    };
  });

  app.patch<{
    Params: { workspaceId: string; skillId: string };
    Body: { status?: 'active' | 'stale' | 'archived'; pinned?: boolean; enabled?: boolean };
  }>('/v1/workspaces/:workspaceId/skills/:skillId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        status: z.enum(['active', 'stale', 'archived']).optional(),
        pinned: z.boolean().optional(),
        enabled: z.boolean().optional()
      })
      .refine(
        (value) =>
          value.status !== undefined || value.pinned !== undefined || value.enabled !== undefined
      )
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const updated = await store.setWorkspaceSkillState({
      id: request.params.skillId,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled })
    });
    if (!updated) throw new AthanorError('skill_not_found', 'Skill not found', 404);
    return {
      id: updated.id,
      version: updated.version,
      enabled: updated.enabled,
      status: updated.status,
      pinned: updated.pinned,
      useCount: updated.useCount,
      lastUsedAt: updated.lastUsedAt,
      ...decryptJson<{ name: string; description: string; content: string }>(
        updated.documentCiphertext,
        key,
        `workspace-skill:${request.params.workspaceId}`
      ),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete<{ Params: { workspaceId: string; skillId: string } }>(
    '/v1/workspaces/:workspaceId/skills/:skillId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceSkill(
          user.id,
          request.params.workspaceId,
          request.params.skillId
        )
      };
    }
  );
};
