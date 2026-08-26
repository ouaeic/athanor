import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad } from '@athanor/core';
import { refreshOnce, type CatalogStore } from './refresh-once.js';

const masterKey = randomBytes(32);
const OWNER = 'ffffffff-2222-4222-8222-ffffffffffff';

interface Catalogue {
  store: CatalogStore;
  /** Every whole-catalogue replacement this pass performed, in order. */
  replaced: Array<Array<Record<string, unknown>>>;
  /** Every seed write. On a box with a live catalogue this list has to stay empty. */
  upserted: Array<Array<Record<string, unknown>>>;
}

const catalogue = (existing: Array<Record<string, unknown>>, savedKey?: string): Catalogue => {
  const replaced: Array<Array<Record<string, unknown>>> = [];
  const upserted: Array<Array<Record<string, unknown>>> = [];
  const rows = [...existing];
  return {
    replaced,
    upserted,
    store: {
      soleUser: async () => ({ id: OWNER }),
      getManagedProviderCredential: async (userId: string, provider: string) => {
        if (!savedKey || provider !== 'inference' || userId !== OWNER) return null;
        return {
          provider: 'inference',
          status: 'active',
          secretCiphertext: encryptJson(
            { provider: 'openrouter', apiKey: savedKey },
            masterKey,
            inferenceCredentialAad(OWNER)
          )
        };
      },
      listModels: async () => rows,
      replaceModelCatalog: async (models) => {
        replaced.push(models);
        rows.splice(0, rows.length, ...models);
      },
      upsertModels: async (models) => {
        upserted.push(models);
        rows.push(...models);
      }
    }
  };
};

const pass = (store: CatalogStore, over: Partial<Parameters<typeof refreshOnce>[0]> = {}) =>
  refreshOnce({
    store,
    masterKey: null,
    baseUrl: 'https://openrouter.test/api/v1',
    scope: 'provider_catalog',
    refreshCatalog: async () => [],
    ...over
  });

describe('refreshOnce', () => {
  it('writes the built-in seed into an empty catalogue, which is the only thing that fills it on a box with no provider key', async () => {
    const fake = catalogue([]);
    const outcome = await pass(fake.store);
    expect(outcome.state).toBe('seeded');
    expect(outcome.reason).toBeNull();
    expect(fake.upserted).toHaveLength(1);
    expect(outcome.models).toBeGreaterThan(0);
    expect(fake.upserted[0]).toHaveLength(outcome.models);
    expect(fake.replaced).toEqual([]);
  });

  /*
   * The regression guard, for a defect this box has already had. The seed used to be written on
   * every pass with no key at all, and no shipped path sets a registry key - so within an hour of
   * finishing setup the static seed landed on top of the catalogue the API had enriched from the
   * owner's own provider account. The curated models went back to availability 'review', lost
   * their prices, left the picker, and every task or schedule pinned to one failed with
   * model_unavailable. The `!existing.length` guard is what ended that, and until now nothing
   * held it in place.
   */
  it('leaves a catalogue that already holds models exactly as it is when there is no key, rather than writing the seed over what the API enriched', async () => {
    const enriched = [
      {
        id: 'openrouter/anthropic/claude-sonnet-4.5',
        availability: 'available',
        usageClass: 'high'
      }
    ];
    const fake = catalogue(enriched);
    const outcome = await pass(fake.store);
    expect(outcome).toEqual({ state: 'frozen', models: 1, reason: null });
    expect(fake.upserted).toEqual([]);
    expect(fake.replaced).toEqual([]);
  });

  it('replaces the whole catalogue from the key the owner saved, and hands the refresh what the catalogue said before it', async () => {
    const fake = catalogue([{ id: 'openrouter/withdrawn-last-quarter' }], 'sk-owner');
    let sawKey = '';
    let sawPrevious = -1;
    const outcome = await pass(fake.store, {
      masterKey,
      refreshCatalog: async (_allowlist, options) => {
        sawKey = options.apiKey;
        sawPrevious = options.previous.length;
        return [{ id: 'openrouter/live-today' }, { id: 'openrouter/released-yesterday' }];
      }
    });
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
    expect(sawKey).toBe('sk-owner');
    expect(sawPrevious).toBe(0);
    expect(fake.replaced).toEqual([
      [{ id: 'openrouter/live-today' }, { id: 'openrouter/released-yesterday' }]
    ]);
    expect(fake.upserted).toEqual([]);
  });

  it('reports what went wrong instead of throwing, because a pass that throws is a loop that stops', async () => {
    const fake = catalogue([{ id: 'openrouter/one' }], 'sk-owner');
    const outcome = await pass(fake.store, {
      masterKey,
      refreshCatalog: async () => {
        throw new Error('OpenRouter models returned 503');
      }
    });
    expect(outcome).toEqual({
      state: 'failed',
      models: 1,
      reason: 'OpenRouter models returned 503'
    });
    expect(fake.replaced).toEqual([]);
    expect(fake.upserted).toEqual([]);
  });

  it('counts the catalogue that survives a provider answering with nothing, since an empty answer prunes nothing', async () => {
    const fake = catalogue([{ id: 'openrouter/one' }, { id: 'openrouter/two' }], 'sk-owner');
    const outcome = await pass(fake.store, { masterKey });
    expect(outcome).toEqual({ state: 'refreshed', models: 2, reason: null });
  });
});
