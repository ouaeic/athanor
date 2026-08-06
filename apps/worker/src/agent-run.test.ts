import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson, generateDataKey, wrapDataKey } from '@athanor/core';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@athanor/data';
import type { ModelRelease } from '@athanor/contracts';
import {
  AgentWorker,
  approvalPreviewHash,
  DELEGATE_MAX_STEPS,
  MAX_NOTICES_PER_TURN,
  UNTRUSTED_NOTICE_MARKER
} from './agent.js';
import { managedMediaCatalog } from './media.js';
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
  providerBodies: Array<BodyInit | (() => BodyInit)>,
  log: FetchLog,
  runner: {
    checkpoint?: () => Response;
    route?: (url: string) => Response | undefined;
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
      return new Response(typeof next === 'function' ? next() : (next ?? ''), {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    if (log.runnerRequests && typeof init?.body === 'string')
      log.runnerRequests.push({ url, body: JSON.parse(init.body) as unknown });
    const routed = runner.route?.(url);
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
    // gone, folded into code_search's wholeWord.
    expect(names).toHaveLength(38);
    expect(names).toEqual(
      expect.arrayContaining([
        'document_read',
        'image_read',
        'browser_snapshot',
        'generate_media',
        'compact_context',
        // Research, comparison and a job hunt all begin here, and until now the catalogue had no
        // way to search at all - the prompt sent the model to drive a browser at a search page.
        'web_search',
        // The retrieval store could be read once at task start and never asked a question again.
        'memory_recall',
        'notify'
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
 * exercise the wiring rather than the verdict: that the worker asks once per run, sends what the
 * plan says to send, withdraws what it says to withdraw, and never lets a mid-run credential edit
 * move a task onto a route the owner was not asked about.
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
    body = textFrame('thinking')
  ): Promise<{ log: FetchLog; probe: StoreProbe }> => {
    const probe = probeStore(() => task);
    const store = { ...probe.store, listModels: async () => catalog } as unknown as DataStore;
    const log: FetchLog = { calls: [], modelRequests: [] };
    installFetch([body], log);
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
      (entry) => (entry.payload as { blockedBy?: string } | undefined)?.blockedBy === 'spend_guard_unavailable'
    );
    expect(stated?.summary).toContain('could not check this against your spending caps');
  });

  it('keeps the whole web in house on a zero-retention conversation', async () => {
    // The default posture, and the one that must never depend on a caller passing the right flag:
    // a provider-side search would send the query - routinely the most revealing sentence in a
    // conversation - to a third party with the zero-retention badge still showing.
    const { log } = await runOnce(makeTask(), config({ TASK_MAX_STEPS: 1 }), [model]);
    const request = log.modelRequests[0];
    expect(toolNames(request)).toEqual(
      expect.arrayContaining(['web_search', 'parallel_web_read'])
    );
    expect(toolNames(request)).not.toContain('openrouter:web_search');
  });

  it('sends the provider’s tools and withdraws the in-house pair they stand in for', async () => {
    const { log, probe } = await runOnce(standardTask(), serverConfig, [openrouterModel]);
    const names = toolNames(log.modelRequests[0]);
    expect(names).toContain('openrouter:web_search');
    expect(names).toContain('openrouter:web_fetch');
    // The withdrawal is the half that cannot be forgotten: leaving these in hands the model two
    // descriptions of one capability, which the gateway refuses outright rather than sends.
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('parallel_web_read');
    // The browser is deliberately not withdrawn - it is the half of the web a provider fetch
    // cannot reach, everything behind a session, a login, a paywall or a form.
    expect(names).toContain('browser_action');
    expect(names).toContain('browser_snapshot');
    // And the owner is told, in one sentence, where their queries now go.
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

  it('spends its last call on a handoff, with nothing but set_plan and finish to spend it on', async () => {
    const { log } = await runToTheCeiling(handoffFinish);

    // Three provider calls for a two-step budget: the budget bounds the work, and the harness
    // closing the turn is not one of the steps it bounds.
    expect(log.modelRequests).toHaveLength(3);
    const handoff = log.modelRequests[2] ?? {};
    expect(
      ((handoff.tools ?? []) as Array<{ function?: { name?: string } }>).map(
        (tool) => tool.function?.name
      )
    ).toEqual(['set_plan', 'finish']);
    const systemText = ((handoff.messages ?? []) as Array<{ role: string; content: string }>)
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('STEP BUDGET EXHAUSTED after 2 steps');
    expect(systemText).toContain('the exact words they can send back to carry on');
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
    expect(
      probe.events.some(
        (entry) => entry.kind === 'warning' && entry.summary.includes('whole step budget')
      )
    ).toBe(true);
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
    const { log } = await run({ query: 'a[0]', literal: true }, [found('t.ts:1:7:const a[0] = 1;')]);
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
  }): Promise<MediaProbe> => {
    const task = makeTask();
    const probe = probeStore(() => task);
    const guarded: Array<Record<string, unknown>> = [];
    const billed: Array<Record<string, unknown>> = [];
    Object.assign(probe.store, {
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

  const lastMessage = (log: FetchLog, request: number): string => {
    const messages = (log.modelRequests[request]?.messages ?? []) as Array<{ content: string }>;
    return messages.at(-1)?.content ?? '';
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
    // state a real finish arrives in.
    mutated: true,
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

    expect(probe.events.some((entry) => entry.summary === 'Finish refused: a check failed')).toBe(
      true
    );
    // The turn did not complete. It ends at its step limit instead, which is the honest ending -
    // and what the model is told back is the harness's own observation rather than a verdict: an
    // exit code and the first lines of stderr are what turn "it does not work" into a next step.
    const ending = probe.events.find((entry) => entry.kind === 'completed');
    expect((ending?.payload as { interrupted?: boolean } | undefined)?.interrupted).toBe(true);
    const answer = lastMessage(log, 1);
    expect(answer).toContain('Finish refused (acceptance 1 of 4)');
    expect(answer).toContain('AssertionError: expected 3 rows');
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

  it('says in the completion when the checks were written after the work', async () => {
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
    // work or may always have been true. The checks still run - and the owner is told which kind of
    // green tick this is.
    expect(probe.events.some((entry) => entry.summary.startsWith('Acceptance baseline:'))).toBe(
      false
    );
    const completed = probe.events.find((entry) => entry.kind === 'completed');
    const payload = completed?.payload as {
      acceptance?: string[];
      verification?: { remainingRisks: string[] };
    };
    expect(payload.verification?.remainingRisks.join(' ')).toContain(
      'declared after this turn had already changed things'
    );
    expect(payload.acceptance?.[0]).toContain('never saw them fail');
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
    expect(payload.verification?.remainingRisks.join(' ')).toContain('declared by an earlier turn');
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
  const usageFrame = (promptTokens: number): string =>
    [
      `data: ${JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            delta: {
              // Real bulk, so there is something to condense - but only about 3k tokens of it by
              // the characters-divided-by-four estimate, well under the trigger. What the provider
              // reports is the number under test.
              content: 'x'.repeat(40_000),
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
        promptCiphertext: encryptJson({ prompt: 'Then deploy it' }, dataKey, `task-message:${taskId}`),
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
    installFetch([toolFrame('call-1', 'files_list', { path: 'workspace' }), textFrame('Done.')], log);
    await new AgentWorker(probe.store, config({ TASK_MAX_STEPS: 2 }), masterKey, runnerSecret)
      .run(task)
      .catch(() => undefined);
    expect(consumed).toHaveLength(0);
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
