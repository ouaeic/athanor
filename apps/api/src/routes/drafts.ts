/**
 * The half-typed message, saved where every one of the owner's devices can pick it up.
 */

import { SaveDraftRequest } from '@athanor/contracts';
import { AthanorError, encryptJson, unwrapDataKey } from '@athanor/core';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerDraftRoutes = (context: RouteContext): void => {
  const { app, store, masterKey } = context;
  /**
   * The owner's choices, saved where every one of their devices can read them.
   *
   * Merged rather than replaced, so a phone saving one key does not wipe what a laptop saved a
   * second earlier. Returned in full so the caller ends up holding what the server now holds
   * rather than what it hoped it had written.
   */
  /**
   * The half-typed message, kept where the owner's other device can find it.
   *
   * Sealed with the workspace key like the conversation it belongs to - a draft is the owner's
   * words, and the box holds no plaintext of those anywhere else either. An empty body deletes the
   * row rather than storing emptiness for every conversation ever opened.
   */
  app.put('/v1/drafts', async (request) => {
    const user = requireUser(request.user);
    const input = SaveDraftRequest.parse(request.body);
    const workspace = await store.getWorkspace(user.id, input.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    const body = input.body.trim();
    // Files already uploaded count as a draft even with nothing typed yet: dropping the row on an
    // empty body would have thrown away the attachments the owner had just spent a minute
    // uploading, which is the state a message that is mostly files sits in.
    const attachments = (input.attachments ?? []).filter((item) => item.path);
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: input.taskId ?? null,
      bodyCiphertext:
        body || attachments.length
          ? encryptJson(
              { body: input.body, attachments },
              unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id),
              `draft:${workspace.id}`
            )
          : null
    });
    return { saved: true };
  });
};
