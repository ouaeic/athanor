/**
 * The catalogue: seeded at boot, then read back per account with this box's own routing on it.
 *
 * Seeding runs before anything is served because the first request must not race a half-filled
 * catalogue, and it is deliberately additive: a live refresh from the provider wins, the built-in
 * seeds fill what the refresh did not name, and a directly configured endpoint is added as its
 * own single-model provider.
 */

import { modelTaskKinds, priceCeilingFields, rankModels } from '@athanor/core';
import type { ModelTaskKind } from '@athanor/core';
import { refreshOpenRouterCatalog, seedModels } from '@athanor/model-gateway';
import { ownerPriceCeiling } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext, ServerBase } from '../http/server-context.js';
import { errorFields } from '../log.js';

export const seedModelCatalog = async (context: ServerBase): Promise<void> => {
  const { log, store, config, overrides } = context;
  const modelSeeds = seedModels();
  const configuredOpenRouterKey =
    config.AI_PROVIDER === 'openrouter'
      ? (config.AI_API_KEY ?? config.OPENROUTER_API_KEY)
      : config.OPENROUTER_API_KEY;
  if (configuredOpenRouterKey) {
    try {
      const liveModels = await refreshOpenRouterCatalog(modelSeeds, {
        baseUrl:
          config.AI_PROVIDER === 'openrouter' ? config.AI_BASE_URL : config.OPENROUTER_BASE_URL,
        apiKey: configuredOpenRouterKey,
        ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
      });
      await store.upsertModels(liveModels);
    } catch (error) {
      log.warn('models.catalog_refresh_failed', errorFields(error));
    }
  }
  const refreshedModels = await store.listModels();
  const existingModelIds = new Set(refreshedModels.map((model) => String(model.id)));
  await store.upsertModels(modelSeeds.filter((model) => !existingModelIds.has(model.id)));
  if (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL) {
    await store.upsertModels([
      {
        id: `custom/${config.AI_DEFAULT_MODEL}`,
        providerModelId: config.AI_DEFAULT_MODEL,
        displayName: config.AI_DEFAULT_MODEL,
        provider: 'custom',
        revision: 'provider-managed',
        availability: 'available',
        openness: 'remote_proprietary',
        license: 'Provider-defined',
        commercialUse: true,
        privacyRoute: config.AI_REQUIRE_ZDR ? 'provider_zdr' : 'external',
        contextTokens: 128_000,
        modalities: ['text'],
        capabilities: ['chat', 'tools', 'reasoning'],
        usageClass: 'medium',
        recommendationTags: ['Configured endpoint'],
        measuredQuality: null,
        measuredLatencyMs: null,
        updatedAt: new Date().toISOString()
      }
    ]);
  }
};

export const registerModelRoutes = (context: RouteContext): void => {
  const { app, store, modelsForUser } = context;
  app.get('/v1/models', async (request) => modelsForUser(requireUser(request.user)));
  app.get<{
    Querystring: {
      privacyRoute?: 'provider_zdr' | 'external';
      preference?: 'fast' | 'balanced' | 'best';
      /**
       * The full router vocabulary, not the three coarse kinds this used to admit. Five profiles -
       * vision, long context, reasoning, bulk summarisation, conversation - were written, weighted
       * and tested, and were unreachable from the only HTTP entry point that ranks anything.
       */
      taskKind?: ModelTaskKind;
    };
  }>('/v1/models/recommend', async (request) => {
    /*
     * A ranking, which is an order and the reason for it - not another copy of the catalogue.
     *
     * This returned every ranked model in full and came to 324 kB, on top of the 426 kB bootstrap,
     * on every model-preference change. Its only caller maps it to `entry.model.id`. The score and
     * the reasoning stay, because they are the answer to "why this one" and cost almost nothing;
     * what goes is the third copy of a record the client already has enough of.
     */
    const user = requireUser(request.user);
    const ranked = rankModels(await modelsForUser(user), {
      privacyRoute: request.query.privacyRoute ?? 'provider_zdr',
      requiredCapabilities: ['chat', 'tools'],
      requiredModalities: ['text'],
      minContextTokens: 16_000,
      preference: request.query.preference ?? 'balanced',
      // Recommending a route the owner's own ceiling would refuse is how a limit becomes a
      // suggestion: the picker offers it, the composer sends it as an explicit `modelId`, and the
      // exemption for an explicit pick - which exists so the owner is never overruled - carries it
      // straight past the ceiling they set.
      ...priceCeilingFields(ownerPriceCeiling(await store.effectiveSpendLimits(user.id))),
      // A kind this server does not know is a client from another version, not a bad request: rank
      // it as general work rather than refusing to answer with the whole catalogue.
      taskKind: modelTaskKinds.includes(request.query.taskKind as ModelTaskKind)
        ? (request.query.taskKind as ModelTaskKind)
        : 'general'
    });
    // Reasoning for the head, an order for the tail. Every entry carried seven sentences explaining
    // a placement no interface will ever show for the three-hundredth-best model; what the caller
    // needs from the tail is its position, and what it needs from the front is the argument.
    const EXPLAINED = 8;
    return ranked.map((entry, index) => ({
      modelId: entry.model.id,
      displayName: entry.model.displayName,
      score: entry.score,
      ...(index < EXPLAINED ? { reasons: entry.reasons } : {})
    }));
  });
};
