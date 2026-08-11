/**
 * The offline rig every fixture runs on: the real agent loop, a scripted model, a scripted runner.
 *
 * Nothing here is a second execution model. `AgentWorker.run` is the same object the worker process
 * runs, taking the same store interface and the same config; what is replaced is the two things at
 * its edges that would otherwise need a provider key and a Linux box - `fetch` to the inference
 * route, and `fetch` to the workspace runner. That is exactly the seam `apps/worker/src/agent-run.test.ts`
 * already stubs, and the shapes below (the store probe, the SSE frame builders, the runner router)
 * are that machinery: the frames are byte-compatible, the probe answers the same method set, and a
 * fixture that passes here would pass as a test there.
 *
 * It is a copy rather than an import because that machinery is file-local inside a `.test.ts` and
 * exports none of it. Keeping the copy honest is cheap - both drive the same loop, so a shape this
 * one gets wrong fails loudly on the first fixture rather than silently reporting a green run.
 *
 * The one difference that matters: the model here is a function of what athanor just said, not a
 * fixed list of replies. Every hold in the loop works by pushing a message back and asking again,
 * so a fixed list cannot tell "the model complied on the second attempt" from "the second reply
 * happened to be next". A script that reads the pushback can, and the step count it produces is
 * then the measured price of that hold.
 */
import type { ModelRelease } from '../packages/contracts/src/index.js';
import {
  decryptJson,
  encryptJson,
  generateDataKey,
  wrapDataKey
} from '../packages/core/src/crypto.js';
import type { DataStore, TaskRecord, WorkspaceRecord } from '../packages/data/src/index.js';
import { AgentWorker } from '../apps/worker/src/agent.js';
import { RUNTIME_CONTEXT_MARKER } from '../apps/worker/src/context.js';

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';

/* -------------------------------------------------------------------------- the scripted model */

export interface ScriptedCall {
  /** The id the model gives the call; `finish` evidence has to cite one of these. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelTurn {
  /** The streamed reply, which is what the owner reads. */
  readonly text?: string;
  /** Streamed in pieces, for the shapes that only appear across chunk boundaries. */
  readonly chunks?: readonly string[];
  /** Tool calls proposed by this step; more than one is a parallel batch. */
  readonly calls?: readonly ScriptedCall[];
  /** Ends the reply at the provider's output ceiling rather than at a real stop. */
  readonly truncated?: boolean;
}

export interface ScriptContext {
  /** Which model call this is, counting from zero. */
  readonly index: number;
  /**
   * The last thing athanor said to the model, which is how every hold in the loop talks back. The
   * runtime block is stepped over: it sits at the end of every window and its clock changes.
   */
  readonly lastMessage: string;
  /** Every message content in this request, for a script that has to look further back. */
  readonly messages: readonly string[];
}

/** A model, as a function of what athanor just said to it. */
export type ModelScript = (context: ScriptContext) => ModelTurn;

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A value read off an untyped payload, as text. Anything that is not a string reads as absent. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const framesFor = (turn: ModelTurn): string[] => {
  const parts: string[] = [];
  const pieces = turn.chunks ?? (turn.text ? [turn.text] : []);
  // Everything but the last piece goes out with no finish reason, which is what a real stream looks
  // like and what the degenerate-repeat watch reads.
  for (const piece of pieces.slice(0, turn.calls?.length ? pieces.length : -1))
    parts.push(sse({ choices: [{ delta: { content: piece } }] }));
  const tail = turn.calls?.length ? undefined : pieces.at(-1);
  parts.push(
    sse({
      choices: [
        {
          finish_reason: turn.calls?.length ? 'tool_calls' : turn.truncated ? 'length' : 'stop',
          delta: {
            ...(tail === undefined ? {} : { content: tail }),
            ...(turn.calls?.length
              ? {
                  tool_calls: turn.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    function: { name: call.name, arguments: JSON.stringify(call.args) }
                  }))
                }
              : {})
          }
        }
      ]
    })
  );
  parts.push('data: [DONE]\n\n');
  return parts;
};

const encoder = new TextEncoder();

/**
 * The frames delivered one at a time, over a stream that dies when the request is torn down.
 *
 * A stub that hands back the whole body as a string cannot be interrupted, and two mechanisms in
 * the loop are interruptions: the watch that aborts a reply which has started repeating itself, and
 * the Stop the owner presses. Both raise their abort from inside a text-delta handler, so the frames
 * have to arrive with the event loop free between them or the handler never runs before the body is
 * finished. This is the same shape `heldBody` has in the worker's own tests, for the same reason.
 */
const streamOf = (
  frames: readonly string[],
  signal?: AbortSignal | null
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const tearDown = (): void => {
        if (closed) return;
        closed = true;
        controller.error(new Error('the request was torn down'));
      };
      if (signal?.aborted) return tearDown();
      signal?.addEventListener('abort', tearDown, { once: true });
      void (async () => {
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (closed) return;
          controller.enqueue(encoder.encode(frame));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (closed) return;
        closed = true;
        controller.close();
      })();
    }
  });

/* ------------------------------------------------------------------------- the scripted runner */

export interface RunnerStub {
  /**
   * Exit codes handed to consecutive `/exec` calls; the last one repeats. This is what makes an
   * acceptance check fail on the unfinished job and pass on the finished one.
   */
  readonly exec?: readonly number[];
  /** What those commands printed, positionally, defaulting to a plausible line. */
  readonly stdout?: readonly string[];
  /** What the workspace holds, by path, for the reads. A path that is absent reads as missing. */
  readonly files?: Readonly<Record<string, string>>;
  /** The rows a `web_search` comes back with. */
  readonly search?: ReadonlyArray<{ readonly title: string; readonly url: string }>;
  /** The text each address returns to `parallel_web_read`, by address. */
  readonly pages?: Readonly<Record<string, string>>;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** What the document tools shell out to, whose stdout has to be JSON rather than a console line. */
const DOCUMENT_BINARY = '/usr/local/lib/athanor/athanor-document';

const runnerResponse = (
  stub: RunnerStub,
  state: { execs: number },
  url: string,
  init?: RequestInit
): Response => {
  // A write carries the file's own bytes rather than a JSON envelope, so this has to survive a body
  // that is not JSON at all: parsing it unguarded turned every file_write into a failed tool call.
  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string')
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  if (url.includes('/exec') || url.includes('/processes/start')) {
    // document_read and document_search are shell calls too, and they parse their own stdout as
    // JSON. They are answered off to one side so they do not consume the exit codes a fixture wrote
    // for its acceptance checks - the sequence that makes a check fail before the work and pass
    // after it is the whole mechanism, and a document read landing in the middle of it would
    // silently shift every code by one.
    if (asText(body.executable) === DOCUMENT_BINARY) {
      const args = Array.isArray(body.args) ? (body.args as unknown[]) : [];
      const path = asText(args[args.indexOf('--path') + 1]);
      return json({
        exitCode: 0,
        stdout: JSON.stringify(
          (Array.isArray(body.args) ? body.args[0] : '') === 'search'
            ? { matches: Object.keys(stub.files ?? {}).map((file) => ({ path: file, page: 1 })) }
            : { path, text: stub.files?.[path] ?? '', pages: 1 }
        ),
        stderr: '',
        durationMs: 5,
        timedOut: false
      });
    }
    const index = state.execs;
    state.execs += 1;
    const codes = stub.exec ?? [0];
    const exitCode = codes[Math.min(index, codes.length - 1)] ?? 0;
    return json({
      exitCode,
      stdout: stub.stdout?.[index] ?? (exitCode === 0 ? 'ok\n' : ''),
      stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
      durationMs: 5,
      timedOut: false
    });
  }
  if (url.includes('/browser/search'))
    return json({
      engine: 'stub',
      query: new URL(url).searchParams.get('q') ?? '',
      results: (stub.search ?? []).map((row, index) => ({
        rank: index + 1,
        title: row.title,
        url: row.url,
        site: new URL(row.url).host,
        snippet: row.title
      }))
    });
  if (url.includes('/browser/read-many'))
    return json({
      pages: Object.entries(stub.pages ?? {}).map(([address, text]) => ({
        url: address,
        title: address,
        text,
        characters: text.length
      }))
    });
  if (url.includes('/files?')) {
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    return json({
      path,
      entries: Object.keys(stub.files ?? {})
        .filter((file) => file.startsWith(path))
        .map((file) => ({ path: file, kind: 'file', bytes: (stub.files?.[file] ?? '').length }))
    });
  }
  if (url.includes('/file')) {
    // A write is acknowledged; a read of a path the fixture never put in the workspace is a miss,
    // which is how a fixture makes a read fail without inventing an error shape.
    if (init?.method === 'PUT') return json({ ok: true, storageBytes: 2_048 });
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    const content = stub.files?.[path];
    return content === undefined
      ? new Response('', { status: 404 })
      : json({ path, content, bytes: content.length });
  }
  if (url.includes('/checkpoints'))
    return json({
      id: 'checkpoint',
      mechanism: 'content',
      createdAt: '2026-07-01T00:00:00.000Z',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 128,
      changedFileCount: 2,
      uncoveredFileCount: 0,
      durationMs: 21,
      pruned: []
    });
  return json({ ok: true, storageBytes: 2_048 });
};

/* --------------------------------------------------------------------------------- the fixture */

/** Which owner-shaped request this fixture stands for. Reported so a gap in coverage is visible. */
export type FixtureShape =
  | 'answer'
  | 'files'
  | 'verify'
  | 'research'
  | 'ambiguous'
  | 'refusal'
  | 'small';

export interface Expectation {
  /** Exactly how many model calls the turn cost, including the closing handoff when one happens. */
  readonly modelCalls?: number;
  /**
   * Every tool athanor actually started, in order. `finish` and `set_acceptance` never appear: the
   * loop answers those itself, ahead of the line that records a tool as started.
   */
  readonly tools?: readonly string[];
  /** Every tool the model asked for, in order, including the ones the loop answered or refused. */
  readonly proposed?: readonly string[];
  /** The catalogue offered on the last request, for the turns where the loop narrows it. */
  readonly finalCatalogue?: readonly string[];
  /** Tools that must appear somewhere in the run. */
  readonly toolsInclude?: readonly string[];
  /** Tools that must never run - the check that a floor or a gate actually stopped something. */
  readonly toolsExclude?: readonly string[];
  /** Where the task ended up: completed, awaiting_user for an approval, failed. */
  readonly status?: string;
  /** The verification status the completion carries. */
  readonly verification?: 'verified' | 'not_applicable';
  /** Whether the owner was asked to approve something, and what for. */
  readonly askedOwner?: boolean;
  /**
   * How many commands the workspace actually ran, which separates the two orders of declaring an
   * acceptance record: declared first, the harness runs the checks twice - once to watch them fail
   * on the unfinished job and once at the finish. Declared after the work, the baseline is skipped
   * and the finish is the only run there ever was.
   */
  readonly commandsRun?: number;
  /** Every hold the harness fired, in the order it fired them. */
  readonly holds?: readonly HoldName[];
  /** Whether the boilerplate fallback plan was written for a task that never asked for one. */
  readonly fallbackPlan?: boolean;
  /** Whether untrusted content was recorded as having entered the turn. */
  readonly untrusted?: boolean;
  /** How many separate replies the owner sees. One answer should arrive as one bubble. */
  readonly replies?: number;
}

export interface Fixture {
  readonly id: string;
  readonly shape: FixtureShape;
  /** The owner's words, as they would arrive. */
  readonly request: string;
  /** What this fixture protects, in prose: what breaks, or costs more, if it changes. */
  readonly why: string;
  readonly model: ModelScript;
  readonly runner?: RunnerStub;
  /** The step ceiling in force, when the fixture is about what happens at one. */
  readonly maxSteps?: number;
  readonly expect: Expectation;
}

/* ------------------------------------------------------------------------------ what is watched */

/**
 * The holds this suite can see, and the string each is recognised by.
 *
 * These are markers in messages the loop pushes back to the model rather than an enum the loop
 * exports, which is the one place this harness is coupled to wording. It is deliberate and it is
 * narrow: a fixture never asserts on the sentence, only on which hold fired and how many model
 * calls it cost. If a marker below stops matching, every fixture that expects that hold fails at
 * once - which is the loud failure, not the silent one.
 */
const HOLD_MARKERS: ReadonlyArray<readonly [HoldName, string]> = [
  ['finish_rejected', 'Finish rejected (attempt'],
  ['plan_hold', 'Finish held: '],
  ['acceptance_hold', 'Finish held: this turn changed'],
  ['silence_hold', 'Finish held: this turn has not said'],
  ['acceptance_failed', 'Finish refused (acceptance '],
  ['completion_nag', 'COMPLETION CHECK ('],
  ['baseline_refused', 'every one of them already passes'],
  ['repetition_stopped', 'began repeating'],
  ['output_limit_continued', 'CONTINUE THE ANSWER ('],
  ['step_budget', 'STEP BUDGET EXHAUSTED']
];

export type HoldName =
  | 'finish_rejected'
  | 'plan_hold'
  | 'acceptance_hold'
  | 'silence_hold'
  | 'acceptance_failed'
  | 'completion_nag'
  | 'baseline_refused'
  | 'repetition_stopped'
  | 'output_limit_continued'
  | 'step_budget';

// The acceptance hold and the plan hold share an opening, so the longer marker is tried first.
const ORDERED_MARKERS = [...HOLD_MARKERS].sort((left, right) => right[1].length - left[1].length);

const holdsIn = (messages: readonly string[]): { holds: HoldName[]; pushback: string[] } => {
  const holds: HoldName[] = [];
  const pushback: string[] = [];
  for (const message of messages) {
    const match = ORDERED_MARKERS.find(([, marker]) => message.includes(marker));
    if (!match) continue;
    holds.push(match[0]);
    pushback.push(message);
  }
  return { holds, pushback };
};

export interface RunOutcome {
  /** Provider calls, which is what a step costs and what the owner is billed for. */
  readonly modelCalls: number;
  /** The prompt athanor built, in tokens, by its own estimate, summed over every call. */
  readonly promptTokens: number;
  /** The largest single prompt, which is what decides whether a long task fits its window. */
  readonly peakPromptTokens: number;
  readonly tools: readonly string[];
  readonly proposed: readonly string[];
  readonly finalCatalogue: readonly string[];
  readonly commandsRun: number;
  readonly holds: readonly HoldName[];
  /** What the loop actually said back, in full, for the runs that need explaining. */
  readonly pushback: readonly string[];
  readonly status: string;
  readonly verification: string;
  readonly askedOwner: boolean;
  readonly fallbackPlan: boolean;
  readonly untrusted: boolean;
  readonly replies: number;
  /** Anything that escaped the loop, which is a fixture that ran off its own script. */
  readonly error: string | null;
}

/* -------------------------------------------------------------------------------- the run itself */

const workspace: WorkspaceRecord = {
  id: workspaceId,
  userId,
  name: 'Study',
  status: 'running',
  storageBytes: 1_000,
  storageLimitBytes: 1_000_000,
  imageRevision: 'r1',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId),
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const model: ModelRelease = {
  id: 'model-1',
  providerModelId: 'vendor/model-1',
  displayName: 'Model One',
  provider: 'custom',
  revision: 'r1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools', 'reasoning'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.8,
  measuredLatencyMs: 100,
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const taskFor = (prompt: string): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  scheduleId: null,
  rewindScope: null,
  restoredCheckpointId: null,
  titleCiphertext: null,
  legacyTitle: null,
  titleSource: 'prompt',
  pinned: false,
  archivedAt: null,
  status: 'running',
  modelId: model.id,
  privacyRoute: 'provider_zdr',
  securityMode: 'balanced',
  maxComputeCredits: 50,
  actualComputeCredits: 0,
  maxSpendUsd: null,
  spentUsd: 0,
  queuedMessageCount: 0,
  promptCiphertext: encryptJson({ prompt }, dataKey, `task-prompt:${taskId}`),
  agentStateCiphertext: null,
  leaseOwner: 'worker-test',
  leaseExpiresAt: '2026-07-01T00:02:00.000Z',
  attempt: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

export const runFixture = async (fixture: Fixture): Promise<RunOutcome> => {
  const task = taskFor(fixture.request);
  const events: Array<{ kind: string; summary: string; payload: unknown }> = [];
  const approvals: string[] = [];
  let finalStatus = 'running';
  let plan: Record<string, unknown> | null = null;
  let fallbackPlan = false;

  const store = {
    getWorkspaceById: async () => workspace,
    listConnectors: async () => [],
    listModels: async () => [model],
    getManagedProviderCredential: async () => null,
    listWorkspaceMemories: async () => [],
    curateWorkspaceSkills: async () => undefined,
    listWorkspaceSkills: async () => [],
    getLatestTaskPlan: async () => plan,
    createTaskPlan: async (input: Record<string, unknown>) => {
      // The boilerplate fallback is recognised structurally rather than by what it says: it is the
      // plan that appears when the model never asked for one. The loop writes it at the start of any
      // step past the second, or of any step after the turn has changed something, and from then on
      // it travels in every prompt - so "did this task acquire a plan nobody wrote?" is a question
      // about the model's calls, not about the plan's contents.
      if (!proposed.includes('set_plan')) fallbackPlan = true;
      const version = Number(plan?.version ?? 0);
      if (Number(input.expectedVersion) !== version) throw new Error('plan_version_conflict');
      plan = {
        id: 'plan',
        taskId,
        version: version + 1,
        parentVersion: version || null,
        branchName: asText(input.branchName) || 'Main',
        stepsCiphertext: input.stepsCiphertext,
        createdBy: input.createdBy ?? 'agent',
        createdAt: '2026-07-01T00:00:00.000Z'
      };
      return plan;
    },
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task,
    taskClaim: async () => ({ status: task.status, leaseOwner: task.leaseOwner ?? null }),
    updateTask: async (input: Record<string, unknown>) => {
      if (typeof input.status === 'string') finalStatus = input.status;
      return task;
    },
    renewTaskLease: async () => true,
    appendTaskEvent: async (input: {
      kind: string;
      payloadCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({ kind: input.kind, summary: body.summary, payload: body.payload });
      return { id: 'event', sequence: events.length };
    },
    createAgentNotification: async (input: Record<string, unknown>) => ({
      id: 'notification',
      ...input
    }),
    createApproval: async (input: { action?: unknown }) => {
      approvals.push(asText(input.action));
      return `approval-${approvals.length}`;
    },
    recordUsage: async () => undefined,
    mediaSpendForTask: async () => 0,
    spendGuard: async () => ({
      outcome: 'allow' as const,
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    }),
    effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
    setWorkspaceStorage: async () => undefined,
    transitionUsage: async () => undefined,
    getNextQueuedTaskMessage: async () => null,
    createMemoryItem: async () => ({ id: 'item' }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => undefined,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => null,
    recordMemoryUse: async () => 0,
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => input,
    deleteWorkspaceCheckpoints: async () => 0,
    completeTaskIfNoQueued: async () => {
      finalStatus = 'completed';
      return true;
    },
    consolidateMemory: async () => undefined
  } as unknown as DataStore;

  const modelRequests: Array<Record<string, unknown>> = [];
  const proposed: string[] = [];
  const execState = { execs: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith(PROVIDER_URL)) {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      modelRequests.push(body);
      const messages = ((body.messages ?? []) as Array<{ content?: unknown }>).map((message) =>
        typeof message.content === 'string' ? message.content : ''
      );
      const turn = fixture.model({
        index: modelRequests.length - 1,
        lastMessage:
          [...messages].reverse().find((content) => !content.startsWith(RUNTIME_CONTEXT_MARKER)) ??
          '',
        messages
      });
      for (const call of turn.calls ?? []) proposed.push(call.name);
      return new Response(streamOf(framesFor(turn), init?.signal), {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    return runnerResponse(fixture.runner ?? {}, execState, url, init);
  }) as typeof fetch;

  let error: string | null = null;
  try {
    await new AgentWorker(
      store,
      {
        WORKER_ID: 'worker-eval',
        DATABASE_DRIVER: 'pglite',
        DATABASE_URL: 'postgres://localhost/athanor',
        PGLITE_PATH: ':memory:',
        DATA_MASTER_KEY: masterKey.toString('base64'),
        RUNNER_SHARED_SECRET: 'x'.repeat(48),
        WORKSPACE_RUNNER_URL: RUNNER_URL,
        PREVIEW_BASE_URL: 'http://preview.localhost:4400',
        OPENROUTER_BASE_URL: PROVIDER_URL,
        AI_PROVIDER: 'openai-compatible',
        AI_BASE_URL: PROVIDER_URL,
        AI_API_KEY: 'provider-key',
        AI_REQUIRE_ZDR: false,
        // Pinned so a search is answered by the workspace's own browser on every fixture. Which
        // host answers a search is a policy decision with its own tests; what these fixtures are
        // about is what the loop does with the rows, and leaving it to policy would make the
        // research fixtures cost a different number of provider calls when that policy moves.
        AI_FORCE_INHOUSE_WEB: true,
        ALLOW_INSECURE_PROVIDER_URLS: true,
        PUBLIC_APP_URL: 'http://localhost:5173',
        CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
        WORKER_CONCURRENCY: 2,
        WORKER_POLL_MS: 1_000,
        TASK_MAX_STEPS: fixture.maxSteps ?? 12,
        // A turn that renews its own budget is a separate mechanism with its own bounds. Left off
        // so every step count below is the cost of one budget rather than of two.
        TASK_MAX_SELF_CONTINUATIONS: 0
      },
      masterKey,
      runnerSecret
    ).run(task);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    globalThis.fetch = original;
  }

  const costs = events
    .filter((entry) => entry.kind === 'cost')
    .map(
      (entry) =>
        Number(
          (entry.payload as { context?: { estimatedInputTokens?: unknown } } | undefined)?.context
            ?.estimatedInputTokens
        ) || 0
    );
  const everyMessage = modelRequests.flatMap((request) =>
    ((request.messages ?? []) as Array<{ content?: unknown }>).map((message) =>
      typeof message.content === 'string' ? message.content : ''
    )
  );
  const completion = [...events].reverse().find((entry) => entry.kind === 'completed');

  return {
    modelCalls: modelRequests.length,
    promptTokens: costs.reduce((total, value) => total + value, 0),
    peakPromptTokens: costs.reduce((peak, value) => Math.max(peak, value), 0),
    tools: events
      .filter((entry) => entry.kind === 'tool_started')
      .map((entry) => asText((entry.payload as { tool?: unknown }).tool)),
    proposed,
    commandsRun: execState.execs,
    finalCatalogue: (
      (modelRequests.at(-1)?.tools ?? []) as Array<{ function?: { name?: unknown } }>
    ).map((tool) => asText(tool.function?.name)),
    // Deduplicated in order: a hold pushes one message that then travels in every later request, so
    // the raw scan would count the same hold once per remaining step.
    ...holdsIn([...new Set(everyMessage)]),
    status: finalStatus,
    verification:
      asText(
        (completion?.payload as { verification?: { status?: unknown } } | undefined)?.verification
          ?.status
      ) || 'none',
    askedOwner: approvals.length > 0,
    fallbackPlan,
    untrusted: events.some(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    ),
    replies: events.filter((entry) => entry.kind === 'assistant_message').length,
    error
  };
};

export const evidence = (id: string, claim: string): Record<string, unknown> => ({
  status: 'verified',
  evidence: [{ claim, source: 'tool_result', toolCallId: id }],
  remainingRisks: []
});

export const conversational = (): Record<string, unknown> => ({
  status: 'not_applicable',
  evidence: [],
  remainingRisks: []
});
