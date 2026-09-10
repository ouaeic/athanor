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
  purpose: 'specialist' | 'coding' | 'summarise' | 'title',
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

/**
 * The model an owner pinned for one auxiliary job, or nothing when they left it automatic.
 *
 * Auxiliary calls already route themselves - `compactionModel` takes the cheapest capable route on
 * the task's own provider - and that is the right answer when nobody has an opinion, so the absence
 * of a pin has to mean "carry on as before" rather than "resolve something". Hence a nullable
 * answer rather than the throwing resolver above: a pin that cannot be honoured on this task's
 * provider or privacy route must not take a long turn down over a summary, so it falls back to the
 * automatic pick with the owner none the wiser until they open the settings that say so.
 */
export async function pinnedPurposeModel(
  context: PurposeContext,
  task: TaskRecord,
  purpose: 'summarise' | 'title',
  catalog: readonly ModelRelease[]
): Promise<ModelRelease | null> {
  try {
    const { project, global } = await preferences(context, task);
    const { choice } = resolvePurposeChoice(purpose, project.choices, global);
    if (choice.automatic) return null;
    return await resolveTaskPurposeModel(context, task, purpose, catalog);
  } catch {
    return null;
  }
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

/**
 * What jobs on this computer are answered by a model other than the one reading this.
 *
 * The owner has been able to route each job to its own model for a while, and the lead was never
 * told: it chose between doing a piece of research itself and handing it to `delegate` without
 * knowing whether the specialist behind that call was a stronger reasoner or a cheaper one. The
 * decision is different in the two cases, and it is not a decision the model can work out by
 * trying - nothing in any tool result names the route that answered it.
 *
 * Only the routes that actually differ from the lead. On a box where one model does everything -
 * which is every box until somebody opens the settings - this returns nothing and costs nothing,
 * which is the point: the line exists to describe a choice the owner made, not to describe the
 * default back to itself.
 *
 * Failure is silence. A roster that cannot be resolved is a sentence the model does not get; it is
 * never a reason to fail a turn, because the turn's actual work does not depend on it.
 */
export async function taskModelRoster(
  context: PurposeContext,
  task: TaskRecord,
  catalog: readonly ModelRelease[],
  leadModelId: string
): Promise<Array<{ job: string; model: string }>> {
  const jobs = [
    { purpose: 'specialist', job: 'research and review specialists (delegate)' },
    { purpose: 'coding', job: 'repository changes (coding_agent)' }
  ] as const;
  const roster: Array<{ job: string; model: string }> = [];
  for (const entry of jobs) {
    try {
      const model = await resolveTaskPurposeModel(context, task, entry.purpose, catalog);
      if (model.id !== leadModelId) roster.push({ job: entry.job, model: model.displayName });
    } catch {
      // A job whose route will not resolve is a job the model should not be told it has.
    }
  }
  return roster;
}
