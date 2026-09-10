import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  providerPreferences,
  shouldMeasureCeiling,
  type RoutingPolicy
} from './endpoint-routing.js';

const policy = (over: Partial<RoutingPolicy> = {}): RoutingPolicy => ({
  ...DEFAULT_ROUTING_POLICY,
  ...over
});

/**
 * The owner's rule: the cheapest company reaching some share of the fastest one's speed. Both
 * halves are the aggregator's to apply - it compares each company's throughput against the floor
 * using figures taken across every request it has ever served, then orders what clears it by price.
 * This side supplies the floor and nothing else.
 */
describe('asking for the cheapest company that is fast enough', () => {
  /*
   * The real table this was built against: Novita 142 tokens a second, DeepInfra 16, io.net 3, with
   * io.net at half the price. At 40% of 142 the floor is 56, so both slower companies fall behind
   * it and the price sort returns the only one in front. Without the floor that same price sort
   * returns io.net, which is what the aggregator does by default and is three tokens a second.
   */
  it('floors at the owner’s share of the fastest, and sorts the survivors on price', () => {
    expect(providerPreferences(policy(), 142)).toEqual({
      sort: 'price',
      preferred_min_throughput: 56
    });
  });

  /**
   * The property that makes a fixed rate unusable. A model whose quickest company manages forty
   * tokens a second is judged against forty; a fixed sixty would deprioritise every endpoint it
   * has, and a price sort over a wholly deprioritised field returns the cheapest - the aggregator's
   * own default, and the exact defect this replaces. A wrong floor fails silently into the old
   * behaviour, which is why it can never be a constant.
   */
  it('scales the floor to what the model can actually reach', () => {
    expect(providerPreferences(policy(), 40).preferred_min_throughput).toBe(16);
    expect(providerPreferences(policy(), 900).preferred_min_throughput).toBe(360);
  });

  it('carries the owner’s own share', () => {
    expect(providerPreferences(policy({ throughputFloorPercent: 75 }), 142)).toMatchObject({
      preferred_min_throughput: 106
    });
  });

  /*
   * Rounded down: a company sitting exactly on the owner's share is one they said they would
   * accept, and a fraction of a token per second should not be what shuts it out.
   */
  it('rounds the floor down rather than to nearest', () => {
    expect(providerPreferences(policy(), 142.9).preferred_min_throughput).toBe(57);
  });

  it('never asks for a floor of zero, which is a preference that filters nothing', () => {
    expect(providerPreferences(policy({ throughputFloorPercent: 0 }), 142)).toEqual({
      sort: 'price'
    });
  });

  /**
   * With no ceiling there is no share to take, and the honest answer is to go and get one: sorting
   * by throughput routes to the company the aggregator ranks quickest, which is both a good route
   * to be on and the only way to learn what quickest means here.
   */
  it('asks for the fastest while it still has nothing to take a share of', () => {
    expect(providerPreferences(policy(), null)).toEqual({ sort: 'throughput' });
    expect(shouldMeasureCeiling(policy(), null)).toBe(true);
    expect(shouldMeasureCeiling(policy(), 142)).toBe(false);
  });

  it('does not go measuring for an owner who asked for fastest or cheapest', () => {
    expect(shouldMeasureCeiling(policy({ objective: 'fastest' }), null)).toBe(false);
    expect(shouldMeasureCeiling(policy({ objective: 'cheapest' }), null)).toBe(false);
  });

  it('follows the owner to fastest or cheapest, and names no floor for either', () => {
    expect(providerPreferences(policy({ objective: 'fastest' }), 142)).toEqual({
      sort: 'throughput'
    });
    expect(providerPreferences(policy({ objective: 'cheapest' }), 142)).toEqual({ sort: 'price' });
  });

  it('passes on the companies the owner struck off, normalised', () => {
    expect(
      providerPreferences(policy({ ignoredProviders: ['  Novita ', 'DeepInfra', ' '] }), 142).ignore
    ).toEqual(['novita', 'deepinfra']);
  });
});
