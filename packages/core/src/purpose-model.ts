import type {
  ModelRelease,
  ModelPurpose,
  PurposeModelChoice,
  PrivacyRoute
} from '@athanor/contracts';
import {
  priceCeilingFields,
  selectModel,
  type OwnerPriceCeiling,
  type ModelTaskKind
} from './model-policy.js';

/** One selection contract for settings previews and the requests that use them. */
export function selectPurposeModel(input: {
  purpose: Extract<ModelPurpose, 'main' | 'specialist' | 'coding'>;
  choice: PurposeModelChoice;
  catalog: readonly ModelRelease[];
  privacyRoute: PrivacyRoute;
  provider?: string;
  ceiling?: OwnerPriceCeiling;
  taskKind?: ModelTaskKind;
}): { model: ModelRelease | null; reason: string | null } {
  const catalog = input.catalog.filter(
    (model) => !input.provider || model.provider === input.provider
  );
  const result = selectModel(catalog, {
    privacyRoute: input.privacyRoute,
    requiredCapabilities:
      input.purpose === 'specialist' ? ['chat', 'tools', 'reasoning'] : ['chat', 'tools'],
    requiredModalities: ['text'],
    minContextTokens: 16_000,
    preference: input.choice.preference,
    taskKind: input.purpose === 'coding' ? 'coding' : (input.taskKind ?? 'general'),
    ...priceCeilingFields(input.ceiling),
    ...(!input.choice.automatic ? { requestedId: input.choice.modelId } : {})
  });
  const model =
    result.ceilingOutcome === 'requested_over_ceiling'
      ? null
      : (catalog.find((item) => item.id === result.choice?.model.id) ?? null);
  return {
    model,
    reason: model
      ? null
      : (result.message ?? 'The selected model is unavailable for this purpose and privacy route.')
  };
}
