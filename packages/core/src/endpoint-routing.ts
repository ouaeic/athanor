/**
 * Which of the companies serving one model on an aggregator should get this computer's work.
 *
 * One model is served by several independent operators at different prices and wildly different
 * speeds - on a real table measured 10 Sep 2026, two at an identical price where one ran nine times
 * faster, and a third at half the price running at three tokens a second. Given no preference the
 * aggregator picks among the cheapest stable candidates weighted by the inverse square of price, so
 * it reaches for that third one about four times as often as the first. For a chat box that is a
 * slower reply. For an agent it is a task that takes a day instead of twenty minutes, because a
 * turn is dozens of sequential calls and throughput is the wall-clock cost of the whole thing.
 *
 * The comparison belongs to the aggregator and this module does not attempt it. Its throughput
 * figures come from every request it has ever served, which is a vastly better measurement than any
 * one computer could take of its own small and self-selecting sample - a box only ever measures the
 * endpoints it was already routed to. `preferred_min_throughput` applies that measurement per
 * endpoint, server-side, and `sort` orders what survives. This module's whole job is to turn the
 * owner's rule into those fields.
 */

export type RoutingObjective = 'cheapest_fast_enough' | 'fastest' | 'cheapest';

export interface RoutingPolicy {
  readonly objective: RoutingObjective;
  /**
   * Tokens per second, below which an endpoint is not worth its lower price.
   *
   * An absolute figure rather than a share of the fastest, because a share cannot be computed: the
   * aggregator's per-endpoint statistics are not readable through its API - the fields exist on the
   * endpoints route and come back null on every endpoint of every model - so nothing outside it can
   * know what the fastest one is doing. The threshold is the one number this side supplies; the
   * comparison against it is entirely theirs.
   */
  readonly minimumTokensPerSecond: number;
  /** Operators this account will not be served by, whatever they charge. */
  readonly ignoredProviders: readonly string[];
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  objective: 'cheapest_fast_enough',
  /*
   * Sixty. An agent turn is dozens of sequential calls, so a route at thirty tokens a second turns
   * a twenty-minute task into an hour of watching a cursor - and the endpoints that sit far below
   * this on a busy model are typically fractions of it rather than a little under, which is what
   * makes a single figure workable across models rather than a fudge.
   */
  minimumTokensPerSecond: 60,
  ignoredProviders: []
};

/** The aggregator's `provider` fields, exactly as they go on the wire. */
export interface ProviderPreferences {
  sort?: 'price' | 'throughput';
  preferred_min_throughput?: number;
  ignore?: string[];
}

/**
 * Turns the owner's rule into the aggregator's own routing fields.
 *
 * `preferred_min_throughput` deprioritises rather than excludes - an endpoint below the threshold
 * moves to the end of the list instead of leaving it - so this can never be the reason a request
 * fails, and no ceremony is needed here to keep a fallback available. That is also why it composes
 * with `sort`: the threshold partitions, and the sort orders inside each part. Cheapest-first over
 * a list whose slow endpoints have already been pushed to the back is precisely "the cheapest one
 * that is fast enough", executed on the aggregator's own numbers.
 */
export const providerPreferences = (
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY
): ProviderPreferences => {
  const ignore = policy.ignoredProviders
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const shared = ignore.length ? { ignore } : {};
  if (policy.objective === 'fastest') return { ...shared, sort: 'throughput' };
  // The aggregator's own default made explicit, and the only arm that names no floor: an owner who
  // asked for the cheapest has said that slowness is acceptable, and a floor would contradict them.
  if (policy.objective === 'cheapest') return { ...shared, sort: 'price' };
  const floor = Math.round(policy.minimumTokensPerSecond);
  return {
    ...shared,
    sort: 'price',
    ...(floor > 0 ? { preferred_min_throughput: floor } : {})
  };
};
