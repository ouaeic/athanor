import { isNativeOpenAIEndpoint } from './openai-media-catalog.js';
import { readBoundedMediaBody } from './media-output.js';
import { REALTIME_MODELS, type RealtimeModelMetadata } from './realtime.js';

/** Discovery never infers duplex transport support from a model's audio modality. */
export const discoverRealtimeModels = async (input: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<RealtimeModelMetadata[]> => {
  if (!isNativeOpenAIEndpoint(input.baseUrl) || !input.apiKey)
    throw new Error('Live voice requires the native OpenAI API connection');
  const response = await (input.fetch ?? globalThis.fetch)('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${input.apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('Live voice model discovery failed');
  const body: unknown = JSON.parse(
    (await readBoundedMediaBody(response, 2_000_000)).toString('utf8')
  );
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data))
    throw new Error('Invalid live voice model catalogue');
  const ids = new Set(
    body.data.flatMap((row: unknown) =>
      row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []
    )
  );
  return REALTIME_MODELS.filter((model) => ids.has(model.modelId));
};
