import { decryptJson, inferenceCredentialAad, type EncryptedEnvelope } from '@athanor/core';

/**
 * What this service needs in order to ask the provider what it is offering today: a key, and the
 * endpoint that key belongs to.
 */
export interface CatalogCredential {
  /**
   * Absent is a real state and not a missing value: an endpoint on the owner's own network is
   * commonly saved with no key at all. Only the OpenRouter path requires one, because asking
   * OpenRouter anything without a key answers nothing.
   */
  apiKey?: string;
  baseUrl?: string;
  /**
   * Which provider this key belongs to, because it decides which list is asked and how the answer
   * is read. It used to be a filter that answered null for everything but OpenRouter, which is the
   * whole of why "openrouter etc." meant openrouter.
   */
  provider: string;
  /**
   * The one model the owner named, for a directly configured endpoint. A gateway fronting thirty
   * models is not thirty offers when the owner told the settings screen the facts of one of them -
   * see the save path, which writes exactly this row and no other.
   */
  modelId?: string;
  /** What the owner asked for on this account, carried so the refresh writes the same route. */
  enforceZeroDataRetention?: boolean;
  /** Where it came from, for the journal line that says why a refresh started working. */
  source: 'environment' | 'owner';
}

/** The two shapes the credential row has been written in, both still on disk somewhere. */
interface InferenceSecret {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  enforceZeroDataRetention?: boolean;
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
 * A box with no owner yet and a box with no saved provider both answer null: there is no live
 * catalogue to be had, which is an ordinary state. A credential that is present and cannot be
 * opened is not - that is a master key that no longer matches its database - so it is left to
 * throw and be said out loud once.
 *
 * A provider that is not OpenRouter used to answer null too, by design and with a comment stating
 * the consequence: an owner on Ollama Cloud or their own endpoint had a catalogue written once at
 * key-save and then frozen for the life of the box. Prices never moved, withdrawn models never
 * left the picker, new ones never appeared - and the two surfaces that mentioned it told that
 * owner to save a provider key, which is the thing they had already done. The endpoint's own
 * `/models` is the same request the save path already makes; answering with the provider instead
 * of with null is what lets the loop make it hourly. See `configured-catalog.ts`.
 */
export const catalogCredential = async (input: {
  store: CredentialSource;
  masterKey: Uint8Array | null;
  environmentKey?: string | undefined;
  /**
   * The endpoint an operator configured in control.env rather than in Settings - the third and last
   * shape a box can be pointed at a provider in, and the one nothing ever refreshed. `AI_PROVIDER`,
   * `AI_BASE_URL` and `AI_DEFAULT_MODEL` write exactly one `custom/…` row at API start-up and
   * nothing asks that endpoint anything again, so a window that grew, a price that moved and a
   * model that was withdrawn were all invisible for the life of the box.
   *
   * Ranked below the owner's saved credential and above nothing, because a key saved in Settings is
   * the later and more specific statement of where this computer's work should go.
   */
  environmentProvider?:
    | { provider: string; baseUrl?: string | undefined; modelId?: string | undefined }
    | undefined;
}): Promise<CatalogCredential | null> => {
  if (input.environmentKey)
    return { apiKey: input.environmentKey, provider: 'openrouter', source: 'environment' };
  const configured =
    input.environmentProvider && input.environmentProvider.provider !== 'openrouter'
      ? {
          provider: input.environmentProvider.provider,
          ...(input.environmentProvider.baseUrl
            ? { baseUrl: input.environmentProvider.baseUrl }
            : {}),
          ...(input.environmentProvider.modelId
            ? { modelId: input.environmentProvider.modelId }
            : {}),
          source: 'environment' as const
        }
      : null;
  if (!input.masterKey) return configured;
  const owner = await input.store.soleUser();
  if (!owner) return configured;
  const saved =
    (await input.store.getManagedProviderCredential(owner.id, 'inference')) ??
    (await input.store.getManagedProviderCredential(owner.id, 'openrouter'));
  if (!saved || saved.status !== 'active') return configured;
  // The legacy row predates both the provider field and the context binding, and holds nothing but
  // a key. It is only ever an OpenRouter key, which is why it needs no provider check.
  if (saved.provider === 'openrouter') {
    const legacy = decryptJson<{ apiKey?: string }>(saved.secretCiphertext, input.masterKey);
    return legacy.apiKey
      ? { apiKey: legacy.apiKey, provider: 'openrouter', source: 'owner' }
      : configured;
  }
  const secret = decryptJson<InferenceSecret>(
    saved.secretCiphertext,
    input.masterKey,
    inferenceCredentialAad(owner.id)
  );
  const provider = secret.provider ?? 'openrouter';
  // OpenRouter is the one provider that answers nothing without a key, so a row that names it and
  // holds none is not a credential. Every other endpoint here may legitimately be open - one on
  // the owner's own network, most obviously - and refusing to refresh those was the bug.
  if (provider === 'openrouter' && !secret.apiKey) return configured;
  return {
    provider,
    ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
    ...(secret.baseUrl ? { baseUrl: secret.baseUrl } : {}),
    ...(secret.modelId ? { modelId: secret.modelId } : {}),
    ...(secret.enforceZeroDataRetention === undefined
      ? {}
      : { enforceZeroDataRetention: secret.enforceZeroDataRetention }),
    source: 'owner'
  };
};
