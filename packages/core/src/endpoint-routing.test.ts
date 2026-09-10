import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  providerPreferences,
  type RoutingPolicy
} from './endpoint-routing.js';

const policy = (over: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  ...DEFAULT_ROUTING_POLICY,
  ...over
});

/**
 * The owner's rule: the cheapest operator that is at least fast enough to be worth its lower price,
 * and where several cost the same, the fastest of those.
 *
 * The comparison is the aggregator's, deliberately. Its throughput figures come from every request
 * it has ever served; a single computer measuring its own traffic sees only the endpoints it was
 * already routed to, which is both a tiny sample and a self-selecting one. So the rule is expressed
 * in the aggregator's own fields and applied against its own data.
 */
describe('asking for the cheapest operator that is fast enough', () => {
  it('sends a throughput floor and then sorts on price', () => {
    // The two halves of the sentence, in that order: `preferred_min_throughput` pushes the slow
    // endpoints to the back of the list, and `sort` picks the cheapest of what is left in front.
    expect(providerPreferences()).toMatchObject({
      sort: 'price',
      preferred_min_throughput: 60
    });
  });

  it('carries the owner’s own floor rather than a built-in one', () => {
    expect(providerPreferences(policy({ minimumTokensPerSecond: 25 }))).toMatchObject({
      preferred_min_throughput: 25
    });
  });

  /*
   * An owner who asked for the cheapest has said slowness is acceptable. Sending a floor as well
   * would contradict the instruction they just gave, and quietly - they would see a price sort in
   * the setting and a throughput preference on the wire.
   */
  it('names no floor when the owner asked for the cheapest, however slow', () => {
    const preferences = providerPreferences(policy({ objective: 'cheapest' }));
    expect(preferences).toEqual({ sort: 'price' });
  });

  it('drops the price sort when the owner asked for the fastest', () => {
    expect(providerPreferences(policy({ objective: 'fastest' }))).toEqual({ sort: 'throughput' });
  });

  it('passes on the operators the owner has struck off, normalised', () => {
    expect(
      providerPreferences(policy({ ignoredProviders: ['  Novita ', 'DeepInfra', '  '] }))
    ).toMatchObject({ ignore: ['novita', 'deepinfra'] });
  });

  it('says nothing about operators when the owner has struck none off', () => {
    expect(providerPreferences()).not.toHaveProperty('ignore');
  });

  /*
   * A floor of zero is not a floor. Sending it would be a preference that reads as one and filters
   * nothing, which is worse than the absence it is equivalent to.
   */
  it('omits a floor of zero rather than sending one', () => {
    expect(providerPreferences(policy({ minimumTokensPerSecond: 0 }))).not.toHaveProperty(
      'preferred_min_throughput'
    );
  });

  it('sends a whole number, because the field is a rate and not a measurement', () => {
    expect(providerPreferences(policy({ minimumTokensPerSecond: 56.8 }))).toMatchObject({
      preferred_min_throughput: 57
    });
  });
});
