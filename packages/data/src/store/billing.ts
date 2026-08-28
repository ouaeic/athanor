import { randomUUID } from 'node:crypto';
import {
  assertTimeZone,
  evaluateSpendCaps,
  localDayKey,
  readRoutingMetadata,
  roundUsd,
  spendWindowBounds
} from '@athanor/core';
import type { EncryptedEnvelope, SpendWindowInput } from '@athanor/core';
import { DEFAULT_SPEND_WARN_PERCENT } from '@athanor/contracts';
import type { SpendBucket, SpendDecision, SpendLimits, SpendSummary } from '@athanor/contracts';
import type { Database } from '../database.js';
import type { SpendAlertRecord, SpendLimitsRecord } from '../types.js';
import { iso, json, mapSpendLimits, numericOrNull, optionalText } from './rows.js';
import { COMMITTED_TASK_STATUSES } from './sql/tasks.js';

const providerRefModelId = (providerRef: string | undefined): string | null => {
  const separator = providerRef?.indexOf(':') ?? -1;
  return providerRef && separator > 0 ? providerRef.slice(separator + 1) : null;
};

/**
 * What this box stops at when nobody has told it to stop anywhere.
 *
 * Everything under this line has been complete for four waves - a pre-flight guard, a per-step halt,
 * an alert per window, a pane drawing all three - and every cap shipped `null`, so the whole
 * apparatus refused nothing on a fresh install. A brake nobody sets is a brake.
 *
 * One number, not three, and the month rather than the day. A day cannot tell a runaway from a heavy
 * afternoon, so a guessed daily ceiling buys its safety by stopping real work; the day is the owner's
 * knob. The month is the window nothing else covers. One turn is already bounded four ways -
 * `TASK_MAX_STEPS` times `TASK_MAX_SELF_CONTINUATIONS`, `TURN_WALL_CLOCK_MS`, `maxComputeCredits`,
 * and the thrash breakers in `turn-bounds.ts` - so the runaway turn was never the exposure. The sum
 * is: a fifteen-minute schedule, ninety-six individually reasonable runs a day, which only a window
 * longer than a turn can see. The monthly one catches it inside the first day.
 *
 * `defaultTaskCapUsd` stays unset on the ruling `POST /v1/providers` reached independently: it is
 * enforced by reserving its whole value the moment work is queued - `openSpendCommitmentIn` below -
 * so a guess there refuses the third conversation of the morning over money nobody has spent.
 *
 * A hundred is a threshold, not a measurement: above a month of ordinary use, below the figure an
 * owner would be angry to discover, and cheap to get wrong in either direction because the halt is
 * not destructive - `spendHalt` pauses a resumable task and names the number in the line the owner
 * reads, so a wrong guess costs one settings edit and no guess costs whatever the provider will bill.
 *
 * This is not the seed at `POST /v1/providers`, which asks at the keyboard and writes the answer -
 * including the daily cap, which an owner who was asked has chosen and an owner who was never asked
 * has not. That route only fires when a managed provider is configured through the API; a box whose
 * key arrives as `AI_API_KEY` or `OPENROUTER_API_KEY`, which is the documented self-hosted install,
 * is never asked and had nothing. This is the backstop for those.
 */
export const DEFAULT_MONTHLY_CAP_USD = 100;

/**
 * The monthly ceiling as the guard and the pane must both see it, from one place.
 *
 * `spendGuardIn` reads `spend_limits` for itself and `effectiveSpendLimits` reads it again two
 * hundred lines further down, which is how a default could be added to the surface the owner looks
 * at while the brake that stops the work carried on with `null`. Both go through here.
 *
 * A stored row is the owner's answer in full, nulls included: an explicit `null` is "no ceiling,
 * thank you" and is answered for good. No row at all is nobody having asked them, and that is the
 * only case this speaks for - `monthly_cap_usd` is NULL for both, and the row's absence is the only
 * thing in the schema that tells them apart.
 *
 * ⚠ Which leaves one writer it cannot see: `athanor price-ceiling set` - renamed from
 * `spend-ceiling`, which is the name to grep for in anything written before the rename - inserts
 * into `spend_limits` in raw SQL to store the two price ceilings, and any row at all takes this
 * function out of the conversation for that owner.
 *
 * It used to write that row with every money cap NULL, which took this default off a box whose
 * owner only wanted to cap the price per million tokens. It no longer does: its INSERT arm writes
 * `monthly_cap_usd` with the constant above - read out of this file by `default_monthly_cap` in
 * scripts/athanor, so the two cannot come to disagree - and its UPDATE arm leaves an answer already
 * there alone. `daily_cap_usd` and `default_task_cap_usd` stay NULL on that row, which is what both
 * of them mean anyway.
 *
 * What the row still does is stamp `updated_at`, and `spendCeilingAsk` in the web client reads a
 * non-epoch `updatedAt` as "this owner has been asked" - so an owner who set a price ceiling over
 * ssh is never put the first-run question about money caps. They have the hundred above, and were
 * never told it is what they have.
 *
 * The fix that covers every writer at once still belongs in a migration: a column default on
 * `monthly_cap_usd`. Until then this closes the fresh install and not that.
 */
const cappedMonthlyUsd = (stored: SpendLimitsRecord | null): number | null =>
  stored ? stored.monthlyCapUsd : DEFAULT_MONTHLY_CAP_USD;

/**
 * What a turn is about to cost and what the owner has said it may cost: the model catalogue the
 * price is read from, the `usage_entries` ledger every charge lands in, the three caps, and the one
 * round trip that answers "may this start".
 *
 * `spendGuardIn`, `spendTotalIn`, `openSpendCommitmentIn` and `spendLimitsIn` take the `Database`
 * to run on rather than reaching for the field, and that parameter is load-bearing rather than
 * tidy: `DataStore.materializeTaskSchedule` calls `spendGuardIn` on the transaction handle that
 * also inserts the task, so an unattended schedule reads the ceiling and commits the work it
 * authorises under one handle. Collapse the parameter and the guard reads a total another
 * connection is still free to change before the insert lands.
 */
export class BillingStore {
  constructor(private readonly database: Database) {}

  /** Adds or refreshes the given releases and leaves everything else in the catalogue alone. */
  async upsertModels(models: Array<Record<string, unknown>>): Promise<void> {
    for (const model of models) await this.#upsertModel(this.database, model);
  }

  /**
   * A whole-catalogue refresh. Anything the provider still offers is written and anything it has
   * withdrawn is removed, in one transaction, so a deprecated model stops appearing in the picker
   * instead of failing at the provider the next time a task is routed to it.
   *
   * Three things bound the blast radius. An empty refresh prunes nothing at all, because a provider
   * outage that returned no models must never empty the picker. The delete is scoped to the
   * providers this refresh actually covered, which is what keeps a self-hosted `custom/...` entry
   * and any provider it said nothing about.
   *
   * And a model something is still pinned to is retired rather than deleted. A weekly schedule is
   * the one thing here that runs unattended for months, and it names its model by id: deleting that
   * row turns "the model you chose was withdrawn" into a run that fails every week against a name
   * nothing on the box can resolve. Retiring it says the same thing where the owner is already
   * looking - the picker lists it, greyed, as currently unavailable - and it is not a tombstone,
   * because a provider that brings the model back upserts it live again on the next pass. Only live
   * pins count: a finished task keeps its model id as history, and history reads perfectly well
   * from the id alone.
   */
  async replaceModelCatalog(
    models: Array<Record<string, unknown>>
  ): Promise<{ upserted: number; removed: number; retired: number }> {
    if (models.length === 0) return { upserted: 0, removed: 0, retired: 0 };
    const ids = models.map((model) => String(model.id));
    const providers = [...new Set(models.map((model) => String(model.provider)))];
    return this.database.transaction(async (transaction) => {
      for (const model of models) await this.#upsertModel(transaction, model);
      const withdrawn = `provider = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`;
      const pinned = `id IN (
           SELECT model_id FROM task_schedules WHERE enabled
           UNION SELECT model_id FROM tasks
             WHERE status NOT IN ('completed','failed','cancelled')
         )`;
      const retired = await transaction.query(
        `UPDATE model_releases SET availability='unavailable', updated_at=NOW()
         WHERE ${withdrawn} AND ${pinned} AND availability <> 'unavailable'`,
        [providers, ids]
      );
      const removed = await transaction.query(
        `DELETE FROM model_releases WHERE ${withdrawn} AND NOT (${pinned})`,
        [providers, ids]
      );
      return { upserted: models.length, removed: removed.rowCount, retired: retired.rowCount };
    });
  }

  async #upsertModel(database: Database, model: Record<string, unknown>): Promise<void> {
    await database.query(
      `INSERT INTO model_releases(
        id,provider_model_id,display_name,provider,revision,availability,openness,license,commercial_use,
        privacy_route,context_tokens,modalities,capabilities,usage_class,recommendation_tags,
        measured_quality,measured_latency_ms,metadata,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17,$18::jsonb,NOW())
      ON CONFLICT(id) DO UPDATE SET
        provider_model_id=EXCLUDED.provider_model_id,
        display_name=EXCLUDED.display_name, provider=EXCLUDED.provider,
        revision=EXCLUDED.revision, availability=EXCLUDED.availability,
        openness=EXCLUDED.openness, license=EXCLUDED.license,
        commercial_use=EXCLUDED.commercial_use, privacy_route=EXCLUDED.privacy_route,
        context_tokens=EXCLUDED.context_tokens, modalities=EXCLUDED.modalities,
        capabilities=EXCLUDED.capabilities, usage_class=EXCLUDED.usage_class,
        recommendation_tags=EXCLUDED.recommendation_tags,
        measured_quality=EXCLUDED.measured_quality,
        measured_latency_ms=EXCLUDED.measured_latency_ms,
        metadata=EXCLUDED.metadata, updated_at=NOW()`,
      [
        model.id,
        model.providerModelId,
        model.displayName,
        model.provider,
        model.revision,
        model.availability,
        model.openness,
        model.license,
        model.commercialUse,
        model.privacyRoute,
        model.contextTokens,
        JSON.stringify(model.modalities),
        JSON.stringify(model.capabilities),
        model.usageClass,
        JSON.stringify(model.recommendationTags),
        model.measuredQuality,
        model.measuredLatencyMs,
        JSON.stringify({
          ...(typeof model.metadata === 'object' && model.metadata ? model.metadata : {}),
          // The fields an unattended server routes on - provenance, retirement, cache style, price
          // tiers, output ceiling - travel through one contract rather than a hand-written list
          // here and a second one in listModels. Two lists is how they silently fell behind the
          // type and were dropped in transit, which made the whole routing layer inert.
          ...readRoutingMetadata(model),
          inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
          outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
          benchmarkRank: model.benchmarkRank ?? null,
          benchmarkSource: model.benchmarkSource ?? null,
          benchmarkUpdatedAt: model.benchmarkUpdatedAt ?? null,
          agenticQuality: model.agenticQuality ?? null,
          codingQuality: model.codingQuality ?? null,
          intelligenceQuality: model.intelligenceQuality ?? null,
          // JSON.stringify drops undefined, which is what keeps "the refresh never reported
          // availability" distinguishable from a live `false`; the privacy projection only
          // applies to catalogues that actually carry live endpoint data.
          providerAvailable: model.providerAvailable,
          zeroDataRetentionAvailable: model.zeroDataRetentionAvailable
        })
      ]
    );
  }

  async listModels(): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query('SELECT * FROM model_releases ORDER BY display_name');
    return result.rows.map((row) => {
      const metadata = json<Record<string, unknown>>(row.metadata ?? {});
      return {
        id: String(row.id),
        providerModelId: String(row.provider_model_id),
        displayName: String(row.display_name),
        provider: String(row.provider),
        revision: String(row.revision),
        availability: String(row.availability),
        openness: String(row.openness),
        license: String(row.license),
        commercialUse: Boolean(row.commercial_use),
        privacyRoute: String(row.privacy_route),
        contextTokens: Number(row.context_tokens),
        modalities: json(row.modalities),
        capabilities: json(row.capabilities),
        usageClass: String(row.usage_class),
        recommendationTags: json(row.recommendation_tags),
        measuredQuality: row.measured_quality === null ? null : Number(row.measured_quality),
        measuredLatencyMs:
          row.measured_latency_ms === null ? null : Number(row.measured_latency_ms),
        inputUsdPerMillionTokens:
          typeof metadata.inputUsdPerMillionTokens === 'number'
            ? metadata.inputUsdPerMillionTokens
            : null,
        outputUsdPerMillionTokens:
          typeof metadata.outputUsdPerMillionTokens === 'number'
            ? metadata.outputUsdPerMillionTokens
            : null,
        benchmarkRank: typeof metadata.benchmarkRank === 'number' ? metadata.benchmarkRank : null,
        benchmarkSource:
          typeof metadata.benchmarkSource === 'string' ? metadata.benchmarkSource : null,
        benchmarkUpdatedAt:
          typeof metadata.benchmarkUpdatedAt === 'string' ? metadata.benchmarkUpdatedAt : null,
        agenticQuality:
          typeof metadata.agenticQuality === 'number' ? metadata.agenticQuality : null,
        codingQuality: typeof metadata.codingQuality === 'number' ? metadata.codingQuality : null,
        intelligenceQuality:
          typeof metadata.intelligenceQuality === 'number' ? metadata.intelligenceQuality : null,
        // Rows written before these fields existed must stay undefined rather than become `false`,
        // or the privacy projection would read them as "no live endpoint" and hide the catalogue.
        ...(typeof metadata.providerAvailable === 'boolean'
          ? { providerAvailable: metadata.providerAvailable }
          : {}),
        ...(typeof metadata.zeroDataRetentionAvailable === 'boolean'
          ? { zeroDataRetentionAvailable: metadata.zeroDataRetentionAvailable }
          : {}),
        ...readRoutingMetadata(metadata),
        updatedAt: iso(row.updated_at)
      };
    });
  }

  async recordUsage(input: {
    userId: string;
    workspaceId?: string;
    taskId?: string;
    kind: string;
    resourceClass: string;
    quantity: number;
    unit: string;
    credits: number;
    state: 'reserved' | 'settled' | 'released' | 'credited';
    idempotencyKey: string;
    providerRef?: string;
    costUsd?: number;
    modelId?: string;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO usage_entries(
        id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
        idempotency_key,provider_ref,cost_usd,model_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId ?? null,
        input.taskId ?? null,
        input.kind,
        input.resourceClass,
        input.quantity,
        input.unit,
        input.credits,
        input.state,
        input.idempotencyKey,
        input.providerRef ?? null,
        input.costUsd ?? 0,
        // provider_ref is "<provider>:<model>". Splitting it here means callers that already pass
        // the composite reference get an exact per-model spend breakdown without being changed.
        input.modelId ?? providerRefModelId(input.providerRef)
      ]
    );
  }

  async transitionUsage(idempotencyKey: string, from: string, to: string): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE usage_entries SET state = $3 WHERE idempotency_key = $1 AND state = $2',
      [idempotencyKey, from, to]
    );
    return result.rowCount === 1;
  }

  async reservedUsageForTask(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(credits),0) AS credits FROM usage_entries
       WHERE task_id=$1 AND state='reserved'`,
      [taskId]
    );
    return Number(result.rows[0]?.credits ?? 0);
  }

  /**
   * What one task has actually been charged for generated media, which is what the second brake on
   * a runaway generation loop is measured against. Read from the ledger rather than from a job
   * table because the ledger is where the provider's own figure lands.
   *
   * `state='settled' AND cost_usd>0` is the same subset `taskSpend`, `spendTotalIn`, `spendByDay`,
   * `spendByModel` and `spendByTask` read, and this reader carried no state filter at all until
   * Wave 7 - which is the argument the comment above was already making without acting on it. The
   * ledger is append-only and four-valued: a `reserved` row is money nobody has taken yet, a
   * `released` one is a reservation the work never spent, and a `credited` one is money that came
   * back. Counting all four meant one refunded generation shortened the media budget for the whole
   * life of the task, and a reservation that never settled did the same. It failed safe, which is
   * why nothing reported it. The predicate is also exactly `usage_entries_task_spend_idx`, so
   * matching the neighbours is what puts this query on the partial index they already use.
   */
  async mediaSpendForTask(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost FROM usage_entries
       WHERE task_id=$1 AND state='settled' AND cost_usd>0 AND resource_class LIKE 'media:%'`,
      [taskId]
    );
    return Number(result.rows[0]?.cost ?? 0);
  }

  /**
   * Merges rather than replaces, so two devices saving different choices at the same moment do not
   * each erase the other's - the last writer of a key wins, which is the smallest unit anyone
   * actually changed.
   */
  async mergeUserPreferences(
    userId: string,
    patch: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `UPDATE users SET preferences = preferences || $2::jsonb, updated_at = NOW()
       WHERE id = $1 RETURNING preferences`,
      [userId, JSON.stringify(patch)]
    );
    const value = result.rows[0]?.preferences;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  /**
   * The half-typed message for one conversation, or for the one not started yet.
   *
   * Written on a debounce from the client, so this is a hot path for a keyboard: upsert on the
   * unique index rather than read-then-write, and an empty draft deletes the row instead of storing
   * emptiness for every conversation the owner ever opened.
   */
  async saveMessageDraft(input: {
    userId: string;
    workspaceId: string;
    taskId?: string | null;
    bodyCiphertext: EncryptedEnvelope | null;
  }): Promise<void> {
    const taskId = input.taskId ?? null;
    if (!input.bodyCiphertext) {
      await this.database.query(
        `DELETE FROM message_drafts WHERE workspace_id=$1 AND task_id IS NOT DISTINCT FROM $2`,
        [input.workspaceId, taskId]
      );
      return;
    }
    // Two partial unique indexes, so two conflict targets: one insert cannot name both, and the
    // draft with no conversation yet is the one most first sentences are typed into.
    const conflict =
      taskId === null
        ? 'ON CONFLICT (workspace_id) WHERE task_id IS NULL'
        : 'ON CONFLICT (workspace_id, task_id) WHERE task_id IS NOT NULL';
    await this.database.query(
      `INSERT INTO message_drafts(user_id,workspace_id,task_id,body_ciphertext,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,NOW())
       ${conflict}
         DO UPDATE SET body_ciphertext=EXCLUDED.body_ciphertext, updated_at=NOW()`,
      [input.userId, input.workspaceId, taskId, JSON.stringify(input.bodyCiphertext)]
    );
  }

  async listMessageDrafts(
    userId: string,
    workspaceId: string
  ): Promise<
    Array<{ taskId: string | null; bodyCiphertext: EncryptedEnvelope; updatedAt: string }>
  > {
    const result = await this.database.query(
      // `updated_at` travels with the draft because a device cannot otherwise tell a sentence newer
      // than its own from one it wrote and has already moved past. Without it the client could only
      // ever choose "keep mine", so a device that had once seen a draft was frozen on that version
      // for good and would eventually write it back over a newer one.
      `SELECT task_id, body_ciphertext, updated_at FROM message_drafts
       WHERE user_id=$1 AND workspace_id=$2`,
      [userId, workspaceId]
    );
    return result.rows.map((row) => ({
      taskId: optionalText(row.task_id) ?? null,
      bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
      updatedAt: new Date(row.updated_at as string).toISOString()
    }));
  }

  async usageTotals(
    userId: string,
    from: Date,
    to: Date
  ): Promise<{ settled: number; reserved: number }> {
    const result = await this.database.query(
      `SELECT
        COALESCE(SUM(CASE WHEN state = 'settled' THEN credits ELSE 0 END), 0) AS settled,
        COALESCE(SUM(CASE WHEN state = 'reserved' THEN credits ELSE 0 END), 0) AS reserved
       FROM usage_entries WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
         AND kind IN ('workspace_compute','task_compute','media_gpu')`,
      [userId, from.toISOString(), to.toISOString()]
    );
    return {
      settled: Number(result.rows[0]?.settled ?? 0),
      reserved: Number(result.rows[0]?.reserved ?? 0)
    };
  }

  async usageHistory(userId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,cost_usd,state,created_at
       FROM usage_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: optionalText(row.workspace_id),
      taskId: optionalText(row.task_id),
      kind: String(row.kind),
      resourceClass: String(row.resource_class),
      quantity: Number(row.quantity),
      unit: String(row.unit),
      credits: Number(row.credits),
      costUsd: Number(row.cost_usd ?? 0),
      modelId: optionalText(row.model_id),
      state: String(row.state),
      createdAt: iso(row.created_at)
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Spend in real currency.
  //
  // Compute credits price a task against a shared scheduler; they do not price it against a bank
  // account, because the dollars a credit stands for move with the model class. Everything below
  // reads usage_entries.cost_usd, which is what the provider actually billed, so that "stop before
  // this costs me more than X" has one answer regardless of which model the router picked.
  // ---------------------------------------------------------------------------------------------

  async getSpendLimits(userId: string): Promise<SpendLimitsRecord | null> {
    return this.spendLimitsIn(this.database, userId);
  }

  private async spendLimitsIn(db: Database, userId: string): Promise<SpendLimitsRecord | null> {
    const result = await db.query('SELECT * FROM spend_limits WHERE user_id=$1', [userId]);
    const row = result.rows[0];
    return row ? mapSpendLimits(row) : null;
  }

  /**
   * Every field is optional and an omitted field is left alone, because the three caps are set at
   * different moments - a monthly ceiling once, a daily one when a run gets away from you.
   * Clearing a cap is `null`, which is why absent and null cannot be the same thing here.
   *
   * The two price ceilings carry the identical contract for the identical reason, and they need it
   * more: a ceiling is the thing an owner sets once and then does not think about again, so a
   * routine edit to the daily cap that forwarded `undefined` as `null` would silently remove the
   * only brake that works while they are asleep.
   */
  async setSpendLimits(input: {
    userId: string;
    dailyCapUsd?: number | null;
    monthlyCapUsd?: number | null;
    defaultTaskCapUsd?: number | null;
    warnAtPercent?: number;
    timeZone?: string;
    maxInputUsdPerMillionTokens?: number | null;
    maxOutputUsdPerMillionTokens?: number | null;
  }): Promise<SpendLimitsRecord> {
    if (input.timeZone !== undefined) assertTimeZone(input.timeZone);
    const result = await this.database.query(
      `INSERT INTO spend_limits(
         user_id,daily_cap_usd,monthly_cap_usd,default_task_cap_usd,warn_at_percent,time_zone,
         max_input_usd_per_million_tokens,max_output_usd_per_million_tokens
       ) VALUES ($1,$2,$3,$4,COALESCE($5,80),COALESCE($6,'UTC'),$10,$11)
       ON CONFLICT(user_id) DO UPDATE SET
         daily_cap_usd=CASE WHEN $7 THEN $2 ELSE spend_limits.daily_cap_usd END,
         monthly_cap_usd=CASE WHEN $8 THEN $3 ELSE spend_limits.monthly_cap_usd END,
         default_task_cap_usd=CASE WHEN $9 THEN $4 ELSE spend_limits.default_task_cap_usd END,
         warn_at_percent=COALESCE($5,spend_limits.warn_at_percent),
         time_zone=COALESCE($6,spend_limits.time_zone),
         max_input_usd_per_million_tokens=CASE WHEN $12 THEN $10
           ELSE spend_limits.max_input_usd_per_million_tokens END,
         max_output_usd_per_million_tokens=CASE WHEN $13 THEN $11
           ELSE spend_limits.max_output_usd_per_million_tokens END,
         updated_at=NOW()
       RETURNING *`,
      [
        input.userId,
        input.dailyCapUsd ?? null,
        // Deliberately still `?? null` on the INSERT arm, after the opposite was tried.
        //
        // Creating the row is how the monthly default stops applying, so seeding it here looked
        // like the way to stop a first save deleting a ceiling nobody knew they had. It is not:
        // the only production caller of this route is the caps pane, which sends all three caps on
        // every save whether or not the owner touched them, so the seed changed nothing on the
        // real path - and on the one path it did change, a client that deliberately sets a daily
        // cap alone, it invented a monthly ceiling that client had not asked for. "An omitted
        // field is left alone" is this method's contract in its own first line, and a value nobody
        // sent is not a field.
        input.monthlyCapUsd ?? null,
        input.defaultTaskCapUsd ?? null,
        input.warnAtPercent ?? null,
        input.timeZone ?? null,
        input.dailyCapUsd !== undefined,
        input.monthlyCapUsd !== undefined,
        input.defaultTaskCapUsd !== undefined,
        input.maxInputUsdPerMillionTokens ?? null,
        input.maxOutputUsdPerMillionTokens ?? null,
        input.maxInputUsdPerMillionTokens !== undefined,
        input.maxOutputUsdPerMillionTokens !== undefined
      ]
    );
    return mapSpendLimits(result.rows[0]!);
  }

  /** Settled provider cost in a half-open interval, whatever it was spent on. */
  async spendTotal(userId: string, from: Date, to: Date): Promise<number> {
    return this.spendTotalIn(this.database, userId, from, to);
  }

  private async spendTotalIn(db: Database, userId: string, from: Date, to: Date): Promise<number> {
    const result = await db.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3`,
      [userId, from.toISOString(), to.toISOString()]
    );
    return Number(result.rows[0]?.cost_usd ?? 0);
  }

  async taskSpend(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd FROM usage_entries
       WHERE task_id=$1 AND state='settled' AND cost_usd>0`,
      [taskId]
    );
    return Number(result.rows[0]?.cost_usd ?? 0);
  }

  /**
   * The unspent headroom of work that is queued or under way. Without it two tasks started in the
   * same second each see the same settled total, each fit under the cap, and together sail past it.
   */
  async openSpendCommitment(userId: string, excludeTaskId?: string): Promise<number> {
    return this.openSpendCommitmentIn(this.database, userId, excludeTaskId);
  }

  private async openSpendCommitmentIn(
    db: Database,
    userId: string,
    excludeTaskId?: string
  ): Promise<number> {
    const result = await db.query(
      `SELECT COALESCE(SUM(GREATEST(t.max_spend_usd - COALESCE(s.spent,0),0)),0) AS pending
       FROM tasks t
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(u.cost_usd),0) AS spent FROM usage_entries u
         WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0
       ) s ON TRUE
       WHERE t.user_id=$1 AND t.max_spend_usd IS NOT NULL
         AND t.status IN ${COMMITTED_TASK_STATUSES}
         AND ($2::uuid IS NULL OR t.id<>$2::uuid)`,
      [userId, excludeTaskId ?? null]
    );
    return Number(result.rows[0]?.pending ?? 0);
  }

  /**
   * One round trip that answers "may this work start, and should the owner be warned". Callers
   * differ only in the estimate they bring and in whether other open tasks count against them:
   * they do when deciding to start something new, and they must not when a running task is
   * checking itself, or it would block on its own reservation.
   */
  async spendGuard(input: {
    userId: string;
    taskId?: string;
    estimateUsd: number;
    includeOpenCommitments?: boolean;
    /** Ceiling to price the task window against when the task row does not exist yet. */
    taskCapUsd?: number | null;
    now?: Date;
  }): Promise<SpendDecision> {
    return this.spendGuardIn(this.database, input);
  }

  /**
   * Public where the other three `...In` helpers are not, because this one has a caller outside the
   * class: `DataStore.materializeTaskSchedule` runs it on the transaction handle that inserts the
   * task, so an unattended schedule cannot authorise itself against a total another connection is
   * still free to change before that insert commits.
   */
  async spendGuardIn(
    db: Database,
    input: {
      userId: string;
      taskId?: string;
      estimateUsd: number;
      includeOpenCommitments?: boolean;
      taskCapUsd?: number | null;
      now?: Date;
    }
  ): Promise<SpendDecision> {
    const now = input.now ?? new Date();
    const limits = await this.spendLimitsIn(db, input.userId);
    const timeZone = limits?.timeZone ?? 'UTC';
    const bounds = spendWindowBounds(timeZone, now);
    // Sequential rather than concurrent: `db` may be a transaction, which is one client, and two
    // queries in flight on one client is how a transaction ends up interleaved.
    const daily = await this.spendTotalIn(db, input.userId, bounds.daily.start, bounds.daily.end);
    const monthly = await this.spendTotalIn(
      db,
      input.userId,
      bounds.monthly.start,
      bounds.monthly.end
    );
    const pending = input.includeOpenCommitments
      ? await this.openSpendCommitmentIn(db, input.userId, input.taskId)
      : 0;
    const task = input.taskId
      ? await db.query(
          `SELECT t.max_spend_usd,
             (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) AS spent
           FROM tasks t WHERE t.id=$1`,
          [input.taskId]
        )
      : null;

    const taskRow = task?.rows[0];
    const taskCapUsd =
      input.taskCapUsd !== undefined
        ? input.taskCapUsd
        : taskRow
          ? numericOrNull(taskRow.max_spend_usd)
          : null;
    const windows: SpendWindowInput[] = [
      {
        name: 'daily',
        spentUsd: daily,
        pendingUsd: pending,
        capUsd: limits?.dailyCapUsd ?? null,
        startsAt: bounds.daily.start,
        endsAt: bounds.daily.end
      },
      {
        name: 'monthly',
        spentUsd: monthly,
        pendingUsd: pending,
        // The one window this box supplies a ceiling for when nobody has. Read through
        // `cappedMonthlyUsd` rather than off the row, because the brake and the pane that draws it
        // have to be quoting the same number - see the comment on `DEFAULT_MONTHLY_CAP_USD`.
        capUsd: cappedMonthlyUsd(limits),
        startsAt: bounds.monthly.start,
        endsAt: bounds.monthly.end
      }
    ];
    if (taskCapUsd !== null)
      windows.unshift({
        name: 'task',
        spentUsd: Number(taskRow?.spent ?? 0),
        capUsd: taskCapUsd
      });

    return evaluateSpendCaps({
      windows,
      estimateUsd: input.estimateUsd,
      warnAtPercent: limits?.warnAtPercent ?? DEFAULT_SPEND_WARN_PERCENT
    });
  }

  /**
   * Records that a window crossed a threshold, and answers whether this is the first time. The
   * primary key is the window occurrence, so a soft threshold produces one alert for the day it
   * was crossed on rather than one per model call for the rest of it.
   */
  async claimSpendAlert(input: {
    userId: string;
    windowName: 'daily' | 'monthly';
    windowStart: Date;
    level: 'warning' | 'exceeded';
    spentUsd: number;
    capUsd: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO spend_alerts(user_id,window_name,window_start,level,spent_usd,cap_usd)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id,window_name,window_start,level) DO NOTHING`,
      [
        input.userId,
        input.windowName,
        input.windowStart.toISOString(),
        input.level,
        Math.max(0, input.spentUsd),
        Math.max(0, input.capUsd)
      ]
    );
    return result.rowCount === 1;
  }

  async listSpendAlerts(userId: string, limit = 50): Promise<SpendAlertRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM spend_alerts WHERE user_id=$1
       ORDER BY created_at DESC, window_name, window_start DESC, level LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      userId: String(row.user_id),
      windowName: String(row.window_name) as SpendAlertRecord['windowName'],
      windowStart: iso(row.window_start),
      level: String(row.level) as SpendAlertRecord['level'],
      spentUsd: Number(row.spent_usd),
      capUsd: Number(row.cap_usd),
      createdAt: iso(row.created_at)
    }));
  }

  /**
   * Spend grouped by the owner's calendar day. The grouping is done here rather than in SQL so it
   * uses exactly the same zone arithmetic the caps do; a day that shows $4 in the chart and $4 in
   * the cap is the whole point of the surface.
   */
  async spendByDay(userId: string, from: Date, to: Date, timeZone = 'UTC'): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT created_at,cost_usd FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3
       ORDER BY created_at`,
      [userId, from.toISOString(), to.toISOString()]
    );
    const days = new Map<string, SpendBucket>();
    for (const row of result.rows) {
      const key = localDayKey(timeZone, new Date(String(row.created_at)));
      const bucket = days.get(key) ?? { key, costUsd: 0, calls: 0 };
      bucket.costUsd += Number(row.cost_usd);
      bucket.calls += 1;
      days.set(key, bucket);
    }
    return [...days.values()].map((bucket) => ({ ...bucket, costUsd: roundUsd(bucket.costUsd) }));
  }

  async spendByModel(userId: string, from: Date, to: Date, limit = 20): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT COALESCE(model_id,kind) AS key,SUM(cost_usd) AS cost_usd,COUNT(*) AS calls
       FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3
       GROUP BY 1 ORDER BY SUM(cost_usd) DESC, 1 LIMIT $4`,
      [userId, from.toISOString(), to.toISOString(), limit]
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      costUsd: roundUsd(Number(row.cost_usd)),
      calls: Number(row.calls)
    }));
  }

  /**
   * The limits as they are actually applied, with the defaults filled in for an owner who has
   * never opened the settings. The epoch timestamp is how a caller tells a default apart from a
   * deliberate choice that happens to match it.
   */
  async effectiveSpendLimits(userId: string): Promise<SpendLimits> {
    const stored = await this.getSpendLimits(userId);
    return {
      dailyCapUsd: stored?.dailyCapUsd ?? null,
      monthlyCapUsd: cappedMonthlyUsd(stored),
      defaultTaskCapUsd: stored?.defaultTaskCapUsd ?? null,
      warnAtPercent: stored?.warnAtPercent ?? DEFAULT_SPEND_WARN_PERCENT,
      timeZone: stored?.timeZone ?? 'UTC',
      // `?? null` and not `??` onto a default, because there is no default price ceiling: an owner
      // who has never opened the settings has not asked for one, and inventing a number here would
      // be this box quietly refusing routes nobody refused.
      maxInputUsdPerMillionTokens: stored?.maxInputUsdPerMillionTokens ?? null,
      maxOutputUsdPerMillionTokens: stored?.maxOutputUsdPerMillionTokens ?? null,
      updatedAt: stored?.updatedAt ?? new Date(0).toISOString()
    };
  }

  /**
   * Everything the spend surface needs in one call. The breakdowns cover the capped month so the
   * numbers reconcile with the monthly ceiling; the daily series runs a month back from today so
   * the trend is still readable on the first of the month.
   */
  async spendSummary(userId: string, now = new Date()): Promise<SpendSummary> {
    const limits = await this.effectiveSpendLimits(userId);
    const bounds = spendWindowBounds(limits.timeZone, now);
    const seriesStart = new Date(bounds.daily.end.getTime() - 30 * 24 * 60 * 60_000);
    const [decision, byDay, byModel, byTask] = await Promise.all([
      this.spendGuard({ userId, estimateUsd: 0, includeOpenCommitments: true, now }),
      this.spendByDay(userId, seriesStart, bounds.daily.end, limits.timeZone),
      this.spendByModel(userId, bounds.monthly.start, bounds.monthly.end),
      this.spendByTask(userId, bounds.monthly.start, bounds.monthly.end)
    ]);
    return { limits, windows: decision.windows, byDay, byModel, byTask };
  }

  async spendByTask(userId: string, from: Date, to: Date, limit = 20): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT task_id AS key,SUM(cost_usd) AS cost_usd,COUNT(*) AS calls
       FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0 AND task_id IS NOT NULL
         AND created_at>=$2 AND created_at<$3
       GROUP BY 1 ORDER BY SUM(cost_usd) DESC, 1 LIMIT $4`,
      [userId, from.toISOString(), to.toISOString(), limit]
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      costUsd: roundUsd(Number(row.cost_usd)),
      calls: Number(row.calls)
    }));
  }
}
