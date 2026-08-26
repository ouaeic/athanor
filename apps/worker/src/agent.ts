import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  resolveWebToolPlan,
  type ModelRelease,
  type SpendDecision,
  type TaskPlanStep,
  type WebToolPlan
} from '@athanor/contracts';
import {
  decryptJson,
  encryptJson,
  inferenceCredentialAad,
  AthanorError,
  sha256,
  unwrapDataKey,
  type MemoryDeadEndCheck
} from '@athanor/core';
import { agentNotificationAad, TASK_MAX_ATTEMPTS } from '@athanor/data';
import type { DataStore, TaskRecord } from '@athanor/data';
import {
  isProviderWall,
  ModelGateway,
  OpenAICompatibleAdapter,
  type ModelResponse,
  type ModelTool,
  type ModelToolCall
} from '@athanor/model-gateway';
import {
  acceptanceAcceptedResult,
  type AcceptanceCommandCheck,
  acceptanceFailureMessage,
  acceptancePassedEvidence,
  describeAcceptanceCheck,
  parseAcceptanceChecks,
  type AcceptanceRecord,
  type AcceptanceResult
} from './acceptance.js';
import type { AgentState, AgentWorkerConfig, InferenceCredential } from './agent-state.js';
import {
  approvalArgumentsMatch,
  approvalOutcome,
  approvalPreviewHash,
  type AgentApprovalRequirement
} from './approval-state.js';
import {
  estimatedInferenceCostUsd,
  reservationUsageKey,
  stepUsageKey,
  usageCredit
} from './billing.js';
import {
  askOutcome,
  citableEvidence,
  completionVerification,
  observedCommands,
  startTurnState,
  type CompletionVerification
} from './completion.js';
import { originOf, rememberOrigin, type DestinationContext } from './egress.js';
import {
  BASE_SYSTEM_PROMPT,
  COMPACT_CONTEXT_TOOL,
  compactionTrigger,
  dropLegacyGuidance,
  contextShortfall,
  ensureBasePrompt,
  estimatedContextTokens,
  modelInputBudget,
  prepareModelContext,
  type CompactionOutcome,
  type PreparedContext
} from './context.js';
import { taskFailureRecord } from './failure-record.js';
import { workerLogger, type Logger } from './log.js';
import {
  botWallSite,
  originsFromOwnerMessages,
  providerWebProvenance,
  takeoverNotice,
  type BotWall
} from './provenance.js';
import { providerWebSearch, type WebSearchAnswer } from './provider-search.js';
import { WEB_SEARCH_MAX_OUTPUT_TOKENS, WEB_SEARCH_REQUEST_TIMEOUT_MS, routeTo } from './routing.js';
import {
  REASONING_FLUSH_INTERVAL_MS,
  createStreamFlusher,
  degenerateRepeat,
  normalizeAssistantText
} from './streaming.js';
import { executeToolCall } from './tool-dispatch.js';
import { AgentRunnerClient, withRunnerAbort } from './runner-client.js';
import { agentToolsFor, isMutatingToolCall, writesOnlyProse } from './tools.js';
import {
  ACCEPTANCE_ALREADY_PASSED_CAVEAT,
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  CAVEAT_BESIDE_THE_TICK,
  CHECKPOINT_EXEMPT_TOOLS,
  IDEMPOTENT_WITHIN_TURN,
  IDLE_STEPS_BEFORE_STOP,
  MAX_ACCEPTANCE_BASELINE_REFUSALS,
  MAX_ACCEPTANCE_FAILURES,
  MAX_ARGUMENT_TRUNCATIONS,
  MAX_COMPLETION_NAGS,
  MAX_CONTEXT_OVERFLOW_REPAIRS,
  MAX_FINISH_REJECTIONS,
  MAX_IDLE_STEPS,
  MAX_NOTICES_PER_TURN,
  MAX_REPEATED_FAILURES,
  MAX_TRUNCATED_CONTINUATIONS,
  REPEATABLE_TOOLS,
  REPEATED_FAILURES_BEFORE_STOP,
  acceptanceBaselineNote,
  acceptanceBaselineRefusal,
  approvalOrigin,
  effortFloorEarned,
  failingCallKey,
  idempotentCallKey,
  idleStepBreak,
  idleStepsAfter,
  ownerFixableCheckpointFailure,
  parallelToolRun,
  reasoningEffortForStep,
  repeatedFailureBreak,
  repeatedFailureRise,
  repeatedFailuresAfter,
  spendHalt,
  spendWarning,
  stepLimitCarryOver
} from './turn-bounds.js';
import {
  CANCELLATION_POLL_INTERVAL_MS,
  TASK_LEASE_SECONDS,
  haltReason,
  retryTurnHandoff,
  sealUnansweredToolCalls,
  startStopWatch,
  unansweredToolCallIds,
  withPeriodicRenewal,
  withRequestDeadline
} from './turn-lifecycle.js';
import { runAcceptanceChecks, type AcceptanceRunnerDeps } from './acceptance-runner.js';
import {
  approvalForCallOnce,
  createApprovalFloorMemo,
  type ApprovalFloorDeps,
  type ApprovalFloorMemo
} from './approval-floor.js';
import { compactTurnContext, type CompactionDeps } from './compaction.js';
import {
  drainCorrection as drainCorrection_,
  honorUserControl as honorUserControl_,
  type TurnControlDeps
} from './turn-control.js';
import {
  assemblePreamble,
  refreshActivePlan as refreshActivePlan_,
  refreshRuntimeContext as refreshRuntimeContext_,
  type WindowDeps
} from './window.js';
import {
  handOffAtStepLimit,
  noteStepBudget,
  renewStepBudget,
  stepCeiling,
  turnWallClockReached,
  type HandoffDeps
} from './handoff.js';
import { captureMemory, type MemoryCaptureDeps } from './memory-capture.js';
import {
  event,
  recordToolFailure,
  recordToolResult,
  raiseTaint,
  runToolCallsTogether,
  type ToolRecordingDeps
} from './tool-recording.js';
import { textValue } from './values.js';
import {
  currentCatalog,
  routeImageObservation,
  type CatalogCache,
  type VisionDeps
} from './vision.js';

/**
 * The provider walls this box can actually park a task behind.
 *
 * Must stay equal to the keys of `providerWalls` in `apps/api/src/maintenance/provider-walls.ts`.
 * The recovery sweep there reads the code off the task's own failure event, looks it up in that
 * table, and skips a task whose code it does not recognise - so parking work under a name the sweep
 * has never heard of leaves it in `awaiting_resource` with nothing left that would ever pick it up.
 * `isProviderWall` is the wider question, asked first; this is the narrower one about what recovery
 * exists.
 *
 * The file reference above read `apps/api/src/server.ts` and had been wrong since Wave 6 moved the
 * table; `server.ts` is 297 lines and has not held it since. Both halves of that are now closed:
 * the path is right, and this pair is the ninth entry in `scripts/check-repository.mjs`'s copied-
 * constant table, so the two lists agree because something checks rather than because somebody did.
 */
const PARKABLE_PROVIDER_WALLS = new Set([
  'provider_quota_exhausted',
  'provider_not_connected',
  'provider_unavailable'
]);

/*
 * `event` moved to `tool-recording.ts` in Wave 7.2, with the recording it exists to serve. It is
 * re-exported here because `tools/publishing.ts`, `tools/plan.ts` and `tools/repository.ts` reach
 * it through `../agent.js`, and those files are not this step's to edit. The edit that retires this
 * line is one import path in each of the three.
 */
export { event } from './tool-recording.js';
/*
 * Wave 5 lifted three leaves out of this file - the journal logger to `log.ts`, the build identity
 * to `build-identity.ts` and the failure record to `failure-record.ts` - and re-exports them from
 * here so nothing outside this package had to move on the same commit. `@athanor/worker`'s only
 * export path is this file, so `apps/api/src/log.ts` and `apps/api/src/server.ts` import these
 * names through it, and `apps/worker/src/agent.test.ts` imports them from `./agent.js`.
 *
 * These three re-export blocks can go once those files import from `@athanor/worker/log` and its
 * siblings, which needs the package's `exports` map to name the new modules first. Nothing new
 * should be added to them: a name that belongs to a leaf belongs in that leaf's own import list.
 */
export {
  createLogger,
  journalLevelPrefix,
  silentLogger,
  workerLogger,
  type Logger,
  type LoggerOptions,
  type LogFields,
  type LogLevel,
  type LogThreshold,
  type LogValue
} from './log.js';
export { buildIdentity } from './build-identity.js';
export { failureFields, taskFailureRecord, type TaskFailureLog } from './failure-record.js';

/*
 * Wave 7.1 lifted the pure decision layer out of this file - the ceilings, the provenance rules,
 * the connector call, the completion check, the patch explanation, the turn lifecycle, the
 * streaming bounds, the model routing, the billing arithmetic, the value coercions and the approval
 * match - into twelve siblings, and re-exports them from here for the reason Wave 5 re-exported its
 * three leaves: `@athanor/worker`'s only export path is this file, so `apps/api/src/routes/tasks.ts`
 * and `evals/harness.ts` reach these names through it, and every `tools/*.ts` arm still imports its
 * helpers from `../agent.js`.
 *
 * The list below is exactly the surface this file exported before the move: no name was added to it
 * and none was dropped, which is what makes the move provable. It goes when those importers name
 * the sibling directly - a separate edit, to files this step does not own. Nothing new should be
 * added to it: a name that belongs to a sibling belongs in that sibling's own import list.
 */
export {
  type AgentState,
  type AgentWorkerConfig,
  type ExecObservation,
  type InferenceCredential,
  type ProcessObservation
} from './agent-state.js';
export {
  MAX_PLAN_STEPS,
  asRecord,
  boundedKnowledge,
  countOccurrences,
  openedSkillsStillReadable,
  planStepsFromArguments,
  previewUrl,
  skillDocument,
  textValue
} from './values.js';
export {
  ACCEPTANCE_ALREADY_PASSED_CAVEAT,
  ACCEPTANCE_BASELINE_TIMEOUT_SECONDS,
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  CONTEXT_EFFORT_FLOOR_SHARE,
  DELEGATE_MAX_STEPS,
  HELPER_PACKAGE_MANAGERS,
  HOST_DISK_FULL_CHECKPOINT_CODE,
  IDLE_STEPS_BEFORE_STOP,
  LATE_STEP_EFFORT_FLOOR,
  MAX_ACCEPTANCE_BASELINE_REFUSALS,
  MAX_ACCEPTANCE_FAILURES,
  MAX_ARGUMENT_TRUNCATIONS,
  MAX_COMPLETION_NAGS,
  MAX_CONTEXT_OVERFLOW_REPAIRS,
  MAX_FINISH_REJECTIONS,
  MAX_IDLE_STEPS,
  MAX_NOTICES_PER_TURN,
  MAX_PARALLEL_TOOL_CALLS,
  MAX_QUESTIONS_PER_TURN,
  MAX_REPEATED_FAILURES,
  MAX_TRUNCATED_CONTINUATIONS,
  PACKAGE_VERBS,
  PARALLEL_SAFE_TOOLS,
  PUSHBACK_MARKERS,
  REPEATED_FAILURES_BEFORE_STOP,
  STEP_BUDGET_HANDOFF_STEPS,
  STEP_BUDGET_MARKER,
  STEP_BUDGET_NOTICE_SHARE,
  STEP_HANDOFF_MARKER,
  VISION_SPECIALIST_ATTEMPTS,
  VISION_SPECIALIST_MIN_CONTEXT_TOKENS,
  WORKSPACE_BRIEF_MARKER,
  WORKSPACE_TOO_LARGE_CHECKPOINT_CODE,
  acceptanceBaselineNote,
  acceptanceBaselineRefusal,
  approvalOrigin,
  cancelConfirmation,
  effortFloorEarned,
  failingCallKey,
  failureSignature,
  idleStepBreak,
  idleStepsAfter,
  ownerFixableCheckpointFailure,
  parallelToolRun,
  reasoningEffortForStep,
  repeatedFailureBreak,
  repeatedFailureKey,
  repeatedFailureRise,
  repeatedFailuresAfter,
  spendHalt,
  spendWarning,
  stepBudgetNotice,
  stepLimitCarryOver,
  type PushbackName
} from './turn-bounds.js';
export {
  UNTRUSTED_NOTICE_MARKER,
  botWallFromError,
  botWallFromRunner,
  botWallSite,
  labelledConnectorResult,
  originsFromOwnerMessages,
  originsFromResult,
  providerWebProvenance,
  takeoverNotice,
  untrustedOriginOfResult,
  untrustedTurnNotice,
  type BotWall
} from './provenance.js';
export {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  attachmentDestination,
  attachmentSavedResult,
  connectorHostAllowance,
  mailAttachmentPaths,
  performConnectorAction
} from './connector-call.js';
export {
  ACCEPTANCE_MARKER,
  askOutcome,
  citableEvidence,
  completionVerification,
  evidenceFloor,
  normalisedSpan,
  observedCommands,
  parseDelegateReport,
  startTurnState,
  type DelegateEvidenceCheck
} from './completion.js';
export { patchFailure, type PatchFailure } from './patch-failure.js';
export {
  COMPLETION_HANDOFF_ATTEMPTS,
  COMPLETION_HANDOFF_DELAY_MS,
  MODEL_REQUEST_TIMEOUT_MS,
  haltReason,
  retryTurnHandoff,
  sealUnansweredToolCalls,
  startStopWatch,
  unansweredToolCallIds,
  withPeriodicRenewal,
  withRequestDeadline,
  type StepHalt,
  type StopWatch,
  type TaskClaim
} from './turn-lifecycle.js';
export {
  STREAM_FLUSH_INTERVAL_MS,
  boundedToolResultForModel,
  createStreamFlusher,
  degenerateRepeat,
  normalizeAssistantText
} from './streaming.js';
export {
  COMPACTION_MIN_CONTEXT_TOKENS,
  COMPACTION_REQUEST_TIMEOUT_MS,
  WEB_SEARCH_REQUEST_TIMEOUT_MS,
  compactionEventSummary,
  compactionModel,
  delegateSpecialists,
  routeTo,
  transcriptionRouteAllowed,
  usableCapabilities,
  type ModelCapability
} from './routing.js';
export {
  DELEGATE_BUDGET_SHARE,
  delegateBudget,
  estimatedInferenceCostUsd,
  usageCredit
} from './billing.js';
export {
  approvalArgumentsMatch,
  approvalOutcome,
  approvalPreviewHash,
  type ApprovalOutcome
} from './approval-state.js';

export class AgentWorker {
  readonly #masterKey: Buffer;
  readonly #runner: AgentRunnerClient;
  /**
   * When each workspace's memory was last consolidated. Held in the worker rather than the store
   * because the cadence is an optimisation, not a guarantee: a restart costs one extra run of an
   * idempotent maintenance pass, which is cheaper than a table and a lock to avoid it.
   */
  readonly #memoryConsolidatedAt = new Map<string, number>();
  /**
   * Binaries this process has seen present on a workspace, so a skill opened twice costs one probe.
   *
   * Only presence is cached. A binary that was missing is exactly the one the owner may have just
   * approved an install for, and a cached "still missing" would then argue the agent out of a
   * procedure that now works - so an absence is re-probed, which is one cheap runner call in the
   * only case where the answer can have changed.
   */
  readonly #presentBinaries = new Map<string, Set<string>>();
  /**
   * Stacks this process has already written to the journal. Held per worker rather than per task
   * because the failure that repeats is rarely one task's: a provider that is refusing everything
   * fails every task in the queue with the same trace, and a restart is what clears the memory.
   */
  readonly #loggedFailureStacks = new Set<string>();

  /**
   * The registry rows this worker last read, and when. One slot per worker rather than one per
   * module: a catalogue is per-installation state, and a module-level memo would be shared by every
   * worker in the process and by every test in a file.
   */
  readonly #catalogCache: { current: CatalogCache | null } = { current: null };

  /**
   * What the sub-machines lifted in Wave 7.2 are handed instead of `this`.
   *
   * Built once in the constructor and frozen by construction - every member is either a store, a
   * config or a bound method - so the cost of the split is one object per worker rather than one
   * per call. Methods are wrapped in arrow functions rather than passed by reference because a
   * private method detached from its receiver cannot reach `#` fields.
   */
  readonly #toolRecording: ToolRecordingDeps;

  readonly #vision: VisionDeps;

  readonly #compaction: CompactionDeps;

  readonly #memoryCapture: MemoryCaptureDeps;

  readonly #approvalFloor: ApprovalFloorDeps;

  readonly #acceptanceRunner: AcceptanceRunnerDeps;

  readonly #handoff: HandoffDeps;

  readonly #window: WindowDeps;

  readonly #turnControl: TurnControlDeps;

  constructor(
    private readonly store: DataStore,
    private readonly config: AgentWorkerConfig,
    masterKey: Uint8Array,
    runnerSharedSecret: string,
    /**
     * Where this worker's own records go. The API runs one of these inside its own process, and a
     * failure there belongs in the API's journal at the API's threshold rather than in a second
     * stream nobody configured.
     */
    private readonly logger: Logger = workerLogger
  ) {
    if (masterKey.byteLength !== 32) throw new Error('Agent worker master key must be 32 bytes');
    this.#masterKey = Buffer.from(masterKey);
    this.#runner = new AgentRunnerClient(config.WORKSPACE_RUNNER_URL, runnerSharedSecret);
    this.#toolRecording = {
      store,
      config,
      raiseTakeover: (task, key, state, wall) => this.#raiseTakeover(task, key, state, wall),
      ensureTurnUndoPoint: (task, key, state, tool) =>
        this.#ensureTurnUndoPoint(task, key, state, tool),
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      withCancellationWatch: (task, operation) => this.#withCancellationWatch(task, operation),
      execute: (task, call, key, approved, webPlan, state) =>
        this.#execute(task, call, key, approved, webPlan, state),
      destinationContext: (state) => this.#destinationContext(state),
      recordToolResult: (task, key, state, call, result, leadModel, catalog) =>
        this.#recordToolResult(task, key, state, call, result, leadModel, catalog)
    };
    this.#vision = {
      store,
      catalogCache: this.#catalogCache,
      assertProviderConfigured: (task) => this.#assertProviderConfigured(task),
      gateway: (task, model) => this.#gateway(task, model),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation)
    };
    this.#compaction = {
      store,
      assertProviderConfigured: (task) => this.#assertProviderConfigured(task),
      gateway: (task, model) => this.#gateway(task, model),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      currentCatalog: (fallback) => this.#currentCatalog(fallback)
    };
    this.#memoryCapture = { store, memoryConsolidatedAt: this.#memoryConsolidatedAt };
    this.#approvalFloor = {
      store,
      masterKey: this.#masterKey,
      runner: this.#runner,
      inferenceCredential: (task) => this.#inferenceCredential(task),
      destinationContext: (state) => this.#destinationContext(state)
    };
    this.#acceptanceRunner = {
      store,
      runner: this.#runner,
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      withCancellationWatch: (task, operation) => this.#withCancellationWatch(task, operation)
    };
    this.#handoff = {
      store,
      config,
      runAcceptanceChecks: (task, key, record, options, state) =>
        this.#runAcceptanceChecks(task, key, record, options, state),
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state),
      withLeaseRenewal: (task, operation) => this.#withLeaseRenewal(task, operation),
      outstandingPlanSteps: (task, key) => this.#outstandingPlanSteps(task, key),
      execute: (task, call, key, approved, webPlan, state) =>
        this.#execute(task, call, key, approved, webPlan, state),
      recordToolResult: (task, key, state, call, result, leadModel, catalog) =>
        this.#recordToolResult(task, key, state, call, result, leadModel, catalog),
      completeTurn: (task, key, state, completion, options) =>
        this.#completeTurn(task, key, state, completion, options)
    };
    this.#window = { store, config, runner: this.#runner };
    this.#turnControl = {
      store,
      config,
      runner: this.#runner,
      logger: this.logger,
      checkpoint: (task, key, state) => this.#checkpoint(task, key, state)
    };
  }

  /**
   * The credential facts the web route is decided from, handed back with the gateway rather than
   * read a second time.
   *
   * The owner can edit both from the settings page while a task runs, and two reads a step apart
   * can disagree - which on this decision is the difference between sending the provider's search
   * tools and withdrawing the in-house ones, the one pair the tool catalogue cannot survive.
   */
  /**
   * The provider this owner has configured, as a base URL and a key.
   *
   * Media generation needs the same account as inference and nothing else about a model release,
   * so the lookup lives here rather than being written twice with two chances to disagree about
   * which credential wins.
   */
  async #inferenceCredential(task: TaskRecord): Promise<InferenceCredential> {
    const credential =
      (await this.store.getManagedProviderCredential(task.userId, 'inference')) ??
      (await this.store.getManagedProviderCredential(task.userId, 'openrouter'));
    const environmentApiKey = this.config.AI_API_KEY ?? this.config.OPENROUTER_API_KEY;
    const secret: InferenceCredential | undefined = credential?.secretCiphertext
      ? credential.provider === 'inference'
        ? decryptJson<InferenceCredential>(
            credential.secretCiphertext,
            this.#masterKey,
            inferenceCredentialAad(task.userId)
          )
        : {
            provider: 'openrouter',
            baseUrl: this.config.OPENROUTER_BASE_URL,
            apiKey: decryptJson<{ apiKey: string }>(credential.secretCiphertext, this.#masterKey)
              .apiKey,
            enforceZeroDataRetention: true
          }
      : environmentApiKey
        ? {
            provider: this.config.AI_PROVIDER,
            baseUrl: this.config.AI_BASE_URL,
            apiKey: environmentApiKey,
            enforceZeroDataRetention: this.config.AI_REQUIRE_ZDR
          }
        : this.config.AI_PROVIDER === 'openai-compatible' && this.config.AI_DEFAULT_MODEL
          ? {
              provider: 'openai-compatible',
              baseUrl: this.config.AI_BASE_URL,
              enforceZeroDataRetention: this.config.AI_REQUIRE_ZDR
            }
          : undefined;
    if (!secret)
      throw new AthanorError(
        // The name three things already listen for. `provider_setup_required` was thrown here and
        // recognised nowhere: the API's wall table, the title sweep's cooldown and this worker's own
        // `waiting` test all key on `provider_not_connected`, so the missing-credential wall was
        // unreachable and every one of them ran its failure branch instead. A code with three
        // consumers and no producer is a control wired to nothing.
        'provider_not_connected',
        'Add a model provider in Settings before starting agent work',
        503
      );
    return secret;
  }

  async #gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{
    gateway: ModelGateway;
    provider: string;
    credential: { provider: string; enforceZeroDataRetention: boolean };
  }> {
    const gateway = new ModelGateway();
    const secret = await this.#inferenceCredential(task);
    const expectedProvider = secret.provider === 'openrouter' ? 'openrouter' : 'custom';
    if (model.provider !== expectedProvider)
      throw new AthanorError(
        'provider_model_mismatch',
        `The selected model belongs to ${model.provider}, but ${secret.provider} is configured`
      );
    gateway.register(
      model.provider,
      new OpenAICompatibleAdapter({
        baseUrl: secret.baseUrl,
        ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
        provider: model.provider,
        privacyRoute: model.privacyRoute,
        appUrl: this.config.PUBLIC_APP_URL,
        appTitle: 'athanor',
        enforceZeroDataRetention:
          secret.provider === 'openrouter' && secret.enforceZeroDataRetention
      })
    );
    return {
      gateway,
      provider: model.provider,
      credential: {
        provider: secret.provider,
        enforceZeroDataRetention: secret.enforceZeroDataRetention
      }
    };
  }

  async #withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T> {
    return withPeriodicRenewal(operation, () =>
      this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS)
    );
  }

  /**
   * Persists the trajectory mid-step. The per-step checkpoint alone cannot record that a particular
   * tool call was already under way, which is what a resume needs in order to avoid running an
   * external action a second time.
   */
  async #checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void> {
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'running',
      actualComputeCredits: state.credits,
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
    });
  }

  /**
   * Takes this turn's undo point for the computer, once, before the first call that could change it.
   *
   * Lazily, because a turn that only reads has nothing to undo and should cost nothing. Once,
   * because the point of the checkpoint is the state the turn started from, not the state before
   * each of its calls. And never fatally: an owner losing the ability to rewind one turn is bad,
   * but stopping the work they asked for because the undo point could not be taken is worse - so a
   * failure is written into the timeline where they can see it, and the turn carries on.
   */
  async #ensureTurnUndoPoint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    tool: string
  ): Promise<void> {
    const turn = state.turn ?? 0;
    if (CHECKPOINT_EXEMPT_TOOLS.has(tool) || state.checkpoint?.turn === turn) return;
    const checkpointId = randomUUID();
    try {
      const created = await this.#withLeaseRenewal(task, () =>
        this.#runner.checkpoint(task.workspaceId, task.id, { checkpointId, turn })
      );
      state.checkpoint = { turn, id: checkpointId };
      await this.store.recordWorkspaceCheckpoint({
        id: checkpointId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        turn,
        mechanism: created.mechanism,
        fileCount: created.fileCount,
        totalBytes: created.totalBytes,
        storedBytes: created.storedBytes,
        durationMs: created.durationMs
      });
      // The runner has already removed these from disk, so the rows would otherwise offer the
      // owner a rewind to a checkpoint that is not there any more.
      if (created.pruned.length)
        await this.store.deleteWorkspaceCheckpoints(task.workspaceId, created.pruned);
    } catch (error) {
      state.checkpoint = { turn, id: null };
      const message = error instanceof Error ? error.message : 'The checkpoint could not be taken';
      await event(
        this.store,
        task,
        key,
        'warning',
        'This turn has no undo point for the computer',
        {
          // The code first, where there is one to read. An `AthanorError` carries it as a field
          // already; everything else has it flattened into the message and is dug back out there.
          ...(ownerFixableCheckpointFailure(
            message,
            error instanceof AthanorError ? { code: error.code } : undefined
          )
            ? { owner: true }
            : {}),
          tool,
          message
        }
      );
    }
  }

  /**
   * Stops a task before the step that would take it over a money ceiling.
   *
   * The compute-credit check above is not a money check: a credit is worth cents on one model and
   * dollars on another, so a task can sit well inside its credit budget and still run up a bill the
   * owner never agreed to. This is the ceiling denominated in the thing they actually pay.
   *
   * It pauses rather than fails, and it pauses *before* the call rather than after the one that
   * crossed - the work so far is intact, the transcript is intact, and raising the ceiling and
   * resuming carries on from here. Failing would throw away a long task over its last dollar, and
   * checking afterwards would always overshoot by one step.
   */
  /**
   * Tells the owner's devices, once per window, that their ceiling is in play.
   *
   * "Warn me at 80% of my daily cap" only ever appeared inside whichever task happened to cross it,
   * which for unattended work - the point of the machine - is a 3am scheduled run nobody opens for
   * hours. The threshold was decorative. `claimSpendAlert` is the deduplication: it inserts on a
   * unique window and returns false if this box has already said this about this window, so a long
   * task that keeps stepping does not keep ringing a phone.
   */
  async #raiseSpendAlert(
    task: TaskRecord,
    key: Uint8Array,
    decision: SpendDecision,
    level: 'warning' | 'exceeded'
  ): Promise<void> {
    const names =
      level === 'warning' ? decision.warnedBy : decision.blockedBy ? [decision.blockedBy] : [];
    for (const name of names) {
      if (name !== 'daily' && name !== 'monthly') continue;
      const window = decision.windows.find((candidate) => candidate.name === name);
      if (!window?.startsAt || window.capUsd === null) continue;
      const claimed = await this.store
        .claimSpendAlert({
          userId: task.userId,
          windowName: name,
          windowStart: new Date(window.startsAt),
          level,
          spentUsd: window.spentUsd,
          capUsd: window.capUsd
        })
        .catch(() => false);
      if (!claimed) continue;
      /*
       * A cap that has been reached is not an agent message.
       *
       * The pause raises `spend_paused`, which is its own notification kind with its own switch in
       * Settings, and this used to raise an `agent_message` beside it for the same event. That made
       * both switches lie: turning agent messages off silenced spend-cap alerts, and the spending
       * switch governed nothing the owner could see. The warning at eighty per cent keeps this
       * channel because there is no pause behind it - nothing else would say anything at all.
       */
      if (level === 'exceeded') continue;
      const headline = `Spending has passed the warning point of your ${name} cap: $${window.spentUsd.toFixed(2)} of $${window.capUsd.toFixed(2)}.`;
      await this.store
        .createAgentNotification({
          userId: task.userId,
          taskId: task.id,
          kind: 'agent_message',
          messageCiphertext: encryptJson({ message: headline }, key, agentNotificationAad(task.id))
        })
        .catch(() => undefined);
    }
  }

  /**
   * What one model call cost, on the ledger, in the credit total and on the timeline.
   *
   * Lifted out of the step loop because three paths through that loop need it and only one of them
   * used to reach it. A generation aborted for looping took a `continue` from above the block and a
   * generation the owner stopped returned from above it, so the two calls the box ends on purpose -
   * the two most expensive things a runaway model does - were the two nobody was ever charged for.
   * The block itself is unchanged; what changed is how many ways there are to arrive at it.
   */
  async #billModelStep(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    input: {
      response: ModelResponse;
      model: ModelRelease;
      preparedContext: PreparedContext;
      reservedTokens: number;
      turn: number;
      reasoningEffort: 'low' | 'medium' | 'high';
    }
  ): Promise<void> {
    const { response, model, preparedContext, reservedTokens, turn, reasoningEffort } = input;
    // What the request that just went out actually weighed, replacing this side's estimate of it.
    // Compaction was decided from characters-divided-by-four while this exact number arrived on
    // every response and was spent only on billing; the estimate cannot see a tokeniser's real
    // behaviour on code, JSON or non-Latin text, so the window was compacted early on some tasks
    // and overrun on others. It is converted to the unit the trigger compares against:
    // prompt_tokens includes the tool catalogue, and modelInputBudget has already set that aside
    // as reservedTokens, so charging it here as well would count it twice. A route that reports
    // no usage leaves the estimate in charge rather than claiming an empty window.
    if (response.usage.inputTokens > 0)
      state.preparedInputTokens = Math.max(0, response.usage.inputTokens - reservedTokens);
    /*
     * What a call that was cut off owes for its prompt.
     *
     * The gateway can count the output it watched go past, and does. It cannot count the input:
     * usage arrives in the last frame of the stream and a stream that was cut never reaches it,
     * and the prompt is not something the reading side ever saw. This side did see it - it
     * assembled the request a few lines above and priced it there - so the one number missing
     * from a cut-off call is the one number here is certain of. The catalogue is added back
     * because the estimate covers the messages alone while what a provider bills is the whole
     * request. Left at zero, a quarter of an hour of generation settled at a few tenths of a
     * cent, which is the spinner-and-a-price-that-never-moves the owner asked about, one layer up.
     */
    const billedInputTokens =
      response.usage.estimated && response.usage.inputTokens === 0
        ? preparedContext.estimatedInputTokens + reservedTokens
        : response.usage.inputTokens;
    const credit = usageCredit(model, billedInputTokens, response.usage.outputTokens);
    const costUsd =
      response.usage.costUsd ??
      estimatedInferenceCostUsd(
        model,
        billedInputTokens,
        response.usage.outputTokens,
        response.usage
      );
    state.credits += credit;
    // Added to rather than replaced. A step is not one model call: a vision handoff, a compaction
    // summary and a provider search all bill inside the same step, and each of them used to
    // overwrite this - so the guard that prices the next step from it was quoted whichever of them
    // happened to run last, which on an image-heavy turn is a light specialist standing in for a
    // full-window lead call. The loop clears it once, before the call the step is named for.
    state.lastStepUsd = (state.lastStepUsd ?? 0) + costUsd;
    await this.store.recordUsage({
      userId: task.userId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: model.usageClass,
      // The total is the provider's own, except where there is no provider total: a stream that
      // was cut carries a sum of a reported output and an input nobody reported, and billing the
      // ledger from it would file the same zero the credit line has just stopped charging.
      quantity: response.usage.estimated
        ? billedInputTokens + response.usage.outputTokens
        : response.usage.totalTokens,
      unit: 'tokens',
      credits: credit,
      costUsd,
      state: 'settled',
      idempotencyKey: stepUsageKey(task.id, turn, state.step),
      providerRef: `${response.metadata.provider}:${response.metadata.model}`
    });
    await event(this.store, task, key, 'cost', `Step ${state.step + 1} completed`, {
      credits: credit,
      costUsd,
      cumulativeCredits: state.credits,
      usage: response.usage,
      metadata: response.metadata,
      reasoningEffort,
      context: {
        estimatedInputTokens: preparedContext.estimatedInputTokens,
        contextWindowTokens: model.contextTokens,
        compacted: preparedContext.compacted,
        cacheBreakpoints: preparedContext.cacheBreakpoints,
        olderToolOutputChars: preparedContext.olderToolOutputChars
      }
    });
  }

  /**
   * What the owner and the model are each told about a reply that was stopped for looping.
   *
   * Written once and called from both arms of the abort - the one that generated something and the
   * one that did not - because the sentence the model is given is the correction it acts on, and
   * two copies of it is two chances for the arms to start saying different things.
   */
  async #noteRepeatingAnswer(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    repeated: string
  ): Promise<void> {
    await event(this.store, task, key, 'warning', 'Stopped a repeating answer', {
      repeated: repeated.slice(0, 200)
    });
    state.messages.push({
      role: 'system',
      content: `Your last reply began repeating "${repeated.slice(0, 120)}" and was stopped. Do not restate it. Say the next thing that is actually new, or call finish if the work is done.`
    });
  }

  async #haltIfOutOfMoney(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<boolean> {
    // The next step usually costs about what the last one did. A first step has nothing to go on,
    // so it is priced at a token amount: the point is to catch a runaway, not to predict precisely.
    const estimateUsd = Math.max(0.01, state.lastStepUsd ?? 0.01);
    let guardFailure = '';
    const decision = await this.store
      .spendGuard({
        userId: task.userId,
        taskId: task.id,
        estimateUsd,
        includeOpenCommitments: true
      })
      .catch((cause: unknown) => {
        guardFailure = cause instanceof Error ? cause.message : 'the spending guard did not answer';
        return null;
      });
    /*
     * A brake that cannot answer stops the car.
     *
     * This used to swallow the failure and return "do not halt", so one transient database error
     * removed the owner's daily ceiling for that step, silently and with nothing written anywhere.
     * The cap exists precisely so an unattended run cannot get away from the person who is asleep,
     * and the only thing left underneath it is the compute-credit backstop, which sits far above
     * where anyone sets a daily limit. Pausing costs a resumable task; failing open costs money
     * that is already gone by the time it is noticed.
     */
    if (!decision) {
      const reason = guardFailure || 'the spending guard did not answer';
      await event(
        this.store,
        task,
        key,
        'status',
        'Paused: athanor could not check this against your spending caps, so it stopped rather than spend past them.',
        { blockedBy: 'spend_guard_unavailable', reason, estimateUsd }
      );
      await this.store.updateTask({
        id: task.id,
        workerId: this.config.WORKER_ID,
        status: 'paused',
        actualComputeCredits: state.credits,
        // What makes this a spend pause rather than an ordinary one. The whole `spend_paused`
        // notification kind - its query, its switch, its consumer - was built and reachable by
        // nothing, because the only two writes that should set this column never set it. An
        // ordinary Pause deliberately leaves it null; a resume clears it in the same statement that
        // re-queues the task, so nothing here has to.
        spendPausedAt: new Date(),
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
        clearLease: true
      });
      return true;
    }
    if (decision.outcome === 'allow') return false;

    if (decision.outcome === 'warn') {
      // Warn once per window, or a long task narrates the same sentence every step.
      const warned = new Set(state.spendWarnings ?? []);
      const fresh = decision.warnedBy.filter((window) => !warned.has(window));
      if (fresh.length) {
        state.spendWarnings = [...warned, ...fresh];
        await event(this.store, task, key, 'warning', spendWarning(decision), {
          windows: decision.windows,
          estimateUsd
        });
        await this.#raiseSpendAlert(task, key, decision, 'warning');
      }
      return false;
    }

    await event(this.store, task, key, 'status', spendHalt(decision), {
      blockedBy: decision.blockedBy,
      windows: decision.windows,
      estimateUsd
    });
    await this.#raiseSpendAlert(task, key, decision, 'exceeded');
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'paused',
      actualComputeCredits: state.credits,
      // The column that tells a pause the owner asked for from one the ceiling imposed. Everything
      // downstream of `spend_paused` reads it and nothing used to write it.
      spendPausedAt: new Date(),
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
      clearLease: true
    });
    return true;
  }

  /**
   * Makes Cancel stop the tool that is already running, not just the ones queued behind it.
   *
   * A single call can hold the worker for an hour, so without this a cancel is only honoured once
   * the long shell command or browser action has finished on its own. The poll is deliberately
   * cheap and read-only; when it sees a stop it aborts the runner request, which surfaces as a
   * failed tool result and lets the loop's own cancellation check take the task down cleanly.
   */
  async #withCancellationWatch<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    /*
     * The two columns this asks about, and not the whole row.
     *
     * `getTask` returns the task with its encrypted trajectory attached, so a poll every three
     * seconds for the life of a ten-minute tool call read about 190 MB to look at one string -
     * and the cost rises with the length of the conversation, so the longest turns, the ones this
     * watch exists to protect, paid the most. `taskClaim` is the narrow read written for exactly
     * this, and the model call's own stop watch beside it already used it.
     *
     * Read through `haltReason` as that watch is, which also closes the case this poll could not
     * see: a task re-queued or re-leased under a running tool call is no longer this run's to
     * finish, and carrying on with it means writing over whoever holds it now.
     */
    const poll = setInterval(() => {
      void this.store
        .taskClaim(task.id)
        .then((claim) => {
          if (haltReason(claim, this.config.WORKER_ID)) controller.abort();
        })
        .catch(() => undefined);
    }, CANCELLATION_POLL_INTERVAL_MS);
    poll.unref();
    try {
      return await withRunnerAbort(controller.signal, operation);
    } finally {
      clearInterval(poll);
    }
  }

  /**
   * @see currentCatalog in `vision.ts`, where this moved in Wave 7.2 and gained the memo. It was a
   * whole-table read of `model_releases` per image-bearing tool result - one per step on a browsing
   * turn - to follow a registry that refreshes hourly.
   */
  async #currentCatalog(fallback: ModelRelease[]): Promise<ModelRelease[]> {
    return currentCatalog(this.#vision, fallback);
  }

  /**
   * The addresses that are this installation rather than somewhere it could send anything.
   *
   * Read from configuration rather than from anything the model wrote, for the same reason the
   * host and byte count on the approval card are: a destination the agent can name is a
   * destination the agent can lie about.
   */
  #selfOrigins(): string[] {
    return [originOf(this.config.PUBLIC_APP_URL)].filter(Boolean);
  }

  /**
   * Where this run is allowed to send data, assembled once for everything that asks.
   *
   * The lead's approval floor, a delegated specialist's refusal and the turn's novelty budget are
   * three questions about the same fact, and three hand-built copies of it are three chances for
   * one of them to be measuring against a different corpus than the one the owner would recognise.
   */
  #destinationContext(state?: AgentState): DestinationContext {
    return {
      knownOrigins: [
        ...(state?.knownOrigins ?? []),
        ...originsFromOwnerMessages(state?.messages ?? [])
          .map(originOf)
          .filter(Boolean)
      ],
      // Only what the harness read out of a tool result. An address the owner typed is already in
      // their own words below, so repeating it here would say nothing.
      knownAddresses: state?.knownAddresses ?? [],
      // The owner's own words, and only those: what the agent wrote about the page is not evidence
      // that the owner asked for the page.
      ownerText: (state?.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .join('\n')
        .slice(0, 40_000),
      selfOrigins: this.#selfOrigins(),
      spentNoveltyBytes: state?.turnNoveltyBytes ?? 0
    };
  }

  async #assertProviderConfigured(task: TaskRecord): Promise<void> {
    const configured =
      (await this.store.getManagedProviderCredential(task.userId, 'inference')) ??
      (await this.store.getManagedProviderCredential(task.userId, 'openrouter'));
    if (
      !configured &&
      !this.config.AI_API_KEY &&
      !this.config.OPENROUTER_API_KEY &&
      !(this.config.AI_PROVIDER === 'openai-compatible' && this.config.AI_DEFAULT_MODEL)
    )
      throw new AthanorError(
        // The name three things already listen for. `provider_setup_required` was thrown here and
        // recognised nowhere: the API's wall table, the title sweep's cooldown and this worker's own
        // `waiting` test all key on `provider_not_connected`, so the missing-credential wall was
        // unreachable and every one of them ran its failure branch instead. A code with three
        // consumers and no producer is a control wired to nothing.
        'provider_not_connected',
        'Add a model provider in Settings before starting agent work',
        503
      );
  }

  /** @see noteStepBudget in `handoff.ts`, where this moved in Wave 7.2. */
  async #noteStepBudget(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    maxSteps: number
  ): Promise<void> {
    await noteStepBudget(this.#handoff, task, key, state, maxSteps);
  }

  /**
   * One notice the owner asked for, written to the conversation and queued for their devices.
   *
   * Nothing else in the product lets the agent decide to say something: the only push was derived
   * from a task reaching a terminal status, so a fifteen-minute page monitor announced itself
   * ninety-six times a day whether or not the page had changed, and the owner's only remedy
   * silenced every other conversation too. A notice is the opposite - it exists because the agent
   * judged there was something to say, and a run that judges otherwise leaves no row behind at all.
   *
   * The queued row comes first. It is the half that can be refused - the box bounds how many one
   * turn may raise, and the count starts again on the turn after the user replies - and a refusal
   * the model can read is worth more than an event written for a push that will never leave the
   * machine.
   */
  async #sendNotice(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall
  ): Promise<void> {
    const headline = textValue(call.arguments.headline).trim().replace(/\s+/g, ' ').slice(0, 140);
    const detail = textValue(call.arguments.detail).trim().slice(0, 2_000);
    const sent = state.notices ?? 0;
    const refusal = !headline
      ? 'Refused: a notice needs a headline the user can act on from a lock screen.'
      : sent >= MAX_NOTICES_PER_TURN
        ? `Refused: this turn has already sent ${sent} notices, which is the limit. Past that it is a stream rather than news - put the rest in your reply, which the user reads when they open the conversation.`
        : null;
    if (refusal) {
      state.messages.push({ role: 'tool', toolCallId: call.id, content: refusal });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
      return;
    }
    // The headline alone, because that is what a lock screen shows; the detail is waiting in the
    // conversation the notification opens.
    const queued = await this.store
      .createAgentNotification({
        userId: task.userId,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: encryptJson({ message: headline }, key, agentNotificationAad(task.id))
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : 'unavailable'));
    if (typeof queued === 'string') {
      state.messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: `Refused: the notice could not be queued for the user's devices. ${queued}`
      });
      state.turnToolResults ??= {};
      state.turnToolResults[call.id] = { name: call.name, success: false };
      return;
    }
    state.notices = sent + 1;
    await event(this.store, task, key, 'notice', headline, {
      headline,
      ...(detail ? { detail } : {}),
      unattended: state.unattended === true
    });
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify({
        notified: true,
        headline,
        note: 'The user has been told. Do not repeat this in another notice; your reply is where the rest of it belongs.'
      })
    });
    state.turnToolResults ??= {};
    state.turnToolResults[call.id] = { name: call.name, success: true };
  }

  /**
   * Stops the turn on a question, which is the other half of `#sendNotice`.
   *
   * It mirrors the approval path deliberately rather than inventing a second way to wait: the call
   * is answered in the window, the remaining calls in the batch are deferred in writing, an event is
   * written, and the task is saved `awaiting_user` with its lease cleared. What it does not mirror is
   * the approvals table. A question is not an approval - there is nothing to bind arguments to,
   * nothing to expire into a denial, and no yes or no to be given - so the answer is the owner's next
   * message, taken back into this same turn by `run`.
   *
   * The notification is the one an unattended run already has. It carries the agent's own sentence
   * to a device, which is exactly what a question is, and it is charged against the same
   * per-conversation ceiling as every other notification the agent raises. Failure to queue it is
   * swallowed, like the takeover raise: the question is in the transcript and the conversation is
   * parked either way, and a device that could not be reached is not a reason to keep working past a
   * decision the model has just said it cannot make.
   *
   * Returns whether the turn is parked. A refused question is an ordinary failed tool call and the
   * turn carries on, which is the point: the refusals tell the model to go and find out instead.
   */
  async #askUser(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    deferred: readonly ModelToolCall[]
  ): Promise<boolean> {
    const outcome = askOutcome(state, call.arguments);
    state.turnToolResults ??= {};
    if (!outcome.ok) {
      state.messages.push({ role: 'tool', toolCallId: call.id, content: outcome.refusal });
      state.turnToolResults[call.id] = { name: call.name, success: false };
      return false;
    }
    const { question, options, why } = outcome;
    state.questionsAsked = (state.questionsAsked ?? 0) + 1;
    state.question = { question, askedAtStep: state.step };
    // Answered before the park, not after it: a tool call with no result is a malformed window, and
    // this one is saved and reloaded by whichever worker picks the conversation back up.
    state.messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: `Asked. The conversation is parked until the user answers, and their reply arrives as the next user message - so do not ask again, and do not act on a guess in the meantime. Question: ${question}${
        options.length ? `\nOptions offered: ${options.join(' | ')}` : ''
      }`
    });
    state.turnToolResults[call.id] = { name: call.name, success: true };
    for (const later of deferred)
      state.messages.push({
        role: 'tool',
        toolCallId: later.id,
        content:
          'Deferred because the turn stopped for a question. Request it again if still needed.'
      });
    await this.store
      .createAgentNotification({
        userId: task.userId,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: encryptJson({ message: question }, key, agentNotificationAad(task.id))
      })
      .catch(() => undefined);
    await event(this.store, task, key, 'question_asked', question, {
      question,
      why,
      ...(options.length ? { options } : {}),
      unattended: state.unattended === true
    });
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'awaiting_user',
      actualComputeCredits: state.credits,
      agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
      clearLease: true
    });
    return true;
  }

  /**
   * Tells the owner about a challenge only a person can clear.
   *
   * The runner detects the wall, scopes it and hands it over as data, and the conversation shows it
   * - but none of that reaches a phone, and an unattended run that walks into a check at 03:00 has
   * nobody to tell. This is where it becomes a notification, because raising one needs the task's
   * user and the workspace key, and the runner has neither.
   *
   * Failure is swallowed on purpose. The wall is already in the transcript and in the tool result;
   * a notification row that could not be written is not a reason to fail the call that hit it.
   */
  async #raiseTakeover(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    wall: BotWall
  ): Promise<void> {
    const site = botWallSite(wall.url);
    const raised = state.takeoversRaised ?? [];
    if (raised.includes(site)) return;
    // Bounded by the same number of notifications one conversation may raise at all, so a task that
    // walks into a wall on twenty sites cannot grow this list without bound either.
    state.takeoversRaised = [...raised, site].slice(-MAX_AGENT_NOTIFICATIONS_PER_TASK);
    await this.store
      .createAgentNotification({
        userId: task.userId,
        taskId: task.id,
        kind: 'takeover_needed',
        messageCiphertext: encryptJson(
          { message: takeoverNotice(wall) },
          key,
          agentNotificationAad(task.id)
        )
      })
      .catch(() => undefined);
  }

  /** @see recordToolFailure in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #recordToolFailure(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    error: unknown
  ): Promise<void> {
    await recordToolFailure(this.#toolRecording, task, key, state, call, error);
  }

  /** @see runToolCallsTogether in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #runToolCallsTogether(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    calls: readonly ModelToolCall[],
    context: {
      model: ModelRelease;
      catalog: ModelRelease[];
      webPlan: WebToolPlan;
      refreshActivePlan: () => Promise<boolean>;
    }
  ): Promise<void> {
    await runToolCallsTogether(this.#toolRecording, task, key, state, calls, context);
  }

  /** The plan steps this task has not finished, newest plan version, in order. */
  async #outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]> {
    const plan = await this.store.getLatestTaskPlan(task.id).catch(() => null);
    if (!plan || plan.stepsCiphertext.aad !== `task-plan:${task.id}`) return [];
    return decryptJson<{ steps: TaskPlanStep[] }>(plan.stepsCiphertext, key)
      .steps.filter((step) => step.status !== 'completed' && step.status !== 'skipped')
      .map((step) => step.title);
  }

  /** @see stepCeiling in `handoff.ts`, where this moved in Wave 7.2. */
  #stepCeiling(state: AgentState): number {
    return stepCeiling(this.#handoff, state);
  }

  /** @see renewStepBudget in `handoff.ts`, where this moved in Wave 7.2. */
  async #renewStepBudget(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<boolean> {
    return renewStepBudget(this.#handoff, task, key, state);
  }

  /**
   * @see handOffAtStepLimit in `handoff.ts`, where this moved in Wave 7.2 and gained the third
   * ceiling: a turn may now run out of time as well as out of steps and out of money.
   */
  async #handOffAtStepLimit(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    context: {
      gateway: ModelGateway;
      provider: string;
      model: ModelRelease;
      catalog: ModelRelease[];
      turn: number;
      maxOutputTokens: number;
      tools: ModelTool[];
      webPlan: WebToolPlan;
      reason?: 'steps' | 'credits' | 'time';
    }
  ): Promise<void> {
    await handOffAtStepLimit(this.#handoff, task, key, state, context);
  }

  /**
   * Whether a schedule started this task rather than the owner.
   *
   * The scheduler stamps its own id into the payload of the run's opening event, which is the only
   * durable marker there is - the task row itself does not say where it came from. Read once per
   * task and then carried in the agent state, so a long conversation does not re-ask.
   */
  async #startedBySchedule(task: TaskRecord, key: Uint8Array): Promise<boolean> {
    const page = await this.store
      .listTaskEventPage(task.id, { after: 0, limit: 1 })
      .catch(() => null);
    const opening = page?.events[0];
    if (!opening?.payloadCiphertext || opening.payloadCiphertext.aad !== `task-event:${task.id}`)
      return false;
    try {
      const body = decryptJson<{ payload?: { scheduleId?: unknown } }>(
        opening.payloadCiphertext,
        key
      );
      return typeof body.payload?.scheduleId === 'string';
    } catch {
      // An opening event this key cannot read says nothing about the origin, and guessing
      // "unattended" would silence a conversation the owner is sitting in front of.
      return false;
    }
  }

  /**
   * What this computer can do with documents, in the runner's own words.
   *
   * Read once at the start of a run and folded into the frozen runtime block, because the answer
   * is a property of the machine rather than of the step. A runner that cannot answer costs the
   * agent this line and nothing else: a task that will not start would be a far worse trade than
   * one that has to check a binary itself.
   */
  async #toolchainSummary(task: TaskRecord): Promise<string> {
    const report = await this.#runner
      .call<{
        summary?: unknown;
      }>(task.workspaceId, task.id, 'exec', `/v1/workspaces/${task.workspaceId}/toolchain`)
      .catch(() => null);
    return textValue(report?.summary).trim();
  }

  /** Which of a skill's declared binaries this workspace does not have, probed through the runner. */
  async #missingBinaries(task: TaskRecord, binaries: readonly string[]): Promise<string[]> {
    const known = this.#presentBinaries.get(task.workspaceId) ?? new Set<string>();
    const unknown = [...new Set(binaries)].filter((binary) => !known.has(binary));
    if (!unknown.length) return [];
    const probed = await this.#runner
      .call<{
        present?: unknown;
        missing?: unknown;
      }>(task.workspaceId, task.id, 'exec', `/v1/workspaces/${task.workspaceId}/toolchain/probe`, {
        binaries: unknown
      })
      .catch(() => null);
    // A probe that could not run must not invent an absence: claiming a present binary is missing
    // sends the agent to ask for an install the owner does not need.
    if (!probed) return [];
    for (const binary of Array.isArray(probed.present) ? probed.present.map(String) : [])
      known.add(binary);
    this.#presentBinaries.set(task.workspaceId, known);
    return Array.isArray(probed.missing) ? probed.missing.map(String) : [];
  }

  /**
   * `web_search`, answered by the provider instead of by the workspace's browser.
   *
   * The tool is the same tool on both routes - same name, same parameters, same description, same
   * result shape - because a model that has to know where its searches are answered in order to know
   * what to call is a model that will get it wrong. What differs is entirely behind this method.
   *
   * It is a second model request, and that is not a workaround for a missing API but the shape of
   * the thing: a provider-side tool has no name a model can call, so the only way to spend one
   * deliberately is to build a request whose whole purpose is to spend it. It carries no function
   * tools at all, which the gateway checks one line before the wire.
   *
   * The task's own model runs it rather than a cheaper one chosen from the catalogue. The request is
   * two sentences and a query, so the model's rate barely registers against the search itself, and
   * picking a different model would mean re-checking that it belongs to the configured provider and
   * to this task's privacy route - two ways to be wrong about where the query goes, bought for
   * fractions of a cent.
   */
  async #providerWebSearch(
    task: TaskRecord,
    call: ModelToolCall,
    webPlan: WebToolPlan,
    state?: AgentState
  ): Promise<WebSearchAnswer> {
    await this.#assertProviderConfigured(task);
    const catalog = (await this.store.listModels()) as unknown as ModelRelease[];
    const model = catalog.find((entry) => entry.id === task.modelId);
    if (!model)
      throw new AthanorError(
        'model_unavailable',
        `Model ${task.modelId} is no longer in the registry`
      );
    const { gateway, provider } = await this.#gateway(task, model);
    return providerWebSearch({
      query: textValue(call.arguments.query),
      limit: Math.max(1, Math.min(10, Math.trunc(Number(call.arguments.limit ?? 10)) || 10)),
      engine: webPlan.serverTools.map((tool) => tool.type).join(', '),
      ask: async (messages) => {
        const response = await this.#withLeaseRenewal(task, () =>
          withRequestDeadline(
            (signal) =>
              gateway.chat(provider, {
                ...routeTo(model),
                messages,
                tools: [],
                serverTools: webPlan.serverTools,
                temperature: 0,
                maxTokens: WEB_SEARCH_MAX_OUTPUT_TOKENS,
                // The judgement in this call is the search engine's, not the model's. Thinking
                // harder about which words to retrieve is the caller's job and it already did it.
                reasoningEffort: 'low',
                // Distinct per call, so two searches in one turn are two requests to the provider
                // rather than one request it believes it has already answered.
                sessionId: sha256(`athanor-task:${task.id}:search:${call.id}`).slice(0, 64),
                signal
              }),
            WEB_SEARCH_REQUEST_TIMEOUT_MS
          )
        );
        // Billed to the task like any other inference, because it is: a search the owner pays for
        // through their model provider should appear against their spend rather than arriving as an
        // unexplained line on the provider's own bill. The ledger row is written wherever this runs;
        // the turn's own credit counter is charged where there is a turn, which a specialist's
        // searches are not - their bound is the sixteen steps a mission gets, not a credit total.
        const credit = usageCredit(model, response.usage.inputTokens, response.usage.outputTokens);
        if (state) state.credits += credit;
        await this.store
          .recordUsage({
            userId: task.userId,
            workspaceId: task.workspaceId,
            taskId: task.id,
            kind: 'model_inference',
            resourceClass: model.usageClass,
            quantity: response.usage.totalTokens,
            unit: 'tokens',
            credits: credit,
            costUsd:
              response.usage.costUsd ??
              estimatedInferenceCostUsd(
                model,
                response.usage.inputTokens,
                response.usage.outputTokens,
                response.usage
              ),
            state: 'settled',
            idempotencyKey: `web-search:${task.id}:${call.id}`,
            providerRef: `${response.metadata.provider}:${response.metadata.model}`
          })
          // The results are already retrieved and the owner asked for them. Losing the ledger row is
          // worth telling the timeline about, not worth throwing the search away over.
          .catch(() => undefined);
        return response;
      }
    });
  }

  /**
   * One tool call, run through the dispatch table in `tool-dispatch.ts`.
   *
   * Kept as a three-line method rather than dissolved into its five call sites so that the loop
   * still reads the way it read before the arms moved out, and so that the context is assembled in
   * one place instead of five. Everything it does is name what an arm may reach for: the four bound
   * functions are the only things left in this class that an arm still needs.
   */
  #execute(
    task: TaskRecord,
    call: ModelToolCall,
    key: Uint8Array,
    consequentialApproved: boolean,
    webPlan: WebToolPlan,
    state: AgentState
  ): Promise<unknown> {
    return executeToolCall(
      {
        store: this.store,
        config: this.config,
        runner: this.#runner,
        masterKey: this.#masterKey,
        task,
        key,
        consequentialApproved,
        webPlan,
        state,
        inferenceCredential: (forTask) => this.#inferenceCredential(forTask),
        providerWebSearch: (forTask, forCall, plan, forState) =>
          this.#providerWebSearch(forTask, forCall, plan, forState),
        missingBinaries: (forTask, binaries) => this.#missingBinaries(forTask, binaries),
        destinationContext: (forState) => this.#destinationContext(forState),
        gateway: (forTask, forModel) => this.#gateway(forTask, forModel),
        assertProviderConfigured: (forTask) => this.#assertProviderConfigured(forTask)
      },
      call
    );
  }

  /**
   * One evaluation per call per state of the world. @see approvalForCallOnce in
   * `approval-floor.ts`, where the floor and its memo moved in Wave 7.2.
   *
   * Every site in the loop asks through here rather than through `approvalForCall` directly, which
   * is what #80's repair amounts to: the first call of a candidate parallel run used to be put to
   * the floor twice - once while deciding whether the batch could run together and once while
   * running it - and a floor that reads the task's spend and the turn's taint is not free to ask
   * twice. `approvalForCall` is still exported for the sibling that owns it and for its own tests;
   * nothing in this class reaches it any more, so the class no longer keeps a wrapper for it.
   */
  async #approvalForCallOnce(
    memo: ApprovalFloorMemo,
    task: TaskRecord,
    call: ModelToolCall,
    state?: AgentState
  ): Promise<AgentApprovalRequirement | null> {
    return approvalForCallOnce(this.#approvalFloor, memo, task, call, state);
  }

  /** @see compactTurnContext in `compaction.ts`, where this moved in Wave 7.2. */
  async #compactContext(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    input: {
      model: ModelRelease;
      catalog: ModelRelease[];
      maxOutputTokens: number;
      reservedTokens: number;
      trigger: 'budget' | 'agent';
      turn: number;
      note?: string;
      contextTokensLimit?: number;
    }
  ): Promise<CompactionOutcome | null> {
    return compactTurnContext(this.#compaction, task, key, state, input);
  }

  /**
   * @see runAcceptanceChecks in `acceptance-runner.ts`, where this moved in Wave 7.2 with the
   * memo that stops the suite running twice on a completing turn and the deadline that stops eight
   * checks composing into two hours.
   */
  async #runAcceptanceChecks(
    task: TaskRecord,
    key: Uint8Array,
    record: AcceptanceRecord,
    options: {
      purpose: 'finish' | 'baseline' | 'continuation';
      observed?: ReadonlyMap<string, number>;
    } = { purpose: 'finish' },
    state?: AgentState
  ): Promise<AcceptanceResult[]> {
    return runAcceptanceChecks(this.#acceptanceRunner, task, key, record, options, state);
  }

  /** @see raiseTaint in `tool-recording.ts`, where this moved in Wave 7.2. */
  async #raiseTaint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    origin: string | null,
    tool: string
  ): Promise<string | null> {
    return raiseTaint(this.#toolRecording, task, key, state, origin, tool);
  }

  /**
   * Recording and, when the result carried a picture, the routing that decides who reads it.
   *
   * Both halves moved out in Wave 7.2 and are sequenced here rather than nested, so `vision.ts` can
   * import `event` from `tool-recording.ts` without the two files importing each other.
   */
  async #recordToolResult(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    result: unknown,
    leadModel: ModelRelease,
    catalog: ModelRelease[]
  ): Promise<void> {
    const image = await recordToolResult(this.#toolRecording, task, key, state, call, result);
    if (!image) return;
    await routeImageObservation(this.#vision, task, key, state, call, image, leadModel, catalog);
  }

  /** @see captureMemory in `memory-capture.ts`, where this moved in Wave 7.2. */
  async #captureMemory(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      verification: CompletionVerification;
      interrupted?: boolean;
      verifiedCommands?: readonly AcceptanceCommandCheck[];
    },
    deadEnds: readonly MemoryDeadEndCheck[] = []
  ): Promise<void> {
    await captureMemory(this.#memoryCapture, task, key, state, completion, deadEnds);
  }

  async #completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      deliverables?: unknown[];
      verification: CompletionVerification;
      /** Present, and true, only on a turn the harness stopped rather than the model. */
      interrupted?: boolean;
      /** What is still open, for the turn that resumes this one. */
      outstanding?: string[];
      /** What the harness itself ran and observed, when the turn declared an acceptance record. */
      acceptance?: string[];
      /** The commands among those that passed, which the memory keeps as procedures. */
      verifiedCommands?: readonly AcceptanceCommandCheck[];
    },
    options: {
      label?: string;
      /**
       * The commands the harness watched fail on the run that finished this turn. Kept out of
       * `completion` because that object is the completed event's payload, and every one of these
       * is already in it as a remaining risk.
       */
      deadEnds?: readonly MemoryDeadEndCheck[];
    } = {}
  ): Promise<void> {
    sealUnansweredToolCalls(state.messages, 'the agent finished the turn before this call ran');
    // The plan is left exactly as the model last set it.
    //
    // Every ordinary finish used to fetch the active plan and rewrite every step that was not
    // 'skipped' to 'completed', then publish that as a new version with a "completed" event. So an
    // agent that published nine steps, did four, ran out of ideas and called finish left the owner
    // looking at nine of nine - and the completion contract could not catch it, because it checks
    // evidence for one claim rather than coverage of the plan. Coverage is now asked for at the
    // finish gate instead, where the model can still answer it.
    // A turn that never said anything. The model can do all of its work through tools and call
    // finish without once writing in its own voice, and the owner is then left with a Result card
    // and a file - which is what happened to someone who had asked, in the same sentence, for a
    // report and for the gist of it in the reply. The summary is the model's own account of what it
    // did, so it is promoted to the answer rather than a sentence of athanor's being invented here.
    // It costs no extra model turn, and a turn that did reply is untouched.
    if (!state.answered && completion.summary.trim())
      await event(this.store, task, key, 'assistant_message', completion.summary.slice(0, 500), {
        markdown: completion.summary
      }).catch(() => undefined);
    await event(this.store, task, key, 'completed', options.label ?? 'Task completed', completion);
    await this.#captureMemory(task, key, state, completion, options.deadEnds ?? []);
    const turn = state.turn ?? 0;
    await this.store.transitionUsage(
      state.reservationKey ?? reservationUsageKey(task.id, turn),
      'reserved',
      'released'
    );

    await retryTurnHandoff({
      attempt: async () => {
        const queued = await this.store.getNextQueuedTaskMessage(task.id);
        if (!queued)
          return this.store.completeTaskIfNoQueued({
            id: task.id,
            workerId: this.config.WORKER_ID,
            actualComputeCredits: state.credits,
            agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
          });
        if (queued.promptCiphertext.aad !== `task-message:${task.id}`)
          throw new AthanorError(
            'queued_message_context',
            'Queued message encryption context is invalid'
          );
        const prompt = decryptJson<{ prompt: string }>(queued.promptCiphertext, key).prompt;
        const nextTurn = turn + 1;
        const nextState = startTurnState(state as unknown as Record<string, unknown>, {
          prompt,
          turn: nextTurn,
          reservationKey: queued.reservationKey
        }) as unknown as AgentState;
        const promoted = await this.store.promoteQueuedTaskMessage({
          taskId: task.id,
          messageId: queued.id,
          workerId: this.config.WORKER_ID,
          modelId: queued.modelId,
          privacyRoute: queued.privacyRoute,
          additionalComputeCredits: queued.maxComputeCredits,
          agentStateCiphertext: encryptJson(nextState, key, `task-state:${task.id}`),
          userMessageCiphertext: encryptJson({ markdown: prompt }, key, `task-event:${task.id}`),
          statusEventCiphertext: encryptJson(
            { messageId: queued.id, turn: nextTurn },
            key,
            `task-event:${task.id}`
          )
        });
        return promoted !== null;
      },
      stillOwned: async () => {
        const latest = await this.store.getTask(task.userId, task.id);
        if (!latest || ['paused', 'cancelled', 'completed'].includes(latest.status)) return false;
        return this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS);
      },
      sleep: (milliseconds) => delay(milliseconds)
    });
  }

  async run(task: TaskRecord): Promise<void> {
    /*
     * When this worker picked the turn up, which is what the wall-clock ceiling is measured from.
     *
     * A local rather than a field on the agent state, and the difference is the promise being made:
     * this bounds how long one worker may hold one lease without saying anything to the owner, so a
     * resumed turn gets a fresh allowance exactly as a new turn does. Persisting it would bound the
     * conversation instead, which the API's own resume contract does not.
     */
    const turnStartedAt = Date.now();
    const workspace = await this.store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey) throw new Error('Workspace key not found');
    const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
    const prompt = decryptJson<{ prompt: string }>(task.promptCiphertext, key);
    const catalog = (await this.store.listModels()) as unknown as ModelRelease[];
    const model = catalog.find((entry) => entry.id === task.modelId);
    if (!model) throw new Error(`Model ${task.modelId} is no longer in the registry`);
    const { gateway, provider, credential } = await this.#gateway(task, model);
    // The owner's own day, taken from the spend limits that already store it rather than from a
    // second copy nobody keeps in step. Without it nothing in the prompt says what time it is, and
    // "by Friday", "last month" and a daily 8am brief are all guesses.
    const timeZone = await this.store
      .effectiveSpendLimits(task.userId)
      .then((limits) => limits.timeZone)
      .catch(() => 'UTC');
    const savedState = task.agentStateCiphertext
      ? decryptJson<AgentState>(task.agentStateCiphertext, key)
      : null;
    // Whether anyone is watching changes what the run should say, so it has to be known before the
    // runtime block is written. Probed only when the saved state does not already carry the answer:
    // a task that ran before this field existed pays one indexed row read, once, and then persists.
    const unattended = savedState?.unattended ?? (await this.#startedBySchedule(task, key));
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
      forceInHouse: this.config.AI_FORCE_INHOUSE_WEB,
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
    if (!(await this.store.listConnectors(task.userId)).some((connector) => connector.enabled))
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
    const toolchainSummary = await this.#toolchainSummary(task);
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
    /*
     * Asked before anything is said, which is the whole point of the silent arm.
     *
     * `honorUserControl`'s `disowned` arm stands the run down without narrating it, because two
     * workers explaining themselves on one timeline is worse than one of them leaving quietly. Every
     * other call site sits at a step or tool-batch boundary, so the question was first asked well
     * below here - and the two `event(...)` writes underneath this line went onto the owner's
     * conversation first. A worker whose task had already been resumed by another worker put the
     * web-route disclosure, and on a stale window a warning about the saved context, into a
     * conversation that was not its own any more, and only then discovered it had nothing to do.
     *
     * The named import is used directly because the `honorUserControl` closure below is defined
     * after the preamble is assembled; hoisting the closure instead would move a large block for a
     * one-line question. Same arguments, same three arms, and `state` is the trajectory as loaded -
     * nothing below has touched it yet, so the `paused` arm saves exactly what is on disk.
     *
     * @see preamble-ownership.test.ts, which measures this set from the source and expects it empty.
     */
    if (await honorUserControl_(this.#turnControl, task, key, state)) return;
    // Written down whenever it moves, and only then: the disclosure is what the owner is owed, and
    // repeating it on every resumed turn would bury the step where it actually changed.
    if (state.webToolMode !== webPlan.mode)
      await event(this.store, task, key, 'status', webPlan.disclosure, {
        webSearch: { mode: webPlan.mode, reason: webPlan.reason }
      }).catch(() => undefined);
    state.webToolMode = webPlan.mode;
    // Before the contract is installed, so a window saved when guidance was a separate keyword-
    // selected message does not arrive carrying both it and the contract that now contains it. The
    // set of playbooks that message was chosen from was persisted too, and is re-encrypted with the
    // state on every step until something drops it.
    dropLegacyGuidance(state.messages);
    delete (state as { playbooks?: unknown }).playbooks;
    const { removedDuplicates } = ensureBasePrompt(state.messages);
    if (removedDuplicates)
      // Worth saying out loud: this ran for as long as the marker was stale, and every duplicate
      // sat at the head of the window where it moved the bytes of everything cached behind it.
      await event(
        this.store,
        task,
        key,
        'warning',
        'Removed a duplicated operating contract from this task’s saved context',
        { removedDuplicates }
      ).catch(() => undefined);
    /**
     * The one block in the window that is meant to change, moved to the one place where changing
     * it is free.
     *
     * It used to sit at index 1, immediately behind the operating contract and ahead of the entire
     * trajectory, and it carries the clock. Turns are minutes apart, so the first byte that
     * differed between two consecutive turns' requests was inside this message - and every cache
     * breakpoint the request carries sits behind it. The cached prefix across turns was therefore
     * not merely degraded but zero: a measured 84% cache rate is exactly what a cache that works
     * only within a turn produces. Re-billing one whole window per turn at the 1.25x write tier
     * instead of the 0.1x read tier is roughly half the input bill of a long conversation.
     *
     * At the tail it costs nothing, because the tail is rewritten by the next step anyway - which
     * is why the active plan and the step-budget notice are already pushed here. It has to be
     * re-pushed every STEP, not once per turn: pushed once per turn it would be buried under that
     * turn's tool results, and removing it on the next turn would rewrite everything behind it -
     * the same disease at a new address. Recency also makes it more salient, not less, so the
     * clock can now be fresher than it was and still free.
     */
    const refreshRuntimeContext = (): void =>
      refreshRuntimeContext_(this.#window, {
        workspace,
        task,
        state,
        timeZone,
        toolchainSummary,
        unattended,
        webPlan
      });
    // Called here as well as in the step loop so a window saved when this block lived at index 1
    // is migrated before the preamble blocks below choose where they go.
    refreshRuntimeContext();
    // The preamble: the two frozen blocks, the recalled pack and the workspace brief, in the order
    // a provider's cache charges for. @see assemblePreamble in `window.ts`.
    await assemblePreamble(this.#window, {
      task,
      key,
      state,
      goal: prompt.prompt,
      contextTokens: model.contextTokens
    });
    const turn = state.turn ?? 0;

    /** @see refreshActivePlan in `window.ts`, where this moved in Wave 7.2. */
    const refreshActivePlan = async (createFallback = false): Promise<boolean> =>
      refreshActivePlan_(this.#window, task, key, state, createFallback);

    // Deliberately not `true` here. The generic three-step plan used to be created before the first
    // model call on every task, so a request for a haiku arrived with "Inspect the request, inputs,
    // and current workspace state" already in progress, the model spent a set_plan call rewriting a
    // plan it never needed, and the user watched a Plan pane fill with boilerplate. The fallback
    // now waits until the task has actually changed something or run past its second step - the
    // cases where a visible plan is what the user wants.
    await refreshActivePlan(state.mutated === true || state.step >= 2);

    /** @see drainCorrection in `turn-control.ts`, where this moved in Wave 7.2. */
    const drainCorrection = async (): Promise<boolean> =>
      drainCorrection_(this.#turnControl, task, key, state);

    /**
     * @see honorUserControl in `turn-control.ts`, where this moved in Wave 7.2 and gained the
     * ownership arm: it can now see a task that was resumed out from under this worker, which is
     * the half of the question that only `haltReason` was asking.
     */
    const honorUserControl = async (): Promise<boolean> =>
      honorUserControl_(this.#turnControl, task, key, state);

    // A state saved partway through a tool batch is the one shape that can arrive here with calls
    // still unanswered. An awaiting-approval state is not: its own call is answered by the approval
    // outcome below, and the calls behind it were deferred in writing when it was saved.
    const interrupted = state.inFlight;
    delete state.inFlight;
    if (interrupted && unansweredToolCallIds(state.messages).includes(interrupted.toolCallId))
      // Whether that call reached the outside world cannot be known from here: the process died
      // between the action and its result. Re-running it is how one restart becomes two emails, so
      // the doubt goes to the model as the call's own result and the model has to check first.
      state.messages.push({
        role: 'tool',
        toolCallId: interrupted.toolCallId,
        content: `Interrupted: this ${interrupted.tool} call was still running when the worker restarted, so it may have taken effect and it may not have. Do not run it again until you have established which - read the file back, list the connected service's own record, or re-observe the page - and state what you found before you act.`
      });
    const stranded = state.pending
      ? []
      : sealUnansweredToolCalls(state.messages, 'the worker restarted before this call ran');
    if (interrupted || stranded.length) {
      // The next model call is a fresh step. Counting it keeps a worker that dies at the same call
      // every time bounded by the step budget instead of resuming into it forever.
      state.step += 1;
      await event(
        this.store,
        task,
        key,
        'warning',
        interrupted
          ? `${interrupted.tool} was interrupted by a restart and was not repeated automatically`
          : 'A restart interrupted this step, so the calls that had not started were dropped',
        {
          ...(interrupted
            ? {
                toolCallId: interrupted.toolCallId,
                tool: interrupted.tool,
                startedAt: interrupted.startedAt
              }
            : {}),
          dropped: stranded
        }
      );
    }

    if (state.pending) {
      const approval = await this.store.getApproval(state.pending.approvalId);
      const outcome = approvalOutcome(approval);
      if (outcome === 'waiting') {
        await this.store.updateTask({
          id: task.id,
          workerId: this.config.WORKER_ID,
          status: 'awaiting_user',
          clearLease: true
        });
        return;
      }
      const { approvalId, toolCall: call, handoffOnly } = state.pending;
      // Dropped before the pause check below so a paused resume seals this call once instead of
      // executing it a second time when the task is picked back up.
      delete state.pending;
      const approvalCoversCall =
        outcome === 'approved' &&
        approvalArgumentsMatch(textValue(approval?.previewHash), key, call.name, call.arguments);
      if (outcome === 'approved' && !approvalCoversCall) {
        // The user approved a specific action, so a different one must not inherit that decision.
        await event(
          this.store,
          task,
          key,
          'warning',
          'Refused: this action no longer matches what was approved',
          // Addressed to the owner: they answered a question about one action and a different one
          // was attempted under that answer. Nothing else in the conversation says so.
          { owner: true, approvalId, tool: call.name }
        );
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Refused: the arguments for ${call.name} no longer match the ones the user approved, so the approval does not cover this call. Request approval again for the exact action you intend to run.`
        });
        state.turnToolResults ??= {};
        state.turnToolResults[call.id] = { name: call.name, success: false };
      } else if (approvalCoversCall) {
        await event(this.store, task, key, 'approval_resolved', 'Approved action resumed', {
          approvalId,
          decision: 'approved'
        });
        if (handoffOnly) {
          state.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `The user completed or reviewed the secure ${call.name === 'desktop_action' ? 'computer' : 'browser'} handoff. Observe the current state before continuing. Never request or replay the private value.`
          });
        } else if (await honorUserControl()) {
          return;
        } else {
          // An approved call can be the first thing this turn that touches the computer - the turn
          // paused before it ran - so the undo point is taken here too, not only in the loop below.
          await this.#ensureTurnUndoPoint(task, key, state, call.name);
          // This is the one call the owner explicitly authorised, so it is also the one a restart
          // must never run twice. Persisting the intent here is what drops the now-answered
          // `pending` record as well: without it a worker killed here resumed with the approval
          // still pending and executed the approved action a second time.
          state.inFlight = {
            toolCallId: call.id,
            tool: call.name,
            startedAt: new Date().toISOString()
          };
          await this.#checkpoint(task, key, state);
          try {
            // Watched exactly as the loop's own dispatch is. This is the one call the owner was
            // asked about by name, so it is the one where Stop has most reason to work - and it was
            // the one path without a watch: an approved `shell` runs to the runner's own ceiling,
            // `startStopWatch` only guards model calls, and `honorUserControl` is checked at step
            // boundaries this resume happens before. The interface said stopped while the approved
            // command kept running.
            const result = await this.#withLeaseRenewal(task, () =>
              this.#withCancellationWatch(task, () =>
                this.#execute(task, call, key, true, webPlan, state)
              )
            );
            await this.#recordToolResult(task, key, state, call, result, model, catalog);
          } catch (error) {
            await this.#recordToolFailure(task, key, state, call, error);
          }
          delete state.inFlight;
          await this.#checkpoint(task, key, state);
        }
      } else if (outcome === 'expired') {
        // An unanswered request is a denial once it times out. Resuming the task is what releases
        // its compute reservation, so leaving it in awaiting_user would hold that reservation for
        // as long as the row lives.
        await event(
          this.store,
          task,
          key,
          'approval_resolved',
          'Approval request expired without an answer, so the action was not run',
          { approvalId, decision: 'expired', tool: call.name }
        );
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `This ${call.name} request expired before the user answered it and was not run. Treat it as denied: continue with what you can do safely without it, and finish by stating clearly what still needs the user's decision.`
        });
        state.turnToolResults ??= {};
        state.turnToolResults[call.id] = { name: call.name, success: false };
      } else {
        await event(this.store, task, key, 'approval_resolved', 'Action was not approved', {
          approvalId,
          decision: textValue(approval?.status, 'denied')
        });
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `The user ${textValue(approval?.status, 'denied')} this action. Continue safely without it.`
        });
      }
    }

    /*
     * The answer to a parked question, taken back into the turn that asked it.
     *
     * A question is answered by the owner writing, and a message sent to a conversation the agent
     * still holds is queued rather than started - so this is the same move `drainCorrection` makes
     * mid-turn, at the one point where waiting for it is the whole state of the machine. Keeping the
     * turn is the point: everything the agent had already established is still in the window, and
     * the alternative - ending the turn and starting a fresh one on the reply - throws away the
     * context that made the question worth asking.
     *
     * `interrupt` is not required here, as it is for a correction. There the distinction earns its
     * keep, because "do this next" and "no, not that" are different intentions and timing alone
     * cannot tell them apart; here the agent has stopped and said what it is waiting for, so the
     * next thing the owner writes is the answer by construction.
     *
     * With nothing queued the conversation is parked again exactly as it was, mirroring the pending
     * approval that is still waiting above. That is what makes a re-lease from any direction - a
     * worker restart, a sweep, an owner resuming - safe: the machine returns to waiting rather than
     * carrying on as though it had been answered.
     */
    if (state.question) {
      const asked = state.question;
      const waiting = await this.store.getNextQueuedTaskMessage(task.id).catch(() => null);
      const answer = waiting
        ? decryptJson<{ prompt: string }>(waiting.promptCiphertext, key).prompt.trim()
        : '';
      const consumed =
        waiting && answer
          ? await this.store.consumeQueuedTaskMessageInTurn({
              taskId: task.id,
              messageId: waiting.id,
              workerId: this.config.WORKER_ID,
              // The reply reserved credits of its own, and the turn it is rejoining was budgeted
              // before they existed - without this the loop trips its own ceiling immediately.
              additionalComputeCredits: waiting.maxComputeCredits,
              ...(waiting.maxSpendUsd === null ? {} : { additionalSpendUsd: waiting.maxSpendUsd }),
              userMessageCiphertext: encryptJson({ markdown: answer }, key, `task-event:${task.id}`)
            })
          : false;
      if (!consumed) {
        await this.store.updateTask({
          id: task.id,
          workerId: this.config.WORKER_ID,
          status: 'awaiting_user',
          clearLease: true
        });
        return;
      }
      delete state.question;
      // Their words, unaltered and in their own role: the answer is owner speech everywhere it
      // matters - the taint model, the compaction rule that never paraphrases what the user said,
      // and the transcript. The question it answers is one message above it in the window.
      state.messages.push({ role: 'user', content: answer });
      // Written before anything else can fail, so a crash here loses neither the answer nor the
      // fact that it has already been taken out of the queue.
      await this.#checkpoint(task, key, state);
      await event(this.store, task, key, 'status', 'Answered - carrying on', {
        question: asked.question
      });
    }

    if (await honorUserControl()) return;
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: 'running'
    });
    if (state.step === 0)
      await event(this.store, task, key, 'status', 'Agent started work', {
        model: model.displayName,
        provider,
        maxSteps: this.config.TASK_MAX_STEPS,
        contextPolicy: 'one operating contract, bounded tool output, and a condensed running brief',
        contextWindowTokens: model.contextTokens
      });

    /*
     * The step ceiling, asked rather than fixed.
     *
     * The first clause is the budget as it has always been. The second is the only thing that can
     * move it: at the ceiling, and nowhere else, the harness runs the acceptance record the model
     * declared before the work and grants another budget when the job is demonstrably unfinished and
     * demonstrably still moving. It raises `selfContinuations`, which raises the first clause, so the
     * loop cannot spin here - each renewal is one whole budget of progress and there are at most
     * `TASK_MAX_SELF_CONTINUATIONS` of them.
     */
    for (
      ;
      state.step < this.#stepCeiling(state) || (await this.#renewStepBudget(task, key, state));
      state.step += 1
    ) {
      if (await honorUserControl()) return;
      // Before the plan is refreshed, so a correction that changes the goal is in the window when
      // the plan is read rather than one step behind it.
      await drainCorrection();
      await refreshActivePlan(state.mutated === true || state.step >= 2);
      await this.#noteStepBudget(task, key, state, this.#stepCeiling(state));
      // Last of the tail blocks, and re-pushed on every step rather than once per turn: a block
      // left where the next step's tool results bury it stops being free to change. At a step
      // boundary every tool call has been answered, so nothing here can split a call from its
      // result.
      refreshRuntimeContext();
      /*
       * The third ceiling, checked where the other two are and priced the same way.
       *
       * Nothing in the product bounded a turn on the clock. Steps, self-continuations, compute
       * credits and the owner's spend caps were the whole of it, and the per-unit ceilings compose
       * rather than cap - six idle steps of generation is an hour, a hundred and twenty steps of
       * tool time is days. On a frontier model the credit ceiling bites first, which is why this
       * has been a residual rather than an open runaway; on a cheap local route credits accumulate
       * slowly and the wall clock does not, and that is the case nothing was watching.
       *
       * `credits` is checked in front of it deliberately: when both ceilings are reached the money
       * is the one the owner can do something about, and it is the sentence they should be given.
       */
      if (turnWallClockReached(turnStartedAt)) {
        if (await honorUserControl()) return;
        await this.#handOffAtStepLimit(task, key, state, {
          gateway,
          provider,
          model,
          catalog,
          turn,
          maxOutputTokens: Math.min(16_384, Math.max(2_048, Math.floor(model.contextTokens * 0.2))),
          tools: requestTools,
          webPlan,
          reason: 'time'
        }).catch(async (error: unknown) => {
          // The same two-line insurance the credit ceiling carries: a provider that is down for the
          // closing call must not also cost the record of where the work stopped.
          const outstanding = await this.#outstandingPlanSteps(task, key).catch(() => []);
          state.messages.push({
            role: 'system',
            content: stepLimitCarryOver(state.step, outstanding)
          });
          await this.store
            .updateTask({
              id: task.id,
              workerId: this.config.WORKER_ID,
              status: 'running',
              actualComputeCredits: state.credits,
              agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
            })
            .catch(() => undefined);
          throw new AthanorError(
            'task_budget_reached',
            `This turn ran for its whole time budget, and the closing handoff could not be written either (${error instanceof Error ? error.message : 'unknown error'}).${
              outstanding.length ? ` Still open: ${outstanding.slice(0, 3).join('; ')}.` : ''
            } Everything it produced is saved - reply to carry on from where it stopped.`
          );
        });
        return;
      }
      if (state.credits >= task.maxComputeCredits) {
        // The same closing call the step ceiling gets. A turn that stops because it ran out of
        // money has exactly as much to hand over as one that ran out of steps, and the owner is
        // owed the same thing: what was done, what is left, and that a reply carries on.
        if (await honorUserControl()) return;
        await this.#handOffAtStepLimit(task, key, state, {
          gateway,
          provider,
          model,
          catalog,
          turn,
          maxOutputTokens: Math.min(16_384, Math.max(2_048, Math.floor(model.contextTokens * 0.2))),
          tools: requestTools,
          webPlan,
          reason: 'credits'
        }).catch(async (error: unknown) => {
          // The handoff is one model call, and a provider that is down for it must not also cost
          // the record of where the work stopped: the carry-over is persisted either way.
          const outstanding = await this.#outstandingPlanSteps(task, key).catch(() => []);
          state.messages.push({
            role: 'system',
            content: stepLimitCarryOver(state.step, outstanding)
          });
          await this.store
            .updateTask({
              id: task.id,
              workerId: this.config.WORKER_ID,
              status: 'running',
              actualComputeCredits: state.credits,
              agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
            })
            .catch(() => undefined);
          throw new AthanorError(
            'task_budget_reached',
            `This turn used its whole compute budget, and the closing handoff could not be written either (${error instanceof Error ? error.message : 'unknown error'}).${
              outstanding.length ? ` Still open: ${outstanding.slice(0, 3).join('; ')}.` : ''
            } Everything it produced is saved - reply to carry on from where it stopped.`
          );
        });
        return;
      }
      if (await this.#haltIfOutOfMoney(task, key, state)) return;
      // Cleared here, after the guard that reads it and before the calls that fill it. A step is
      // whatever this iteration spends - the lead call plus any specialist, compaction or search
      // that runs inside it - and each of those used to overwrite this rather than add to it, so
      // the guard was quoted the price of whichever happened to bill last.
      state.lastStepUsd = 0;
      const maxOutputTokens = Math.min(
        16_384,
        Math.max(2_048, Math.floor(model.contextTokens * 0.2))
      );
      // Said once, before the first request rather than after the provider refuses it. A window
      // that cannot hold the catalogue and still leave room to work is a fact about the model the
      // owner chose, and it is answerable - pick another one - but only if they are told.
      const shortfall = contextShortfall(model.contextTokens, maxOutputTokens, reservedTokens);
      if (shortfall > 0)
        throw new AthanorError(
          'model_context_too_small',
          `${model.displayName} has a ${model.contextTokens.toLocaleString()}-token window, and every request already carries about ${reservedTokens.toLocaleString()} tokens of tools before your first word. It is short by roughly ${shortfall.toLocaleString()} tokens, so this task cannot run on it - choose a model with a larger window.`
        );
      // Condensed before the window is prepared, not while preparing it: compaction is a durable
      // edit to the persisted trajectory, so the request that follows it - and every request until
      // the next one - only appends to a prefix the provider has already cached.
      if (
        // The size the last request actually had, not the size of the untrimmed trajectory. On the
        // first step of a turn there is no previous request, so the raw estimate stands in - it is
        // the conservative direction, and one early compaction is cheaper than one refused request.
        (state.preparedInputTokens ?? estimatedContextTokens(state.messages)) >
        compactionTrigger(modelInputBudget(model.contextTokens, maxOutputTokens, reservedTokens))
      ) {
        const compacted = await this.#compactContext(task, key, state, {
          model,
          catalog,
          maxOutputTokens,
          reservedTokens,
          trigger: 'budget',
          turn
        });
        if (compacted) await refreshActivePlan();
      }
      const preparedContext = prepareModelContext(
        state.messages,
        model.contextTokens,
        maxOutputTokens,
        {
          precedingTokens: reservedTokens,
          reservedTokens,
          ...(state.toolOutputFloor === undefined ? {} : { toolOutputFloor: state.toolOutputFloor })
        }
      );
      state.toolOutputFloor = preparedContext.olderToolOutputChars;
      state.preparedInputTokens = preparedContext.estimatedInputTokens;
      const reasoningEffort = reasoningEffortForStep({
        ...state,
        estimatedInputTokens: preparedContext.estimatedInputTokens,
        inputBudgetTokens: modelInputBudget(model.contextTokens, maxOutputTokens, reservedTokens)
      });
      // The ratchet, recorded rather than recomputed: once a turn has become the kind of turn that
      // needs the full budget it does not stop being one, and pinning the field is also what keeps
      // the provider's cached trajectory from being discarded on the next flip. The opening step is
      // deliberately excluded - it is high because it is the opening step, not because the work is
      // hard, and letting it set the floor would make every task high for its whole length. A tool
      // that threw is excluded for the same reason: it raises this step and not the turn.
      if (state.step > 0 && reasoningEffort === 'high' && effortFloorEarned(state))
        state.reasoningFloor = 'high';
      await this.#assertProviderConfigured(task);
      const streamFlusher = createStreamFlusher();
      let streamEvents = Promise.resolve();
      /*
       * Whose timeline the frames below are landing on.
       *
       * `disowned` means another claimant is already running this task, and every row this run
       * writes from that moment on lands in the middle of *their* trajectory - a paragraph from a
       * generation nobody is watching, spliced into one somebody is. The halt branch below already
       * refuses to bill or to write closing state on that arm for exactly this reason; the frame
       * channel did not, and it is the loudest of the three. It cannot be retrospective - the watch
       * polls, so the deltas written before it noticed have already landed - but from the moment it
       * is known, this run stops writing on somebody else's page.
       *
       * `stopped` is the opposite case and is deliberately left alone: that is the owner's own Stop,
       * on their own conversation, and the words they watched being written are theirs to keep.
       */
      const disowned = (): boolean => stopWatch.halt === 'disowned';
      /*
       * One lost frame is not a lost turn.
       *
       * `await streamEvents` sits above the billing block, so a single failed insert among several
       * hundred delta rows - pglite under contention, a Postgres failover - used to reject there
       * and kill a turn the owner had already watched succeed on screen, taking the ledger row for
       * a model call the provider had already charged for with it. The frames are the least
       * durable thing in this file by design: they are superseded by the assistant message that
       * closes the turn, so losing one costs a fragment of a paragraph that is about to be written
       * again in full. The reasoning channel beside this has been swallowing its own failures for
       * exactly this reason; the answer channel was the one that did not.
       *
       * It is not silent. `droppedFrames` is counted and said once per turn, because a frame
       * channel that has started failing is worth knowing about even though it is not worth
       * failing for.
       */
      let droppedFrames = 0;
      const noteDroppedFrames = async (): Promise<void> => {
        if (!droppedFrames || state.frameLossNoted) return;
        state.frameLossNoted = true;
        await event(
          this.store,
          task,
          key,
          'warning',
          'Some of the reply arrived on screen but could not be written to the transcript',
          { count: droppedFrames }
        ).catch(() => undefined);
      };
      const emitStreamFrame = (frame: string): void => {
        if (disowned()) return;
        streamEvents = streamEvents.then(async () => {
          // Checked again inside the queue as well as at the door: the frames are written one at a
          // time behind an awaited chain, so a halt that lands while three are queued would
          // otherwise still write all three.
          if (disowned()) return;
          await event(this.store, task, key, 'assistant_delta', 'Agent response', {
            markdown: frame,
            append: true
          }).catch(() => {
            droppedFrames += 1;
          });
        });
      };
      /**
       * The reasoning, on its own channel and on its own flusher.
       *
       * A high-effort step on a full window routinely thinks for the better part of a minute before
       * the first word of the answer, and the owner was shown a spinner for all of it. The route
       * already produces this and the stream parser already read it; it was accumulated and thrown
       * into the response, arriving all at once after the fact when it was no longer of use.
       *
       * Its own flusher because the two arrive interleaved and sharing one would splice the thinking
       * into the answer.
       */
      const reasoningFlusher = createStreamFlusher(REASONING_FLUSH_INTERVAL_MS);
      const emitReasoningFrame = (frame: string): void => {
        if (disowned()) return;
        streamEvents = streamEvents.then(async () => {
          if (disowned()) return;
          await event(this.store, task, key, 'assistant_reasoning', 'Agent thinking', {
            markdown: frame,
            append: true
          }).catch(() => undefined);
        });
      };
      /**
       * One row for the whole of the thinking, in place of the frames that streamed it.
       *
       * The answer's frames are superseded by the assistant_message that closes the turn; the
       * thinking had no such row, so every frame it ever wrote was kept forever and decrypted again
       * on every reopen of the conversation - and the thinking is routinely the longer of the two.
       * The route accumulated the same text on the way past, so this costs nothing to obtain, and
       * writing it as a replace is what lets the store drop the frames underneath it.
       */
      const emitWholeReasoning = (markdown: string): void => {
        // The worst of the three to write on a disowned run: it is a *replace*, so it does not add
        // a stray paragraph to the other claimant's trajectory, it drops the frames underneath it.
        if (disowned()) return;
        streamEvents = streamEvents.then(async () => {
          if (disowned()) return;
          await event(
            this.store,
            task,
            key,
            'assistant_reasoning',
            'Agent thinking',
            { markdown, replace: true },
            { replacesEarlierFrames: true }
          ).catch(() => undefined);
        });
      };
      // Renewed for the same reason a long tool call is: the lease is two minutes and a
      // high-reasoning turn on a full window routinely runs longer, at which point any other worker
      // polling for work can lease this task and run the identical trajectory a second time.
      /*
       * Stopped the moment it starts looping rather than at the provider's ceiling.
       *
       * A model that answers and then repeats one sentence spends the whole output budget on it -
       * seventeen thousand tokens and a quarter of an hour, twice in one evening, ending in a
       * timeout the owner is shown as a failure. Nothing here was watching the text itself. The
       * check runs on the accumulating tail and aborts this request; the loop below then tells the
       * model what it did, which is a correction it can act on rather than a dead turn.
       */
      let loopedOn = '';
      /**
       * The route's refusal of an oversized window, held for the repair below rather than thrown.
       * A holder rather than a bare `let` for the reason `firstToken` above is one: the assignment
       * happens inside a callback, which the compiler's flow analysis does not follow.
       */
      const refusedWindow: { error?: AthanorError } = {};
      const looping = new AbortController();
      let streamed = '';
      const stopWatch = startStopWatch(() => this.store.taskClaim(task.id), this.config.WORKER_ID);
      const response = await this.#withLeaseRenewal(task, () =>
        withRequestDeadline((signal) =>
          gateway.chat(provider, {
            ...routeTo(model),
            messages: preparedContext.messages,
            // No provider-side tools ride here, on any route. The agent's request offers the model
            // the tools the model calls; the provider's search is spent by `#providerWebSearch`, on
            // a request built for it, when the model calls `web_search`. Sending it alongside would
            // mean the same capability twice - once under a name the model can use and once under a
            // name only the provider can - and which one answered would depend on the model's mood.
            tools: requestTools,
            temperature: 0.2,
            maxTokens: maxOutputTokens,
            reasoningEffort,
            sessionId: sha256(`athanor-task:${task.id}`).slice(0, 64),
            signal: AbortSignal.any([signal, looping.signal, stopWatch.signal]),
            onTextDelta: (delta) => {
              const frame = streamFlusher.push(delta);
              if (frame !== null) emitStreamFrame(frame);
              if (loopedOn) return;
              streamed = (streamed + delta).slice(-4_000);
              const repeat = degenerateRepeat(streamed);
              if (repeat) {
                loopedOn = repeat;
                looping.abort();
              }
            },
            onReasoningDelta: (delta) => {
              const frame = reasoningFlusher.push(delta);
              if (frame !== null) emitReasoningFrame(frame);
            }
          })
        )
      )
        .catch((error: unknown) => {
          /*
           * A window the route will not take, which is the one refusal at this status a caller can
           * do something about. It is repaired below rather than here so the repair happens with
           * the turn's own state in hand, and it is bounded in that state rather than in a local
           * so a resume cannot hand the same refusal a fresh allowance.
           */
          if (
            error instanceof AthanorError &&
            error.code === 'provider_context_overflow' &&
            (state.contextOverflowRepairs ?? 0) < MAX_CONTEXT_OVERFLOW_REPAIRS
          ) {
            refusedWindow.error = error;
            return null;
          }
          // Only the aborts this turn raised itself. Everything else - a deadline, a provider fault
          // - is still the caller's to handle, and is rethrown untouched. The stop is recognised by
          // the watch's own record rather than by the error, because a stop that lands before the
          // response headers reaches here as `provider_unavailable` and would be failed as one.
          if (!loopedOn && !stopWatch.halt) throw error;
          return null;
        })
        .finally(() => stopWatch.stop());
      /*
       * Read off the watch and not off the response, deliberately.
       *
       * The gateway now hands back what a stopped generation had produced rather than throwing, so
       * a Stop that lands after the first token arrives here with a response in hand - and gated on
       * `response === null` this branch stopped firing for exactly the stops it was written for.
       * That is the shape of the last defect this file learnt: a repair to one arm of a branch
       * quietly changed what reached the other.
       */
      if (stopWatch.halt) {
        // The words that had arrived are the owner's - they watched them being written - so the
        // partial frames are flushed rather than dropped. Nothing is added to the window: half a
        // sentence with its tool calls cut off is not a turn a resumed task can carry. On the
        // `disowned` arm they are not the owner's and not this run's to write, and `emitStreamFrame`
        // refuses them; the drains still run so the flushers are left empty either way.
        const stoppedFrame = streamFlusher.drain();
        if (stoppedFrame !== null) emitStreamFrame(stoppedFrame);
        const stoppedReasoning = reasoningFlusher.drain();
        if (stoppedReasoning !== null) emitReasoningFrame(stoppedReasoning);
        await streamEvents.catch(() => undefined);
        // `stopped` is the owner, and honorUserControl is what records the trajectory and says so on
        // the timeline. `disowned` is another claimant already running this task, and there this run
        // ends without writing or saying anything at all - every write it could make would land on
        // somebody else's trajectory, and the unguarded closing write would take their lease with it.
        if (stopWatch.halt === 'stopped') {
          // The tokens were generated and the provider billed them, whoever ended the generation.
          // Only on this arm: a disowned run writing a ledger row would be writing it against a
          // trajectory another claimant is in the middle of.
          if (response)
            await this.#billModelStep(task, key, state, {
              response,
              model,
              preparedContext,
              reservedTokens,
              turn,
              reasoningEffort
            }).catch(() => undefined);
          await honorUserControl();
        }
        return;
      }
      /*
       * The window was refused as too large, so it is condensed to the size the route named and the
       * step is sent again.
       *
       * The same property the signed-reasoning refusal has: the identical bytes are refused
       * identically for ever, and a refused request appends nothing, so the window never advances
       * past the message that overflowed it. Before this, a resumed task rebuilt the same window,
       * sent the same request and died at the same step for as long as the owner kept replying.
       */
      if (refusedWindow.error) {
        state.contextOverflowRepairs = (state.contextOverflowRepairs ?? 0) + 1;
        await streamEvents.catch(() => undefined);
        const limit = Number(refusedWindow.error.details?.contextLimitTokens);
        await event(
          this.store,
          task,
          key,
          'warning',
          `${model.displayName} refused this conversation as too large for it, so earlier work was condensed and the step was sent again`,
          {
            code: refusedWindow.error.code,
            ...(Number.isFinite(limit) ? { contextLimitTokens: limit } : {}),
            attempt: state.contextOverflowRepairs
          }
        );
        const compacted = await this.#compactContext(task, key, state, {
          model,
          catalog,
          maxOutputTokens,
          reservedTokens,
          trigger: 'budget',
          turn,
          ...(Number.isFinite(limit) && limit > 0 ? { contextTokensLimit: limit } : {})
        });
        if (compacted) await refreshActivePlan();
        // The estimate the next iteration's compaction trigger reads. Left at the number that was
        // just refused, the trigger would fire again immediately on a window that has already been
        // condensed; left at the pre-compaction estimate it would not fire when it should.
        state.preparedInputTokens = estimatedContextTokens(state.messages);
        continue;
      }
      // The repetition watch fired before a single character came back - a repeat detected in the
      // reasoning channel, or an abort that landed before the response headers. There is nothing to
      // bill and nothing to supersede; the model is told what it did and the turn carries on. The
      // ordinary case, where the repeat is exactly what was generated, arrives with a response and
      // is handled after the billing block, because those tokens were spent.
      if (response === null) {
        const finalLoopFrame = streamFlusher.drain();
        if (finalLoopFrame !== null) emitStreamFrame(finalLoopFrame);
        await streamEvents;
        await noteDroppedFrames();
        await this.#noteRepeatingAnswer(task, key, state, loopedOn);
        continue;
      }
      const finalFrame = streamFlusher.drain();
      if (finalFrame !== null) emitStreamFrame(finalFrame);
      const finalReasoning = reasoningFlusher.drain();
      // A route that streamed thinking but reports none back keeps the frame path, because dropping
      // the tail there would lose the last of the thinking rather than consolidate it.
      if (response.reasoning) emitWholeReasoning(response.reasoning);
      else if (finalReasoning !== null) emitReasoningFrame(finalReasoning);
      await streamEvents;
      await noteDroppedFrames();
      await this.#billModelStep(task, key, state, {
        response,
        model,
        preparedContext,
        reservedTokens,
        turn,
        reasoningEffort
      });
      /*
       * The repeat, now that it has been paid for.
       *
       * This sits after the billing block and not before it, which is the whole of the repair: the
       * abort used to `continue` from above the block, so the one generation the box stops on
       * purpose was the one generation that cost $0.00 on the ledger and left `lastStepUsd` at the
       * previous step's figure - the number the spend guard prices the next step from.
       *
       * The words are not added to the window. Half a reply and four hundred copies of one sentence
       * is not a turn a later request can carry, and the model is told what it did instead. They are
       * published once, as the row that supersedes the delta frames the owner watched arrive: those
       * frames are otherwise kept and decrypted again on every reopen of the conversation, because
       * nothing else in this path ever writes the assistant message that replaces them.
       */
      if (loopedOn) {
        const repeated = normalizeAssistantText(response.text);
        if (repeated)
          await event(
            this.store,
            task,
            key,
            'assistant_message',
            repeated.slice(0, 500),
            { markdown: repeated },
            { replacesEarlierFrames: true }
          ).catch(() => undefined);
        await this.#noteRepeatingAnswer(task, key, state, loopedOn);
        continue;
      }
      // What the provider fetched on the model's behalf, which arrives inside the response rather
      // than through a tool result and would otherwise cross the boundary unlabelled. The notice
      // goes in ahead of the assistant message rather than after it: an assistant message carrying
      // tool calls has to be followed immediately by their results, so the only position that is
      // shape-safe on every step is in front of the turn the content arrived in.
      const providerWeb = providerWebProvenance(response);
      for (const url of providerWeb.urls)
        state.knownOrigins = rememberOrigin(state.knownOrigins ?? [], url);
      const providerWebNotice = await this.#raiseTaint(
        task,
        key,
        state,
        providerWeb.origin,
        'provider_web'
      );
      if (providerWebNotice) state.messages.push({ role: 'system', content: providerWebNotice });
      const assistantText = normalizeAssistantText(response.text);
      state.messages.push({
        role: 'assistant',
        content: assistantText,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.reasoningDetails?.length
          ? { reasoningDetails: response.reasoningDetails }
          : {}),
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {})
      });
      /*
       * A step the harness asked for is not a new answer to the owner.
       *
       * Five paths refuse a finish and send the model round again - the finish rejection, the plan
       * hold, the acceptance hold, an acceptance check that failed, and the completion nag. Its
       * natural reply to "finish rejected, cite something newer" is to restate the answer with an
       * apology, and every one of those restatements used to become another bubble. That is why one
       * answer arrived in pieces, and eleven of those rounds in the worst case is most of where a
       * small task's tokens went. The prose still goes into the window - the model needs its own
       * words back - it simply is not published as a fresh reply.
       */
      if (assistantText && !state.repairStep) {
        state.answered = true;
        await event(this.store, task, key, 'assistant_message', assistantText.slice(0, 500), {
          markdown: assistantText
        });
      }
      // Cleared as soon as the model does something other than ask to finish again, so an ordinary
      // step following a repair speaks normally.
      if (state.repairStep && response.toolCalls.some((call) => call.name !== 'finish'))
        state.repairStep = false;
      if (await honorUserControl()) return;

      /*
       * Why the answer stops where it does, when it was this side that stopped it.
       *
       * A generation that went quiet, ran past its deadline or wrote past its ceiling is ended
       * here rather than by the model, and what had arrived is kept. The owner is reading half an
       * answer either way; without this they are reading half an answer that presents itself as a
       * whole one, and the only clue is that it ends mid-sentence.
       *
       * It deliberately does not continue. The gateway has already asked whether carrying on could
       * finish this answer - it watched the rate the words arrived at - and written the verdict
       * into the finish reason: worth continuing arrives as `length` and is continued by the branch
       * below, and everything else arrives as `stop` and falls through to the completion check,
       * which is bounded and ends the turn by completing it. Asking again from here would buy back
       * the ten-minutes-at-a-time this was all built to stop.
       *
       * Only where the step ended in prose. A cut-off step that still assembled a tool call has to
       * be followed immediately by that call's result, so a system message wedged in between would
       * make the next request malformed; that shape is answered by the truncated-arguments path.
       */
      if (response.truncated && response.finishReason !== 'length' && !response.toolCalls.length) {
        await event(this.store, task, key, 'warning', 'The answer was cut off before it finished', {
          owner: true,
          reason: response.truncated.reason,
          detail: response.truncated.detail,
          characters: assistantText.length
        });
        state.messages.push({
          role: 'system',
          content: `YOUR REPLY WAS CUT OFF: ${response.truncated.detail}. The user has already read what you wrote, so do not repeat or summarise it. Either do one concrete thing that moves the work on, or close in a sentence and call finish.`
        });
      }

      // A reply that stopped at the provider's output ceiling is half a sentence, and it used to be
      // committed as if it were the whole answer: the task completed, the Result card said the work
      // was ready, and the owner's only recourse was to type "continue" and pay for the whole
      // window again. The gateway has always distinguished this from a real stop; the loop simply
      // never read it. Continuing here costs one step and keeps the answer one answer.
      if (response.finishReason === 'length' && !response.toolCalls.length) {
        const truncations = (state.truncatedReplies ?? 0) + 1;
        state.truncatedReplies = truncations;
        const capped = truncations > MAX_TRUNCATED_CONTINUATIONS;
        await event(
          this.store,
          task,
          key,
          'warning',
          capped
            ? 'The reply reached the model’s output limit again, so it was not continued automatically'
            : 'The reply reached the model’s output limit and is being continued',
          {
            // Only the cap. A reply being continued is the harness doing its job and the owner
            // sees the finished answer either way; a reply that will not be continued any further
            // is an answer they have been handed incomplete.
            ...(capped ? { owner: true } : {}),
            truncated: true,
            characters: assistantText.length,
            continuation: truncations,
            continued: !capped
          }
        );
        state.messages.push({
          role: 'system',
          content: capped
            ? `OUTPUT LIMIT REACHED ${truncations} times in a row. Stop expanding the answer in chat: write what remains to a workspace file, publish it, and reply with a short complete closing message that points at it.`
            : `CONTINUE THE ANSWER (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): your previous reply stopped at the model's output limit, mid-sentence, and the user is looking at it. Carry straight on from where it stopped - do not repeat, restart or summarise what you already wrote. Call finish once the answer is complete.`
        });
        /*
         * Past the cap this deliberately does not continue, and the counter deliberately does not
         * reset.
         *
         * The cap used to change only the wording. Both branches continued, and the reset below was
         * skipped by that continue, so a model that hit the output limit on every reply was told to
         * stop expanding the answer and then asked again, and again, until the step budget ran out:
         * measured at 41 model calls against a ceiling of 40. It bounded nothing.
         *
         * Falling through instead puts the step under the completion nag, which is bounded and ends
         * the turn by *completing* rather than by exhausting it - so the answer the owner has
         * already read stands, with the closing instruction in front of the model. That matters
         * more than it used to: a generation this computer cut short now reports the same finish
         * reason whenever carrying on could still finish it, and each of those costs up to the full
         * generation deadline.
         */
        if (!capped) continue;
      } else state.truncatedReplies = 0;

      if (!response.toolCalls.length) {
        /*
         * The idle count is deliberately not touched here, in either direction.
         *
         * A step that asked for nothing is this branch's, and this branch already bounds it: the
         * nag ends the turn at MAX_COMPLETION_NAGS, and it ends it by *completing* - the answer
         * stands, which is the better of the two outcomes whenever the model has actually answered.
         * Raising the idle count here as well put the same step under two bounds, and the second
         * one ends the turn by stopping it. That is the difference that matters: it made
         * "reasoning, reasoning, then a read I already had" - an ordinary shape in a long debugging
         * turn - the third of the three steps that trigger a break, so a turn was told it had
         * stopped moving on the strength of two steps that never asked for anything.
         *
         * It is not reset either. Prose is not evidence that anything ran, and a turn that alternates
         * a paragraph with a call it already has is exactly what the guard below is for; it simply
         * has to reach its number on the steps that asked and got nothing, which is the only claim
         * that guard makes about itself.
         */
        // Same failure shape as a finish that will not ground itself, and it needs the same bound:
        // a model that answers in prose and never calls the tool used to absorb the entire step
        // budget one nag at a time, then fail with a step-limit error that named nothing.
        const nags = (state.completionNags ?? 0) + 1;
        state.completionNags = nags;
        state.repairStep = true;
        if (nags >= MAX_COMPLETION_NAGS) {
          /*
           * The answer stands; only the paperwork is missing.
           *
           * This used to raise, which marks the task FAILED. Observed: asked what the top story on
           * a news site was, the agent searched, opened the page, and wrote the correct headline
           * with its address and its source - five times, because a reply cut off at the output
           * limit is continued and each continuation is another answer without a finish. Five
           * correct answers, thrown away, reported to the owner as a failure.
           *
           * Not calling the tool is a real thing to record, and it is recorded: the turn completes
           * as interrupted, with what is missing written into the caveats the completion card
           * already shows. The bound stays - it is what stops the step budget going on nagging.
           */
          await event(this.store, task, key, 'warning', 'Answered without calling finish', {
            attempts: nags
          });
          const stillOpen = await this.#outstandingPlanSteps(task, key).catch(() => []);
          await this.#completeTurn(task, key, state, {
            summary:
              assistantText.slice(0, 400) ||
              `Answered after ${state.step} steps without calling finish.`,
            interrupted: true,
            ...(stillOpen.length ? { outstanding: stillOpen } : {}),
            verification: {
              status: 'not_applicable',
              evidence: [],
              remainingRisks: [
                `The agent answered ${nags} times without calling finish, so athanor never checked this against the request. Read the answer before relying on it, or reply to carry on.`
              ]
            }
          });
          return;
        }
        state.messages.push({
          role: 'system',
          content: `COMPLETION CHECK (${nags} of ${MAX_COMPLETION_NAGS}): A response without the finish tool does not complete the task. Verify the outcome, update any work that is still incomplete, then call finish with evidence. If this was only a conversational answer and no tools were used, use verification status not_applicable.`
        });
        await event(this.store, task, key, 'status', 'Checking the result before completion', {
          attempt: nags
        });
        continue;
      }
      state.completionNags = 0;
      // Read before the batch and again after it. Anything in between that starts a tool moves it,
      // and nothing else in the loop can - which is what makes the difference the guard's evidence.
      const startedBeforeBatch = state.toolsStarted ?? 0;
      /*
       * One evaluation of the approval floor per call, per state of the world.
       *
       * The first call of every candidate parallel run was asked about twice: once here while the
       * run is chosen, and again on the sequential path the run falls through to when it collapses
       * to a single call. Nothing between the two asks starts a tool - every gate in between either
       * answers the call and continues or registers an idempotency key - so the second ask could
       * only ever repeat the first, at the price of a destination context built out of forty
       * thousand characters of the owner's own words. Held per model response, and the memo throws
       * its own verdicts away the moment `toolsStarted` moves.
       */
      const approvalMemo = createApprovalFloorMemo();
      // Read the same way and for the same reason: what this step did to the counts is the
      // evidence, not what they stood at when it began.
      const failuresBeforeBatch = state.repeatedFailures;

      // The last index a concurrent run has already answered. Those calls have their results in the
      // window and their events on the timeline; walking into them again would run them twice.
      let answeredByRun = -1;
      for (const [callIndex, call] of response.toolCalls.entries()) {
        if (callIndex <= answeredByRun) continue;
        // Re-checked before every call in the batch, not once before it. A model routinely proposes
        // several actions at a time, and the earlier single check meant a cancel landing after the
        // first one still sent the email, published the artifact and fired the POST - minutes after
        // the interface said the task had stopped. honorUserControl seals the calls that never ran,
        // so the transcript stays answerable if the task is later resumed.
        if (await honorUserControl()) return;
        /*
         * Reads that were proposed together stop queueing behind each other.
         *
         * A frontier model opens a task with four `file_read`s, or a `code_search` beside a
         * `repo_overview`, and each of those is an HTTP round trip to the runner that the next one
         * waited on for no reason - the product had already paid for this parallelism three times
         * over as per-tool workarounds (`parallel_web_read`, the browser_action batch, `delegate`),
         * which is the strongest argument that the loop itself should have it.
         *
         * Only the run's execution overlaps. Every decision around it stays exactly where it was:
         * the stop check above has already run, the floor is asked about each call separately just
         * below, and the results are recorded strictly in the order the model declared them, so the
         * window this produces is the same window the sequential path produced.
         */
        const runLength = parallelToolRun(response.toolCalls, callIndex, state.seenCalls ?? {});
        if (runLength > 1) {
          const run: ModelToolCall[] = [];
          for (const candidate of response.toolCalls.slice(callIndex, callIndex + runLength)) {
            // Per call, never once for the run. A call the floor wants a card for ends the run in
            // front of itself and is left to the sequential path below, which raises the card and
            // defers everything behind it in writing - so the approval order the owner sees is the
            // order the model declared. Every tool in the run is one whose verdict is a pure
            // function of arguments and turn state, so asking early cannot change the answer.
            if (await this.#approvalForCallOnce(approvalMemo, task, candidate, state)) break;
            run.push(candidate);
          }
          if (run.length > 1) {
            await this.#runToolCallsTogether(task, key, state, run, {
              model,
              catalog,
              refreshActivePlan,
              webPlan
            });
            answeredByRun = callIndex + run.length - 1;
            continue;
          }
        }
        // Arguments that did not parse mean the response was cut off mid-JSON at the output cap.
        // Running the call anyway sent an empty object into a tool that then failed on a validation
        // error naming neither the truncation nor the way out of it, and the turn spent its
        // remaining steps re-proposing the same oversized call. It is answered instead, because a
        // tool call with no tool result is a malformed turn the provider will refuse next step.
        // An exact repeat of a read that already answered this turn. Re-running it returns the
        // same bytes and teaches the model nothing, which is how a stuck agent spends a whole step
        // budget looking for something in the same place. It is answered rather than refused: the
        // call still gets a tool result, because a call without one is a malformed window, and the
        // result names the earlier id so the model can cite or re-read that instead.
        if (IDEMPOTENT_WITHIN_TURN.has(call.name)) {
          const callKey = idempotentCallKey(call);
          const earlier = state.seenCalls?.[callKey];
          if (earlier) {
            await this.#recordToolResult(
              task,
              key,
              state,
              call,
              {
                skipped: true,
                reason: `This is the same ${call.name} call as ${earlier}, which already ran this turn and would return the same result. Read that result again, or change the arguments - a different path, different words, a wider search - if it did not answer the question.`
              },
              model,
              catalog
            );
            continue;
          }
        }
        if (call.parseFailed) {
          const truncations = (state.argumentTruncations ?? 0) + 1;
          state.argumentTruncations = truncations;
          const cutOff = call.argumentsTruncated === true;
          await event(
            this.store,
            task,
            key,
            'warning',
            cutOff
              ? `${call.name} was cut off mid-argument`
              : `${call.name} arrived with arguments that would not parse`,
            {
              tool: call.name,
              attempt: truncations,
              bytes: call.rawArguments?.length ?? 0
            }
          );
          await this.#recordToolResult(
            task,
            key,
            state,
            call,
            {
              skipped: true,
              /*
               * Which of the two it was decides what to do about it, and they used to be told
               * apart by guesswork - every unparseable call was reported as truncation, so a model
               * that had simply written bad JSON was advised to send less of it.
               */
              reason: cutOff
                ? truncations >= MAX_ARGUMENT_TRUNCATIONS
                  ? `The arguments for ${call.name} were cut off at the model's output limit for the ${truncations}th time, so it was not run. Stop retrying this call: do the work in smaller pieces, or finish and say what could not be written.`
                  : `The arguments for ${call.name} were cut off at the model's output limit, so it was not run and nothing changed. Re-issue it with a smaller payload - write the file in parts with file_write then file_patch, or shorten the content.`
                : `The arguments for ${call.name} were not valid JSON, so it was not run and nothing changed. Send the call again with well-formed arguments - the payload was ${call.rawArguments?.length ?? 0} characters, so length was not the problem.`
            },
            model,
            catalog
          );
          continue;
        }
        const planChanged = await refreshActivePlan();
        if (planChanged && call.name !== 'set_plan') {
          await this.#recordToolResult(
            task,
            key,
            state,
            call,
            {
              skipped: true,
              reason:
                'The user changed the active plan after this tool call was proposed. Replan before acting.'
            },
            model,
            catalog
          );
          continue;
        }
        /*
         * Registered here, past every gate that answers a call instead of running it.
         *
         * It used to be registered at the repeat check above, which is two gates too early. The
         * owner edits the plan mid-step, three `file_read`s are answered "replan before acting" -
         * none of them ran - the agent replans and re-issues exactly those three, which is what it
         * was just told to do, and each one comes back "which already ran this turn and would
         * return the same result. Read that result again": there is no result to read, only the
         * skip notice, and those three files are unreadable for the rest of the turn. Truncation
         * has the same shape and a sharper edge, because `repo_overview` has no required
         * parameters, so a valid minimal call and a call cut off mid-JSON are both `{}` - one
         * truncated `repo_overview` retired the tool for the whole turn.
         *
         * Nothing between here and `#execute` answers one of these eight without running it. An
         * approval can park one, and that is deliberate: the parked call is resumed by id rather
         * than re-proposed, so the key belongs to the call the owner was asked about.
         */
        if (IDEMPOTENT_WITHIN_TURN.has(call.name))
          state.seenCalls = {
            ...(state.seenCalls ?? {}),
            [idempotentCallKey(call)]: call.id
          };
        if (call.name === 'finish') {
          const summary = textValue(call.arguments.summary, assistantText || 'Task complete');
          const checked = completionVerification(state, call.arguments.verification);
          /*
           * Past the ceiling the turn ends honestly, exactly as a failed acceptance check does
           * below, rather than being thrown away.
           *
           * This used to raise `completion_unverified`, which marks the task FAILED. Observed: an
           * agent built the page it was asked for, served it, published a working preview and
           * wrote a correct summary - and the run was binned, because each time it curled its own
           * server to check the result, that shell call became the newest change and made the
           * evidence it had just cited stale. Thirty-one turns and a live deliverable, reported to
           * the owner as a failure. Verification failing is not the work failing, and a harness
           * that cannot tell the difference must not be the one deciding.
           *
           * So the completion stands and the doubt travels with it: the turn finishes, and what
           * could not be established is carried into `remainingRisks`, where the completion card
           * already shows it. The owner sees what was made and is told plainly that athanor could
           * not prove it.
           */
          const unverifiable =
            !checked.ok && (state.finishRejections ?? 0) + 1 >= MAX_FINISH_REJECTIONS;
          if (!checked.ok && !unverifiable) {
            const rejections = (state.finishRejections ?? 0) + 1;
            state.finishRejections = rejections;
            state.repairStep = true;
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: [
                `Finish rejected (attempt ${rejections} of ${MAX_FINISH_REJECTIONS}): ${checked.reason}`,
                citableEvidence(state),
                'Either keep working, or call finish again with verification shaped exactly as {"status":"verified","evidence":[{"claim":"<what you are asserting>","source":"tool_result","toolCallId":"<id from the list above>"}],"remainingRisks":[]}.'
              ].join('\n')
            });
            await event(this.store, task, key, 'status', 'Completion needs verification', {
              reason: checked.reason,
              attempt: rejections
            });
            continue;
          }
          if (unverifiable)
            await event(
              this.store,
              task,
              key,
              'warning',
              'Finished, but athanor could not verify it',
              { reason: checked.ok ? '' : checked.reason, attempts: MAX_FINISH_REJECTIONS }
            );
          state.finishRejections = 0;
          // The plan is the one artefact the owner watches while long work runs, and until now the
          // harness force-marked every outstanding step completed on the way out - so a turn that
          // did four of nine steps and gave up left a panel reading nine of nine. Asked once, with
          // the titles named; a turn that has genuinely finished answers it in one line.
          const outstanding = await this.#outstandingPlanSteps(task, key).catch(() => []);
          /*
           * Only against a plan somebody chose to write.
           *
           * The hold exists because a turn that did four of nine steps and gave up used to leave a
           * panel reading nine of nine - the owner watches those statuses. But when no plan was
           * declared the harness writes one for itself, three boilerplate lines beginning "Inspect
           * the request, inputs, and current workspace state", and then held the finish against its
           * own boilerplate. Measured on one research task: the answer was written, and six of the
           * ten model turns came after it, this hold among them. Nothing is lost by dropping it -
           * the outstanding steps still travel into the completion for the turn that resumes.
           */
          if (outstanding.length && !state.planCoverageNagged && !state.planIsFallback) {
            state.planCoverageNagged = true;
            state.repairStep = true;
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: `Finish held: ${outstanding.length} plan step${outstanding.length === 1 ? ' is' : 's are'} still open - ${outstanding.slice(0, 8).join('; ')}. Either finish them, mark them skipped with set_plan, or say in your reply that they are outstanding and finish again. The user is looking at those statuses.`
            });
            await event(this.store, task, key, 'status', 'Plan steps are still open', {
              outstanding
            });
            continue;
          }
          // Nothing in athanor ever ran a check that could fail on the work itself. A finish cited a
          // successful call ordered after the last change, which any read of the file just written
          // satisfies. If this turn changed something, it has to say what would prove it - once.
          //
          // A record the last turn declared does not answer this. It is kept, because a follow-up
          // must not be able to break what the previous turn was held to, but it passed before this
          // turn started: whatever this turn just did, that record is not evidence of it.
          const inheritedAcceptance = (state.acceptanceTurn ?? 0) !== turn;
          if (
            state.mutatedBeyondProse &&
            (!state.acceptance || inheritedAcceptance) &&
            !state.acceptanceNagged
          ) {
            state.acceptanceNagged = true;
            state.repairStep = true;
            /*
             * Both calls in one step, said in as many words.
             *
             * The loop has always answered a batch in order, so `set_acceptance` followed by
             * `finish` in the same reply is declared, run and completed in a single model call -
             * but nothing said so, and every model answered "then finish again" with one call and
             * then another. Measured on `media-logo-set-holds-for-acceptance`: eight model calls
             * against seven for the same job declared up front, and the whole difference was the
             * round trip. This does not soften the hold; the record is still declared before the
             * checks are run, and a turn that ignores the invitation is held exactly as before.
             */
            const inOneStep =
              ' Send both calls in the same step - set_acceptance and then finish - and this costs you nothing.';
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content:
                (state.acceptance
                  ? 'Finish held: this turn changed something, and the only acceptance checks on record are the ones an earlier turn declared - they were already passing before this turn began, so they show nothing about what you just did. Call set_acceptance with checks for this turn’s work, keeping the earlier ones alongside if they still guard something, then finish again.'
                  : 'Finish held: this turn changed something and never said what would prove it worked. Call set_acceptance with the checks the harness should run - the command that builds or tests it, the extraction that shows the document says what it should, the file that has to exist - then finish again. If the work genuinely has no executable proof, say so in your reply and declare the artifact checks that do apply.') +
                inOneStep
            });
            await event(this.store, task, key, 'status', 'Asked for an acceptance record', {});
            continue;
          }
          /*
           * An unverifiable finish still completes, and says so in the one sentence the owner can
           * do something with.
           *
           * It used to carry `checked.reason` and the attempt count: "athanor could not confirm
           * this completion after 3 attempts: Every cited result predates file_write (call-2)...
           * Cite call-2 itself if its output shows the outcome". That is the harness talking to the
           * model, printed at somebody who cannot cite anything, in the place that should say what
           * to do about the work. The reason is not lost - the warning event above carries it,
           * which is where a diagnostic belongs.
           */
          let verification: CompletionVerification = checked.ok
            ? checked.verification
            : {
                status: 'not_applicable',
                evidence: [],
                remainingRisks: [
                  'athanor could not tie this result to anything it did, so check it before relying on it.'
                ]
              };
          let acceptanceEvidence: string[] = [];
          // Held outside the block so the finish below can keep the commands that passed. Only the
          // commands: an artifact check says a file exists, which is about this afternoon, where a
          // command that exits zero is about the machine.
          let verifiedCommands: AcceptanceCommandCheck[] = [];
          /*
           * And the other half, which reaching this line is most of what makes it worth keeping.
           *
           * A check that fails sends the model round again, up to `MAX_ACCEPTANCE_FAILURES` times,
           * and only the last of those runs is ever read here - so a command that failed and was
           * then fixed leaves nothing behind, and a command that arrives here failed after the
           * model had four goes at it. That is the difference between a bad afternoon and a route
           * worth remembering was closed.
           */
          let deadEnds: MemoryDeadEndCheck[] = [];
          if (state.acceptance) {
            // Carrying what athanor has already run, so a check naming a command it executed
            // itself after the last change is answered by that run rather than by a second build.
            const results = await this.#runAcceptanceChecks(
              task,
              key,
              state.acceptance,
              { purpose: 'finish', observed: observedCommands(state) },
              // The turn, so the answer hold below - which is free, runs after this, and sends the
              // same finish round again - cannot buy a second build with it.
              state
            );
            verifiedCommands = state.acceptance.checks.filter(
              (check): check is AcceptanceCommandCheck =>
                check.kind === 'command' &&
                results.some((result) => result.id === check.id && result.passed)
            );
            deadEnds = state.acceptance.checks.flatMap((check) => {
              if (check.kind !== 'command') return [];
              const result = results.find((entry) => entry.id === check.id && !entry.passed);
              // Only a run that ended. "timed out after 900s" and "the check could not run" are the
              // harness failing to observe the command rather than the command failing, and a
              // caution written out of either would outlive a wedged network or a runner restart.
              if (!result?.detail.startsWith('exit ')) return [];
              return [
                {
                  label: check.label,
                  command: [check.executable, ...check.args].join(' '),
                  cwd: check.cwd,
                  detail: result.detail
                }
              ];
            });
            acceptanceEvidence = acceptancePassedEvidence(results);
            const failed = results.filter((result) => !result.passed);
            if (failed.length) {
              const attempt = (state.acceptanceFailures ?? 0) + 1;
              state.acceptanceFailures = attempt;
              state.repairStep = true;
              if (attempt < MAX_ACCEPTANCE_FAILURES) {
                state.messages.push({
                  role: 'tool',
                  toolCallId: call.id,
                  content: acceptanceFailureMessage(results, attempt, MAX_ACCEPTANCE_FAILURES)
                });
                // A status, not a warning. This refusal is transient by construction: the model is
                // told what failed and gets to fix it, and the turn that recovers used to carry a
                // standing red line contradicting the "all passed" on its own completion card. A
                // failure that is never recovered from is not lost - it reaches the owner as a
                // remaining risk below, which is where a finished task's problems belong.
                //
                // The summary says which check, because the old one said only that "a check" failed
                // and the payload naming it was never rendered anywhere.
                await event(
                  this.store,
                  task,
                  key,
                  'status',
                  `Finish refused: ${failed.length} of ${results.length} acceptance ${results.length === 1 ? 'check' : 'checks'} failed — ${failed
                    .map((result) => result.label)
                    .join('; ')
                    .slice(0, 160)}`,
                  { acceptance: results }
                );
                continue;
              }
              // Bounded like every other refusal in this loop: past the ceiling the turn ends
              // honestly rather than spending the rest of the budget on the same failure.
              verification = {
                ...verification,
                remainingRisks: [
                  ...verification.remainingRisks,
                  ...failed.map((result) => `${result.label} — ${result.detail}`)
                ].slice(0, 20)
              };
            } else {
              state.acceptanceFailures = 0;
            }
            // A green tick that means less than the last one did has to say so where the owner
            // reads it, not only in the timeline entry for the step that declared the checks. Where
            // exactly is the card's decision: a line written into both the acceptance list and the
            // risks is shown beside the tick, and a line written only into the risks is shown with
            // the rest of the detail, behind the disclosure. Only the caveat that would leave a
            // reader who never opens it believing something untrue goes in both.
            const caveat =
              state.acceptanceCaveat ??
              ((state.acceptanceTurn ?? 0) === turn ? undefined : ACCEPTANCE_EARLIER_TURN_CAVEAT);
            if (caveat) {
              if (CAVEAT_BESIDE_THE_TICK.has(caveat))
                acceptanceEvidence = [caveat, ...acceptanceEvidence];
              verification = {
                ...verification,
                remainingRisks: [...verification.remainingRisks, caveat].slice(0, 20)
              };
            }
          }
          /*
           * A turn that did the work and never said a word.
           *
           * The model can do everything through tools and call finish without writing prose once,
           * and the owner is left with a card describing the work instead of the answer they asked
           * for - "wrote a note to notes-check.md" in reply to "tell me what it says". The finish
           * schema already tells it the answer belongs in the reply; nothing ever checked.
           *
           * Asked once, and only when literally nothing was said, so a turn that answered normally
           * never sees it. Deliberately not a `repairStep`: those suppress publishing because they
           * are bookkeeping, and this is the opposite - it exists to get an answer published, so it
           * clears the flag a refusal may have left set.
           */
          if (!state.answered && !state.answerNagged) {
            state.answerNagged = true;
            state.repairStep = false;
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content:
                'Finish held: this turn has not said anything to the user. The card carries a description of the work, not the answer - if they asked what a file says, what you found, or what you concluded, that belongs in your reply. Write it, then call finish again.'
            });
            await event(this.store, task, key, 'status', 'Asked for the answer itself', {});
            continue;
          }
          state.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({
              completed: true,
              summary,
              verification
            })
          });
          await this.#completeTurn(
            task,
            key,
            state,
            {
              summary,
              deliverables: Array.isArray(call.arguments.deliverables)
                ? call.arguments.deliverables
                : [],
              verification,
              ...(acceptanceEvidence.length ? { acceptance: acceptanceEvidence } : {}),
              ...(verifiedCommands.length ? { verifiedCommands } : {})
            },
            // Carried beside the completion rather than inside it: the card already prints each of
            // these as a remaining risk, and this copy exists only for the memory write.
            deadEnds.length ? { deadEnds } : {}
          );
          return;
        }
        if (call.name === 'compact_context') {
          // Compaction runs while this call is still unanswered, which is precisely what keeps the
          // assistant message that made it - and every result already pushed for its batch - out of
          // the condensed span; the result below would otherwise have no call to attach to.
          const outcome = await this.#compactContext(task, key, state, {
            model,
            catalog,
            maxOutputTokens,
            // The same count the budget check above used, not a second one worked out here: the
            // catalogue this step sent is the catalogue the next step sends, and two ways of
            // measuring it is exactly how the trigger and the target came apart.
            reservedTokens,
            trigger: 'agent',
            turn,
            note: textValue(call.arguments.finishedPhase).trim().slice(0, 2_000)
          });
          state.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: outcome
              ? JSON.stringify({
                  compacted: true,
                  condensedMessages: outcome.condensedMessages,
                  briefParts: outcome.brief.sections.length,
                  estimatedInputTokens: outcome.estimatedTokensAfter,
                  note: 'The condensed turns are now recorded in the running brief above your recent messages. Re-read files or re-run checks for exact detail.'
                })
              : JSON.stringify({
                  compacted: false,
                  reason:
                    'There is not enough superseded conversation to condense yet. Keep working; the harness compacts on its own as the window fills.'
                })
          });
          state.turnToolResults ??= {};
          state.turnToolResults[call.id] = { name: call.name, success: outcome !== null };
          // Republished after the result, matching set_plan, so a tool call is never separated from
          // its own result by an unrelated system message.
          if (outcome) await refreshActivePlan();
          continue;
        }
        if (call.name === 'notify') {
          await this.#sendNotice(task, key, state, call);
          continue;
        }
        if (call.name === 'ask') {
          // The same shape as the approval park below: everything the model proposed behind the
          // question is answered in writing before the turn is saved, so the window it resumes into
          // is well formed and nothing behind a decision runs before the decision is made.
          if (await this.#askUser(task, key, state, call, response.toolCalls.slice(callIndex + 1)))
            return;
          continue;
        }
        if (call.name === 'set_acceptance') {
          const parsed = parseAcceptanceChecks(call.arguments.checks);
          state.turnToolResults ??= {};
          if (!parsed.ok) {
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: `Acceptance record rejected: ${parsed.reason}`
            });
            state.turnToolResults[call.id] = { name: call.name, success: false };
            continue;
          }
          const previous = state.acceptance;
          const record: AcceptanceRecord = {
            checks: parsed.checks,
            revisions: (previous?.revisions ?? 0) + 1,
            declaredAtStep: state.step
          };
          // The red baseline, and the only part of this mechanism that cannot be satisfied by the
          // model deciding its own work is good: the checks are run against the job as it stands
          // before the turn has changed anything, and a record where none of them fails is refused.
          // Once the turn has already changed something there is no such reading to be had - what
          // passes now may be the work or may always have been true - so the record is taken as it
          // stands and no baseline is claimed for it.
          //
          // Set only by the branch below. What the completion says about the checks now describes
          // the checks; when there is nothing of that kind to say, it says nothing.
          let caveat: string | undefined;
          let baseline: AcceptanceResult[] | null = null;
          if (!state.mutated) {
            baseline = await this.#runAcceptanceChecks(task, key, record, { purpose: 'baseline' });
            if (baseline.every((result) => result.passed)) {
              const attempt = (state.acceptanceBaselineRefusals ?? 0) + 1;
              state.acceptanceBaselineRefusals = attempt;
              if (attempt < MAX_ACCEPTANCE_BASELINE_REFUSALS) {
                state.messages.push({
                  role: 'tool',
                  toolCallId: call.id,
                  content: acceptanceBaselineRefusal(
                    baseline,
                    attempt,
                    MAX_ACCEPTANCE_BASELINE_REFUSALS
                  )
                });
                state.turnToolResults[call.id] = { name: call.name, success: false };
                await event(
                  this.store,
                  task,
                  key,
                  'status',
                  'Acceptance checks refused: they already pass',
                  { checks: parsed.checks.map(describeAcceptanceCheck), acceptance: baseline }
                );
                continue;
              }
              caveat = ACCEPTANCE_ALREADY_PASSED_CAVEAT;
            } else state.acceptanceBaselineRefusals = 0;
          }
          state.acceptance = record;
          state.acceptanceTurn = turn;
          if (caveat) state.acceptanceCaveat = caveat;
          else delete state.acceptanceCaveat;
          // Both versions reach the timeline. Weakening your own test in front of the owner is a
          // different act from passing it, and it should read like one.
          await event(
            this.store,
            task,
            key,
            'status',
            previous
              ? `Acceptance checks revised (version ${record.revisions})`
              : 'Acceptance checks declared',
            {
              revision: record.revisions,
              checks: parsed.checks.map(describeAcceptanceCheck),
              ...(previous ? { replaced: previous.checks.map(describeAcceptanceCheck) } : {}),
              ...(baseline ? { baseline } : {}),
              ...(caveat ? { caveat } : {})
            }
          );
          state.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: [
              acceptanceAcceptedResult(record),
              caveat ?? (baseline ? acceptanceBaselineNote(baseline) : '')
            ]
              .filter(Boolean)
              .join('\n')
          });
          state.turnToolResults[call.id] = { name: call.name, success: true };
          continue;
        }
        const approval = await this.#approvalForCallOnce(approvalMemo, task, call, state);
        if (approval) {
          const origin = approvalOrigin(state);
          const approvalId = await this.store.createApproval({
            userId: task.userId,
            taskId: task.id,
            action: approval.handoffOnly ? 'secure_input_handoff' : call.name,
            ...(origin === undefined ? {} : { origin }),
            sideEffect: approval.sideEffect,
            previewCiphertext: encryptJson(
              {
                action: approval.action,
                preview: approval.preview,
                tool: call.name,
                arguments: approval.handoffOnly
                  ? { action: textValue(call.arguments.action, 'secure_input') }
                  : call.arguments
              },
              key,
              `approval:${task.id}`
            ),
            previewHash: approvalPreviewHash(key, call.name, call.arguments),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          });
          state.pending = {
            approvalId,
            toolCall: call,
            ...(approval.handoffOnly ? { handoffOnly: true } : {})
          };
          for (const deferred of response.toolCalls.slice(callIndex + 1)) {
            state.messages.push({
              role: 'tool',
              toolCallId: deferred.id,
              content:
                'Deferred because an earlier action requires user approval. Request it again if still needed.'
            });
          }
          await event(this.store, task, key, 'approval_requested', approval.action, {
            approvalId,
            sideEffect: approval.sideEffect,
            preview: approval.preview
          });
          await this.store.updateTask({
            id: task.id,
            workerId: this.config.WORKER_ID,
            status: 'awaiting_user',
            actualComputeCredits: state.credits,
            agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
            clearLease: true
          });
          return;
        }
        // Before the call runs, not after: the whole point is to hold the state the turn started
        // from. It happens at most once a turn, and never at all for a turn that only reads.
        await this.#ensureTurnUndoPoint(task, key, state, call.name);
        // Recorded on intent rather than on success, because a write that failed is still a turn
        // doing material work, and that is what the user-visible plan is for.
        if (isMutatingToolCall(call.name, call.arguments)) {
          state.mutated = true;
          if (!writesOnlyProse(call.name, call.arguments)) state.mutatedBeyondProse = true;
        }
        state.toolsStarted = (state.toolsStarted ?? 0) + 1;
        await event(this.store, task, key, 'tool_started', `Running ${call.name}`, {
          toolCallId: call.id,
          tool: call.name,
          arguments: call.arguments
        });
        // Intent first, action second. State used to be written once per step, after the whole
        // batch, so a worker killed between sending an email and recording that it had sent one
        // resumed from before the batch and sent it again. The record below is what lets the resume
        // say "this was running" instead of silently repeating it.
        const repeatable = REPEATABLE_TOOLS.has(call.name);
        if (!repeatable) {
          state.inFlight = {
            toolCallId: call.id,
            tool: call.name,
            startedAt: new Date().toISOString()
          };
          await this.#checkpoint(task, key, state);
        }
        try {
          const result = await this.#withLeaseRenewal(task, () =>
            this.#withCancellationWatch(task, () =>
              this.#execute(task, call, key, false, webPlan, state)
            )
          );
          if (call.name === 'publish_artifact') {
            const artifact = result as {
              artifactId: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
              version: number;
              preview?: {
                artifactId: string;
                name: string;
                mimeType: string;
                sizeBytes: number;
                version: number;
              };
            };
            await event(
              this.store,
              task,
              key,
              'artifact',
              `${artifact.name} · version ${artifact.version}`,
              artifact
            );
            if (artifact.preview)
              await event(
                this.store,
                task,
                key,
                'artifact',
                `${artifact.preview.name} · review copy · version ${artifact.preview.version}`,
                artifact.preview
              );
            state.messages.push({
              role: 'tool',
              toolCallId: call.id,
              content: JSON.stringify(artifact)
            });
            state.turnToolResults ??= {};
            state.turnToolResults[call.id] = { name: call.name, success: true, mutating: false };
            // Said here as well as in `#recordToolResult`, because this is the one success in the
            // loop that does not go through it. Without it a publish that fails, works, and fails
            // the same way again carries its old count forward, and a call the turn is genuinely
            // completing can reach a bound meant for one that never completes.
            state.repeatedFailures = repeatedFailuresAfter(state.repeatedFailures, {
              call: failingCallKey(call),
              failure: null
            });
          } else {
            await this.#recordToolResult(task, key, state, call, result, model, catalog);
          }
          // Adopt the version this call just wrote. Without it the plan the agent itself published
          // looks like a user edit to the next call in the same batch, which then gets skipped -
          // and marking a step in_progress before acting would skip the very action it describes.
          if (
            call.name === 'set_plan' &&
            Number.isFinite(Number((result as { version?: unknown } | null)?.version))
          )
            await refreshActivePlan();
        } catch (error) {
          await this.#recordToolFailure(task, key, state, call, error);
        }
        if (!repeatable) {
          delete state.inFlight;
          await this.#checkpoint(task, key, state);
        }
      }
      sealUnansweredToolCalls(state.messages, 'the step ended before this call ran');
      /*
       * The step is over; did anything happen in it.
       *
       * The one inversion of the silence hold, which holds a turn that did the work and never said
       * anything. This is a turn that says everything and does nothing, and until now the loop had
       * no bound on it that a proposal could not reset. Asked here rather than at the top of the
       * next step so the sentence lands in the same window the step it describes was billed for.
       */
      const idle = idleStepsAfter(state.idleSteps ?? 0, {
        proposed: response.toolCalls.map((call) => call.name),
        started: (state.toolsStarted ?? 0) - startedBeforeBatch
      });
      if (idle !== undefined) state.idleSteps = idle;
      if (idle !== undefined && idle >= IDLE_STEPS_BEFORE_STOP) {
        /*
         * Told once, then ended - because a bound that only ever pushes back is not a bound.
         *
         * Ended the way the completion nag ends, not by raising: whatever the model has said is
         * still the owner's, the plan and the artifacts are still there, and a reply carries the
         * conversation on. What the owner is owed is the reason, and it goes where they already
         * read reasons - the caveat on the completion, beside the work.
         */
        await event(this.store, task, key, 'warning', 'Stopped a turn that had stopped moving', {
          steps: idle
        });
        const stillOpen = await this.#outstandingPlanSteps(task, key).catch(() => []);
        await this.#completeTurn(task, key, state, {
          /*
           * Athanor's own sentence, not the model's last paragraph.
           *
           * The completion nag uses `assistantText` because there the model has answered and the
           * answer is the summary. Here it has not: this break only fires on a step that asked for
           * a tool, so whatever it wrote is prose written alongside a call - the deliberation that
           * caused the break. `#completeTurn` publishes the summary as the reply when the turn
           * never spoke, so taking it from there would put the spiral's last paragraph at the top
           * of the result card, which is the same promotion the client now folds away.
           */
          summary: `Stopped after ${idle} steps that asked for tools and started none.`,
          interrupted: true,
          ...(stillOpen.length ? { outstanding: stillOpen } : {}),
          verification: {
            status: 'not_applicable',
            evidence: [],
            remainingRisks: [
              `athanor stopped this turn: ${idle} steps running asked for tools and started none, so the work was not moving. Reply to carry on, or say which way you want it decided.`
            ]
          }
        });
        return;
      }
      // Said again on every further step that starts nothing, with the number it has reached. A
      // sentence pushed once, four steps ago, under a thousand frames of the model's own prose, is
      // a sentence that is no longer in front of it - and the repeats are bounded by the stop above.
      if (idle !== undefined && idle >= MAX_IDLE_STEPS) {
        await event(this.store, task, key, 'warning', `Nothing has run for ${idle} steps`, {
          steps: idle
        });
        state.messages.push({ role: 'system', content: idleStepBreak(idle) });
      }
      /*
       * And did any of it fail the way it failed last time.
       *
       * The step above and this one cannot both fire: a call that runs and throws has started a
       * tool, which zeroes the idle count, and a step that started nothing has nothing here to
       * count. They are the two halves of the same question - the first asks whether the turn is
       * still doing anything, the second whether what it is doing is still capable of working.
       */
      const repeated = repeatedFailureRise(failuresBeforeBatch, state.repeatedFailures);
      if (repeated && repeated.count >= REPEATED_FAILURES_BEFORE_STOP) {
        /*
         * Ended exactly as the idle break ends one, and the reason goes where the owner reads
         * reasons. The event carries the tool and the count and nothing else: the arguments are the
         * owner's file or the owner's command line, and the error can quote their own code back.
         */
        await event(
          this.store,
          task,
          key,
          'warning',
          'Stopped a turn that was retrying a failure',
          {
            tool: repeated.tool,
            attempts: repeated.count
          }
        );
        const stuckOpen = await this.#outstandingPlanSteps(task, key).catch(() => []);
        await this.#completeTurn(task, key, state, {
          summary: `Stopped after ${repeated.count} identical ${repeated.tool} calls that all failed the same way.`,
          interrupted: true,
          ...(stuckOpen.length ? { outstanding: stuckOpen } : {}),
          verification: {
            status: 'not_applicable',
            evidence: [],
            remainingRisks: [
              `athanor stopped this turn: ${repeated.tool} was called ${repeated.count} times with the same arguments and failed the same way every time, so nothing it did in between was changing the outcome. Reply to carry on, or say which way you want it decided.`
            ]
          }
        });
        return;
      }
      if (repeated && repeated.count >= MAX_REPEATED_FAILURES) {
        await event(
          this.store,
          task,
          key,
          'warning',
          `${repeated.tool} has failed ${repeated.count} times the same way`,
          { tool: repeated.tool, attempts: repeated.count }
        );
        state.messages.push({
          role: 'system',
          content: repeatedFailureBreak(repeated.count, repeated.tool)
        });
      }
      await this.store.updateTask({
        id: task.id,
        workerId: this.config.WORKER_ID,
        status: 'running',
        actualComputeCredits: state.credits,
        agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
      });
      await this.store.renewTaskLease(task.id, this.config.WORKER_ID, TASK_LEASE_SECONDS);
    }
    // Asked once more before the closing call is billed: a Stop pressed during the final step has
    // already said what the owner wants to happen next, and a handoff is not it.
    if (await honorUserControl()) return;
    try {
      await this.#handOffAtStepLimit(task, key, state, {
        gateway,
        provider,
        model,
        catalog,
        turn,
        maxOutputTokens: Math.min(16_384, Math.max(2_048, Math.floor(model.contextTokens * 0.2))),
        tools: requestTools,
        webPlan
      });
    } catch (error) {
      // The handoff is one model call, and a provider that is down for it must not also cost the
      // record of where the work stopped. Persist the carry-over note - fail() writes events but
      // never agent state - and then report the ceiling with the same sentence as every other
      // bounded stop in this file, which is that the work is saved and a reply continues it.
      const outstanding = await this.#outstandingPlanSteps(task, key).catch(() => []);
      state.messages.push({ role: 'system', content: stepLimitCarryOver(state.step, outstanding) });
      await this.store
        .updateTask({
          id: task.id,
          workerId: this.config.WORKER_ID,
          status: 'running',
          actualComputeCredits: state.credits,
          agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
        })
        .catch(() => undefined);
      throw new AthanorError(
        'step_limit_reached',
        `This turn used all ${this.#stepCeiling(state)} of its steps, and the closing handoff could not be written either (${error instanceof Error ? error.message : 'unknown error'}).${
          outstanding.length ? ` Still open: ${outstanding.slice(0, 3).join('; ')}.` : ''
        } Everything it produced is saved - reply to carry on from where it stopped.`
      );
    }
  }

  async fail(task: TaskRecord, error: unknown, durationMs?: number): Promise<void> {
    const workspace = await this.store.getWorkspaceById(task.workspaceId).catch(() => null);
    const message = error instanceof Error ? error.message : 'Task failed';
    // Both halves have to hold. `isProviderWall` answers whether waiting is any use, and
    // `PARKABLE_PROVIDER_WALLS` answers whether anything on this box would ever ask again: a code
    // named here and missing from the API's own table parks the work for ever with nothing left to
    // wake it, which is strictly worse than failing, because failing at least tells the owner.
    const waiting =
      error instanceof AthanorError &&
      isProviderWall(error) &&
      PARKABLE_PROVIDER_WALLS.has(error.code);
    let turn = 0;
    let step = 0;
    if (workspace?.wrappedKey && task.agentStateCiphertext) {
      try {
        const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
        const saved = decryptJson<Pick<AgentState, 'turn' | 'step'>>(
          task.agentStateCiphertext,
          key
        );
        turn = saved.turn ?? 0;
        step = saved.step ?? 0;
      } catch {
        turn = 0;
        step = 0;
      }
    }
    // Before the writes below, all of which need the database - which is one of the things that
    // fails here. The journal record is the one that survives the store being the problem.
    const record = taskFailureRecord(
      {
        taskId: task.id,
        attempt: task.attempt,
        turn,
        step,
        modelId: task.modelId,
        ...(durationMs === undefined ? {} : { durationMs }),
        error,
        waiting
      },
      this.#loggedFailureStacks
    );
    this.logger[record.level](record.event, record.fields);
    if (workspace?.wrappedKey) {
      const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
      await event(
        this.store,
        task,
        key,
        error instanceof AthanorError && error.code.includes('provider') ? 'warning' : 'error',
        message.slice(0, 500),
        // The task stopped and did not do what was asked. Whatever else is folded away, the reason
        // the work is not there has to be in the conversation.
        { owner: true, code: error instanceof AthanorError ? error.code : 'agent_failed' }
      );
    }
    /*
     * A message the owner sent while this turn was running outlives the turn.
     *
     * Nothing here used to look at the queue at all. A correction typed into a turn that was going
     * wrong - which is the moment the queue exists for - was answered with "the agent picks it up
     * at its next step", and if the turn then died there was no next step, ever: the row stayed
     * queued on a task nothing would lease again, and the header went on counting it.
     *
     * `awaiting_resource` is deliberately not in here. A provider wall is already resumed by the
     * sweep in the API, on a widening interval and with a line of its own when it gives up asking,
     * and the message really is still waiting on that path - so the count is telling the truth and
     * requeueing underneath the sweep would only take the pacing away from it.
     */
    const carried = waiting
      ? null
      : await this.store
          .requeueTaskForQueuedMessage({ id: task.id, workerId: this.config.WORKER_ID })
          .catch(() => null);
    if (carried) {
      this.logger.info('task.retried_for_queued_message', {
        taskId: task.id,
        attempt: carried.attempt,
        attempts: TASK_MAX_ATTEMPTS
      });
      // Said after the requeue rather than before it, so nothing is announced that did not happen.
      // The cost is that a worker may lease the task back before this line lands; an event arriving
      // a moment into the next attempt is a smaller wrong than a promise the write did not keep.
      if (workspace?.wrappedKey)
        await event(
          this.store,
          task,
          unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id),
          'warning',
          `This turn stopped before the message you sent could be started. It is still queued and this conversation is going back in the queue to carry on from where it stopped - start ${carried.attempt + 1} of ${TASK_MAX_ATTEMPTS}.`,
          { owner: true, code: 'queued_message_retried', attempt: carried.attempt + 1 }
        ).catch(() => undefined);
      // The reservation stays reserved and the status stays leasable, exactly as on the provider
      // wall above: this task is going to run again, and releasing the credits it is about to spend
      // would leave the next attempt budgeted for nothing.
      return;
    }
    if (!waiting)
      await this.store.transitionUsage(reservationUsageKey(task.id, turn), 'reserved', 'released');
    await this.store.updateTask({
      id: task.id,
      workerId: this.config.WORKER_ID,
      status: waiting ? 'awaiting_resource' : 'failed',
      clearLease: true
    });
    if (!waiting) await this.#refuseUndeliveredMessages(task, workspace);
  }

  /**
   * Says out loud that the owner's message is not going to run, and gives them back their words.
   *
   * Reached when the conversation has stopped for good with something still queued - which after
   * the retry above means the attempt ceiling, or a task the owner cancelled while it was dying.
   * Cancelling already empties this queue, so in practice that second door finds nothing, which is
   * the intended shape: a conversation the owner stopped stays stopped and says nothing further.
   *
   * A correction that is quietly dropped is worse than one that is refused, so the refusal carries
   * the message back verbatim. The row is moved out of 'queued' either way - that is what stops the
   * header counting a message that cannot arrive - but the sentence is what the owner is actually
   * owed, and the text in the payload is what a re-send can be built on without asking them to
   * retype anything.
   */
  async #refuseUndeliveredMessages(
    task: TaskRecord,
    workspace: { id: string; wrappedKey?: string } | null
  ): Promise<void> {
    const stranded = await this.store.strandQueuedTaskMessages(task.id).catch(() => []);
    if (!stranded.length) return;
    this.logger.warn('task.queued_messages_undelivered', {
      taskId: task.id,
      attempt: task.attempt,
      count: stranded.length
    });
    if (!workspace?.wrappedKey) return;
    const key = unwrapDataKey(workspace.wrappedKey, this.#masterKey, workspace.id);
    // Said only where it is known to be true. The ceiling is the reason nearly every time, but this
    // is also where a conversation the owner stopped mid-failure arrives, and telling them their
    // work was tried six times when they cancelled it after one is the kind of confident wrong
    // sentence the whole of this file is meant to stop writing.
    const exhausted =
      task.attempt >= TASK_MAX_ATTEMPTS
        ? ` This conversation was started ${task.attempt} times without finishing.`
        : '';
    for (const queued of stranded) {
      // A message whose envelope will not open is still a message that did not arrive, so the
      // refusal is written either way and only the quotation is missing from it. Reading it must
      // not be able to throw: this is the last thing said about a conversation that has already
      // failed once, and losing the refusal to a bad envelope would leave the owner with silence.
      let markdown = '';
      try {
        if (queued.promptCiphertext.aad === `task-message:${task.id}`)
          markdown = decryptJson<{ prompt: string }>(queued.promptCiphertext, key).prompt.trim();
      } catch {
        markdown = '';
      }
      await event(
        this.store,
        task,
        key,
        'warning',
        `Your message was not started, and athanor is not going to start it on its own.${exhausted}${markdown ? ` What you sent was: "${markdown.slice(0, 240)}"` : ''} Send it again to try.`,
        { owner: true, code: 'queued_message_undelivered', ...(markdown ? { markdown } : {}) }
      ).catch(() => undefined);
    }
  }
}
