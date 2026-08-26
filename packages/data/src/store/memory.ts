import { randomUUID } from 'node:crypto';
import {
  AthanorError,
  MEMORY_PACK_BUDGET_TOKENS,
  MEMORY_FUZZY_SIMILARITY_THRESHOLD,
  MEMORY_PACK_DEFAULT_QUOTA,
  MEMORY_PACK_QUOTAS,
  MEMORY_PREDICATES,
  MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
  MEMORY_PROCEDURE_STALE_DAYS,
  isFunctionalMemoryPredicate,
  isMemoryToken,
  memoryPredicate
} from '@athanor/core';
import type {
  EncryptedEnvelope,
  MemoryItemIndex,
  MemoryKind,
  MemoryPackQuota,
  MemoryQueryPlan,
  MemoryStatus,
  MemoryTrust
} from '@athanor/core';
import type { Database } from '../database.js';
import {
  iso,
  mapMemoryCandidate,
  mapMemoryFactCandidate,
  mapMemoryItem,
  mapMemoryPack,
  mapMemorySource,
  optionalText
} from './rows.js';
import {
  MEMORY_RECALL_SQL,
  MEMORY_SOURCE_SEARCH_PER_TASK,
  MEMORY_SOURCE_SEARCH_SQL,
  MEMORY_SOURCE_WINDOW_SQL
} from './sql/memory.js';

/** Guards the one lookup whose ids arrive as model-written text rather than from a prior row. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryCapabilities {
  /** True when pg_trgm is installed. Fuzzy recall does not depend on it; reporting does. */
  readonly trigram: boolean;
}

export interface MemoryItemRecord {
  id: string;
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  observedAt: string;
  retiredAt: string | null;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  predFunctional: boolean;
  objectKey: string | null;
  episodeId: string | null;
  taskId: string | null;
  lastVerified: string | null;
  okCount: number;
  failCount: number;
  pin: boolean;
  useCount: number;
  citedCount: number;
  negCount: number;
  lastUsedAt: string | null;
  salience: number;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A procedure in the review queue, and why it is there.
 *
 * `unverified` is "nobody has confirmed this in a season" - it may be perfectly good and merely
 * unused. `failing` is "it lost more than it won across its last five uses" - it is broken now, and
 * `recentOkCount` of `recentGradedCount` is the evidence. They are different things to say to an
 * owner deciding whether to keep a remembered command, which is why the queue reports which.
 */
export interface MemoryProcedureReviewRecord extends MemoryItemRecord {
  reason: 'unverified' | 'failing' | 'both';
  recentOkCount: number;
  recentGradedCount: number;
}

export interface MemorySourceRecord {
  id: string;
  userId: string;
  workspaceId: string;
  occurredAt: string;
  channel: MemorySourceChannel;
  role: string | null;
  taskId: string | null;
  episodeId: string | null;
  originCiphertext: EncryptedEnvelope | null;
  originKey: string | null;
  bodyCiphertext: EncryptedEnvelope;
  chunkIndex: number;
  chunkOf: string | null;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
}

export type MemorySourceChannel = 'chat' | 'terminal' | 'file' | 'browser' | 'desktop' | 'tool';

export type MemoryUseOutcome = 'ok' | 'fail' | 'unknown';

export interface MemoryCandidateRecord {
  id: string;
  /** `item` rows come from the curated overlay, `source` rows from the verbatim layer. */
  layer: 'item' | 'source';
  kind: MemoryKind;
  trust: MemoryTrust;
  status: MemoryStatus;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  tokensEst: number;
  score: number;
  documentCiphertext: EncryptedEnvelope;
}

export interface MemoryPackRecord {
  taskId: string;
  workspaceId: string;
  briefVersion: string | null;
  bodyCiphertext: EncryptedEnvelope;
  sha256: string;
  itemIds: string[];
  tokensEst: number;
  createdAt: string;
}

export interface MemoryLinkRecord {
  srcId: string;
  dstId: string;
  rel: MemoryLinkRelation;
  weight: number;
  createdAt: string;
}

export type MemoryLinkRelation =
  | 'supersedes'
  | 'contradicts'
  | 'supports'
  | 'derived_from'
  | 'about'
  | 'part_of';

export interface MemoryFactCandidateRecord {
  workspaceId: string;
  subjectKey: string;
  predicate: string;
  objectKey: string;
  episodeCount: number;
  firstSeen: string;
  lastSeen: string;
  episodeIds: string[];
  draftCiphertext: EncryptedEnvelope | null;
}

/**
 * What the key holder has to supply for an observation to become a durable fact: the sealed
 * document and the blind index over it, neither of which the store can produce for itself.
 */
export interface PreparedMemoryFact {
  userId: string;
  documentCiphertext: EncryptedEnvelope;
  /** Its `subjectKey` and `objectKey` must be the candidate's, or the promotion is refused. */
  index: MemoryItemIndex;
  /** Defaults to `derived`: a promoted fact was assembled from episodes, not stated outright. */
  trust?: MemoryTrust;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  taskId?: string | null;
}

export interface MemoryFactPromotion {
  candidate: MemoryFactCandidateRecord;
  item: MemoryItemRecord;
  supersededIds: string[];
}

export interface CreateMemoryItemInput {
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  /** Keyed blind index built by `buildMemoryItemIndex`; plaintext never reaches the store. */
  index: MemoryItemIndex;
  id?: string;
  status?: MemoryStatus;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  predicate?: string | null;
  episodeId?: string | null;
  taskId?: string | null;
  lastVerified?: Date | string | null;
  pin?: boolean;
  salience?: number;
}

export interface RecallMemoryInput {
  workspaceId: string;
  plan: MemoryQueryPlan;
  /** Anchors every decayed score. Pass the task's start instant to freeze a pack for its lifetime. */
  now?: Date | string;
  budgetTokens?: number;
  maxItems?: number;
  kinds?: readonly MemoryKind[];
  scope?: 'default' | 'archive';
  asOf?: Date | string | null;
  includeSuperseded?: boolean;
  quotas?: readonly MemoryPackQuota[];
  procedureStaleDays?: number;
  procedureMinSuccessRate?: number;
  /** Minimum keyed-trigram Jaccard for the fuzzy channel; defaults to pg_trgm's own threshold. */
  fuzzyThreshold?: number;
  /**
   * Rows the caller already has in context. Excluded before any channel spends a slot on them, so a
   * mid-task recall returns what the frozen pack did not, rather than a paraphrase of it.
   */
  excludeIds?: readonly string[];
  /**
   * `stable` orders by (kind, id) so the same rows always render to the same pack bytes, which is
   * what the prompt cache needs. `relevance` orders by fused score, for a recall the agent asked
   * for mid-task and nothing is caching.
   */
  order?: 'stable' | 'relevance';
}

export interface SearchMemorySourcesInput {
  workspaceId: string;
  /** Built by `planMemoryQuery`, exactly as for item recall: same tokenizer, same key. */
  plan: MemoryQueryPlan;
  /** Restricts the search to one task's transcript. */
  taskId?: string | null;
  since?: Date | string | null;
  until?: Date | string | null;
  limit?: number;
  /**
   * Most rows any one conversation may contribute. Defaults to `MEMORY_SOURCE_SEARCH_PER_TASK`;
   * a search already restricted to one task raises it, because there is nothing to crowd out.
   */
  perTask?: number;
}

export interface MemorySourceHit extends MemorySourceRecord {
  score: number;
}

export interface MemoryConsolidationReport {
  salienceUpdated: number;
  itemsArchived: number;
  sourcesUnindexed: number;
  usesPruned: number;
  candidatesPruned: number;
  packsPruned: number;
  staleProcedureIds: string[];
  /** True when this pass also did the periodic full rebuild of the BM25 corpus statistics. */
  corpusStatsRebuilt: boolean;
}

/**
 * The tiered agent memory: the `mem` schema and every statement that reads or writes it.
 *
 * Three layers in one place because they only make sense together - `mem.source` holds the words as
 * they were typed, `mem.item` holds what was curated out of them, and `mem.pack` holds the bytes a
 * task actually sent to the model. Recall reads all three; consolidation demotes across all three;
 * and `forgetMemoryItem` is the one statement that has to reach every one of them, which is exactly
 * why it belongs beside them rather than in a route.
 */
export class MemoryStore {
  constructor(private readonly database: Database) {}

  /** Detected once per process: extension availability cannot change under a running server. */
  #memoryCapabilities: Promise<MemoryCapabilities> | null = null;

  async memoryCapabilities(): Promise<MemoryCapabilities> {
    this.#memoryCapabilities ??= this.database
      .query<{
        extname: string;
      }>(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)
      .then((result) => ({ trigram: result.rows.length > 0 }));
    return this.#memoryCapabilities;
  }

  /**
   * Reconciles the database copy of the predicate registry with the vetted in-repo one. The
   * registry is deliberately not extensible at runtime, so this only ever writes what ships.
   *
   * Each registry row is followed by a backfill of `mem.item.pred_functional`, because that column
   * is a cache of `cardinality = 'one'` that only ever gets filled at write time: `mem.index_row()`
   * computes it, and its trigger fires on `mem.item`, not on `mem.predicate`. Nothing else refreshes
   * it, and it is the sole predicate of the `mem_fact_current_one` unique index - the one guarantee
   * that a functional predicate has one current value.
   *
   * So a release that changes a cardinality used to update the registry and leave every stored row
   * carrying the old answer. `many` -> `one` left the unique index covering nothing it should have
   * covered, and two current values for the same subject coexisting indefinitely with no error
   * anywhere. `one` -> `many` was worse: the stale `TRUE` kept the index covering rows it no longer
   * governed, so a legitimate second value was refused by a constraint violation the agent reported
   * to the owner as a failed memory write.
   *
   * Two things to know before relying on this. Nothing calls it on a live box: the eval harness and
   * the tests do, while `apps/api/src/server.ts` and `apps/worker/src/index.ts` both stop at
   * `migrateDatabase`. And the damage it repairs is narrower than it looks, because the registry's
   * only production writer is `#recordMemoryFact`, which upserts the definition it is about to use
   * before writing - so a fact minted after a cardinality change always carries the new answer, and
   * the retirement that enforces `one` never reads the flag. What is left is the rows written
   * *before* the change, which keep the old answer and stay outside or inside `mem_fact_current_one`
   * accordingly until this runs.
   */
  async syncMemoryPredicates(): Promise<number> {
    let written = 0;
    for (const predicate of MEMORY_PREDICATES) {
      const result = await this.database.query(
        `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE
           SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
               description=EXCLUDED.description`,
        [predicate.name, predicate.cardinality, predicate.isTemporal, predicate.description]
      );
      written += result.rowCount;
      await this.#backfillPredicateFunctional(
        this.database,
        predicate.name,
        predicate.cardinality === 'one'
      );
    }
    return written;
  }

  /**
   * Re-materialises `pred_functional` for one predicate after its cardinality moved.
   *
   * The direction matters, and only one of the two can fail. Clearing the flag can only remove rows
   * from `mem_fact_current_one`, so it is a plain UPDATE. Setting it *adds* rows to a unique index,
   * and the rows being added are exactly the ones written while the predicate still permitted many
   * values - so a subject that legitimately accumulated three current values under `many` would
   * abort the whole statement the moment the registry said `one`.
   *
   * That abort would land on an unattended upgrade, so it is designed out rather than caught: a row
   * is only promoted when nothing else already occupies its slot in the index. A subject that really
   * does hold several current values keeps them, keeps them retrievable, and stays outside the
   * unique index until the contradiction is resolved the ordinary way - by one of them being
   * superseded. Half a table converted is the correct outcome here; a migration that refuses to
   * finish is not.
   *
   * The occupancy test is a window rather than the correlated NOT EXISTS it reads as, and that is
   * not a style choice. `mem.item.predicate` has no index of its own, so asking "does anything else
   * hold this row's slot?" once per candidate row is one sequential scan per candidate: measured at
   * 20,000 facts under a predicate that had just narrowed, the correlated form took **65 s** and the
   * window form takes **0.4 s**. Sixty-five seconds inside an unattended upgrade is how a box comes
   * back from a 3am restart with its memory half converted and nobody watching.
   *
   * `PARTITION BY workspace_id, subject_key` is the index's key less the predicate, which the WHERE
   * has already fixed. subject_key is nullable in general but never on a row this can promote: the
   * table's own CHECK requires a fact to carry one, and only facts are governed.
   */
  async #backfillPredicateFunctional(
    database: Database,
    name: string,
    functional: boolean
  ): Promise<void> {
    if (!functional) {
      await database.query(
        `UPDATE mem.item SET pred_functional = FALSE
         WHERE predicate = $1 AND pred_functional`,
        [name]
      );
      return;
    }
    await database.query(
      `WITH slots AS (
         SELECT id, pred_functional,
                (kind = 'fact' AND status = 'active' AND valid_to IS NULL) AS governed,
                count(*) FILTER (WHERE kind = 'fact' AND status = 'active' AND valid_to IS NULL)
                  OVER (PARTITION BY workspace_id, subject_key) AS in_slot
         FROM mem.item WHERE predicate = $1
       )
       UPDATE mem.item i SET pred_functional = TRUE
       FROM slots s
       WHERE s.id = i.id AND NOT s.pred_functional
         AND (NOT s.governed OR s.in_slot <= 1)`,
      [name]
    );
  }

  async createMemorySource(input: {
    userId: string;
    workspaceId: string;
    channel: MemorySourceChannel;
    bodyCiphertext: EncryptedEnvelope;
    bodyTokens: string;
    tokensEst: number;
    indexed?: boolean;
    role?: string | null;
    taskId?: string | null;
    episodeId?: string | null;
    /** Sealed provenance: paths, URLs, cwd, exit codes. Never written in the clear. */
    originCiphertext?: EncryptedEnvelope | null;
    /** Keyed hash of the locator, from `memoryOriginKey`; the only origin column SQL can match. */
    originKey?: string | null;
    chunkIndex?: number;
    chunkOf?: string | null;
    occurredAt?: Date | string;
    /**
     * Every other memory write takes a caller-supplied id and this one minted its own, which made
     * a corpus impossible to reproduce: two rows the ranking cannot separate are ordered by id, so
     * a random one decides which of them the pack carries and the same store answers the same
     * question differently on a second run.
     */
    id?: string;
  }): Promise<MemorySourceRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.source(
         id,user_id,workspace_id,occurred_at,channel,role,task_id,episode_id,origin_ciphertext,
         origin_key,body_ciphertext,chunk_ix,chunk_of,tokens_est,indexed,body_tokens
       ) VALUES ($1,$2,$3,COALESCE($4,NOW()),$5,$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb),$10,
                 $11::jsonb,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.occurredAt ?? null,
        input.channel,
        input.role ?? null,
        input.taskId ?? null,
        input.episodeId ?? null,
        input.originCiphertext ? JSON.stringify(input.originCiphertext) : null,
        input.originKey ?? null,
        JSON.stringify(input.bodyCiphertext),
        input.chunkIndex ?? 0,
        input.chunkOf ?? null,
        input.tokensEst,
        input.indexed ?? true,
        input.indexed === false ? '' : input.bodyTokens
      ]
    );
    return mapMemorySource(result.rows[0]!);
  }

  /**
   * Reaches verbatim rows by where they came from. Compaction takes old sources out of the lexical
   * index but never deletes them, so this is the path that still finds them.
   */
  async listMemorySourcesByOrigin(
    workspaceId: string,
    originKey: string,
    limit = 50
  ): Promise<MemorySourceRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.source WHERE workspace_id=$1 AND origin_key=$2
       ORDER BY occurred_at DESC, id LIMIT $3`,
      [workspaceId, originKey, limit]
    );
    return result.rows.map(mapMemorySource);
  }

  async createMemoryItem(input: CreateMemoryItemInput): Promise<MemoryItemRecord> {
    return this.#insertMemoryItem(this.database, input);
  }

  async #insertMemoryItem(
    database: Database,
    input: CreateMemoryItemInput
  ): Promise<MemoryItemRecord> {
    const result = await database.query(
      `INSERT INTO mem.item(
         id,user_id,workspace_id,kind,status,trust,document_ciphertext,title_tokens,tag_tokens,
         alias_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,observed_at,valid_from,valid_to,
         subject_key,predicate,object_key,episode_id,task_id,last_verified,pin,salience,
         tokens_est,indexed
       ) VALUES (
         $1,$2,$3,$4::mem.kind,COALESCE($5::mem.status,'active'),$6::mem.trust,$7::jsonb,$8,$9,
         $27,$10,$11::text[],$12::text[],$13,COALESCE($14,NOW()),COALESCE($15,NOW()),$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26
       ) RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.kind,
        input.status ?? null,
        input.trust,
        JSON.stringify(input.documentCiphertext),
        input.index.titleTokens,
        input.index.tagTokens,
        input.index.bodyTokens,
        input.index.tagsHashed,
        input.index.trigrams,
        input.index.dedupeKey,
        input.observedAt ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.index.subjectKey,
        input.predicate ?? null,
        input.index.objectKey,
        input.episodeId ?? null,
        input.taskId ?? null,
        input.lastVerified ?? null,
        input.pin ?? false,
        input.salience ?? 0,
        input.index.tokensEst,
        input.index.indexed,
        input.index.aliasTokens
      ]
    );
    return mapMemoryItem(result.rows[0]!);
  }

  /**
   * Mints a fact and applies deterministic supersession: a second current value for a functional
   * predicate retires the first one, bitemporally and with a `supersedes` link, rather than being
   * deleted. That keeps "what did I use before?" answerable and keeps the audit trail behind every
   * brief line intact - and it costs no model call at all.
   */
  async recordMemoryFact(
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    return this.database.transaction(async (transaction) =>
      this.#recordMemoryFact(transaction, input)
    );
  }

  async #recordMemoryFact(
    transaction: Database,
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    const definition = memoryPredicate(input.predicate);
    if (!definition)
      throw new AthanorError(
        'memory_predicate_unknown',
        `Unknown memory predicate "${input.predicate}"`
      );
    if (!input.index.subjectKey)
      throw new AthanorError('memory_fact_subject_missing', 'A fact needs a subject');

    /*
     * The shipped definition, pushed into the registry before anything is written against it.
     *
     * This upsert is load-bearing in a way its own line does not show, so it is written down here:
     * it is the reason a release that changes a cardinality cannot break a fact write, and the
     * reason `mem.item.pred_functional` going stale is a dormant inconsistency rather than a failed
     * memory. The row inserted below has its flag computed by `mem.index_row()` from `mem.predicate`
     * as it stands *after* this statement, so a new fact always carries the current answer whatever
     * the rows beside it are still claiming - and the retirement below never consults the flag at
     * all. `syncMemoryPredicates` is what reconciles the rows already stored; nothing calls it at
     * boot, and this is why that is a debt rather than an outage.
     */
    await transaction.query(
      `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
             description=EXCLUDED.description`,
      [definition.name, definition.cardinality, definition.isTemporal, definition.description]
    );
    const supersededIds: string[] = [];
    // Asked of the registry by name rather than off the definition in hand, so that "what makes a
    // predicate functional" has exactly one spelling. `definition` came from the same registry a
    // few lines up, so the answer cannot differ; what changes is that the deterministic half of
    // contradiction resolution and the predicate helper `@athanor/core` exports are now the same
    // test, and a future edit to one of them cannot leave the other behind.
    if (isFunctionalMemoryPredicate(input.predicate)) {
      const retired = await transaction.query<{ id: string }>(
        `UPDATE mem.item SET status='superseded', valid_to=COALESCE($4,NOW()), retired_at=NOW(),
                             updated_at=NOW()
         WHERE workspace_id=$1 AND kind='fact' AND status='active' AND valid_to IS NULL
           AND subject_key=$2 AND predicate=$3
         RETURNING id`,
        [input.workspaceId, input.index.subjectKey, input.predicate, input.validFrom ?? null]
      );
      supersededIds.push(...retired.rows.map((row) => row.id));
    }
    const item = await this.#insertMemoryItem(transaction, { ...input, kind: 'fact' });
    for (const supersededId of supersededIds)
      await transaction.query(
        `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supersedes')
         ON CONFLICT DO NOTHING`,
        [item.id, supersededId]
      );
    return { item, supersededIds };
  }

  /**
   * Both sides of what the harness watched an acceptance command do, written in one statement.
   *
   * A dead end is a procedure the harness saw fail, and the thing that refutes it is the same
   * command later observed passing - so the write that would record a pass is the write that has to
   * retire the caution, or the caution outlives the problem and starts arguing against work that
   * would now succeed. Doing it here rather than in two calls is what makes that true even when the
   * turn crashes between them: a pass never leaves a stale dead end standing, because there is no
   * moment at which one has been recorded and the other has not.
   *
   * `passed` wins inside the turn as well as across turns. A command can reach both lists at once -
   * two checks naming the same command, one answered by a run athanor already watched succeed and
   * one it ran again - and the pass is the later evidence, so nothing is written for it.
   *
   * The subject is the command alone, exactly as a passing run keys it, so a command that fails in
   * one directory and passes in another retires the caution about the first. That is the deliberate
   * direction of the error: forgetting a warning costs a re-run, and keeping a wrong one costs the
   * approach.
   */
  async recordMemoryDeadEnds(input: {
    workspaceId: string;
    /** Keyed `MEMORY_DEAD_END_TAG`; the only handle this store has on rows it cannot read. */
    markerTag: string;
    /** Keyed subjects of the commands the harness watched pass on this turn. */
    passed?: readonly string[];
    /** One per command it watched fail, already built and encrypted by the caller. */
    failed?: readonly Omit<CreateMemoryItemInput, 'kind'>[];
    at?: Date | string | null;
  }): Promise<{ recorded: string[]; retired: string[] }> {
    const passed = [...new Set(input.passed ?? [])];
    const failed = (input.failed ?? []).filter(
      (item) => item.index.subjectKey && !passed.includes(item.index.subjectKey)
    );
    if (passed.length === 0 && failed.length === 0) return { recorded: [], retired: [] };
    return this.database.transaction(async (transaction) => {
      const retired: string[] = [];
      if (passed.length > 0) {
        // Superseded rather than deleted, for the same reason a retired fact is: "what was wrong
        // with this last month" stays answerable, and only `status='active'` reaches recall.
        const result = await transaction.query<{ id: string }>(
          `UPDATE mem.item SET status='superseded', valid_to=COALESCE($4::timestamptz,NOW()),
                               retired_at=NOW(), updated_at=NOW()
           WHERE workspace_id=$1 AND kind='procedure' AND status='active'
             AND tags_hashed @> ARRAY[$2::text] AND subject_key = ANY($3::text[])
           RETURNING id`,
          [input.workspaceId, input.markerTag, passed, input.at ?? null]
        );
        retired.push(...result.rows.map((row) => row.id));
      }
      const recorded: string[] = [];
      for (const item of failed) {
        const written = await this.#insertMemoryItem(transaction, { ...item, kind: 'procedure' });
        recorded.push(written.id);
      }
      return { recorded, retired };
    });
  }

  async getMemoryItem(workspaceId: string, id: string): Promise<MemoryItemRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM mem.item WHERE id=$2 AND workspace_id=$1',
      [workspaceId, id]
    );
    return result.rows[0] ? mapMemoryItem(result.rows[0]) : null;
  }

  async listMemoryItems(
    workspaceId: string,
    filter: { kind?: MemoryKind; status?: MemoryStatus; limit?: number } = {}
  ): Promise<MemoryItemRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.item
       WHERE workspace_id=$1
         AND ($2::text IS NULL OR kind::text=$2)
         AND ($3::text IS NULL OR status::text=$3)
       ORDER BY observed_at DESC, id
       LIMIT $4`,
      [workspaceId, filter.kind ?? null, filter.status ?? null, filter.limit ?? 200]
    );
    return result.rows.map(mapMemoryItem);
  }

  async linkMemoryItems(input: {
    srcId: string;
    dstId: string;
    rel: MemoryLinkRelation;
    weight?: number;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO mem.link(src_id,dst_id,rel,weight) VALUES ($1,$2,$3,$4)
       ON CONFLICT (src_id,dst_id,rel) DO UPDATE SET weight=EXCLUDED.weight`,
      [input.srcId, input.dstId, input.rel, input.weight ?? 1]
    );
  }

  async listMemoryLinks(itemId: string): Promise<MemoryLinkRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.link WHERE src_id=$1 OR dst_id=$1 ORDER BY rel, src_id, dst_id`,
      [itemId]
    );
    return result.rows.map((row) => ({
      srcId: String(row.src_id),
      dstId: String(row.dst_id),
      rel: String(row.rel) as MemoryLinkRelation,
      weight: Number(row.weight),
      createdAt: iso(row.created_at)
    }));
  }

  /** Provenance: every curated item cites the verbatim rows it was extracted from. */
  async attachMemoryEvidence(
    itemId: string,
    sources: readonly { sourceId: string; span?: [number, number] | null }[]
  ): Promise<number> {
    // All of an item's provenance or none of it. A curated item is already visible to recall by
    // the time this runs, so a half-written citation list is an item the owner can be shown that
    // claims fewer sources than it was actually extracted from - and nothing later notices, because
    // there is no record anywhere of how many there should have been.
    return this.database.transaction(async (transaction) => {
      let written = 0;
      for (const source of sources) {
        const result = await transaction.query(
          `INSERT INTO mem.evidence(item_id,source_id,span)
           VALUES ($1,$2,CASE WHEN $3::int IS NULL THEN NULL ELSE int4range($3::int,$4::int) END)
           ON CONFLICT (item_id,source_id) DO UPDATE SET span=EXCLUDED.span`,
          [itemId, source.sourceId, source.span?.[0] ?? null, source.span?.[1] ?? null]
        );
        written += result.rowCount;
      }
      return written;
    });
  }

  async listMemoryEvidence(
    itemId: string
  ): Promise<{ sourceId: string; span: string | null; occurredAt: string }[]> {
    const result = await this.database.query(
      `SELECT e.source_id, e.span::text AS span, s.occurred_at
       FROM mem.evidence e JOIN mem.source s ON s.id=e.source_id
       WHERE e.item_id=$1 ORDER BY s.occurred_at, e.source_id`,
      [itemId]
    );
    return result.rows.map((row) => ({
      sourceId: String(row.source_id),
      span: optionalText(row.span),
      occurredAt: iso(row.occurred_at)
    }));
  }

  /**
   * Below-threshold observations wait here instead of entering mem.item. Requiring two independent
   * episodes at least a day apart is the single most effective anti-bloat rule in the design:
   * minting a fact per message pair is what makes a store unusable after a year.
   */
  async observeMemoryFactCandidate(input: {
    workspaceId: string;
    subjectKey: string;
    predicate: string;
    objectKey: string;
    episodeId: string;
    observedAt?: Date | string;
    draftCiphertext?: EncryptedEnvelope | null;
  }): Promise<MemoryFactCandidateRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.fact_candidate(
         workspace_id,subject_key,predicate,object_key,n_episodes,first_seen,last_seen,
         episode_ids,draft_ciphertext
       ) VALUES ($1,$2,$3,$4,1,COALESCE($6,NOW()),COALESCE($6,NOW()),ARRAY[$5::uuid],$7::jsonb)
       ON CONFLICT (workspace_id,subject_key,predicate,object_key) DO UPDATE SET
         n_episodes = mem.fact_candidate.n_episodes
           + CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids) THEN 0 ELSE 1 END,
         episode_ids = CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids)
           THEN mem.fact_candidate.episode_ids
           ELSE (mem.fact_candidate.episode_ids || ARRAY[$5::uuid])[1:32] END,
         first_seen = LEAST(mem.fact_candidate.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(mem.fact_candidate.last_seen, EXCLUDED.last_seen),
         draft_ciphertext = COALESCE(EXCLUDED.draft_ciphertext, mem.fact_candidate.draft_ciphertext)
       RETURNING *`,
      [
        input.workspaceId,
        input.subjectKey,
        input.predicate,
        input.objectKey,
        input.episodeId,
        input.observedAt ?? null,
        input.draftCiphertext ? JSON.stringify(input.draftCiphertext) : null
      ]
    );
    return mapMemoryFactCandidate(result.rows[0]!);
  }

  async listPromotableMemoryFactCandidates(
    workspaceId: string,
    options: { minEpisodes?: number; minGapHours?: number; limit?: number } = {}
  ): Promise<MemoryFactCandidateRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.fact_candidate
       WHERE workspace_id=$1 AND n_episodes >= $2
         AND last_seen - first_seen >= make_interval(hours => $3::int)
       ORDER BY n_episodes DESC, last_seen DESC, subject_key, predicate, object_key
       LIMIT $4`,
      [
        workspaceId,
        options.minEpisodes ?? 2,
        Math.trunc(options.minGapHours ?? 24),
        options.limit ?? 50
      ]
    );
    return result.rows.map(mapMemoryFactCandidate);
  }

  async deleteMemoryFactCandidate(
    workspaceId: string,
    subjectKey: string,
    predicate: string,
    objectKey: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
      [workspaceId, subjectKey, predicate, objectKey]
    );
    return result.rowCount === 1;
  }

  /**
   * The other half of the observation gate: candidates that have now cleared it become facts and
   * stop being candidates. Only the key holder can seal a document or build a blind index, so it
   * supplies both through `prepare`; everything that has to happen together - supersession, the
   * `derived_from` links back to the episodes that vouched for the fact, and the removal of the
   * candidate row - happens in one transaction per candidate, so a crash cannot leave a promoted
   * fact whose candidate would be promoted again on the next pass.
   *
   * `prepare` returning null leaves the candidate exactly where it is. That is the right answer
   * when the caller cannot open the draft, and it is why nothing here is ever destructive on its
   * own: a candidate only disappears once it has become something.
   */
  async promoteMemoryFactCandidates(
    workspaceId: string,
    prepare: (
      candidate: MemoryFactCandidateRecord
    ) => Promise<PreparedMemoryFact | null> | PreparedMemoryFact | null,
    options: { minEpisodes?: number; minGapHours?: number; limit?: number } = {}
  ): Promise<MemoryFactPromotion[]> {
    const candidates = await this.listPromotableMemoryFactCandidates(workspaceId, options);
    const promoted: MemoryFactPromotion[] = [];
    for (const candidate of candidates) {
      // A predicate that has left the vetted in-repo registry can never become a fact, so its
      // candidates are not held for a review that will never come.
      if (!memoryPredicate(candidate.predicate)) {
        await this.deleteMemoryFactCandidate(
          workspaceId,
          candidate.subjectKey,
          candidate.predicate,
          candidate.objectKey
        );
        continue;
      }
      const prepared = await prepare(candidate);
      if (!prepared) continue;
      // The fact that gets minted has to be the one that was actually observed twice; the keyed
      // subject and object are the only handles the store has on that identity.
      if (
        prepared.index.subjectKey !== candidate.subjectKey ||
        prepared.index.objectKey !== candidate.objectKey
      )
        throw new AthanorError(
          'memory_promotion_mismatch',
          'A promoted fact must carry the subject and object of the candidate it came from'
        );
      const result = await this.database.transaction(async (transaction) => {
        const recorded = await this.#recordMemoryFact(transaction, {
          userId: prepared.userId,
          workspaceId,
          trust: prepared.trust ?? 'derived',
          documentCiphertext: prepared.documentCiphertext,
          index: prepared.index,
          predicate: candidate.predicate,
          observedAt: prepared.observedAt ?? candidate.lastSeen,
          validFrom: prepared.validFrom ?? candidate.lastSeen,
          taskId: prepared.taskId ?? null,
          episodeId: candidate.episodeIds.at(-1) ?? null
        });
        for (const episodeId of candidate.episodeIds)
          await transaction.query(
            `INSERT INTO mem.link(src_id,dst_id,rel)
             SELECT $1,$2,'derived_from' FROM mem.item WHERE id=$2 AND workspace_id=$3
             ON CONFLICT DO NOTHING`,
            [recorded.item.id, episodeId, workspaceId]
          );
        await transaction.query(
          `DELETE FROM mem.fact_candidate
           WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
          [workspaceId, candidate.subjectKey, candidate.predicate, candidate.objectKey]
        );
        return recorded;
      });
      promoted.push({ candidate, item: result.item, supersededIds: result.supersededIds });
    }
    return promoted;
  }

  /**
   * Two things the owner stated that genuinely conflict are never auto-resolved: both go to
   * `disputed`, neither is retrieved by default, and the pair surfaces in the review queue.
   */
  async markMemoryFactsDisputed(workspaceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // The status and the contradiction links are one statement of the same fact - these two
    // disagree, here is which two. Half of it is worse than none: items marked disputed with no
    // links leave the review queue unable to say what they conflict with, and links with no status
    // change leave both values live and retrievable while the graph says they contradict.
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE mem.item SET status='disputed', updated_at=NOW()
         WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND status='active'`,
        [workspaceId, [...ids]]
      );
      for (const [index, left] of ids.entries())
        for (const right of ids.slice(index + 1))
          await transaction.query(
            `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'contradicts')
             ON CONFLICT DO NOTHING`,
            [left, right]
          );
      return result.rowCount;
    });
  }

  async retractMemoryItem(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.item SET status='retracted', retired_at=NOW(), valid_to=COALESCE(valid_to,NOW()),
                           neg_count=neg_count+1, updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND status <> 'retracted'`,
      [workspaceId, id]
    );
    return result.rowCount === 1;
  }

  /** Records the outcome of injecting an item so salience and procedure health stay honest. */
  async recordMemoryUse(input: {
    workspaceId: string;
    itemIds: readonly string[];
    taskId?: string | null;
    cited?: boolean;
    outcome?: MemoryUseOutcome;
    usedAt?: Date | string;
  }): Promise<number> {
    if (input.itemIds.length === 0) return 0;
    const workspaceId = input.workspaceId;
    const itemIds = [...input.itemIds];
    const usedAt = input.usedAt ?? null;
    const cited = input.cited ?? false;
    const outcome = input.outcome ?? 'unknown';
    // One event written down twice, so it is written down once. Procedure health counts the
    // item_use rows and salience is recomputed from the counters on the item, and nothing ever
    // derives either from the other - so a crash between these two statements left the two views
    // of the same use disagreeing for as long as the item existed.
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO mem.item_use(id,item_id,workspace_id,task_id,used_at,cited,outcome)
         SELECT gen_random_uuid(), i.id, $1::uuid, $3::uuid, COALESCE($4::timestamptz,NOW()),
                $5::boolean, $6::text
         FROM mem.item i WHERE i.id = ANY($2::uuid[]) AND i.workspace_id=$1::uuid`,
        [workspaceId, itemIds, input.taskId ?? null, usedAt, cited, outcome]
      );
      const updated = await transaction.query(
        `UPDATE mem.item SET
           use_count=use_count+1,
           last_used_at=COALESCE($3::timestamptz,NOW()),
           cited_count=cited_count + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
           ok_count=ok_count + CASE WHEN $5::text='ok' THEN 1 ELSE 0 END,
           fail_count=fail_count + CASE WHEN $5::text='fail' THEN 1 ELSE 0 END,
           updated_at=NOW()
         WHERE id = ANY($2::uuid[]) AND workspace_id=$1::uuid`,
        [workspaceId, itemIds, usedAt, cited, outcome]
      );
      return updated.rowCount;
    });
  }

  async verifyMemoryProcedure(
    workspaceId: string,
    id: string,
    verifiedAt?: Date | string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.item SET last_verified=COALESCE($3,NOW()), updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND kind='procedure'`,
      [workspaceId, id, verifiedAt ?? null]
    );
    return result.rowCount === 1;
  }

  /**
   * The review queue. A procedure that stops being injected is never deleted for the owner: it is
   * listed here as "verify or delete", because silently dropping it destroys the audit trail.
   *
   * Two questions decide membership and they mean opposite things to whoever is reading: a
   * procedure nobody has confirmed in a season may be perfectly good and merely unused, while one
   * that failed three of its last five uses is broken now. The statement has always computed both
   * and returned neither, and the only caller kept the ids - so the queue three documents promise
   * could be listed but not explained. `reason` and the two recent counters are the rest of that
   * answer, and they cost nothing: the LATERAL already produces them.
   */
  async listStaleMemoryProcedures(
    workspaceId: string,
    options: { now?: Date | string; staleDays?: number; minSuccessRate?: number } = {}
  ): Promise<MemoryProcedureReviewRecord[]> {
    const result = await this.database.query(
      `SELECT i.*,
         COALESCE(health.ok_recent,0)::int AS ok_recent,
         COALESCE(health.graded_recent,0)::int AS graded_recent,
         (COALESCE(i.last_verified, i.observed_at)
            <= COALESCE($2::timestamptz, NOW()) - make_interval(days => $3::int)) AS unverified,
         (health.graded_recent > 0
          AND health.ok_recent / health.graded_recent < $4::float8) AS failing
       FROM mem.item i
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.outcome='ok')::float8 AS ok_recent,
                count(*) FILTER (WHERE r.outcome<>'unknown')::float8 AS graded_recent
         FROM (SELECT u.outcome FROM mem.item_use u WHERE u.item_id=i.id
               ORDER BY u.used_at DESC, u.id LIMIT 5) r
       ) health ON TRUE
       WHERE i.workspace_id=$1 AND i.kind='procedure' AND i.status='active'
         AND (COALESCE(i.last_verified, i.observed_at)
                <= COALESCE($2::timestamptz, NOW()) - make_interval(days => $3::int)
              OR (health.graded_recent > 0
                  AND health.ok_recent / health.graded_recent < $4::float8))
       ORDER BY i.observed_at, i.id`,
      [
        workspaceId,
        options.now ?? null,
        Math.trunc(options.staleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
        options.minSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE
      ]
    );
    return result.rows.map((row) => {
      const unverified = row.unverified === true;
      const failing = row.failing === true;
      return {
        ...mapMemoryItem(row),
        reason: unverified && failing ? 'both' : failing ? 'failing' : 'unverified',
        recentOkCount: Number(row.ok_recent),
        recentGradedCount: Number(row.graded_recent)
      };
    });
  }

  /**
   * The other half of the queue: two things the owner said that contradict each other.
   *
   * `markMemoryFactsDisputed` writes the status and the `contradicts` links as one statement of one
   * fact, and the status alone cannot be shown to anybody - "this is disputed" with no answer to
   * "with what" is not a thing a person can act on. Both sides come back in one read rather than
   * through `listMemoryLinks` per row, because a review surface that issues a query per item is the
   * shape the sidebar spent a release paying for.
   *
   * Ordered oldest first, like the procedure queue, so the pair that has been unresolved longest is
   * the one at the top.
   */
  async listDisputedMemoryItems(
    workspaceId: string,
    limit = 200
  ): Promise<Array<MemoryItemRecord & { contradicts: string[] }>> {
    const result = await this.database.query(
      `SELECT i.*, COALESCE(against.ids, ARRAY[]::uuid[]) AS contradicts
       FROM mem.item i
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT other ORDER BY other) AS ids
         FROM (
           SELECT l.dst_id AS other FROM mem.link l
             WHERE l.src_id=i.id AND l.rel='contradicts'
           UNION
           SELECT l.src_id AS other FROM mem.link l
             WHERE l.dst_id=i.id AND l.rel='contradicts'
         ) sides
       ) against ON TRUE
       WHERE i.workspace_id=$1 AND i.status='disputed'
       ORDER BY i.observed_at, i.id
       LIMIT $2`,
      [workspaceId, Math.max(1, Math.min(Math.trunc(limit), 500))]
    );
    return result.rows.map((row) => ({
      ...mapMemoryItem(row),
      contradicts: ((row.contradicts as string[] | null) ?? []).map(String)
    }));
  }

  /**
   * The fused ranking query. Returns an already-budgeted set in deterministic (kind, id) order, so
   * two calls anchored at the same `now` produce byte-identical packs.
   */
  async recallMemoryCandidates(input: RecallMemoryInput): Promise<MemoryCandidateRecord[]> {
    // The tsquery is assembled inside SQL from this array. Tokens come from the blind index and
    // are alphabetic by construction; anything else could only be a caller bug, and could not
    // match a stored token anyway, so it is dropped rather than allowed to reach the parser.
    const result = await this.database.query(MEMORY_RECALL_SQL, [
      input.workspaceId,
      input.plan.lexemes.filter(isMemoryToken),
      [...input.plan.trigrams],
      [...input.plan.entityKeys],
      [...input.plan.tagTokens],
      input.now ?? new Date(),
      input.plan.temporalIntent,
      // Pinned false rather than removed. No writer on this computer produces an `inferred` row and
      // no caller can ask for one any more, so the clause this feeds is now a guard against a
      // legacy row rather than a switch - and leaving the parameter in place keeps the other
      // twenty-two positions where the query already expects them.
      false,
      input.includeSuperseded ?? false,
      Math.trunc(input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS),
      JSON.stringify(input.quotas ?? MEMORY_PACK_QUOTAS),
      input.asOf ?? null,
      input.kinds ? [...input.kinds] : null,
      input.scope ?? 'default',
      Math.trunc(input.maxItems ?? 60),
      Math.trunc(input.procedureStaleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
      input.procedureMinSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
      input.fuzzyThreshold ?? MEMORY_FUZZY_SIMILARITY_THRESHOLD,
      input.order === 'relevance',
      MEMORY_PACK_DEFAULT_QUOTA.share,
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.cap),
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.perSubject),
      // Ids reach the store from a model-authored tool call by way of the pack, so anything that is
      // not a UUID is dropped here rather than reaching PostgreSQL as a cast error.
      [...new Set((input.excludeIds ?? []).filter((id) => UUID_PATTERN.test(id)))]
    ]);
    return result.rows.map(mapMemoryCandidate);
  }

  /**
   * BM25 over the verbatim layer alone: past conversations, terminal output and tool results, in
   * the same keyed index the curated overlay uses. Bodies come back sealed; only the key holder
   * ever sees what matched.
   */
  async searchMemorySources(input: SearchMemorySourcesInput): Promise<MemorySourceHit[]> {
    const lexemes = input.plan.lexemes.filter(isMemoryToken);
    if (lexemes.length === 0) return [];
    const limit = Math.trunc(input.limit ?? 20);
    const result = await this.database.query(MEMORY_SOURCE_SEARCH_SQL, [
      input.workspaceId,
      lexemes,
      input.taskId ?? null,
      input.since ?? null,
      input.until ?? null,
      limit,
      // Inside a single conversation there is no second thread to make room for, so the cap would
      // only throw away rows the caller asked for by name.
      Math.max(
        1,
        Math.trunc(input.perTask ?? (input.taskId ? limit : MEMORY_SOURCE_SEARCH_PER_TASK))
      )
    ]);
    return result.rows.map((row) => ({ ...mapMemorySource(row), score: Number(row.score) }));
  }

  /**
   * How far back the verbatim layer actually reaches.
   *
   * A search that returns nothing has two completely different meanings - the owner never discussed
   * it, or it happened before this workspace started recording - and an agent that cannot tell them
   * apart will state the first one as fact. Capture began when the memory schema did, so on a
   * computer that has been in use longer than that there is a real horizon, and it is a number
   * rather than a guess.
   */
  async memorySourceCoverage(workspaceId: string): Promise<{
    turns: number;
    conversations: number;
    earliest: string | null;
  }> {
    const result = await this.database.query<{
      turns: string;
      conversations: string;
      earliest: unknown;
    }>(
      `SELECT count(*) AS turns, count(DISTINCT task_id) AS conversations,
              min(occurred_at) AS earliest
       FROM mem.source WHERE workspace_id = $1`,
      [workspaceId]
    );
    const row = result.rows[0];
    return {
      turns: Number(row?.turns ?? 0),
      conversations: Number(row?.conversations ?? 0),
      earliest: row?.earliest ? iso(row.earliest) : null
    };
  }

  /**
   * The verbatim rows around one hit, in the order they happened. `before` and `after` are counts
   * of rows, not bytes: a caller that wants more context asks for more rows.
   */
  async listMemorySourceWindow(
    workspaceId: string,
    sourceId: string,
    window: { before?: number; after?: number } = {}
  ): Promise<MemorySourceRecord[]> {
    const result = await this.database.query(MEMORY_SOURCE_WINDOW_SQL, [
      workspaceId,
      sourceId,
      Math.max(0, Math.trunc(window.before ?? 2)),
      Math.max(0, Math.trunc(window.after ?? 2))
    ]);
    return result.rows.map(mapMemorySource);
  }

  /**
   * Dereferences the ids a memory pack printed. Ids reach the agent as opaque text, so anything
   * that is not a UUID is discarded here rather than reaching PostgreSQL as a cast error - a model
   * quoting an id back imprecisely must get an empty result, never a failed turn.
   */
  async getMemoryItems(workspaceId: string, ids: readonly string[]): Promise<MemoryItemRecord[]> {
    const wanted = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
    if (wanted.length === 0) return [];
    const result = await this.database.query(
      `SELECT * FROM mem.item WHERE workspace_id=$1 AND id = ANY($2::uuid[]) ORDER BY kind, id`,
      [workspaceId, wanted]
    );
    return result.rows.map(mapMemoryItem);
  }

  async getMemoryPack(taskId: string): Promise<MemoryPackRecord | null> {
    const result = await this.database.query('SELECT * FROM mem.pack WHERE task_id=$1', [taskId]);
    return result.rows[0] ? mapMemoryPack(result.rows[0]) : null;
  }

  /**
   * First writer wins. A worker that restarts mid-task re-reads the bytes it already emitted
   * instead of re-ranking against a newer clock, which is what keeps the cached prefix alive.
   */
  async saveMemoryPack(input: {
    taskId: string;
    workspaceId: string;
    bodyCiphertext: EncryptedEnvelope;
    sha256: string;
    itemIds: readonly string[];
    tokensEst: number;
    briefVersion?: string | null;
  }): Promise<MemoryPackRecord> {
    const inserted = await this.database.query(
      `INSERT INTO mem.pack(
         task_id,workspace_id,brief_version,body_ciphertext,sha256,item_ids,tokens_est
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7)
       ON CONFLICT (task_id) DO NOTHING RETURNING *`,
      [
        input.taskId,
        input.workspaceId,
        input.briefVersion ?? null,
        JSON.stringify(input.bodyCiphertext),
        input.sha256,
        [...input.itemIds],
        input.tokensEst
      ]
    );
    if (inserted.rows[0]) return mapMemoryPack(inserted.rows[0]);
    const existing = await this.getMemoryPack(input.taskId);
    if (!existing) throw new AthanorError('memory_pack_missing', 'Memory pack could not be stored');
    return existing;
  }

  /*
   * There is no `deleteMemoryPack(taskId)`. There was, and it had no caller anywhere - not
   * production, not a test, not an eval - while being the simplest signature of the three ways a
   * bundle can be removed, which is the one somebody reaches for.
   *
   * The two that run are the two that are safe, and both are scoped to a workspace rather than to a
   * task: `consolidateMemory` drops the bundles of settled conversations, and `forgetMemoryItem`
   * drops every bundle that quoted a row the owner just deleted. Deleting a live task's bundle on
   * its own has no meaning that is not a bug - the task rebuilds it on its next turn and pays a
   * cache miss for nothing - so the way to remove one is to remove what it was built from.
   */

  /**
   * The nightly pass. Salience is recomputed from raw counters rather than stored decayed, old
   * material is demoted rather than deleted, and every table that could grow without bound is
   * trimmed. Nothing here calls a model: the expensive residue is the caller's business.
   */
  async consolidateMemory(
    workspaceId: string,
    options: {
      now?: Date | string;
      archiveAfterDays?: number;
      useRetentionDays?: number;
      candidateRetentionDays?: number;
      statsRebuildDays?: number;
    } = {}
  ): Promise<MemoryConsolidationReport> {
    const now = options.now ?? null;
    const archiveAfterDays = Math.trunc(options.archiveAfterDays ?? 730);
    const useRetentionDays = Math.trunc(options.useRetentionDays ?? 180);
    const candidateRetentionDays = Math.trunc(options.candidateRetentionDays ?? 180);
    const statsRebuildDays = Math.trunc(options.statsRebuildDays ?? 30);

    // Reliability and usage dominate retention decisions; "did this match the last query" is
    // deliberately not an input, because it is exactly the signal that over-weights recency.
    const salience = await this.database.query(
      `WITH usage AS (
         SELECT i.id, i.pin,
                COALESCE(NULLIF(i.neg_count,0)::float8 / NULLIF(i.use_count,0), 0) AS neg_rate,
                count(u.id) FILTER (
                  WHERE u.used_at > COALESCE($2::timestamptz,NOW()) - INTERVAL '90 days'
                )::float8 AS uses,
                count(u.id) FILTER (
                  WHERE u.cited
                    AND u.used_at > COALESCE($2::timestamptz,NOW()) - INTERVAL '90 days'
                )::float8 AS cites
         FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
         WHERE i.workspace_id=$1
         GROUP BY i.id, i.pin, i.neg_count, i.use_count
       ),
       moments AS (
         SELECT AVG(uses) AS mu, COALESCE(STDDEV_POP(uses),0) AS su,
                AVG(cites) AS mc, COALESCE(STDDEV_POP(cites),0) AS sc
         FROM usage
       )
       UPDATE mem.item SET salience =
           0.50 * COALESCE((g.uses - m.mu) / NULLIF(m.su,0), 0)
         + 0.20 * COALESCE((g.cites - m.mc) / NULLIF(m.sc,0), 0)
         - 0.30 * g.neg_rate
         + CASE WHEN g.pin THEN 1.0 ELSE 0.0 END,
         updated_at=NOW()
       FROM usage g, moments m
       WHERE mem.item.id = g.id`,
      [workspaceId, now]
    );
    // An episode lends part of its salience to what was extracted from it, so a fact from a
    // heavily used episode outranks an equally unused fact from a forgotten one.
    await this.database.query(
      `UPDATE mem.item SET salience = mem.item.salience + 0.20 * GREATEST(e.salience, 0)
       FROM mem.item e
       WHERE mem.item.workspace_id=$1 AND mem.item.episode_id = e.id AND e.kind='episode'`,
      [workspaceId]
    );

    // Compaction never deletes verbatim text: items are demoted to 'archived' and sources merely
    // leave the lexical index. Anything pinned or cited by a live item is exempt.
    const archived = await this.database.query(
      `UPDATE mem.item SET status='archived', updated_at=NOW()
       WHERE workspace_id=$1 AND status='active' AND NOT pin
         AND observed_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (SELECT 1 FROM mem.link l WHERE l.dst_id=mem.item.id)`,
      [workspaceId, now, archiveAfterDays]
    );
    const unindexed = await this.database.query(
      `UPDATE mem.source SET indexed=FALSE, body_tokens=''
       WHERE workspace_id=$1 AND indexed
         AND occurred_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (SELECT 1 FROM mem.evidence e WHERE e.source_id=mem.source.id)`,
      [workspaceId, now, archiveAfterDays]
    );

    const uses = await this.database.query(
      `DELETE FROM mem.item_use
       WHERE workspace_id=$1
         AND used_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, useRetentionDays]
    );
    const candidates = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1
         AND last_seen < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, candidateRetentionDays]
    );
    const packs = await this.database.query(
      `DELETE FROM mem.pack WHERE workspace_id=$1 AND task_id IN (
         SELECT t.id FROM tasks t
         WHERE t.id=mem.pack.task_id AND t.status IN ('completed','failed','cancelled')
       )`,
      [workspaceId]
    );

    // The AFTER INSERT trigger keeps document frequency fresh but never subtracts, so archived
    // items and unindexed sources leave their lexemes counted forever and IDF drifts low. The full
    // rebuild is too expensive to run nightly, so this pass is where its own cadence is kept -
    // there is no other timer in the product that knows a workspace has memory in it.
    const drifted = await this.database.query<{ stale: boolean }>(
      `SELECT refreshed_at <= COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
                AS stale
       FROM mem.corpus_stats WHERE workspace_id=$1`,
      [workspaceId, now, statsRebuildDays]
    );
    const corpusStatsRebuilt = drifted.rows[0]?.stale === true;
    if (corpusStatsRebuilt) await this.rebuildMemoryCorpusStats(workspaceId);

    const stale = await this.listStaleMemoryProcedures(
      workspaceId,
      options.now ? { now: options.now } : {}
    );
    return {
      salienceUpdated: salience.rowCount,
      itemsArchived: archived.rowCount,
      sourcesUnindexed: unindexed.rowCount,
      usesPruned: uses.rowCount,
      candidatesPruned: candidates.rowCount,
      packsPruned: packs.rowCount,
      staleProcedureIds: stale.map((item) => item.id),
      corpusStatsRebuilt
    };
  }

  /**
   * Monthly full rebuild of the corpus statistics. Doing this nightly would be a sequential scan
   * plus a hash aggregate over every lexeme; the AFTER INSERT trigger keeps df fresh in between.
   *
   * Single-occurrence lexemes are kept. Discarding them saved a fraction of a table that the
   * insert trigger repopulates anyway - the trigger writes df=1 for every lexeme of every row it
   * indexes - and it cost the one distinction retrieval most needs: a term in exactly one document
   * is the most discriminative term there is, and a term in no document cannot match at all. With
   * the df=1 rows dropped those two cases were indistinguishable, so the query planner had to treat
   * the rarest terms as if they were unknown.
   */
  async rebuildMemoryCorpusStats(workspaceId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query('DELETE FROM mem.lexeme_df WHERE workspace_id=$1', [workspaceId]);
      await transaction.query(
        // Guarded like every sibling upsert in this file, and for a reason this one has of its own:
        // the AFTER INSERT trigger on a memory write puts a df=1 row into this very table, so a
        // single episode the agent records between the DELETE above and this INSERT re-creates a
        // key the count is about to claim. Unguarded that was a unique violation that took the
        // whole transaction with it, leaving the workspace with no document frequencies at all
        // until the next monthly run - every term's df defaulting to 1, IDF uniform, and recall
        // ranking silently flat for a month with nothing anywhere reporting it.
        `INSERT INTO mem.lexeme_df(workspace_id, lexeme, df)
         SELECT $1, u.lexeme, count(*) FROM (
           SELECT tsv FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d CROSS JOIN LATERAL unnest(d.tsv) u
         GROUP BY u.lexeme
         ON CONFLICT (workspace_id, lexeme) DO UPDATE SET df = EXCLUDED.df`,
        [workspaceId]
      );
      await transaction.query(
        `INSERT INTO mem.corpus_stats(workspace_id,n_docs,sum_len,refreshed_at)
         SELECT $1, count(*), COALESCE(SUM(tsv_len),0), NOW() FROM (
           SELECT tsv_len FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv_len FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d
         ON CONFLICT (workspace_id) DO UPDATE
           SET n_docs=EXCLUDED.n_docs, sum_len=EXCLUDED.sum_len, refreshed_at=EXCLUDED.refreshed_at`,
        [workspaceId]
      );
    });
  }

  /**
   * Removal, not retirement.
   *
   * `retractMemoryItem` above sets a status: the row stops being recalled and every word of it
   * stays on disk. That is the right answer when the agent decides something has stopped being
   * true, and the wrong one when an owner says to forget it, because an owner told a line is gone
   * has to be right. The verbatim chunks go with it - `mem.source` holds the request as typed, and
   * reaches its episode by a link that is set to null rather than followed on delete, so removing
   * the episode alone would leave those words on disk with nothing left pointing at them.
   *
   * The bundle is the statement that decides whether any of this is true from where the agent is
   * standing. A task assembles its memory once, seals the rendered text into `mem.pack`, and re-uses
   * those exact bytes on every later turn without reading the rows again - that is what keeps the
   * cached prompt prefix alive. Deleting the rows and leaving the bundle would mean a conversation
   * that is merely parked, and can be parked for weeks, goes on reciting the line the owner just
   * deleted. So every bundle that quoted this row or its chunks goes too, and those tasks pay one
   * rebuild on their next turn.
   *
   * It lived in the delete route until Wave 7.3, which is why it had no test: six statements that
   * have to agree about what "gone" means, reachable only through HTTP. They are store statements,
   * they are the counterpart of `retractMemoryItem` beside them, and `store.test.ts` now asserts
   * all four copies are reached.
   */
  forgetMemoryItem(workspaceId: string, itemId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const chunks = await transaction.query<{ id: string }>(
        'DELETE FROM mem.source WHERE workspace_id=$1 AND episode_id=$2 RETURNING id',
        [workspaceId, itemId]
      );
      /*
       * The half of this statement that is load-bearing is `dst_id`, and nothing but this comment
       * says so. `mem.link.src_id` REFERENCES `mem.item(id) ON DELETE CASCADE`; `dst_id` is
       * `UUID NOT NULL` and references nothing at all. So the `src_id` arm is belt-and-braces over a
       * cascade the database already performs, and the `dst_id` arm is the only thing standing
       * between a deleted row and a `supersedes` edge that still points at it by id.
       *
       * The same asymmetry is why `mem.evidence` and `mem.item_use` need no statement here: both
       * carry a real cascading foreign key to `mem.item`, so the row's evidence and its usage
       * history go with it untouched. A future migration that ADDS the missing `dst_id` foreign key
       * makes this whole statement redundant and no test will notice, because a redundant DELETE
       * and a necessary one look identical from the outside - the row is gone either way.
       */
      await transaction.query('DELETE FROM mem.link WHERE src_id=$1 OR dst_id=$1', [itemId]);
      // A bundle cites verbatim chunks by their own id alongside the items, so both go into the
      // overlap test: matching on the item alone would leave the owner's own words quoted.
      await transaction.query(
        'DELETE FROM mem.pack WHERE workspace_id=$1 AND item_ids && $2::uuid[]',
        [workspaceId, [itemId, ...chunks.rows.map((chunk) => chunk.id)]]
      );
      /*
       * And the turn stops vouching for anything it was about to prove. A drafted fact waits in
       * `mem.fact_candidate` until two separate turns have observed it, holding a sealed draft and
       * the ids of the turns that vouched for it. Nothing reads that table on recall, so it is not
       * the lie the bundle above was - but leaving this turn's vote in it means a line the owner
       * deleted can still be half of what makes athanor believe something later, from a record they
       * were told was gone. A draft with no turn left behind it is not a draft.
       *
       * Two statements, in this order, and the order is the whole of it. The sole-witness drafts go
       * first; only then does every surviving draft lose this turn's vote.
       *
       * It used to be the other way round - one UPDATE flooring the counter with
       * `GREATEST(n_episodes - 1, 1)`, then a DELETE sweeping whatever it had emptied - and the
       * floor was not a safety net but a workaround for the column's own `CHECK (n_episodes > 0)`.
       * Between the two statements a draft whose only witness had just been deleted sat at
       * `n_episodes = 1` with an EMPTY `episode_ids`, which is a fact this box believes two turns
       * observed and can name neither. Nothing but the adjacency of the two lines kept that state
       * from being read, and `listPromotableMemoryFactCandidates(minEpisodes: 1)` reads exactly it.
       *
       * Written this way the intermediate state cannot exist, the counter is decremented honestly
       * rather than floored, and the CHECK stops being something to work around and becomes the
       * guard: delete the first statement and the second one violates it, so the transaction fails
       * loudly instead of promoting a fact no surviving turn ever observed.
       *
       * `array_remove` rather than a cardinality test on the raw column, because it strips every
       * occurrence - a draft that somehow listed the same episode twice is still sole-witness.
       * `n_episodes` is not re-derived from the array: `observeMemoryFactCandidate` caps the array
       * at 32 ids while the counter keeps climbing, so on a well-observed draft they legitimately
       * disagree and `cardinality()` would silently reset the count to 31.
       */
      await transaction.query(
        `DELETE FROM mem.fact_candidate
          WHERE workspace_id=$1 AND $2::uuid = ANY(episode_ids)
            AND cardinality(array_remove(episode_ids, $2::uuid)) = 0`,
        [workspaceId, itemId]
      );
      await transaction.query(
        `UPDATE mem.fact_candidate
            SET episode_ids = array_remove(episode_ids, $2::uuid),
                n_episodes = n_episodes - 1
          WHERE workspace_id=$1 AND $2::uuid = ANY(episode_ids)`,
        [workspaceId, itemId]
      );
      const removed = await transaction.query(
        'DELETE FROM mem.item WHERE workspace_id=$1 AND id=$2',
        [workspaceId, itemId]
      );
      return removed.rowCount === 1;
    });
  }
}
