/**
 * Turning a recording into text, priced from what this account has actually been charged.
 */

import { AthanorError, assertSpendAllowed, sha256 } from '@athanor/core';
import { z } from 'zod';
import {
  TRANSCRIPTION_FORMATS,
  transcriptionEstimateUsd,
  transcriptionSecondsFromPayload
} from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerTranscriptionRoutes = (context: RouteContext): void => {
  const { app, store, inferenceCredential, measuredTranscriptionUsdPerMinute, config } = context;
  app.post('/v1/audio/transcriptions', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        data: z.string().min(1).max(20_000_000),
        format: z.enum(TRANSCRIPTION_FORMATS)
      })
      .parse(request.body);
    const { secret } = await inferenceCredential(user.id);
    if (secret.provider !== 'openrouter' || !secret.apiKey)
      throw new AthanorError(
        'transcription_provider_required',
        'Voice transcription currently requires an OpenRouter connection in Settings',
        409
      );
    const baseUrl = secret.baseUrl.replace(/\/$/, '');
    const headers = {
      authorization: `Bearer ${secret.apiKey}`,
      'content-type': 'application/json',
      'http-referer': config.PUBLIC_APP_URL,
      'x-title': 'athanor'
    };
    // The owner's own choice, where they have made one. This route used to take whatever stood at
    // the top of the provider's weekly list, which meant the model that reads a voice note into the
    // composer could change under them between one dictation and the next, and could never be the
    // one they picked in Settings. The catalogue is now the fallback rather than the answer, and it
    // is the same sealed choice the agent's audio_read reads.
    const pinned =
      secret.mediaRoutes?.transcription?.modality === 'transcription'
        ? secret.mediaRoutes.transcription
        : undefined;
    /*
     * Dictation is spending, and until this it was the only spending on the box that neither asked
     * the caps first nor left a line in the ledger. `GET /v1/spend` and `GET /v1/usage` reported
     * task inference and nothing else, so an owner dictating long notes against a monthly cap
     * watched a ceiling that could never fire and a provider bill nothing in the product could
     * explain.
     *
     * Asked before the recording leaves the box - before the catalogue is even consulted - for the
     * reason the agent's own `audio_read` gives: duration billing means the money is spent the
     * moment the request is accepted, so a check that ran afterwards would be a report rather than
     * a brake. Open commitments count, the same as they do when a task is started: a queued
     * afternoon of work has already promised the day's headroom, and a voice note must not promise
     * it a second time.
     */
    const seconds = transcriptionSecondsFromPayload(input.data, input.format);
    const usdPerMinute =
      pinned &&
      pinned.priceSource !== 'unknown' &&
      typeof pinned.usdPerMinute === 'number' &&
      Number.isFinite(pinned.usdPerMinute)
        ? pinned.usdPerMinute
        : await measuredTranscriptionUsdPerMinute(user.id);
    assertSpendAllowed(
      await store.spendGuard({
        userId: user.id,
        estimateUsd: transcriptionEstimateUsd(seconds, usdPerMinute),
        includeOpenCommitments: true
      })
    );
    const model = await (async (): Promise<string | undefined> => {
      if (pinned?.providerModelId) return pinned.providerModelId;
      const catalogUrl = new URL(`${baseUrl}/models`);
      catalogUrl.searchParams.set('output_modalities', 'transcription');
      catalogUrl.searchParams.set('sort', 'top-weekly');
      const catalogResponse = await fetch(catalogUrl, {
        headers,
        signal: AbortSignal.timeout(15_000)
      }).catch(() => undefined);
      if (!catalogResponse?.ok)
        throw new AthanorError(
          'transcription_catalog_unavailable',
          'The transcription catalogue could not be reached',
          503
        );
      const catalog = (await catalogResponse.json()) as { data?: Array<{ id?: string }> };
      return catalog.data?.find((entry) => typeof entry.id === 'string')?.id;
    })();
    if (!model)
      throw new AthanorError(
        'transcription_model_unavailable',
        'No transcription model is currently available from OpenRouter',
        503
      );
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        input_audio: { data: input.data, format: input.format },
        temperature: 0,
        provider: {
          zdr: true,
          data_collection: 'deny',
          require_parameters: true,
          allow_fallbacks: true
        }
      })
    }).catch(() => undefined);
    if (!response?.ok)
      throw new AthanorError(
        'transcription_failed',
        response?.status === 429
          ? 'The transcription provider is busy or rate-limited; try again shortly'
          : 'No zero-retention transcription route accepted this voice note',
        response?.status === 429 ? 429 : 503
      );
    const result = (await response.json()) as {
      text?: string;
      usage?: {
        seconds?: number;
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
      };
    };
    /*
     * Written between the charge and everything that could still fail, exactly as a generation is.
     * The provider has billed by this line: a note it read and then declined to return any speech
     * from cost the same as one it returned a paragraph from, so the refusal below must not be the
     * thing that decides whether the owner is told about the money.
     *
     * The provider's own figure where it states one. Where it does not, what the estimate said -
     * which is the same fallback `transcribe` makes on the agent's path, and is a floor rather than
     * a claim when nobody has priced the route at all.
     */
    const billedSeconds =
      typeof result.usage?.seconds === 'number' && Number.isFinite(result.usage.seconds)
        ? result.usage.seconds
        : seconds;
    await store.recordUsage({
      userId: user.id,
      kind: 'model_inference',
      resourceClass: 'media:transcription',
      quantity: Math.max(1, Math.round(billedSeconds)),
      unit: 'second',
      credits: 0,
      state: 'settled',
      costUsd:
        typeof result.usage?.cost === 'number' &&
        Number.isFinite(result.usage.cost) &&
        result.usage.cost >= 0
          ? result.usage.cost
          : transcriptionEstimateUsd(billedSeconds, usdPerMinute),
      // Keyed on the recording, so a client that resends a note whose answer was lost on the way
      // back is not billed for it twice on the owner's own ledger. Under the account as well as the
      // bytes: two people on one box saying the same sentence are two charges.
      idempotencyKey: `audio:${user.id}:${sha256(input.data)}:transcription`,
      providerRef: `${secret.provider}:${model}`
    });
    if (!result.text?.trim())
      throw new AthanorError(
        'transcription_empty',
        'The transcription model did not return any speech',
        422
      );
    return {
      text: result.text.trim(),
      model,
      usage: result.usage ?? null,
      privacyRoute: 'provider_zdr' as const
    };
  });
};
