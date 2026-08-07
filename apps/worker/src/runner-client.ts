import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { AthanorError, signCapabilityToken } from '@athanor/core';

/**
 * Carries the cancellation signal for whatever tool call is currently in flight.
 *
 * A tool call can occupy the worker for an hour, so a cancel that only takes effect between calls
 * is not a stop button. Threading a signal through all thirty-odd call sites would be noise, and a
 * field on the shared client would leak between tasks running in the same process - async-local
 * storage gives every request the signal belonging to its own task and nothing else.
 */
const abortScope = new AsyncLocalStorage<AbortSignal>();

/** Binds `signal` to every runner request made while `operation` runs. */
export const withRunnerAbort = <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> =>
  abortScope.run(signal, operation);

const requestSignal = (timeoutMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const scoped = abortScope.getStore();
  return scoped ? AbortSignal.any([timeout, scoped]) : timeout;
};

/**
 * A runner that stops answering must not hold one of the worker's few task slots forever. Tool calls
 * cap their own work at 3600 s, so these ceilings only trip when the runner itself is wedged.
 */
const TOOL_REQUEST_TIMEOUT_MS = 3_900_000;
const FILE_REQUEST_TIMEOUT_MS = 300_000;
/**
 * A turn checkpoint is a walk of the workspace, not a copy of it, and it stands between the model
 * and the work it is about to do. Ten minutes is far beyond anything measured and still short
 * enough that a wedged runner delays a turn rather than holding it for an hour.
 */
const CHECKPOINT_REQUEST_TIMEOUT_MS = 600_000;

/**
 * A restart of the workspace service is a two-second window, and every request that lands in it used
 * to reach the model and the owner as the bare string `fetch failed` - which distinguishes neither
 * "the workspace briefly went away" from "this command is wrong", nor tells anyone what to do.
 * Connection refused is the one failure that is provably safe to replay: the request never left this
 * process, so nothing can have run twice.
 */
export const RUNNER_CONNECT_ATTEMPTS = 4;
const RUNNER_CONNECT_BACKOFF_MS = 400;
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** undici hides the real reason one level down: the outer error is only `TypeError: fetch failed`. */
const transportCode = (error: unknown): string | undefined => {
  for (let current = asRecord(error), depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string') return current.code;
    current = asRecord(current.cause);
  }
  return undefined;
};

const isAbort = (error: unknown): boolean => asRecord(error)?.name === 'AbortError';

const isTimeout = (error: unknown): boolean => asRecord(error)?.name === 'TimeoutError';

/**
 * A refusal the caller can act on rather than a sentence it would have to read back.
 *
 * Every runner route answers a refusal with `{error:{code,message,…}}`, and one of those codes is
 * the only failure whose answer is a person instead of a retry: `browser_bot_wall` carries the
 * vendor, the site and the tab the challenge is on, and the turn needs all three to raise the
 * takeover with the owner and to leave the conversation something to show. Flattening the body into
 * `Workspace tool failed (409): {…}` threw every one of them away and left the model a JSON blob to
 * guess at. A body that is not shaped like that keeps the old sentence, since there is nothing else
 * to say about it.
 *
 * The file routes below used to answer with the bare status instead - `File write failed (400)`,
 * for a runner that had already said which paths it accepts. A model cannot act on a number, so it
 * guessed at paths and spent the owner's money doing it. Every route reports the reason it was
 * given.
 */
const runnerFailure = async (response: Response): Promise<Error> => {
  const body = (await response.text().catch(() => '')).slice(0, 4_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const failure = asRecord(asRecord(parsed)?.error);
  const code = typeof failure?.code === 'string' ? failure.code : '';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  if (!code || !message)
    return new Error(`Workspace tool failed (${response.status}): ${body.slice(0, 500)}`);
  const wall = asRecord(failure?.botWall);
  return new AthanorError(code, message, response.status, wall ? { botWall: wall } : undefined);
};

const pause = (milliseconds: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
  });

const unreachable = (error: unknown, timeoutMs: number): AthanorError => {
  if (isTimeout(error))
    return new AthanorError(
      'workspace_runner_timeout',
      `The workspace service on this computer accepted this call but produced no answer within ${Math.round(timeoutMs / 60_000)} minutes, so it was abandoned. It may still be running: check the current state before repeating it.`,
      504
    );
  const code = transportCode(error);
  if (code && NEVER_SENT.has(code))
    return new AthanorError(
      'workspace_runner_unreachable',
      `The workspace service on this computer is not accepting connections (${code}), so nothing from this call ran. It normally returns within a few seconds - try again. If it keeps failing, the athanor-runner service on the server needs attention and no tool can run until it is back.`,
      503
    );
  return new AthanorError(
    'workspace_runner_interrupted',
    `The connection to the workspace service on this computer broke while this call was in flight (${code ?? 'connection lost'}), so it may have partly run. Establish the current state before repeating it. If this keeps happening, the athanor-runner service on the server needs attention.`,
    503
  );
};

/**
 * One request, with the connection-refused window ridden out rather than reported. Anything that
 * fails after the request was sent is classified, never retried: the runner may already have run it.
 */
const runnerFetch = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (isAbort(error)) throw error;
      const code = transportCode(error);
      if (
        attempt >= RUNNER_CONNECT_ATTEMPTS ||
        isTimeout(error) ||
        !code ||
        !NEVER_SENT.has(code) ||
        init.signal?.aborted
      )
        throw unreachable(error, timeoutMs);
      await pause(RUNNER_CONNECT_BACKOFF_MS * attempt, init.signal);
      if (init.signal?.aborted) throw unreachable(error, timeoutMs);
    }
  }
};

export class AgentRunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string
  ) {}

  async call<T>(
    workspaceId: string,
    taskId: string,
    scope: string | string[],
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = signCapabilityToken(
      {
        sub: taskId,
        workspaceId,
        role: 'agent',
        scopes: Array.isArray(scope) ? scope : [scope],
        nonce: randomUUID()
      },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        signal: requestSignal(TOOL_REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      TOOL_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    const type = response.headers.get('content-type') ?? '';
    return (type.includes('application/json') ? await response.json() : await response.text()) as T;
  }

  /**
   * Takes the turn's checkpoint and prunes what retention no longer keeps.
   *
   * Pruning rides along with creating rather than running on a timer: the only moment a workspace
   * is certainly worth tidying is just after it gained a checkpoint, and a timer would be a second
   * thing to get wrong.
   */
  async checkpoint(
    workspaceId: string,
    taskId: string,
    input: { checkpointId: string; turn: number }
  ): Promise<{
    id: string;
    mechanism: 'btrfs' | 'zfs' | 'content';
    fileCount: number | null;
    totalBytes: number | null;
    storedBytes: number;
    durationMs: number;
    pruned: string[];
  }> {
    const token = signCapabilityToken(
      {
        sub: taskId,
        workspaceId,
        role: 'agent',
        scopes: ['workspace.manage'],
        nonce: randomUUID()
      },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/checkpoints`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: requestSignal(CHECKPOINT_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ ...input, taskId })
      },
      CHECKPOINT_REQUEST_TIMEOUT_MS
    );
    if (!response.ok)
      throw new Error(
        `Checkpoint failed (${response.status}): ${(await response.text()).slice(0, 500)}`
      );
    return (await response.json()) as Awaited<ReturnType<AgentRunnerClient['checkpoint']>>;
  }

  async readFile(workspaceId: string, taskId: string, requestedPath: string): Promise<string> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.read'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS)
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    return response.text();
  }

  /** The same read, with the runner's hash of what was read, for a later whole-file write. */
  async readFileWithHash(
    workspaceId: string,
    taskId: string,
    requestedPath: string
  ): Promise<{ content: string; sha256: string | null }> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.read'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS)
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    return { content: await response.text(), sha256: response.headers.get('x-content-sha256') };
  }

  /**
   * The lines a read asked for, and what was left out of them.
   *
   * `readFile` fetches the whole file, which is what a patch or an upload needs and what a look at
   * one function does not: the bytes crossed the wire and were held on both sides before all but a
   * screenful was thrown away. Naming the window makes the runner send that much and no more, so
   * reading from a log costs what the window costs rather than what the log weighs.
   */
  async readFileLines(
    workspaceId: string,
    taskId: string,
    requestedPath: string,
    window: { startLine: number; endLine: number; maxBytes: number }
  ): Promise<{
    content: string;
    startLine: number;
    endLine: number;
    totalLines?: number;
    nextStartLine?: number;
    truncated: boolean;
    fileBytes: number;
  }> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.read'], nonce: randomUUID() },
      this.secret,
      90
    );
    const query = new URLSearchParams({
      path: requestedPath,
      startLine: String(window.startLine),
      endLine: String(window.endLine),
      maxBytes: String(window.maxBytes)
    });
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS)
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    const count = (header: string): number | undefined => {
      const raw = response.headers.get(header);
      return raw === null || !Number.isFinite(Number(raw)) ? undefined : Number(raw);
    };
    // Spread rather than assigned: both are absent when the read stopped before the end of the
    // file, and under exactOptionalPropertyTypes an explicit undefined is not the same as absent.
    const totalLines = count('x-total-lines');
    const nextStartLine = count('x-next-start-line');
    return {
      content: await response.text(),
      startLine: count('x-start-line') ?? window.startLine,
      endLine: count('x-end-line') ?? window.startLine,
      ...(totalLines === undefined ? {} : { totalLines }),
      ...(nextStartLine === undefined ? {} : { nextStartLine }),
      truncated: response.headers.get('x-truncated') === 'true',
      fileBytes: count('x-file-bytes') ?? 0
    };
  }

  async readImage(
    workspaceId: string,
    taskId: string,
    requestedPath: string
  ): Promise<{ mimeType: string; base64: string }> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.read'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS)
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    const mimeType =
      response.headers.get('content-type')?.split(';', 1)[0] ?? 'application/octet-stream';
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
      throw new Error('image_read accepts PNG, JPEG, WebP, or GIF files only');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Image exceeds the 20 MB vision limit');
    return { mimeType, base64: bytes.toString('base64') };
  }

  async readBytes(
    workspaceId: string,
    taskId: string,
    requestedPath: string
  ): Promise<{ mimeType: string; bytes: Buffer }> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.read'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS)
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    return {
      mimeType:
        response.headers.get('content-type')?.split(';', 1)[0] ?? 'application/octet-stream',
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  async writeBytes(
    workspaceId: string,
    taskId: string,
    requestedPath: string,
    content: Uint8Array
  ): Promise<unknown> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.write'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS),
        body: Uint8Array.from(content).buffer
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    return response.json();
  }

  async writeFile(
    workspaceId: string,
    taskId: string,
    requestedPath: string,
    content: string,
    expectSha256?: string
  ): Promise<unknown> {
    const token = signCapabilityToken(
      { sub: taskId, workspaceId, role: 'agent', scopes: ['files.write'], nonce: randomUUID() },
      this.secret,
      90
    );
    const response = await runnerFetch(
      `${this.baseUrl}/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(requestedPath)}${
        expectSha256 ? `&expectSha256=${encodeURIComponent(expectSha256)}` : ''
      }`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        signal: requestSignal(FILE_REQUEST_TIMEOUT_MS),
        body: content
      },
      FILE_REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw await runnerFailure(response);
    return response.json();
  }
}
