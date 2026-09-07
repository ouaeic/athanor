import { OwnerPreferences, type ModelRelease } from '@athanor/contracts';
import { AthanorError, encryptJson, selectPurposeModel } from '@athanor/core';
import {
  readProjectModelPreferences,
  resolvePurposeChoice,
  type DataStore,
  type TaskRecord
} from '@athanor/data';
import type { AgentState, InferenceCredential } from './agent-state.js';

type PurposeContext = {
  store: DataStore;
  masterKey: Buffer;
  inferenceCredential(task: TaskRecord): Promise<Pick<InferenceCredential, 'provider'>>;
};

async function connectedProvider(context: PurposeContext, task: TaskRecord) {
  const credential = await context.inferenceCredential(task);
  return credential.provider === 'openrouter' ? 'openrouter' : 'custom';
}

async function preferences(
  context: PurposeContext,
  task: TaskRecord,
  existing?: Awaited<ReturnType<typeof readProjectModelPreferences>>
) {
  const [project, user, limits] = await Promise.all([
    existing ?? readProjectModelPreferences(context.store, context.masterKey, task),
    context.store.getUserById(task.userId),
    context.store.effectiveSpendLimits(task.userId)
  ]);
  if (!user) throw new AthanorError('owner_not_found', 'Project owner is unavailable');
  const owner = OwnerPreferences.parse(user.preferences);
  return {
    project,
    global: { ...owner.modelPurposes, ...(owner.model ? { main: owner.model } : {}) },
    limits: {
      maxInputUsdPerMillionTokens: limits.maxInputUsdPerMillionTokens ?? null,
      maxOutputUsdPerMillionTokens: limits.maxOutputUsdPerMillionTokens ?? null
    }
  };
}

export async function resolveTaskPurposeModel(
  context: PurposeContext,
  task: TaskRecord,
  purpose: 'specialist' | 'coding',
  catalog: readonly ModelRelease[]
): Promise<ModelRelease> {
  const { project, global, limits } = await preferences(context, task);
  const { choice } = resolvePurposeChoice(purpose, project.choices, global);
  const provider = await connectedProvider(context, task);
  const result = selectPurposeModel({
    purpose,
    choice,
    catalog,
    privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
    provider,
    ceiling: limits
  });
  if (!result.model) throw new AthanorError('purpose_model_unavailable', result.reason!, 409);
  return result.model;
}

export async function applyProjectMainModel(
  context: PurposeContext,
  task: TaskRecord,
  state: AgentState,
  catalog: readonly ModelRelease[],
  key: Uint8Array,
  workerId: string
): Promise<void> {
  if (task.parentMissionId) return;
  const project = await readProjectModelPreferences(context.store, context.masterKey, task);
  const main = project.choices.main;
  if (!main && state.mainModelPreference === undefined) return;
  const fingerprint = JSON.stringify(main ? [main.automatic, main.preference, main.modelId] : null);
  if (state.mainModelPreference === fingerprint) return;
  const { global, limits } = await preferences(context, task, project);
  const { choice } = resolvePurposeChoice('main', project.choices, global);
  const provider = await connectedProvider(context, task);
  const result = selectPurposeModel({
    purpose: 'main',
    choice,
    catalog,
    privacyRoute: task.privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external',
    provider,
    ceiling: limits
  });
  if (!result.model) throw new AthanorError('purpose_model_unavailable', result.reason!, 409);
  const effort = result.model.id === task.modelId ? (task.reasoningEffort ?? 'auto') : 'auto';
  const nextState = { ...state, mainModelPreference: fingerprint, ownerReasoningEffort: effort };
  await context.store.applyProjectMainModel({
    userId: task.userId,
    taskId: task.id,
    workerId,
    previousModelId: task.modelId,
    modelId: result.model.id,
    reasoningEffort: effort,
    stateCiphertext: encryptJson(nextState, key, `task-state:${task.id}`)
  });
  task.modelId = result.model.id;
  task.reasoningEffort = effort;
  Object.assign(state, nextState);
}
