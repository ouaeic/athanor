import { OwnerPreferences } from '@athanor/contracts';
import { DEFAULT_ROUTING_POLICY, type RoutingPolicy } from '@athanor/core';
import type { DataStore } from '@athanor/data';

/**
 * The owner's rule for choosing between the companies serving one model.
 *
 * Unreadable preferences are the default preferences, never a reason to stop routing: a turn that
 * failed because a settings row would not parse would be this feature costing the owner the thing
 * it exists to improve.
 */
export const routingPolicyFor = async (
  store: DataStore,
  userId: string
): Promise<RoutingPolicy> => {
  try {
    const user = await store.getUserById(userId);
    const routing = OwnerPreferences.parse(user?.preferences ?? {}).providerRouting;
    if (!routing) return DEFAULT_ROUTING_POLICY;
    return {
      objective: routing.objective,
      minimumTokensPerSecond: routing.minimumTokensPerSecond,
      ignoredProviders: routing.ignoredProviders
    };
  } catch {
    return DEFAULT_ROUTING_POLICY;
  }
};
