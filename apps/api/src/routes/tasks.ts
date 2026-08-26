/**
 * Conversations: starting one, sending to it, reading it back, and the plan it is working to.
 *
 * The two writes that cost money - creating a conversation and sending it a message - resolve a
 * ceiling and assert it before a single token is bought, and they do it against the same helpers
 * the scheduler uses, so a run costs the same whoever started it.
 */

import { randomUUID } from 'node:crypto';
import {
  ContinueTaskRequest,
  CreateTaskRequest,
  TaskPageQuery,
  UpdateSecurityModeRequest,
  UpdateTaskPlanRequest,
  UpdateTaskRequest
} from '@athanor/contracts';
import type { TaskPage, TaskPlanStep } from '@athanor/contracts';
import {
  AthanorError,
  decryptJson,
  encryptJson,
  inferModelTask,
  modelFit,
  priceCeilingFields,
  unwrapDataKey
} from '@athanor/core';
import type { OwnerPriceCeiling, RoutableModel } from '@athanor/core';
import { startTurnState } from '@athanor/worker';
import { ownerPriceCeiling, resumableTaskStatuses, taskResponse } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { recordSecurityEvent } from '../security-events.js';

export const registerTaskRoutes = (context: RouteContext): void => {
  const {
    log,
    app,
    store,
    masterKey,
    privateTaskResponse,
    privateTaskPlanResponse,
    nameIndexFor,
    openPrompt,
    computeAllowanceFor,
    resolveSpendCeiling,
    assertSpendCeilingAllowed,
    pickModelUnderPriceCeiling,
    modelsForUser,
    config,
    idempotent
  } = context;
  /**
   * The sidebar, a page at a time. `cursor` is the opaque position returned with the previous
   * page - and with the bootstrap, so reaching page two never costs a re-read of page one.
   */
  app.get<{
    Querystring: { workspaceId?: string; cursor?: string; limit?: string; include?: string };
  }>('/v1/tasks', async (request): Promise<TaskPage> => {
    const user = requireUser(request.user);
    const query = TaskPageQuery.parse(request.query);
    const page = await store.listTaskPage(user.id, {
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      include: query.include
    });
    /**
     * The owner's workspaces, read once for the whole page.
     *
     * Called without this, `privateTaskResponse` runs `getWorkspaceById` and `unwrapDataKey` per
     * row - and a page defaults to 200 rows and is allowed 500, so drawing the sidebar issued 201
     * queries instead of 2. `/v1/bootstrap` has always done it this way against the same helper;
     * this route and `/v1/schedules` were the two that did not.
     */
    const workspaces = await store.listWorkspaces(user.id);
    return {
      tasks: await Promise.all(
        page.tasks.map((task) =>
          privateTaskResponse(
            task,
            workspaces.find((workspace) => workspace.id === task.workspaceId)
          )
        )
      ),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      // The page deliberately carries only the newest few runs of any one schedule, so the number
      // of runs on it is not the number of runs there are. Without this the folded line in the
      // sidebar could only count what it was holding, and a watcher that had fired four hundred
      // times said five.
      scheduleRunCounts: page.scheduleRunCounts
    };
  });

  /** Extensions the router treats as pictures, which is the one attachment kind that changes it. */
  const IMAGE_ATTACHMENT = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i;

  /**
   * Says once, at the top of a conversation, that the model about to answer is behind for the work
   * being asked of it.
   *
   * The web client picks a model before a word is typed - it ranks the catalogue on sign-in for
   * generic work in a 16K window and pins the winner - so by the time the request exists the route
   * has already been decided against something that is not this request. Every automatic pick then
   * arrives here as an explicit `modelId`, which `rankModels` honours without comparison. This is
   * the one place the two facts are in the same scope, and it costs a ranking over a catalogue
   * already in memory: no model call, no tokens, no round trip.
   *
   * At the top of the conversation and nowhere else. The same line on every follow-up would be the
   * narration this interface exists to be losing, and a model the owner kept after reading it once
   * is a decision, not an oversight.
   */
  const noteModelFit = async (input: {
    taskId: string;
    dataKey: Uint8Array;
    catalog: RoutableModel[];
    chosen: RoutableModel;
    privacyRoute: 'provider_zdr' | 'external';
    prompt: string;
    attachments: string[];
    /**
     * The owner's ceiling, so the comparison is against routes they would actually let this box
     * take. Without it the line reads "the router would have reached for X" naming a route the
     * ceiling forbids - advice that cannot be followed, about money, from the one component that
     * knows the limit.
     */
    ceilingUsd: OwnerPriceCeiling;
  }): Promise<void> => {
    const fit = modelFit({
      models: input.catalog,
      chosen: input.chosen,
      request: {
        privacyRoute: input.privacyRoute,
        requiredCapabilities: ['chat', 'tools'],
        requiredModalities: ['text'],
        minContextTokens: 16_000,
        preference: 'balanced',
        ...priceCeilingFields(input.ceilingUsd)
      },
      signals: {
        prompt: input.prompt,
        hasImages: input.attachments.some((path) => IMAGE_ATTACHMENT.test(path))
      }
    });
    if (!fit.headline) return;
    await store.appendTaskEvent({
      taskId: input.taskId,
      kind: 'notice',
      summary: fit.headline.slice(0, 500),
      payloadCiphertext: encryptJson(
        { headline: fit.headline, detail: fit.detail },
        input.dataKey,
        `task-event:${input.taskId}`
      )
    });
  };

  app.post('/v1/tasks', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskRequest.parse(request.body);
      const workspace = await store.getWorkspace(user.id, input.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      const catalog = await modelsForUser(user);
      const chosen = input.modelId
        ? null
        : await pickModelUnderPriceCeiling(user.id, catalog, {
            privacyRoute: input.privacyRoute,
            taskKind: inferModelTask(input.prompt)
          });
      const selected = input.modelId
        ? catalog.find((model) => model.id === input.modelId)
        : chosen?.model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new AthanorError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
      }
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title =
        input.title ?? input.prompt.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 160);
      const task = await store.createTask({
        userId: user.id,
        workspaceId: workspace.id,
        titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
        nameIndex: nameIndexFor(title, input.prompt, dataKey),
        modelId: selected.id,
        privacyRoute: input.privacyRoute,
        maxComputeCredits: Math.max(
          input.maxComputeCredits,
          computeAllowanceFor(selected, config.TASK_MAX_STEPS)
        ),
        maxSpendUsd: spendCeilingUsd,
        securityMode: workspace.securityMode,
        promptCiphertext: encryptJson(
          { prompt: input.prompt },
          dataKey,
          `task-prompt:${workspace.id}`
        )
      });
      await store.recordUsage({
        userId: user.id,
        workspaceId: workspace.id,
        taskId: task.id,
        kind: 'task_compute',
        resourceClass: selected.usageClass,
        quantity: input.maxComputeCredits,
        unit: 'credits',
        credits: input.maxComputeCredits,
        state: 'reserved',
        idempotencyKey: `task:${task.id}:reservation`
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'task_created',
        summary: 'Task queued',
        payloadCiphertext: encryptJson(
          {
            model: selected.displayName,
            privacyRoute: selected.privacyRoute,
            budget: input.maxComputeCredits
          },
          dataKey,
          `task-event:${task.id}`
        )
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'user_message',
        summary: 'User message',
        payloadCiphertext: encryptJson({ markdown: input.prompt }, dataKey, `task-event:${task.id}`)
      });
      /*
       * After the request it is about, so the owner reads what they asked for and then what will be
       * answering it. Started rather than awaited into the response: the task exists and is queued
       * by this point, and neither a ranking over the whole catalogue nor the insert that records
       * it is worth holding a send the owner is watching.
       *
       * The comment here said "caught rather than awaited" while the call was awaited, which is how
       * a synchronous pass over a few hundred models and a round trip to the database stayed in
       * front of every first message on the box without anybody meaning them to be. The `.catch` is
       * attached on this line and not later, so nothing about this can become an unhandled
       * rejection, and the notice still lands ahead of the worker's first frame - it is one insert
       * against a task that has yet to be leased, let alone answered.
       */
      void noteModelFit({
        taskId: task.id,
        dataKey,
        catalog,
        chosen: selected,
        privacyRoute: input.privacyRoute,
        prompt: input.prompt,
        attachments: input.attachments ?? [],
        ceilingUsd: ownerPriceCeiling(await store.effectiveSpendLimits(user.id))
      }).catch((error: unknown) => log.warn('models.fit_note_failed', errorFields(error)));
      /*
       * What the ceiling did to this pick, when it did something worth saying.
       *
       * `selectModel`'s `relaxed_unbenchmarked` arm is the case: every measured model that could do
       * the work is above the ceiling, so an unmeasured one is answering. That is a fact about the
       * quality of this reply and the owner is the only person who can act on it - by raising the
       * ceiling or accepting the route - and until now it was computed and dropped on the floor. The
       * `blocked` arm never reaches here; it refused the request above.
       */
      if (chosen?.message)
        await store.appendTaskEvent({
          taskId: task.id,
          kind: 'notice',
          summary: chosen.message.slice(0, 500),
          payloadCiphertext: encryptJson(
            { headline: chosen.message, detail: '' },
            dataKey,
            `task-event:${task.id}`
          )
        });
      return taskResponse(task, title);
    });
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/messages', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = ContinueTaskRequest.parse(request.body);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (task.userId !== user.id)
        throw new AthanorError(
          'task_owner_required',
          'Start a new task to continue work created by another team member',
          403
        );
      const activeTask = ['queued', 'planning', 'running', 'awaiting_user', 'paused'].includes(
        task.status
      );
      /**
       * A stopped conversation continues like a finished one.
       *
       * Stop tells the owner "the work so far is kept - send a message to continue from here", and
       * that sentence has to be true: cancelling releases the reservations and ends the run, but
       * the agent state it wrote is intact, so the next message resumes the same conversation
       * rather than silently opening a new one and abandoning what they were reading.
       */
      if (
        !activeTask &&
        !['completed', 'failed', 'awaiting_resource', 'cancelled'].includes(task.status)
      )
        throw new AthanorError(
          'task_not_continuable',
          'This task cannot accept another message; branch it or start a new task',
          409
        );
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
      const privacyRoute = input.privacyRoute ?? task.privacyRoute;
      /**
       * A follow-up brings its own ceiling: the store anchors it to what the task has already
       * spent, so `additionalSpendUsd` is headroom for this turn rather than a new total. The task
       * itself is excluded from the open commitments it is checked against, for the same reason.
       */
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({
        userId: user.id,
        ceilingUsd: spendCeilingUsd,
        taskId: task.id
      });
      const catalog = await modelsForUser(user);
      const selected = catalog.find((model) => model.id === (input.modelId ?? task.modelId));
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== privacyRoute
      )
        throw new AthanorError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      if (activeTask) {
        const messageId = randomUUID();
        const queued = await store.enqueueTaskMessage({
          id: messageId,
          taskId: task.id,
          userId: user.id,
          modelId: selected.id,
          privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          resourceClass: selected.usageClass,
          reservationKey: `task:${task.id}:message:${messageId}:reservation`,
          ...(input.interrupt ? { interrupt: true } : {}),
          promptCiphertext: encryptJson(
            { prompt: input.prompt },
            dataKey,
            `task-message:${task.id}`
          ),
          queuedEventCiphertext: encryptJson(
            { markdown: input.prompt, position: task.queuedMessageCount + 1 },
            dataKey,
            `task-event:${task.id}`
          )
        });
        if (!queued)
          throw new AthanorError(
            'task_message_queue_conflict',
            'The task changed while this message was being queued; send it again',
            409
          );
        /*
         * A reply to a conversation parked on a question is the thing it is parked for.
         *
         * Nothing re-leases `awaiting_user` - the lease query only ever hands out queued, planning
         * and running - and until the agent had a way to ask, the only thing that ever put a task
         * into that state was an approval, which the approval card takes it back out of. A question
         * is answered by writing, so without this the answer would sit in the message queue for
         * ever and the conversation could never be reached again from any door.
         *
         * A live approval is deliberately excluded. That card is the way to answer it and the
         * worker resumes into the pending call expecting a decision; requeueing on a message would
         * spend a lease discovering the approval is still pending and park again. Ordinary
         * follow-ups to a working task are untouched: only a task that has actually stopped for the
         * owner is moved, and the message it just queued is what the resumed turn reads.
         */
        const unparked =
          task.status === 'awaiting_user' &&
          !(await store.listApprovals(user.id, 'pending')).some(
            (approval) => String(approval.taskId) === task.id
          ) &&
          (await store.setTaskStatusForUser(user.id, task.id, 'queued'));
        // Re-read only when it moved. `enqueueTaskMessage` returns the row as it was before the
        // status changed, and that row is what the client decides from - answering a question and
        // being told the conversation is still waiting for you is the wrong sentence to end on.
        return privateTaskResponse(
          unparked ? ((await store.getTask(user.id, task.id)) ?? queued) : queued,
          workspace
        );
      }
      if (!task.agentStateCiphertext || task.agentStateCiphertext.aad !== `task-state:${task.id}`)
        throw new AthanorError(
          'task_context_unavailable',
          'This task stopped before a resumable conversation checkpoint was saved',
          409
        );
      const previousState = decryptJson<
        Record<string, unknown> & {
          messages: Array<Record<string, unknown>>;
          step: number;
          credits: number;
          turn?: number;
        }
      >(task.agentStateCiphertext, dataKey);
      if (!Array.isArray(previousState.messages))
        throw new AthanorError('task_context_invalid', 'Task conversation state is invalid');
      const nextTurn = Math.max(0, Number(previousState.turn ?? 0)) + 1;
      const reservationKey = `task:${task.id}:turn:${nextTurn}:reservation`;
      // The same reset the worker's own door performs, from the same function. These two had
      // drifted: this one cleared four fields where that one clears eleven and deletes three, and
      // this is the door an ordinary reply comes through - so the common case was the broken one.
      const nextState = startTurnState(previousState as unknown as Record<string, unknown>, {
        prompt: input.prompt,
        turn: nextTurn,
        reservationKey
      });
      const updated = await store.continueTask({
        id: task.id,
        userId: user.id,
        modelId: selected.id,
        privacyRoute,
        additionalComputeCredits: input.maxComputeCredits,
        additionalSpendUsd: spendCeilingUsd,
        agentStateCiphertext: encryptJson(nextState, dataKey, `task-state:${task.id}`),
        reservationKey,
        resourceClass: selected.usageClass,
        userMessageCiphertext: encryptJson(
          { markdown: input.prompt },
          dataKey,
          `task-event:${task.id}`
        )
      });
      if (!updated)
        throw new AthanorError(
          'task_continue_conflict',
          'This task changed before the follow-up could be queued',
          409
        );
      return privateTaskResponse(updated, workspace);
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => {
    const task = await store.getTask(requireUser(request.user).id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    return privateTaskResponse(task);
  });

  app.patch<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateTaskRequest.parse(request.body ?? {});
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      let current = task;
      if (input.pinned !== undefined || input.archived !== undefined) {
        const filed = await store.updateTaskFiling(user.id, task.id, {
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          ...(input.archived === undefined ? {} : { archived: input.archived })
        });
        if (!filed) throw new AthanorError('task_not_found', 'Task not found');
        current = filed;
      }
      if (input.title === undefined) return privateTaskResponse(current, workspace);
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const renamed = await store.renameTask(
        user.id,
        task.id,
        encryptJson({ title: input.title }, key, `task-title:${workspace.id}`),
        // The request has not changed, but the vector holds both surfaces and a tsvector cannot be
        // half-rewritten, so the opening is re-tokenized from the task's own ciphertext.
        nameIndexFor(input.title, openPrompt(task, key), key)
      );
      if (!renamed) throw new AthanorError('task_not_found', 'Task not found');
      return taskResponse(renamed, input.title);
    });
  });

  app.delete<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (['queued', 'planning', 'running'].includes(task.status))
        throw new AthanorError('task_active', 'Stop this task before deleting it', 409);
      return { deleted: await store.deleteTask(user.id, task.id) };
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const plan = await store.getLatestTaskPlan(task.id);
    return plan ? privateTaskPlanResponse(plan, workspace) : null;
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plans', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    return Promise.all(
      (await store.listTaskPlans(task.id)).map((plan) => privateTaskPlanResponse(plan, workspace))
    );
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    if (['completed', 'failed', 'cancelled'].includes(task.status))
      throw new AthanorError(
        'invalid_task_state',
        'A finished task plan is immutable; branch by starting a new task',
        409
      );
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const input = UpdateTaskPlanRequest.parse(request.body);
    const steps: TaskPlanStep[] = input.steps.map((step) => ({
      id: step.id ?? randomUUID(),
      title: step.title,
      status: step.status ?? 'pending'
    }));
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    let created;
    try {
      created = await store.createTaskPlan({
        taskId: task.id,
        expectedVersion: input.expectedVersion,
        ...(input.parentVersion ? { parentVersion: input.parentVersion } : {}),
        branchName: input.branchName,
        stepsCiphertext: encryptJson(
          { steps, branchName: input.branchName },
          key,
          `task-plan:${task.id}`
        ),
        createdBy: 'user'
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'plan_version_conflict')
        throw new AthanorError(
          'plan_version_conflict',
          'The plan changed on another device; reload before saving',
          409
        );
      throw cause;
    }
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'plan',
      summary: 'Encrypted user plan event',
      payloadCiphertext: encryptJson(
        {
          __athanorEventVersion: 1,
          summary: `Plan updated to version ${created.version}`,
          payload: {
            planId: created.id,
            version: created.version,
            branchName: input.branchName,
            steps
          }
        },
        key,
        `task-event:${task.id}`
      )
    });
    return privateTaskPlanResponse(created, workspace);
  });

  app.post<{ Params: { taskId: string; action: string } }>(
    '/v1/tasks/:taskId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = request.params.action;
        if (!['pause', 'resume', 'cancel'].includes(action))
          throw new AthanorError('invalid_action', 'Unsupported task action');
        const task = await store.getTask(user.id, request.params.taskId);
        if (!task) throw new AthanorError('task_not_found', 'Task not found');
        if (['completed', 'failed', 'cancelled'].includes(task.status))
          throw new AthanorError('invalid_task_state', 'A finished task cannot be changed', 409);
        if (
          action === 'resume' &&
          !(resumableTaskStatuses as readonly string[]).includes(task.status)
        )
          throw new AthanorError(
            'invalid_task_state',
            'Only paused or resource-waiting tasks can be resumed',
            409
          );
        const status = action === 'pause' ? 'paused' : 'queued';
        if (action === 'cancel') await store.cancelTaskAndReleaseReservations(user.id, task.id);
        else await store.setTaskStatusForUser(user.id, task.id, status);
        log.info('task.action', { taskId: task.id, userId: user.id, kind: action, status });
        return privateTaskResponse((await store.getTask(user.id, task.id))!);
      });
    }
  );

  app.patch<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/security-mode',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateSecurityModeRequest.parse(request.body);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (task.userId !== user.id)
        throw new AthanorError(
          'task_owner_required',
          'Only the task owner can change its security mode',
          403
        );
      /*
       * No second factor for choosing how much this run asks.
       *
       * Loosening used to demand a passkey inside the last five minutes, so in practice moving a
       * conversation to Autonomous meant a fingerprint every single time - on the setting whose
       * entire purpose is to be interrupted less. The session is already bound to a passkey; asking
       * again buys almost nothing here, because an attacker holding it can send tasks anyway, and
       * it costs the owner the one control they reach for most.
       *
       * Step-up stays where it protects something that cannot be undone by changing a setting
       * back: the provider credential, and raising a spending ceiling.
       */
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateTaskSecurityMode(user.id, task.id, input.securityMode);
        if (!updated) throw new AthanorError('task_not_found', 'Task not found');
        const workspace = await store.getWorkspace(user.id, task.workspaceId);
        if (workspace?.wrappedKey) {
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          await store.appendTaskEvent({
            taskId: task.id,
            kind: 'status',
            summary: 'Security mode changed',
            payloadCiphertext: encryptJson(
              { securityMode: input.securityMode },
              key,
              `task-event:${task.id}`
            )
          });
        }
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'task_security_mode_changed',
          outcome: 'succeeded',
          metadata: { taskId: task.id, securityMode: input.securityMode }
        });
        return privateTaskResponse(updated, workspace ?? undefined);
      });
    }
  );
};
