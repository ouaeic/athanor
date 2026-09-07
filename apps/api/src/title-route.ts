import type { PrivacyRoute } from '@athanor/contracts';
import { isModelEligible, type RoutableModel, type ModelRequest } from '@athanor/core';

export const TITLE_MAX_COST_USD = 0.005;
export const TITLE_OUTPUT_TOKENS = 256;

export interface TitleRoute {
  model: RoutableModel;
  maxTokens: number;
  maxCostUsd: number;
  maxPrice: { prompt: number; completion: number; request: 0 };
  reasoningEffort?: 'none';
}

/** A full-context quote avoids estimating the provider's tokenizer or hidden message framing. */
export const selectTitleRoute = (
  models: readonly RoutableModel[],
  input: {
    provider: string;
    privacyRoute: PrivacyRoute;
    ceiling: Pick<ModelRequest, 'maxInputUsdPerMillionTokens' | 'maxOutputUsdPerMillionTokens'>;
  }
): TitleRoute | null => {
  const candidates: TitleRoute[] = [];
  for (const model of models) {
    if (model.provider !== input.provider || model.privacyRoute !== input.privacyRoute) continue;
    if (model.expiresAt && Date.parse(model.expiresAt) <= Date.now()) continue;
    const reasoning = model.reasoning;
    if (reasoning?.mandatory) continue;
    const disableReasoning = reasoning?.supportedEfforts?.includes('none') === true;
    const nonReasoning =
      reasoning?.defaultEnabled === false ||
      (model.supportsReasoningEffort === false && !model.capabilities.includes('reasoning'));
    if (!disableReasoning && !nonReasoning) continue;
    if (
      !isModelEligible(model, {
        privacyRoute: input.privacyRoute,
        requiredCapabilities: ['chat'],
        requiredModalities: ['text'],
        minContextTokens: 4_096,
        preference: 'fast',
        ...input.ceiling
      })
    )
      continue;
    const rates = [
      { input: model.inputUsdPerMillionTokens, output: model.outputUsdPerMillionTokens },
      ...(model.priceTiers ?? []).map((tier) => ({
        input: tier.inputUsdPerMillionTokens,
        output: tier.outputUsdPerMillionTokens
      }))
    ];
    if (
      rates.some(
        (rate) =>
          typeof rate.input !== 'number' ||
          !Number.isFinite(rate.input) ||
          rate.input < 0 ||
          typeof rate.output !== 'number' ||
          !Number.isFinite(rate.output) ||
          rate.output < 0
      )
    )
      continue;
    const prompt = Math.max(...rates.map((rate) => rate.input!));
    const completion = Math.max(...rates.map((rate) => rate.output!));
    if (
      (input.ceiling.maxInputUsdPerMillionTokens !== undefined &&
        prompt > input.ceiling.maxInputUsdPerMillionTokens) ||
      (input.ceiling.maxOutputUsdPerMillionTokens !== undefined &&
        completion > input.ceiling.maxOutputUsdPerMillionTokens)
    )
      continue;
    if (model.maxOutputTokens != null && model.maxOutputTokens < TITLE_OUTPUT_TOKENS) continue;
    const maxCostUsd =
      (model.contextTokens * prompt + TITLE_OUTPUT_TOKENS * completion) / 1_000_000;
    if (!Number.isFinite(maxCostUsd) || maxCostUsd > TITLE_MAX_COST_USD) continue;
    candidates.push({
      model,
      maxTokens: TITLE_OUTPUT_TOKENS,
      maxCostUsd,
      maxPrice: { prompt, completion, request: 0 },
      ...(disableReasoning ? { reasoningEffort: 'none' as const } : {})
    });
  }
  return (
    candidates.sort(
      (a, b) => a.maxCostUsd - b.maxCostUsd || a.model.id.localeCompare(b.model.id)
    )[0] ?? null
  );
};
