/**
 * Watchers: work the owner asked for on a clock rather than at a keyboard.
 *
 * A schedule carries its own model choice and its own ceiling, and both are checked when it is
 * saved rather than only when it fires - a run that is refused at three in the morning is a run
 * nobody sees refused.
 */

import { CreateTaskScheduleRequest, UpdateTaskScheduleRequest } from '@athanor/contracts';
import {
  AthanorError,
  assertTimeZone,
  encryptJson,
  inferModelTask,
  unwrapDataKey
} from '@athanor/core';
import type { TaskScheduleRecord } from '@athanor/data';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { serverLimits } from '../plans.js';
import { advanceScheduleRun } from '../schedule-advance.js';

export const registerScheduleRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    scheduleTitle,
    schedulePrompt,
    privateScheduleResponse,
    computeAllowanceFor,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    pickModelUnderPriceCeiling,
    modelsForUser,
    config,
    idempotent
  } = context;
  app.get('/v1/schedules', async (request) => {
    const user = requireUser(request.user);
    // Read once, for the same reason `GET /v1/tasks` above reads it once: `listTaskSchedules` is
    // unbounded up to `serverLimits.maxSchedules`, which is a thousand.
    const [schedules, workspaces] = await Promise.all([
      store.listTaskSchedules(user.id),
      store.listWorkspaces(user.id)
    ]);
    return Promise.all(
      schedules.map((schedule) =>
        privateScheduleResponse(
          schedule,
          workspaces.find((workspace) => workspace.id === schedule.workspaceId)
        )
      )
    );
  });

  app.post('/v1/schedules', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskScheduleRequest.parse(request.body);
      if (input.spec.kind === 'daily' || input.spec.kind === 'weekly') {
        try {
          assertTimeZone(input.spec.timeZone);
        } catch {
          throw new AthanorError('invalid_time_zone', 'Choose a valid IANA time zone');
        }
      }
      // No occurrence has been served yet, so there is no repeat to guard against - but a first
      // run that falls inside a spring-forward gap is recovered here exactly as a later one is.
      const nextRunAt = advanceScheduleRun(input.spec, null);
      if (!nextRunAt)
        throw new AthanorError('schedule_in_past', 'The one-time schedule must be in the future');
      const workspace = await store.getWorkspace(user.id, input.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (['failed', 'deleting'].includes(workspace.status))
        throw new AthanorError('workspace_unavailable', 'Workspace is unavailable');
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      if ((await store.countTaskSchedules(user.id)) >= serverLimits.maxSchedules) {
        throw new AthanorError(
          'schedule_limit',
          `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
        );
      }
      const catalog = await modelsForUser(user);
      // A schedule is the unattended case the ceiling exists for: nobody is at the keyboard when it
      // fires, so the pick it makes months from now is held to the limit set today. That covers the
      // owner's standing pin as well, which `pickModelUnderPriceCeiling` drops in favour of the
      // ranking when it breaches the ceiling - and it drops it silently, because the picker's
      // advisory sentence has nowhere to go on this route: `TaskSchedule` carries no message field.
      // An explicit `modelId` on this request is the owner choosing for themselves and is not held
      // to the ceiling at all; it does not reach the picker.
      const selected = input.modelId
        ? catalog.find((model) => model.id === input.modelId)
        : (
            await pickModelUnderPriceCeiling(user.id, catalog, {
              privacyRoute: input.privacyRoute,
              taskKind: inferModelTask(input.prompt)
            })
          ).model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new AthanorError(
          'model_unavailable',
          'The selected cloud model is unavailable for this privacy route'
        );
      }
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title =
        input.title ?? input.prompt.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 160);
      let schedule: TaskScheduleRecord;
      try {
        schedule = await store.createTaskSchedule({
          userId: user.id,
          workspaceId: workspace.id,
          titleCiphertext: encryptJson({ title }, key, `task-title:${workspace.id}`),
          promptCiphertext: encryptJson(
            { prompt: input.prompt },
            key,
            `task-prompt:${workspace.id}`
          ),
          modelId: selected.id,
          privacyRoute: input.privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          spec: input.spec,
          nextRunAt,
          maxSchedules: serverLimits.maxSchedules
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'schedule_limit') {
          throw new AthanorError(
            'schedule_limit',
            `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
          );
        }
        throw error;
      }
      reply.status(201);
      return privateScheduleResponse(schedule, workspace);
    });
  });

  /**
   * Editing a watcher that already exists, which the README has promised for longer than this file
   * has been able to do it.
   *
   * There has been no route: an owner moving a daily run from nine to seven had to delete the
   * schedule and retype the whole instruction, which is how a standing instruction quietly gets
   * shorter. The agent has been able to do this from inside a conversation the entire time
   * (`agent.ts`'s `schedule` tool, `action: 'update'`), so this is the same capability reaching the
   * person the schedule belongs to.
   *
   * Two things it does that the agent's path does not:
   *
   * `maxSpendUsd` is carried forward explicitly. `updateTaskSchedule` writes `max_spend_usd` on
   * every call from `input.maxSpendUsd ?? null`, so a caller that leaves it out does not leave it
   * alone - it clears it. An edit to the timing that silently removes the money ceiling from an
   * unattended run is the exact shape of defect this pass is here to stop, and the agent's own
   * `update` arm still has it (handed off).
   *
   * `nextRunAt` is recomputed only when the timing changed, because `advanceScheduleRun(spec, null)`
   * from a schedule that has already run would move the next occurrence for an edit to the title.
   */
  app.patch<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = UpdateTaskScheduleRequest.parse(request.body ?? {});
        const schedule = await store.getTaskSchedule(user.id, request.params.scheduleId);
        if (!schedule) throw new AthanorError('schedule_not_found', 'Schedule not found');
        const workspace = await store.getWorkspace(user.id, schedule.workspaceId);
        if (!workspace?.wrappedKey)
          throw new AthanorError('workspace_not_found', 'Workspace not found');
        /*
         * Declared and refused rather than accepted and dropped. `updateTaskSchedule` does not write
         * `model_id` or `privacy_route`, and zod strips a key it does not declare - so a client
         * asking to move a watcher onto a different model would have been answered 200, with the
         * schedule unchanged and nothing anywhere saying so. Naming the same value it already has is
         * not a change and is allowed through, so a client that echoes the whole record back still
         * works.
         */
        if (
          (input.modelId !== undefined && input.modelId !== schedule.modelId) ||
          (input.privacyRoute !== undefined && input.privacyRoute !== schedule.privacyRoute)
        )
          throw new AthanorError(
            'schedule_model_immutable',
            'A schedule keeps the model and privacy route it was created with; create a new schedule to change them',
            409
          );
        if (
          input.title === undefined &&
          input.prompt === undefined &&
          input.spec === undefined &&
          input.maxComputeCredits === undefined &&
          input.maxSpendUsd === undefined
        )
          throw new AthanorError(
            'schedule_update_empty',
            'Provide a new title, instruction, timing, compute limit or spending ceiling'
          );
        if (input.spec && (input.spec.kind === 'daily' || input.spec.kind === 'weekly')) {
          try {
            assertTimeZone(input.spec.timeZone);
          } catch {
            throw new AthanorError('invalid_time_zone', 'Choose a valid IANA time zone');
          }
        }
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const spec = input.spec ?? schedule.spec;
        /*
         * A paused schedule keeps its `next_run_at` of null - resuming is what computes one, and it
         * already does. An enabled one-time schedule whose new time is in the past is refused rather
         * than silently disabled, the same refusal and the same code the agent's `update` gives.
         */
        const nextRunAt =
          input.spec === undefined
            ? schedule.nextRunAt === null
              ? null
              : new Date(schedule.nextRunAt)
            : schedule.enabled
              ? advanceScheduleRun(spec, null)
              : null;
        if (input.spec !== undefined && schedule.enabled && !nextRunAt)
          throw new AthanorError(
            'schedule_in_past',
            'An enabled one-time schedule must be in the future'
          );
        const title = input.title ?? (await scheduleTitle(schedule, workspace));
        const prompt = input.prompt ?? schedulePrompt(schedule, workspace);
        if (!prompt)
          throw new AthanorError(
            'encrypted_prompt_context',
            'This server cannot read the instruction on this schedule; send a new one with this edit'
          );
        const updated = await store.updateTaskSchedule(user.id, schedule.id, {
          titleCiphertext: encryptJson({ title }, key, `task-title:${workspace.id}`),
          promptCiphertext: encryptJson({ prompt }, key, `task-prompt:${workspace.id}`),
          spec,
          maxComputeCredits: input.maxComputeCredits ?? schedule.maxComputeCredits,
          maxSpendUsd: input.maxSpendUsd === undefined ? schedule.maxSpendUsd : input.maxSpendUsd,
          nextRunAt
        });
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return privateScheduleResponse(updated, workspace);
      });
    }
  );

  app.post<{ Params: { scheduleId: string; action: string } }>(
    '/v1/schedules/:scheduleId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = z.enum(['pause', 'resume', 'run']).parse(request.params.action);
        const schedule = await store.getTaskSchedule(user.id, request.params.scheduleId);
        if (!schedule) throw new AthanorError('schedule_not_found', 'Schedule not found');
        const nextRunAt =
          action === 'run'
            ? new Date()
            : action === 'resume'
              ? advanceScheduleRun(schedule.spec, null)
              : null;
        if (action === 'resume' && !nextRunAt) {
          throw new AthanorError(
            'schedule_finished',
            'This one-time schedule has already passed; create a new schedule instead',
            409
          );
        }
        const updated = await store.setTaskScheduleEnabled(
          user.id,
          schedule.id,
          action !== 'pause',
          nextRunAt
        );
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return privateScheduleResponse(updated);
      });
    }
  );

  app.delete<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => ({
        deleted: await store.deleteTaskSchedule(user.id, request.params.scheduleId)
      }));
    }
  );
};
