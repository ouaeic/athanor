import type { ModelRelease, PrivacyRoute } from '@athanor/contracts';

export type ModelCapability = ModelRelease['capabilities'][number];
export type ModelModality = ModelRelease['modalities'][number];
export type ModelUsageClass = ModelRelease['usageClass'];
export type ModelPreference = 'fast' | 'balanced' | 'best';

/**
 * Where a model's numbers came from.
 *
 * - `measured` - an independent benchmark ran the model and published a score.
 * - `declared` - the endpoint or the owner told us, at configure time, what this route is.
 * - `unknown` - nobody has said anything. Athanor invents nothing for these: they are reachable by
 *   name and never by automatic ranking, because a route we know nothing about must not be scored
 *   as if we did.
 */
export type ModelMetadataProvenance = 'measured' | 'declared' | 'unknown';

/**
 * A long-context price tier, as providers publish them: above `minPromptTokens` the route bills at
 * these rates instead. A task that passes a spend ceiling on its first turn would otherwise breach
 * it silently once the transcript grows, which is exactly the long agent run the ceiling protects.
 */
export interface ModelPriceTier {
  readonly minPromptTokens: number;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
}

/**
 * How many models carried each benchmark column. The columns do not cover the same models - a live
 * catalogue read on 2026-08-03 measured 117 on coding, 108 on agentic and 107 on intelligence - so a
 * percentile has to name the population it was computed against rather than borrow another's.
 */
export interface BenchmarkPopulations {
  readonly coding: number | null;
  readonly agentic: number | null;
  readonly intelligence: number | null;
}

/**
 * Catalogue facts the router uses that the stored `ModelRelease` shape does not carry yet. Every
 * field is optional, so a plain `ModelRelease` is a valid `RoutableModel` and a catalogue that has
 * not been refreshed since these were added simply ranks without them.
 *
 * These are the fields an unattended server needs and the stored shape drops. `readRoutingMetadata`
 * below is the one place that decides what they are, so the store and the API round-trip them in a
 * single call instead of each keeping a hand-written list that silently falls behind this type.
 */
export type RoutingMetadata = {
  /** Defaults to `measured` when absent, which is what every catalogue entry has always been. */
  readonly metadataSource?: ModelMetadataProvenance;
  /** Raw benchmark indices, kept for display. Ranking uses the percentile fields on ModelRelease. */
  readonly agenticIndex?: number | null;
  readonly codingIndex?: number | null;
  readonly intelligenceIndex?: number | null;
  /** How many models carried any benchmark at all, which is the population behind the overall score. */
  readonly benchmarkPopulation?: number | null;
  /** How many carried each column, for the percentile that was actually computed on that column. */
  readonly benchmarkPopulations?: BenchmarkPopulations | null;
  readonly cacheReadUsdPerMillionTokens?: number | null;
  readonly cacheWriteUsdPerMillionTokens?: number | null;
  /**
   * How this route caches a repeated prompt prefix, read from what it charges for cache writes and
   * reads rather than guessed from its vendor prefix. `explicit` routes cache nothing unless the
   * request marks where the stable prefix ends.
   */
  readonly promptCacheStyle?: 'explicit' | 'automatic' | 'none';
  /**
   * Whether the route accepts a `reasoning_effort` parameter. Sending one where it is not supported
   * narrows or fails routing when the request also demands the provider honour every parameter,
   * which is exactly what the zero-retention posture demands.
   */
  readonly supportsReasoningEffort?: boolean;
  readonly priceTiers?: readonly ModelPriceTier[];
  /** Worst one-day uptime across the endpoints that serve this model, as a percentage. */
  readonly uptimeLast1dPercent?: number | null;
  /** The date the provider withdraws this route, ISO `YYYY-MM-DD` or a full timestamp. */
  readonly expiresAt?: string | null;
  /** Most tokens the route will write in one response. */
  readonly maxOutputTokens?: number | null;
  readonly knowledgeCutoff?: string | null;
};

/** A catalogue entry plus whatever live metadata the refresh managed to carry with it. */
export type RoutableModel = ModelRelease & RoutingMetadata;

const finiteNumberOrNull = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonEmptyStringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' && value.length > 0 ? value : undefined;

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : undefined;

const readPriceTiers = (value: unknown): readonly ModelPriceTier[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const tiers: ModelPriceTier[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const minPromptTokens = finiteNumberOrNull(record.minPromptTokens);
    // A tier without the threshold it applies above cannot be evaluated, so it is not a tier.
    if (typeof minPromptTokens !== 'number') continue;
    tiers.push({
      minPromptTokens,
      inputUsdPerMillionTokens: finiteNumberOrNull(record.inputUsdPerMillionTokens) ?? null,
      outputUsdPerMillionTokens: finiteNumberOrNull(record.outputUsdPerMillionTokens) ?? null
    });
  }
  return tiers;
};

const readPopulations = (value: unknown): BenchmarkPopulations | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    coding: finiteNumberOrNull(record.coding) ?? null,
    agentic: finiteNumberOrNull(record.agentic) ?? null,
    intelligence: finiteNumberOrNull(record.intelligence) ?? null
  };
};

/**
 * One reader per routing field.
 *
 * The mapped type is the point: adding a field to `RoutingMetadata` without adding a reader here is
 * a compile error, so the round trip cannot quietly start dropping it. That is exactly how the
 * retirement dates, output limits, cache styles and provenance flags were lost - each of the three
 * places that copied a model kept its own list of fields, and none of them was this type.
 */
const routingMetadataReaders: {
  readonly [K in keyof Required<RoutingMetadata>]: (
    value: unknown
  ) => Required<RoutingMetadata>[K] | undefined;
} = {
  metadataSource: oneOf(['measured', 'declared', 'unknown']),
  agenticIndex: finiteNumberOrNull,
  codingIndex: finiteNumberOrNull,
  intelligenceIndex: finiteNumberOrNull,
  benchmarkPopulation: finiteNumberOrNull,
  benchmarkPopulations: readPopulations,
  cacheReadUsdPerMillionTokens: finiteNumberOrNull,
  cacheWriteUsdPerMillionTokens: finiteNumberOrNull,
  promptCacheStyle: oneOf(['explicit', 'automatic', 'none']),
  supportsReasoningEffort: (value) => (typeof value === 'boolean' ? value : undefined),
  priceTiers: readPriceTiers,
  uptimeLast1dPercent: finiteNumberOrNull,
  expiresAt: nonEmptyStringOrNull,
  maxOutputTokens: finiteNumberOrNull,
  knowledgeCutoff: nonEmptyStringOrNull
};

const routingMetadataKeys = Object.keys(routingMetadataReaders) as Array<
  keyof Required<RoutingMetadata>
>;

/**
 * Reads the routing metadata off anything shaped like a model or like the JSON blob one was stored
 * in. It is both halves of the round trip - what to persist, and what to trust on the way back - so
 * a value that survives the journey is the value that was written, and a field that arrives
 * malformed is dropped on its own rather than taking the rest of the entry with it.
 *
 * An absent field stays absent. `undefined` and `null` mean different things here: "the refresh
 * never reported this" is not "the provider publishes nothing", and the router reads them apart.
 */
export const readRoutingMetadata = (source: unknown): RoutingMetadata => {
  if (typeof source !== 'object' || source === null) return {};
  const record = source as Record<string, unknown>;
  const readers = routingMetadataReaders as Record<string, (value: unknown) => unknown>;
  const result: Record<string, unknown> = {};
  for (const key of routingMetadataKeys) {
    if (!(key in record)) continue;
    const value = readers[key]?.(record[key]);
    if (value !== undefined) result[key] = value;
  }
  return result as RoutingMetadata;
};

export interface ModelRequest {
  requestedId?: string;
  privacyRoute: PrivacyRoute;
  requiredCapabilities: ModelCapability[];
  requiredModalities: ModelModality[];
  minContextTokens: number;
  maxUsageClass?: ModelUsageClass;
  preference: ModelPreference;
  taskKind?: ModelTaskKind;
  /**
   * The owner's ceiling, as two rates, because "$2 per million in and $10 per million out" has no
   * single-number equivalent. Both are inclusive: a model priced at exactly the ceiling is admitted.
   *
   * When either is set, a model that publishes no price is *ineligible* rather than assumed cheap -
   * a ceiling a route can pass by declining to publish a price is not a ceiling. The rates are
   * evaluated at the tier `minContextTokens` actually reaches, so a model that only fits under the
   * ceiling at short context is admitted for short work and excluded for long.
   */
  maxInputUsdPerMillionTokens?: number;
  maxOutputUsdPerMillionTokens?: number;
  /**
   * Older single blended ceiling. It cannot express two rates and it treats an unpublished price as
   * under the ceiling, so it is superseded by the pair above; it stays for callers that already pass
   * it and is ignored when either of the two rates is set.
   */
  maxUsdPerMillionTokens?: number;
  /** Clock for retirement checks. Defaults to now; tests and replays pass their own. */
  asOf?: string;
}

/**
 * The shapes of work the router distinguishes. The first three are the historical coarse kinds and
 * stay in the union so callers that only know them keep type-checking.
 */
export type ModelTaskKind =
  | 'general'
  | 'coding'
  | 'agentic'
  | 'conversation'
  | 'reasoning'
  | 'vision'
  | 'long_context'
  | 'bulk_summarisation';

const usageRank: Record<ModelUsageClass, number> = {
  light: 1,
  medium: 2,
  high: 3,
  extra_high: 4
};

/**
 * What an unmeasured model scores on quality.
 *
 * The benchmark sub-scores are percentiles within the live catalogue, so 0.4 is literally "the
 * fortieth percentile of the models somebody has actually measured". An unmeasured model is
 * therefore reachable - it beats the weakest measured models, as it should, since most of them are
 * genuinely poor - and can never be preferred over a strong one. The previous priors ran to 0.80,
 * which under a raw index that tops out near 60 meant being benchmarked was a penalty.
 */
export const UNMEASURED_QUALITY_PRIOR = 0.4;

const usageClassPricePrior: Record<ModelUsageClass, number> = {
  light: 1,
  medium: 0.75,
  high: 0.5,
  extra_high: 0.25
};

/** A latency at or beyond this reads as "slow"; the sub-score floors at zero there. */
const LATENCY_CEILING_MS = 30_000;

/** Blended dollars per million tokens at which the price sub-score is exactly one half. */
const PRICE_HALF_POINT_USD = 1;

/**
 * Prices arrive as per-token decimals and are scaled by a million, so two rates that are equal to
 * the cent can differ in the last float bit. Comparisons against a ceiling allow that much slack.
 */
const PRICE_EPSILON_USD = 1e-6;

/**
 * A model within this many days of its published retirement date is kept out of automatic
 * selection. An unattended server that picks a route which stops answering next week has failed at
 * the one job it has, and the successor is always one refresh away.
 */
export const RETIREMENT_HORIZON_DAYS = 30;

/** A route serving less than this share of requests over the last day is treated as broken. */
export const MIN_HEALTHY_UPTIME_PERCENT = 90;

/**
 * Share of a multi-step task's input tokens that arrive as a cache read rather than a fresh prompt.
 * An agent resends the contract, the tool catalogue and the whole trajectory every step, so after
 * the first turn almost all of the prefix is a repeat; three quarters is a deliberately conservative
 * reading of that. It only ever applies where the route publishes a cache-read rate.
 */
const CACHED_INPUT_SHARE = 0.75;

export interface TaskWeights {
  readonly quality: number;
  readonly latency: number;
  readonly price: number;
  readonly context: number;
}

export interface TaskProfile {
  readonly kind: ModelTaskKind;
  /** Which benchmark column actually speaks to this task. */
  readonly benchmark: 'coding' | 'agentic' | 'intelligence';
  readonly weights: TaskWeights;
  /** Capabilities the task cannot be performed without. */
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly requiredModalities: readonly ModelModality[];
  /** Context the task is expected to need; the headroom sub-score is measured against it. */
  readonly referenceContextTokens: number;
  /**
   * Whether the work resends a growing transcript every step. Where it does, and the route
   * publishes a cache-read rate, price is judged on what the task will really cost rather than on
   * charging every input token at the full prompt rate.
   */
  readonly resendsTranscript: boolean;
}

const profiles: Record<ModelTaskKind, TaskProfile> = {
  conversation: {
    kind: 'conversation',
    benchmark: 'intelligence',
    weights: { quality: 0.25, latency: 0.45, price: 0.2, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 16_000,
    resendsTranscript: false
  },
  general: {
    kind: 'general',
    benchmark: 'intelligence',
    weights: { quality: 0.45, latency: 0.25, price: 0.2, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  },
  reasoning: {
    kind: 'reasoning',
    benchmark: 'intelligence',
    weights: { quality: 0.7, latency: 0.05, price: 0.1, context: 0.15 },
    requiredCapabilities: ['chat', 'reasoning'],
    requiredModalities: ['text'],
    referenceContextTokens: 64_000,
    resendsTranscript: false
  },
  coding: {
    kind: 'coding',
    benchmark: 'coding',
    weights: { quality: 0.65, latency: 0.1, price: 0.1, context: 0.15 },
    requiredCapabilities: ['chat', 'tools'],
    requiredModalities: ['text'],
    referenceContextTokens: 128_000,
    resendsTranscript: true
  },
  agentic: {
    kind: 'agentic',
    benchmark: 'agentic',
    weights: { quality: 0.6, latency: 0.1, price: 0.1, context: 0.2 },
    requiredCapabilities: ['chat', 'tools'],
    requiredModalities: ['text'],
    referenceContextTokens: 128_000,
    resendsTranscript: true
  },
  vision: {
    kind: 'vision',
    benchmark: 'intelligence',
    weights: { quality: 0.55, latency: 0.15, price: 0.15, context: 0.15 },
    requiredCapabilities: ['chat', 'vision'],
    requiredModalities: ['text', 'image'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  },
  long_context: {
    kind: 'long_context',
    benchmark: 'intelligence',
    weights: { quality: 0.4, latency: 0.05, price: 0.15, context: 0.4 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 400_000,
    resendsTranscript: false
  },
  bulk_summarisation: {
    kind: 'bulk_summarisation',
    benchmark: 'intelligence',
    weights: { quality: 0.15, latency: 0.2, price: 0.55, context: 0.1 },
    requiredCapabilities: ['chat'],
    requiredModalities: ['text'],
    referenceContextTokens: 32_000,
    resendsTranscript: false
  }
};

export const taskProfile = (kind: ModelTaskKind): TaskProfile => profiles[kind];

/** Every task kind the router knows, in a stable order, so callers can enumerate them. */
export const modelTaskKinds: readonly ModelTaskKind[] = Object.freeze([
  'general',
  'coding',
  'agentic',
  'conversation',
  'reasoning',
  'vision',
  'long_context',
  'bulk_summarisation'
] as const);

/**
 * How the preference dial bends a task profile. It multiplies rather than replaces the profile so
 * that "fast coding" still ranks on the coding benchmark, just with latency weighted harder.
 */
const preferenceBias: Record<ModelPreference, TaskWeights> = {
  fast: { quality: 0.5, latency: 2, price: 1.5, context: 0.75 },
  balanced: { quality: 1, latency: 1, price: 1, context: 1 },
  best: { quality: 1.8, latency: 0.4, price: 0.5, context: 1.2 }
};

const normaliseWeights = (raw: TaskWeights, fallback: TaskWeights): TaskWeights => {
  const total = raw.quality + raw.latency + raw.price + raw.context;
  if (total <= 0) return fallback;
  return {
    quality: raw.quality / total,
    latency: raw.latency / total,
    price: raw.price / total,
    context: raw.context / total
  };
};

export const blendWeights = (profile: TaskProfile, preference: ModelPreference): TaskWeights => {
  const bias = preferenceBias[preference];
  return normaliseWeights(
    {
      quality: profile.weights.quality * bias.quality,
      latency: profile.weights.latency * bias.latency,
      price: profile.weights.price * bias.price,
      context: profile.weights.context * bias.context
    },
    profile.weights
  );
};

/**
 * Drops the latency term and shares its weight out across the rest.
 *
 * Nothing publishes a usable latency for these routes today, so the sub-score used to fall back to
 * a table indexed by price - which made two thirds of the "fast" dial a price lookup wearing a
 * latency label. A sub-score that is honestly absent is better than one that is silently price.
 */
export const withoutLatency = (weights: TaskWeights): TaskWeights =>
  normaliseWeights({ ...weights, latency: 0 }, weights);

export type MetadataSource =
  | 'benchmark'
  | 'overall'
  | 'measured'
  | 'catalogue'
  | 'usage_class'
  | 'unknown';

export interface SubScore {
  readonly value: number;
  readonly source: MetadataSource;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const benchmarkValue = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): number | null => {
  const raw =
    benchmark === 'coding'
      ? model.codingQuality
      : benchmark === 'agentic'
        ? model.agenticQuality
        : model.intelligenceQuality;
  return typeof raw === 'number' ? raw : null;
};

/** The raw published index behind a percentile, where the catalogue carried one. */
const benchmarkIndex = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): number | null => {
  const raw =
    benchmark === 'coding'
      ? model.codingIndex
      : benchmark === 'agentic'
        ? model.agenticIndex
        : model.intelligenceIndex;
  return typeof raw === 'number' ? raw : null;
};

/**
 * Quality on one comparable scale.
 *
 * `codingQuality`, `agenticQuality`, `intelligenceQuality` and `measuredQuality` are percentiles
 * within the live catalogue, not percentages of a benchmark: the best-scoring model on a column is
 * 1.0 by construction. That is what keeps the scale meaningful when the index behind it is revised,
 * and what stops an unmeasured model outranking a measured one on the sub-score whose whole job is
 * to reward capability.
 */
export const qualityScore = (
  model: RoutableModel,
  benchmark: TaskProfile['benchmark']
): SubScore => {
  if (model.metadataSource === 'unknown') return { value: 0, source: 'unknown' };
  const dimension = benchmarkValue(model, benchmark);
  if (dimension !== null) return { value: clamp01(dimension), source: 'benchmark' };
  if (typeof model.measuredQuality === 'number')
    return { value: clamp01(model.measuredQuality), source: 'overall' };
  return { value: UNMEASURED_QUALITY_PRIOR, source: 'usage_class' };
};

export const latencyScore = (model: RoutableModel): SubScore | null => {
  if (typeof model.measuredLatencyMs === 'number')
    return { value: clamp01(1 - model.measuredLatencyMs / LATENCY_CEILING_MS), source: 'measured' };
  return null;
};

/**
 * The two published rates at the tier a prompt of this size actually reaches. Tiers are the
 * provider's own `pricing.overrides`: above their threshold the route bills differently, and a
 * ceiling that ignores them is a ceiling the task walks straight through as its transcript grows.
 */
export const pricesAtPromptSize = (
  model: RoutableModel,
  promptTokens: number
): { input: number | null; output: number | null } => {
  let input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  let output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : null;
  const tiers = [...(model.priceTiers ?? [])].sort(
    (left, right) => left.minPromptTokens - right.minPromptTokens
  );
  for (const tier of tiers) {
    if (promptTokens < tier.minPromptTokens) break;
    if (typeof tier.inputUsdPerMillionTokens === 'number') input = tier.inputUsdPerMillionTokens;
    if (typeof tier.outputUsdPerMillionTokens === 'number') output = tier.outputUsdPerMillionTokens;
  }
  return { input, output };
};

/**
 * Agent transcripts are input-heavy - a long tool log in, a short decision out - so the blended
 * rate weights prompt tokens far above completion tokens. Returns null when the catalogue carries
 * neither price, which callers must treat as "unknown", never as "free".
 */
export const blendedPricePerMillionTokens = (model: RoutableModel): number | null => {
  const input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  const output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : null;
  if (input === null && output === null) return null;
  return (input ?? output ?? 0) * 0.75 + (output ?? input ?? 0) * 0.25;
};

/**
 * What the work will really cost per million tokens. On a route that publishes a cache-read rate,
 * a task that resends its transcript pays that rate for most of its input, which is close to an
 * order of magnitude below the prompt rate - the difference between a caching model at $5/M and a
 * non-caching one at $1/M being the right choice.
 */
export const effectivePricePerMillionTokens = (
  model: RoutableModel,
  profile: TaskProfile
): number | null => {
  const blended = blendedPricePerMillionTokens(model);
  if (blended === null) return null;
  const cacheRead =
    typeof model.cacheReadUsdPerMillionTokens === 'number'
      ? model.cacheReadUsdPerMillionTokens
      : null;
  const input =
    typeof model.inputUsdPerMillionTokens === 'number' ? model.inputUsdPerMillionTokens : null;
  if (!profile.resendsTranscript || cacheRead === null || input === null) return blended;
  const output =
    typeof model.outputUsdPerMillionTokens === 'number' ? model.outputUsdPerMillionTokens : input;
  const effectiveInput = input * (1 - CACHED_INPUT_SHARE) + cacheRead * CACHED_INPUT_SHARE;
  return effectiveInput * 0.75 + output * 0.25;
};

export const priceScore = (model: RoutableModel, profile?: TaskProfile): SubScore => {
  const price = profile
    ? effectivePricePerMillionTokens(model, profile)
    : blendedPricePerMillionTokens(model);
  if (price === null)
    return { value: usageClassPricePrior[model.usageClass], source: 'usage_class' };
  return { value: PRICE_HALF_POINT_USD / (PRICE_HALF_POINT_USD + price), source: 'catalogue' };
};

/**
 * Headroom, not raw size: a window exactly the size of the task scores 0.5, sixteen times the task
 * scores 1. Without the cap a million-token model would win every ranking on context alone.
 */
export const contextHeadroomScore = (contextTokens: number, referenceTokens: number): number => {
  if (contextTokens <= 0 || referenceTokens <= 0) return 0;
  const headroom = contextTokens / referenceTokens;
  if (headroom <= 1) return clamp01(headroom * 0.5);
  return clamp01(0.5 + Math.log2(headroom) / 8);
};

export const isPrivacyRouteEligible = (model: RoutableModel, route: PrivacyRoute): boolean => {
  if (model.privacyRoute !== route) return false;
  // A reviewed zero-retention model whose live endpoints have all lost their ZDR contract is not a
  // zero-retention route any more, so it must never carry privacy-bound work.
  if (route === 'provider_zdr' && model.zeroDataRetentionAvailable === false) return false;
  return true;
};

const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1_000)}K`
      : String(tokens);

const formatUsd = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);

/**
 * Everything except the owner's price ceiling: can this model do the work at all.
 */
export const meetsRequirements = (model: RoutableModel, request: ModelRequest): boolean => {
  if (model.availability !== 'available') return false;
  if (model.providerAvailable === false) return false;
  if (!model.commercialUse) return false;
  // A route nobody has measured or described is reachable by name and never by automatic ranking.
  if (model.metadataSource === 'unknown' && !request.requestedId) return false;
  if (!isPrivacyRouteEligible(model, request.privacyRoute)) return false;
  if (model.contextTokens < request.minContextTokens) return false;
  if (request.maxUsageClass && usageRank[model.usageClass] > usageRank[request.maxUsageClass])
    return false;
  if (!request.requiredCapabilities.every((item) => model.capabilities.includes(item)))
    return false;
  return request.requiredModalities.every((item) => model.modalities.includes(item));
};

/** Whether the request carries the owner's two-rate ceiling. */
export const hasPriceCeiling = (request: ModelRequest): boolean =>
  typeof request.maxInputUsdPerMillionTokens === 'number' ||
  typeof request.maxOutputUsdPerMillionTokens === 'number';

/**
 * Why the ceiling excludes this model, or null when it does not. The sentence is the one the
 * interface shows, so "no published price" reads as a reason rather than as a silent omission.
 */
export const priceCeilingBreach = (model: RoutableModel, request: ModelRequest): string | null => {
  if (!hasPriceCeiling(request)) {
    if (typeof request.maxUsdPerMillionTokens !== 'number') return null;
    const blended = blendedPricePerMillionTokens(model);
    if (blended === null || blended <= request.maxUsdPerMillionTokens + PRICE_EPSILON_USD)
      return null;
    return `${formatUsd(blended)} blended is above the ${formatUsd(request.maxUsdPerMillionTokens)} ceiling`;
  }
  const { input, output } = pricesAtPromptSize(model, request.minContextTokens);
  const maxInput = request.maxInputUsdPerMillionTokens;
  const maxOutput = request.maxOutputUsdPerMillionTokens;
  if (typeof maxInput === 'number') {
    if (input === null) return 'no published price';
    if (input > maxInput + PRICE_EPSILON_USD)
      return `${formatUsd(input)} per million input is above the ${formatUsd(maxInput)} ceiling`;
  }
  if (typeof maxOutput === 'number') {
    if (output === null) return 'no published price';
    if (output > maxOutput + PRICE_EPSILON_USD)
      return `${formatUsd(output)} per million output is above the ${formatUsd(maxOutput)} ceiling`;
  }
  return null;
};

export const isModelEligible = (model: RoutableModel, request: ModelRequest): boolean =>
  meetsRequirements(model, request) && priceCeilingBreach(model, request) === null;

const asOfDate = (request: ModelRequest): Date => {
  if (!request.asOf) return new Date();
  const parsed = new Date(request.asOf);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

/** Whether the provider has published a withdrawal date this side of the horizon. */
export const isRetiringSoon = (model: RoutableModel, asOf: Date): boolean => {
  if (!model.expiresAt) return false;
  const expiry = Date.parse(model.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - asOf.getTime() <= RETIREMENT_HORIZON_DAYS * 86_400_000;
};

/** Whether the endpoints serving this model were failing often enough yesterday to route around. */
export const isDegraded = (model: RoutableModel): boolean =>
  typeof model.uptimeLast1dPercent === 'number' &&
  model.uptimeLast1dPercent < MIN_HEALTHY_UPTIME_PERCENT;

export interface ScoreBreakdown {
  readonly quality: SubScore;
  /** Null when nothing measured a latency for this model, in which case the term was dropped. */
  readonly latency: SubScore | null;
  readonly price: SubScore;
  readonly context: number;
  readonly weights: TaskWeights;
}

export interface RankedModel {
  model: RoutableModel;
  score: number;
  reasons: string[];
  breakdown: ScoreBreakdown;
  /** One sentence a person can read in the interface to see why this model was picked. */
  explanation: string;
}

const benchmarkLabel: Record<TaskProfile['benchmark'], string> = {
  coding: 'coding',
  agentic: 'agentic',
  intelligence: 'intelligence'
};

const taskLabel: Record<ModelTaskKind, string> = {
  general: 'general work',
  coding: 'coding',
  agentic: 'agentic work',
  conversation: 'fast conversation',
  reasoning: 'deep reasoning',
  vision: 'vision work',
  long_context: 'long-context work',
  bulk_summarisation: 'bulk summarisation'
};

const ordinal = (value: number): string => {
  const rounded = Math.round(value);
  const tens = rounded % 100;
  if (tens >= 11 && tens <= 13) return `${rounded}th`;
  const unit = rounded % 10;
  return `${rounded}${unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th'}`;
};

/**
 * The benchmark line. The owner sees the published index and where it sits, never a synthetic
 * decimal: "agentic 55.3, 99th percentile of 117 measured" says something; "0.99" does not.
 */
const describeBenchmark = (
  model: RoutableModel,
  profile: TaskProfile,
  quality: SubScore
): string => {
  const label = benchmarkLabel[profile.benchmark];
  if (quality.source === 'unknown') return 'Nothing is known about this endpoint; it is unrated';
  if (quality.source === 'usage_class')
    return `Not benchmarked; ranked at the ${ordinal(UNMEASURED_QUALITY_PRIOR * 100)} percentile of measured models rather than measured`;
  const percentile = `${ordinal(quality.value * 100)} percentile`;
  // The column the percentile was computed on, never another column's count: the three do not cover
  // the same models, so borrowing the largest overstates how many measured the one being reported.
  const counted =
    quality.source === 'benchmark'
      ? (model.benchmarkPopulations?.[profile.benchmark] ?? model.benchmarkPopulation ?? null)
      : (model.benchmarkPopulation ?? null);
  const population =
    typeof counted === 'number' && counted > 0 ? ` of ${counted} measured` : ' of measured models';
  if (quality.source === 'overall')
    return `No ${label} benchmark yet; overall benchmark ${percentile}${population}`;
  const index = benchmarkIndex(model, profile.benchmark);
  return index === null
    ? `${label} benchmark ${percentile}${population}`
    : `${label} benchmark ${index.toFixed(1)}, ${percentile}${population}`;
};

const buildReasons = (
  model: RoutableModel,
  profile: TaskProfile,
  breakdown: ScoreBreakdown,
  request: ModelRequest
): string[] => {
  const reasons: string[] = [];
  reasons.push(
    request.privacyRoute === 'provider_zdr'
      ? 'Served by a zero-retention endpoint'
      : 'Eligible on the external route'
  );
  reasons.push(`Chosen for ${taskLabel[profile.kind]}`);
  reasons.push(describeBenchmark(model, profile, breakdown.quality));
  reasons.push(
    `${formatTokens(model.contextTokens)} context for a task sized at ${formatTokens(profile.referenceContextTokens)}`
  );
  const blended = blendedPricePerMillionTokens(model);
  const effective = effectivePricePerMillionTokens(model, profile);
  reasons.push(
    blended === null
      ? 'Price not published; ranked on usage class'
      : effective !== null && Math.abs(effective - blended) > PRICE_EPSILON_USD
        ? `${formatUsd(blended)} per million tokens blended, ${formatUsd(effective)} once the prefix is cached`
        : `${formatUsd(blended)} per million tokens blended`
  );
  reasons.push(
    breakdown.latency
      ? `${Math.round(model.measuredLatencyMs ?? 0)} ms measured latency`
      : 'Latency not measured on this server; ranked without it'
  );
  if (typeof model.uptimeLast1dPercent === 'number')
    reasons.push(`${model.uptimeLast1dPercent.toFixed(2)}% uptime over the last day`);
  if (model.expiresAt) reasons.push(`Provider withdraws this route on ${model.expiresAt}`);
  return reasons;
};

export interface ScoreOptions {
  /**
   * Whether the latency term takes part. `rankModels` decides this once for a whole ranking so
   * every candidate is scored on identical weights; on its own, `scoreModel` drops the term for a
   * model nothing has timed.
   */
  readonly rankLatency?: boolean;
}

export const scoreModel = (
  model: RoutableModel,
  request: ModelRequest,
  options: ScoreOptions = {}
): { score: number; breakdown: ScoreBreakdown; reasons: string[]; explanation: string } => {
  const profile = taskProfile(request.taskKind ?? 'general');
  const measuredLatency = latencyScore(model);
  const rankLatency = options.rankLatency ?? measuredLatency !== null;
  const blended = blendWeights(profile, request.preference);
  const weights = rankLatency ? blended : withoutLatency(blended);
  const quality = qualityScore(model, profile.benchmark);
  const latency = rankLatency ? measuredLatency : null;
  const price = priceScore(model, profile);
  const context = contextHeadroomScore(
    model.contextTokens,
    Math.max(profile.referenceContextTokens, request.minContextTokens)
  );
  const breakdown: ScoreBreakdown = { quality, latency, price, context, weights };
  const score =
    quality.value * weights.quality +
    (latency?.value ?? 0) * weights.latency +
    price.value * weights.price +
    context * weights.context;
  const reasons = buildReasons(model, profile, breakdown, request);
  const explanation = `${model.displayName} leads for ${taskLabel[profile.kind]}: ${reasons
    .slice(2)
    .join(', ')}.`;
  return { score, breakdown, reasons, explanation };
};

/** The same request with the owner's price ceiling lifted, and nothing else changed. */
const withoutCeiling = (request: ModelRequest): ModelRequest => ({
  privacyRoute: request.privacyRoute,
  requiredCapabilities: request.requiredCapabilities,
  requiredModalities: request.requiredModalities,
  minContextTokens: request.minContextTokens,
  preference: request.preference,
  ...(request.requestedId === undefined ? {} : { requestedId: request.requestedId }),
  ...(request.maxUsageClass === undefined ? {} : { maxUsageClass: request.maxUsageClass }),
  ...(request.taskKind === undefined ? {} : { taskKind: request.taskKind }),
  ...(request.asOf === undefined ? {} : { asOf: request.asOf })
});

export const rankModels = (models: RoutableModel[], request: ModelRequest): RankedModel[] => {
  if (request.requestedId) {
    // An explicit pick is never constrained by the ceiling: it governs what athanor chooses for the
    // owner, never what the owner chooses for themselves.
    const relaxed = withoutCeiling(request);
    return models
      .filter((model) => model.id === request.requestedId && isModelEligible(model, relaxed))
      .map((model) => {
        const scored = scoreModel(model, request);
        return {
          model,
          score: 1,
          reasons: ['Explicitly selected by the user', ...scored.reasons],
          breakdown: scored.breakdown,
          explanation: `${model.displayName} was selected by you; it is ${scored.reasons[0]?.toLowerCase() ?? 'eligible'}.`
        };
      });
  }

  const eligible = models.filter((model) => isModelEligible(model, request));
  // A route the provider is about to withdraw, or one that was failing yesterday, is kept out of
  // automatic selection - unless it is all there is, in which case saying so beats refusing to work.
  const asOf = asOfDate(request);
  const healthy = eligible.filter((model) => !isRetiringSoon(model, asOf) && !isDegraded(model));
  const pool = healthy.length > 0 ? healthy : eligible;
  const rankLatency = pool.some((model) => typeof model.measuredLatencyMs === 'number');

  return pool
    .map((model) => {
      const scored = scoreModel(model, request, { rankLatency });
      return {
        model,
        score: scored.score,
        reasons: scored.reasons,
        breakdown: scored.breakdown,
        explanation: scored.explanation
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.model.benchmarkRank ?? Number.MAX_SAFE_INTEGER) -
          (right.model.benchmarkRank ?? Number.MAX_SAFE_INTEGER) ||
        left.model.id.localeCompare(right.model.id)
    );
};

/**
 * What the owner's ceiling did to this selection.
 *
 * - `no_ceiling` - no ceiling was set, so nothing was constrained.
 * - `within` - the pick is the best benchmarked model under the ceiling, which is the whole promise.
 * - `relaxed_unbenchmarked` - nothing benchmarked fits, so an unmeasured model was used and said so.
 * - `blocked` - nothing fits at all. Nothing is picked, because silently spending over a ceiling the
 *   owner set while they are asleep is the one outcome a ceiling exists to prevent.
 */
export type CeilingOutcome = 'no_ceiling' | 'within' | 'relaxed_unbenchmarked' | 'blocked';

export interface ModelSelection {
  /** Every eligible model in rank order. Empty when the ceiling blocked the whole catalogue. */
  readonly ranked: RankedModel[];
  readonly choice: RankedModel | null;
  readonly ceilingOutcome: CeilingOutcome;
  /** One sentence for the interface and the timeline, or null when nothing needs saying. */
  readonly message: string | null;
  /** When blocked, the cheapest model that could have done the work with the ceiling lifted. */
  readonly cheapestAboveCeiling: RoutableModel | null;
}

export interface TaskSignals {
  readonly prompt: string;
  /**
   * The kind the caller already knows, because it read the request rather than guessing at it. It
   * outranks every prose hint: a keyword list that decides in advance what shape a job has is the
   * mold, and this is the way out of it.
   */
  readonly declaredKind?: ModelTaskKind;
  /** The turn carries screenshots or photographs, whatever the words say. */
  readonly hasImages?: boolean;
  /** Tokens of transcript, files or tool output the model has to read alongside the prompt. */
  readonly attachedContextTokens?: number;
  readonly interactive?: boolean;
  /**
   * Whether the turn is being handed a tool catalogue and a computer.
   *
   * It gates the conversation profile, and it has to, because `interactive` on its own measures the
   * length of the request rather than the size of the work. Measured: "Generate a cartoon logo, cut
   * the background out cleanly, produce several sizes and a contact sheet" is ninety-eight
   * characters, and on the short-prompt rule alone it classified as `conversation` - the profile
   * that weights latency at 0.45 and quality at 0.25 against a 16K reference window. What that
   * sentence actually asked for was image maths, a script, several runs of it and a montage, on a
   * window that reached 37,000 tokens. A short imperative typed at a machine that can act is not a
   * chat, and no reading of the words was ever going to say so.
   */
  readonly usesTools?: boolean;
  /** Set when the caller is the system talking to itself rather than the owner. */
  readonly internalPurpose?: 'summarisation' | 'classification' | 'extraction';
}

export interface TaskClassification {
  readonly kind: ModelTaskKind;
  /** The observations that produced the kind, in the order they fired. */
  readonly signals: readonly string[];
}

/** Attached context at or above this no longer fits a normal window comfortably. */
export const LONG_CONTEXT_SIGNAL_TOKENS = 120_000;

/** A short prompt in a live turn is a conversation, not a project. */
export const CONVERSATION_PROMPT_CHARS = 160;

const visionPattern =
  /\b(screenshot|screen shot|screengrab|image|images|photo|photograph|picture|ocr|scanned page|video frame|look at this)\b/i;
const longContextPattern =
  /\b(whole (?:repo|repository|codebase|book|transcript|thread)|entire (?:repo|repository|codebase|book|transcript|corpus|archive)|full transcript|hundreds of pages|across all (?:files|documents|papers)|every file in)\b/i;
const bulkPattern =
  /\b(?:summari[sz]e|summaries of|classify|categori[sz]e|label|tag)\s+(?:these|all|each|every|the following)\b/i;
const codingPattern =
  /\b(code|coding|codebase|repository|repo|debug|bug|refactor|typescript|javascript|python|rust|golang|java|compile|unit test|integration test|pull request|website|web app|api|database|sql)\b/i;
const reasoningPattern =
  /\b(prove|proof|theorem|derive|derivation|first principles|step by step|reason through|think through|trade-?offs?|root cause|why does|why did|formally verify|architecture decision|design doc)\b/i;
/**
 * Only phrases that mean the work leaves this process - a browser, an installer, a deployment, a
 * calendar. The words that merely describe an artefact used to live here too, so "Summarise this
 * document for me" was routed to the agentic profile with a 128K reference window; an artefact is
 * not a plan, and this list must never grow back into one.
 */
const agenticPattern =
  /\b(research|browse|browser|find online|search the web|compare sources|apply for|install|deploy|publish|schedule|book a|order a|host a demo|fill (?:in|out) (?:the|this|a) form)\b/i;

/**
 * Deterministic, ordered classification. Order encodes precedence: what the caller knows outranks
 * what the words suggest, a hard capability need (images) outranks a subject-matter hint, and a
 * measured context size outranks any wording.
 */
export const classifyModelTask = (signals: TaskSignals): TaskClassification => {
  const prompt = signals.prompt;
  if (signals.declaredKind)
    return { kind: signals.declaredKind, signals: ['The caller named the kind of work'] };
  if (signals.internalPurpose)
    return {
      kind: 'bulk_summarisation',
      signals: [`Internal ${signals.internalPurpose} request`]
    };
  if (signals.hasImages === true)
    return { kind: 'vision', signals: ['The turn carries image attachments'] };
  if (visionPattern.test(prompt))
    return { kind: 'vision', signals: ['The prompt asks about visual material'] };
  if (
    typeof signals.attachedContextTokens === 'number' &&
    signals.attachedContextTokens >= LONG_CONTEXT_SIGNAL_TOKENS
  )
    return {
      kind: 'long_context',
      signals: [`${signals.attachedContextTokens} tokens of attached context`]
    };
  if (longContextPattern.test(prompt))
    return { kind: 'long_context', signals: ['The prompt spans a whole corpus'] };
  if (bulkPattern.test(prompt))
    return {
      kind: 'bulk_summarisation',
      signals: ['The prompt is bulk summarisation or labelling']
    };
  if (codingPattern.test(prompt)) return { kind: 'coding', signals: ['The prompt is about code'] };
  if (reasoningPattern.test(prompt))
    return { kind: 'reasoning', signals: ['The prompt asks for a derivation or a judgement'] };
  if (agenticPattern.test(prompt))
    return { kind: 'agentic', signals: ['The prompt asks for multi-step work with tools'] };
  if (
    signals.interactive === true &&
    signals.usesTools !== true &&
    prompt.trim().length <= CONVERSATION_PROMPT_CHARS
  )
    return {
      kind: 'conversation',
      signals: ['Short prompt in a live conversation, with no tools']
    };
  return { kind: 'general', signals: ['No specialised signal; treated as general work'] };
};

/**
 * Why this model cannot do this work, in the terms the request was made in. Empty means it can.
 *
 * `meetsRequirements` answers the same question with a boolean, which is all a filter needs and
 * nothing an owner can act on. The sentences are the same clauses, in the same order, said once.
 */
export const unmetRequirements = (model: RoutableModel, request: ModelRequest): string[] => {
  const missing: string[] = [];
  if (model.availability !== 'available')
    missing.push(`the provider lists it as ${model.availability}`);
  if (model.providerAvailable === false) missing.push('its provider is not answering');
  if (!model.commercialUse) missing.push('its licence has not been cleared');
  if (model.metadataSource === 'unknown') missing.push('nothing is known about this endpoint');
  if (!isPrivacyRouteEligible(model, request.privacyRoute))
    missing.push(
      request.privacyRoute === 'provider_zdr'
        ? 'it has no verified zero-retention route'
        : 'it is not on this privacy route'
    );
  if (model.contextTokens < request.minContextTokens)
    missing.push(
      `${formatTokens(model.contextTokens)} context for ${formatTokens(request.minContextTokens)} of work`
    );
  for (const capability of request.requiredCapabilities)
    if (!model.capabilities.includes(capability)) missing.push(`no ${capability}`);
  for (const modality of request.requiredModalities)
    if (!model.modalities.includes(modality)) missing.push(`it cannot read ${modality}`);
  return missing;
};

/**
 * How far down the ranking the model in use has to sit before the gap is worth a line. Third place
 * on a catalogue of hundreds is the router disagreeing with itself, not a bad choice.
 */
const FIT_RANK_FLOOR = 4;

/**
 * And how much blended score has to separate it from the leader. Both have to be true: a wide gap
 * between first and second is a strong leader, not a poor pick, and rank alone is noise.
 */
const FIT_SCORE_GAP = 0.12;

export interface ModelFit {
  /** The shape of work the request was read as, and the observations that produced it. */
  readonly classification: TaskClassification;
  /** Where the model in use placed, 1-based. Null when it was not rankable for this work at all. */
  readonly rank: number | null;
  readonly ranked: number;
  /** What it cannot do for this work. Empty when it can, and the whole answer when it cannot. */
  readonly missing: readonly string[];
  /** What leads instead, or null when the model in use already does. */
  readonly leader: RoutableModel | null;
  /** One line for the transcript, or null when the fit is fine and nothing needs saying. */
  readonly headline: string | null;
  /** The benchmark behind the line, which is the part worth reading twice. Empty when silent. */
  readonly detail: string;
}

/**
 * Whether the model about to answer suits the work in front of it.
 *
 * `rankModels` short-circuits a named model to a score of 1 and the reason "Explicitly selected by
 * the user" - correct, because the owner's pick is not athanor's to overrule, and the reason
 * nothing anywhere compares the model in use against the one the router would have reached for. A
 * fast route pointed at precise multi-step work degenerates quietly: it costs almost nothing per
 * call, so no ceiling fires, and the only signal reaching the owner is a spinner.
 *
 * It is judged on `fast`, whatever the owner asked for. That dial weights latency and price hardest
 * and quality least, so it is the most forgiving reading a cheap route can get; a model that still
 * places near the bottom under it is behind on terms nobody chose. This says so once and stops -
 * changing the route mid-task is a decision with its own failure modes, and the owner has a model
 * control two inches from where this line lands.
 */
export const modelFit = (input: {
  models: RoutableModel[];
  /** The model that will actually answer. */
  chosen: RoutableModel;
  /** The request as the router would have received it, without the owner's pick short-circuiting it. */
  request: ModelRequest;
  signals: TaskSignals;
}): ModelFit => {
  // Whether the turn can act is a fact about the request, not something a caller should be able to
  // get wrong: a ranking that requires the tools capability is by definition ranking for tool work.
  const classification = classifyModelTask({
    ...input.signals,
    usesTools: input.request.requiredCapabilities.includes('tools')
  });
  const profile = taskProfile(classification.kind);
  const { requestedId: _pinned, ...open } = input.request;
  const request: ModelRequest = {
    ...open,
    preference: 'fast',
    taskKind: classification.kind,
    requiredCapabilities: [
      ...new Set([...input.request.requiredCapabilities, ...profile.requiredCapabilities])
    ],
    requiredModalities: [
      ...new Set([...input.request.requiredModalities, ...profile.requiredModalities])
    ]
  };
  const ranked = rankModels(input.models, request);
  const leader = ranked[0] ?? null;
  const index = ranked.findIndex((entry) => entry.model.id === input.chosen.id);
  const chosen = index >= 0 ? ranked[index]! : null;
  const silent: ModelFit = {
    classification,
    rank: chosen ? index + 1 : null,
    ranked: ranked.length,
    missing: [],
    leader: null,
    headline: null,
    detail: ''
  };
  // Nothing to compare against, or the model in use is already the answer.
  if (!leader || leader.model.id === input.chosen.id) return silent;
  const benchmarkOf = (model: RoutableModel): string =>
    `${model.displayName}: ${describeBenchmark(model, profile, qualityScore(model, profile.benchmark)).toLowerCase()}`;
  if (!chosen) {
    const missing = unmetRequirements(input.chosen, request);
    // Ranked out for something this function does not model - a retirement date, a bad day on the
    // provider's endpoints. Both are already reported where they are decided; neither is a fit.
    if (missing.length === 0) return silent;
    return {
      ...silent,
      missing,
      leader: leader.model,
      headline: `${input.chosen.displayName} cannot do ${taskLabel[classification.kind]} here: ${missing.join(', ')}. ${leader.model.displayName} can.`,
      detail: benchmarkOf(leader.model)
    };
  }
  if (index + 1 < FIT_RANK_FLOOR || leader.score - chosen.score < FIT_SCORE_GAP) return silent;
  return {
    ...silent,
    leader: leader.model,
    headline: `${input.chosen.displayName} ranks ${index + 1} of ${ranked.length} for ${taskLabel[classification.kind]}; ${leader.model.displayName} leads.`,
    detail: `${benchmarkOf(input.chosen)}. ${benchmarkOf(leader.model)}.`
  };
};

/** Collapses the full task vocabulary onto the three kinds older callers understand. */
export const coarsenTaskKind = (kind: ModelTaskKind): 'general' | 'coding' | 'agentic' =>
  kind === 'coding' ? 'coding' : kind === 'agentic' ? 'agentic' : 'general';

/**
 * The kind a prompt implies, in the router's full vocabulary. It used to be coarsened to three
 * kinds on the way out, which left five carefully written profiles - vision, long context,
 * reasoning, bulk summarisation, conversation - unreachable from the only entry point that used it.
 */
export const inferModelTask = (prompt: string): ModelTaskKind => classifyModelTask({ prompt }).kind;
