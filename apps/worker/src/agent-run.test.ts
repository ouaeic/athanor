import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AthanorError,
  decryptJson,
  encryptJson,
  generateDataKey,
  wrapDataKey
} from '@athanor/core';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@athanor/data';
import type { ModelRelease } from '@athanor/contracts';
import {
  ACCEPTANCE_EARLIER_TURN_CAVEAT,
  AgentWorker,
  approvalPreviewHash,
  DELEGATE_MAX_STEPS,
  MAX_NOTICES_PER_TURN,
  startTurnState,
  UNTRUSTED_NOTICE_MARKER
} from './agent.js';
import { RUNTIME_CONTEXT_MARKER } from './context.js';
import { managedMediaCatalog } from './media.js';
import { memoryItemAad, MEMORY_PACK_MARKER } from './memory-runtime.js';
import { agentTools } from './tools.js';
import type { WorkerConfig } from './config.js';

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';

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

const config = (
  overrides: Partial<WorkerConfig> = {}
): Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'> => ({
  WORKER_ID: 'worker-test',
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
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: true,
  PUBLIC_APP_URL: 'http://localhost:5173',
  CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
  WORKER_CONCURRENCY: 2,
  WORKER_POLL_MS: 1_000,
  TASK_MAX_STEPS: 1,
  // Off unless a test asks for it, so every existing expectation about what happens at the step
  // ceiling still describes a turn that stops there.
  TASK_MAX_SELF_CONTINUATIONS: 0,
  ...overrides
});

interface StoreProbe {
  readonly store: DataStore;
  readonly checkpoints: Array<Record<string, unknown>>;
  readonly renewals: number[];
  readonly events: Array<{
    kind: string;
    summary: string;
    payload: unknown;
    /** Whether the write also asked the store to drop the frames this row carries the whole of. */
    replacesEarlierFrames?: boolean;
  }>;
  /** What was queued for the owner's devices, as opposed to written into the conversation. */
  readonly notifications: Array<{ kind: string; message: string }>;
  /** Turn checkpoints recorded against the workspace, as opposed to persisted agent state. */
  readonly undoPoints: Array<Record<string, unknown>>;
  readonly forgottenUndoPoints: string[][];
  /** Episode bodies the finished turn deposited, which is what a later task recalls it as. */
  readonly episodes: string[];
  /** The grade each injected item was given, which is what procedure health is computed from. */
  readonly memoryUses: Array<{ itemIds: string[]; outcome: string }>;
  /** Seeds the pack this task recalled, so the grade the turn writes on it is observable. */
  readonly recallPack: (itemIds: string[]) => void;
}

interface AgentStateShape {
  messages: Array<{ role: string; content: string; toolCallId?: string }>;
  inFlight?: { toolCallId: string; tool: string; startedAt: string };
  step: number;
}

const probeStore = (task: () => TaskRecord): StoreProbe => {
  const checkpoints: Array<Record<string, unknown>> = [];
  const renewals: number[] = [];
  const events: StoreProbe['events'] = [];
  const notifications: Array<{ kind: string; message: string }> = [];
  const undoPoints: Array<Record<string, unknown>> = [];
  const forgottenUndoPoints: string[][] = [];
  const episodes: string[] = [];
  const memoryUses: Array<{ itemIds: string[]; outcome: string }> = [];
  let memoryPack: Record<string, unknown> | null = null;
  let sources = 0;
  const store = {
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => {
      undoPoints.push(input);
      return input;
    },
    deleteWorkspaceCheckpoints: async (_workspaceId: string, ids: string[]) => {
      forgottenUndoPoints.push(ids);
      return ids.length;
    },
    getWorkspaceById: async () => workspace,
    // Nothing connected, which is what a fresh box looks like: connector_action is left out of the
    // catalogue rather than described and unusable.
    listConnectors: async () => [],
    listModels: async () => [model],
    getManagedProviderCredential: async () => null,
    listWorkspaceMemories: async () => [],
    curateWorkspaceSkills: async () => undefined,
    listWorkspaceSkills: async () => [],
    getLatestTaskPlan: async () => null,
    // The worker treats a version conflict as "a newer plan exists", which keeps this probe out of
    // the plan-encryption path without changing any branch the tests care about.
    createTaskPlan: async () => {
      throw new Error('plan_version_conflict');
    },
    // The run asks the opening event where the task came from, because a scheduled run and a run
    // the owner is watching are told different things about staying quiet.
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task(),
    // The narrow read the stop watch polls while a model request streams. It answers from the same
    // task the run is built on, so a test that pauses the task stops the request too.
    taskClaim: async () => {
      const current = task();
      return { status: current.status, leaseOwner: current.leaseOwner ?? null };
    },
    updateTask: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
      return task();
    },
    renewTaskLease: async (_id: string, _worker: string, seconds: number) => {
      renewals.push(seconds);
      return true;
    },
    appendTaskEvent: async (input: {
      kind: string;
      payloadCiphertext: Parameters<typeof decryptJson>[0];
      replacesEarlierFrames?: boolean;
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({
        kind: input.kind,
        summary: body.summary,
        payload: body.payload,
        ...(input.replacesEarlierFrames ? { replacesEarlierFrames: true } : {})
      });
      return { id: 'event', sequence: events.length };
    },
    // The other end of a notice: the row the notifier reads to reach a phone. The conversation
    // event and this are written together, and a test that only saw the event could not tell the
    // difference between a notice the owner receives and one that never leaves the machine.
    createAgentNotification: async (input: {
      userId: string;
      taskId: string;
      kind: string;
      messageCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ message: string }>(input.messageCiphertext, dataKey);
      notifications.push({ kind: input.kind, message: body.message });
      return {
        id: `notification-${notifications.length}`,
        userId: input.userId,
        taskId: input.taskId,
        kind: input.kind,
        messageCiphertext: input.messageCiphertext,
        createdAt: new Date().toISOString()
      };
    },
    recordUsage: async () => undefined,
    // The money ceiling is consulted before every step, so a probe that omits it fails every test
    // here with a type error rather than the behaviour under test.
    spendGuard: async () => ({
      outcome: 'allow' as const,
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    }),
    // The owner's time zone reaches the prompt through the spend limits that already store it, so
    // a probe without it starts every task in UTC rather than in the owner's day.
    effectiveSpendLimits: async () => ({ timeZone: 'Europe/London' }),
    setWorkspaceStorage: async () => undefined,
    transitionUsage: async () => undefined,
    getNextQueuedTaskMessage: async () => null,
    // What the turn deposits in memory. Capture has its own try/catch inside the agent, so a probe
    // missing these methods logs one warning and records nothing - which is why the label a turn
    // files itself under went unwatched for so long.
    createMemoryItem: async (input: {
      kind: string;
      documentCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      if (input.kind === 'episode')
        episodes.push(
          decryptJson<{ body: string }>(
            input.documentCiphertext,
            dataKey,
            `memory-item:${workspaceId}`
          ).body
        );
      return { id: 'item' };
    },
    createMemorySource: async () => {
      sources += 1;
      return { id: `source-${sources}` };
    },
    attachMemoryEvidence: async () => undefined,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => memoryPack,
    recordMemoryUse: async (input: { itemIds: readonly string[]; outcome: string }) => {
      memoryUses.push({ itemIds: [...input.itemIds], outcome: input.outcome });
      return input.itemIds.length;
    },
    // It carries the closing agent state, which is the copy the next turn resumes from - so a probe
    // that dropped it could not see what a finished turn actually left behind.
    completeTaskIfNoQueued: async (input: Record<string, unknown>) => {
      checkpoints.push(input);
      return true;
    },
    consolidateMemory: async () => undefined
  };
  return {
    store: store as unknown as DataStore,
    checkpoints,
    renewals,
    events,
    notifications,
    undoPoints,
    forgottenUndoPoints,
    episodes,
    memoryUses,
    recallPack: (itemIds: string[]) => {
      memoryPack = {
        taskId,
        workspaceId,
        briefVersion: null,
        bodyCiphertext: encryptJson(
          { body: '# MEMORY PACK\n- `make notes` tidies the notes directory' },
          dataKey,
          `memory-pack:${taskId}`
        ),
        sha256: 'pack',
        itemIds,
        tokensEst: 12,
        createdAt: '2026-07-01T00:00:00.000Z'
      };
    }
  };
};

const decryptCheckpoints = (checkpoints: Array<Record<string, unknown>>): AgentStateShape[] =>
  checkpoints.flatMap((input) =>
    input.agentStateCiphertext
      ? [
          decryptJson<AgentStateShape>(
            input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
            dataKey
          )
        ]
      : []
  );

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const textFrame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content } }] })}\n\ndata: [DONE]\n\n`;

/** The thinking arriving on its own channel ahead of the answer, as a reasoning route sends it. */
const thoughtsThenTextFrame = (thoughts: string[], content: string): string =>
  [
    ...thoughts.map(
      (reasoning) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning } }] })}\n\n`
    ),
    textFrame(content)
  ].join('');

/** A completion that was never streamed, which is what a delegated specialist's own calls read. */
const completion = (message: Record<string, unknown>): string =>
  JSON.stringify({
    choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  });

const toolFrame = (id: string, name: string, args: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }]
        }
      }
    ]
  })}\n\ndata: [DONE]\n\n`;

const makeTask = (agentState?: unknown): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  // A conversation the owner started, which is what every test in this file is about. The worker
  // never reads this - it is provenance the sidebar folds runs of one schedule by - but the record
  // declares it, so the fixture has to say which kind of conversation it is standing in for.
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
  maxComputeCredits: 5,
  actualComputeCredits: 0,
  maxSpendUsd: null,
  spentUsd: 0,
  queuedMessageCount: 0,
  promptCiphertext: encryptJson({ prompt: 'Tidy the notes' }, dataKey, `task-prompt:${taskId}`),
  agentStateCiphertext: agentState
    ? encryptJson(agentState, dataKey, `task-state:${taskId}`)
    : null,
  leaseOwner: 'worker-test',
  leaseExpiresAt: '2026-07-01T00:02:00.000Z',
  attempt: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

interface FetchLog {
  readonly calls: string[];
  readonly modelRequests: Array<Record<string, unknown>>;
  /** Bodies sent to the workspace runner, for the tests that care what a tool actually asked for. */
  readonly runnerRequests?: Array<{ url: string; body: unknown }>;
  /** Generation requests, which reach the same host as inference but a different route. */
  readonly mediaRequests?: Array<Record<string, unknown>>;
}

const checkpointResponse = (pruned: string[] = []): Response =>
  new Response(
    JSON.stringify({
      id: 'checkpoint',
      mechanism: 'content',
      createdAt: '2026-07-01T00:00:00.000Z',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 128,
      changedFileCount: 2,
      uncoveredFileCount: 0,
      durationMs: 21,
      pruned
    }),
    { headers: { 'content-type': 'application/json' } }
  );

/** Serves the provider and the workspace runner from one stub so call ordering stays observable. */
const installFetch = (
  // A body factory is handed the request init so a stub can behave like a real connection does:
  // undici errors an in-flight response stream when the request's signal aborts, and a test that
  // ignores the signal cannot tell a request that was torn down from one that ran to completion.
  providerBodies: Array<BodyInit | ((init?: RequestInit) => BodyInit)>,
  log: FetchLog,
  runner: {
    checkpoint?: () => Response;
    // Handed the request init for the same reason the provider bodies are: a runner call that is
    // torn down mid-flight - by a Stop, by a cancel - errors its response stream, and a stub that
    // never sees the signal cannot tell that apart from a call that ran to completion.
    route?: (url: string, init?: RequestInit) => Response | undefined;
    media?: () => Response;
  } = {}
): void => {
  let served = 0;
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    log.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith(PROVIDER_URL)) {
      // Generation is an ordinary request to the configured provider, so it arrives here too. It
      // is answered from its own stub: routing it to the inference frames would hand a media call
      // an SSE body and make the next model step read someone else's turn.
      if (url.endsWith('/images') || url.endsWith('/audio/speech')) {
        if (typeof init?.body === 'string')
          log.mediaRequests?.push(JSON.parse(init.body) as Record<string, unknown>);
        return (
          runner.media ??
          (() =>
            new Response(
              JSON.stringify({
                data: [{ b64_json: Buffer.from('generated').toString('base64') }],
                usage: { cost: 0.0102 }
              }),
              { headers: { 'content-type': 'application/json' } }
            ))
        )();
      }
      if (typeof init?.body === 'string')
        log.modelRequests.push(JSON.parse(init.body) as Record<string, unknown>);
      const next = providerBodies[Math.min(served, providerBodies.length - 1)];
      served += 1;
      return new Response(typeof next === 'function' ? next(init) : (next ?? ''), {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    if (log.runnerRequests && typeof init?.body === 'string')
      log.runnerRequests.push({ url, body: JSON.parse(init.body) as unknown });
    const routed = runner.route?.(url, init);
    if (routed) return routed;
    if (url.includes('/checkpoints')) return (runner.checkpoint ?? checkpointResponse)();
    if (url.includes('/file'))
      return init?.method === 'PUT'
        ? new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          })
        : new Response('', { status: 404 });
    return new Response(JSON.stringify({ ok: true, storageBytes: 2_048 }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the model call and the task lease', () => {
  it('renews the lease while the provider is still answering', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let release = (): void => undefined;
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              requested();
              release = (): void => {
                controller.enqueue(encode(textFrame('still here')));
                controller.close();
              };
            }
          }),
        // The closing handoff call. Without a body of its own it would reuse the stream above,
        // which is deliberately held open, and the run would never settle.
        textFrame('Out of steps.')
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task).catch((error: unknown) => error);
    await modelRequested;
    expect(probe.renewals).toHaveLength(0);

    // Longer than the 45 s renewal interval and far shorter than the 15-minute request deadline:
    // the lease is 120 s, so without this the task is stealable while the model is still talking.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(probe.renewals.length).toBeGreaterThanOrEqual(1);
    expect(probe.renewals[0]).toBe(120);

    release();
    await running;
  });

  it('marks the cacheable prefix on the wire, on the route the catalogue described', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Done.')], log);
    /*
     * The routing fields are deliberately kept off the owner-facing model shape and carried
     * alongside it, which is exactly how `store.listModels` returns them and how the worker
     * receives them - so the catalogue entry is built the same way here.
     */
    const cachingRoute = { ...model, promptCacheStyle: 'explicit' as const };

    await new AgentWorker(
      { ...probe.store, listModels: async () => [cachingRoute] } as unknown as typeof probe.store,
      config(),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    const sent = (log.modelRequests[0]?.messages ?? []) as Array<{ content: unknown }>;
    const marked = sent.filter(
      (message) =>
        Array.isArray(message.content) &&
        (message.content as Array<Record<string, unknown>>).some((block) => block.cache_control)
    );
    /*
     * The whole breakpoint apparatus in context.ts was computed on every step, counted into the
     * cost event, and then dropped on the floor: nothing carried the route's cache style from the
     * catalogue entry onto the request, so the adapter fell back to a two-vendor slug list and
     * marked nothing. Measured on one twenty-step task, thirteen steps cached nothing at all and
     * 187,014 of 289,514 input tokens were billed at full rate against a fixed head of about
     * 12,000 that only ever needed paying for once. Asserted on the request body rather than on
     * the helper, because the helper was never what was broken.
     */
    expect(marked.length).toBeGreaterThan(0);
  });

  it('tears down the request in flight when the owner stops the task', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    let torn = false;
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              // Part of an answer arrives, and then the provider keeps writing - which is the whole
              // shape of the complaint: Stop said the task had stopped and the text kept coming.
              controller.enqueue(encode(textFrame('Half a sen')));
              requested();
              init?.signal?.addEventListener('abort', () => {
                torn = true;
                controller.error(new Error('aborted'));
              });
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    task.status = 'cancelled';
    task.leaseOwner = null;

    // Longer than the stop poll, far shorter than the 15-minute request deadline.
    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    expect(torn).toBe(true);
    // One request. The turn ends here rather than looping into another step on the owner's money.
    expect(log.modelRequests).toHaveLength(1);
    // The words the owner watched being written are kept; no reply is published after the stop.
    expect(probe.events.some((event) => event.kind === 'assistant_delta')).toBe(true);
    expect(probe.events.some((event) => event.kind === 'assistant_message')).toBe(false);
    expect(probe.events.at(-1)).toMatchObject({
      kind: 'status',
      summary: 'Task cancelled by user'
    });
    // ...and the trajectory is saved, unguarded, because the cancel already cleared the lease.
    const closing = probe.checkpoints.at(-1);
    expect(closing).toMatchObject({ status: 'cancelled', clearLease: true });
    expect(closing?.agentStateCiphertext).toBeDefined();
    expect(closing?.workerId).toBeUndefined();
  });

  it('stands down in silence when another worker has taken the task', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let requested = (): void => undefined;
    const modelRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    installFetch(
      [
        (init) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              requested();
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            }
          })
      ],
      log
    );
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    const running = worker.run(task);
    await modelRequested;
    const before = probe.events.length;
    // A pause that was resumed inside the poll window: the resume cleared the lease and set the
    // status back to queued, and a second worker took it while this one was still generating. It is
    // then stopped again, so this worker reads the owner's own stop on a task that is no longer its
    // to record - the one case where honouring it would write over somebody else's trajectory.
    task.status = 'cancelled';
    task.leaseOwner = 'another-worker';

    await vi.advanceTimersByTimeAsync(4_000);
    await running;

    // Not a word and not a write. Everything this run could say now would land on the trajectory
    // the other claimant is building, and the closing write is unguarded - it would take their
    // lease with it and leave them generating into a task nothing they write can reach.
    expect(probe.events).toHaveLength(before);
    expect(probe.checkpoints.every((checkpoint) => checkpoint.status !== 'cancelled')).toBe(true);
    expect(log.modelRequests).toHaveLength(1);
  });

  it('closes the streamed thinking with one row carrying the whole of it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [thoughtsThenTextFrame(['Let me ', 'check the notes ', 'first.'], 'Tidied.')],
      log
    );

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Nothing ever superseded these the way the closing message supersedes the answer's frames, so
    // a step that thought for the better part of a minute left a few hundred encrypted rows behind
    // for good - and had them read back and decrypted on every reopen of the conversation.
    const thinking = probe.events.filter((event) => event.kind === 'assistant_reasoning');
    expect(thinking.at(-1)).toMatchObject({
      payload: { markdown: 'Let me check the notes first.', replace: true },
      replacesEarlierFrames: true
    });
    expect(thinking.slice(0, -1).every((event) => !event.replacesEarlierFrames)).toBe(true);
  });
});

describe('a tool call interrupted by a restart', () => {
  it('records the intent durably before the tool runs', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'shell', { executable: 'ls', args: ['-la'] })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    const beforeExec = probe.checkpoints.findIndex((input) => {
      if (!input.agentStateCiphertext) return false;
      const state = decryptJson<AgentStateShape>(
        input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
        dataKey
      );
      return state.inFlight?.toolCallId === 'call-1';
    });
    expect(beforeExec).toBeGreaterThanOrEqual(0);
    const states = decryptCheckpoints(probe.checkpoints);
    // Written, and cleared again, around the call - so a worker that dies inside it leaves the
    // record set and one that survives leaves no stale claim behind.
    expect(states.some((state) => state.inFlight?.tool === 'shell')).toBe(true);
    expect(states.at(-1)?.inFlight).toBeUndefined();
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(true);
  });

  it('leaves a read-only tool unmarked, so a restart raises no doubt about it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-2', 'files_list', { path: 'workspace' })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(decryptCheckpoints(probe.checkpoints).every((state) => !state.inFlight)).toBe(true);
  });

  it('does not repeat a shell tool that was already in flight, and tells the model why', async () => {
    const interruptedState = {
      messages: [
        { role: 'user', content: 'Publish the report' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-9', name: 'shell', arguments: { executable: 'curl', args: ['-d', 'x'] } },
            { id: 'call-10', name: 'files_list', arguments: {} }
          ]
        }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {},
      inFlight: { toolCallId: 'call-9', tool: 'shell', startedAt: '2026-07-01T00:01:00.000Z' }
    };
    const task = makeTask(interruptedState);
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Let me check whether that already happened.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
    const messages = (log.modelRequests[0]?.messages ?? []) as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;
    const answer = messages.find((message) => message.tool_call_id === 'call-9');
    expect(answer?.content).toContain('Interrupted');
    expect(answer?.content).toContain('may not have');
    // The calls behind it never ran at all, and say so rather than being left dangling.
    expect(messages.find((message) => message.tool_call_id === 'call-10')?.content).toContain(
      'Not executed'
    );
    expect(
      probe.events.some(
        (entry) => entry.kind === 'warning' && entry.summary.includes('interrupted by a restart')
      )
    ).toBe(true);
  });

  it('answers calls a mid-batch restart left dangling, so the next request is still valid', async () => {
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Tidy the notes' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call-3', name: 'files_list', arguments: {} },
            { id: 'call-4', name: 'file_read', arguments: { path: 'workspace/a.md' } }
          ]
        },
        { role: 'tool', toolCallId: 'call-3', content: '{"entries":[]}' }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {}
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Picking up where that left off.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const messages = (log.modelRequests[0]?.messages ?? []) as Array<{
      content: string;
      tool_call_id?: string;
    }>;
    // A provider rejects any history whose tool_calls block has an unanswered call, so leaving one
    // behind would strand the task rather than resume it.
    expect(messages.find((message) => message.tool_call_id === 'call-4')?.content).toContain(
      'Not executed'
    );
    expect(messages.find((message) => message.tool_call_id === 'call-3')?.content).toContain(
      'entries'
    );
  });
});

describe('the undo point a turn leaves behind', () => {
  const twoToolFrame = (): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-a',
                function: { name: 'shell', arguments: JSON.stringify({ executable: 'ls' }) }
              },
              {
                index: 1,
                id: 'call-b',
                function: {
                  name: 'file_write',
                  arguments: JSON.stringify({ path: 'workspace/a.txt', content: 'x' })
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  it('checkpoints the computer once, before the first call that could change it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([twoToolFrame()], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const checkpointCalls = log.calls.filter((call) => call.includes('/checkpoints'));
    expect(checkpointCalls).toHaveLength(1);
    // In front of the work, not behind it: a checkpoint taken after the shell call would hold the
    // state the owner is trying to get away from.
    expect(log.calls.indexOf(checkpointCalls[0]!)).toBeLessThan(
      log.calls.findIndex((call) => call.includes('/exec'))
    );
    expect(probe.undoPoints).toHaveLength(1);
    expect(probe.undoPoints[0]).toMatchObject({
      workspaceId,
      taskId,
      turn: 0,
      mechanism: 'content',
      fileCount: 12,
      storedBytes: 128
    });
  });

  it('costs a turn that only reads nothing at all', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-r', 'files_list', { path: 'workspace' })], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/checkpoints'))).toBe(false);
    expect(probe.undoPoints).toEqual([]);
  });

  it('forgets the checkpoints the runner pruned in the same breath', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-p', 'shell', { executable: 'ls' })], log, {
      checkpoint: () => checkpointResponse(['old-checkpoint-1', 'old-checkpoint-2'])
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    expect(probe.forgottenUndoPoints).toEqual([['old-checkpoint-1', 'old-checkpoint-2']]);
  });

  it('carries on when the computer cannot be checkpointed, and says so where it shows', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-f', 'shell', { executable: 'ls' })], log, {
      checkpoint: () =>
        new Response(JSON.stringify({ error: { message: 'Host disk is too full' } }), {
          status: 507,
          headers: { 'content-type': 'application/json' }
        })
    });
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);

    await worker.run(task).catch(() => undefined);

    // The work the owner asked for still happens; what they lose is the ability to rewind it, and
    // that has to be visible rather than inferred from a missing entry.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(true);
    expect(probe.undoPoints).toEqual([]);
    const warning = probe.events.find(
      (entry) => entry.summary === 'This turn has no undo point for the computer'
    );
    expect(warning?.kind).toBe('warning');
    expect(String((warning?.payload as { message?: string })?.message)).toContain('507');
    // A full disk is the one cause of this the owner can clear, so it is raised to them.
    expect((warning?.payload as { owner?: boolean })?.owner).toBe(true);
  });

  it('files the same loss quietly when the reason is not the owner’s to fix', async () => {
    // Measured: writing a two-line haiku put this card at the top of the transcript, above the
    // verse, because the runner could not take a checkpoint. Nothing about that is the owner's
    // business unless they are the one who can clear it.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-f', 'shell', { executable: 'ls' })], log, {
      checkpoint: () =>
        new Response(JSON.stringify({ error: { message: 'workspace is not its own dataset' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
    });

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const warning = probe.events.find(
      (entry) => entry.summary === 'This turn has no undo point for the computer'
    );
    // Still recorded - the work log holds it, and a rewind that is not on offer still has a reason.
    expect(warning?.kind).toBe('warning');
    expect((warning?.payload as { owner?: boolean })?.owner).toBeUndefined();
  });
});

describe('what actually reaches the provider', () => {
  const firstRequest = async (
    agentState?: unknown
  ): Promise<{ request: Record<string, unknown>; systemText: string }> => {
    const task = makeTask(agentState);
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('thinking')], log);
    const worker = new AgentWorker(probe.store, config(), masterKey, runnerSecret);
    await worker.run(task).catch(() => undefined);
    const request = log.modelRequests[0] ?? {};
    const messages = (request.messages ?? []) as Array<{ role: string; content: string }>;
    return {
      request,
      systemText: messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n')
    };
  };

  it('sends the whole tool catalogue on the very first step', async () => {
    // Before: sixteen tools, and no document reader, image reader, browser or media tool unless
    // one of six keyword regexes happened to match the request.
    const { request } = await firstRequest();
    const names = ((request.tools ?? []) as Array<{ function?: { name?: string } }>).map(
      (tool) => tool.function?.name
    );
    // An exact count, because the point of this test is that the model is not asked to choose from
    // an ever-growing list: adding a tool should be a deliberate act that updates this number.
    // Thirty-eight: nothing is connected on this box, so connector_action is withheld (see below);
    // media_catalog is gone, because generate_media picks the reviewed model itself; media_status
    // is gone, because a generation now returns its file rather than a receipt; and code_symbols is
    // gone, folded into code_search's wholeWord. Thirty-nine since `ask`, which is the first way
    // the model has had to put a question to the owner and stop - before it, a blocker came back as
    // a finish nobody could tell from finished work. Forty since `audio_read`: thirty-nine of them
    // could open a recording, none could hear it, so a voice memo or a meeting recording sat in the
    // workspace as bytes nothing on this computer could act on.
    expect(names).toHaveLength(40);
    expect(names).toEqual(
      expect.arrayContaining([
        'document_read',
        'image_read',
        'audio_read',
        'browser_snapshot',
        'generate_media',
        'compact_context',
        // Research, comparison and a job hunt all begin here, and until now the catalogue had no
        // way to search at all - the prompt sent the model to drive a browser at a search page.
        'web_search',
        // The retrieval store could be read once at task start and never asked a question again.
        'memory_recall',
        'notify',
        'ask'
      ])
    );
    // The catalogue is sent whole on every request and is the largest fixed cost in a turn, and
    // connector_action is the biggest tool in it - almost all of that being the declared shape of
    // mail, calendar, repository and WebDAV operations. With nothing connected none of those calls
    // can do anything but fail, so the box stops paying for the description on every step.
    expect(names).not.toContain('connector_action');
    // The way the model finds out stays, and the contract already tells it what to do with an
    // empty answer.
    expect(names).toContain('connector_list');
  });

  it('puts the built-in skill library in front of the model', async () => {
    // Nineteen vetted skills were loadable, indexable and openable, and none of it had ever
    // reached a model - while the preamble told the model to consult that index.
    const { systemText } = await firstRequest();
    expect(systemText).toContain('Built-in skills (index only');
    expect(systemText).toContain('pdf-extraction:');
    expect(systemText).toContain('skill(action=view,id=...)');
  });

  it('tells the model what day it is, in the owner’s time zone', async () => {
    const { systemText } = await firstRequest();
    expect(systemText).toMatch(/- Current time: \w+ \d+ \w+ \d{4}, \d\d:\d\d in Europe\/London/);
    expect(systemText).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  });

  it('carries exactly one operating contract, even from a window that had two', async () => {
    const doubled = {
      messages: [
        { role: 'system', content: 'You operate a persistent, private Linux cloud computer. Old.' },
        { role: 'system', content: 'You operate a persistent, private Linux cloud computer. Old.' },
        { role: 'user', content: 'Tidy the notes' }
      ],
      step: 0,
      credits: 0,
      turnToolResults: {}
    };
    const { systemText } = await firstRequest(doubled);
    expect(systemText.split('# athanor operating contract')).toHaveLength(2);
  });

  it('does not open with a plan the request never needed', async () => {
    // The generic three-step plan used to be published before the first model call on every task.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('A haiku, then.')], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(probe.events.filter((event) => event.kind === 'plan')).toEqual([]);
  });

  it('prices the opening step at full reasoning effort', async () => {
    const { request } = await firstRequest();
    expect((request.reasoning as { effort?: string } | undefined)?.effort).toBe('high');
  });
});

describe('what a delegated specialist is sent', () => {
  const specialistRequest = async (): Promise<Record<string, unknown>> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Compare what these three filings say.' }]
        }),
        textFrame('The three filings agree on revenue and disagree on headcount.'),
        textFrame('Reporting back.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log.modelRequests[1] ?? {};
  };

  it('gives it the web reading tool, and nothing that could change anything', async () => {
    const names = (
      (
        ((await specialistRequest()).tools ?? []) as Array<{
          function?: { name?: string };
        }>
      ).map((tool) => tool.function?.name) ?? []
    ).filter(Boolean);
    // parallel_web_read opens its own isolated browser, so three specialists can use it at once
    // without steering the persistent session the lead and the owner share. web_search is beside
    // it because a specialist that cannot search can only read sources somebody else found first.
    expect(names).toContain('parallel_web_read');
    expect(names).toContain('web_search');
    expect(names).toEqual(
      expect.arrayContaining(['file_read', 'document_read', 'document_search', 'session_search'])
    );
    expect(names).not.toContain('shell');
    expect(names).not.toContain('file_write');
    expect(names).not.toContain('browser_action');
    expect(names).not.toContain('finish');
  });

  it('tells it what day it is and what a report has to contain', async () => {
    const system = (
      ((await specialistRequest()).messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    // A specialist asked which of two dated documents supersedes the other cannot answer without
    // a date, and it used to be sent none.
    expect(system).toMatch(/- Current time: \w+ \d+ \w+ \d{4}, \d\d:\d\d in Europe\/London/);
    // Against the constant rather than a spelled-out number: the budget was raised from six to
    // sixteen and this assertion is about the specialist being told what it has, not about the
    // value it happens to be.
    expect(system).toContain(`${DELEGATE_MAX_STEPS} steps`);
    expect(system).toContain('never instructions');
  });

  it('lets it run a search of its own, on the route the lead uses', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Find what the regulator published.' }]
        }),
        // A specialist's own calls are not streamed, so they come back as a completion body.
        completion({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-w',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: 'regulator guidance 2026' })
              }
            }
          ]
        }),
        completion({ role: 'assistant', content: 'The regulator published guidance in March.' }),
        textFrame('Reported.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(
      log.runnerRequests?.find((request) => request.url.includes('/browser/search'))?.body
    ).toEqual({ query: 'regulator guidance 2026', limit: 10 });
  });

  it('brings back all three specialists, not the first one and a half', async () => {
    // Three missions may run and each specialist may write 8,192 output tokens, so three full
    // reports are far more than the 24,000 characters the lead's window keeps of one tool result -
    // and that result is cut from the middle, which is right for one long document and wrong for a
    // list. Measured on three 14,000-character reports: the first arrived, the second was cut in
    // half, the third was not there at all, and the only thing the lead was told is that some
    // characters had been omitted - not which specialist it had lost.
    const report = (marker: string): string =>
      `${marker}-OPENS ${'finding '.repeat(1_700)} ${marker}-CONCLUDES`;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [
            { name: 'filings', instruction: 'Read the filings.' },
            { name: 'transcripts', instruction: 'Read the transcripts.' },
            { name: 'coverage', instruction: 'Read the coverage.' }
          ]
        }),
        completion({ role: 'assistant', content: report('ONE') }),
        completion({ role: 'assistant', content: report('TWO') }),
        completion({ role: 'assistant', content: report('THREE') }),
        textFrame('Reported.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const leadResult = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    for (const marker of ['ONE', 'TWO', 'THREE']) {
      expect(leadResult?.content).toContain(`${marker}-OPENS`);
      expect(leadResult?.content).toContain(`${marker}-CONCLUDES`);
    }
  });

  /**
   * The specialist's reads are the lead's reads.
   *
   * A specialist runs its tools through the same executor as the lead but never through the lead's
   * provenance step, so the whole delegate path used to be a way around the taint model: a mission
   * that read attacker-controlled pages returned their contents, restated by a model, into a window
   * the approval floor still believed had read nothing external.
   */
  it('taints the lead with what the specialist read, and raises the floor while it holds', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'delegate', {
          missions: [{ name: 'sources', instruction: 'Read what the vendor published.' }]
        }),
        completion({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-w',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: 'vendor pricing' })
              }
            }
          ]
        }),
        completion({ role: 'assistant', content: '{"answer":"The vendor lists three tiers."}' }),
        textFrame('Reported.')
      ],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The lead's own next request is where the notice has to land: it is attached to the tool
    // result that introduced the content, because a bare system message between an assistant's
    // tool call and its result is the one shape providers reject.
    const leadResult = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    expect(leadResult?.content).toContain(UNTRUSTED_NOTICE_MARKER);
    expect(leadResult?.content).toContain('delegated specialist');
    expect(leadResult?.content).toContain('web search results');

    // And it is written down for the owner. A repeat origin across tasks is the strongest residual
    // attack against this design, and it is only visible if every transition is recorded.
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('delegated specialist');
    expect((transition?.payload as { taint?: { level?: string } } | undefined)?.taint?.level).toBe(
      'untrusted'
    );
  });
});

/**
 * The provider key, and which account's row is allowed to open it.
 *
 * The GCM tag proves the ciphertext and the AAD stored beside it were produced together; it does
 * not prove that AAD is the one the caller meant, so a row moved from one account to another
 * decrypts perfectly well unless somebody compares. The settings endpoint has always compared. The
 * worker - the side that actually spends the key - did not.
 */
describe('opening the stored inference credential', () => {
  const credentialRow = (aad: string | undefined) =>
    ({
      provider: 'inference',
      secretCiphertext: encryptJson(
        {
          provider: 'openai-compatible',
          baseUrl: PROVIDER_URL,
          apiKey: 'stored-key',
          enforceZeroDataRetention: false
        },
        masterKey,
        aad
      )
    }) as unknown as Awaited<ReturnType<DataStore['getManagedProviderCredential']>>;

  const runWithCredential = async (aad: string | undefined): Promise<FetchLog> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...probe.store,
      getManagedProviderCredential: async (_userId: string, provider: string) =>
        provider === 'inference' ? credentialRow(aad) : null
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('thinking')], log);
    await new AgentWorker(store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return log;
  };

  it('spends a key sealed for this account', async () => {
    const log = await runWithCredential(`inference-provider:${userId}`);
    expect(log.modelRequests.length).toBeGreaterThan(0);
  });

  it('refuses one sealed for a different account rather than spending it', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    // Nothing reaches the provider at all: the run fails before the first request rather than
    // authenticating with a key this account was never meant to hold.
    expect((await runWithCredential(`inference-provider:${other}`)).modelRequests).toHaveLength(0);
  });

  it('still opens a row written before the binding existed', async () => {
    // Stripping the field off an envelope that was written with one makes the tag fail, so the only
    // envelopes reaching this branch are ones whose context was never recorded anywhere.
    expect((await runWithCredential(undefined)).modelRequests.length).toBeGreaterThan(0);
  });
});

/**
 * The read path's second half.
 *
 * The memory pack is chosen once from the opening request and frozen so the cached prefix survives
 * the task. Everything a task turned out to need and did not open with was unreachable: the store
 * could be read at task start and never asked a question again, however relevant its contents.
 */
describe('asking memory a question mid-task', () => {
  const memoryDocument = (title: string, body: string) =>
    encryptJson({ title, body, tags: ['ops'] }, dataKey, `memory-item:${workspaceId}`);

  it('answers from the store and leaves out what the frozen pack already printed', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const uses: Array<{ itemIds: string[] }> = [];
    const recallInputs: Array<Record<string, unknown>> = [];
    const store = {
      ...probe.store,
      // A pack this task already holds, so the run reuses its bytes rather than re-ranking - and
      // so the recall below has something to exclude.
      getMemoryPack: async () => ({
        taskId,
        workspaceId,
        briefVersion: null,
        bodyCiphertext: encryptJson({ body: 'PACKED' }, dataKey, `memory-pack:${taskId}`),
        sha256: 'pack-sha',
        itemIds: ['mem-packed'],
        tokensEst: 10,
        createdAt: '2026-07-01T00:00:00.000Z'
      }),
      recallMemoryCandidates: async (input: Record<string, unknown>) => {
        recallInputs.push(input);
        return [
          {
            id: 'mem-new',
            layer: 'item' as const,
            kind: 'fact' as const,
            trust: 'stated' as const,
            status: 'active' as const,
            observedAt: '2026-06-01T00:00:00.000Z',
            validFrom: '2026-06-01T00:00:00.000Z',
            validTo: null,
            subjectKey: null,
            predicate: null,
            tokensEst: 8,
            score: 0.9,
            documentCiphertext: memoryDocument('WAL archive', 'Backups land on the NAS at 02:00.')
          }
        ];
      },
      recordMemoryUse: async (input: { itemIds: string[] }) => {
        uses.push(input);
      }
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'memory_recall', {
          query: 'where do the backups land',
          kinds: ['fact'],
          maxItems: 5
        }),
        textFrame('On the NAS at 02:00.')
      ],
      log
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const result = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-1');
    expect(result?.content).toContain('Backups land on the NAS at 02:00.');
    // Told what it deliberately did not return, so an empty answer reads as "nothing further"
    // rather than "nothing at all" and the agent does not ask again in different words.
    expect(result?.content).toContain('mem-packed');
    // The recall itself: relevance order rather than the pack's byte-stable order, and the ids the
    // pack already printed excluded before any channel spends a slot on them.
    const asked = recallInputs.at(-1);
    expect(asked?.order).toBe('relevance');
    expect(asked?.excludeIds).toEqual(['mem-packed']);
    expect(asked?.kinds).toEqual(['fact']);
    // A row the agent went looking for and received is a row that was used, which is what salience
    // is computed from. Whether it helped is settled later; claiming it here would grade every
    // recall a success at the moment it was made.
    expect(uses.at(-1)?.itemIds).toEqual(['mem-new']);
  });
});

/**
 * Where this run's searches go, and what the model is therefore holding.
 *
 * The decision belongs to `resolveWebToolPlan` in @athanor/contracts and to nothing else, so these
 * exercise the wiring rather than the verdict: that the worker asks once per run, offers the model
 * the same tools whichever answer it got, spends the provider's search only when the model calls
 * `web_search`, and never lets a mid-run credential edit move a task onto a route the owner was not
 * asked about.
 */
describe('the web route a run is pinned to', () => {
  const toolNames = (request: Record<string, unknown> | undefined): string[] =>
    ((request?.tools ?? []) as Array<{ type?: string; function?: { name?: string } }>)
      .map((tool) => tool.function?.name ?? tool.type)
      .filter((name): name is string => Boolean(name));

  /** An OpenRouter deployment with retention allowed, which is the only route that reaches server. */
  const serverConfig = config({
    AI_PROVIDER: 'openrouter',
    AI_REQUIRE_ZDR: false,
    AI_FORCE_INHOUSE_WEB: false,
    TASK_MAX_STEPS: 1
  });
  const openrouterModel: ModelRelease = { ...model, provider: 'openrouter' };
  const standardTask = (agentState?: unknown): TaskRecord => ({
    ...makeTask(agentState),
    privacyRoute: 'external'
  });

  const runOnce = async (
    task: TaskRecord,
    workerConfig: Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'>,
    catalog: ModelRelease[],
    /** One body, or a script of them: a search spends a provider call of its own between steps. */
    body: string | string[] = textFrame('thinking')
  ): Promise<{ log: FetchLog; probe: StoreProbe }> => {
    const probe = probeStore(() => task);
    const store = { ...probe.store, listModels: async () => catalog } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(Array.isArray(body) ? body : [body], log);
    await new AgentWorker(store, workerConfig, masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { log, probe };
  };

  /*
   * A brake that cannot answer stops the car.
   *
   * The guard's result used to be `.catch(() => null)`, and null meant "do not halt" - so one
   * transient database error removed the owner's daily ceiling for that step, silently, with
   * nothing written anywhere. The cap exists so an unattended overnight run cannot get away from
   * somebody who is asleep, and the only thing underneath it sits far above where anyone sets a
   * daily limit.
   */
  it('stops rather than spend when the spending guard cannot answer', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const updates: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      spendGuard: async () => {
        throw new Error('database is not accepting connections');
      },
      updateTask: async (input: Record<string, unknown>) => {
        updates.push(input);
        return task;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('should never be asked for')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Nothing was bought.
    expect(log.modelRequests).toHaveLength(0);
    // And the owner is told why, in a state a reply can resume.
    expect(updates.some((update) => update.status === 'paused')).toBe(true);
    const stated = probe.events.find(
      (entry) =>
        (entry.payload as { blockedBy?: string } | undefined)?.blockedBy ===
        'spend_guard_unavailable'
    );
    expect(stated?.summary).toContain('could not check this against your spending caps');
  });

  it('keeps the whole web in house on an endpoint with no search service to offer', async () => {
    // Not a privacy refusal - a capability one. Sending a provider tool name to an endpoint that
    // has never heard of it is a request that fails, so an unrecognised endpoint arrives refused.
    const { log } = await runOnce(makeTask(), config({ TASK_MAX_STEPS: 1 }), [model]);
    const request = log.modelRequests[0];
    expect(toolNames(request)).toEqual(expect.arrayContaining(['web_search', 'parallel_web_read']));
    expect(toolNames(request)).not.toContain('openrouter:web_search');
  });

  /**
   * The box this wave was written for.
   *
   * A credential that enforces zero data retention is the shipped default, and it used to take
   * provider-side search off the run - which on a server is the only search that works, because a
   * datacenter address is answered with an anti-bot challenge instead of results. The owner was
   * never offered that trade and it bought nothing: the retention promise covers inference routing
   * and says in terms that it does not cover tools, so the query sat outside it either way.
   *
   * What the run is held to instead is the disclosure, and both halves are asserted here - the
   * provider block that keeps the inference request zero-retention, and the sentence telling the
   * model its queries now leave this computer.
   */
  it('searches on the provider from a zero-retention box, and tells the run that it does', async () => {
    const { log, probe } = await runOnce(
      standardTask(),
      config({ AI_PROVIDER: 'openrouter', AI_REQUIRE_ZDR: true, TASK_MAX_STEPS: 1 }),
      [openrouterModel]
    );
    expect(toolNames(log.modelRequests[0])).toContain('web_search');
    expect(
      probe.events.find((entry) => entry.summary.includes("model provider's search service"))
    ).toBeDefined();
  });

  /**
   * The failure this whole arrangement was rebuilt to stop.
   *
   * The provider's search has no `function.name`, so no model can call it; it used to be sent in the
   * agent's own tools array with `web_search` withdrawn to make room. The model was told by its
   * operating contract to start research with a search, went looking for the search tool, and found
   * neither it nor any name for what had replaced it - so asked for three notable projects with
   * sources, it made no tool call at all and answered from memory with fabricated names, fabricated
   * dates and fabricated addresses.
   */
  it('offers the model the same catalogue on the provider route, and no tool it cannot call', async () => {
    const { log, probe } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const names = toolNames(log.modelRequests[0]);
    // The two tools the four cross-referencing descriptions send the model to, present under the
    // names those descriptions use.
    expect(names).toContain('web_search');
    expect(names).toContain('parallel_web_read');
    // And nothing the model has no way to invoke. A provider-side tool on this request would be a
    // second answerer for a question the model can already ask.
    expect(names).not.toContain('openrouter:web_search');
    expect(names).not.toContain('openrouter:web_fetch');
    expect(names).toContain('browser_action');
    expect(names).toContain('browser_snapshot');
    // The owner is told, in one sentence, where their queries now go.
    expect(
      probe.events.find((entry) => entry.summary.includes("model provider's search service"))
    ).toBeDefined();
    // So is the model. The operating contract is a byte-stable constant and cannot vary with the
    // route, so the runtime block is where a run learns that its queries now leave the computer.
    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{ role: string; content: string }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('answered by your model provider, which sees the query');
  });

  /**
   * The rule the fabricated answer broke, checked against the catalogue as it actually goes out.
   *
   * The descriptions are the only map the model has of this computer and they cross-reference
   * constantly - "hand the promising URLs to parallel_web_read", "use web_search to find that
   * address", "each specialist gets web_search and parallel_web_read". `tools.test.ts` already holds
   * every one of those names to something declared. What it cannot see is a run that then removes
   * the tool: four descriptions went on pointing at `web_search` and `parallel_web_read` after the
   * provider route withdrew them, and a model that trusts its own catalogue looked for a tool that
   * was not there and answered from memory instead.
   *
   * `connector_action` is the one name allowed to dangle, and only because what is missing there is
   * the capability itself rather than the tool - nothing is connected, every call would fail, and
   * `connector_list` names it in the course of being the call that says so.
   */
  it('sends no description naming a tool this run took out of the catalogue', async () => {
    const { log } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const sent = new Set(toolNames(log.modelRequests[0]));
    const declared = new Set(agentTools.map((tool) => tool.name));
    for (const tool of agentTools)
      if (sent.has(tool.name))
        for (const token of tool.description.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g) ?? [])
          if (declared.has(token) && token !== 'connector_action')
            expect(
              sent.has(token),
              `${tool.name} sends the model to ${token}, which this run did not offer it`
            ).toBe(true);
    expect(sent.has('connector_action')).toBe(false);
  });

  /** What the model was handed back for its last tool call, which is where a search result lands. */
  const lastToolResult = (request: Record<string, unknown> | undefined): string =>
    ((request?.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .at(-1) ?? '';

  /** A provider response to the search request athanor builds, with the sources it retrieved. */
  const searched = (
    citations: Array<{ url: string; title?: string; content?: string }>,
    requests = 1
  ): string =>
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: citations.map((citation) => `${citation.title} ${citation.url}`).join('\n'),
            annotations: citations.map((citation) => ({
              type: 'url_citation',
              url_citation: citation
            }))
          }
        }
      ],
      usage: {
        prompt_tokens: 90,
        completion_tokens: 40,
        total_tokens: 130,
        server_tool_use: { web_search_requests: requests }
      }
    });

  it('answers a web_search call by spending the provider’s search on a request built for it', async () => {
    const { log } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      toolFrame('call-search', 'web_search', { query: 'agent frameworks released in 2026' })
    );
    // Three provider calls for one search: the step that asked, the search itself, the step that
    // reads it. The middle one is the whole mechanism - a provider-side tool can only be spent by a
    // request whose purpose is to spend it.
    const search = log.modelRequests[1] ?? {};
    expect(((search.tools ?? []) as Array<{ type?: string }>).map((tool) => tool.type)).toEqual([
      'openrouter:web_search'
    ]);
    // No function tools beside it. The gateway refuses this outright, so a regression here is a
    // failed run rather than a model quietly choosing between two answerers.
    expect(toolNames(search)).toEqual(['openrouter:web_search']);
    const asked = ((search.messages ?? []) as Array<{ role: string; content: string }>)
      .map((message) => message.content)
      .join('\n');
    expect(asked).toContain('agent frameworks released in 2026');
    // The query and nothing else. The conversation, the workspace and the user's own words stay on
    // this computer; what leaves it is what the disclosure says leaves it.
    expect(asked).not.toContain('Tidy the notes');
  });

  it('hands the search back as ranked rows and taints the turn with what it read', async () => {
    const { log, probe } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      [
        toolFrame('call-search', 'web_search', { query: 'rate decision' }),
        searched([
          { url: 'https://regulator.example/notice', title: 'Notice', content: 'Held at 4.25.' },
          { url: 'https://press.example/story', title: 'Story', content: 'Rates unchanged.' }
        ]),
        textFrame('Two sources say the rate held.')
      ]
    );
    const result = lastToolResult(log.modelRequests[2]);
    // The same shape the in-house search returns, because the model was given one description of
    // what a search returns and both routes have to keep it.
    expect(result).toContain('"rank":1');
    expect(result).toContain('https://regulator.example/notice');
    expect(result).toContain('"site":"press.example"');
    expect(result).toContain('Held at 4.25.');
    // A search is a read of pages nobody on this computer chose, so the floor rises exactly as it
    // does for an in-house search - the route may change who fetched, never what it counts as.
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('web search results');
    expect((transition?.payload as { tool?: string } | undefined)?.tool).toBe('web_search');
  });

  it('refuses to pass off a provider that never searched as a web with nothing on the subject', async () => {
    // The failure mode this route exists to remove, arriving one level down. A response with no
    // sources and no search spent is the provider answering from the model's memory; handing that
    // back as an empty result list would let the agent report "nothing found" about a search that
    // never happened, which is how the original fabrication looked from inside the model.
    const { log } = await runOnce(
      standardTask(),
      config({ ...serverConfig, TASK_MAX_STEPS: 2 }),
      [openrouterModel],
      [
        toolFrame('call-search', 'web_search', { query: 'rate decision' }),
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'I already know this.' } }],
          usage: { prompt_tokens: 90, completion_tokens: 5, total_tokens: 95 }
        }),
        textFrame('The search did not run.')
      ]
    );
    const result = lastToolResult(log.modelRequests[2]);
    expect(result).toContain('did not run a search');
    expect(result).toContain('not evidence that nothing exists');
  });

  it('keeps a run whose deployment forced the in-house route off the provider entirely', async () => {
    // The one switch that restores the old behaviour, asserted where it matters: not merely that no
    // provider tool is offered, but that a search actually goes to the runner instead.
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    const probe = probeStore(() => standardTask());
    const store = {
      ...probe.store,
      listModels: async () => [openrouterModel]
    } as unknown as DataStore;
    installFetch(
      [toolFrame('call-search', 'web_search', { query: 'rate decision' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(
      store,
      config({ ...serverConfig, AI_FORCE_INHOUSE_WEB: true, TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(standardTask())
      .catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/browser/search'))).toBe(true);
    for (const request of log.modelRequests)
      expect(toolNames(request)).not.toContain('openrouter:web_search');
  });

  it('finishes in house when it started in house, however the credential changed underneath', async () => {
    // The one direction that is pinned. Without it, turning zero retention off from the settings
    // page mid-run moves a task that began under the in-house promise onto the provider's search
    // without the owner ever being asked about that task.
    const pinned = standardTask({
      messages: [{ role: 'user', content: 'Tidy the notes' }],
      step: 0,
      credits: 0,
      turnToolResults: {},
      webToolMode: 'in_house'
    });
    const { log } = await runOnce(pinned, serverConfig, [openrouterModel]);
    const names = toolNames(log.modelRequests[0]);
    expect(names).toContain('web_search');
    expect(names).not.toContain('openrouter:web_search');
  });

  it('records the mode it ran under, so the next turn is held to it', async () => {
    const { probe } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const modes = probe.checkpoints
      .flatMap((input) =>
        input.agentStateCiphertext
          ? [
              decryptJson<{ webToolMode?: string }>(
                input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
                dataKey
              )
            ]
          : []
      )
      .map((state) => state.webToolMode);
    expect(modes.at(-1)).toBe('server');
  });

  /**
   * The hole a route change would otherwise have opened. On the provider route the search runs on
   * the provider's own infrastructure and its results reach the model inside the response - there
   * is no tool result for `untrustedOriginOfResult` to classify, and the two calls that used to
   * label the web have just been withdrawn from the catalogue.
   */
  it('taints the turn with what the provider fetched, which arrives without a tool result', async () => {
    const cited = `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          delta: {
            content: 'The regulator published guidance in March.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://regulator.example/notice',
                  title: 'Notice',
                  content: 'Guidance was published in March.'
                }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;
    const { probe } = await runOnce(standardTask(), serverConfig, [openrouterModel], cited);
    const transition = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.startsWith('Untrusted content entered')
    );
    expect(transition?.summary).toContain('regulator.example');
    expect((transition?.payload as { tool?: string } | undefined)?.tool).toBe('provider_web');
  });
});

describe('a turn that runs out of steps', () => {
  it('tells the model the budget is nearly gone before it spends the last of it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Still working.'), textFrame('Still working.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('FINAL STEPS: 2 of this turn');
    expect(systemText).toContain('call finish');
    // Said once. A notice re-pushed every step would move the tail on every request.
    const second = ((log.modelRequests[1]?.messages ?? []) as Array<{ content: string }>).filter(
      (message) => message.content.startsWith('FINAL STEPS')
    );
    expect(second).toHaveLength(1);
  });

  const runToTheCeiling = async (
    handoffBody: string
  ): Promise<{ probe: StoreProbe; log: FetchLog; outcome: string | null }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Still working.'), textFrame('Still working.'), handoffBody], log);
    const outcome = await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .then(() => null)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    return { probe, log, outcome };
  };

  const handoffFinish = toolFrame('call-hand', 'finish', {
    summary: 'Two of five sections are drafted; the rest is outlined in workspace/report.md.',
    deliverables: ['workspace/report.md'],
    verification: { status: 'not_applicable', evidence: [] }
  });

  it('spends its last call on a handoff, on the catalogue every other step sent', async () => {
    const { log } = await runToTheCeiling(handoffFinish);

    // Three provider calls for a two-step budget: the budget bounds the work, and the harness
    // closing the turn is not one of the steps it bounds.
    expect(log.modelRequests).toHaveLength(3);
    const handoff = log.modelRequests[2] ?? {};
    /*
     * The catalogue is the head of the cached prefix, and this is the largest request the turn
     * makes. It used to be sent a two-tool list where the step before it sent forty, so the front
     * of the prompt moved and every byte behind it was re-billed at the write price - to buy
     * nothing, because what stops the model starting new work here is the denial the next test
     * exercises, not the shape of the list.
     */
    expect(JSON.stringify(handoff.tools)).toBe(JSON.stringify(log.modelRequests[1]?.tools));
    expect(
      ((handoff.tools ?? []) as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name
      )
    ).toEqual(expect.arrayContaining(['set_plan', 'finish', 'shell', 'file_write']));
    const systemText = ((handoff.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('STEP BUDGET EXHAUSTED after 2 steps');
    expect(systemText).toContain('the exact words they can send back to carry on');
  });

  it('runs nothing but set_plan and finish on the handoff turn, whatever it is asked for', async () => {
    // The restriction the catalogue used to carry, where it has always actually lived: a call that
    // is neither of the two is answered with a denial and never reaches the runner.
    const { log } = await runToTheCeiling(
      toolFrame('call-hand', 'shell', { command: 'echo late', cwd: 'workspace' })
    );

    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });

  it('lands somewhere the owner can act on instead of a red failure', async () => {
    const { probe, outcome } = await runToTheCeiling(handoffFinish);

    // Before: throw step_limit_reached, status 'failed', no summary and no statement of where the
    // work got to - on a task the API has always let a reply resume.
    expect(outcome).toBeNull();
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(false);
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    expect(completed?.summary).toBe('Stopped at the step limit with work outstanding');
    const payload = (completed?.payload ?? {}) as Record<string, unknown>;
    expect(payload.interrupted).toBe(true);
    expect(String(payload.summary)).toContain('Two of five sections');
    expect(payload.deliverables).toEqual(['workspace/report.md']);
    const ceiling = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.includes('whole step budget')
    );
    // Raised to the owner rather than filed: the turn stopped short of what they asked for and
    // only their reply starts it again.
    expect((ceiling?.payload as { owner?: boolean })?.owner).toBe(true);
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.at(-1)?.content).toContain('PREVIOUS TURN STOPPED AT ITS STEP LIMIT');
    expect(saved?.messages.at(-1)?.content).toContain('do not restart finished work');
  });

  it('still reports the ceiling honestly when the handoff call itself cannot be made', async () => {
    // A provider outage during the one closing call must not also cost the record of where the
    // work stopped, so the carry-over note is persisted before the error is raised.
    const { probe, outcome } = await runToTheCeiling('data: {"error":{"message":"upstream"}}\n\n');

    expect(outcome).toContain('used all 2 of its steps');
    expect(outcome).toContain('reply to carry on');
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.at(-1)?.content).toContain('PREVIOUS TURN STOPPED AT ITS STEP LIMIT');
  });
});

describe('what a finished turn tells memory about itself', () => {
  const packItem = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('files a turn that ran out of steps as interrupted, and grades nothing on it', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    probe.recallPack([packItem]);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Still working.'),
        textFrame('Still working.'),
        toolFrame('call-hand', 'finish', {
          summary: 'Two of five sections are drafted; the rest is outlined in workspace/report.md.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // Before: "Outcome: ok", directly above the same episode's own account of what is unfinished -
    // and an 'ok' written against every item the pack injected, on a turn that proved nothing about
    // any of them. Nothing writes 'fail', so a pack graded on a run that never finished is a number
    // that can only ever go up.
    expect(probe.episodes).toHaveLength(1);
    expect(probe.episodes[0]).toContain('Outcome: interrupted');
    expect(probe.memoryUses).toEqual([]);
  });

  it('still files an ordinary finish as ok, and grades the pack it was given', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    probe.recallPack([packItem]);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'finish', {
          summary: 'The notes were already tidy, so there was nothing to change.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // `not_applicable` is the right status for an answer that needed no tools, which is why the
    // label keys off the interruption and never off the verification status.
    expect(probe.episodes).toHaveLength(1);
    expect(probe.episodes[0]).toContain('Outcome: ok');
    expect(probe.memoryUses).toEqual([{ itemIds: [packItem], outcome: 'ok' }]);
  });
});

describe('deciding to tell the owner something', () => {
  const twoNotices = (): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-n1',
                function: {
                  name: 'notify',
                  arguments: JSON.stringify({
                    headline: 'The listing you are watching dropped to £412,000',
                    detail:
                      'It was £430,000 at 09:00. Snapshot saved to workspace/watch/latest.html.'
                  })
                }
              },
              {
                index: 1,
                id: 'call-n2',
                function: { name: 'notify', arguments: JSON.stringify({ headline: '' }) }
              }
            ]
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  it('writes a durable notice the owner can be told about, and refuses an empty one', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([twoNotices(), textFrame('Told you.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const notices = probe.events.filter((entry) => entry.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.summary).toBe('The listing you are watching dropped to £412,000');
    const notice = (notices[0]?.payload ?? {}) as Record<string, unknown>;
    expect(notice.headline).toBe('The listing you are watching dropped to £412,000');
    expect(String(notice.detail)).toContain('workspace/watch/latest.html');
    expect(notice.unattended).toBe(false);
    // And the headline alone is queued for the owner's devices, because that is what a lock screen
    // has room for; the detail waits in the conversation the notification opens.
    expect(probe.notifications).toEqual([
      { kind: 'agent_message', message: 'The listing you are watching dropped to £412,000' }
    ]);
    // Nothing reached the workspace, so nothing needed an undo point taken in front of it.
    expect(probe.undoPoints).toHaveLength(0);
    const refusal = decryptCheckpoints(probe.checkpoints)
      .at(-1)
      ?.messages.find((message) => message.toolCallId === 'call-n2');
    expect(refusal?.content).toContain('needs a headline');
  });

  it('stops one turn from becoming a stream', async () => {
    const notice = (id: string): string =>
      toolFrame(id, 'notify', { headline: `Something happened, number ${id}` });
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([notice('a'), notice('b'), notice('c'), notice('d'), textFrame('Done.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 5 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(probe.events.filter((entry) => entry.kind === 'notice')).toHaveLength(
      MAX_NOTICES_PER_TURN
    );
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    expect(messages.find((message) => message.toolCallId === 'd')?.content).toContain(
      'which is the limit'
    );
  });

  it('gives the next turn its own three notices instead of silencing the conversation', async () => {
    // The bound is written as per-turn in the tool description, in the constant's name and in the
    // refusal the model reads - but the counter was carried into the next turn by the state spread,
    // so a watch that raised three notices could never reach the owner again for the life of the
    // conversation, and was told the current turn had already sent three.
    const first = makeTask();
    const probe = probeStore(() => first);
    const promoted: Array<Record<string, unknown>> = [];
    // Reading the queue does not consume it - `getNextQueuedTaskMessage` is a plain SELECT, and
    // promoting is what clears the row. The stub used to decrement on read, so any second reader
    // made the message vanish; the loop now checks for a correction at every step boundary, which
    // is exactly such a reader.
    let queuedPromoted = false;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (queuedPromoted) return null;
        return {
          id: 'message-1',
          taskId,
          userId,
          promptCiphertext: encryptJson(
            { prompt: 'Keep watching it' },
            dataKey,
            `task-message:${taskId}`
          ),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: `task:${taskId}:2`,
          status: 'queued',
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      promoteQueuedTaskMessage: async (input: Record<string, unknown>) => {
        queuedPromoted = true;
        promoted.push(input);
        return first;
      }
    });
    const notice = (id: string): string =>
      toolFrame(id, 'notify', { headline: `Something happened, number ${id}` });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([notice('a'), notice('b'), notice('c'), textFrame('Done.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(first)
      .catch(() => undefined);

    expect(probe.events.filter((entry) => entry.kind === 'notice')).toHaveLength(
      MAX_NOTICES_PER_TURN
    );
    const handedOver = decryptJson<{ notices?: number }>(
      promoted[0]?.agentStateCiphertext as Parameters<typeof decryptJson>[0],
      dataKey
    );
    expect(handedOver.notices).toBe(0);

    // And the turn that resumes from that state can genuinely speak again.
    const second = makeTask(handedOver);
    const resumed = probeStore(() => second);
    installFetch([notice('d'), textFrame('Done.')], { calls: [], modelRequests: [] });
    await new AgentWorker(resumed.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(second)
      .catch(() => undefined);
    expect(resumed.events.filter((entry) => entry.kind === 'notice')).toHaveLength(1);
    expect(resumed.notifications).toHaveLength(1);
  });

  it('tells a scheduled run it is unattended, and stamps its notices as such', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    // The scheduler stamps its own id into the payload of the run's opening event; that marker is
    // the only durable record that this task was not started by someone sitting in front of it.
    (probe.store as unknown as { listTaskEventPage: () => unknown }).listTaskEventPage =
      async () => ({
        events: [
          {
            id: 'opening',
            taskId,
            sequence: 1,
            kind: 'task_created',
            summary: 'Encrypted task created event',
            payloadCiphertext: encryptJson(
              { summary: 'Scheduled run is preparing', payload: { scheduleId: 'schedule-7' } },
              dataKey,
              `task-event:${taskId}`
            ),
            createdAt: '2026-07-01T00:00:00.000Z'
          }
        ],
        hasMore: false,
        oldestSequence: 1,
        nextCursor: 1
      });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-n', 'notify', { headline: 'The page changed' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const systemText = (
      (log.modelRequests[0]?.messages ?? []) as Array<{
        role: string;
        content: string;
      }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('started by a schedule');
    expect(probe.events.find((entry) => entry.kind === 'notice')?.payload).toMatchObject({
      unattended: true
    });
  });
});

describe('finding things on the internet', () => {
  it('searches through the runner route rather than by driving the browser at a search page', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-s', 'web_search', { query: 'athanor board pack template', limit: 40 }),
        textFrame('Found them.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(log.calls.some((call) => call.includes('/browser/search'))).toBe(true);
    expect(log.calls.some((call) => call.includes('/browser/action'))).toBe(false);
    // The runner caps a page at ten results and rejects anything larger, so the worker clamps
    // rather than sending a request that would come back as a validation error.
    expect(
      log.runnerRequests?.find((request) => request.url.includes('/browser/search'))?.body
    ).toEqual({ query: 'athanor board pack template', limit: 10 });
  });

  it('reads twelve pages at a twelfth of the window each, so all twelve come back', async () => {
    // Twelve pages at the 20,000 the model may ask for is 214,670 characters arriving through a
    // 24,000-character result that is cut from the middle: measured, page one came back and the
    // other eleven were gone along with their URLs, so the harness paid runner time and provider
    // bandwidth for eleven pages the model could never see and was never told were missing.
    const urls = Array.from({ length: 12 }, (_unused, index) => `https://source-${index}.test/doc`);
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-r', 'parallel_web_read', { urls, maxCharactersPerPage: 20_000 }),
        textFrame('Read them.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const body = log.runnerRequests?.find((request) => request.url.includes('/browser/read-many'))
      ?.body as { urls: string[]; maxCharactersPerPage: number } | undefined;
    expect(body?.urls).toHaveLength(12);
    expect(body?.maxCharactersPerPage).toBe(1_500);
    expect(body!.maxCharactersPerPage * 12).toBeLessThanOrEqual(24_000);

    // And the model is told, because a page cut without a mark reads as a page that did not
    // mention the thing, and a model reasons from what a source does not say.
    const result = log.modelRequests
      .flatMap(
        (request) =>
          (request.messages ?? []) as Array<{
            role?: string;
            tool_call_id?: string;
            content?: string;
          }>
      )
      .find((message) => message.role === 'tool' && message.tool_call_id === 'call-r');
    expect(result?.content).toContain('1,500 characters');
    expect(result?.content).toContain('Read a URL on its own for more of it');
  });

  it('gives one page the whole allowance, because it is not sharing the window with anything', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    installFetch(
      [
        toolFrame('call-r', 'parallel_web_read', {
          urls: ['https://source.test/doc'],
          maxCharactersPerPage: 20_000
        }),
        textFrame('Read it.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(
      (
        log.runnerRequests?.find((request) => request.url.includes('/browser/read-many'))?.body as
          | { maxCharactersPerPage: number }
          | undefined
      )?.maxCharactersPerPage
    ).toBe(20_000);
    // Nothing was shortened, so there is nothing to say about it.
    expect(
      log.modelRequests
        .flatMap(
          (request) =>
            (request.messages ?? []) as Array<{
              role?: string;
              tool_call_id?: string;
              content?: string;
            }>
        )
        .find((message) => message.role === 'tool' && message.tool_call_id === 'call-r')?.content
    ).not.toContain('Read a URL on its own');
  });

  it('tells the owner about a challenge once per site, and keeps the wall as data', async () => {
    // The runner detects the wall and scopes it, but it has no database identity: nothing it can do
    // reaches the owner's phone. A wall hit three times used to reach it zero times.
    const walls = [
      'https://html.duckduckgo.com/html/?q=a',
      'https://html.duckduckgo.com/html/?q=b',
      'https://careers.example.com/apply'
    ];
    let served = 0;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'web_search', { query: 'a' }),
        toolFrame('call-2', 'web_search', { query: 'b' }),
        toolFrame('call-3', 'web_search', { query: 'c' }),
        textFrame('Told you about the check.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/search')
            ? new Response(
                JSON.stringify({
                  error: {
                    code: 'browser_bot_wall',
                    message: `Blocked by Cloudflare Turnstile: this page is showing an anti-bot challenge. Tab tab-2 is stopped and ${new URL(walls[served] ?? walls[0]!).hostname} is closed to you until the owner opens it.`,
                    requestId: 'req',
                    botWall: {
                      vendor: 'Cloudflare Turnstile',
                      url: walls[served++] ?? walls[0],
                      reason: 'challenge frame',
                      evidence: 'page',
                      tabId: 'tab-2'
                    }
                  }
                }),
                { status: 409, headers: { 'content-type': 'application/json' } }
              )
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const failures = probe.events.filter((entry) => entry.kind === 'error');
    expect(failures).toHaveLength(3);
    // The pane renders the wall from the event, so it has to survive as fields rather than prose -
    // every field it reads, including the one that decides whether the banner says the challenge
    // may clear on its own.
    expect(failures[0]?.payload).toMatchObject({
      code: 'browser_bot_wall',
      botWall: {
        vendor: 'Cloudflare Turnstile',
        url: 'https://html.duckduckgo.com/html/?q=a',
        reason: 'challenge frame',
        evidence: 'page',
        tabId: 'tab-2'
      }
    });
    expect(probe.notifications).toEqual([
      {
        kind: 'takeover_needed',
        message:
          'html.duckduckgo.com is showing a Cloudflare Turnstile check only you can clear. Take over the Computer pane - the rest of the task carries on.'
      },
      {
        kind: 'takeover_needed',
        message:
          'careers.example.com is showing a Cloudflare Turnstile check only you can clear. Take over the Computer pane - the rest of the task carries on.'
      }
    ]);
    // And the model is told what is still open to it, in the runner's own words.
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    expect(messages.find((message) => message.toolCallId === 'call-1')?.content).toContain(
      'is closed to you until the owner opens it'
    );
  });
});

/**
 * Every one of these queries exits rg 0 or 1, so the exit-code guard never fires: what the model
 * gets back is an empty match list, which reads as "not present in this repository".
 */
describe('searching code for something that is not a regular expression', () => {
  const searches = (log: FetchLog): string[][] =>
    (log.runnerRequests ?? [])
      .filter((request) => request.url.endsWith('/exec'))
      .map((request) => (request.body as { args?: string[] }).args ?? []);

  /** rg answers exit 1 for "searched, found nothing" and 0 with lines for a hit. */
  const found = (...lines: string[]): Response =>
    new Response(
      JSON.stringify({
        exitCode: lines.length > 0 ? 0 : 1,
        stdout: lines.join('\n'),
        stderr: '',
        durationMs: 3,
        timedOut: false
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  const run = async (
    args: Record<string, unknown>,
    execResponses: Response[]
  ): Promise<{ log: FetchLog; result: Record<string, unknown> | undefined }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [], runnerRequests: [] };
    let served = 0;
    installFetch([toolFrame('call-1', 'code_search', args), textFrame('Read it.')], log, {
      route: (url) => {
        if (!url.endsWith('/exec')) return undefined;
        const next = execResponses[Math.min(served, execResponses.length - 1)];
        served += 1;
        return next;
      }
    });
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    const event = probe.events.find((entry) => entry.kind === 'tool_result');
    return {
      log,
      result: (event?.payload as { result?: Record<string, unknown> } | undefined)?.result
    };
  };

  it('reads a query the regex engine found nothing in as text, and says that is what it did', async () => {
    // `$scope.value` as a regex anchors at end of line and matches nothing - the same silent empty
    // answer the removed symbol tool gave for `$scope`, arriving by a different route.
    const { log, result } = await run({ query: '$scope.value' }, [
      found(),
      found('app.js:12:3:$scope.value = 3;')
    ]);

    const [first, second] = searches(log);
    expect(first).not.toContain('--fixed-strings');
    expect(second).toContain('--fixed-strings');
    expect(result).toMatchObject({ literal: true, totalReturned: 1 });
  });

  it('leaves a query with no regex punctuation on one search', async () => {
    // A retry here could only return what the first search already did, and every ordinary search
    // would pay for it.
    const { log } = await run({ query: 'parseInvoice' }, [found()]);
    expect(searches(log)).toHaveLength(1);
  });

  it('takes the query literally without also demanding a whole word', async () => {
    // These were one flag, so the only way to search for `a[0]` as text was to also require word
    // boundaries around it - which is a different question, and often the wrong one.
    const { log } = await run({ query: 'a[0]', literal: true }, [
      found('t.ts:1:7:const a[0] = 1;')
    ]);
    const [first] = searches(log);
    expect(first).toContain('--fixed-strings');
    expect(first).not.toContain('--word-regexp');
  });

  it('ignores a glob the model filled in with the word for nothing', async () => {
    // `--glob none` matches no file, so the search is over before it starts and the empty result
    // looks like an answer about the repository.
    const { log } = await run({ query: 'parseInvoice', glob: 'none' }, [found()]);
    expect(searches(log)[0]).not.toContain('--glob');
  });
});

describe('handing a repository to a subscription coding CLI', () => {
  it('sends the sandbox policy to the runner, not only to itself', async () => {
    // The worker builds OPENCODE_PERMISSION and OPENCODE_AUTO_SHARE - a deny-list covering sudo,
    // git push, rm -rf and reads of .env, plus the opt-out from publishing the session - and the
    // only test that covered them asserted the builder returned them. It proved the policy existed,
    // not that it survived to the process, and for a while it did not: the background route the
    // feature uses filtered them out of the environment on the way past.
    const approved = {
      action: 'run',
      agent: 'opencode',
      prompt: 'Fix the failing test',
      cwd: 'workspace'
    };
    const task = {
      ...makeTask({
        messages: [
          { role: 'user', content: 'Hand it to OpenCode' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-c', name: 'coding_agent', arguments: approved }]
          }
        ],
        step: 1,
        credits: 0,
        pending: {
          approvalId: 'approval-1',
          toolCall: { id: 'call-c', name: 'coding_agent', arguments: approved }
        }
      }),
      // A zero-retention task refuses the hand-over outright, which is a different branch.
      privacyRoute: 'external' as const
    };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const started: Array<{ url: string; body: Record<string, unknown> }> = [];
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Handed over.')], log);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/processes/start') && typeof init?.body === 'string') {
        started.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return new Response(
          JSON.stringify({
            sessionId: 'proc_1',
            status: 'exited',
            exitCode: 0,
            stdout: '{"type":"text","part":{"text":"done","sessionID":"ses_1"}}',
            stderr: ''
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return inner(input as string, init);
    }) as typeof fetch);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(started, 'the approved hand-over never reached the runner').toHaveLength(1);
    const environment = (started[0]?.body.env ?? {}) as Record<string, string>;
    expect(environment.OPENCODE_AUTO_SHARE).toBe('false');
    const permission = JSON.parse(environment.OPENCODE_PERMISSION ?? '{}') as {
      external_directory?: string;
      bash?: Record<string, string>;
    };
    expect(permission.external_directory).toBe('deny');
    expect(permission.bash?.['sudo *']).toBe('deny');
    expect(permission.bash?.['git push *']).toBe('deny');
  });

  it('reports why a hand-over failed, instead of that it did not finish', async () => {
    // Measured against the real CLI on the box: an unauthenticated run exits 1, writes its reason
    // as the last JSON record on stdout - "Not logged in - please run /login" - and leaves stderr
    // empty. Reading only stderr turned the one thing the owner has to do into "exited without
    // completing". The same record's is_error is honoured too, so a run that fails without failing
    // its exit code is not reported back as a finished piece of work.
    const approved = {
      action: 'run',
      agent: 'claude',
      prompt: 'Fix the failing test',
      cwd: 'workspace'
    };
    const task = {
      ...makeTask({
        messages: [
          { role: 'user', content: 'Hand it to Claude Code' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-c', name: 'coding_agent', arguments: approved }]
          }
        ],
        step: 1,
        credits: 0,
        pending: {
          approvalId: 'approval-1',
          toolCall: { id: 'call-c', name: 'coding_agent', arguments: approved }
        }
      }),
      privacyRoute: 'external' as const
    };
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Handed over.')], log);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/processes/start') && typeof init?.body === 'string')
        return new Response(
          JSON.stringify({
            sessionId: 'proc_1',
            status: 'exited',
            exitCode: 1,
            stdout: JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: true,
              result: 'Not logged in · Please run /login',
              session_id: 'ses_9'
            }),
            stderr: ''
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      return inner(input as string, init);
    }) as typeof fetch);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    const answer = messages.find((message) => message.toolCallId === 'call-c')?.content ?? '';
    expect(answer).toContain('Please run /login');
    expect(answer).not.toContain('exited without completing');
  });
});

describe('the review copy that goes out beside an editable file', () => {
  const publish = async (
    exec: (body: { executable?: string; args?: string[] }) => Response
  ): Promise<{
    conversions: Array<{ executable?: string; args?: string[] }>;
    events: Array<{ kind: string; summary: string; payload: unknown }>;
  }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      createArtifact: async (input: Record<string, unknown>) => ({ ...input, id: 'a1', version: 1 })
    });
    const conversions: Array<{ executable?: string; args?: string[] }> = [];
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-p', 'publish_artifact', {
          path: 'workspace/board-pack.docx',
          name: 'Board pack.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }),
        textFrame('Sent.')
      ],
      log
    );
    // The artifact path reads and writes bytes and runs one command, and the command's identity is
    // in the request body - which the shared `route` hook does not see - so both are intercepted
    // here, in front of the stub installFetch left behind.
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/exec') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as { executable?: string; args?: string[] };
        conversions.push(body);
        return exec(body);
      }
      if (url.includes('/file?path='))
        return init?.method === 'PUT'
          ? new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' }
            })
          : new Response('bytes');
      return inner(input as string, init);
    }) as typeof fetch);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { conversions, events: probe.events };
  };

  const observation = (exitCode: number, stderr = ''): Response =>
    new Response(JSON.stringify({ exitCode, stdout: '', stderr, durationMs: 1, timedOut: false }), {
      headers: { 'content-type': 'application/json' }
    });

  it('converts through the wrapper that fails when the bytes are not there', async () => {
    // Bare `libreoffice --convert-to pdf` exits 0 having written nothing, picks the output name
    // itself from the input stem, and shares one user profile with any conversion a skill starts
    // at the same moment. The wrapper is the answer to all three, and it is the only route the
    // built-in procedures name - the worker was the one caller still going around it.
    const { conversions } = await publish(() => observation(0));
    const conversion = conversions.find((call) => call.executable === 'athanor-office-convert');
    expect(conversion, 'the review copy did not go through athanor-office-convert').toBeDefined();
    expect(conversion?.args?.[0]).toBe('workspace/board-pack.docx');
    expect(conversion?.args?.[1]).toMatch(/^workspace\/\.athanor\/renders\/.+\.pdf$/);
    expect(conversions.some((call) => call.executable === 'libreoffice')).toBe(false);
  });

  it('still publishes the editable file when the conversion fails, and says so', async () => {
    const { events } = await publish(() => observation(1, 'LibreOffice produced no output'));
    expect(
      events.find((entry) => entry.kind === 'warning' && entry.summary.includes('review PDF'))
    ).toBeDefined();
    const result = events.find((entry) => entry.kind === 'tool_result');
    expect(
      (result?.payload as { result?: { preview?: unknown } })?.result?.preview
    ).toBeUndefined();
  });
});

describe('spending the owner’s money on generated media', () => {
  /** What the agent loop prices its own next step at before it has a measurement to go on. */
  const STEP_FLOOR_USD = 0.01;

  interface MediaProbe {
    readonly guarded: Array<Record<string, unknown>>;
    readonly billed: Array<Record<string, unknown>>;
    readonly generated: Array<Record<string, unknown>>;
    readonly written: string[];
    readonly events: Array<{ kind: string; summary: string; payload: unknown }>;
    readonly messages: Array<{ role: string; content: string; toolCallId?: string }>;
  }

  const generate = async (options: {
    deny?: boolean;
    failWrite?: boolean;
    spentUsd?: number;
    arguments?: Record<string, unknown>;
    /** A route the owner chose in Settings, sealed the way the API seals it. */
    imageRoute?: Record<string, unknown>;
    /** The same for speech, which is dispatched through its own arm and priced in its own unit. */
    audioRoute?: Record<string, unknown>;
    /** A provider that will not serve the sealed route, which is what a withdrawn model looks like. */
    providerRefusesTheRoute?: boolean;
  }): Promise<MediaProbe> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const guarded: Array<Record<string, unknown>> = [];
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      ...(options.imageRoute || options.audioRoute
        ? {
            getManagedProviderCredential: async (_userId: string, provider: string) =>
              provider === 'inference'
                ? ({
                    provider: 'inference',
                    secretCiphertext: encryptJson(
                      {
                        provider: 'openai-compatible',
                        baseUrl: PROVIDER_URL,
                        apiKey: 'stored-key',
                        enforceZeroDataRetention: false,
                        mediaRoutes: {
                          ...(options.imageRoute ? { image: options.imageRoute } : {}),
                          ...(options.audioRoute ? { audio: options.audioRoute } : {})
                        }
                      },
                      masterKey,
                      `inference-provider:${userId}`
                    )
                  } as unknown as Awaited<ReturnType<DataStore['getManagedProviderCredential']>>)
                : null
          }
        : {}),
      mediaSpendForTask: async () => options.spentUsd ?? 0,
      recordUsage: async (input: Record<string, unknown>) => {
        if (String(input.resourceClass).startsWith('media:')) billed.push(input);
      },
      spendGuard: async (input: Record<string, unknown>) => {
        // Every step of the loop asks the same question about its own next model call, priced at
        // the floor of a cent. Those are not what this describes: the media path is the one that
        // arrives carrying the catalogue's price for a generation.
        const media = Number(input.estimateUsd) !== STEP_FLOOR_USD;
        if (media) guarded.push(input);
        return options.deny && media
          ? {
              outcome: 'deny' as const,
              estimateUsd: Number(input.estimateUsd),
              blockedBy: 'daily' as const,
              warnedBy: [],
              reason: null,
              windows: [
                {
                  name: 'daily' as const,
                  spentUsd: 4,
                  pendingUsd: 0,
                  capUsd: 4,
                  warnAtUsd: 3,
                  projectedUsd: 4.02,
                  state: 'exceeded' as const,
                  startsAt: null,
                  endsAt: null
                }
              ]
            }
          : {
              outcome: 'allow' as const,
              estimateUsd: Number(input.estimateUsd),
              blockedBy: null,
              warnedBy: [],
              reason: null,
              windows: []
            };
      }
    });
    const written: string[] = [];
    const log: FetchLog = { calls: [], modelRequests: [], mediaRequests: [] };
    installFetch(
      [
        toolFrame('call-m', 'generate_media', {
          kind: 'image',
          prompt: 'A matte black kettle on a grey seamless background',
          width: 1024,
          height: 1024,
          ...options.arguments
        }),
        textFrame('Done.')
      ],
      log,
      {
        ...(options.providerRefusesTheRoute
          ? {
              media: () =>
                new Response(
                  JSON.stringify({ error: { message: 'No endpoints found for that model' } }),
                  { status: 404 }
                )
            }
          : {}),
        route: (url) => {
          if (!url.includes('/file?path=')) return undefined;
          const path = decodeURIComponent(url.split('path=')[1] ?? '');
          // Only what a generation produced. The turn also writes its own scaffolding through the
          // same route, and counting that would make every assertion here about the wrong file.
          const generated = /\.(png|mp3)$/.test(path);
          if (generated && options.failWrite)
            return new Response(JSON.stringify({ error: 'refused' }), { status: 403 });
          if (generated) written.push(path);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return {
      guarded,
      billed,
      generated: log.mediaRequests ?? [],
      written,
      events: probe.events,
      messages: decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? []
    };
  };

  it('asks the spending limit before the provider is charged, and prices the request itself', async () => {
    // This was the one money-spending path with no guard on it at all: every model call consults
    // the cap, and a generation - the only call that bills a second provider - did not.
    const probe = await generate({ arguments: { estimatedCostUsd: 0 } });
    const expected = managedMediaCatalog.image.estimate({ width: 1024, height: 1024 });
    expect(probe.guarded).toHaveLength(1);
    expect(probe.guarded[0]).toMatchObject({ taskId, estimateUsd: expected });
    // The model said it was free. Nothing read that.
    expect(probe.generated).toHaveLength(1);
  });

  it('writes the file in the call that asked for it and answers with its path', async () => {
    // The whole point of the change this replaced: the tool returns a file, not a receipt for one.
    const probe = await generate({});
    // The routing block is the OpenRouter-only part and is covered where it is built; this asks
    // that the request describes what was asked for.
    expect(probe.generated[0]).toMatchObject({
      model: managedMediaCatalog.image.modelId,
      size: '1024x1024',
      output_format: 'png'
    });
    expect(probe.written).toHaveLength(1);
    expect(probe.written[0]).toMatch(/^workspace\/generated\/.*\.png$/);
    const answer = probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(answer).toContain(probe.written[0]!);
  });

  it('generates with the model the owner chose, and prices the request against it', async () => {
    /*
     * The whole of "we have no control over the image model" in one assertion.
     *
     * Settings resolves the choice and the API seals it beside the key; this is the only place
     * that reads it back. Before it was wired the picker stored a route, displayed it, and the
     * worker generated with the compiled-in constant anyway - so an owner could pick a model, be
     * shown it, and never once use it. The price travels with it because the cap and the approval
     * card are checked against this number, and quoting the default's figure for a route ten times
     * the price is how a spend ceiling stops meaning anything.
     */
    const probe = await generate({
      imageRoute: {
        id: 'someone/painter-xl',
        providerModelId: 'someone/painter-xl',
        displayName: 'Painter XL',
        provider: 'openai-compatible',
        modality: 'image',
        usdPerImage: 0.14,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/painter-xl' });
    // The chosen route's own base, and the same megapixel surcharge every image carries: 1024x1024
    // is 0.048576 of a megapixel over the flat rate, at $0.001 each.
    expect(probe.guarded[0]).toMatchObject({ estimateUsd: 0.14 + 0.000_048_576 });
    expect(probe.billed[0]).toMatchObject({
      providerRef: 'openai-compatible:someone/painter-xl'
    });
    // Not the reviewed default, which is the thing this used to do no matter what was chosen.
    expect(probe.generated[0]?.model).not.toBe(managedMediaCatalog.image.modelId);
  });

  it('falls back to the reviewed route when the sealed choice names no model at all', async () => {
    // Nothing on this side validates the sealed blob: it is decrypted and cast, because the screen
    // that wrote it is the thing that parsed it. A route that resolved to a blank id would go to
    // the provider as a request with no model on it, and what happens then is the owner's bill.
    const probe = await generate({
      imageRoute: {
        id: '',
        providerModelId: '',
        displayName: 'Whatever the catalogue said',
        provider: 'openai-compatible',
        modality: 'image',
        // Deliberately under the approval threshold and deliberately not the default's figure, so
        // the generation runs without a card in front of it and the price still says which route
        // was used.
        usdPerImage: 0.02,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: managedMediaCatalog.image.modelId });
    expect(probe.guarded[0]).toMatchObject({
      estimateUsd: managedMediaCatalog.image.estimate({ width: 1024, height: 1024 })
    });
  });

  it('spends nothing and says so when the provider will not serve the chosen route', async () => {
    /*
     * The failure the picker makes possible.
     *
     * A route is resolved once, when the owner chooses it, and sealed beside the key - so a model
     * their provider later withdraws stays sealed until they open Settings again. The turn has to
     * survive that: the ledger is the only account of media spend there is, and a generation that
     * never happened must not appear in it, must not leave a half-written file, and must reach the
     * model as a tool result it can act on rather than as a dead turn.
     */
    const probe = await generate({
      providerRefusesTheRoute: true,
      imageRoute: {
        id: 'someone/withdrawn',
        providerModelId: 'someone/withdrawn',
        displayName: 'Withdrawn',
        provider: 'openai-compatible',
        modality: 'image',
        usdPerImage: 0.14,
        usdPerMillionCharacters: null,
        priceSource: 'provider',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/withdrawn' });
    expect(probe.billed).toHaveLength(0);
    expect(probe.written).toHaveLength(0);
    const answer = probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(answer).toContain('No endpoints found for that model');
  });

  it('speaks in the voice of the speech model the owner chose, and prices it by the character', async () => {
    /*
     * The other arm, which shares the resolver and nothing else.
     *
     * Speech is dispatched to a different endpoint, billed in a different unit, and is the only
     * modality that carries a voice - and a voice belongs to one model's own list, so the moment
     * the model became the owner's choice, sending the reviewed default's voice name to whatever
     * they picked became a request their provider has no way to honour. The image assertion above
     * cannot see any of that: it never sends a voice and its price is per image.
     */
    const probe = await generate({
      arguments: { kind: 'audio', prompt: 'Read the quarterly note aloud.' },
      audioRoute: {
        id: 'someone/reader-1',
        providerModelId: 'someone/reader-1',
        displayName: 'Reader One',
        provider: 'openai-compatible',
        modality: 'audio',
        usdPerImage: null,
        usdPerMillionCharacters: 40,
        priceSource: 'provider',
        defaultVoice: 'quiet',
        recommendationTags: [],
        updatedAt: new Date().toISOString()
      }
    });
    expect(probe.generated[0]).toMatchObject({ model: 'someone/reader-1', voice: 'quiet' });
    expect(probe.generated[0]?.model).not.toBe(managedMediaCatalog.audio.modelId);
    // The chosen route's own per-million rate over the thirty characters it was asked to speak.
    expect(probe.guarded[0]).toMatchObject({ estimateUsd: (30 * 40) / 1_000_000 });
    expect(probe.billed[0]).toMatchObject({ providerRef: 'openai-compatible:someone/reader-1' });
    expect(probe.written[0]).toMatch(/\.mp3$/);
  });

  it('honours a path the agent chose, so the file lands where the work expects it', async () => {
    const probe = await generate({ arguments: { path: 'workspace/hero.png' } });
    expect(probe.written).toEqual(['workspace/hero.png']);
  });

  it('puts a bare path in the workspace rather than paying for a write the runner will refuse', async () => {
    // The runner accepts writes only under workspace/, and the tool schema invites a plain name. A
    // model answering `hero.png` used to have the provider bill, the write refused, and the charge
    // lost - so the destination is resolved on this side before anything is spent.
    const probe = await generate({ arguments: { path: 'hero.png' } });
    expect(probe.written).toEqual(['workspace/hero.png']);
  });

  it('refuses a path that climbs out of the workspace before the provider is called', async () => {
    const probe = await generate({ arguments: { path: '../../etc/athanor/control.env' } });
    expect(probe.generated).toHaveLength(0);
    expect(probe.billed).toHaveLength(0);
    expect(probe.messages.find((message) => message.toolCallId === 'call-m')?.content).toContain(
      'may not climb out'
    );
  });

  it('records the charge even when the file cannot be written afterwards', async () => {
    // The ledger is the only account of media spend there is now: it feeds the caps, the cumulative
    // approval card and the breakdown the owner reads. A write that fails after the provider has
    // billed must still leave the money visible, or a retry loop spends without ever being seen.
    const probe = await generate({ failWrite: true });
    expect(probe.generated).toHaveLength(1);
    expect(probe.billed).toHaveLength(1);
    expect(probe.billed[0]).toMatchObject({ resourceClass: 'media:image', costUsd: 0.0102 });
    expect(probe.written).toHaveLength(0);
  });

  it('settles the ledger on what the provider charged, not on the estimate', async () => {
    // The estimate is what the cap is checked against; the invoice is what the owner actually pays,
    // and the spend breakdown they read is built from these rows.
    const probe = await generate({});
    expect(probe.billed).toHaveLength(1);
    expect(probe.billed[0]).toMatchObject({
      resourceClass: 'media:image',
      state: 'settled',
      costUsd: 0.0102,
      providerRef: `openai-compatible:${managedMediaCatalog.image.modelId}`
    });
    // Not the estimate, which is a different number.
    expect(probe.billed[0]?.costUsd).not.toBe(
      managedMediaCatalog.image.estimate({ width: 1024, height: 1024 })
    );
  });

  it('refuses the generation when the limit is reached, and says nothing was charged', async () => {
    const probe = await generate({ deny: true });
    expect(probe.generated).toHaveLength(0);
    expect(probe.written).toHaveLength(0);
    expect(probe.billed).toHaveLength(0);
    const refusal =
      probe.messages.find((message) => message.toolCallId === 'call-m')?.content ?? '';
    expect(refusal).toContain('limit');
    expect(refusal).toContain('nothing was charged');
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
  });

  it('refuses video outright rather than starting a generation that cannot finish', async () => {
    const probe = await generate({ arguments: { kind: 'video' } });
    expect(probe.generated).toHaveLength(0);
    expect(probe.guarded).toHaveLength(0);
    expect(probe.messages.find((message) => message.toolCallId === 'call-m')?.content).toContain(
      'zero-data-retention'
    );
  });
});

describe('reaching the built-in skill library', () => {
  const toolResult = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'skill', args)], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    const event = probe.events.find((entry) => entry.kind === 'tool_result');
    return (event?.payload as { result?: Record<string, unknown> })?.result ?? {};
  };

  it('lists the built-in skills beside the workspace ones', async () => {
    const result = await toolResult({ action: 'list' });
    const builtin = (result.builtinSkills ?? []) as Array<{ name: string }>;
    expect(builtin.length).toBeGreaterThan(15);
    expect(builtin.map((skill) => skill.name)).toContain('pdf-extraction');
  });

  it('opens a built-in procedure by name, with the binaries it assumes', async () => {
    // openSkill had no caller outside its own tests; skill(action=view) could only open skills the
    // agent had written itself.
    const result = await toolResult({ action: 'view', id: 'pdf-extraction' });
    expect(result.origin).toBe('builtin');
    expect(String(result.content)).toContain('<skill name="pdf-extraction"');
    expect(String(result.content)).toContain('## 1. Classify the PDF first');
    // The skill declares the binaries it assumes, and the answer names the ones this computer does
    // not have rather than a command for finding out - a procedure that opens with "run
    // build_deck.py" is confident, specific and wrong on a machine without python-pptx.
    expect(Array.isArray(result.requiredBinaries)).toBe(true);
    expect((result.requiredBinaries as string[]).length).toBeGreaterThan(0);
    // The probe is stubbed here and reports nothing missing, so the warning block stays out of the
    // procedure; a machine that really lacked one would carry it into the model's context.
    expect(result.missingBinaries).toBeUndefined();
    expect(String(result.content)).not.toContain('skill_missing_binaries');
  });

  it('still reports an unknown skill as missing', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([toolFrame('call-1', 'skill', { action: 'view', id: 'no-such-skill' })], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
  });
});

/**
 * The completion contract as a contract rather than a receipt.
 *
 * Every gate before this one tested identity and ordering - that a cited call exists, succeeded and
 * came after the last change - which any read of the file just written satisfies. These tests are
 * about the harness running something that can fail on the work itself, and about the one way that
 * mechanism could be turned back into a receipt: a check chosen because it was already true.
 */
describe('what would prove the job is done', () => {
  const execResponse = (exitCode: number, stdout = ''): Response =>
    new Response(
      JSON.stringify({
        exitCode,
        stdout,
        stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
        durationMs: 5,
        timedOut: false
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  const execRoute =
    (...codes: number[]) =>
    (url: string): Response | undefined => {
      if (!url.includes('/exec')) return undefined;
      const code = codes.length > 1 ? (codes.shift() ?? 0) : (codes[0] ?? 0);
      return execResponse(code);
    };

  /**
   * The last thing this request actually said to the model. The runtime block sits at the very end
   * of every window - that is where its clock is free to change - so it is stepped over here rather
   * than in each assertion.
   */
  const lastMessage = (log: FetchLog, request: number): string => {
    const messages = (log.modelRequests[request]?.messages ?? []) as Array<{ content: string }>;
    return (
      [...messages].reverse().find((message) => !message.content.startsWith(RUNTIME_CONTEXT_MARKER))
        ?.content ?? ''
    );
  };

  const acceptanceState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    messages: [
      { role: 'user', content: 'Fix the importer' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'file_read', arguments: {} }]
      },
      { role: 'tool', toolCallId: 'call-0', content: 'ok' }
    ],
    step: 0,
    credits: 0,
    // A turn that has already changed something, with one earlier result available to cite: the
    // state a real finish arrives in. It is fixing an importer, so the change is code - which is
    // what puts it in front of the acceptance gate at all.
    mutated: true,
    mutatedBeyondProse: true,
    turnToolResults: { 'call-0': { name: 'file_read', success: true } },
    ...over
  });

  const finishCall = (id: string): string =>
    toolFrame(id, 'finish', {
      summary: 'The importer reads all three columns.',
      verification: {
        status: 'verified',
        evidence: [
          {
            claim: 'The importer reads all three columns',
            source: 'tool_result',
            toolCallId: 'call-0'
          }
        ],
        remainingRisks: []
      }
    });

  it('refuses a definition of done the harness can already satisfy', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the workspace is there',
              executable: 'ls',
              args: ['workspace']
            }
          ]
        }),
        textFrame('Understood.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(
      probe.events.some((entry) => entry.summary === 'Acceptance checks refused: they already pass')
    ).toBe(true);
    expect(lastMessage(log, 1)).toContain('every one of them already passes');
    // Not stored: a record that cannot fail must not become the thing the finish is judged against.
    const states = decryptCheckpoints(probe.checkpoints) as unknown as Array<{
      acceptance?: unknown;
    }>;
    expect(states.every((state) => state.acceptance === undefined)).toBe(true);
  });

  it('takes the record once the harness has watched a check fail, and says which one is the proof', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q']
            },
            {
              kind: 'command',
              label: 'the existing suite still passes',
              executable: 'ruff',
              args: ['check']
            }
          ]
        }),
        textFrame('Starting now.')
      ],
      log,
      { route: execRoute(1, 0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const baseline = probe.events.find((entry) => entry.summary.startsWith('Acceptance baseline:'));
    expect(baseline?.summary).toBe('Acceptance baseline: 1 of 2 already pass before the work');
    expect(probe.events.some((entry) => entry.summary === 'Acceptance checks declared')).toBe(true);
    const answer = lastMessage(log, 1);
    expect(answer).toContain('check-1 fails now');
    expect(answer).toContain('check-2 already passes');
    const states = decryptCheckpoints(probe.checkpoints) as unknown as Array<{
      acceptance?: { checks: unknown[] };
    }>;
    expect(states.some((state) => state.acceptance?.checks.length === 2)).toBe(true);
  });

  it('refuses the finish when the harness runs the checks and one fails', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1'), textFrame('Looking at it.')], log, { route: execRoute(1) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Named, and a status rather than a warning: the model gets to fix this and finish, so a turn
    // that recovers used to carry a standing red line over its own "all passed" completion card.
    const refusal = probe.events.find((entry) => entry.summary.startsWith('Finish refused:'));
    expect(refusal?.kind).toBe('status');
    expect(refusal?.summary).toBe(
      'Finish refused: 1 of 1 acceptance check failed — the importer test passes'
    );
    // The turn did not complete. It ends at its step limit instead, which is the honest ending -
    // and what the model is told back is the harness's own observation rather than a verdict: an
    // exit code and the first lines of stderr are what turn "it does not work" into a next step.
    const ending = probe.events.find((entry) => entry.kind === 'completed');
    expect((ending?.payload as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    const answer = lastMessage(log, 1);
    expect(answer).toContain('Finish refused (acceptance 1 of 4)');
    expect(answer).toContain('AssertionError: expected 3 rows');
    /*
     * And the prose it writes on the way back round is not published as a reply. Five paths refuse
     * a finish and send the model round again; its natural answer to "finish refused" is to restate
     * itself, and each restatement used to be another bubble. That is why one answer reached the
     * owner in pieces. The words still go into the window - the model needs them - they are just
     * not a new thing said to the owner.
     */
    // Exactly one thing reaches the owner. Five paths refuse a finish and send the model round
    // again, and its natural reply to "finish refused" is to restate itself; each restatement used
    // to be another bubble, which is why one answer arrived in pieces.
    expect(probe.events.filter((entry) => entry.kind === 'assistant_message')).toHaveLength(1);
  });

  /**
   * The hold exists so a turn that changed code says what would prove it. A report is a change too,
   * but nothing executable can prove it: the only check available is reading back the file just
   * written, which passes whatever the file says. Held anyway, a research task invents a check,
   * fails it, and is refused its own finish - which is what happened to a real one.
   */
  it('holds for acceptance on code but not on prose, on the extension alone', async () => {
    const heldFor = async (path: string): Promise<boolean> => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch(
        [
          toolFrame('call-1', 'file_write', { path, content: 'Some words.\n' }),
          // A read-only look at the result, so the finish below cites an observation ordered after
          // the change rather than the change itself. `ls` writes nothing, so it leaves the
          // prose/code question this test is about entirely to the extension.
          toolFrame('call-2', 'shell', { executable: 'ls', args: ['workspace'] }),
          toolFrame('call-3', 'finish', {
            summary: 'Wrote the file.',
            verification: {
              status: 'verified',
              evidence: [
                { claim: 'The file is on disk', source: 'tool_result', toolCallId: 'call-2' }
              ],
              remainingRisks: []
            }
          }),
          textFrame('Done.')
        ],
        log,
        { route: execRoute(0) }
      );
      const worker = new AgentWorker(
        probe.store,
        config({ TASK_MAX_STEPS: 8 }),
        masterKey,
        runnerSecret
      );

      await worker.run(task).catch(() => undefined);

      return probe.events.some((entry) => entry.summary === 'Asked for an acceptance record');
    };

    // The same turn, the same write, the same finish. Only the extension differs, so neither result
    // can be explained by anything else in the run.
    expect(await heldFor('workspace/notes.ts')).toBe(true);
    expect(await heldFor('workspace/notes.md')).toBe(false);
  });

  /**
   * A real task asked for a report file "and the gist in your reply". It wrote the report, published
   * it, and completed without an assistant message at all - the owner got a Result card and a
   * download. Nothing in the loop required the turn to say anything.
   */
  it('answers with the finish summary when the turn never said anything itself', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'shell', { executable: 'ls', args: ['workspace'] }),
        // A finish, with no prose in the same frame and none before it.
        toolFrame('call-2', 'finish', {
          summary: 'The workspace has three files in it.',
          verification: {
            status: 'verified',
            evidence: [
              { claim: 'Listed the workspace', source: 'tool_result', toolCallId: 'call-1' }
            ],
            remainingRisks: []
          }
        }),
        textFrame('Done.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 4 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Asked once, rather than completed in silence and papered over with the summary. The reply the
    // owner reads is then the model's own words, which is the thing they asked for.
    expect(probe.events.some((entry) => entry.summary === 'Asked for the answer itself')).toBe(
      true
    );
    const spoken = probe.events.filter((entry) => entry.kind === 'assistant_message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toBe('Done.');
    // Before the completion, so the owner reads the answer above the card rather than under it.
    expect(probe.events.indexOf(spoken[0]!)).toBeLessThan(
      probe.events.findIndex((entry) => entry.kind === 'completed')
    );
  });

  /**
   * Pausing cleared the lease in the same statement that set the status, and every write this
   * worker makes is guarded by `lease_owner = workerId`. So the stand-down write - the one that
   * saves the agent state - matched zero rows every time, and a paused task quietly lost the work
   * it had done and resumed from the beginning. `updateTask` returns void, so nothing said so.
   */
  it('saves the work when the owner pauses, despite the pause having cleared the lease', async () => {
    const paused = { ...makeTask(), status: 'paused', leaseOwner: null } as TaskRecord;
    const probe = probeStore(() => paused);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Working on it.')], log);
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(paused).catch(() => undefined);

    const standDown = probe.checkpoints.find((write) => write.status === 'paused');
    expect(standDown).toBeDefined();
    // The point of the write: the turn's work survives the pause.
    expect(standDown?.agentStateCiphertext).toBeDefined();
    // And it is not guarded by an owner the pause already set to NULL, which is what made the
    // write a no-op. Reconciling to a status the owner set is not competing for the task.
    expect(standDown?.workerId).toBeUndefined();
  });

  /** The other half of the rule: a turn that answered is never asked to answer again. */
  it('says nothing to a turn that already spoke', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'shell', { executable: 'ls', args: ['workspace'] }),
        // Prose and the finish in the same frame, which is how a turn that behaves looks.
        `data: ${JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                content: 'There are three files in the workspace.',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: {
                      name: 'finish',
                      arguments: JSON.stringify({
                        summary: 'Listed the workspace.',
                        verification: {
                          status: 'verified',
                          evidence: [
                            { claim: 'Listed it', source: 'tool_result', toolCallId: 'call-1' }
                          ],
                          remainingRisks: []
                        }
                      })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        textFrame('Done.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 4 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    expect(probe.events.some((entry) => entry.summary === 'Asked for the answer itself')).toBe(
      false
    );
    const spoken = probe.events.filter((entry) => entry.kind === 'assistant_message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.summary).toBe('There are three files in the workspace.');
  });

  it('completes when the harness runs the checks and they pass', async () => {
    const task = makeTask(
      acceptanceState({
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1')], log, { route: execRoute(0) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const completed = probe.events.find((entry) => entry.kind === 'completed');
    expect(completed).toBeDefined();
    // What the harness itself ran, kept apart from what the model claimed.
    expect((completed?.payload as { acceptance?: string[] }).acceptance).toEqual([
      'check-1: the importer test passes — exit 0'
    ]);
  });

  it('keeps the order athanor did its own steps in out of the completion', async () => {
    const task = makeTask(acceptanceState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'set_acceptance', {
          checks: [
            {
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q']
            }
          ]
        }),
        finishCall('call-2')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // No baseline was possible: the turn had already changed things, so what passes now may be the
    // work or may always have been true. The checks still run and the tick is still earned.
    expect(probe.events.some((entry) => entry.summary.startsWith('Acceptance baseline:'))).toBe(
      false
    );
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const payload = completed?.payload as {
      acceptance?: string[];
      verification?: { remainingRisks: string[] };
    };
    expect(payload.acceptance).toEqual(['check-1: the importer test passes — exit 0']);
    /*
     * What the owner is not told is when the checks were written relative to the work, because that
     * is a fact about how this box sequences its own steps and not about the job it just finished.
     * The hold on finish is the only thing that asks for a record and it fires because something has
     * already changed, so the sentence appeared on very nearly every completed task; the owner read
     * it and asked what it meant. Matched on the words rather than on a constant, because the fix is
     * that no wording of it belongs here.
     */
    for (const risk of payload.verification?.remainingRisks ?? [])
      expect(risk).not.toMatch(/written after the work|before it/i);
    expect(payload.acceptance ?? []).not.toContainEqual(
      expect.stringMatching(/written after the work/i)
    );
  });

  it('will not let a later turn be proven by the checks an earlier one declared', async () => {
    const task = makeTask(
      acceptanceState({
        turn: 1,
        acceptanceTurn: 0,
        acceptance: {
          checks: [
            {
              id: 'check-1',
              kind: 'command',
              label: 'the importer test passes',
              executable: 'pytest',
              args: ['-q'],
              cwd: 'workspace',
              expectExit: 0,
              timeoutSeconds: 300
            }
          ],
          revisions: 1,
          declaredAtStep: 0
        }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([finishCall('call-1'), finishCall('call-2')], log, { route: execRoute(0) });
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 3 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    // Held once, because a record that was already green before this turn started cannot be
    // evidence of what this turn did - and then taken at its word, with the owner told which it is.
    expect(lastMessage(log, 1)).toContain('an earlier turn declared');
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const payload = completed?.payload as { verification?: { remainingRisks: string[] } };
    expect(payload.verification?.remainingRisks).toContain(ACCEPTANCE_EARLIER_TURN_CAVEAT);
  });

  it('will not let a turn cite the promise it made as the proof it kept it', async () => {
    const task = makeTask({
      messages: [{ role: 'user', content: 'Tidy the notes' }],
      step: 0,
      credits: 0,
      mutated: true,
      turnToolResults: { 'call-0': { name: 'set_acceptance', success: true } },
      acceptance: {
        checks: [
          {
            id: 'check-1',
            kind: 'artifact',
            label: 'the notes exist',
            path: 'workspace/notes.md',
            minBytes: 1
          }
        ],
        revisions: 1,
        declaredAtStep: 0
      }
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'finish', {
          summary: 'Done.',
          verification: {
            status: 'verified',
            evidence: [
              { claim: 'The notes are tidy', source: 'tool_result', toolCallId: 'call-0' }
            ],
            remainingRisks: []
          }
        }),
        textFrame('Let me check the file.')
      ],
      log,
      { route: execRoute(0) }
    );
    const worker = new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2 }),
      masterKey,
      runnerSecret
    );

    await worker.run(task).catch(() => undefined);

    const ending = probe.events.find((entry) => entry.kind === 'completed');
    expect((ending?.payload as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    expect(lastMessage(log, 1)).toContain('Finish rejected');
  });
});

describe('how full the window is believed to be', () => {
  /**
   * A frame carrying the provider's own accounting for the request that produced it.
   * `stream_options.include_usage` is what puts it on the stream, and it is the number the
   * compaction trigger should be reading.
   */
  const usageFrame = (promptTokens: number, chars = 120_000): string =>
    [
      `data: ${JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            delta: {
              // Real bulk, so there is something to condense. It was 40,000 characters, which was
              // enough only while the tool catalogue was its old size: the catalogue is subtracted
              // from the input budget the trigger is a share of, so shrinking the catalogue by two
              // thousand tokens raised the threshold and the estimate stopped reaching it. That is
              // the right behaviour and the wrong calibration for a test about which *number* is
              // believed, so the fixture now clears the trigger with room rather than by a hair.
              content: 'x'.repeat(chars),
              tool_calls: [
                {
                  index: 0,
                  id: 'call-u',
                  function: { name: 'files_list', arguments: JSON.stringify({ path: 'workspace' }) }
                }
              ]
            }
          }
        ]
      })}`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: 4, total_tokens: promptTokens + 4 }
      })}`,
      'data: [DONE]'
    ].join('\n\n') + '\n\n';

  // Every step answers with the same tool call and the same reported size, so the run builds the
  // history compaction needs (MIN_CONDENSED_MESSAGES is 6) and the trigger is asked the same
  // question each step. installFetch repeats its last body once the list runs out.
  const run = async (promptTokens: number) => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([usageFrame(promptTokens)], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 12 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return probe.events;
  };

  const compacted = (events: Array<{ summary: string }>): boolean =>
    events.some((entry) => entry.summary.includes('Condensed earlier work'));

  it('does not condense work the provider says is nowhere near the window', async () => {
    // The messages are bulky enough that characters-divided-by-four calls the window nearly full,
    // which is what used to force a compaction here. The provider says the request was 5k tokens.
    // Compaction is a durable, lossy edit to the trajectory, so making it on a guess that the
    // route's own accounting contradicts is work and context thrown away for nothing.
    expect(compacted(await run(5_000))).toBe(false);
  });

  it('still condenses on the estimate when the route reports no usage at all', async () => {
    // Zero is "this route told us nothing", not "the window is empty" - reading it as a real
    // measurement would switch compaction off entirely for every route that omits usage, which is
    // the failure that matters, because it ends in a refused request rather than a wasted one.
    expect(compacted(await run(0))).toBe(true);
  });

  it('condenses to a share of the same budget the trigger measured', async () => {
    /*
     * The two ends were reading different numbers. The check that decides to compact subtracts the
     * tool catalogue from the window; the target it then aims for did not, so it asked for a
     * verbatim tail that was a share of a budget nobody was working to. On a 64k model that made
     * the intended half into 0.725, and the run below shows what that costs: measured here, the old
     * arithmetic condensed once, freed a fifth of the window, and then never managed to condense
     * anything again for the rest of the task - each later attempt asking to keep a tail larger
     * than the conversation and returning nothing, while the trigger went on firing every step. The
     * same figure at both ends condenses four times and frees nearly twice as much the first time.
     *
     * A small window is the case that shows it because the catalogue is a larger share of it; the
     * fault is the same on every window.
     *
     * The bulk is the helper's own, and has to be: this ran on six thousand characters a step,
     * which is not enough to keep the window under pressure once the tool-output squeeze reaches
     * its two-thousand-character floor. Measured on that figure, the prepared request collapses
     * from 19,393 tokens to 10,808 at the step the floor bottoms out and then climbs about sixty a
     * step, so it never reaches the 20,719 trigger again and nothing is condensed for the rest of
     * the run - which is compaction correctly declining to spend a model call on a request sitting
     * at 46% of its budget, not the fault this test is about. It survived only while the catalogue
     * was a particular size, and a test that a fortieth tool can turn red is measuring the
     * catalogue. On the helper's default the prepared request stays pinned above the budget itself
     * for the whole run, which is the pressure the arithmetic below is meant to be read under.
     */
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([usageFrame(0)], log);
    await new AgentWorker(
      {
        ...(probe.store as unknown as Record<string, unknown>),
        listModels: async () => [{ ...model, contextTokens: 64_000 }]
      } as unknown as DataStore,
      config({ TASK_MAX_STEPS: 60 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    const compactions = probe.events
      .filter((entry) => entry.summary.includes('Condensed earlier work'))
      .map(
        (entry) =>
          (
            entry.payload as {
              compaction: { estimatedTokensBefore: number; estimatedTokensAfter: number };
            }
          ).compaction
      );

    // It keeps being able to help. One compaction in sixty steps is the shape of the fault, not of
    // a task that had nothing more to condense.
    expect(compactions.length).toBeGreaterThanOrEqual(3);
    const first = compactions[0];
    expect(first).toBeDefined();
    // And the first one frees a third of the window rather than a fifth.
    expect(first!.estimatedTokensAfter).toBeLessThan(first!.estimatedTokensBefore * 0.7);
  });
});

describe('a correction sent while the task is working', () => {
  it('joins the running turn instead of waiting for it to stop', async () => {
    // Until this existed, a message sent to a working task could only wait for it to finish. If
    // the agent had misread the request, the owner's choices were to watch it finish or cancel and
    // lose the work - the one channel for steering was unusable exactly when there was something
    // to steer.
    const task = makeTask();
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    let pending = 1;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (pending <= 0) return null;
        pending -= 1;
        return {
          id: 'correction-1',
          taskId,
          userId,
          promptCiphertext: encryptJson(
            { prompt: 'Stop - use Postgres, not SQLite.' },
            dataKey,
            `task-message:${taskId}`
          ),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: 'r',
          status: 'queued',
          interrupt: true,
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'files_list', { path: 'workspace' }),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        textFrame('Done.')
      ],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // It was taken into the turn, and the credit ceiling was raised by what it reserved - without
    // that the loop trips its own budget on the very next iteration.
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'correction-1', additionalComputeCredits: 5 });

    // And it reached the provider as the owner's own words, in the same turn.
    const sent = log.modelRequests.at(-1)?.messages as Array<{ role: string; content: string }>;
    expect(
      sent.some((message) => message.role === 'user' && message.content.includes('use Postgres'))
    ).toBe(true);
    // The turn was kept: the work done before the correction is still in the window.
    expect(sent.some((message) => message.role === 'tool')).toBe(true);
  });

  it('leaves an ordinary follow-up queued, because that is a different intention', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => ({
        id: 'followup-1',
        taskId,
        userId,
        promptCiphertext: encryptJson(
          { prompt: 'Then deploy it' },
          dataKey,
          `task-message:${taskId}`
        ),
        modelId: model.id,
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 5,
        maxSpendUsd: null,
        resourceClass: 'task_compute',
        reservationKey: 'r',
        status: 'queued',
        interrupt: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        promotedAt: null
      }),
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-1', 'files_list', { path: 'workspace' }), textFrame('Done.')],
      log
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(consumed).toHaveLength(0);
  });
});

describe('a question the agent stops to ask', () => {
  /*
   * The operating contract has always told the model to ask when a missing choice materially
   * changes the result, and until now there was nowhere to ask: `awaiting_user` was written only by
   * the approval path, so a genuine blocker came back as a finish with a not_applicable
   * verification and landed as a completion card nobody could tell from finished work - and on an
   * unattended run the box then went silent until the owner next looked.
   */
  const parked = {
    question: 'Which mailbox should the invoice go from?',
    why: 'Two are connected and the reply address changes what the client sees.',
    options: ['work@', 'billing@']
  };

  it('parks the conversation, writes the question, and rings a device', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        // Something first: a turn that has looked at nothing may not ask, which is the guard against
        // an agent that asks instead of working.
        toolFrame('call-1', 'file_read', { path: 'workspace/invoice.md' }),
        `data: ${JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-2',
                    function: { name: 'ask', arguments: JSON.stringify(parked) }
                  },
                  {
                    index: 1,
                    id: 'call-3',
                    function: {
                      name: 'file_read',
                      arguments: JSON.stringify({ path: 'workspace/terms.md' })
                    }
                  }
                ]
              }
            }
          ]
        })}\n\ndata: [DONE]\n\n`,
        textFrame('Never reached.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ content: 'Invoice for March' }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 6 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The three things the approval path does, done the same way rather than a second mechanism.
    const asked = probe.events.filter((entry) => entry.kind === 'question_asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject(parked);
    expect(probe.notifications).toEqual([{ kind: 'agent_message', message: parked.question }]);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });

    // No approval was raised, and nothing about it is dressed as one: there is no decision to bind
    // arguments to and no yes or no that would answer "which mailbox".
    expect(probe.events.some((entry) => entry.kind === 'approval_requested')).toBe(false);
    // Nor did it finish. A blocker that lands as a completion card is the whole reason for this.
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(false);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1) as unknown as {
      question?: { question: string };
      questionsAsked?: number;
      messages: Array<{ role: string; toolCallId?: string; content: string }>;
    };
    expect(saved.question).toMatchObject({ question: parked.question });
    expect(saved.questionsAsked).toBe(1);
    // The call is answered before the park - a tool call with no result is a malformed window, and
    // this one is reloaded by whichever worker picks the conversation back up - and the read the
    // model proposed behind the question is deferred in writing rather than run.
    expect(saved.messages.find((message) => message.toolCallId === 'call-2')?.content).toContain(
      'parked until the user answers'
    );
    expect(saved.messages.find((message) => message.toolCallId === 'call-3')?.content).toContain(
      'Deferred because the turn stopped for a question'
    );
    expect(log.calls.filter((entry) => entry.includes('terms.md'))).toHaveLength(0);
  });

  it('refuses a question from a turn that has looked at nothing, and keeps working', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [toolFrame('call-1', 'ask', parked), textFrame('Assumed the work address; say if not.')],
      log
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(probe.events.some((entry) => entry.kind === 'question_asked')).toBe(false);
    expect(probe.notifications).toHaveLength(0);
    expect(probe.checkpoints.some((entry) => entry.status === 'awaiting_user')).toBe(false);
    const refusal = decryptCheckpoints(probe.checkpoints)
      .at(-1)
      ?.messages.find((message) => message.toolCallId === 'call-1');
    expect(refusal?.content).toContain('has not looked at anything yet');
  });

  it('takes the answer back into the turn that asked, rather than starting a fresh one', async () => {
    const asking = {
      messages: [
        { role: 'user', content: 'Send the invoice' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'ask', arguments: parked }]
        },
        { role: 'tool', toolCallId: 'call-2', content: 'Asked. The conversation is parked.' }
      ],
      step: 2,
      credits: 0,
      turn: 0,
      question: { question: parked.question, askedAtStep: 2 },
      questionsAsked: 1,
      turnToolResults: { 'call-1': { name: 'files_list', success: true } }
    };
    const task = makeTask(asking);
    const probe = probeStore(() => task);
    const consumed: Array<Record<string, unknown>> = [];
    let pending = 1;
    Object.assign(probe.store, {
      getNextQueuedTaskMessage: async () => {
        if (pending <= 0) return null;
        pending -= 1;
        return {
          id: 'answer-1',
          taskId,
          userId,
          promptCiphertext: encryptJson({ prompt: 'billing@' }, dataKey, `task-message:${taskId}`),
          modelId: model.id,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          maxSpendUsd: null,
          resourceClass: 'task_compute',
          reservationKey: 'r',
          status: 'queued',
          // Deliberately not an interrupt. A correction has to be marked, because "do this next"
          // and "no, not that" cannot be told apart by timing; an answer needs no marking, because
          // the agent has stopped and said what it is waiting for.
          interrupt: false,
          createdAt: '2026-07-01T00:00:00.000Z',
          promotedAt: null
        };
      },
      consumeQueuedTaskMessageInTurn: async (input: Record<string, unknown>) => {
        consumed.push(input);
        return true;
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Sent from billing@.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({ messageId: 'answer-1', additionalComputeCredits: 5 });
    const sent = log.modelRequests.at(-1)?.messages as Array<{ role: string; content: string }>;
    // Their words, in their own role, in the same window as the question - so the turn carries on
    // with everything it had already established rather than re-deriving it from a new turn.
    expect(sent.some((message) => message.role === 'user' && message.content === 'billing@')).toBe(
      true
    );
    expect(sent.some((message) => message.role === 'tool')).toBe(true);
    expect(decryptCheckpoints(probe.checkpoints).at(-1)).not.toHaveProperty('question');
  });

  it('goes back to waiting when it is re-leased before the answer arrives', async () => {
    // A worker restart, a sweep, an owner pressing Resume: whatever picks the conversation up, a
    // question with no answer yet has to return to waiting rather than carry on as though it had
    // been answered. It costs no model call at all.
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Send the invoice' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'ask', arguments: parked }]
        },
        { role: 'tool', toolCallId: 'call-2', content: 'Asked. The conversation is parked.' }
      ],
      step: 2,
      credits: 0,
      turn: 0,
      question: { question: parked.question, askedAtStep: 2 }
    });
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Never reached.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(log.modelRequests).toHaveLength(0);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user', clearLease: true });
  });
});

describe('an agent that asks the same question twice', () => {
  it('answers an identical read with a pointer instead of running it again', async () => {
    // A stuck agent re-runs the identical search, gets the identical answer, and spends the whole
    // step budget learning nothing. The step ceiling stops it eventually, but the run ends with the
    // work undone rather than at the point the agent should have tried something else.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    const searches: string[] = [];
    installFetch(
      [
        toolFrame('call-1', 'code_search', { query: 'handleRequest', path: 'workspace' }),
        toolFrame('call-2', 'code_search', { query: 'handleRequest', path: 'workspace' }),
        textFrame('Done.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/exec')) return undefined;
          searches.push(url);
          return new Response(JSON.stringify({ stdout: '', stderr: '', exitCode: 1 }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The second identical search never reached the runner.
    expect(searches).toHaveLength(1);
    // And the model was told where the answer already is, rather than being refused silently.
    const messages = decryptCheckpoints(probe.checkpoints).at(-1)?.messages ?? [];
    const answer = messages.find((message) => message.toolCallId === 'call-2')?.content ?? '';
    expect(answer).toContain('call-1');
    expect(answer).toContain('same code_search call');
  });

  it('leaves polling alone, because repeating those is how they are meant to be used', async () => {
    // `process` is how the model is told to watch a build, and browser_snapshot takes no arguments
    // at all so every call looks identical. Deduplicating either would break the documented way to
    // use them.
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let snapshots = 0;
    installFetch(
      [
        toolFrame('call-1', 'files_list', { path: 'workspace' }),
        toolFrame('call-2', 'files_list', { path: 'workspace' }),
        textFrame('Done.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/files?path=')) return undefined;
          snapshots += 1;
          return new Response(JSON.stringify({ entries: [] }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    // files_list is read-only but not in the set: listing a directory twice is how you notice
    // something appeared in it.
    expect(snapshots).toBe(2);
  });
});

describe('the prompt prefix a follow-up turn re-sends', () => {
  /** The messages of one recorded request, as the provider received them. */
  const requestMessages = (
    log: FetchLog,
    request: number
  ): Array<{ role: string; content: string }> =>
    (log.modelRequests[request]?.messages ?? []) as Array<{ role: string; content: string }>;

  /** How many leading messages two requests agree on, byte for byte. */
  const sharedPrefix = (
    left: Array<{ role: string; content: string }>,
    right: Array<{ role: string; content: string }>
  ): number => {
    let shared = 0;
    while (
      shared < left.length &&
      shared < right.length &&
      JSON.stringify(left[shared]) === JSON.stringify(right[shared])
    )
      shared += 1;
    return shared;
  };

  it('is byte-identical up to the point where the new turn starts talking', async () => {
    // Only the clock is faked. The run awaits real timers, and what this is about is what the
    // window looks like when a follow-up arrives some minutes after the turn before it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T09:12:00.000Z'));

    let task = makeTask();
    const probe = probeStore(() => task);
    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    expect(saved?.messages.length).toBeGreaterThan(0);
    const followUp = startTurnState(saved as unknown as Record<string, unknown>, {
      prompt: 'Now archive last year’s notes too',
      turn: 1,
      reservationKey: 'reservation-2'
    });

    vi.setSystemTime(new Date('2026-07-01T09:17:00.000Z'));
    task = makeTask(followUp);
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const opening = requestMessages(first, 0);
    const resumed = requestMessages(second, 0);
    const shared = sharedPrefix(opening, resumed);

    // The whole of the first turn's opening request is re-sent unchanged except its last message,
    // and that last message is the runtime block - the only thing in the window meant to change.
    // Every byte the provider cached for the first turn is still readable on the second.
    expect(shared).toBe(opening.length - 1);
    expect(opening.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
    expect(resumed.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
    // Vacuous if the clock had not moved: the point is that the volatile bytes DID change and the
    // prefix survived anyway.
    expect(resumed.at(-1)?.content).not.toBe(opening.at(-1)?.content);
    // And the first thing the second turn sends that the first did not is the first turn's own
    // reply, not a system block quietly reinserted ahead of the trajectory.
    expect(resumed[shared]?.role).not.toBe('system');
  });

  it('carries every installed system block ahead of the original request, and the runtime block behind everything', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], log);
    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const messages = requestMessages(log, 0);
    const goal = messages.findIndex((message) => message.role === 'user');
    // Every system block the harness installs belongs in front of the goal, because that is the
    // region `condensableStart` protects and the anchor breakpoint closes. The runtime block is the
    // one exception, and it is at the very end where rewriting it is free.
    expect(goal).toBeGreaterThan(0);
    expect(messages.slice(0, goal).every((message) => message.role === 'system')).toBe(true);
    expect(
      messages.slice(0, goal).some((message) => message.content.startsWith(RUNTIME_CONTEXT_MARKER))
    ).toBe(false);
    expect(messages.at(-1)?.content.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
  });

  it('renders the skill index in an order that opening a skill cannot change', async () => {
    /*
     * The store returns saved skills most-recently-updated first, and viewing one stamps that
     * column - so the owner opening a skill reordered this block and rewrote the front of the
     * prompt on their next turn, their own browsing paying the write premium on the whole window
     * behind it. What is rendered is an index rather than a ranking, and ids are written once and
     * never rewritten, so ordering by id costs the model nothing it was being told.
     */
    const skill = (id: string, name: string): Record<string, unknown> => ({
      id,
      enabled: true,
      status: 'active',
      pinned: false,
      documentCiphertext: encryptJson(
        { name, description: `How to ${name}` },
        dataKey,
        `workspace-skill:${workspaceId}`
      )
    });
    const rendered = async (order: Array<Record<string, unknown>>): Promise<string> => {
      const task = makeTask();
      const probe = probeStore(() => task);
      const store = {
        ...(probe.store as unknown as Record<string, unknown>),
        listWorkspaceSkills: async () => order
      } as unknown as DataStore;
      const log: FetchLog = { calls: [], modelRequests: [] };
      installFetch([textFrame('Tidied.')], log);
      await new AgentWorker(store, config(), masterKey, runnerSecret)
        .run(task)
        .catch(() => undefined);
      return (
        requestMessages(log, 0).find((message) =>
          message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
        )?.content ?? ''
      );
    };

    const drafting = skill('skill-a', 'draft the weekly note');
    const filing = skill('skill-b', 'file the receipts');
    const before = await rendered([drafting, filing]);
    // The owner opens the second one, so the store hands it back first from here on.
    const after = await rendered([filing, drafting]);

    expect(before).toContain('draft the weekly note');
    expect(before.indexOf('skill-a')).toBeLessThan(before.indexOf('skill-b'));
    expect(after).toBe(before);
  });

  it('leaves the reviewed block where it is when a resume cannot rebuild the memory pack', async () => {
    /*
     * The two recalled blocks have a fixed order - what the owner approved, then what recall found -
     * and the pack's own comment says so. The knowledge block used to be spliced out of the window
     * and re-inserted at the end of the leading system run, which puts it *after* the pack; the
     * pack's injector happened to do the same dance a few lines later and put it back, so the two
     * moves cancelled and nothing showed. They stop cancelling the moment the pack cannot be
     * rebuilt - a store that is briefly unavailable on a follow-up, which is the one case that path
     * exists for - and then the two blocks swap for the rest of the task and every cached byte
     * behind them is written again. Replacing the block where it already sits removes the
     * dependence on one bug undoing another.
     */
    const item = {
      id: 'memory-item-1',
      layer: 'item' as const,
      kind: 'fact' as const,
      trust: 'stated' as const,
      status: 'active' as const,
      observedAt: '2026-06-01T00:00:00.000Z',
      validFrom: '2026-06-01T00:00:00.000Z',
      validTo: null,
      subjectKey: null,
      predicate: null,
      tokensEst: 20,
      score: 1,
      documentCiphertext: encryptJson(
        { title: 'Where notes live', body: 'Notes live under workspace/notes' },
        dataKey,
        memoryItemAad(workspaceId)
      )
    };
    let packRecord: Record<string, unknown> | null = null;
    let packReadable = true;
    let task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...(probe.store as unknown as Record<string, unknown>),
      getMemoryPack: async () => {
        if (!packReadable) throw new Error('memory store unavailable');
        return packRecord;
      },
      recallMemoryCandidates: async () => [item],
      saveMemoryPack: async (input: Record<string, unknown>) => {
        packRecord = {
          ...input,
          itemIds: [...(input.itemIds as string[])],
          createdAt: '2026-07-01T00:00:00.000Z'
        };
        return packRecord;
      }
    } as unknown as DataStore;

    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const opening = requestMessages(first, 0);
    const knowledgeAt = opening.findIndex((message) =>
      message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
    );
    const packAt = opening.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER));
    // Vacuous unless both blocks are actually there and in that order.
    expect(knowledgeAt).toBeGreaterThan(0);
    expect(packAt).toBe(knowledgeAt + 1);

    packReadable = false;
    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    task = makeTask(
      startTurnState(saved as unknown as Record<string, unknown>, {
        prompt: 'Now archive last year’s notes too',
        turn: 1,
        reservationKey: 'reservation-2'
      })
    );
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const resumed = requestMessages(second, 0);
    expect(
      resumed.findIndex((message) => message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE'))
    ).toBe(knowledgeAt);
    expect(resumed.findIndex((message) => message.content.startsWith(MEMORY_PACK_MARKER))).toBe(
      packAt
    );
    expect(sharedPrefix(opening, resumed)).toBeGreaterThan(packAt);
  });

  it('ranks the curated knowledge block once, so a follow-up does not reshuffle it', async () => {
    // Two entries the two requests would rank in opposite orders: the first shares a word with the
    // opening request, the second with the follow-up. The block says it is frozen for the run, and
    // this is what makes that true.
    const memory = (id: string, content: string): Record<string, unknown> => ({
      id,
      target: 'workspace',
      contentCiphertext: encryptJson({ content }, dataKey, `workspace-memory:${workspaceId}`),
      updatedAt: '2026-06-01T00:00:00.000Z'
    });
    let task = makeTask();
    const probe = probeStore(() => task);
    const store = {
      ...(probe.store as unknown as Record<string, unknown>),
      listWorkspaceMemories: async () => [
        memory('memory-notes', 'Notes live under workspace/notes'),
        memory('memory-archive', 'Archive anything older than a year into workspace/archive')
      ]
    } as unknown as DataStore;

    const first: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Tidied.')], first);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const saved = decryptCheckpoints(probe.checkpoints).at(-1);
    task = makeTask(
      startTurnState(saved as unknown as Record<string, unknown>, {
        prompt: 'Now archive last year’s notes too',
        turn: 1,
        reservationKey: 'reservation-2'
      })
    );
    const second: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('Archived.')], second);
    await new AgentWorker(store, config(), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const knowledge = (log: FetchLog): string =>
      requestMessages(log, 0).find((message) =>
        message.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')
      )?.content ?? '';
    expect(knowledge(first)).toContain('workspace/notes');
    expect(knowledge(first)).toContain('workspace/archive');
    expect(knowledge(second)).toBe(knowledge(first));
  });
});

/*
 * Measured on a live run: writing a two-line haiku produced a transcript whose visible content was
 * an amber "no undo point" card, a red "file_write failed" the agent had already recovered from,
 * and a cost line. The verse was third. Almost every warning the worker writes is a note to itself,
 * and the transcript now folds those into the work log - so the few that are genuinely the owner's
 * business have to say so at the site that raises them.
 */
describe('the warnings that are the owner’s business', () => {
  const ownerFlag = (entry: { payload: unknown } | undefined): unknown =>
    (entry?.payload as { owner?: unknown } | undefined)?.owner;

  it('raises an action that no longer matches what the owner approved', async () => {
    const approved = { executable: 'rm', args: ['-rf', 'workspace/old'] };
    const attempted = { executable: 'rm', args: ['-rf', 'workspace'] };
    const task = makeTask({
      messages: [
        { role: 'user', content: 'Clear the old folder' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-s', name: 'shell', arguments: attempted }]
        }
      ],
      step: 1,
      credits: 0,
      pending: {
        approvalId: 'approval-1',
        toolCall: { id: 'call-s', name: 'shell', arguments: attempted }
      }
    });
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      getApproval: async () => ({
        id: 'approval-1',
        status: 'approved',
        previewHash: approvalPreviewHash(dataKey, approved),
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([textFrame('I will not run that.')], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const refusal = probe.events.find((entry) =>
      entry.summary.startsWith('Refused: this action no longer matches')
    );
    expect(refusal?.kind).toBe('warning');
    expect(ownerFlag(refusal)).toBe(true);
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  });

  it('raises the answer it will not continue, and not the ones it will', async () => {
    const cutOff = `data: ${JSON.stringify({
      choices: [{ finish_reason: 'length', delta: { content: 'and then, ' } }]
    })}\n\ndata: [DONE]\n\n`;
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([cutOff], log);

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 5 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const continuing = probe.events.find((entry) => entry.summary.includes('is being continued'));
    const capped = probe.events.find((entry) =>
      entry.summary.includes('was not continued automatically')
    );
    // Continuing is the harness doing its job and the owner reads the finished answer either way.
    expect(continuing?.kind).toBe('warning');
    expect(ownerFlag(continuing)).toBeUndefined();
    // Stopping is an answer handed over incomplete, which nothing else in the transcript says.
    expect(capped?.kind).toBe('warning');
    expect(ownerFlag(capped)).toBe(true);
  });

  it('raises the reason a task stopped without doing what was asked', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const journal = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret).fail(
      task,
      new Error('The workspace could not be reached')
    );

    const failure = probe.events.find((entry) => entry.kind === 'error');
    expect(failure?.summary).toBe('The workspace could not be reached');
    expect(ownerFlag(failure)).toBe(true);
    journal.mockRestore();
  });

  /**
   * The other half of the same failure, and the half the owner can actually read. The event above
   * is encrypted for good reasons; this box's owner is also its operator, and an error that needs
   * the master key to read is one they cannot diagnose.
   */
  it('writes the failure to the journal, where the owner can read it without a key', async () => {
    const task = makeTask({ messages: [], step: 12, credits: 0, turn: 2 });
    const probe = probeStore(() => task);
    const journal = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret).fail(
      task,
      new AthanorError('model_timeout', 'The model provider did not respond within 900 seconds'),
      903_000
    );

    const line = String(journal.mock.calls.at(0)?.[0]);
    journal.mockRestore();
    expect(line).toContain(`task ${taskId} failed at turn 2 step 12 after 903.0s`);
    expect(line).toContain('model_timeout');
    // The sentence the model provider wrote is in the encrypted event and nowhere else.
    expect(line).not.toContain('did not respond');
  });

  it('leaves that line behind even when the store is what failed', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    Object.assign(probe.store, {
      appendTaskEvent: async () => {
        throw new Error('database is not accepting connections');
      }
    });
    const journal = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await new AgentWorker(probe.store, config(), masterKey, runnerSecret)
      .fail(task, new AthanorError('workspace_unreachable', 'The workspace could not be reached'))
      .catch(() => undefined);

    const line = String(journal.mock.calls.at(0)?.[0]);
    journal.mockRestore();
    expect(line).toContain('workspace_unreachable');
  });
});

/**
 * The batch of reads a frontier model opens a task with.
 *
 * Every call in it used to wait for the one in front of it to cross to the runner and come back,
 * which is three round trips of nothing on a four-read batch. What must not change is anything the
 * loop decides: the stop check, the floor's verdict on each call, and above all the order the
 * results land in the window - a turn whose window depends on which read finished first is a turn
 * that cannot be reproduced.
 */
describe('reads proposed together', () => {
  const batchFrame = (
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  ): string =>
    `data: ${JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.args) }
            }))
          }
        }
      ]
    })}\n\ndata: [DONE]\n\n`;

  const reads = (
    ...names: string[]
  ): Array<{ id: string; name: string; args: Record<string, unknown> }> =>
    names.map((name, index) => ({
      id: `call-${index + 1}`,
      name: 'file_read',
      args: { path: `workspace/${name}.txt` }
    }));

  const readPath = (url: string): string =>
    decodeURIComponent(new URL(url).searchParams.get('path') ?? '');

  /** A runner response whose body arrives only when `until` settles, and dies if torn down first. */
  const heldBody = (body: string, until: Promise<void>, signal?: AbortSignal | null): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let settled = false;
          const tearDown = (): void => {
            if (settled) return;
            settled = true;
            controller.error(new Error('the connection was torn down'));
          };
          if (signal?.aborted) {
            tearDown();
            return;
          }
          signal?.addEventListener('abort', tearDown, { once: true });
          void until.then(() => {
            if (settled) return;
            settled = true;
            controller.enqueue(encode(body));
            controller.close();
          });
        }
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  const toolMessages = (probe: StoreProbe): Array<{ toolCallId?: string; content: string }> => {
    const state = decryptCheckpoints(probe.checkpoints).at(-1);
    return (state?.messages ?? []).filter((message) => message.role === 'tool');
  };

  it('holds all four open at once and still answers them in the declared order', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    const openers: Array<() => void> = [];
    let inFlight = 0;
    installFetch(
      [batchFrame(reads('alpha', 'bravo', 'charlie', 'delta')), textFrame('Read them.')],
      log,
      {
        route: (url) => {
          // Only the batch's own reads. The turn opens by looking for the workspace's durable
          // instructions, and holding that one would hang the run before the model is even asked.
          if (!url.includes('/file?') || !readPath(url).endsWith('.txt')) return undefined;
          const path = readPath(url);
          let open = (): void => undefined;
          const body = heldBody(
            JSON.stringify({ marker: path }),
            new Promise<void>((resolve) => {
              open = resolve;
            })
          );
          openers.push(open);
          inFlight += 1;
          // Nothing is answered until every read in the run has been dispatched, so this test can
          // only finish if they really were in flight together - and they are then answered
          // backwards, so a window that came out in the declared order cannot have got there by
          // following the order the runner happened to reply in.
          if (inFlight === 4) for (const release of [...openers].reverse()) release();
          return body;
        }
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(inFlight).toBe(4);
    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4'
    ]);
    for (const [index, name] of ['alpha', 'bravo', 'charlie', 'delta'].entries())
      expect(answered[index]?.content).toContain(`workspace/${name}.txt`);
    // And the timeline reads in the same order, because that is the record the owner scrolls.
    expect(
      probe.events
        .filter((entry) => entry.kind === 'tool_result')
        .map((entry) => (entry.payload as { toolCallId?: string }).toolCallId)
    ).toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
    // Three state writes for the whole turn: one for the run, then the step's own and the closing
    // one. Four reads that would each have written twice had they been anything but reads now cost
    // a single point at which everything already fetched is durable.
    expect(probe.checkpoints.filter((input) => input.agentStateCiphertext).length).toBe(3);
  });

  it('keeps the answers that came back when one of the run throws', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [batchFrame(reads('alpha', 'missing', 'charlie')), textFrame('Two of three.')],
      log,
      {
        route: (url) => {
          if (!url.includes('/file?')) return undefined;
          const path = readPath(url);
          if (path.includes('missing'))
            return new Response(
              JSON.stringify({ error: { code: 'file_not_found', message: 'no such file' } }),
              { status: 404, headers: { 'content-type': 'application/json' } }
            );
          return new Response(JSON.stringify({ marker: path }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
    // The one that failed says so, in its own place, and the two that came back are still here -
    // a run that threw away three good reads because the second one was a typo would be a worse
    // loop than the one that ran them one at a time.
    expect(answered[0]?.content).toContain('workspace/alpha.txt');
    expect(answered[1]?.content).toContain('Tool failed');
    expect(answered[2]?.content).toContain('workspace/charlie.txt');
    expect(probe.events.filter((entry) => entry.kind === 'error')).toHaveLength(1);
  });

  it('runs the reads, then stops at the call the floor wants a card for', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const approvals: Array<Record<string, unknown>> = [];
    const store = {
      ...probe.store,
      createApproval: async (input: Record<string, unknown>) => {
        approvals.push(input);
        return 'approval-1';
      }
    } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        batchFrame([
          ...reads('alpha', 'bravo'),
          {
            id: 'call-3',
            name: 'schedule',
            args: { action: 'create', title: 'Nightly', prompt: 'Check the feed', spec: {} }
          },
          { id: 'call-4', name: 'file_read', args: { path: 'workspace/delta.txt' } }
        ]),
        textFrame('Waiting on you.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/file?')
            ? new Response(JSON.stringify({ marker: readPath(url) }), {
                headers: { 'content-type': 'application/json' }
              })
            : undefined
      }
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 1 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(approvals).toHaveLength(1);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'awaiting_user' });
    const answered = toolMessages(probe);
    // The two reads in front of the card are answered and kept: the turn parks on the approval
    // with its reading already done, not with it thrown away.
    expect(answered[0]?.content).toContain('workspace/alpha.txt');
    expect(answered[1]?.content).toContain('workspace/bravo.txt');
    // And the read behind the card is deferred in writing rather than run, exactly as it was when
    // every call went one at a time.
    expect(answered.find((message) => message.toolCallId === 'call-4')?.content).toContain(
      'Deferred because an earlier action requires user approval'
    );
    expect(log.calls.filter((entry) => entry.includes('delta.txt'))).toHaveLength(0);
  });

  it('loses nothing when the owner presses Stop with the run in flight', async () => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let inFlight = 0;
    const never = new Promise<void>(() => undefined);
    installFetch([batchFrame(reads('alpha', 'bravo', 'charlie')), textFrame('Stopped.')], log, {
      route: (url, init) => {
        if (!url.includes('/file?') || !readPath(url).endsWith('.txt')) return undefined;
        inFlight += 1;
        // Stopped once the whole run is out on the wire, which is the moment this is about: three
        // requests the owner has already paid for, none of them answered yet.
        if (inFlight === 3) {
          task.status = 'paused';
          // A pause clears the lease in the same statement that sets the status, and the closing
          // write is the one that saves the trajectory - a probe that left the lease on would test
          // the disowned path instead.
          task.leaseOwner = null;
        }
        return heldBody('never arrives', never, init?.signal);
      }
    });

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    expect(inFlight).toBe(3);
    // One poll of the cancellation watch reaches every request in the run, because they all
    // inherit its signal.
    const answered = toolMessages(probe);
    expect(answered.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3']);
    for (const message of answered) expect(message.content).toContain('Tool failed');
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'paused', clearLease: true });
    expect(probe.events.some((entry) => entry.summary === 'Task paused by user')).toBe(true);
  }, 15_000);
});

/**
 * A turn that runs out of steps while the job is demonstrably unfinished and demonstrably moving.
 *
 * The ceiling used to end the turn and write a handoff saying the work continues "the moment the
 * user replies" - which on a scheduled run at three in the morning is eight hours away. These are
 * about the harness taking that decision itself, and about how much harder it is to get a yes than
 * a no: the acceptance record must exist, the harness itself must have just watched it fail, the
 * turn must still be changing things, and the owner must not have stopped it.
 */
describe('a turn that finishes the job rather than the budget', () => {
  const failingCheck = {
    checks: [
      {
        id: 'check-1',
        kind: 'command',
        label: 'the importer test passes',
        executable: 'pytest',
        args: ['-q'],
        cwd: 'workspace',
        expectExit: 0,
        timeoutSeconds: 300
      }
    ],
    revisions: 1,
    declaredAtStep: 0
  };

  /** A turn mid-job: it declared its checks, and it has already changed something. */
  const workingState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    messages: [
      { role: 'user', content: 'Fix the importer' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-0', name: 'file_write', arguments: {} }]
      },
      { role: 'tool', toolCallId: 'call-0', content: 'ok' }
    ],
    step: 0,
    credits: 0,
    mutated: true,
    mutatedBeyondProse: true,
    turnToolResults: { 'call-0': { name: 'file_write', success: true, mutating: true } },
    acceptance: failingCheck,
    acceptanceTurn: 0,
    ...over
  });

  const exec = (exitCode: number) => (url: string) =>
    url.includes('/exec')
      ? new Response(
          JSON.stringify({
            exitCode,
            stdout: '',
            stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
            durationMs: 5,
            timedOut: false
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      : undefined;

  it('renews its own budget when the harness watches its checks fail, and says so', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        textFrame('Still working.'),
        textFrame('Carrying on.'),
        textFrame('Nearly there.'),
        toolFrame('call-hand', 'finish', {
          summary: 'The importer reads two of three columns; the third is still failing.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 1 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // Two budgets of two steps, and then the one closing call - which the budget has never counted.
    expect(log.modelRequests).toHaveLength(5);
    const continued = probe.events.find((entry) =>
      entry.summary.startsWith('Continuing on its own')
    );
    expect(continued?.summary).toContain('(1 of 1)');
    expect(continued?.summary).toContain('1 of 1 acceptance check still fails after 2 steps');
    expect(continued?.payload).toMatchObject({ continuation: 1, step: 2, maxSteps: 4 });
    // The model is told what the harness saw, not that it was given more rope.
    const renewed = ((log.modelRequests[2]?.messages ?? []) as Array<{ content: string }>)
      .map((message) => message.content)
      .join('\n');
    expect(renewed).toContain('BUDGET RENEWED (1 of 1) after 2 steps');
    expect(renewed).toContain('AssertionError: expected 3 rows, found 0');
    expect(renewed).toContain('This is the last renewal there is');
    // ...and the wind-down it was given for the first budget is gone, replaced by one counting down
    // to the ceiling that is actually in force. Carrying the old one would leave the model holding a
    // standing instruction to stop starting work, which is exactly what it has just been told not to
    // do - and would cost the renewed budget any warning of its own ending.
    expect(renewed.split('FINAL STEPS').length - 1).toBe(1);
    expect(renewed).toContain("2 of this turn's 4 steps remain");
    // It still ends where the owner can act on it, with the ceiling it actually worked to.
    const ceiling = probe.events.find(
      (entry) => entry.kind === 'warning' && entry.summary.includes('whole step budget')
    );
    expect(ceiling?.payload).toMatchObject({ owner: true, maxSteps: 4, continuations: 1 });
  }, 15_000);

  it('stops the moment its own definition of done is satisfied', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        textFrame('Still working.'),
        toolFrame('call-hand', 'finish', {
          summary: 'The importer reads all three columns.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(0) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    // The checks the model wrote before the work all pass, which is the strongest evidence this box
    // has that the job is done - so the budget is not renewed and the turn spends its closing call.
    expect(
      probe.events.some(
        (entry) => entry.summary === 'Stopping at the step limit: every acceptance check now passes'
      )
    ).toBe(true);
    expect(log.modelRequests).toHaveLength(3);
  }, 15_000);

  it('is stopped by the same Stop, on the last step of the budget it would have renewed', async () => {
    const task = makeTask(workingState());
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Working.'),
        () => {
          // Stop, pressed while the last step of the budget was still streaming. Nothing about a
          // turn that can renew itself may make it harder to stop than one that cannot: the same
          // button, at the same moment, has to end it.
          task.status = 'paused';
          task.leaseOwner = null;
          return textFrame('Still working.');
        },
        textFrame('This call must never be made.')
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // No renewal, and no closing call billed after the stop either.
    expect(log.modelRequests).toHaveLength(2);
    expect(probe.events.some((entry) => entry.summary === 'Task paused by user')).toBe(true);
    expect(probe.checkpoints.at(-1)).toMatchObject({ status: 'paused', clearLease: true });
  }, 15_000);

  it('never renews a turn this worker no longer holds', async () => {
    // The lease moved while the budget was being spent. Renewing here would have this worker
    // announce a continuation on a conversation another one is running, and then save its own stale
    // trajectory over theirs - so the ceiling asks who holds the task before it asks anything about
    // the work.
    const task = makeTask(workingState());
    task.leaseOwner = 'worker-other';
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [textFrame('Working.'), textFrame('Still working.'), textFrame('Handing off.')],
      log,
      {
        route: exec(1)
      }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some(
        (entry) => entry.summary === 'Stopping at the step limit: another worker holds the task'
      )
    ).toBe(true);
    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // Nothing was run to work that out, either: who holds the task is a free read and it comes
    // before the checks, which can be a full build.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  }, 15_000);

  it('does not spend a check run establishing what the free reads already refused', async () => {
    const task = makeTask(
      // Nothing this turn changed: the acceptance record is inherited and the only successful call
      // was a read. Running the checks could only tell it what it is not allowed to act on anyway.
      workingState({
        turnToolResults: { 'call-0': { name: 'file_read', success: true } }
      })
    );
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        textFrame('Reading.'),
        textFrame('Still reading.'),
        toolFrame('call-hand', 'finish', {
          summary: 'I could not work out what was wrong.',
          verification: { status: 'not_applicable', evidence: [] }
        })
      ],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some(
        (entry) =>
          entry.summary === 'Stopping at the step limit: this turn has not changed anything yet'
      )
    ).toBe(true);
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  }, 15_000);

  it('will not renew itself on the checks an earlier turn declared', async () => {
    /*
     * The finish gate already refuses this record and says why: it was passing before this turn
     * began, so whatever this turn just did, that record is not evidence of it. The renewal has to
     * hold to the same rule, and the case for it is sharper - the renewal fires on a check
     * *failing*, and an inherited check that has started failing says this turn broke something an
     * earlier turn guaranteed. That is the owner's business, not another budget's.
     */
    const task = makeTask(workingState({ turn: 1 }));
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [textFrame('Working.'), textFrame('Still working.'), textFrame('Handing off.')],
      log,
      { route: exec(1) }
    );

    await new AgentWorker(
      probe.store,
      config({ TASK_MAX_STEPS: 2, TASK_MAX_SELF_CONTINUATIONS: 2 }),
      masterKey,
      runnerSecret
    )
      .run(task)
      .catch(() => undefined);

    expect(
      probe.events.some((entry) =>
        entry.summary.startsWith('Stopping at the step limit: the only acceptance checks on record')
      )
    ).toBe(true);
    expect(probe.events.some((entry) => entry.summary.startsWith('Continuing on its own'))).toBe(
      false
    );
    // Nothing was run to establish it: the turn a record belongs to is a free read, and it comes in
    // front of the checks, which can be a whole build.
    expect(log.calls.some((call) => call.includes('/exec'))).toBe(false);
  }, 15_000);
});

describe('what a tainted turn is charged for sending', () => {
  /**
   * The turn's novelty budget is the only bound on how much material can leave in a series of
   * addresses that are each individually innocent, and where it is charged decides whether it
   * bounds anything at all. Both halves below rested on a comment.
   *
   * The owner names the host, so reading it is ordinary and the second read of the same host is
   * inside every per-address bound - which is the case that has to be charged, not carded.
   */
  const OWNER_PROMPT = 'Read https://docs.example.test/guide and tell me what changed';

  const readingTask = (): TaskRecord => ({
    ...makeTask(),
    promptCiphertext: encryptJson({ prompt: OWNER_PROMPT }, dataKey, `task-prompt:${taskId}`)
  });

  /** What the runner answers a page read with, in the one field the taint and the origins are read from. */
  const pageRead = (url: string): Response =>
    new Response(
      JSON.stringify({
        sources: [{ url, requestedUrl: url, title: 'Guide', status: 200 }],
        pages: [{ url, text: 'Somebody else wrote this.' }]
      }),
      { headers: { 'content-type': 'application/json' } }
    );

  /** What the turn had spent when it was last written down, which is the running total itself. */
  const noveltySpent = (probe: StoreProbe): number | undefined =>
    probe.checkpoints
      .flatMap((input) =>
        input.agentStateCiphertext
          ? [
              decryptJson<{ turnNoveltyBytes?: number }>(
                input.agentStateCiphertext as Parameters<typeof decryptJson>[0],
                dataKey
              )
            ]
          : []
      )
      .at(-1)?.turnNoveltyBytes;

  it('charges a request that threw, because the request still went out', async () => {
    /*
     * Charging on the answer alone made stalling a free channel: a collector that accepts a request
     * and never replies produced `TOOL_REQUEST_TIMEOUT_MS`, left the total where it was, and the
     * next chunk was judged against the same figure again - so the per-turn bound bounded nothing
     * an attacker was willing to wait for. The hostname was resolved and the payload was in the
     * path before anything failed, and the only party who decides whether a request is answered is
     * the server being talked to.
     */
    const task = readingTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(
      [
        toolFrame('call-1', 'parallel_web_read', { urls: ['https://docs.example.test/guide'] }),
        toolFrame('call-2', 'parallel_web_read', {
          urls: ['https://docs.example.test/guide/changelog']
        }),
        textFrame('The second page never answered.')
      ],
      log,
      {
        route: (url) =>
          url.includes('/browser/read-many')
            ? log.calls.filter((call) => call.includes('/browser/read-many')).length > 1
              ? new Response(
                  JSON.stringify({
                    error: { code: 'runner_request_failed', message: 'the page never answered' }
                  }),
                  { status: 502, headers: { 'content-type': 'application/json' } }
                )
              : pageRead('https://docs.example.test/guide')
            : undefined
      }
    );

    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // The call failed, and the turn was told so.
    expect(probe.events.some((entry) => entry.kind === 'error')).toBe(true);
    // `changelog` is the one thing in that address that appears nowhere in the owner's words, so
    // it is exactly what the turn is charged. Asserted as the figure rather than as "more than
    // nothing": a charge of the whole URL would be a different bug wearing the same assertion.
    expect(noveltySpent(probe)).toBe('changelog'.length);
  }, 15_000);

  it('charges nothing for an answer the harness wrote, because nothing was sent', async () => {
    /*
     * The other side of the same rule. A repeat the loop answers from an earlier call, a plan the
     * owner republished under a proposed call, arguments cut off mid-JSON: nothing was run and
     * nothing left the machine, so a budget that spends itself on those raises approval cards on
     * turns where nothing was sent at all.
     *
     * Driven through the plan case because it is the one that can carry addresses: the repeat set
     * is workspace reads, which reach no host to charge for.
     */
    const task = readingTask();
    const probe = probeStore(() => task);
    const log: FetchLog = { calls: [], modelRequests: [] };
    let read = false;
    let version = 0;
    // The owner is republishing the plan, so the version the loop reads is newer than the one the
    // step began with - which is what "changed after this tool call was proposed" is. Held back
    // until the first read has landed, so the turn is tainted and the budget is live when the
    // second call is skipped; without the taint neither branch charges anything and this would
    // pass on a bug.
    const store = {
      ...probe.store,
      getLatestTaskPlan: async () =>
        read
          ? {
              id: 'plan',
              taskId,
              version: (version += 1),
              parentVersion: null,
              branchName: 'Main',
              stepsCiphertext: encryptJson(
                { steps: [{ id: 'step-1', title: 'Read the guide', status: 'in_progress' }] },
                dataKey,
                `task-plan:${taskId}`
              ),
              createdBy: 'user' as const,
              createdAt: '2026-07-01T00:00:00.000Z'
            }
          : null
    } as unknown as DataStore;
    installFetch(
      [
        toolFrame('call-1', 'parallel_web_read', { urls: ['https://docs.example.test/guide'] }),
        toolFrame('call-2', 'parallel_web_read', {
          urls: ['https://docs.example.test/guide/changelog']
        }),
        textFrame('Replanning.')
      ],
      log,
      {
        route: (url) => {
          if (!url.includes('/browser/read-many')) return undefined;
          read = true;
          return pageRead('https://docs.example.test/guide');
        }
      }
    );

    await new AgentWorker(store, config({ TASK_MAX_STEPS: 3 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);

    // One read reached the runner; the second call was answered by the harness instead.
    expect(log.calls.filter((call) => call.includes('/browser/read-many'))).toHaveLength(1);
    expect(
      probe.events.some(
        (entry) =>
          entry.kind === 'tool_result' &&
          JSON.stringify(entry.payload).includes('changed the active plan')
      )
    ).toBe(true);
    // Nothing was ever added, so the running total is still untouched rather than merely small.
    expect(noveltySpent(probe) ?? 0).toBe(0);
  }, 15_000);
});

/**
 * A call this side ended rather than one the model finished.
 *
 * The gateway keeps what was written, says what ended it, and marks the usage it had to work out
 * for itself because the frame carrying the real numbers is the one a cut stream never reaches.
 * Two things have to happen here: the prompt is billed from what this side sent, and the owner is
 * told why the answer they are looking at stops where it does.
 */
describe('a generation the box cut short', () => {
  /**
   * An answer that runs past the ceiling `maxTokens` implies - eight characters a token against a
   * 16,384-token cap - which is the one cutoff a test can provoke without spending the wall time
   * the other two are measured in.
   *
   * Every line differs, so what is measured is the ceiling rather than the repetition watch: a
   * hundred thousand characters of the same sentence is a degenerate repeat and would be stopped
   * long before the generation budget noticed anything.
   */
  const overrunningAnswer = ((): string => {
    const lines: string[] = [];
    for (let index = 0, length = 0; length < 140_000; index += 1) {
      const line = `Point ${index}: workspace/notes/${index}.md still wants a heading and a date.`;
      lines.push(line);
      length += line.length + 1;
    }
    return lines.join('\n');
  })();

  /** The stream as a cut one arrives: text, then nothing. No finish reason, and no usage frame. */
  const cutOffStream = `data: ${JSON.stringify({
    choices: [{ delta: { content: overrunningAnswer } }]
  })}\n\n`;

  /** Four characters to the token, which is what the gateway counts a cut-off answer at. */
  const estimatedOutput = Math.ceil(overrunningAnswer.length / 4);

  const finishFrame = toolFrame('call-1', 'finish', {
    summary: 'The answer was cut off, and what stands is in the reply above.',
    verification: { status: 'not_applicable', evidence: [] }
  });

  const run = async (
    bodies: string[]
  ): Promise<{ probe: StoreProbe; log: FetchLog; billed: Array<Record<string, unknown>> }> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
      recordUsage: async (input: Record<string, unknown>) => {
        if (input.kind === 'model_inference') billed.push(input);
      }
    });
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch(bodies, log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 4 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    return { probe, log, billed };
  };

  it('bills the prompt it sent for a call whose usage never came back', async () => {
    const { probe, log, billed } = await run([cutOffStream, finishFrame]);

    // What the loop said it was sending, read back off its own cost event and off the catalogue on
    // the wire - the two halves of a request, and between them the whole of what a provider bills
    // as input. Nothing in the response carries either number: the usage frame never arrived.
    const cost = probe.events.find((entry) => entry.kind === 'cost');
    const messageTokens = (
      cost?.payload as { context: { estimatedInputTokens: number } } | undefined
    )?.context.estimatedInputTokens;
    const catalogue = (log.modelRequests[0]?.tools ?? []) as Array<{ function: unknown }>;
    const catalogueTokens = Math.ceil(
      JSON.stringify(catalogue.map((tool) => tool.function)).length / 4
    );

    expect(messageTokens).toBeGreaterThan(0);
    expect(billed[0]?.quantity).toBe(messageTokens! + catalogueTokens + estimatedOutput);
    // The ledger row is the one the owner's spend is added up from, so the failure this replaces is
    // not a rounding error: it filed the prompt at nothing and the output at the provider's silence.
    expect(billed[0]?.unit).toBe('tokens');
    expect(Number(billed[0]?.credits)).toBeGreaterThan(0);
  }, 20_000);

  it('says why the answer stops there, and does not ask for the rest of it', async () => {
    const { probe, log } = await run([cutOffStream, finishFrame]);

    const cut = probe.events.find((entry) =>
      entry.summary.startsWith('The answer was cut off before it finished')
    );
    expect(cut?.kind).toBe('warning');
    // An answer handed over incomplete is the owner's business, in the way a continuation is not.
    expect((cut?.payload as { owner?: unknown } | undefined)?.owner).toBe(true);
    expect((cut?.payload as { reason?: unknown } | undefined)?.reason).toBe('overrun');

    const windows = log.modelRequests.map((body) => JSON.stringify(body.messages));
    // The model is told, and told once. What it must not be told is to carry on: the gateway had
    // already decided this generation had stopped being productive, and continuing it buys the
    // same cut-off answer again at the same price.
    expect(windows.at(-1)).toContain('YOUR REPLY WAS CUT OFF');
    expect(windows.some((window) => window.includes('CONTINUE THE ANSWER'))).toBe(false);
    // Bounded: it fell through to the completion check, which ends the turn by completing it.
    expect(windows.at(-1)).toContain('COMPLETION CHECK');
    expect(log.modelRequests).toHaveLength(2);
    expect(probe.events.some((entry) => entry.kind === 'completed')).toBe(true);
  }, 20_000);
});
