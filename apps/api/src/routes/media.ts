/**
 * What makes an image and what speaks, and what each will cost per unit the owner can picture.
 */

import { MediaModelSelection } from '@athanor/contracts';
import { registerProjectModelRoutes } from './project-models.js';
import { AthanorError, decryptJson, encryptJson, inferenceCredentialAad } from '@athanor/core';
import type { InferenceSecret } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerMediaRoutes = (context: RouteContext): void => {
  registerProjectModelRoutes(context);
  const { app, store, masterKey, mediaSettings, mediaRoutesFor, idempotent } = context;
  app.get('/v1/media/models', async (request) => mediaSettings(requireUser(request.user).id));

  /**
   * Changes which model makes an image and which one speaks. Deliberately not behind step-up.
   *
   * The approval floor asks for a passkey when a credential moves, and nothing here moves one: the
   * key is untouched, the endpoint is untouched, and choosing a model authorises no spend on its
   * own - every generation still meets the cumulative media card, and picking a route whose price
   * the provider does not publish makes that card appear more often rather than less. Putting a
   * fingerprint in front of a dropdown is the heavy-handedness the owner has already objected to
   * elsewhere, and it would buy nothing an attacker could not do by asking for a picture.
   */
  app.put('/v1/media/models', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = MediaModelSelection.parse(request.body);
      // Whatever key this account's credential lives under, and written back to that same key: a
      // media choice belongs in the row it was read from.
      const credential = await store.primaryInferenceCredential(user.id);
      if (credential?.status !== 'active')
        throw new AthanorError(
          'provider_setup_required',
          'Connect a model provider before choosing what it generates with',
          409
        );
      const secret = decryptJson<InferenceSecret>(
        credential.secretCiphertext,
        masterKey,
        inferenceCredentialAad(user.id)
      );
      const routes = await mediaRoutesFor(secret, input);
      await store.upsertManagedProviderCredential({
        userId: user.id,
        provider: credential.provider,
        secretCiphertext: encryptJson(
          { ...secret, mediaModels: input, ...(routes ? { mediaRoutes: routes } : {}) },
          masterKey,
          inferenceCredentialAad(user.id)
        ),
        externalRef: credential.externalRef ?? 'self-hosted',
        monthlyLimitUsd: 0,
        status: 'active'
      });
      return mediaSettings(user.id);
    });
  });
};
