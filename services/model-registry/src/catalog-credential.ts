import { decryptJson, inferenceCredentialAad, type EncryptedEnvelope } from '@athanor/core';

/**
 * What this service needs in order to ask the provider what it is offering today: a key, and the
 * endpoint that key belongs to.
 */
export interface CatalogCredential {
  apiKey: string;
  baseUrl?: string;
  /** Where it came from, for the journal line that says why a refresh started working. */
  source: 'environment' | 'owner';
}

/** The two shapes the credential row has been written in, both still on disk somewhere. */
interface InferenceSecret {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface CredentialRow {
  provider: string;
  status: string;
  secretCiphertext: EncryptedEnvelope;
}

/**
 * The narrow slice of the store this needs, named so the resolution can be exercised without a
 * database.
 */
export interface CredentialSource {
  soleUser(): Promise<{ id: string } | null>;
  getManagedProviderCredential(userId: string, provider: string): Promise<CredentialRow | null>;
}

/**
 * The key this service refreshes the catalogue with.
 *
 * There has never been one. The refresh was gated on `OPENROUTER_REGISTRY_KEY`, an operator
 * variable no shipped install path writes, so on every real box this service started, slept for an
 * hour, did nothing, and slept again - which is why a model the provider withdrew stayed in the
 * picker until somebody tried to use it, and why a model released after the build never appeared at
 * all. The owner's own provider key was sitting in the database the whole time, sealed for exactly
 * this and already read this way by the API and the worker.
 *
 * The environment still wins when it is set: an operator who deliberately points the catalogue at a
 * separate account should not have that quietly overridden by whatever the owner saved in Settings.
 *
 * A box with no owner yet, no saved provider, or a provider that is not OpenRouter all answer null:
 * there is no live catalogue to be had, which is an ordinary state and not worth a word. A
 * credential that is present and cannot be opened is not - that is a master key that no longer
 * matches its database - so it is left to throw and be said out loud once.
 */
export const catalogCredential = async (input: {
  store: CredentialSource;
  masterKey: Uint8Array | null;
  environmentKey?: string | undefined;
}): Promise<CatalogCredential | null> => {
  if (input.environmentKey) return { apiKey: input.environmentKey, source: 'environment' };
  if (!input.masterKey) return null;
  const owner = await input.store.soleUser();
  if (!owner) return null;
  const saved =
    (await input.store.getManagedProviderCredential(owner.id, 'inference')) ??
    (await input.store.getManagedProviderCredential(owner.id, 'openrouter'));
  if (!saved || saved.status !== 'active') return null;
  // The legacy row predates both the provider field and the context binding, and holds nothing but
  // a key. It is only ever an OpenRouter key, which is why it needs no provider check.
  if (saved.provider === 'openrouter') {
    const legacy = decryptJson<{ apiKey?: string }>(saved.secretCiphertext, input.masterKey);
    return legacy.apiKey ? { apiKey: legacy.apiKey, source: 'owner' } : null;
  }
  const secret = decryptJson<InferenceSecret>(
    saved.secretCiphertext,
    input.masterKey,
    inferenceCredentialAad(owner.id)
  );
  // An owner on Ollama Cloud or their own endpoint has a catalogue of exactly one model, written by
  // the API when they saved it and under a provider this service never prunes. Sending their key to
  // OpenRouter to ask what OpenRouter is offering would be wrong twice over.
  if (secret.provider !== 'openrouter' || !secret.apiKey) return null;
  return {
    apiKey: secret.apiKey,
    ...(secret.baseUrl ? { baseUrl: secret.baseUrl } : {}),
    source: 'owner'
  };
};
