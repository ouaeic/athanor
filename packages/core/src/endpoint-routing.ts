/**
 * Which of the companies serving one model on an aggregator should get this computer's work.
 *
 * One model is served by several independent companies at different prices and wildly different
 * speeds - on a real table measured 10 Sep 2026, two at an identical price where one ran nine times
 * faster, and a third at half the price running at three tokens a second. Given no preference the
 * aggregator picks among the cheapest stable candidates weighted by the inverse square of price, so
 * it reaches for that third one about four times as often as the first. For a chat box that is a
 * slower reply. For an agent it is a task that takes a day instead of twenty minutes, because a
 * turn is dozens of sequential calls and throughput is the wall-clock cost of the whole thing.
 *
 * The rule is the owner's: the cheapest company reaching some share of the fastest one's speed.
 * Both halves are done by the aggregator - `preferred_min_throughput` compares each company's
 * throughput against the floor using figures taken across every request it has ever served, and
 * `sort: 'price'` orders what clears it. This side supplies one number, the floor, and the whole
 * design problem is that the floor must be RELATIVE.
 *
 * WHY IT CANNOT BE A FIXED RATE. Models differ by more than an order of magnitude in what their
 * quickest company achieves. A fixed sixty tokens a second deprioritises every endpoint of a model
 * whose best is forty - and when every endpoint is deprioritised the price sort returns the
 * cheapest, which is the aggregator's own default and the exact behaviour this exists to replace.
 * A floor that is wrong is worse than no floor, because it fails silently into the old defect.
 *
 * WHERE THE CEILING COMES FROM. The aggregator will compare against a threshold but publishes no
 * per-endpoint throughput to compute one from: `throughput_last_30m` is declared on its endpoints
 * route and returned null on every endpoint of every model, for a valid API key as much as for
 * nobody, while `uptime_last_30m` populates - so it is not an authentication gate. Its own site
 * reads those columns from a session-authenticated route that answers an API key with "signed_out".
 * What it does answer is its generation-stats route, for a request it has already served: the
 * generation time, the completion tokens and the company that served it. Asked of a request the
 * aggregator itself routed by throughput, that is a measurement OF THE FASTEST COMPANY, BY THEM.
 * @see fetchGenerationThroughput. This module is handed that ceiling and takes a share of it.
 */

export type RoutingObjective = 'cheapest_fast_enough' | 'fastest' | 'cheapest';

export interface RoutingPolicy {
  readonly objective: RoutingObjective;
  /**
   * How slow a company may be, as a percentage of the fastest one serving that model, and still be
   * worth its lower price. Below it the saving stops being one: the task takes proportionally
   * longer, and every fixed overhead is paid again on each of the turn's dozens of calls.
   */
  readonly throughputFloorPercent: number;
  /** Companies this account will not be served by, whatever they charge. */
  readonly ignoredProviders: readonly string[];
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  objective: 'cheapest_fast_enough',
  throughputFloorPercent: 40,
  ignoredProviders: []
};

/** The aggregator's `provider` fields, exactly as they go on the wire. */
export interface ProviderPreferences {
  sort?: 'price' | 'throughput';
  preferred_min_throughput?: number;
  ignore?: string[];
}

/**
 * What this turn should ask for, given what is known about the model's fastest company.
 *
 * `ceilingTokensPerSecond` is null until a ceiling has been measured, and the answer then is to go
 * and measure one: sorting by throughput routes the request to the company the aggregator ranks
 * quickest, which is both a good route to be on and the only way to learn what quickest means for
 * this model. So the probe costs nothing beyond being fast.
 */
export const providerPreferences = (
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
  ceilingTokensPerSecond: number | null = null
): ProviderPreferences => {
  const ignore = policy.ignoredProviders
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const shared = ignore.length ? { ignore } : {};
  // The aggregator's own default made explicit. An owner who asked for the cheapest has said
  // slowness is acceptable, and a floor would contradict the instruction they just gave.
  if (policy.objective === 'cheapest') return { ...shared, sort: 'price' };
  if (policy.objective === 'fastest') return { ...shared, sort: 'throughput' };
  if (ceilingTokensPerSecond === null || ceilingTokensPerSecond <= 0)
    return { ...shared, sort: 'throughput' };
  const floor = (ceilingTokensPerSecond * policy.throughputFloorPercent) / 100;
  if (!(floor > 0)) return { ...shared, sort: 'price' };
  return {
    ...shared,
    sort: 'price',
    // A whole number, because the field is a rate rather than a measurement, and rounded down so a
    // company sitting exactly on the owner's share is admitted rather than shut out by a fraction.
    preferred_min_throughput: Math.max(1, Math.floor(floor))
  };
};

/**
 * Whether this turn is the one that goes and measures the model's fastest company.
 *
 * True only where the answer would otherwise be uninformed: the owner's rule needs a ceiling, and
 * there is no fresh one. On every other turn the ceiling is already known and the request is routed
 * by the rule itself.
 */
export const shouldMeasureCeiling = (
  policy: RoutingPolicy,
  ceilingTokensPerSecond: number | null
): boolean =>
  policy.objective === 'cheapest_fast_enough' &&
  (ceilingTokensPerSecond === null || ceilingTokensPerSecond <= 0);
