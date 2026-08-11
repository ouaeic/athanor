import type { MediaModelOption, ModelRelease } from '@athanor/contracts';
import {
  AthanorError,
  RETIREMENT_HORIZON_DAYS,
  type BenchmarkPopulations,
  type ModelPriceTier,
  type RoutableModel
} from '@athanor/core';
import { seedMediaModels } from './catalog.js';
import { currentCommercialLicenseReview } from './license-manifest.js';
import { promptCacheStyleFor, type PromptCacheStyle } from './prompt-cache.js';

/**
 * How much of the provider's catalogue the owner is offered.
 *
 * - `provider_catalog` (default) exposes every model the owner's own provider account can reach.
 *   Athanor never redistributes model weights, so a model's weight licence governs redistribution
 *   rather than API use; it is reported as a badge instead of a gate. New models appear without a
 *   code change, which is what keeps an unattended server working as providers ship releases.
 * - `reviewed_open_weight` restricts selection to models that carry a current independent
 *   commercial-licence review. This is the stricter posture for owners who want to run only
 *   permissively licensed open-weight models, and it fails closed when a review lapses.
 */
export type ModelCatalogScope = 'provider_catalog' | 'reviewed_open_weight';

interface Options {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: Date;
  scope?: ModelCatalogScope;
  /**
   * The catalogue as it stood before this refresh. Zero-retention flags are carried forward from it
   * when the endpoint feed cannot be reached, so one failing request cannot withdraw the owner's
   * private routes on the strength of an outage.
   */
  previous?: ModelRelease[];
}

interface OpenRouterPriceTier {
  min_prompt_tokens?: number;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: OpenRouterPriceTier[];
}

interface ArtificialAnalysisBenchmark {
  intelligence_index?: number;
  coding_index?: number;
  agentic_index?: number;
}

interface DesignArenaEntry {
  arena?: string;
  category?: string;
  elo?: number;
  win_rate?: number;
  rank?: number;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: OpenRouterPricing;
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
  /** Set on the `~vendor/model-latest` entries, which carry no benchmarks of their own. */
  alias_target?: { slug?: string; name?: string } | null;
  reasoning?: { mandatory?: boolean } | null;
  benchmarks?: {
    artificial_analysis?: ArtificialAnalysisBenchmark | null;
    design_arena?: DesignArenaEntry[] | null;
  } | null;
}

/**
 * The endpoint feed is scalar where it was once declared as an object: `latency_last_30m` is a
 * number or null, and it is null on every endpoint observed so far. The uptime fields beside it are
 * populated on all of them, which makes them the reliability signal actually available today.
 */
interface ZdrEndpoint {
  model_id?: string;
  status?: number;
  latency_last_30m?: number | null;
  uptime_last_1d?: number | null;
  supports_implicit_caching?: boolean;
  max_completion_tokens?: number | null;
}

/**
 * A catalogue entry with the live metadata this refresh was able to read. Everything beyond
 * `ModelRelease` is optional, so an entry that predates a field simply does not carry it.
 */
export type CatalogModelRelease = RoutableModel;

const checkedJson = async <T>(response: Response, label: string): Promise<T> => {
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response.json() as Promise<T>;
};

/** Price per million input tokens decides how a run is weighed against the owner's usage windows. */
const usageClassForPrice = (inputUsdPerMillion: number | null): ModelRelease['usageClass'] => {
  if (inputUsdPerMillion === null || !Number.isFinite(inputUsdPerMillion)) return 'medium';
  if (inputUsdPerMillion <= 1) return 'light';
  if (inputUsdPerMillion <= 3) return 'medium';
  if (inputUsdPerMillion <= 10) return 'high';
  return 'extra_high';
};

/**
 * Prices arrive as per-token decimals; scaling by a million in binary floating point leaves noise in
 * the last bits, and a ceiling of exactly $2.00 has to admit a model priced at exactly $2.00.
 */
const perMillion = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
};

const titleCase = (value: string): string =>
  value
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** OpenRouter usually supplies "Vendor: Model"; a bare slug is humanised as a last resort. */
const displayNameFor = (model: OpenRouterModel): string => {
  const provided = model.name?.trim();
  if (provided)
    return provided.includes(': ') ? provided.split(': ').slice(1).join(': ') : provided;
  return titleCase(model.id.split('/').pop() ?? model.id);
};

/**
 * Where a value sits in the population that carries the same measurement: the count at or below it
 * over the count of all of them, so the best-scoring model is 1.0 by construction.
 *
 * This is the whole of the normalisation. The published indices are weighted averages of hard
 * evaluations that no model is meant to approach 100 on - the best in the world scores about 61 on
 * intelligence and 55 on agentic - so dividing by 100 made being benchmarked a penalty against any
 * unmeasured model's prior. A percentile also survives the next index revision without a code
 * change, which the previous scaling did not.
 */
const percentileOf = (value: number, sorted: number[]): number => {
  if (sorted.length === 0) return 0;
  let atOrBelow = 0;
  for (const entry of sorted) {
    if (entry <= value) atOrBelow += 1;
    else break;
  }
  return Math.round((atOrBelow / sorted.length) * 1e4) / 1e4;
};

const sortedFinite = (values: Array<number | null | undefined>): number[] =>
  values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);

/**
 * A design-arena standing is real evidence, and for the 51 models that carry one but no hard-eval
 * index it is the only evidence there is. It is also head-to-head preference on visual and
 * front-end work, so it moves a model inside the middle of the distribution and can never place one
 * above a model measured on hard evaluations.
 */
const ARENA_EVIDENCE_FLOOR = 0.4;
const ARENA_EVIDENCE_SPAN = 0.4;

const bestArenaElo = (entries: DesignArenaEntry[] | null | undefined): number | null => {
  if (!entries?.length) return null;
  const models = entries.filter((entry) => entry.arena === 'models');
  const pool = models.length ? models : entries;
  const elos = pool
    .map((entry) => entry.elo)
    .filter((elo): elo is number => typeof elo === 'number' && Number.isFinite(elo));
  return elos.length ? Math.max(...elos) : null;
};

const derivedTags = (
  supported: Set<string>,
  inputModalities: Set<string>,
  contextTokens: number,
  expiresAt: string | null
): string[] => [
  ...(supported.has('tools') ? ['Tools'] : []),
  ...(supported.has('reasoning') ? ['Reasoning'] : []),
  ...(inputModalities.has('image') ? ['Vision'] : []),
  ...(inputModalities.has('file') ? ['Documents'] : []),
  ...(contextTokens >= 400_000 ? ['Long context'] : []),
  ...(expiresAt ? [`Retires ${expiresAt}`] : [])
];

const priceTiersOf = (pricing: OpenRouterPricing | undefined): ModelPriceTier[] =>
  (pricing?.overrides ?? [])
    .filter((tier) => typeof tier.min_prompt_tokens === 'number')
    .map((tier) => ({
      minPromptTokens: tier.min_prompt_tokens ?? 0,
      inputUsdPerMillionTokens: perMillion(tier.prompt),
      outputUsdPerMillionTokens: perMillion(tier.completion)
    }))
    .sort((left, right) => left.minPromptTokens - right.minPromptTokens);

/**
 * Asks the provider about the credential itself, before anything is saved under it.
 *
 * Neither request below is a check of the key. `/models` and `/endpoints/zdr` are public catalogue
 * routes: both answer 200 to a request carrying no credential at all, so a key with a trailing
 * character, a revoked key, and an account with nothing left to spend all completed the settings
 * screen's "Verify and save" and were written to the database. The first thing that ever read the
 * credential was the owner's next conversation, which failed as a raw 401 in the middle of a task.
 *
 * `/key` is the one route that reads it, it costs nothing, and its answer carries what the key may
 * still spend - so the two failures that are not "wrong key" can be told apart and named.
 */
export const verifyOpenRouterKey = async (options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<void> => {
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(`${options.baseUrl.replace(/\/$/, '')}/key`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401 || response.status === 403)
    throw new AthanorError(
      'provider_key_rejected',
      'The provider did not accept this key. Paste it again whole — a trailing space or a missing character is enough — and check it has not been revoked.',
      422
    );
  if (!response.ok)
    throw new AthanorError(
      'provider_key_uncheckable',
      `The provider answered ${response.status} when asked about this key, so nothing was saved. Try again in a moment.`,
      502
    );
  const body = (await response.json().catch(() => null)) as {
    data?: { limit_remaining?: number | null };
  } | null;
  /*
   * Stated as a number, or not stated at all. A key with no spend limit set reports null here, and
   * an unknown balance must not be reported as an empty one - the point of this call is to stop
   * claiming knowledge it does not have.
   */
  const remaining = body?.data?.limit_remaining;
  if (typeof remaining === 'number' && remaining <= 0)
    throw new AthanorError(
      'provider_credit_exhausted',
      'This key works but has nothing left to spend. Add credit to the provider account, or raise this key’s limit, then verify again.',
      422
    );
};

/**
 * Builds the owner's selectable model catalogue from live OpenRouter metadata.
 *
 * In `reviewed_open_weight` scope this enriches, but can never expand, the independently reviewed
 * licence allowlist. In the default `provider_catalog` scope the allowlist supplies curated
 * defaults and the rest of the provider's chat models are offered alongside them.
 *
 * Two requests, settled independently. The model list carries prices, context, capabilities and
 * benchmarks; the endpoint list carries zero-retention routes and uptime. They used to sit in one
 * `Promise.all`, so a failure on either - and the third, undocumented, user-scoped benchmarks call
 * that is now gone - silently blanked the entire catalogue back to seeds, on an unattended server,
 * for months.
 */
export const refreshOpenRouterCatalog = async (
  allowlist: ModelRelease[],
  options: Options
): Promise<CatalogModelRelease[]> => {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const [modelsResult, zdrResult] = await Promise.allSettled([
    request(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) }).then(
      (response) => checkedJson<{ data?: OpenRouterModel[] }>(response, 'OpenRouter models')
    ),
    request(`${baseUrl}/endpoints/zdr`, {
      headers,
      signal: AbortSignal.timeout(15_000)
    }).then((response) =>
      checkedJson<{ data?: ZdrEndpoint[] }>(response, 'OpenRouter ZDR endpoints')
    )
  ]);
  // Without the model list there is no catalogue to build, so that failure still propagates.
  if (modelsResult.status === 'rejected') throw modelsResult.reason;
  const modelsBody = modelsResult.value;
  const zdrBody = zdrResult.status === 'fulfilled' ? zdrResult.value : null;

  const models = new Map((modelsBody.data ?? []).map((model) => [model.id, model]));
  /*
   * An empty list is an outage wearing a 200, and it has to be refused here rather than believed.
   *
   * `checkedJson` only asks whether the response was ok, so a proxy interstitial, a shape change, or
   * an account with nothing enabled all arrive as a body with no models in it - and the answer built
   * from that is not empty, it is the reviewed allowlist on its own, at availability 'unavailable'
   * because no live endpoint backed any of it. Believing that flattens the catalogue on the settings
   * route and, on the registry's replace, deletes every enriched model on the box and leaves four
   * seeds behind - in both cases without a single failed request to account for it.
   */
  if (models.size === 0)
    throw new AthanorError(
      'provider_catalog_empty',
      'The provider answered but listed no models, so the catalogue was left as it was',
      502
    );
  const zdr = new Map<string, ZdrEndpoint[]>();
  for (const endpoint of zdrBody?.data ?? []) {
    if (!endpoint.model_id || (endpoint.status !== undefined && endpoint.status !== 0)) continue;
    const current = zdr.get(endpoint.model_id) ?? [];
    current.push(endpoint);
    zdr.set(endpoint.model_id, current);
  }
  const previous = new Map((options.previous ?? []).map((model) => [model.id, model]));

  const now = options.now ?? new Date();
  const updatedAt = now.toISOString();
  const retirementHorizon = now.getTime() + RETIREMENT_HORIZON_DAYS * 86_400_000;

  /** An alias entry carries no benchmarks of its own; it inherits its target's. */
  const benchmarksOf = (model: OpenRouterModel | undefined): OpenRouterModel['benchmarks'] => {
    if (!model) return null;
    if (model.benchmarks?.artificial_analysis || model.benchmarks?.design_arena?.length)
      return model.benchmarks;
    const target = model.alias_target?.slug ? models.get(model.alias_target.slug) : undefined;
    return target?.benchmarks ?? model.benchmarks ?? null;
  };

  // The population is the models that were measured in their own right. Aliases inherit a score and
  // must not be counted twice inside the distribution they are then ranked against.
  const measured = [...models.values()].filter((model) => !model.alias_target);
  const intelligenceScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.intelligence_index)
  );
  const codingScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.coding_index)
  );
  const agenticScale = sortedFinite(
    measured.map((model) => model.benchmarks?.artificial_analysis?.agentic_index)
  );
  const arenaScale = sortedFinite(
    measured.map((model) => bestArenaElo(model.benchmarks?.design_arena))
  );
  // The columns do not cover the same models - a live read counted 117 on coding, 108 on agentic and
  // 107 on intelligence - so each percentile reports the count of its own column, and the single
  // number stays only for the overall score, which is the mean of whichever columns a model carried.
  const benchmarkPopulations: BenchmarkPopulations = {
    coding: codingScale.length,
    agentic: agenticScale.length,
    intelligence: intelligenceScale.length
  };
  const benchmarkPopulation = Math.max(
    intelligenceScale.length,
    codingScale.length,
    agenticScale.length
  );

  interface Quality {
    measuredQuality: number | null;
    agenticQuality: number | null;
    codingQuality: number | null;
    intelligenceQuality: number | null;
    agenticIndex: number | null;
    codingIndex: number | null;
    intelligenceIndex: number | null;
    benchmarkSource: string | null;
    benchmarkPopulation: number | null;
    benchmarkPopulations: BenchmarkPopulations | null;
  }

  const qualityOf = (model: OpenRouterModel | undefined): Quality => {
    const benchmarks = benchmarksOf(model);
    const analysis = benchmarks?.artificial_analysis ?? null;
    const index = (value: number | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const agenticIndex = index(analysis?.agentic_index);
    const codingIndex = index(analysis?.coding_index);
    const intelligenceIndex = index(analysis?.intelligence_index);
    const agenticQuality = agenticIndex === null ? null : percentileOf(agenticIndex, agenticScale);
    const codingQuality = codingIndex === null ? null : percentileOf(codingIndex, codingScale);
    const intelligenceQuality =
      intelligenceIndex === null ? null : percentileOf(intelligenceIndex, intelligenceScale);
    const columns = [agenticQuality, codingQuality, intelligenceQuality].filter(
      (value): value is number => value !== null
    );
    if (columns.length)
      return {
        measuredQuality:
          Math.round((columns.reduce((sum, value) => sum + value, 0) / columns.length) * 1e4) / 1e4,
        agenticQuality,
        codingQuality,
        intelligenceQuality,
        agenticIndex,
        codingIndex,
        intelligenceIndex,
        benchmarkSource: 'artificial-analysis',
        benchmarkPopulation,
        benchmarkPopulations
      };
    const elo = bestArenaElo(benchmarks?.design_arena);
    if (elo !== null)
      return {
        measuredQuality:
          Math.round(
            (ARENA_EVIDENCE_FLOOR + ARENA_EVIDENCE_SPAN * percentileOf(elo, arenaScale)) * 1e4
          ) / 1e4,
        agenticQuality: null,
        codingQuality: null,
        intelligenceQuality: null,
        agenticIndex: null,
        codingIndex: null,
        intelligenceIndex: null,
        benchmarkSource: 'design-arena',
        benchmarkPopulation: arenaScale.length,
        // An arena standing is not a column of the hard-evaluation table, so it claims none of them.
        benchmarkPopulations: null
      };
    return {
      measuredQuality: null,
      agenticQuality: null,
      codingQuality: null,
      intelligenceQuality: null,
      agenticIndex: null,
      codingIndex: null,
      intelligenceIndex: null,
      benchmarkSource: null,
      benchmarkPopulation: null,
      benchmarkPopulations: null
    };
  };

  // Rank is a standing among the models measured on hard evaluations, so a head-to-head arena
  // placing informs a model's quality without claiming a position in that table.
  const overall = measured
    .map((model) => ({ id: model.id, quality: qualityOf(model) }))
    .filter((entry) => entry.quality.benchmarkSource === 'artificial-analysis')
    .map((entry) => ({ id: entry.id, score: entry.quality.measuredQuality ?? 0 }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
  const ranked = new Map(overall.map((id, position) => [id, position + 1]));
  /** An alias is the same model as its target, so it reports the target's standing, not a second one. */
  const rankOf = (model: OpenRouterModel | undefined): number | null => {
    if (!model) return null;
    const own = ranked.get(model.id);
    if (own !== undefined) return own;
    const target = model.alias_target?.slug;
    return (target === undefined ? undefined : ranked.get(target)) ?? null;
  };

  const scope: ModelCatalogScope = options.scope ?? 'provider_catalog';

  /** Live metadata shared by reviewed and unreviewed models alike. */
  const enrich = (providerModelId: string, catalogueId: string) => {
    const live = models.get(providerModelId);
    const endpoints = zdr.get(providerModelId) ?? [];
    const supported = new Set(live?.supported_parameters ?? []);
    const inputModalities = new Set(live?.architecture?.input_modalities ?? []);
    const quality = qualityOf(live);
    const inputUsdPerMillionTokens = perMillion(live?.pricing?.prompt);
    const outputUsdPerMillionTokens = perMillion(live?.pricing?.completion);
    const uptimes = endpoints
      .map((endpoint) => endpoint.uptime_last_1d)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const latencies = endpoints
      .map((endpoint) => endpoint.latency_last_30m)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const expiresAt = live?.expiration_date ?? null;
    // Zero-retention is a fact about live endpoints. When that feed could not be read we do not
    // claim to know it: the previous answer is carried forward, and failing that the flag is left
    // absent, which the privacy projection reads as "not verified" rather than as "verified safe".
    const zeroDataRetentionAvailable: boolean | undefined = zdrBody
      ? endpoints.length > 0
      : previous.get(catalogueId)?.zeroDataRetentionAvailable;
    return {
      live,
      endpoints,
      supported,
      inputModalities,
      inputUsdPerMillionTokens,
      zeroDataRetentionAvailable,
      expiresAt,
      shared: {
        modalities: [
          'text' as const,
          ...(inputModalities.has('image') ? (['image'] as const) : []),
          ...(inputModalities.has('video') ? (['video'] as const) : []),
          ...(inputModalities.has('audio') ? (['audio'] as const) : [])
        ],
        capabilities: [
          'chat' as const,
          ...(supported.has('tools') ? (['tools'] as const) : []),
          ...(inputModalities.has('image') ? (['vision'] as const) : []),
          ...(supported.has('reasoning') ? (['reasoning'] as const) : [])
        ],
        measuredQuality: quality.measuredQuality,
        agenticQuality: quality.agenticQuality,
        codingQuality: quality.codingQuality,
        intelligenceQuality: quality.intelligenceQuality,
        agenticIndex: quality.agenticIndex,
        codingIndex: quality.codingIndex,
        intelligenceIndex: quality.intelligenceIndex,
        benchmarkPopulation: quality.benchmarkPopulation,
        benchmarkPopulations: quality.benchmarkPopulations,
        measuredLatencyMs: latencies.length ? Math.round(Math.min(...latencies)) : null,
        uptimeLast1dPercent: uptimes.length ? Math.min(...uptimes) : null,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
        cacheReadUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_read),
        cacheWriteUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_write),
        priceTiers: priceTiersOf(live?.pricing),
        promptCacheStyle: promptCacheStyleFor({
          providerModelId,
          cacheReadUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_read),
          cacheWriteUsdPerMillionTokens: perMillion(live?.pricing?.input_cache_write),
          supportsImplicitCaching: endpoints.some(
            (endpoint) => endpoint.supports_implicit_caching === true
          ),
          catalogued: live !== undefined
        }) satisfies PromptCacheStyle,
        supportsReasoningEffort: supported.has('reasoning_effort'),
        maxOutputTokens:
          typeof live?.top_provider?.max_completion_tokens === 'number'
            ? live.top_provider.max_completion_tokens
            : null,
        knowledgeCutoff: live?.knowledge_cutoff ?? null,
        expiresAt,
        metadataSource: 'measured' as const,
        benchmarkRank: rankOf(live),
        benchmarkSource: quality.benchmarkSource,
        // OpenRouter publishes the score but not the date it was run, so this records when athanor
        // last read it - which is the only honest answer available and still tells an owner whether
        // they are looking at something from this week or from a catalogue that stopped refreshing.
        benchmarkUpdatedAt: quality.benchmarkSource ? updatedAt : null,
        revision: 'openrouter-live',
        updatedAt
      }
    };
  };

  const reviewedEntries = allowlist.map((entry): CatalogModelRelease => {
    const { live, shared, zeroDataRetentionAvailable, expiresAt } = enrich(
      entry.providerModelId,
      entry.id
    );
    const livePrivateRoute = Boolean(live) && zeroDataRetentionAvailable === true;
    const licenseReview = currentCommercialLicenseReview(
      entry.providerModelId,
      entry.license,
      options.now ?? new Date()
    );
    // Strict scope keeps the original fail-closed contract: a lapsed review withdraws the model
    // from selection. Provider scope only withdraws the open-weight claim, because the review
    // describes the weights rather than the owner's right to call a hosted endpoint.
    const reviewGated = scope === 'reviewed_open_weight';
    const retiring = expiresAt !== null && Date.parse(expiresAt) <= retirementHorizon;
    return {
      ...entry,
      ...shared,
      ...(reviewGated || licenseReview
        ? {}
        : { openness: 'remote_proprietary' as const, license: 'provider-hosted' }),
      availability: livePrivateRoute
        ? reviewGated && !licenseReview
          ? ('review' as const)
          : ('available' as const)
        : ('unavailable' as const),
      contextTokens: live?.context_length ?? entry.contextTokens,
      recommendationTags: retiring
        ? [
            ...entry.recommendationTags.filter((tag) => !tag.startsWith('Retires ')),
            `Retires ${expiresAt}`
          ]
        : entry.recommendationTags.filter((tag) => !tag.startsWith('Retires ')),
      providerAvailable: Boolean(live && (licenseReview || !reviewGated)),
      ...(zeroDataRetentionAvailable === undefined
        ? {}
        : {
            zeroDataRetentionAvailable: Boolean(livePrivateRoute && (licenseReview || !reviewGated))
          })
    };
  });

  if (scope === 'reviewed_open_weight') return reviewedEntries;

  const reviewedIds = new Set(allowlist.map((entry) => entry.providerModelId));
  const liveEntries: CatalogModelRelease[] = [];
  for (const [providerModelId, live] of models) {
    if (reviewedIds.has(providerModelId)) continue;
    const outputModalities = live.architecture?.output_modalities;
    // Image, audio and video generators are reached through the media service, not the chat loop.
    if (outputModalities?.length && !outputModalities.includes('text')) continue;
    const catalogueId = `openrouter/${providerModelId}`;
    const {
      supported,
      inputModalities,
      inputUsdPerMillionTokens,
      zeroDataRetentionAvailable,
      shared
    } = enrich(providerModelId, catalogueId);
    const contextTokens = live.context_length ?? 128_000;
    const review = currentCommercialLicenseReview(
      providerModelId,
      'Apache-2.0',
      options.now ?? new Date()
    );
    const expiresAt = live.expiration_date ?? null;
    const retiring = expiresAt !== null && Date.parse(expiresAt) <= retirementHorizon;
    liveEntries.push({
      ...shared,
      id: catalogueId,
      providerModelId,
      displayName: displayNameFor(live),
      provider: 'openrouter',
      availability: 'available',
      openness: review ? 'permissive_open_weight' : 'remote_proprietary',
      license: review?.license ?? 'provider-hosted',
      // The owner licenses a hosted service from their own provider account; Athanor neither
      // redistributes weights nor resells inference.
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens,
      usageClass: usageClassForPrice(inputUsdPerMillionTokens),
      recommendationTags: derivedTags(
        supported,
        inputModalities,
        contextTokens,
        retiring ? expiresAt : null
      ),
      providerAvailable: true,
      ...(zeroDataRetentionAvailable === undefined ? {} : { zeroDataRetentionAvailable })
    });
  }

  return [...reviewedEntries, ...liveEntries];
};

/**
 * The generators the owner's provider account can reach, which the chat refresh above throws away.
 *
 * `refreshOpenRouterCatalog` skips every model whose output is not text - correctly, they cannot
 * answer a turn - and until now that was the end of them. So the image and speech models the owner
 * is paying for existed nowhere in this software except as two ids compiled into a manifest, which
 * is exactly the complaint: there was no control because there was no catalogue to control.
 *
 * What this cannot do is price them. The chat side reads `pricing.prompt` and `pricing.completion`
 * off the same feed and those are the only price fields this repository has ever confirmed; there
 * is no field here that is known to state dollars per generated image, and guessing at one would
 * put a number under a control the owner is about to trust. So a live entry's price is reported as
 * `unknown`, the reviewed seeds keep their measured figures, and the worker's approval card asks
 * every single time for a model whose cost nobody has stated. A live account is what it would take
 * to confirm whether a per-image price is published here and under what key.
 */
export const refreshOpenRouterMediaCatalog = async (options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: Date;
  /** When true, a model with no zero-retention endpoint is listed but cannot be chosen. */
  requireZeroDataRetention?: boolean;
}): Promise<MediaModelOption[]> => {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const now = options.now ?? new Date();
  const updatedAt = now.toISOString();
  const [modelsResult, zdrResult] = await Promise.allSettled([
    request(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000) }).then(
      (response) => checkedJson<{ data?: OpenRouterModel[] }>(response, 'OpenRouter models')
    ),
    request(`${baseUrl}/endpoints/zdr`, { headers, signal: AbortSignal.timeout(15_000) }).then(
      (response) => checkedJson<{ data?: ZdrEndpoint[] }>(response, 'OpenRouter ZDR endpoints')
    )
  ]);
  if (modelsResult.status === 'rejected') throw modelsResult.reason;
  const listed = modelsResult.value.data ?? [];
  if (listed.length === 0)
    throw new AthanorError(
      'provider_catalog_empty',
      'The provider answered but listed no models, so the media catalogue was left as it was',
      502
    );
  const zdrBody = zdrResult.status === 'fulfilled' ? zdrResult.value : null;
  const zdrModelIds = new Set(
    (zdrBody?.data ?? [])
      .filter((endpoint) => endpoint.status === undefined || endpoint.status === 0)
      .flatMap((endpoint) => (endpoint.model_id ? [endpoint.model_id] : []))
  );
  const listedIds = new Set(listed.map((model) => model.id));
  const seeds = seedMediaModels(now).map((seed) => ({
    ...seed,
    ...(zdrBody ? { zeroDataRetentionAvailable: zdrModelIds.has(seed.providerModelId) } : {}),
    // The reviewed route is always offered, but it is not always there: an account that cannot
    // reach it says so here rather than at the moment a generation fails.
    ...(listedIds.has(seed.providerModelId)
      ? {}
      : { unavailableReason: 'this provider account does not list it' })
  }));
  const seeded = new Set(seeds.map((seed) => seed.providerModelId));
  const live: MediaModelOption[] = [];
  for (const model of listed) {
    if (seeded.has(model.id)) continue;
    const outputs = model.architecture?.output_modalities ?? [];
    // A model that can answer with text is a chat model, whatever else it can also emit; it belongs
    // in the picker the composer reads and not in a list of things that make files.
    if (!outputs.length || outputs.includes('text')) continue;
    const modality = outputs.includes('image')
      ? ('image' as const)
      : outputs.includes('audio')
        ? ('audio' as const)
        : null;
    if (!modality) continue;
    live.push({
      id: `openrouter/${model.id}`,
      providerModelId: model.id,
      displayName: displayNameFor(model),
      provider: 'openrouter',
      modality,
      usdPerImage: null,
      usdPerMillionCharacters: null,
      priceSource: 'unknown' as const,
      defaultVoice: null,
      recommendationTags: ['Price not published'],
      updatedAt,
      // Undefined rather than false when the endpoint feed could not be read, so an outage on one
      // of two requests cannot silently withdraw every private media route the owner has.
      ...(zdrBody ? { zeroDataRetentionAvailable: zdrModelIds.has(model.id) } : {})
    });
  }
  const all = [...seeds, ...live];
  if (!options.requireZeroDataRetention) return all;
  return all.map((option) =>
    option.unavailableReason || option.zeroDataRetentionAvailable !== false
      ? option
      : { ...option, unavailableReason: 'no verified private route' }
  );
};

/** Projects shared live endpoint metadata into one owner's current privacy policy. */
export const applyOpenRouterPrivacyPolicy = <T extends ModelRelease>(
  model: T,
  requireZeroDataRetention: boolean
): T => {
  if (model.provider !== 'openrouter' || model.providerAvailable === undefined) return model;
  const eligible = requireZeroDataRetention
    ? model.zeroDataRetentionAvailable === true
    : model.providerAvailable;
  return {
    ...model,
    privacyRoute: requireZeroDataRetention ? 'provider_zdr' : 'external',
    availability:
      model.availability === 'review' ? 'review' : eligible ? 'available' : 'unavailable'
  };
};
