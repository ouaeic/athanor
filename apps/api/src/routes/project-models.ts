import {
  ModelPurpose,
  OwnerPreferences,
  UpdateProjectModelPreferences,
  type ProjectModelPreferences,
  type ProjectModelChoices
} from '@athanor/contracts';
import { AthanorError, selectPurposeModel } from '@athanor/core';
import {
  readProjectModelPreferences,
  writeProjectModelPreferences,
  resolvePurposeChoice,
  mergeProjectModelChoices,
  type UserRecord
} from '@athanor/data';
import { ownerPriceCeiling } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const projectModelSettings = async (
  context: RouteContext,
  user: UserRecord,
  taskId: string
): Promise<ProjectModelPreferences> => {
  const task = await context.store.getTask(user.id, taskId);
  if (!task) throw new AthanorError('task_not_found', 'Task not found', 404);
  const preferences = await readProjectModelPreferences(context.store, context.masterKey, task);
  const owner = OwnerPreferences.parse(user.preferences);
  const { secret } = await context.inferenceCredential(user.id);
  const global: ProjectModelChoices = {
    ...secret.mediaModels,
    ...(owner.model ? { main: owner.model } : {}),
    ...('modelPurposes' in owner ? (owner.modelPurposes as ProjectModelChoices) : {})
  };
  const selection = mergeProjectModelChoices(global, preferences.choices);
  const [media, models, limits] = await Promise.all([
    context.mediaSettings(user.id, selection),
    context.modelsForUser(user),
    context.store.effectiveSpendLimits(user.id)
  ]);
  return {
    ...preferences,
    purposes: ModelPurpose.options.map((purpose) => {
      const resolved = resolvePurposeChoice(purpose, preferences.choices, global);
      const modality = media.modalities.find((item) => item.modality === purpose);
      if (modality)
        return {
          purpose,
          ...resolved,
          effective: modality.effective,
          options: modality.options,
          available: Boolean(modality.effective && !modality.effective.unavailableReason),
          reason:
            modality.effective?.unavailableReason ??
            (modality.effective ? null : (modality.reason ?? 'The selected model is unavailable.'))
        };
      if (purpose !== 'main' && purpose !== 'specialist' && purpose !== 'coding')
        return {
          purpose,
          ...resolved,
          effective: null,
          options: [],
          available: false,
          reason: 'The connected provider does not offer this purpose.'
        };
      const result = selectPurposeModel({
        purpose,
        choice: resolved.choice,
        catalog: models,
        privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
        ceiling: ownerPriceCeiling(limits)
      });
      return {
        purpose,
        ...resolved,
        effective: result.model,
        options: models,
        available: Boolean(result.model),
        reason: result.reason
      };
    })
  };
};

export const registerProjectModelRoutes = (context: RouteContext): void => {
  context.app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/model-preferences',
    (request) => projectModelSettings(context, requireUser(request.user), request.params.taskId)
  );
  context.app.put<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/model-preferences',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, async () => {
        const input = UpdateProjectModelPreferences.parse(request.body);
        const task = await context.store.getTask(user.id, request.params.taskId);
        if (!task) throw new AthanorError('task_not_found', 'Task not found', 404);
        await writeProjectModelPreferences(context.store, context.masterKey, task, input);
        return projectModelSettings(context, user, task.id);
      });
    }
  );
};
