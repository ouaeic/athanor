import { ModelRelease } from '@athanor/contracts';
import {
  refreshOpenRouterCatalog,
  seedModels,
  type ModelCatalogScope
} from '@athanor/model-gateway';
import { catalogCredential, type CredentialSource } from './catalog-credential.js';
import { refreshFailureReason } from './refresh-log.js';

/**
 * One pass of the refresh loop, lifted out of it.
 *
 * It was the body of a `while (running)` block, which meant the four states this service can end a
 * pass in - it refreshed, it seeded a new box, it has no key and a catalogue it cannot refresh, it
 * failed - were reachable only by running the loop, and so were tested by nothing at all. The one
 * that mattered most had already cost the owner their picker once (see `!existing.length` below).
 *
 * Naming the outcome is also what lets the pass be *said* and *written down* rather than only
 * done: the journal line and the timestamp `athanor doctor` reads are both built from this value.
 */
export interface CatalogStore extends CredentialSource {
  listModels(): Promise<Array<Record<string, unknown>>>;
  replaceModelCatalog(models: Array<Record<string, unknown>>): Promise<unknown>;
  upsertModels(models: Array<Record<string, unknown>>): Promise<void>;
}

/**
 * The refresh stated in this service's own terms rather than the gateway's, so a pass can be
 * exercised without a provider and without knowing the shape of a catalogue row.
 * `refreshOpenRouterCatalog` satisfies it.
 */
export type CatalogRefresh = (
  allowlist: ModelRelease[],
  options: {
    baseUrl: string;
    apiKey: string;
    scope: ModelCatalogScope;
    previous: ModelRelease[];
  }
) => Promise<Array<Record<string, unknown>>>;

export interface RefreshOutcome {
  /**
   * `refreshed` - a provider answered and the whole catalogue was replaced.
   * `seeded` - no key and an empty catalogue, so the built-in list was written to fill it.
   * `frozen` - no key and a catalogue already in the database, which is therefore staying exactly
   * as it is until a key appears. This is an ordinary state on a box whose owner runs their own
   * endpoint, and it is also what a revoked key looks like, which is why it is said out loud.
   * `failed` - the attempt threw; the catalogue already in the database stays in use.
   */
  state: 'refreshed' | 'seeded' | 'frozen' | 'failed';
  /**
   * What the catalogue holds after this pass, for the journal line and for `doctor`. On a `failed`
   * pass it is what the pass managed to read before it threw, so it is zero when the failure came
   * before the catalogue was listed at all - an unopenable credential, say.
   */
  models: number;
  /** Set only for `failed`, bounded and flattened to one line by `refreshFailureReason`. */
  reason: string | null;
}

export const refreshOnce = async (input: {
  store: CatalogStore;
  masterKey: Uint8Array | null;
  environmentKey?: string | undefined;
  baseUrl: string;
  scope: ModelCatalogScope;
  refreshCatalog?: CatalogRefresh;
  seed?: () => ModelRelease[];
}): Promise<RefreshOutcome> => {
  const refreshCatalog = input.refreshCatalog ?? refreshOpenRouterCatalog;
  const seed = input.seed ?? seedModels;
  // Carried out of the try so a failure can still say how many models the picker is living on.
  let existingCount = 0;
  try {
    // The default scope offers whatever the owner's own provider account can reach, so a model
    // released after this build still appears without a code change. `reviewed_open_weight`
    // restores the stricter allowlist. A refresh failure preserves the previous catalog rather
    // than weakening privacy requirements or emptying the model picker.
    const credential = await catalogCredential({
      store: input.store,
      masterKey: input.masterKey,
      environmentKey: input.environmentKey
    });
    const existing = await input.store.listModels();
    existingCount = existing.length;
    if (credential) {
      // A real refresh, and a replace rather than an upsert: a model the provider has withdrawn
      // should leave the picker rather than sit in it until somebody tries to use it.
      const live = await refreshCatalog(seed(), {
        baseUrl: credential.baseUrl ?? input.baseUrl,
        apiKey: credential.apiKey,
        scope: input.scope,
        /*
         * What the catalogue said an hour ago, so one failing request cannot withdraw the owner's
         * private routes. Zero-retention is a fact about live endpoints and it arrives on its own
         * request; when that request alone fails, the answer carried forward is the last one this
         * box actually observed rather than "not verified", which the privacy projection would
         * read as a reason to take every private model out of the picker.
         */
        previous: existing.flatMap((model) => {
          const parsed = ModelRelease.safeParse(model);
          return parsed.success ? [parsed.data] : [];
        })
      });
      await input.store.replaceModelCatalog(live);
      // `replaceModelCatalog` prunes nothing when the provider answered with an empty list, so the
      // catalogue that survives an empty answer is the one that was already there.
      return { state: 'refreshed', models: live.length || existingCount, reason: null };
    }
    if (!existingCount) {
      /*
       * No key, so there is nothing to refresh from — but an empty catalogue still needs something
       * in it, and this is the only thing that puts it there on a new box.
       *
       * It used to write the seed on every pass regardless. No shipped path sets a registry key, so
       * within an hour of finishing setup the static seed landed on top of the catalogue the API
       * had enriched from the owner's own provider account: the curated models went back to
       * availability 'review' and lost their prices, which took them out of the picker and made any
       * task or schedule pinned to one fail with model_unavailable. The owner's fix was to re-save
       * their provider key, and an hour later it happened again.
       */
      const models = seed();
      await input.store.upsertModels(models);
      return { state: 'seeded', models: models.length, reason: null };
    }
    return { state: 'frozen', models: existingCount, reason: null };
  } catch (error) {
    return { state: 'failed', models: existingCount, reason: refreshFailureReason(error) };
  }
};
