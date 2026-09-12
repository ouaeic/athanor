import type { ModelRelease, PrivacyRoute } from '@athanor/contracts';
import { AthanorError, selectPurposeModel, type OwnerPriceCeiling } from '@athanor/core';

/** Named choices share the same contract as project model preferences. */
export function requireMainModel(input: {
  modelId: string;
  catalog: readonly ModelRelease[];
  privacyRoute: PrivacyRoute;
  ceiling: OwnerPriceCeiling;
}): ModelRelease {
  const result = selectPurposeModel({
    purpose: 'main',
    choice: { automatic: false, preference: 'balanced', modelId: input.modelId },
    catalog: input.catalog,
    privacyRoute: input.privacyRoute,
    ceiling: input.ceiling
  });
  if (!result.model)
    throw new AthanorError(
      'model_unavailable',
      result.reason ?? 'The selected model is unavailable'
    );
  return result.model;
}
