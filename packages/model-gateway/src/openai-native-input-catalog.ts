import type { ConfiguredModelDescription } from './openai-compatible.js';
import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';

export const OPENAI_NATIVE_INPUT_DOCUMENTATION = {
  modelId: 'gpt-audio-1.5',
  source: 'https://developers.openai.com/api/docs/models/gpt-audio-1.5',
  checkedAt: '2026-09-06',
  contextTokens: 128_000,
  maxOutputTokens: 16_384,
  inputUsdPerMillionTokens: 2.5,
  outputUsdPerMillionTokens: 10,
  audioUsdPerMillionTokens: 32,
  inputModalities: ['text', 'audio']
} as const;

/** Account discovery supplies availability; exact documented IDs supply otherwise absent metadata. */
export const describeNativeOpenAIInput = (
  baseUrl: string,
  model: ConfiguredModelDescription
): ConfiguredModelDescription => {
  const documented = OPENAI_NATIVE_INPUT_DOCUMENTATION;
  if (!isNativeOpenAIEndpoint(baseUrl) || model.id !== documented.modelId) return model;
  const modalities: ConfiguredModelDescription['inputModalities'] = [...documented.inputModalities];
  return {
    ...model,
    contextTokens: Math.min(model.contextTokens ?? Infinity, documented.contextTokens),
    maxOutputTokens: Math.min(model.maxOutputTokens ?? Infinity, documented.maxOutputTokens),
    inputUsdPerMillionTokens: Math.max(
      model.inputUsdPerMillionTokens ?? 0,
      documented.inputUsdPerMillionTokens
    ),
    outputUsdPerMillionTokens: Math.max(
      model.outputUsdPerMillionTokens ?? 0,
      documented.outputUsdPerMillionTokens
    ),
    nativeInputPricing: {
      audioUsdPerMillionTokens: Math.max(
        model.nativeInputPricing?.audioUsdPerMillionTokens ?? 0,
        documented.audioUsdPerMillionTokens
      ),
      videoUsdPerMillionTokens: null
    },
    inputModalities: model.inputModalities
      ? modalities.filter((kind) => model.inputModalities!.includes(kind))
      : modalities,
    supportsTools: model.supportsTools ?? true,
    supportsReasoningEffort: model.supportsReasoningEffort ?? false,
    unknownFields: [],
    metadataSource: 'declared'
  };
};
