/**
 * The activity stream, over a real socket: how fast it delivers and what it does when full.
 *
 * Everything else in this suite runs against `app.inject`, which cannot exercise a hijacked
 * response. These tests bind a real listener and read the real server-sent event stream with a real
 * client, because the two things being measured - when the first character of a reply reaches the
 * screen, and what a send blocks on - only exist end to end.
 *
 * The provider is scripted with a deliberate 300 ms first byte so the number below is athanor's
 * own overhead and not the model's.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { seedModels } from '@athanor/model-gateway';
import type { ApiConfig } from './config.js';
import { buildServer } from './server.js';

const MODEL_ID = 'openrouter/deepseek/deepseek-v4-flash';

/** Captured before any test stubs the global: the stub cannot reach the listener under test. */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

interface LatencyHarness {
  origin: string;
  cookie: string;
  workspaceId: string;
  runnerCalls: () => string[];
  send: (prompt: string) => Promise<string>;
  get: (path: string) => Promise<{ statusCode: number }>;
  /**
   * Hold the agent-disk walk open until `releaseWalk`, so "this response did not wait for it" is an
   * ordering fact rather than a stopwatch reading. Anything that waits on the walk cannot answer at
   * all while it is held.
   */
  holdWalk: () => void;
  releaseWalk: () => void;
}

const start = async (
  answer: string,
  options: {
    firstByteMs?: number;
    workerPollMs?: number;
    usageDelayMs?: number;
    frameGapMs?: number;
  } = {}
): Promise<LatencyHarness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-latency-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const runnerCalls: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let heldWalk: Promise<void> | null = null;
  let openWalkGate = (): void => undefined;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' }
        });
      if (url.includes('workspace-manager.test')) {
        const path = new URL(url).pathname;
        runnerCalls.push(path);
        if (path.endsWith('/usage')) {
          // The real runner walks the whole tree here. This is that walk, on a modest project -
          // or, while a test holds it, a walk that has not finished at all yet.
          if (heldWalk) await heldWalk;
          else await sleep(options.usageDelayMs ?? 700);
          return json({
            storageBytes: 2_048,
            hostStorageTotalBytes: 1_000_000_000,
            hostStorageAvailableBytes: 900_000_000
          });
        }
        if (path.endsWith('/exec'))
          return json({
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: 1,
            timedOut: false
          });
        return json({ ok: true });
      }
      if (url.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((m) => ({ model_id: m.providerModelId, status: 0 }))
        });
      if (url.endsWith('/models'))
        return json({
          data: seedModels().map((m) => ({
            id: m.providerModelId,
            context_length: m.contextTokens,
            architecture: { input_modalities: m.modalities },
            supported_parameters: ['tools', 'reasoning']
          }))
        });
      if (url.includes('/benchmarks')) return json({ data: [] });
      if (url.endsWith('/chat/completions')) {
        const frames: string[] = [];
        for (let index = 0; index < answer.length; index += 24)
          frames.push(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: answer.slice(index, index + 24) } }]
            })}\n\n`
          );
        frames.push(
          `data: ${JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-finish',
                      function: {
                        name: 'finish',
                        arguments: JSON.stringify({
                          summary: 'Answered.',
                          verification: {
                            status: 'not_applicable',
                            evidence: [],
                            remainingRisks: []
                          }
                        })
                      }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0001 }
          })}\n\n`
        );
        frames.push('data: [DONE]\n\n');
        // A real model does not hand over a finished answer: it arrives token by token, which is
        // the only shape in which "when did the first character appear" is a question at all.
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await sleep(options.firstByteMs ?? 300);
            for (const frame of frames) {
              controller.enqueue(encoder.encode(frame));
              await sleep(options.frameGapMs ?? 150);
            }
            controller.close();
          }
        });
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      return json({ error: { message: `unhandled ${url}` } }, 404);
    })
  );

  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    ATHANOR_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    REGISTRATION_BOOTSTRAP_TOKEN: 'latency-pairing-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 0,
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'latency-worker',
    // The production default. Before the queue signal, this was up to a second of the wait.
    WORKER_POLL_MS: options.workerPollMs ?? 1_000,
    SCHEDULER_POLL_MS: 60_000,
    TASK_MAX_STEPS: 8,
    // Off: every expectation in this file describes a turn that stops at its step ceiling.
    TASK_MAX_SELF_CONTINUATIONS: 0,
    SECURITY_EVENT_RETENTION_DAYS: 30,
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    AI_PROVIDER: 'openrouter',
    AI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    AI_REQUIRE_ZDR: true,
    AI_FORCE_INHOUSE_WEB: false,
    ALLOW_INSECURE_PROVIDER_URLS: false,
    CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
    RESERVED_PREVIEW_PORTS: '4201,4203',
    WORKER_CONCURRENCY: 1,
    LOG_LEVEL: 'silent',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
  };

  const { app, previewApp, database } = await buildServer(config);
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('The API did not bind a port');
  const origin = `http://127.0.0.1:${address.port}`;

  // The stubbed global fetch cannot reach the listener, so the test client is the undici request
  // the stub replaced. Keeping a handle to it is the only way to speak real HTTP here.
  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'latency-workspace-1' },
    payload: { name: 'Latency' }
  });
  const workspaceId = created.json<{ id: string }>().id;
  runnerCalls.length = 0;

  let nextKey = 0;
  return {
    origin,
    cookie,
    workspaceId,
    runnerCalls: () => runnerCalls,
    holdWalk: () => {
      heldWalk = new Promise<void>((resolve) => {
        openWalkGate = () => resolve();
      });
    },
    releaseWalk: () => {
      heldWalk = null;
      openWalkGate();
    },
    get: (path) => app.inject({ method: 'GET', url: path, headers: { cookie } }),
    send: async (prompt) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { cookie, 'idempotency-key': `latency-task-${(nextKey += 1)}` },
        payload: {
          workspaceId,
          prompt,
          modelId: MODEL_ID,
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 20
        }
      });
      if (response.statusCode !== 200) throw new Error(`send failed: ${response.body}`);
      return response.json<{ id: string }>().id;
    }
  };
};

/**
 * Reads a live SSE stream over real HTTP to the end, stamping every frame with how long after the
 * send it arrived. Read to the end deliberately: stopping at the first interesting frame would tear
 * the database down under a mid-turn agent.
 */
const readStream = async (
  harness: LatencyHarness,
  taskId: string,
  sentAt: number,
  timeoutMs = 20_000
): Promise<Array<{ kind: string; atMs: number }>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: Array<{ kind: string; atMs: number }> = [];
  try {
    const response = await realFetch(`${harness.origin}/v1/tasks/${taskId}/events/stream`, {
      headers: { cookie: harness.cookie, accept: 'text/event-stream' },
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
        if (data) {
          const parsed = JSON.parse(data) as { kind?: string; status?: string };
          frames.push({
            kind: parsed.kind ?? `terminal:${parsed.status ?? ''}`,
            atMs: performance.now() - sentAt
          });
        }
        split = buffer.indexOf('\n\n');
      }
    }
    return frames;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/** Opens a stream and reports when the server, rather than the caller, ends it. */
const openStream = async (
  harness: LatencyHarness,
  taskId: string
): Promise<{ status: number; ended: Promise<void>; abort: () => void }> => {
  const controller = new AbortController();
  const response = await realFetch(`${harness.origin}/v1/tasks/${taskId}/events/stream`, {
    headers: { cookie: harness.cookie, accept: 'text/event-stream' },
    signal: controller.signal
  });
  const reader = response.body!.getReader();
  const ended = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
    }
  })();
  return { status: response.status, ended, abort: () => controller.abort() };
};

const withTimeout = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`still open after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe('how long the owner waits', () => {
  test('the first character of a reply arrives without a poll interval in front of it', async () => {
    const harness = await start(
      'I will check the agent computer, read what is there, and report back with what I find in it.'
    );
    const sentAt = performance.now();
    const taskId = await harness.send('Say something');
    const frames = await readStream(harness, taskId, sentAt);
    const firstText = frames.find(
      (frame) => frame.kind === 'assistant_delta' || frame.kind === 'assistant_message'
    );
    expect(firstText).toBeDefined();
    /**
     * Measured before this change, with the same 300 ms first byte: the first text reached the
     * client at 2087 ms, and every later frame landed on a one-second boundary, because the worker
     * polled the queue at 1 Hz and the stream re-read the table at 1 Hz. What is left is the
     * provider's own 300 ms plus the agent's flush window.
     */
    expect(firstText!.atMs).toBeLessThan(1_500);
    /**
     * The lumpiness is the other half of the complaint: before this, visible updates were either
     * simultaneous or a full second apart, never anything between. Two frames landing more than
     * 900 ms apart while text is still arriving means delivery is back on a clock.
     */
    const textFrames = frames.filter((frame) => frame.kind === 'assistant_delta');
    const gaps = textFrames.slice(1).map((frame, index) => frame.atMs - textFrames[index]!.atMs);
    expect(gaps.filter((gap) => gap > 900)).toEqual([]);
  }, 30_000);

  test('neither a send nor a first paint waits for the agent disk to be walked', async () => {
    /**
     * Measured before this was fixed, with the runner stubbed at 700 ms: bootstrap 716 ms median
     * and POST /v1/tasks 716 ms median - the walk was essentially the whole response time. On a
     * 29,000-file tree it takes 684-1279 ms.
     *
     * The property is that neither response waits for it, and that used to be checked with a
     * millisecond budget - which measures the machine as much as the server, and fails on a loaded
     * one while the property still holds. So the walk is held open across both requests instead: if
     * either one waits on it, nothing answers and this test times out. There is no threshold left
     * to be unlucky against.
     */
    const harness = await start('Answered.');
    const sentAt = performance.now();
    let taskId: string;
    harness.holdWalk();
    try {
      const bootstrap = await harness.get('/v1/bootstrap');
      expect(bootstrap.statusCode).toBe(200);
      taskId = await harness.send('Do something');
    } finally {
      harness.releaseWalk();
    }
    // Let the turn finish rather than tearing the database out from under it.
    await readStream(harness, taskId, sentAt);
  }, 30_000);
});

describe('when several devices are already watching', () => {
  test('a sixth stream takes the place of the oldest instead of being refused', async () => {
    /**
     * Five is not many for a product reachable from every device: a laptop, a phone, a tablet and
     * two tabs reach it, and a sleeping phone can hold a half-open connection well past the point
     * the owner opens the laptop. Refusing the newest connection made the device in front of them
     * the one that stopped updating, silently, because an EventSource treats a 429 as fatal.
     */
    const harness = await start('Answered.', { firstByteMs: 5_000 });
    const taskId = await harness.send('Say something');
    const opened: Array<{ status: number; ended: Promise<void>; abort: () => void }> = [];
    for (let index = 0; index < 6; index += 1) opened.push(await openStream(harness, taskId));
    try {
      expect(opened.map((stream) => stream.status)).toEqual([200, 200, 200, 200, 200, 200]);
      // The oldest is closed by the server, not by the client: nobody had to notice.
      await expect(withTimeout(opened[0]!.ended, 5_000)).resolves.toBeUndefined();
      const stillOpen = await Promise.race([
        opened[5]!.ended.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('open'), 500))
      ]);
      expect(stillOpen).toBe('open');
    } finally {
      for (const stream of opened) stream.abort();
    }
  }, 30_000);
});
