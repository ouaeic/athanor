/**
 * Where a notice goes, and which kinds are allowed to make the trip.
 *
 * A push endpoint is a URL this box will POST to unattended, so it is checked against the
 * deployment's allowed relay hosts before it is stored - credential-free HTTPS, no odd port, and a
 * hostname on the list.
 */

import type { AgentNotification } from '@athanor/contracts';
import { AthanorError, sha256 } from '@athanor/core';
import { z } from 'zod';
import { UNREADABLE_AGENT_MESSAGE, clockToMinutes, minutesToClock } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { sessionCookieName } from '../session.js';

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256)
  })
});

const validatePushEndpoint = (endpoint: string, suffixes: string[]): string => {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new AthanorError(
      'invalid_push_endpoint',
      'Push endpoints must use credential-free HTTPS'
    );
  }
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => {
    const value = suffix.trim().toLowerCase();
    return value.startsWith('.') ? host.endsWith(value) : host === value;
  });
  if (!allowed)
    throw new AthanorError('invalid_push_endpoint', 'This browser push relay is not allowed');
  return url.toString();
};

export const registerNotificationRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, secure, pushEndpointSuffixes, config, idempotent } = context;
  app.get('/v1/notifications/config', async () => ({
    enabled: Boolean(config.PUSH_VAPID_PUBLIC_KEY),
    publicKey: config.PUSH_VAPID_PUBLIC_KEY ?? null
  }));

  app.post('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      if (!config.PUSH_VAPID_PUBLIC_KEY) {
        throw new AthanorError(
          'push_unavailable',
          'Push notifications are not configured for this deployment'
        );
      }
      const input = pushSubscriptionSchema.parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      const sessionToken = request.cookies[sessionCookieName(secure)];
      const sessionPublicId = sessionToken
        ? await store.getSessionPublicId(user.id, sha256(sessionToken))
        : null;
      if (!sessionPublicId)
        throw new AthanorError('authentication_required', 'Active device session is required');
      const subscription = await store.upsertPushSubscription({
        userId: user.id,
        sessionPublicId,
        endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth
      });
      reply.status(201);
      return { id: subscription.id, enabled: true };
    });
  });

  app.delete('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ endpoint: z.string().url().max(2048) }).parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      await store.deletePushSubscription(user.id, endpoint);
      return { enabled: false };
    });
  });

  /**
   * The owner's notification preferences.
   *
   * Quiet hours are stored as minutes past local midnight and travel as "HH:MM", because the owner
   * thinks in a clock and the notifier thinks in a comparison. The zone is echoed read-only from
   * the spending caps: there is one answer on this box to when the owner's day rolls over, and a
   * second copy of it would eventually disagree.
   */
  const notificationSettingsResponse = async (userId: string) => {
    const stored = (await store.notificationSettings(userId)) ?? {
      kinds: {
        approval_required: true,
        task_finished: true,
        spend_paused: true,
        agent_message: true,
        takeover_needed: true
      },
      quietHours: null,
      quietHoursAllowApprovals: true
    };
    const limits = await store.effectiveSpendLimits(userId);
    return {
      kinds: {
        approvalRequired: stored.kinds.approval_required,
        taskFinished: stored.kinds.task_finished,
        spendPaused: stored.kinds.spend_paused,
        agentMessage: stored.kinds.agent_message,
        takeoverNeeded: stored.kinds.takeover_needed
      },
      quietHoursStart: stored.quietHours ? minutesToClock(stored.quietHours.startMinute) : null,
      quietHoursEnd: stored.quietHours ? minutesToClock(stored.quietHours.endMinute) : null,
      quietHoursAllowApprovals: stored.quietHoursAllowApprovals,
      timeZone: limits.timeZone
    };
  };

  app.get('/v1/notifications/settings', async (request) =>
    notificationSettingsResponse(requireUser(request.user).id)
  );

  /**
   * Every kind that can reach a device has a switch here, the two the agent raises included. They
   * arrived without one, on the reasoning that the agent asking for the owner is not the box
   * reporting on itself - but that made the one notification the owner explicitly asked for also
   * the only one they could not turn down, short of unsubscribing the device entirely.
   */
  const UpdateNotificationSettingsRequest = z.object({
    kinds: z.object({
      approvalRequired: z.boolean(),
      taskFinished: z.boolean(),
      spendPaused: z.boolean(),
      agentMessage: z.boolean(),
      takeoverNeeded: z.boolean()
    }),
    quietHoursStart: z.string().nullable(),
    quietHoursEnd: z.string().nullable(),
    quietHoursAllowApprovals: z.boolean()
  });

  app.put('/v1/notifications/settings', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateNotificationSettingsRequest.parse(request.body);
      // Both ends or neither: half a window is not a window, and it would silently never be quiet.
      if (Boolean(input.quietHoursStart) !== Boolean(input.quietHoursEnd))
        throw new AthanorError(
          'invalid_quiet_hours',
          'Quiet hours need both a start and an end time'
        );
      const quietHours =
        input.quietHoursStart && input.quietHoursEnd
          ? {
              startMinute: clockToMinutes(input.quietHoursStart),
              endMinute: clockToMinutes(input.quietHoursEnd)
            }
          : null;
      if (quietHours && quietHours.startMinute === quietHours.endMinute)
        throw new AthanorError(
          'invalid_quiet_hours',
          'Quiet hours that start and end at the same minute would never be quiet'
        );
      await store.setNotificationSettings(user.id, {
        kinds: {
          approval_required: input.kinds.approvalRequired,
          task_finished: input.kinds.taskFinished,
          spend_paused: input.kinds.spendPaused,
          agent_message: input.kinds.agentMessage,
          takeover_needed: input.kinds.takeoverNeeded
        },
        quietHours,
        quietHoursAllowApprovals: input.quietHoursAllowApprovals
      });
      return notificationSettingsResponse(user.id);
    });
  });

  /**
   * Everything the agent has told this owner, across every conversation, newest first.
   *
   * A push is one moment on whichever devices happened to be subscribed. This is the standing
   * record of the same decisions, so a watcher's week can be read in one place by an owner whose
   * phone was off - and so a notice is still recoverable when the push was dropped for quiet hours
   * or because they were already at the keyboard.
   */
  app.get<{ Querystring: { limit?: string } }>('/v1/notifications/agent', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
    return (await store.listAgentNotifications(user.id, limit, masterKey)).map(
      (row): AgentNotification => ({
        id: row.id,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        kind: row.kind,
        /**
         * A notice the workspace key will not unwrap says so, in the field a client renders. It
         * used to be served as null, and a row with nothing to read is dropped rather than drawn -
         * so the one notice that reports a conversation has become unreadable was the one notice
         * that vanished silently. This is a rare row and a serious one: it means a key this box
         * holds no longer opens what it sealed.
         */
        message: row.message ?? UNREADABLE_AGENT_MESSAGE,
        createdAt: row.createdAt
      })
    );
  });
};
