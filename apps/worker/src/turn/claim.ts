/**
 * Everything a turn needs before it can say a word, gathered in one place.
 *
 * This was the first hundred and five lines of `AgentWorker.run()`: a straight run of loads and
 * one-time decisions - the workspace key, the prompt, the model and its gateway, the owner's time
 * zone, the saved trajectory, whether anybody is watching, where this run's web searches go, which
 * tools this box can honestly describe, and what every request will carry before a word of
 * conversation. None of it loops, none of it can be reached twice, and all of it is fixed for the
 * life of the run. It is the *claim* phase, and it was only ever inline because the loop it feeds
 * was written in the same function.
 *
 * What it returns is deliberately two things rather than one. `TurnRun` is frozen for the run;
 * `state` is the trajectory, and the caller mutates it from the next line onward. Handing back one
 * object that mixed them would make the read-only half look editable.
 */
import { decryptJson, unwrapDataKey } from '@athanor/core';
import { resolveWebToolPlan, type ModelRelease, type WebToolPlan } from '@athanor/contracts';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@athanor/data';
import type { ModelGateway, ModelTool } from '@athanor/model-gateway';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { BASE_SYSTEM_PROMPT, COMPACT_CONTEXT_TOOL } from '../context.js';
import { agentToolsFor } from '../tools.js';

/** What claiming a turn needs from the worker that owns it. */
export interface TurnClaimDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly masterKey: Buffer;
  gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{
    gateway: ModelGateway;
    provider: string;
    credential: { provider: string; enforceZeroDataRetention: boolean };
  }>;
  startedBySchedule(task: TaskRecord, key: Uint8Array): Promise<boolean>;
  toolchainSummary(task: TaskRecord): Promise<string>;
}

/** What the turn is, once it has been claimed. Every field is fixed for the life of the run. */
export interface TurnRun {
  /** When this worker picked the turn up, which is what the wall-clock ceiling is measured from. */
  readonly turnStartedAt: number;
  readonly workspace: WorkspaceRecord;
  readonly key: Uint8Array;
  readonly prompt: string;
  readonly catalog: ModelRelease[];
  readonly model: ModelRelease;
  readonly gateway: ModelGateway;
  readonly provider: string;
  readonly timeZone: string;
  readonly unattended: boolean;
  readonly webPlan: WebToolPlan;
  /** Capabilities this box does not currently have, which are not described to the model. */
  readonly withdrawnTools: Set<string>;
  readonly requestTools: ModelTool[];
  readonly reservedTokens: number;
  readonly toolchainSummary: string;
}

export const claimTurn = async (
  deps: TurnClaimDeps,
  task: TaskRecord
): Promise<{ run: TurnRun; state: AgentState }> => {
  /*
   * When this worker picked the turn up, which is what the wall-clock ceiling is measured from.
   *
   * A local rather than a field on the agent state, and the difference is the promise being made:
   * this bounds how long one worker may hold one lease without saying anything to the owner, so a
   * resumed turn gets a fresh allowance exactly as a new turn does. Persisting it would bound the
   * conversation instead, which the API's own resume contract does not.
   */
  const turnStartedAt = Date.now();
  const workspace = await deps.store.getWorkspaceById(task.workspaceId);
  if (!workspace?.wrappedKey) throw new Error('Workspace key not found');
  const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
  const prompt = decryptJson<{ prompt: string }>(task.promptCiphertext, key);
  const catalog = (await deps.store.listModels()) as unknown as ModelRelease[];
  const model = catalog.find((entry) => entry.id === task.modelId);
  if (!model) throw new Error(`Model ${task.modelId} is no longer in the registry`);
  const { gateway, provider, credential } = await deps.gateway(task, model);
  // The owner's own day, taken from the spend limits that already store it rather than from a
  // second copy nobody keeps in step. Without it nothing in the prompt says what time it is, and
  // "by Friday", "last month" and a daily 8am brief are all guesses.
  const timeZone = await deps.store
    .effectiveSpendLimits(task.userId)
    .then((limits) => limits.timeZone)
    .catch(() => 'UTC');
  const savedState = task.agentStateCiphertext
    ? decryptJson<AgentState>(task.agentStateCiphertext, key)
    : null;
  // Whether anyone is watching changes what the run should say, so it has to be known before the
  // runtime block is written. Probed only when the saved state does not already carry the answer:
  // a task that ran before this field existed pays one indexed row read, once, and then persists.
  const unattended = savedState?.unattended ?? (await deps.startedBySchedule(task, key));
  /**
   * Where this run's web searches go, decided once and then pinned.
   *
   * One call answers both parts of it - the route and the provider tool that implements it -
   * because asking separately would mean resolving twice against facts the owner can edit between
   * the two reads, and a run whose disclosure says one thing while its searches go somewhere else
   * is the failure the contract exists to prevent.
   *
   * `startedMode` carries the mode from the saved state, and it can only ever refuse: a run that
   * started in house finishes in house even if the credential is replaced mid-run with one whose
   * provider does answer searches. The other direction is deliberately not pinned - a fact that
   * has just made this task more private takes effect on the next step, and protecting a cache
   * prefix is not a reason to withhold it.
   *
   * What the route no longer decides is the catalogue. `web_search` and `parallel_web_read` are
   * offered under their own names on both routes and only the `web_search` arm in `tools/web.ts`
   * knows the difference, so the mode cannot leave the model looking for a tool that is not there
   * - which is precisely what it did, and what a research question then got answered out of
   * memory because of.
   *
   * Resolved here, ahead of the runtime block, because the block has to say which route is in
   * force: on the provider's route the query itself leaves this computer, and that is the one
   * fact about the web the model cannot work out from its tool schemas.
   */
  const webPlan = resolveWebToolPlan({
    provider: credential.provider,
    forceInHouse: deps.config.AI_FORCE_INHOUSE_WEB,
    ...(savedState?.webToolMode ? { startedMode: savedState.webToolMode } : {})
  });
  const withdrawnTools = new Set<string>();
  /**
   * Capabilities this box does not currently have are not described to the model.
   *
   * The catalogue is sent whole on every request and is the largest fixed cost in a turn, and
   * connector_action is the biggest single tool in it - most of that being the declared shape of
   * mail, calendar, repository and WebDAV operations. With nothing connected, none of those calls
   * can do anything but fail, so describing them buys nothing and is paid for on every step of
   * every task. connector_list stays, because it is how the model finds out, and the contract
   * already tells it to drive webmail in the browser and say that connecting is the better route.
   *
   * This is now the only tool any run withdraws, and it is the one case where withdrawing is
   * honest: what is missing is the capability itself, and connector_list is in the catalogue
   * precisely to say so. Withdrawing a tool whose capability the box still has - which is what
   * this set used to do to `web_search` on the provider's route - leaves the model reading
   * descriptions of a computer it is not on.
   */
  if (!(await deps.store.listConnectors(task.userId)).some((connector) => connector.enabled))
    withdrawnTools.add('connector_action');
  // Byte-identical on both web routes and for the whole run, which is the point: the catalogue is
  // the head of the cached prefix, and it is also the whole of the model's map of what this
  // computer can do. Nothing withdraws a tool after this line, so it is built once here rather
  // than rebuilt every step - and the closing handoff below can be handed the same array, instead
  // of a shorter one that would move the front of the prompt on the largest request of the turn.
  const requestTools = [...agentToolsFor(), COMPACT_CONTEXT_TOOL].filter(
    (tool) => !withdrawnTools.has(tool.name)
  );
  // What every request carries before a word of conversation. The step loop measures its budget
  // against it, the compaction target is derived from the same budget, and the handoff counts it
  // for itself from the same array.
  const reservedTokens = Math.ceil(JSON.stringify(requestTools).length / 4);
  const toolchainSummary = await deps.toolchainSummary(task);
  const state: AgentState = savedState ?? {
    messages: [
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: prompt.prompt }
    ],
    step: 0,
    credits: 0,
    turnToolResults: {},
    finishRejections: 0,
    completionNags: 0
  };
  state.unattended = unattended;
  state.turnToolResults ??= {};

  return {
    run: {
      turnStartedAt,
      workspace,
      key,
      prompt: prompt.prompt,
      catalog,
      model,
      gateway,
      provider,
      timeZone,
      unattended,
      webPlan,
      withdrawnTools,
      requestTools,
      reservedTokens,
      toolchainSummary
    },
    state
  };
};
