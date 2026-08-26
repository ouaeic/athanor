/**
 * The questions the agent stopped to ask, and the answers that start it again.
 *
 * Pending is the default listing because that is the list with something to answer.
 */

import { AthanorError, decryptJson, unwrapDataKey } from '@athanor/core';
import { z } from 'zod';
import { textValue } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerApprovalRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, idempotent } = context;
  /**
   * Pending is the default because that is the list with something to answer, but an approval
   * that lapsed is exactly what a returning owner is looking for: it explains why a task is
   * paused, and the wording of what was asked is the only record of it.
   */
  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string } }>(
    '/v1/approvals',
    async (request) => {
      const user = requireUser(request.user);
      const query = z
        .object({
          status: z.enum(['pending', 'approved', 'denied', 'expired']).default('pending'),
          /*
           * The store has taken a page and a cursor since the read was bounded, and every row it
           * returns carries the `cursor` for the row after it - this route passed neither, so the
           * answer was always the first page and the cursor on every row pointed at a page nothing
           * could ask for. An owner going back through what they approved last month reached the
           * store's own ceiling and stopped there, with no way to say "keep going".
           */
          limit: z.coerce.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).max(200).optional()
        })
        .parse(request.query);
      const status = query.status;
      const approvals = await store.listApprovals(user.id, status, {
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor })
      });
      return Promise.all(
        approvals.map(async (approval) => {
          const task = await store.getTask(user.id, String(approval.taskId));
          const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
          if (!workspace?.wrappedKey)
            return { ...approval, preview: '[unavailable]', previewCiphertext: undefined };
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          const decryptedPreview = decryptJson<Record<string, unknown>>(
            approval.previewCiphertext as Parameters<typeof decryptJson>[0],
            key,
            `approval:${String(approval.taskId)}`
          );
          return {
            ...approval,
            action: textValue(decryptedPreview.action, textValue(approval.action)),
            preview: decryptedPreview,
            previewCiphertext: undefined
          };
        })
      );
    }
  );

  app.post<{ Params: { approvalId: string; decision: string } }>(
    '/v1/approvals/:approvalId/:decision',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const decision = z.enum(['approve', 'deny']).parse(request.params.decision);
        const approval = await store.getApproval(request.params.approvalId);
        if (!approval || approval.userId !== user.id)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        const changed = await store.resolveApproval(
          user.id,
          request.params.approvalId,
          decision === 'approve' ? 'approved' : 'denied'
        );
        if (!changed)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        await store.setTaskStatusForUser(user.id, String(approval.taskId), 'queued');
        return { ok: true };
      });
    }
  );
};
