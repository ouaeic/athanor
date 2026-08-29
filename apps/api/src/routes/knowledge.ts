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
  memoryTemporalStatus,
  userMemoryAad,
  OWNER_MEMORY_MAX_CHARS,
  OWNER_MEMORY_MAX_ROWS,
  WORKSPACE_MEMORY_MAX_CHARS
} from '@athanor/core';
import type { MemoryDocument } from '@athanor/core';
import type { MemoryItemBody } from '@athanor/contracts';
import type { MemoryItemRecord, WorkspaceMemoryRecord } from '@athanor/data';
import { z } from 'zod';
import { UNREADABLE_MEMORY_ITEM } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

/**
 * A credential in the text, refused rather than stored.
 *
 * This gate is the whole of the content check on the one tier that follows the owner out of the
 * workspace, and it was reading the LABEL rather than the secret. `api[_ -]?key\s*[:=]` wants the
 * word and the punctuation adjacent, so `Here is the API key: sk-…` was refused and `Here is my
 * openrouter key: sk-…` was not - same secret, same sentence, one word apart. Measured over the
 * owner's own 924 typed turns on this machine (`type: user`, not `isSidechain`, not a tool result,
 * not `isMeta` with a `sourceToolUseID`, no slash-command or compaction-continuation block,
 * deduplicated by turn uuid; 3,097 transcript files, 2,093,092 characters, 10 projects): 8 of them
 * carry a live 73-character `sk-or-v1-…` token, and the old rule refused 2. The capture path into
 * the workspace tier already neutralises all 8, because `redactText` matches the token; the tier
 * that outlives the workspace was the one letting them through.
 *
 * The count is stated because an earlier pass of this work stated 505 turns and 197,466 characters
 * and neither reproduces - the character figure by a factor of ten. Two independent recounts on the
 * stated filter agree on the order and on every exclusion count that matters (24,124 tool results),
 * so the basis here is the recounted one and the ratio arguments built on the old one are withdrawn
 * rather than repeated.
 *
 * So the vendor rule below reads the token: a recognised issuer prefix, ITS OWN delimiter, and
 * somewhere after it a run of sixteen characters with no delimiter in it. Both halves are load
 * bearing and each was measured against the other.
 *
 * The delimiter is what `redactText` does not require, and reusing that net here was the one-line
 * fix. It takes the prefix plus ten more characters of anything, which is right for a log line and
 * wrong for a refusal: it alters `skateboarding` and `pkgconfig`, and a tier the owner cannot write
 * the word "skateboarding" into is not a tier they will use.
 *
 * The run is what a length threshold cannot say. A threshold has to be picked, and the number
 * decides which names are refused while saying nothing about what a secret is - at twelve more
 * characters it already refuses `sk-learn-classifier-v2`, and every larger number is a guess about
 * how long a name gets. The run states the property itself, that a random token has a long
 * undelimited stretch and a hyphenated name does not, and it is indifferent to the total length:
 * `glpat-` with a twenty-character body and `sk-or-v1-` with seventy are the same clause.
 *
 * Against the same 924 turns, the four shapes together refuse all 8 secret-bearing turns and 0 of
 * the other 916.
 *
 * The labelled rule is kept beneath them, because a secret with no recognisable prefix has nothing
 * else to be caught by, and `password = …` is exactly that shape. Its PEM clause names the key
 * types `[A-Z ]*` rather than three of them, which is what `redaction.ts:48` on the capture path
 * has always matched: the narrower list admitted `-----BEGIN ENCRYPTED PRIVATE KEY-----` and
 * `-----BEGIN DSA PRIVATE KEY-----` into the one tier that leaves the workspace while the capture
 * path into the workspace redacted both, which is the property this gate exists to restore
 * inverted. Measured on the 924 turns: the widened clause fires on the same 0 of them.
 *
 * STILL OPEN, named rather than papered over. `Authorization: Basic …` is redacted on the capture
 * path (`Bearer|Basic|Token` there) and admitted here, and the naive port of that rule refuses
 * `Always send the Bearer token that the vault issues` - the owner's own shape - so it needs a
 * measurement this gate did not have room to make. A standing order carrying an exfiltration
 * address is not a credential and is not this rule's business; it is the one thing this tier reads
 * into every task in every workspace, and it has no content control at all. @see
 * docs/design/finish/GATE.md.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk_live|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|glpat|dop_v1|sq0csp)[-_][-_.A-Za-z0-9]*[A-Za-z0-9]{16,}/i,
  // Issuers whose tokens are a fixed shape rather than a prefix and a body: AWS key identifiers,
  // Google API keys, and any JSON web token whoever signed it.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // A password written into a URL, which is a complete credential arriving as an ordinary address.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_ -]?key|password|passphrase|secret|token)\s*[:=]\s*\S{12,}/i
];

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
    (value) => !CREDENTIAL_SHAPES.some((shape) => shape.test(value)),
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
  const { app, store, workspaceKnowledgeKey, ownerKnowledgeKey, idempotent } = context;

  /**
   * Two keys, and the rule for which row opens under which.
   *
   * A memory list is no longer one scope. The workspace tier is sealed under the workspace data
   * key with `workspace-memory:${workspaceId}`; the owner tier is sealed under a key derived from
   * the master key and the user, with its own AAD domain. `keyScope` is in the clear precisely so
   * this choice can be made before anything is decrypted rather than by trying one key and
   * catching the failure - a decrypt that fails and a decrypt that opened the wrong row look
   * identical from the outside only when nobody wrote down which key was meant.
   *
   * A `target: 'user'` row written before migration 70 is still `keyScope: 'workspace'` and still
   * opens the old way, so no existing entry changes meaning under its owner. `PATCH` is what
   * promotes one, and it does so with the owner watching.
   */
  const memoryKeyring = async (userId: string, workspaceId: string) => {
    const { key: workspaceKey } = await workspaceKnowledgeKey(userId, workspaceId);
    const ownerKey = ownerKnowledgeKey(userId);
    const open = (record: WorkspaceMemoryRecord): MemoryDocument =>
      record.keyScope === 'user'
        ? decryptJson<MemoryDocument>(record.contentCiphertext, ownerKey, userMemoryAad(userId))
        : decryptJson<MemoryDocument>(
            record.contentCiphertext,
            workspaceKey,
            `workspace-memory:${workspaceId}`
          );
    return { workspaceKey, ownerKey, open };
  };

  /**
   * What one row looks like on the wire.
   *
   * `scope` is served beside `target` and is not the same fact. `target` is what the owner chose;
   * `scope` is where the row actually lives now. They differ on exactly the rows that were written
   * under the old promise, and a client that shows "About you, everywhere" needs to be able to
   * tell those apart rather than repeating a claim the row cannot keep.
   */
  const memoryResponse = (record: WorkspaceMemoryRecord, document: MemoryDocument) => ({
    id: record.id,
    target: record.target,
    scope: record.keyScope,
    content: document.content,
    status: memoryTemporalStatus(document),
    validFrom: document.validFrom ?? null,
    validUntil: document.validUntil ?? null,
    source: document.source ?? 'owner',
    sourceTaskId: document.sourceTaskId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });

  /** Characters already spent in one tier, counting only rows that are still in force. */
  const spentCharacters = (
    records: readonly WorkspaceMemoryRecord[],
    open: (record: WorkspaceMemoryRecord) => MemoryDocument,
    target: WorkspaceMemoryRecord['target'],
    exceptId?: string
  ): number =>
    records
      .filter((record) => record.target === target && record.id !== exceptId)
      .reduce((total, record) => {
        const document = open(record);
        return memoryTemporalStatus(document) === 'expired'
          ? total
          : total + document.content.length;
      }, 0);

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/memories',
    async (request) => {
      const user = requireUser(request.user);
      const { open } = await memoryKeyring(user.id, request.params.workspaceId);
      return (await store.listWorkspaceMemories(user.id, request.params.workspaceId)).map(
        (record) => memoryResponse(record, open(record))
      );
    }
  );

  /**
   * Writes a memory, and the only path by which the owner tier can be entered.
   *
   * The gate is what is missing from this handler rather than what is in it: there is no task, no
   * tool call and no agent on this path. It is an authenticated owner session posting a form.
   * `createOwnerMemory` takes no workspace id for the same reason, so a caller that has one - which
   * is every caller inside a running turn - cannot use it. The worker's `memory` tool is refused at
   * the type and again at the store; @see createWorkspaceMemory.
   *
   * Two bounds, and they are not redundant. Characters are checked here because only a holder of
   * both keys can add up what is already stored, and rows are checked inside the insert because a
   * count taken here and an insert issued afterwards are two statements with a gap between them.
   * Both refuse. Neither evicts.
   */
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
    const { workspaceKey, ownerKey, open } = await memoryKeyring(
      user.id,
      request.params.workspaceId
    );
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const limit = input.target === 'user' ? OWNER_MEMORY_MAX_CHARS : WORKSPACE_MEMORY_MAX_CHARS;
    const spent = spentCharacters(records, open, input.target);
    if (spent + input.content.length > limit)
      throw new AthanorError(
        'memory_full',
        `${input.target} memory is ${spent}/${limit} characters. Consolidate or remove an entry first.`
      );
    const document: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      ...(input.validUntil ? { validUntil: input.validUntil } : {})
    };
    assertMemoryValidity(document);
    if (input.target === 'user') {
      const created = await store.createOwnerMemory({
        userId: user.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: encryptJson(document, ownerKey, userMemoryAad(user.id))
      });
      if (!created)
        throw new AthanorError(
          'memory_full',
          `Memory about you holds ${OWNER_MEMORY_MAX_ROWS} entries and all ${OWNER_MEMORY_MAX_ROWS} are in use. Remove one you no longer stand behind before adding another.`
        );
      return memoryResponse(created, document);
    }
    const created = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      target: 'workspace',
      contentCiphertext: encryptJson(
        document,
        workspaceKey,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    return memoryResponse(created, document);
  });

  /**
   * Rewrites one entry, and promotes a legacy owner-tier row on the way through.
   *
   * A `target: 'user'` row written before migration 70 is sealed under a workspace key and dies
   * with that workspace. It cannot be re-sealed by a migration, because migrations hold no key.
   * This is the moment it can be: the owner has both keys in hand, is looking at the row, and is
   * already rewriting its bytes. So an edit to any `target: 'user'` row seals the result under the
   * owner key and clears its workspace id, which is the difference between a promise in a label
   * and a row that keeps it.
   */
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
    const { workspaceKey, ownerKey, open } = await memoryKeyring(
      user.id,
      request.params.workspaceId
    );
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const existing = records.find((record) => record.id === request.params.memoryId);
    if (!existing) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    const existingDocument = open(existing);
    const limit = existing.target === 'user' ? OWNER_MEMORY_MAX_CHARS : WORKSPACE_MEMORY_MAX_CHARS;
    const spent = spentCharacters(records, open, existing.target, existing.id);
    if (spent + input.content.length > limit)
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
    const keyScope = existing.target === 'user' ? 'user' : 'workspace';
    /*
     * A promotion is an entry to the owner tier and pays the tier's row bound, exactly as an
     * insert does. Only a row that is not already there can pay it, so an ordinary edit to a row
     * the owner has already promoted is not charged twice.
     *
     * Checked here for the message and inside the statement for the guarantee, which is the same
     * division the POST above makes and for the same reason: this count and the write that follows
     * it are two statements with a gap in the middle, and the bound on the one tier that outlives
     * a workspace should not depend on nobody racing it.
     */
    if (keyScope === 'user' && existing.keyScope !== 'user') {
      const held = await store.countOwnerMemories(user.id);
      if (held >= OWNER_MEMORY_MAX_ROWS)
        throw new AthanorError(
          'memory_full',
          `Memory about you already holds ${OWNER_MEMORY_MAX_ROWS} entries. Remove one you no longer stand behind before moving this one across.`
        );
    }
    const updated = await store.updateWorkspaceMemory({
      id: existing.id,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      keyScope,
      maxOwnerRows: OWNER_MEMORY_MAX_ROWS,
      contentCiphertext:
        keyScope === 'user'
          ? encryptJson(updatedDocument, ownerKey, userMemoryAad(user.id))
          : encryptJson(
              updatedDocument,
              workspaceKey,
              `workspace-memory:${request.params.workspaceId}`
            )
    });
    if (!updated) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    return memoryResponse(updated, updatedDocument);
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
   * The whole of one row, which is the half of the promise the excerpt cannot keep.
   *
   * Both lists clamp at 200 characters and both say on screen that they are showing an opening.
   * That is honest and it is not "read the whole of what was remembered about you": the rest sat on
   * the owner's own disk, under a key this request already derives, with nothing anywhere to ask
   * for it. One row at a time and never in the list, deliberately — a review queue of fifty rows
   * with every body inlined is a megabyte of ciphertext decrypted to answer a question about one of
   * them, and the screen shows two lines until the owner opens something.
   *
   * A row this key will not open answers 200 with `readable: false` and the same standing sentence
   * the lists use, not 500 and not an empty string. The list already shows the row; an expander
   * that came back blank would read as "nothing was remembered here", which is the opposite of what
   * is true, and an error would hide a row the owner would most want to reach. A row that is not in
   * this workspace at all is a 404, which is a different fact and is said differently.
   */
  app.get<{ Params: { workspaceId: string; itemId: string } }>(
    '/v1/workspaces/:workspaceId/memory-items/:itemId',
    async (request) => {
      const user = requireUser(request.user);
      const workspaceId = request.params.workspaceId;
      const { key } = await workspaceKnowledgeKey(user.id, workspaceId);
      const record = await store.getMemoryItem(workspaceId, request.params.itemId);
      if (!record) throw new AthanorError('memory_item_not_found', 'Memory item not found', 404);
      try {
        const document = decryptJson<{ title?: string | null; body: string }>(
          record.documentCiphertext,
          key,
          `memory-item:${workspaceId}`
        );
        return {
          id: record.id,
          title: document.title ?? null,
          body: document.body,
          readable: true
        } satisfies MemoryItemBody;
      } catch {
        return {
          id: record.id,
          title: null,
          body: UNREADABLE_MEMORY_ITEM,
          readable: false
        } satisfies MemoryItemBody;
      }
    }
  );

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
