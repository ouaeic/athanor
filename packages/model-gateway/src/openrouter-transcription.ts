import { mediaRate, mediaRecord, type CatalogMediaModel } from './media-capabilities.js';
import { readBoundedMediaBody } from './media-output.js';

export const isOpenRouterEndpoint = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'openrouter.ai' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/\/$/, '') === '/api/v1'
    );
  } catch {
    return false;
  }
};

// The models feed omits units. These exact pairs are documented in the provider tables at
// https://openrouter.ai/openai/whisper-1/providers and
// https://openrouter.ai/openai/whisper-large-v3/. Values are seconds per published unit.
const durationUnits: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'openai/whisper-1': { openai: 60 },
  'openai/whisper-large-v3': { deepinfra: 1, together: 60, groq: 3600 }
};

export const hasOpenRouterTranscriptionDurationProfile = (modelId: string): boolean =>
  Object.hasOwn(durationUnits, modelId);

/** STT load-balances without request routing controls, so every endpoint must have a known unit. */
export const openRouterTranscriptionDurationRate = (
  modelId: string,
  body: unknown
): number | null => {
  const units = durationUnits[modelId];
  if (!units || !mediaRecord(body) || !mediaRecord(body.data)) return null;
  const model = body.data;
  if (model.id !== modelId || !Array.isArray(model.endpoints) || !model.endpoints.length)
    return null;
  const rates: number[] = [];
  for (const endpoint of model.endpoints) {
    if (
      !mediaRecord(endpoint) ||
      endpoint.model_id !== modelId ||
      typeof endpoint.tag !== 'string' ||
      !Object.hasOwn(units, endpoint.tag) ||
      !mediaRecord(endpoint.pricing)
    )
      return null;
    const rate = mediaRate(endpoint.pricing.prompt);
    if (
      rate === null ||
      mediaRate(endpoint.pricing.completion) !== 0 ||
      Object.entries(endpoint.pricing).some(
        ([key, value]) =>
          !['prompt', 'completion', 'discount'].includes(key) && mediaRate(value) !== 0
      )
    )
      return null;
    // Include unavailable endpoints: their status can recover before the request is routed.
    rates.push((rate * 60) / units[endpoint.tag]!);
  }
  const maximum = Math.max(...rates);
  return Number.isFinite(maximum) ? maximum : null;
};

export const refreshOpenRouterTranscriptionModel = async (
  model: CatalogMediaModel,
  options: { baseUrl: string; apiKey: string; fetch?: typeof fetch; now?: Date }
): Promise<CatalogMediaModel> => {
  const cleaned: CatalogMediaModel = {
    ...model,
    apiProtocol: 'openrouter',
    zeroDataRetentionAvailable: false,
    requiresRetentionApproval: true,
    usdPerMinute: null,
    pricing: [],
    priceSource: 'unknown',
    recommendationTags: ['External transcription requires approval'],
    unavailableReason: 'The provider has no verified cost bound across its transcription endpoints'
  };
  delete cleaned.providerEndpointTag;
  delete cleaned.metadataVerifiedAt;
  if (
    model.modality !== 'transcription' ||
    !hasOpenRouterTranscriptionDurationProfile(model.providerModelId)
  )
    return cleaned;
  try {
    const path = model.providerModelId.split('/').map(encodeURIComponent).join('/');
    const response = await (options.fetch ?? globalThis.fetch)(
      `${options.baseUrl.replace(/\/$/, '')}/models/${path}/endpoints`,
      {
        headers: { authorization: `Bearer ${options.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      }
    );
    if (!response.ok) return cleaned;
    const body: unknown = JSON.parse(
      (await readBoundedMediaBody(response, 1024 * 1024)).toString('utf8')
    );
    const rate = openRouterTranscriptionDurationRate(model.providerModelId, body);
    if (rate === null) return cleaned;
    return {
      ...cleaned,
      usdPerMinute: rate,
      pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: rate }],
      priceSource: 'provider',
      metadataVerifiedAt: (options.now ?? new Date()).toISOString(),
      unavailableReason: null,
      recommendationTags: [
        'External transcription requires approval',
        'Maximum routed duration price'
      ]
    };
  } catch {
    return cleaned;
  }
};
