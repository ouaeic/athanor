import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptJson, inferenceCredentialAad, type EncryptedEnvelope } from '@athanor/core';
import { catalogCredential, type CredentialSource } from './catalog-credential.js';

const masterKey = randomBytes(32);
const OWNER = 'ffffffff-1111-4111-8111-ffffffffffff';

const source = (rows: Record<string, { provider: string; status: string; secret: unknown }>) =>
  ({
    soleUser: async () => ({ id: OWNER }),
    getManagedProviderCredential: async (userId: string, provider: string) => {
      const row = rows[provider];
      if (!row || userId !== OWNER) return null;
      return {
        provider: row.provider,
        status: row.status,
        secretCiphertext: row.secret as EncryptedEnvelope
      };
    }
  }) satisfies CredentialSource;

const inferenceRow = (secret: Record<string, unknown>, status = 'active') => ({
  provider: 'inference',
  status,
  secret: encryptJson(secret, masterKey, inferenceCredentialAad(OWNER))
});

describe('catalogCredential', () => {
  it('uses the owner saved provider key, which is the only key a shipped box has', async () => {
    const credential = await catalogCredential({
      store: source({
        inference: inferenceRow({
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-owner'
        })
      }),
      masterKey
    });
    expect(credential).toEqual({
      apiKey: 'sk-owner',
      baseUrl: 'https://openrouter.ai/api/v1',
      source: 'owner'
    });
  });

  it('lets an operator key win, so a deliberately separate account is not overridden', async () => {
    const credential = await catalogCredential({
      store: source({ inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }) }),
      masterKey,
      environmentKey: 'sk-operator'
    });
    expect(credential).toEqual({ apiKey: 'sk-operator', source: 'environment' });
  });

  it('reads the legacy openrouter row, which carries no provider and no context', async () => {
    const credential = await catalogCredential({
      store: source({
        openrouter: {
          provider: 'openrouter',
          status: 'active',
          secret: encryptJson({ apiKey: 'sk-legacy' }, masterKey)
        }
      }),
      masterKey
    });
    expect(credential).toEqual({ apiKey: 'sk-legacy', source: 'owner' });
  });

  it('refuses to send an owner on another provider to OpenRouter', async () => {
    for (const provider of ['ollama-cloud', 'openai-compatible']) {
      const credential = await catalogCredential({
        store: source({
          inference: inferenceRow({
            provider,
            apiKey: 'sk-elsewhere',
            baseUrl: 'https://x.test/v1'
          })
        }),
        masterKey
      });
      expect(credential).toBeNull();
    }
  });

  it('answers null rather than throwing on the ordinary reasons there is no key', async () => {
    const saved = source({
      inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' })
    });
    expect(await catalogCredential({ store: saved, masterKey: null })).toBeNull();
    expect(
      await catalogCredential({
        store: { ...saved, soleUser: async () => null },
        masterKey
      })
    ).toBeNull();
    expect(await catalogCredential({ store: source({}), masterKey })).toBeNull();
    expect(
      await catalogCredential({
        store: source({
          inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }, 'revoked')
        }),
        masterKey
      })
    ).toBeNull();
    expect(
      await catalogCredential({
        store: source({ inference: inferenceRow({ provider: 'openrouter' }) }),
        masterKey
      })
    ).toBeNull();
  });

  it('throws on a credential it cannot open, which is a key that stopped matching', async () => {
    await expect(
      catalogCredential({
        store: source({ inference: inferenceRow({ provider: 'openrouter', apiKey: 'sk-owner' }) }),
        masterKey: randomBytes(32)
      })
    ).rejects.toThrow();
  });

  it('refuses a credential sealed for a different account', async () => {
    const stolen = encryptJson(
      { provider: 'openrouter', apiKey: 'sk-somebody-else' },
      masterKey,
      inferenceCredentialAad('00000000-0000-4000-8000-000000000000')
    );
    await expect(
      catalogCredential({
        store: source({ inference: { provider: 'inference', status: 'active', secret: stolen } }),
        masterKey
      })
    ).rejects.toThrow(/context mismatch/i);
  });
});
