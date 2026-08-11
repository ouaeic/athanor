import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import {
  BrowserAction,
  BranchTaskRequest,
  TaskTrajectoryRequest,
  DesktopAction,
  DesktopHolder,
  DesktopLaunchRequest,
  CreateApiTokenRequest,
  CreateConnectorRequest,
  StartMcpOAuthRequest,
  CreateTaskScheduleRequest,
  CreateTaskRequest,
  ContinueTaskRequest,
  CreateWorkspacePreviewRequest,
  CreateWorkspaceRequest,
  ModelRelease,
  resolveWebToolPlan,
  PublishWorkspacePreviewRequest,
  TaskEventWindowQuery,
  TaskPageQuery,
  UpdateTaskPlanRequest,
  UpdateTaskRequest,
  UpdateSecurityModeRequest,
  UpdateSpendLimitsRequest,
  type AgentNotification,
  type Connector,
  type ConnectorTestResult,
  type StartMcpOAuthResponse,
  OwnerPreferences,
  SaveDraftRequest,
  type ApiTokenScope,
  type ApiToken,
  type TaskSchedule,
  type TaskEvent,
  type TaskPage,
  type TaskStatus,
  type TaskPlan,
  type TaskPlanStep,
  type CheckpointRestorePreview,
  type RewindScope,
  type TaskRewindPreview,
  type Workspace,
  type WorkspaceCheckpoint,
  type WorkspacePreview
} from '@athanor/contracts';
import {
  assertConnectorUrl,
  assertMemoryValidity,
  assertPublishablePort,
  assertSpendAllowed,
  beginMcpOAuth,
  completeMcpOAuth,
  connectorCatalog,
  deriveServiceSecret,
  parseImapEndpoint,
  type ConnectorSecret,
  type ConnectorTransport,
  type MailSocketFactory,
  resolveDataMasterKey,
  decryptJson,
  encryptJson,
  generateDataKey,
  hashRecoveryCode,
  assertTimeZone,
  memoryTemporalStatus,
  AthanorError,
  inferenceCredentialAad,
  inferModelTask,
  rankModels,
  readRoutingMetadata,
  MAX_CAPABILITY_TTL_SECONDS,
  redactText,
  reservedPreviewPorts,
  sha256,
  spendWindowBounds,
  storageThreshold,
  unwrapDataKey,
  type MemoryDocument,
  verifyConnector,
  wrapDataKey
} from '@athanor/core';
import {
  assertMasterKeyOpensDatabase,
  createDatabase,
  DataStore,
  migrateDatabase,
  type ConnectorRecord,
  type ApiTokenRecord,
  type UserRecord,
  type TaskScheduleRecord,
  type WorkspaceCheckpointRecord,
  type WorkspacePreviewRecord,
  type WorkspaceRecord
} from '@athanor/data';
import {
  applyOpenRouterPrivacyPolicy,
  OpenAICompatibleAdapter,
  refreshOpenRouterCatalog,
  seedModels,
  verifyOpenRouterKey
} from '@athanor/model-gateway';
import { AgentWorker, connectorHostAllowance, startTurnState } from '@athanor/worker';
import { registerAuthRoutes } from './auth-routes.js';
import type { ApiConfig } from './config.js';
import { createLogger, errorFields, type Logger } from './log.js';
import { currentPeriod, serverLimits } from './plans.js';
import { buildPreviewGateway } from './preview-gateway.js';
import { RelaySupervisor, withRelayEndpoint } from './relay.js';
import { RunnerClient } from './runner-client.js';
import { advanceScheduleRun } from './schedule-advance.js';
import { startTaskTitler, TITLE_SYSTEM_PROMPT, type TitleCompletion } from './task-titles.js';
import { recordSecurityEvent } from './security-events.js';
import { sessionCookieName, sessionUser, STEP_UP_WINDOW_SECONDS } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRecord | null;
    apiToken: ApiTokenRecord | null;
    rawBody?: Buffer;
  }
}

/**
 * A task waits for the user in two different ways and only one of them looks like a pause. A
 * provider quota, a disconnected provider or an unreachable model park the task in
 * `awaiting_resource`, which resumes exactly like `paused` does - so the server states the rule
 * once, here, rather than leaving each client to infer it from the status name.
 */
const resumableTaskStatuses = ['paused', 'awaiting_resource'] as const;

/**
 * What the standing notice log says in place of a sentence it cannot decrypt.
 *
 * Only reachable when a workspace key will not unwrap - a master key that has been replaced, or a
 * key row lost with its workspace - so it is worded as the fact it is rather than as an apology.
 */
export const UNREADABLE_AGENT_MESSAGE =
  'This notice cannot be read: the workspace key that sealed it no longer opens on this server.';

const taskResponse = (
  task: Awaited<ReturnType<DataStore['getTask']>> extends infer T ? NonNullable<T> : never,
  title: string
) => ({
  id: task.id,
  workspaceId: task.workspaceId,
  parentTaskId: task.parentTaskId,
  branchedFromEventId: task.branchedFromEventId,
  forkKind: task.forkKind,
  title,
  // The store keeps these as text so a migration can add a value without a type change; the API is
  // the boundary where they become the contract's unions, and every value written comes from one.
  status: task.status as TaskStatus,
  resumable: (resumableTaskStatuses as readonly string[]).includes(task.status),
  modelId: task.modelId,
  privacyRoute: task.privacyRoute as TaskPage['tasks'][number]['privacyRoute'],
  securityMode: task.securityMode,
  maxComputeCredits: task.maxComputeCredits,
  actualComputeCredits: task.actualComputeCredits,
  maxSpendUsd: task.maxSpendUsd,
  spentUsd: task.spentUsd,
  queuedMessageCount: task.queuedMessageCount,
  rewind: task.rewindScope ?? null,
  restoredCheckpointId: task.restoredCheckpointId ?? null,
  pinned: task.pinned,
  archivedAt: task.archivedAt,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt
});

type HostStorage = {
  hostStorageTotalBytes: number;
  hostStorageAvailableBytes: number;
};

const checkpointResponse = (checkpoint: WorkspaceCheckpointRecord): WorkspaceCheckpoint => ({
  id: checkpoint.id,
  workspaceId: checkpoint.workspaceId,
  taskId: checkpoint.taskId,
  turn: checkpoint.turn,
  eventSequence: checkpoint.eventSequence,
  mechanism: checkpoint.mechanism,
  fileCount: checkpoint.fileCount,
  totalBytes: checkpoint.totalBytes,
  storedBytes: checkpoint.storedBytes,
  durationMs: checkpoint.durationMs,
  createdAt: checkpoint.createdAt
});

const workspaceResponse = (
  workspace: WorkspaceRecord,
  hostStorage?: HostStorage | null
): Workspace => ({
  id: workspace.id,
  name: workspace.name,
  status: workspace.status as Workspace['status'],
  storageBytes: workspace.storageBytes,
  storageLimitBytes: workspace.storageLimitBytes,
  ...(hostStorage ?? {}),
  imageRevision: workspace.imageRevision,
  region: workspace.region,
  keyProtection: workspace.keyProtection,
  securityMode: workspace.securityMode,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt
});

const scheduleErrorMessage = (code: string): string =>
  ({
    workspace_unavailable: 'The agent computer is unavailable.',
    workspace_missing: 'The agent computer data no longer exists.',
    model_unavailable: 'The selected model is not currently available.',
    spend_cap_reached: 'The run would have gone past your spending cap.'
  })[code] ?? 'The scheduled run could not start safely.';

const publicPaths = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/v1/legal',
  '/v1/auth/register/options',
  '/v1/auth/register/verify',
  '/v1/auth/login/options',
  '/v1/auth/login/verify',
  '/v1/auth/recover/options',
  '/v1/auth/recover/verify',
  /*
   * Adding a device is unauthenticated by construction, and these two were not on this list.
   *
   * A device redeeming an enrollment grant has no session - that is the entire thing it is asking
   * for - so the gate refused the pair before either route could look at the token, and the only
   * way onto a claimed box was the recovery code, which replaces every passkey the owner has. What
   * authorises the request is the grant itself: single use, ten minutes, minted by a device that is
   * already signed in and stepped up, and worth nothing without a WebAuthn ceremony completed on
   * top of it.
   */
  '/v1/auth/enroll/options',
  '/v1/auth/enroll/verify',
  '/v1/auth/dev',
  '/v1/connectors/mcp/oauth/callback',
  '/v1/connectors/mcp/oauth/client-metadata'
]);

/**
 * Passkey ceremonies are unauthenticated or reauthentication surfaces, so they are throttled per
 * caller address the way account recovery already is.
 */
const authRateLimitedPaths = new Set([
  '/v1/auth/login/options',
  '/v1/auth/login/verify',
  '/v1/auth/step-up/options',
  '/v1/auth/step-up/verify',
  // Both recovery routes derive a 32 MB scrypt hash, so the throttle protects the machine as well
  // as the code.
  '/v1/auth/recover/options',
  '/v1/auth/recover/verify',
  // The enrollment grant is 256 bits and cannot be guessed, but it is a secret presented by an
  // unauthenticated caller, which is the profile this throttle exists for.
  '/v1/auth/enroll/options',
  '/v1/auth/enroll/verify'
]);
const authRateLimitWindowMs = 15 * 60_000;
const authRateLimitAttempts = 20;

/**
 * Every open event stream holds a connection and a safety-net timer, so one account keeps at most
 * this many. Reaching the limit closes the longest-standing one rather than refusing the new one:
 * the newest connection is the device the owner is actually looking at.
 */
const maxEventStreamsPerUser = 5;

/**
 * How long a shutdown gives the embedded worker's current turn to land before closing the database
 * anyway. Long enough for the writes that close out a turn, short enough that a restart is a
 * restart rather than a wait for whatever the agent happens to be doing.
 */
const embeddedWorkerShutdownGraceMs = 5_000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The error a malformed path identifier is reported as. Every `*Id` path parameter in the API names
 * a UUID primary key, so an id that is not one names nothing - the same answer as an id that named
 * a record which is gone. The two codes the clients already branch on keep their own names so that
 * handling does not have to change.
 */
const missingRecordCode: Record<string, string> = {
  taskId: 'task_not_found',
  workspaceId: 'workspace_not_found'
};
const missingRecordLabel: Record<string, string> = {
  taskId: 'Task',
  workspaceId: 'Workspace'
};

const requireUser = (user: UserRecord | null): UserRecord => {
  if (!user) throw new AthanorError('authentication_required', 'Sign in to continue');
  return user;
};

/**
 * The three `*-token` routes hand back a runner capability - a terminal one is an interactive shell
 * on the box, reachable from anywhere the published runner is. That is a session-cookie flow for a
 * person driving the machine, not something an automation token should be able to reach: no scope
 * in the list says "may open a shell", and `workspaces:write` reads as "may create and modify
 * workspaces". Returning undefined refuses them to bearer tokens outright.
 */
const streamCredentialRoutes = new Set([
  '/v1/workspaces/:workspaceId/terminal-token',
  '/v1/workspaces/:workspaceId/browser-token',
  '/v1/workspaces/:workspaceId/desktop-token'
]);

const requiredApiTokenScope = (method: string, route: string): ApiTokenScope | undefined => {
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (streamCredentialRoutes.has(route)) return undefined;
  if (route.startsWith('/v1/models')) return 'models:read';
  if (route.startsWith('/v1/tasks') || route.startsWith('/v1/schedules'))
    return writing ? 'tasks:write' : 'tasks:read';
  if (route.startsWith('/v1/approvals')) return writing ? 'approvals:write' : 'approvals:read';
  if (route.startsWith('/v1/usage')) return 'usage:read';
  // Reading what has been spent is usage. Changing the ceiling is the owner deciding how much of
  // their own money the agent may spend, which is not something an automation token gets to do.
  if (route === '/v1/spend' || (route === '/v1/spend-limits' && !writing)) return 'usage:read';
  // No scope reaches the notification surface: an automation token that could switch off approval
  // prompts could act unwatched, which is the one thing the prompts exist to prevent.
  if (route.startsWith('/v1/notifications')) return undefined;
  if (route.startsWith('/v1/connectors')) return writing ? undefined : 'connectors:read';
  if (route.startsWith('/v1/previews')) return 'workspaces:write';
  if (route.startsWith('/v1/workspaces')) {
    if (route.includes('/file')) return writing ? 'files:write' : 'files:read';
    if (route.includes('/browser') || route.includes('/desktop') || route.includes('/terminal'))
      return 'workspaces:write';
    return writing ? 'workspaces:write' : 'workspaces:read';
  }
  return undefined;
};

const textValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;

const revealedTaskEvent = (
  summary: string,
  encryptedPayload: unknown
): { summary: string; payload?: unknown } => {
  if (
    encryptedPayload &&
    typeof encryptedPayload === 'object' &&
    (encryptedPayload as { __athanorEventVersion?: unknown }).__athanorEventVersion === 1
  ) {
    const content = encryptedPayload as { summary?: unknown; payload?: unknown };
    return {
      summary: textValue(content.summary, summary),
      ...(content.payload === undefined ? {} : { payload: content.payload })
    };
  }
  return encryptedPayload === undefined ? { summary } : { summary, payload: encryptedPayload };
};

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256)
  })
});

const validatePushEndpoint = (endpoint: string, suffixes: string[]): string => {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new AthanorError(
      'invalid_push_endpoint',
      'Push endpoints must use credential-free HTTPS'
    );
  }
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => {
    const value = suffix.trim().toLowerCase();
    return value.startsWith('.') ? host.endsWith(value) : host === value;
  });
  if (!allowed)
    throw new AthanorError('invalid_push_endpoint', 'This browser push relay is not allowed');
  return url.toString();
};

const KnowledgeText = z
  .string()
  .trim()
  .min(1)
  .max(24_000)
  .transform((value) => value.normalize('NFKC'))
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return (
          code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
        );
      }) && !/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(value),
    'Hidden control and bidirectional text are not allowed'
  )
  .refine(
    (value) =>
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S{12,}/i.test(
        value
      ),
    'Keep credentials out of memory and skills'
  );

const SkillDocumentInput = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: KnowledgeText.pipe(z.string().max(240)),
    content: KnowledgeText
  })
  .superRefine((value, context) => {
    for (const heading of ['When to use', 'Procedure', 'Pitfalls', 'Verification']) {
      if (!new RegExp(`^#{1,3}\\s+${heading}\\s*$`, 'im').test(value.content))
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: `Skill is missing ${heading}`
        });
    }
  });

/**
 * Binary uploads reach here as a Buffer of up to the 50 MB body limit; serialising one through
 * `JSON.stringify` would expand it into a multi-hundred-megabyte string on every request, so raw
 * bytes are digested directly and tagged so they cannot collide with a JSON body.
 */
interface ConnectionManifest {
  endpoints: string[];
  identity: string;
  discovery?: { mdnsService?: string; mdnsPort?: number };
}

/**
 * The connection ticket every client knows how to read, and the discovery details it insists on.
 *
 * A client refuses a ticket whose version it does not recognise and one carrying a field it has
 * never heard of, which is what makes this a number rather than a preference: an installer and a
 * server that print different tickets produce a device that cannot be added. The installer writes
 * the same three values - `scripts/athanor` where it prints the first-device ticket, and
 * `scripts/athanor-network-refresh` where it writes the manifest this reads.
 */
/**
 * The provider connection one account's model calls go through, as it is sealed in the database.
 * `modelId` is only meaningful for an endpoint that serves a single model.
 */
interface InferenceSecret {
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
  enforceZeroDataRetention: boolean;
}

const CONNECTION_TICKET_VERSION = 2;
const MDNS_SERVICE = '_athanor._tcp.local';
const MDNS_PORT = 443;

/**
 * Reads the manifest the network watcher maintains on disk. It is regenerated whenever the host's
 * addresses change, so it is read per request rather than cached: a stale endpoint set would send
 * a newly enrolled device to an address the server no longer answers on.
 */
const readConnectionManifest = async (path: string): Promise<ConnectionManifest> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const endpoints = Array.isArray(record.endpoints)
      ? record.endpoints.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (!endpoints.length || typeof record.identity !== 'string')
      throw new Error('incomplete manifest');
    return {
      endpoints,
      identity: record.identity,
      ...(record.discovery && typeof record.discovery === 'object'
        ? { discovery: record.discovery as NonNullable<ConnectionManifest['discovery']> }
        : {})
    };
  } catch {
    throw new AthanorError(
      'connection_manifest_unavailable',
      'The server connection details are not available yet; run sudo athanor connect on the server',
      503
    );
  }
};

/**
 * True for a bare IPv4 or IPv6 address. Used to detect a WebAuthn RP ID that can never work,
 * rather than discovering it when the first sign-in silently fails.
 */
export const isAddressLiteral = (host: string): boolean => {
  const value = host.trim().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return value.includes(':');
};

export const idempotencyRequestHash = (method: string, url: string, body: unknown): string => {
  // `bytes:` tags the binary form so a Buffer can never collide with a JSON body that happens to
  // serialise to the same digest string.
  const fingerprint = ArrayBuffer.isView(body)
    ? `bytes:${sha256(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))}`
    : JSON.stringify(body ?? null);
  return sha256(`${method}\n${url}\n${fingerprint}`);
};

export interface ApiServices {
  app: FastifyInstance;
  previewApp: FastifyInstance;
  store: DataStore;
  database: ReturnType<typeof createDatabase>;
  /** The box's relay: its settings, and the single connection they turn on or off. */
  relay: RelaySupervisor;
  /**
   * The same sweep the five-minute timer runs - releasing lapsed approvals, finishing interrupted
   * scheduled dispatches, metering. Exposed so it can be driven on demand rather than waited for.
   */
  runMaintenance: () => Promise<void>;
}

export interface ApiOverrides {
  connectorTransport?: ConnectorTransport;
  /**
   * The mail connectors speak TLS sockets rather than HTTPS requests, so verifying one cannot go
   * through `connectorTransport`. This is the same seam for that half.
   */
  mailSocketFactory?: MailSocketFactory;
  masterKey?: Uint8Array;
  modelCatalogFetch?: typeof fetch;
  logger?: Logger;
  /** Replaces the relay supervisor, so a test can drive the settings without dialling out. */
  relay?: RelaySupervisor;
}

export const buildServer = async (
  config: ApiConfig,
  overrides: ApiOverrides = {}
): Promise<ApiServices> => {
  /**
   * Fastify's own logger is left off because its request lines carry raw URLs and headers. Every
   * line this server writes goes through the allowlisting logger instead, which cannot print
   * content even by accident.
   */
  const log = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, service: 'api' });
  /**
   * nginx terminates TLS and forwards `X-Forwarded-For`; without trusting it every per-address rate
   * limit keys on 127.0.0.1, which collapses every caller into one bucket - simultaneously useless
   * against an attacker and a denial of service against everyone else. Only a loopback hop is
   * trusted, so the header counts for something exactly when it came from this machine's own
   * reverse proxy and for nothing when the API is reached directly.
   */
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024, trustProxy: 'loopback' });
  const database = createDatabase({
    driver: config.DATABASE_DRIVER,
    ...(config.DATABASE_DRIVER === 'postgres'
      ? { url: config.DATABASE_URL }
      : { pglitePath: config.PGLITE_PATH })
  });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const keyRelease = overrides.masterKey
    ? { key: Buffer.from(overrides.masterKey), mode: 'hosted' as const }
    : await resolveDataMasterKey(config);
  const masterKey = keyRelease.key;
  await assertMasterKeyOpensDatabase(database, masterKey);
  const runnerSharedSecret =
    config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(masterKey, 'runner-capabilities');
  const sessionSigningKey =
    config.SESSION_SIGNING_KEY ?? deriveServiceSecret(masterKey, 'session-signing');
  const runner = new RunnerClient(config.WORKSPACE_RUNNER_URL, runnerSharedSecret);
  const previewApp = await buildPreviewGateway(store, config, runner);
  const secure = config.PUBLIC_APP_URL.startsWith('https://');
  const pushEndpointSuffixes = config.PUSH_ENDPOINT_HOST_SUFFIXES.split(',').filter(Boolean);
  /**
   * The hosts one connector may be reached on, decided the same way here and in the worker.
   *
   * A connector verified against one list and then executed against another is a connector that
   * connects and then fails the first time it is asked to do anything, so both processes read the
   * single rule in @athanor/worker: the deployment list plus the connector's own hostname, except
   * for mail and calendar, where the deployment list stands alone because a mailbox's submission
   * host is routinely a different name from the one it is read on.
   */
  const connectorAllowedHosts = (kind: Connector['kind'], baseUrl: string): string[] =>
    connectorHostAllowance(config.CONNECTOR_ALLOWED_HOST_SUFFIXES, { kind, baseUrl });
  /**
   * Publishing a preview points the internet at a loopback port of the agent computer, and every
   * athanor service is on loopback: the API, this preview gateway, the runner, PostgreSQL and the
   * sibling health endpoints. Refusing our own ports is what keeps "publish my demo on 3000" from
   * becoming "publish the database on 5432".
   */
  const reservedPreviewPortSet = reservedPreviewPorts({
    ports: [config.API_PORT, config.PREVIEW_GATEWAY_PORT],
    urls: [config.WORKSPACE_RUNNER_URL, config.PUBLIC_RUNNER_URL, config.DATABASE_URL],
    additional: config.RESERVED_PREVIEW_PORTS
  });
  const requestStarted = new WeakMap<object, number>();
  const requestMetrics = new Map<string, { count: number; durationMs: number }>();
  const connectionManifest = (): Promise<ConnectionManifest> =>
    readConnectionManifest(config.CONNECTION_MANIFEST_PATH);
  const relay =
    overrides.relay ??
    new RelaySupervisor({
      directory: config.RELAY_STATE_DIR,
      localHost: config.RELAY_LOCAL_HOST,
      localPort: config.RELAY_LOCAL_PORT,
      localHttpPort: config.RELAY_LOCAL_HTTP_PORT,
      log
    });
  // Reading the file is what makes the relay survive a restart; a box whose owner turned it on
  // should not need to be told again after every update.
  await relay.start();
  const authAttempts = new Map<string, { count: number; resetAt: number }>();
  /**
   * Every open activity stream, oldest first, per account. Insertion order is what lets a sixth
   * device take the place of the stalest connection rather than be refused: a single owner
   * reaching for their laptop should never be the one who loses.
   */
  const openEventStreams = new Map<string, Map<number, () => void>>();
  let nextEventStreamId = 0;
  const checkAuthRate = (key: string): void => {
    const now = Date.now();
    const current = authAttempts.get(key);
    if (!current || current.resetAt <= now) {
      if (authAttempts.size >= 10_000) {
        for (const [candidate, attempt] of authAttempts) {
          if (attempt.resetAt <= now) authAttempts.delete(candidate);
        }
        if (authAttempts.size >= 10_000) {
          throw new AthanorError(
            'auth_rate_limited',
            'Sign-in is temporarily busy; try again later',
            429
          );
        }
      }
      authAttempts.set(key, { count: 1, resetAt: now + authRateLimitWindowMs });
      return;
    }
    current.count += 1;
    if (current.count > authRateLimitAttempts) {
      throw new AthanorError(
        'auth_rate_limited',
        'Too many sign-in attempts; try again later',
        429
      );
    }
  };
  /**
   * Metering walks the whole agent disk, so it is never on a path a person is waiting behind.
   *
   * The figure it produces is a display number and a maintenance input - the quota decision that
   * follows a send reads `store.usageTotals`, which is a database query - so a send, a follow-up
   * and a first paint are served from this cache and the walk happens behind the response. A
   * coding tree makes that walk hundreds of milliseconds, every time, on the single most common
   * action in the product.
   */
  const hostStorageTtlMs = 60_000;
  const hostStorageCache = new Map<
    string,
    { usage: HostStorage & { storageBytes: number }; at: number }
  >();
  const meteringInFlight = new Map<
    string,
    Promise<(HostStorage & { storageBytes: number }) | null>
  >();
  const meterWorkspace = async (
    workspace: WorkspaceRecord
  ): Promise<(HostStorage & { storageBytes: number }) | null> => {
    if (workspace.status !== 'running') return null;
    const existing = meteringInFlight.get(workspace.id);
    if (existing) return existing;
    const attempt = (async () => {
      try {
        const usage = await runner.request<HostStorage & { storageBytes: number }>({
          workspaceId: workspace.id,
          userId: workspace.userId,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`,
          // A hung runner otherwise holds the caller for undici's five-minute header timeout.
          timeoutMs: 5_000
        });
        await store.setWorkspaceStorage(workspace.userId, workspace.id, usage.storageBytes);
        hostStorageCache.set(workspace.id, { usage, at: Date.now() });
        return usage;
      } catch (error) {
        // Metering is best-effort, but a runner that has stopped answering shows up here first and
        // explains every storage figure that later looks frozen.
        log.warn('workspace.metering_failed', {
          workspaceId: workspace.id,
          ...errorFields(error)
        });
        return null;
      } finally {
        meteringInFlight.delete(workspace.id);
      }
    })();
    meteringInFlight.set(workspace.id, attempt);
    return attempt;
  };

  /**
   * The last figure read from the machine, refreshing it behind the response when it has aged out.
   * A workspace nothing has metered yet reports its stored total and no host figures until the
   * first refresh lands, which is one background walk rather than one per request.
   */
  const cachedHostStorage = (
    workspace: WorkspaceRecord
  ): (HostStorage & { storageBytes: number }) | null => {
    const cached = hostStorageCache.get(workspace.id);
    if (!cached || Date.now() - cached.at > hostStorageTtlMs) void meterWorkspace(workspace);
    return cached?.usage ?? null;
  };
  const taskTitle = async (
    task: NonNullable<Awaited<ReturnType<DataStore['getTask']>>>,
    knownWorkspace?: WorkspaceRecord
  ): Promise<string> => {
    if (!task.titleCiphertext) return task.legacyTitle ?? 'Private task';
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(task.workspaceId));
    if (!workspace?.wrappedKey) return 'Private task';
    if (task.titleCiphertext.aad !== `task-title:${workspace.id}`) {
      throw new AthanorError('encrypted_title_context', 'Task title encryption context is invalid');
    }
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return decryptJson<{ title: string }>(task.titleCiphertext, key).title;
  };

  const privateTaskResponse = async (
    task: NonNullable<Awaited<ReturnType<DataStore['getTask']>>>,
    knownWorkspace?: WorkspaceRecord
  ) => taskResponse(task, await taskTitle(task, knownWorkspace));

  const scheduleTitle = async (
    schedule: TaskScheduleRecord,
    knownWorkspace?: WorkspaceRecord
  ): Promise<string> => {
    const workspace = knownWorkspace ?? (await store.getWorkspaceById(schedule.workspaceId));
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    if (schedule.titleCiphertext.aad !== `task-title:${workspace.id}`) {
      throw new AthanorError(
        'encrypted_title_context',
        'Schedule title encryption context is invalid'
      );
    }
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return decryptJson<{ title: string }>(schedule.titleCiphertext, key).title;
  };

  const privateScheduleResponse = async (
    schedule: TaskScheduleRecord,
    knownWorkspace?: WorkspaceRecord
  ): Promise<TaskSchedule> => ({
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    title: await scheduleTitle(schedule, knownWorkspace),
    modelId: schedule.modelId,
    privacyRoute: schedule.privacyRoute as TaskSchedule['privacyRoute'],
    maxComputeCredits: schedule.maxComputeCredits,
    maxSpendUsd: schedule.maxSpendUsd ?? null,
    spec: schedule.spec,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastTaskId: schedule.lastTaskId,
    lastErrorCode: schedule.lastErrorCode,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt
  });

  const privateTaskPlanResponse = async (
    plan: NonNullable<Awaited<ReturnType<DataStore['getLatestTaskPlan']>>>,
    workspace: WorkspaceRecord
  ): Promise<TaskPlan> => {
    if (plan.stepsCiphertext.aad !== `task-plan:${plan.taskId}`)
      throw new AthanorError('encrypted_plan_context', 'Task plan encryption context is invalid');
    const key = unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id);
    const content = decryptJson<{ steps: TaskPlanStep[]; branchName?: string }>(
      plan.stepsCiphertext,
      key
    );
    return {
      id: plan.id,
      taskId: plan.taskId,
      version: plan.version,
      parentVersion: plan.parentVersion,
      branchName: content.branchName ?? plan.branchName,
      steps: content.steps,
      createdBy: plan.createdBy,
      createdAt: plan.createdAt
    };
  };

  const connectorResponse = (connector: ConnectorRecord): Connector => ({
    id: connector.id,
    kind: connector.kind,
    authMode: connector.authMode,
    label: connector.label,
    baseUrl: connector.baseUrl,
    scopes: connector.scopes,
    enabled: connector.enabled,
    lastUsedAt: connector.lastUsedAt,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt
  });
  const previewBase = new URL(config.PREVIEW_BASE_URL);
  const workspacePreviewUrl = (slug: string): string => {
    const url = new URL(previewBase);
    const basePath = previewBase.pathname.replace(/\/+$/, '');
    if (basePath) {
      url.pathname = `${basePath}/${slug}/`;
    } else {
      url.hostname = `${slug}.${previewBase.hostname}`;
      url.pathname = '/';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  };
  const workspacePreviewResponse = (
    preview: WorkspacePreviewRecord,
    accessToken?: string
  ): WorkspacePreview => {
    // Always the slug. A preview used to be able to report a custom domain as its address once a
    // TXT record verified, but nothing ever routed such a host here: there is one nginx server
    // block, it matches any name, and only the preview path regex reaches the gateway - so the
    // owner was handed a link that answered with a certificate warning and then with athanor's own
    // sign-in page. The feature is gone rather than half-present; the columns behind it are left in
    // place for now so a rollback to the previous release still reads its own rows.
    const url = new URL(workspacePreviewUrl(preview.slug));
    /*
     * The entry path rides on every address handed out, not only on the one minted at publish
     * time: the Preview tab asks for a fresh address whenever it opens one, and a link that
     * forgot where to land would be the same file index all over again.
     */
    if (preview.entryPath)
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${preview.entryPath.replace(/^\/+/, '')}`;
    if (accessToken && preview.visibility === 'private')
      url.searchParams.set('access', accessToken);
    return {
      id: preview.id,
      workspaceId: preview.workspaceId,
      label: preview.label,
      port: preview.port,
      visibility: preview.visibility,
      status:
        preview.status === 'active' &&
        preview.expiresAt !== null &&
        new Date(preview.expiresAt).getTime() <= Date.now()
          ? 'expired'
          : preview.status,
      url: url.toString(),
      expiresAt: preview.expiresAt,
      lastAccessedAt: preview.lastAccessedAt,
      createdAt: preview.createdAt,
      updatedAt: preview.updatedAt
    };
  };
  const apiTokenResponse = (token: ApiTokenRecord): ApiToken => ({
    id: token.id,
    label: token.label,
    prefix: token.prefix,
    scopes: token.scopes,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt
  });
  const workspaceKnowledgeKey = async (
    userId: string,
    workspaceId: string
  ): Promise<{ workspace: WorkspaceRecord; key: Buffer }> => {
    const workspace = await store.getWorkspace(userId, workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    return {
      workspace,
      key: unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
    };
  };

  for (const task of await store.listLegacyTaskTitles()) {
    const workspace = await store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey || !task.legacyTitle) continue;
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    await store.setTaskTitleCiphertext(
      task.id,
      encryptJson({ title: task.legacyTitle }, key, `task-title:${workspace.id}`)
    );
  }
  await store.scrubLegacyContentSummaries();

  const requireRecentStepUp = async (request: FastifyRequest, user: UserRecord): Promise<void> => {
    const token = request.cookies[sessionCookieName(secure)];
    if (
      !token ||
      !(await store.hasRecentSessionStepUp(user.id, sha256(token), STEP_UP_WINDOW_SECONDS))
    ) {
      throw new AthanorError(
        'step_up_required',
        'Confirm this sensitive action with your passkey',
        403
      );
    }
  };

  const idempotent = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRecord,
    operation: () => Promise<T>
  ): Promise<T> => {
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || !/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
      throw new AthanorError(
        'idempotency_key_required',
        'A valid Idempotency-Key header is required'
      );
    }
    const operationPath = request.routeOptions.url ?? request.url.split('?')[0]!;
    const requestHash = idempotencyRequestHash(request.method, request.url, request.body);
    const existing = await store.beginOperation({
      userId: user.id,
      idempotencyKey: key,
      method: request.method,
      path: operationPath,
      requestHash
    });
    if (existing) {
      if (
        existing.method !== request.method ||
        existing.path !== operationPath ||
        existing.requestHash !== requestHash
      ) {
        throw new AthanorError(
          'idempotency_conflict',
          'This key was already used for a different operation'
        );
      }
      if (existing.state === 'completed' && existing.responseStatus !== null) {
        reply.status(existing.responseStatus).header('idempotency-replayed', 'true');
        return existing.responseBody as T;
      }
      throw new AthanorError(
        'operation_in_progress',
        'The original request is still being reconciled'
      );
    }
    try {
      const result = await operation();
      await store.completeOperation(user.id, key, reply.statusCode, result);
      return result;
    } catch (error) {
      await store.failOperation(user.id, key);
      throw error;
    }
  };

  const modelSeeds = seedModels();
  const configuredOpenRouterKey =
    config.AI_PROVIDER === 'openrouter'
      ? (config.AI_API_KEY ?? config.OPENROUTER_API_KEY)
      : config.OPENROUTER_API_KEY;
  if (configuredOpenRouterKey) {
    try {
      const liveModels = await refreshOpenRouterCatalog(modelSeeds, {
        baseUrl:
          config.AI_PROVIDER === 'openrouter' ? config.AI_BASE_URL : config.OPENROUTER_BASE_URL,
        apiKey: configuredOpenRouterKey,
        ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
      });
      await store.upsertModels(liveModels);
    } catch (error) {
      log.warn('models.catalog_refresh_failed', errorFields(error));
    }
  }
  const refreshedModels = await store.listModels();
  const existingModelIds = new Set(refreshedModels.map((model) => String(model.id)));
  await store.upsertModels(modelSeeds.filter((model) => !existingModelIds.has(model.id)));
  if (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL) {
    await store.upsertModels([
      {
        id: `custom/${config.AI_DEFAULT_MODEL}`,
        providerModelId: config.AI_DEFAULT_MODEL,
        displayName: config.AI_DEFAULT_MODEL,
        provider: 'custom',
        revision: 'provider-managed',
        availability: 'available',
        openness: 'remote_proprietary',
        license: 'Provider-defined',
        commercialUse: true,
        privacyRoute: config.AI_REQUIRE_ZDR ? 'provider_zdr' : 'external',
        contextTokens: 128_000,
        modalities: ['text'],
        capabilities: ['chat', 'tools', 'reasoning'],
        usageClass: 'medium',
        recommendationTags: ['Configured endpoint'],
        measuredQuality: null,
        measuredLatencyMs: null,
        updatedAt: new Date().toISOString()
      }
    ]);
  }
  let embeddedWorkerRunning = false;
  let maintenanceRun: Promise<void> | null = null;
  /**
   * Shutdown used to set the loop's flag and immediately close the database, so a turn that was
   * mid-write - appending an event, settling usage, saving agent state - lost its connection under
   * it and the task was left leased and half-recorded. Closing now waits for the turn to land.
   *
   * `stopEmbeddedWorker` is the other half: without it the loop would sit out its whole poll
   * interval before noticing the flag, and every restart would pay that on an idle box.
   */
  let stopEmbeddedWorker = (): void => undefined;
  const embeddedWorkerStopped = new Promise<void>((resolve) => {
    stopEmbeddedWorker = resolve;
  });
  let embeddedWorkerLoop: Promise<void> = Promise.resolve();
  if (config.EMBEDDED_WORKER ?? config.DATABASE_DRIVER === 'pglite') {
    const embeddedWorker = new AgentWorker(store, config, masterKey, runnerSharedSecret);
    embeddedWorkerRunning = true;
    /**
     * Pickup waits on the write, not on a clock: `waitForQueuedTask` returns the moment a task is
     * queued and otherwise after the poll interval, so a send is picked up in milliseconds instead
     * of costing the owner up to a full poll before the model is even called. The interval remains
     * as the floor for anything that becomes leasable without a signal - an expired lease.
     */
    embeddedWorkerLoop = (async () => {
      while (embeddedWorkerRunning) {
        let leased: Awaited<ReturnType<typeof store.leaseNextTask>> = null;
        try {
          leased = await store.leaseNextTask(config.WORKER_ID, 120);
        } catch (error) {
          // The embedded worker shares the API's process, so an unreachable store must not end the
          // server with it.
          if (embeddedWorkerRunning) log.error('worker.poll_failed', errorFields(error));
        }
        if (!leased) {
          await Promise.race([
            store.waitForQueuedTask(config.WORKER_POLL_MS),
            embeddedWorkerStopped
          ]);
          continue;
        }
        try {
          await embeddedWorker.run(leased);
        } catch (error) {
          log.warn('worker.task_failed', { taskId: leased.id, ...errorFields(error) });
          await embeddedWorker.fail(leased, error).catch((cause: unknown) => {
            log.error('worker.fail_failed', { taskId: leased.id, ...errorFields(cause) });
          });
        }
      }
    })();
  }
  await app.register(cookie, { secret: sessionSigningKey, hook: 'onRequest' });
  await app.register(cors, { origin: config.PUBLIC_APP_URL, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);

  /**
   * The second half of dispatching a scheduled run: the workspace has to be awake before the task
   * is worth queueing, and that is an HTTP round-trip outside the transaction that created it. It
   * lives in its own function because a process death inside that window leaves the task parked in
   * `awaiting_resource`, and the recovery sweep finishes the job with exactly these steps.
   */
  const promoteScheduledTask = async (input: {
    scheduleId: string;
    taskId: string;
    userId: string;
    workspace: WorkspaceRecord;
    key: ReturnType<typeof unwrapDataKey>;
  }): Promise<'queued' | 'failed'> => {
    const { scheduleId, taskId, userId, workspace, key } = input;
    try {
      if (workspace.status !== 'running') {
        await runner.request({
          workspaceId: workspace.id,
          userId,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/resume`,
          method: 'POST',
          body: '{}',
          contentType: 'application/json'
        });
        await store.updateWorkspaceStatus(workspace.id, 'running');
      }
      await store.setTaskStatusForUser(userId, taskId, 'queued');
      await store.appendTaskEvent({
        taskId,
        kind: 'status',
        summary: 'Encrypted schedule status event',
        payloadCiphertext: encryptJson(
          {
            __athanorEventVersion: 1,
            summary: 'Scheduled run queued',
            payload: { scheduleId }
          },
          key,
          `task-event:${taskId}`
        )
      });
      log.info('schedule.run_queued', { scheduleId, taskId, workspaceId: workspace.id });
      return 'queued';
    } catch (error) {
      await store.setTaskStatusForUser(userId, taskId, 'failed');
      await store.transitionUsage(`task:${taskId}:reservation`, 'reserved', 'released');
      await store.failMaterializedTaskSchedule(scheduleId, taskId, 'workspace_unavailable');
      await store.appendTaskEvent({
        taskId,
        kind: 'error',
        summary: 'Encrypted schedule error event',
        payloadCiphertext: encryptJson(
          {
            __athanorEventVersion: 1,
            summary: scheduleErrorMessage('workspace_unavailable'),
            // `owner` is what keeps a warning or an error out on the page rather than folded into
            // the collapsed work log with the machinery the agent recovered from. A scheduled run
            // that never started has no other evidence in its transcript at all: without this the
            // whole conversation is a closed disclosure reading "2 steps".
            payload: { owner: true, code: 'workspace_unavailable', scheduleId }
          },
          key,
          `task-event:${taskId}`
        )
      });
      log.warn('schedule.run_failed', {
        scheduleId,
        taskId,
        workspaceId: workspace.id,
        ...errorFields(error)
      });
      return 'failed';
    }
  };

  /**
   * `cleanupExpired` marks a lapsed approval 'expired' and stops there, which is where the task
   * used to be abandoned: nothing re-leases `awaiting_user`, so it waited forever, held its credit
   * reservation against the monthly allowance, and lost the approval card that was the only way to
   * answer it. Releasing the reservation comes first - a crash in between then leaves the row
   * still `awaiting_user` for the next sweep, where the opposite order would strand the credits
   * for good. `paused` is the destination because it is the one waiting state every client already
   * offers a way out of.
   */
  const sweepExpiredApprovals = async (): Promise<number> => {
    const stranded = await database.query<{
      approval_id: string;
      task_id: string;
      user_id: string;
      workspace_id: string;
    }>(
      `SELECT DISTINCT ON (a.task_id)
         a.id AS approval_id, a.task_id, t.user_id, t.workspace_id
       FROM approvals a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.status = 'expired' AND t.status = 'awaiting_user'
         AND NOT EXISTS (
           SELECT 1 FROM approvals live
           WHERE live.task_id = a.task_id AND live.status = 'pending' AND live.expires_at > NOW()
         )
       ORDER BY a.task_id, a.expires_at DESC, a.id DESC
       LIMIT 100`
    );
    let swept = 0;
    for (const row of stranded.rows) {
      const taskId = String(row.task_id);
      const userId = String(row.user_id);
      const released = await database.query(
        `UPDATE usage_entries SET state='released' WHERE task_id=$1 AND state='reserved'`,
        [taskId]
      );
      if (!(await store.setTaskStatusForUser(userId, taskId, 'paused'))) continue;
      const workspace = await store.getWorkspaceById(String(row.workspace_id));
      if (workspace?.wrappedKey) {
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        await store.appendTaskEvent({
          taskId,
          kind: 'warning',
          summary: 'Encrypted approval expiry event',
          payloadCiphertext: encryptJson(
            {
              __athanorEventVersion: 1,
              summary:
                'The approval this task was waiting for expired unanswered, so the task is paused and its reserved credits are back. Resume it to ask again.',
              // Owner-facing by construction: the task is stopped and only their reply starts it.
              payload: {
                owner: true,
                code: 'approval_expired',
                approvalId: String(row.approval_id)
              }
            },
            key,
            `task-event:${taskId}`
          )
        });
      }
      swept += 1;
      log.info('approval.expired_swept', {
        taskId,
        approvalId: String(row.approval_id),
        count: released.rowCount ?? 0
      });
    }
    return swept;
  };

  /**
   * Says out loud that a task kept dying, which is the half of the attempt ceiling the queue itself
   * cannot do.
   *
   * A turn that takes the worker process down with it never reaches `AgentWorker.fail` - there is
   * no process left to write anything - so the only record of six deaths is a number in a column.
   * The ceiling stops the loop; this is what turns it into something the owner can see and act on,
   * in the timeline where every other stop is reported.
   */
  const failTasksAtAttemptLimit = async (): Promise<number> => {
    const exhausted = await store.failTasksAtAttemptLimit();
    for (const task of exhausted) {
      // `attempt` rather than `attempts` because the log field allowlist carries that name, and a
      // field nobody put on the list is dropped rather than printed.
      log.warn('task.attempt_limit_reached', { taskId: task.id, attempt: task.attempt });
      const workspace = await store.getWorkspaceById(task.workspaceId);
      if (!workspace?.wrappedKey) continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'error',
        summary: 'Encrypted attempt limit event',
        payloadCiphertext: encryptJson(
          {
            __athanorEventVersion: 1,
            // Same shape as the approval-expiry line above it, deliberately: what happened, what
            // athanor did about it, what starts it again. The advice to try "in smaller pieces"
            // was cut - nothing here knows that size was the problem.
            summary: `Started ${task.attempt} times and never finished, so athanor has stopped retrying it and its reserved credits are back. Reply here to try again.`,
            // Owner-facing: the work is not there, and nothing else in the timeline says why - the
            // worker died before it could write a word.
            payload: { owner: true, code: 'task_attempt_limit', attempts: task.attempt }
          },
          key,
          `task-event:${task.id}`
        )
      });
    }
    return exhausted.length;
  };

  /**
   * A scheduled task is created `awaiting_resource` and promoted to `queued` only after its
   * workspace answers, so a restart inside that window leaves a run nothing will ever lease,
   * holding a reservation, while its schedule has already moved on. `attempt = 0` is what
   * separates it from a task that ran and then hit a provider wall: only a leased task has ever
   * been counted. The age gate keeps this clear of a dispatch that is merely still in progress.
   */
  const recoverStrandedScheduledTasks = async (): Promise<number> => {
    const stranded = await database.query<{
      schedule_id: string;
      task_id: string;
      user_id: string;
      workspace_id: string;
    }>(
      `SELECT r.schedule_id, r.task_id, t.user_id, t.workspace_id
       FROM task_schedule_runs r
       JOIN tasks t ON t.id = r.task_id
       WHERE r.outcome = 'queued' AND t.status = 'awaiting_resource' AND t.attempt = 0
         AND t.updated_at < NOW() - INTERVAL '2 minutes'
       ORDER BY r.created_at, r.task_id
       LIMIT 20`
    );
    let recovered = 0;
    for (const row of stranded.rows) {
      const taskId = String(row.task_id);
      const scheduleId = String(row.schedule_id);
      const workspace = await store.getWorkspaceById(String(row.workspace_id));
      if (!workspace?.wrappedKey) continue;
      log.info('schedule.dispatch_recovered', { scheduleId, taskId, workspaceId: workspace.id });
      await promoteScheduledTask({
        scheduleId,
        taskId,
        userId: String(row.user_id),
        workspace,
        key: unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id)
      });
      recovered += 1;
    }
    return recovered;
  };

  /**
   * Each step is contained on its own: an unhandled rejection here used to reach Node's default
   * handler and take the whole API down, and a database blip during cleanup should not cost the
   * metering pass or the two sweeps that release held credits. Nothing in here throws, which is
   * what lets the sweeps chain safely.
   */
  const sweepOnce = async (): Promise<void> => {
    const started = performance.now();
    const step = async (event: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        log.error(event, errorFields(error));
      }
    };
    await step('maintenance.cleanup_failed', () =>
      store.cleanupExpired(config.SECURITY_EVENT_RETENTION_DAYS)
    );
    await step('maintenance.approval_sweep_failed', sweepExpiredApprovals);
    await step('maintenance.attempt_limit_sweep_failed', failTasksAtAttemptLimit);
    await step('maintenance.schedule_recovery_failed', recoverStrandedScheduledTasks);
    await step('maintenance.metering_failed', async () => {
      const running = await store.listRunningWorkspaces();
      await Promise.all(running.map(meterWorkspace));
    });
    log.debug('maintenance.swept', { durationMs: Math.round(performance.now() - started) });
  };
  /** Sweeps never overlap: a caller that arrives mid-sweep waits and then gets a fresh one. */
  const maintain = (): Promise<void> => {
    const run = (maintenanceRun ?? Promise.resolve()).then(sweepOnce);
    maintenanceRun = run;
    void run.finally(() => {
      if (maintenanceRun === run) maintenanceRun = null;
    });
    return run;
  };
  void maintain();
  const maintenanceTimer = setInterval(() => {
    // A sweep that is still running skips the tick rather than queueing behind itself, so a
    // wedged runner cannot accumulate a backlog of waiting sweeps.
    if (!maintenanceRun) void maintain();
  }, 5 * 60_000);
  maintenanceTimer.unref();

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id ?? randomUUID());
    const known = error instanceof AthanorError;
    const invalid = error instanceof z.ZodError;
    const status = invalid
      ? 400
      : known && error.code === 'authentication_required'
        ? 401
        : known && ['not_found', 'workspace_not_found', 'task_not_found'].includes(error.code)
          ? 404
          : known && ['storage_limit', 'spend_cap_reached'].includes(error.code)
            ? 402
            : known && ['idempotency_conflict', 'operation_in_progress'].includes(error.code)
              ? 409
              : known
                ? error.statusCode
                : 500;
    const code = invalid ? 'invalid_request' : known ? error.code : 'request_failed';
    /**
     * The client is handed a requestId and told to quote it; this is the line it has to match.
     * A 401 is the ordinary sound of an expired cookie, so it stays at debug; an unrecognised
     * throw is the one case worth the stack frames, since its own message is never safe to print.
     */
    const fields = {
      requestId,
      code,
      statusCode: status,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      durationMs: Math.round(performance.now() - (requestStarted.get(request) ?? performance.now()))
    };
    if (status >= 500) log.error('http.request_failed', { ...fields, ...errorFields(error) });
    else if (status === 401) log.debug('http.request_rejected', fields);
    else log.warn('http.request_rejected', fields);
    /**
     * A rejected field says which one it was. The web client cannot send a malformed body - it is
     * built from the same schemas - so the only reader of this message is someone driving the API
     * directly, for whom "something is invalid" means guessing. The paths come from the request
     * the caller just sent and carry none of its values, so nothing is disclosed by naming them.
     */
    const invalidFields = invalid
      ? [...new Set(error.issues.map((issue) => issue.path.join('.')).filter(Boolean))]
          .slice(0, 8)
          .join(', ')
      : '';
    void reply.status(status).send({
      error: {
        code,
        message: invalid
          ? `One or more request fields are missing or invalid${invalidFields ? `: ${invalidFields}` : ''}`
          : known
            ? // An AthanorError message is written to be read by the owner, but some are built from
              // an upstream response, so the last thing before it leaves the process scrubs it.
              redactText(error.message)
            : 'The request could not be completed',
        requestId
      }
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    requestStarted.set(request, performance.now());
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (authRateLimitedPaths.has(path)) checkAuthRate(`${request.ip}:${path}`);
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const value = authorization.slice('Bearer '.length);
      const authenticated = /^oc_live_[A-Za-z0-9_-]{40,80}$/.test(value)
        ? await store.authenticateApiToken(sha256(value))
        : null;
      request.user = authenticated?.user ?? null;
      request.apiToken = authenticated?.token ?? null;
    } else {
      request.user = await sessionUser(
        store,
        request.cookies[sessionCookieName(secure)],
        reply,
        secure
      );
      request.apiToken = null;
    }
    if (!publicPaths.has(path) && !request.user) {
      throw new AthanorError('authentication_required', 'Sign in to continue');
    }
    if (request.apiToken) {
      const scope = requiredApiTokenScope(request.method, path);
      if (!scope || !request.apiToken.scopes.includes(scope))
        throw new AthanorError(
          'api_token_scope_required',
          scope
            ? `This API token requires the ${scope} scope`
            : 'API tokens cannot call this endpoint',
          403
        );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== config.PUBLIC_APP_URL)
        throw new AthanorError('invalid_origin', 'Request origin is not allowed');
    }
  });
  /**
   * Every identifier that appears in a path is a UUID column. PostgreSQL answers a malformed one
   * with error 22P02 rather than an empty result, and that reached the owner as a 500 and
   * "The request could not be completed" - for a truncated link, a bookmark to a conversation that
   * has been deleted, or a path segment the router matched as an id because no static route claimed
   * it. None of those are server faults, so the shape is checked here while it is still known which
   * record was being asked for.
   */
  app.addHook('preHandler', async (request) => {
    const parameters = request.params as Record<string, unknown> | null;
    if (!parameters) return;
    for (const [name, value] of Object.entries(parameters)) {
      if (!name.endsWith('Id') || typeof value !== 'string') continue;
      if (uuidPattern.test(value)) continue;
      throw new AthanorError(
        missingRecordCode[name] ?? 'not_found',
        `${missingRecordLabel[name] ?? 'The record'} was not found`,
        404
      );
    }
  });
  app.addHook('preHandler', async (request) => {
    const user = request.user;
    if (!user) return;
    const route = request.routeOptions.url ?? '';
    const parameters = request.params as { workspaceId?: string; taskId?: string };
    if (parameters.workspaceId) {
      // The workspace reports its own liveness; there is no caller to authorize.
      if (route.endsWith('/heartbeat')) return;
      /**
       * Every route carrying a workspace id is authorized here, reads included, so a GET added
       * later cannot ship with no check at all - which is how the file routes once came to be
       * readable more widely than the export they duplicate.
       *
       * There is one question left to ask. The computer belongs to the person who installed this,
       * and nothing can put a second person on it, so "may this caller act here" and "is this the
       * owner's own workspace" are the same question with one answer.
       */
      if (!(await store.workspaceBelongsToUser(user.id, parameters.workspaceId)))
        throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    }
    if (parameters.taskId && route === '/v1/tasks/:taskId/:action' && request.method === 'POST') {
      if (!(await store.getTask(user.id, parameters.taskId)))
        throw new AthanorError('task_not_found', 'Task not found', 404);
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const key = `${request.method}|${route}|${reply.statusCode}`;
    const metric = requestMetrics.get(key) ?? { count: 0, durationMs: 0 };
    metric.count += 1;
    const durationMs = Math.max(
      0,
      performance.now() - (requestStarted.get(request) ?? performance.now())
    );
    metric.durationMs += durationMs;
    requestMetrics.set(key, metric);
    // The route pattern, never the URL: a path parameter is an identifier, a query string is not
    // guaranteed to be one. Per-request lines are for a diagnosis session, not for standing use.
    log.debug('http.request', {
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs)
    });
  });

  registerAuthRoutes(app, store, config);
  app.get('/healthz', async () => ({ ok: true, service: 'api' }));
  /**
   * A WebAuthn Relying Party ID has to be a registrable domain: the spec rules out IP literals,
   * and Chrome refuses outright. A server reached only by address therefore cannot run a passkey
   * ceremony at all, however healthy everything else is. That is reported here so the sign-in
   * screen can say what to do instead of presenting a button that always fails.
   */
  const passkeysUsable = !isAddressLiteral(config.WEBAUTHN_RP_ID);
  /**
   * What this program is and where its source is, which is all a licence notice on an AGPL box
   * amounts to.
   *
   * It used to carry a document version and an "acceptance required" flag as well. Nothing ever
   * served a document to accept and nothing could record an acceptance after registration, so the
   * flag was a constant `false` and the version a constant null - a gate reported to every client
   * that could never close. A machine the owner installed does not present its owner with terms.
   */
  app.get('/v1/legal', async () => ({
    applicationLicense: 'AGPL-3.0-only' as const,
    sourceUrl: config.PUBLIC_SOURCE_URL ?? null,
    privacyUrl: config.PUBLIC_PRIVACY_URL ?? null,
    passkeysUsable,
    registrationAvailable: (await store.countUsers()) === 0,
    /**
     * Whether recovery needs to be told which account it is for.
     *
     * On a box with one owner it does not, and asking made the last-resort path depend on
     * remembering a display name typed once during setup. Nothing is disclosed by saying so that
     * `registrationAvailable` does not already say: a box that refuses registration is a box that
     * has been claimed.
     */
    singleOwner: (await store.countUsers()) === 1
  }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await database.query('SELECT 1 AS ready');
      return { ok: true, service: 'api' };
    } catch (error) {
      // The one route that reports a dead database, and the gate an update should be checking.
      log.error('api.not_ready', { driver: config.DATABASE_DRIVER, ...errorFields(error) });
      return reply.status(503).send({ ok: false, service: 'api' });
    }
  });
  app.get('/metrics', async (_request, reply) => {
    const lines = [
      '# HELP athanor_http_requests_total Content-free HTTP request count',
      '# TYPE athanor_http_requests_total counter'
    ];
    for (const [key, metric] of requestMetrics) {
      const [method, route, status] = key.split('|');
      const labels = `method=${JSON.stringify(method)},route=${JSON.stringify(route)},status=${JSON.stringify(status)}`;
      lines.push(
        `athanor_http_requests_total{${labels}} ${metric.count}`,
        `athanor_http_request_duration_milliseconds_sum{${labels}} ${metric.durationMs.toFixed(3)}`
      );
    }
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
  app.get('/v1/auth/me', async (request) => ({ user: requireUser(request.user) }));

  app.get('/v1/sessions', async (request) => {
    const user = requireUser(request.user);
    const currentHash = request.cookies[sessionCookieName(secure)]
      ? sha256(request.cookies[sessionCookieName(secure)]!)
      : null;
    const sessions = await store.listSessions(user.id);
    if (!currentHash) return sessions;
    const currentId = await store.getSessionPublicId(user.id, currentHash);
    return sessions.map((session) => ({ ...session, current: session.id === currentId }));
  });

  /**
   * A fresh recovery code for an owner who still has a passkey but has lost the paper.
   *
   * Step-up first and always: a recovery code is a permanent way back into the account from any
   * device, so anyone who could reach an unlocked browser could otherwise mint themselves one. The
   * code is shown once - nothing here can read it back, only replace it again.
   */
  app.post('/v1/auth/recovery-code', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const recoveryCode = randomBytes(18).toString('base64url');
    const replaced = await store.setRecoveryHash(user.id, await hashRecoveryCode(recoveryCode));
    if (!replaced) throw new AthanorError('user_not_found', 'Account not found', 404);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'recovery_code_reissued',
      outcome: 'completed'
    });
    return { recoveryCode };
  });

  app.get('/v1/api-tokens', async (request) => {
    const user = requireUser(request.user);
    return (await store.listApiTokens(user.id)).map(apiTokenResponse);
  });

  app.post('/v1/api-tokens', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const input = CreateApiTokenRequest.parse(request.body);
    const value = `oc_live_${randomBytes(32).toString('base64url')}`;
    let created: ApiTokenRecord;
    try {
      created = await store.createApiToken({
        userId: user.id,
        label: input.label,
        tokenHash: sha256(value),
        prefix: value.slice(0, 16),
        scopes: [...new Set(input.scopes)],
        expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000)
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'api_token_limit')
        throw new AthanorError(
          'api_token_limit',
          'Revoke an existing API token before creating another',
          409
        );
      throw cause;
    }
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'api_token_create',
      outcome: 'completed',
      metadata: { tokenId: created.id, scopes: created.scopes }
    });
    return { apiToken: apiTokenResponse(created), token: value };
  });

  app.delete<{ Params: { tokenId: string } }>('/v1/api-tokens/:tokenId', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const tokenId = z.string().uuid().parse(request.params.tokenId);
    const revoked = await store.revokeApiToken(user.id, tokenId);
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'api_token_revoke',
      outcome: revoked ? 'completed' : 'not_found',
      metadata: { tokenId }
    });
    return { revoked };
  });

  app.delete<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const sessionId = z.string().uuid().parse(request.params.sessionId);
        const deletedHash = await store.deleteSessionForUser(user.id, sessionId);
        const token = request.cookies[sessionCookieName(secure)];
        const current = Boolean(token && deletedHash && sha256(token) === deletedHash);
        if (current)
          reply.clearCookie(sessionCookieName(secure), {
            path: '/',
            httpOnly: true,
            secure,
            sameSite: 'strict'
          });
        return { revoked: Boolean(deletedHash), current };
      });
    }
  );

  app.get('/v1/notifications/config', async () => ({
    enabled: Boolean(config.PUSH_VAPID_PUBLIC_KEY),
    publicKey: config.PUSH_VAPID_PUBLIC_KEY ?? null
  }));

  app.post('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      if (!config.PUSH_VAPID_PUBLIC_KEY) {
        throw new AthanorError(
          'push_unavailable',
          'Push notifications are not configured for this deployment'
        );
      }
      const input = pushSubscriptionSchema.parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      const sessionToken = request.cookies[sessionCookieName(secure)];
      const sessionPublicId = sessionToken
        ? await store.getSessionPublicId(user.id, sha256(sessionToken))
        : null;
      if (!sessionPublicId)
        throw new AthanorError('authentication_required', 'Active device session is required');
      const subscription = await store.upsertPushSubscription({
        userId: user.id,
        sessionPublicId,
        endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth
      });
      reply.status(201);
      return { id: subscription.id, enabled: true };
    });
  });

  app.delete('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ endpoint: z.string().url().max(2048) }).parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      await store.deletePushSubscription(user.id, endpoint);
      return { enabled: false };
    });
  });

  /**
   * The owner's notification preferences.
   *
   * Quiet hours are stored as minutes past local midnight and travel as "HH:MM", because the owner
   * thinks in a clock and the notifier thinks in a comparison. The zone is echoed read-only from
   * the spending caps: there is one answer on this box to when the owner's day rolls over, and a
   * second copy of it would eventually disagree.
   */
  const clockToMinutes = (value: string): number => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) throw new AthanorError('invalid_quiet_hours', 'Quiet hours need a time like 22:00');
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const minutesToClock = (value: number): string =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const notificationSettingsResponse = async (userId: string) => {
    const stored = (await store.notificationSettings(userId)) ?? {
      kinds: {
        approval_required: true,
        task_finished: true,
        spend_paused: true,
        agent_message: true,
        takeover_needed: true
      },
      quietHours: null,
      quietHoursAllowApprovals: true
    };
    const limits = await store.effectiveSpendLimits(userId);
    return {
      kinds: {
        approvalRequired: stored.kinds.approval_required,
        taskFinished: stored.kinds.task_finished,
        spendPaused: stored.kinds.spend_paused,
        agentMessage: stored.kinds.agent_message,
        takeoverNeeded: stored.kinds.takeover_needed
      },
      quietHoursStart: stored.quietHours ? minutesToClock(stored.quietHours.startMinute) : null,
      quietHoursEnd: stored.quietHours ? minutesToClock(stored.quietHours.endMinute) : null,
      quietHoursAllowApprovals: stored.quietHoursAllowApprovals,
      timeZone: limits.timeZone
    };
  };

  app.get('/v1/notifications/settings', async (request) =>
    notificationSettingsResponse(requireUser(request.user).id)
  );

  /**
   * Every kind that can reach a device has a switch here, the two the agent raises included. They
   * arrived without one, on the reasoning that the agent asking for the owner is not the box
   * reporting on itself - but that made the one notification the owner explicitly asked for also
   * the only one they could not turn down, short of unsubscribing the device entirely.
   */
  const UpdateNotificationSettingsRequest = z.object({
    kinds: z.object({
      approvalRequired: z.boolean(),
      taskFinished: z.boolean(),
      spendPaused: z.boolean(),
      agentMessage: z.boolean(),
      takeoverNeeded: z.boolean()
    }),
    quietHoursStart: z.string().nullable(),
    quietHoursEnd: z.string().nullable(),
    quietHoursAllowApprovals: z.boolean()
  });

  app.put('/v1/notifications/settings', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateNotificationSettingsRequest.parse(request.body);
      // Both ends or neither: half a window is not a window, and it would silently never be quiet.
      if (Boolean(input.quietHoursStart) !== Boolean(input.quietHoursEnd))
        throw new AthanorError(
          'invalid_quiet_hours',
          'Quiet hours need both a start and an end time'
        );
      const quietHours =
        input.quietHoursStart && input.quietHoursEnd
          ? {
              startMinute: clockToMinutes(input.quietHoursStart),
              endMinute: clockToMinutes(input.quietHoursEnd)
            }
          : null;
      if (quietHours && quietHours.startMinute === quietHours.endMinute)
        throw new AthanorError(
          'invalid_quiet_hours',
          'Quiet hours that start and end at the same minute would never be quiet'
        );
      await store.setNotificationSettings(user.id, {
        kinds: {
          approval_required: input.kinds.approvalRequired,
          task_finished: input.kinds.taskFinished,
          spend_paused: input.kinds.spendPaused,
          agent_message: input.kinds.agentMessage,
          takeover_needed: input.kinds.takeoverNeeded
        },
        quietHours,
        quietHoursAllowApprovals: input.quietHoursAllowApprovals
      });
      return notificationSettingsResponse(user.id);
    });
  });

  /**
   * Everything the agent has told this owner, across every conversation, newest first.
   *
   * A push is one moment on whichever devices happened to be subscribed. This is the standing
   * record of the same decisions, so a watcher's week can be read in one place by an owner whose
   * phone was off - and so a notice is still recoverable when the push was dropped for quiet hours
   * or because they were already at the keyboard.
   */
  app.get<{ Querystring: { limit?: string } }>('/v1/notifications/agent', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
    return (await store.listAgentNotifications(user.id, limit, masterKey)).map(
      (row): AgentNotification => ({
        id: row.id,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        kind: row.kind,
        /**
         * A notice the workspace key will not unwrap says so, in the field a client renders. It
         * used to be served as null, and a row with nothing to read is dropped rather than drawn -
         * so the one notice that reports a conversation has become unreadable was the one notice
         * that vanished silently. This is a rare row and a serious one: it means a key this box
         * holds no longer opens what it sealed.
         */
        message: row.message ?? UNREADABLE_AGENT_MESSAGE,
        createdAt: row.createdAt
      })
    );
  });

  const PROVIDER_SPEND_WINDOWS = ['daily', 'weekly', 'monthly'] as const;

  /**
   * What the owner's provider has charged over their own day, week and month.
   *
   * The boundaries come from the same place the spending caps take theirs, and so does the figure:
   * `spendTotal` is the statement the caps themselves are measured with. The usage pane draws a
   * window's spend beside a cap when one is set and without it when none is, and it used to reach a
   * second, separately worded query to do it - two definitions of "what this cost" that agreed only
   * as long as nobody edited one of them. There is no allowance to report against either: the owner
   * holds the provider account and pays it directly.
   */
  const providerSpend = async (userId: string) => {
    const { timeZone } = await store.effectiveSpendLimits(userId);
    const periods = spendWindowBounds(timeZone);
    const spent = await Promise.all(
      PROVIDER_SPEND_WINDOWS.map((name) =>
        store.spendTotal(userId, periods[name].start, periods[name].end)
      )
    );
    return {
      windows: Object.fromEntries(
        PROVIDER_SPEND_WINDOWS.map((name, index) => [
          name,
          { used: spent[index] ?? 0, resetsAt: periods[name].end.toISOString() }
        ])
      ) as Record<(typeof PROVIDER_SPEND_WINDOWS)[number], { used: number; resetsAt: string }>
    };
  };

  /**
   * The dollar ceiling a task actually runs under. A request that names none inherits the account
   * default rather than becoming unlimited, which is what lets one setting cover follow-ups and
   * scheduled runs as well as tasks started by hand.
   */
  /**
   * The compute allowance a turn starts with, sized so it outlasts the step budget rather than
   * expiring a third of the way into it.
   *
   * A credit is (input + 2x output) per million tokens, times a class multiplier that runs from 0.5
   * to 5. So the same fixed number is eighty steps on a light model and nine on a heavy one, and the
   * five everything asked for was reached around step twenty-two to thirty-nine on a frontier model
   * against a step budget of a hundred and twenty. The ceiling that actually fired was therefore
   * never the one anything was designed around.
   *
   * This is a runaway backstop, not the owner's spending limit - that is `maxSpendUsd`, denominated
   * in real money, which is the number they set and understand. So it is sized to sit just past the
   * step budget for the model actually chosen, and the owner is never asked about it.
   */
  const computeAllowanceFor = (model: { usageClass: string }, maxSteps: number): number => {
    const multiplier = { light: 0.5, medium: 1, high: 2.5, extra_high: 5 }[model.usageClass] ?? 1;
    // A generous step: a large window in, a full reply out. Rounded up so the arithmetic never
    // lands exactly on the boundary it is meant to sit past.
    const creditsPerStep = ((200_000 + 2 * 16_384) / 1_000_000) * multiplier;
    return Math.ceil(creditsPerStep * maxSteps * 1.1);
  };

  const resolveSpendCeiling = async (
    userId: string,
    requested: number | undefined
  ): Promise<number | null> =>
    requested ?? (await store.effectiveSpendLimits(userId)).defaultTaskCapUsd;

  /**
   * Refuses work that would take the day or the month past its cap before any of it is started.
   * The whole ceiling is offered as the estimate because that is what starting the work commits to,
   * and open commitments count - otherwise two tasks started in the same second each fit under the
   * cap and together sail past it. A ceiling of zero still asks the question, which is how a cap
   * that is already breached stops work that named no ceiling of its own.
   */
  const assertSpendCeilingAllowed = async (input: {
    userId: string;
    ceilingUsd: number | null;
    /**
     * Set on a follow-up. The task is then excluded from the commitments it is measured against -
     * it would otherwise block on its own reservation - and its own window is left to the worker,
     * which knows what the task has already spent.
     */
    taskId?: string;
  }): Promise<void> => {
    assertSpendAllowed(
      await store.spendGuard({
        userId: input.userId,
        ...(input.taskId ? { taskId: input.taskId, taskCapUsd: null } : {}),
        estimateUsd: input.ceilingUsd ?? 0,
        ...(input.taskId ? {} : { taskCapUsd: input.ceilingUsd }),
        includeOpenCommitments: true
      })
    );
  };

  const requiresZeroDataRetention = async (userId: string): Promise<boolean> => {
    const saved = await store.getManagedProviderCredential(userId, 'inference');
    if (saved?.status !== 'active') return config.AI_REQUIRE_ZDR;
    try {
      return (
        decryptJson<{ enforceZeroDataRetention?: boolean }>(
          saved.secretCiphertext,
          masterKey,
          inferenceCredentialAad(userId)
        ).enforceZeroDataRetention !== false
      );
    } catch {
      // An unreadable credential must never weaken the configured privacy floor.
      return true;
    }
  };

  /**
   * Put the catalogue back if something flattened it.
   *
   * The registry service used to write the static seed over the enriched catalogue once an hour,
   * which left every model at availability 'review' with no prices - out of the picker, and
   * `model_unavailable` for anything pinned to one. That is fixed at the source, but a box that
   * already hit it stays flattened until its owner happens to re-save their provider key, and
   * nothing tells them that is the cure. So it repairs itself: if every model in the catalogue is
   * still in the seeded state and the owner has a working credential, ask the provider again.
   *
   * Runs without being awaited. It is a repair, not a precondition - the server should answer
   * requests while it happens, and a provider that is down must not delay startup.
   */
  const repairFlattenedCatalog = async (): Promise<void> => {
    const catalog = await store.listModels();
    if (!catalog.length || catalog.some((model) => String(model.availability) !== 'review')) return;
    const owner = await store.soleUser();
    if (!owner) return;
    const saved = await store.getManagedProviderCredential(owner.id, 'inference');
    if (saved?.status !== 'active') return;
    const secret = decryptJson<{ provider?: string; baseUrl?: string; apiKey?: string }>(
      saved.secretCiphertext,
      masterKey,
      inferenceCredentialAad(owner.id)
    );
    if (secret.provider !== 'openrouter' || !secret.apiKey) return;
    const live = await refreshOpenRouterCatalog(seedModels(), {
      baseUrl: secret.baseUrl ?? config.OPENROUTER_BASE_URL,
      apiKey: secret.apiKey,
      scope: config.MODEL_CATALOG_SCOPE,
      ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
    });
    await store.upsertModels(live);
    log.info('models.catalog_repaired', { models: live.length });
  };
  void repairFlattenedCatalog().catch((error: unknown) => {
    log.warn('models.catalog_repair_failed', errorFields(error));
  });

  const modelsForUser = async (user: UserRecord) => {
    const requireZdr = await requiresZeroDataRetention(user.id);
    return (await store.listModels()).map((record) => {
      // The contract's parse strips what it does not declare, and the fields the router reads -
      // where the numbers came from, when the route retires, how it bills a cached prefix - are
      // deliberately not part of the owner-facing model shape. Carried alongside rather than
      // widened into it, so the API keeps answering with exactly what it promises.
      const model = applyOpenRouterPrivacyPolicy(ModelRelease.parse(record), requireZdr);
      return { ...model, ...readRoutingMetadata(record) };
    });
  };

  const schedulerOwner = `${config.WORKER_ID}:scheduler:${process.pid}`;
  let schedulerBusy = false;
  const dispatchDueSchedule = async (): Promise<void> => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const schedule = await store.leaseDueTaskSchedule(schedulerOwner, 120);
      if (!schedule) return;
      const [user, workspace] = await Promise.all([
        store.getUserById(schedule.userId),
        store.getWorkspace(schedule.userId, schedule.workspaceId)
      ]);
      if (!user) return;
      const catalog = await modelsForUser(user);
      const selected = catalog.find((model) => model.id === schedule.modelId);
      if (
        ['provisioning', 'resizing'].includes(workspace?.status ?? '') ||
        selected?.availability === 'degraded'
      ) {
        const code =
          selected?.availability === 'degraded'
            ? 'model_temporarily_unavailable'
            : 'workspace_starting';
        await store.deferTaskSchedule(schedule.id, schedulerOwner, code);
        log.info('schedule.deferred', { scheduleId: schedule.id, code });
        return;
      }
      const forceFailureCode = !workspace
        ? 'workspace_missing'
        : ['failed', 'deleting'].includes(workspace.status)
          ? 'workspace_unavailable'
          : !selected ||
              selected.availability !== 'available' ||
              selected.privacyRoute !== schedule.privacyRoute
            ? 'model_unavailable'
            : undefined;
      const nextRunAt = advanceScheduleRun(
        schedule.spec,
        schedule.nextRunAt ? new Date(schedule.nextRunAt) : null
      );
      const taskId = randomUUID();
      if (!workspace?.wrappedKey) {
        // A workspace cascade normally removes its schedules. A concurrently deleted
        // workspace leaves this lease to expire without exposing schedule content.
        log.warn('schedule.workspace_gone', {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId
        });
        return;
      }
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const preparingEventCiphertext = encryptJson(
        {
          __athanorEventVersion: 1,
          summary: 'Scheduled run is starting the computer',
          payload: { scheduleId: schedule.id, scheduledFor: schedule.nextRunAt }
        },
        key,
        `task-event:${taskId}`
      );
      const failureEventCiphertext = encryptJson(
        {
          __athanorEventVersion: 1,
          summary: 'Scheduled run could not start',
          payload: { owner: true, scheduleId: schedule.id }
        },
        key,
        `task-event:${taskId}`
      );
      const materialized = await store.materializeTaskSchedule({
        scheduleId: schedule.id,
        workerId: schedulerOwner,
        taskId,
        nextRunAt,
        resourceClass: selected?.usageClass ?? 'unknown',
        preparingEventCiphertext,
        failureEventCiphertext,
        ...(forceFailureCode ? { forceFailureCode } : {})
      });
      if (!materialized) return;
      if (materialized.outcome === 'failed') {
        await store.appendTaskEvent({
          taskId,
          kind: 'error',
          summary: 'Encrypted schedule error event',
          payloadCiphertext: encryptJson(
            {
              __athanorEventVersion: 1,
              summary: scheduleErrorMessage(materialized.errorCode ?? 'schedule_failed'),
              payload: { owner: true, code: materialized.errorCode, scheduleId: schedule.id }
            },
            key,
            `task-event:${taskId}`
          )
        });
        log.warn('schedule.run_rejected', {
          scheduleId: schedule.id,
          taskId,
          code: materialized.errorCode ?? 'schedule_failed'
        });
        return;
      }
      await promoteScheduledTask({
        scheduleId: schedule.id,
        taskId,
        userId: user.id,
        workspace,
        key
      });
    } finally {
      schedulerBusy = false;
    }
  };
  const dispatchDueScheduleSafely = (): void => {
    void dispatchDueSchedule().catch((error: unknown) => {
      log.error('schedule.dispatch_failed', errorFields(error));
    });
  };
  dispatchDueScheduleSafely();
  const schedulerTimer = setInterval(dispatchDueScheduleSafely, config.SCHEDULER_POLL_MS);
  schedulerTimer.unref();

  app.get('/v1/bootstrap', async (request) => {
    const user = requireUser(request.user);
    const workspaces = await ensurePrimaryWorkspace(user);
    const [ownedWorkspaces, tasks, schedules, models, providerCredential] = await Promise.all([
      store.listWorkspaces(user.id),
      store.listTaskPage(user.id),
      store.listTaskSchedules(user.id),
      modelsForUser(user),
      store.getManagedProviderCredential(user.id, 'inference')
    ]);
    const { start: periodStart, end: periodEnd } = currentPeriod();
    const hostStorage = new Map(
      ownedWorkspaces
        .map((workspace) => [workspace.id, cachedHostStorage(workspace)] as const)
        .filter((entry): entry is readonly [string, HostStorage & { storageBytes: number }] =>
          Boolean(entry[1])
        )
    );
    const usage = await store.usageTotals(user.id, periodStart, periodEnd);
    // What the owner was part-way through typing, on whichever device they typed it. Opened here
    // rather than by the client, because the client has no key and never sees one; a draft whose
    // workspace key cannot be unwrapped is simply left out rather than failing the whole load.
    const drafts = (
      await Promise.all(
        ownedWorkspaces.map(async (workspace) => {
          if (!workspace.wrappedKey) return [];
          try {
            const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
            const rows = await store.listMessageDrafts(user.id, workspace.id);
            return rows.map((row) => {
              // `attachments` is absent from a draft written before they travelled with one, so it
              // reads as none rather than as a decryption failure that would drop the sentence too.
              const opened = decryptJson<{
                body: string;
                attachments?: Array<{
                  path: string;
                  name: string;
                  sizeBytes: number;
                  mimeType: string;
                }>;
              }>(row.bodyCiphertext, key);
              return {
                workspaceId: workspace.id,
                taskId: row.taskId,
                body: opened.body,
                attachments: opened.attachments ?? [],
                updatedAt: row.updatedAt
              };
            });
          } catch {
            return [];
          }
        })
      )
    ).flat();
    return {
      user,
      drafts,
      workspaces: workspaces.map((workspace) =>
        workspaceResponse(
          {
            ...workspace,
            storageBytes: hostStorage.get(workspace.id)?.storageBytes ?? workspace.storageBytes
          },
          hostStorage.get(workspace.id)
        )
      ),
      tasks: await Promise.all(
        tasks.tasks.map((task) =>
          privateTaskResponse(
            task,
            workspaces.find((workspace) => workspace.id === task.workspaceId)
          )
        )
      ),
      /** Where GET /v1/tasks resumes from, so the sidebar can reach past this first page. */
      tasksCursor: tasks.nextCursor,
      schedules: await Promise.all(
        schedules.map((schedule) =>
          privateScheduleResponse(
            schedule,
            workspaces.find((workspace) => workspace.id === schedule.workspaceId)
          )
        )
      ),
      /*
       * The catalogue as the picker needs it, not as the router needs it.
       *
       * This is the request that gates first paint: nothing renders until it returns. It was 426 kB
       * on a box with a provider connected, and 424.5 kB of that was the model catalogue - 341
       * models with forty-three fields each, including benchmark populations, cache pricing, price
       * tiers, uptime percentages and knowledge cutoffs. Everything else in the payload together
       * came to 1.7 kB. The web client reads five of those fields; the rest went to every device on
       * every launch and was never looked at. The full record is still one request away for anyone
       * who needs it - `GET /v1/models` - and the router reads it server-side where it lives.
       */
      models: models.map((model) => ({
        id: model.id,
        providerModelId: model.providerModelId,
        displayName: model.displayName,
        // Kept although no screen reads it: it is how "this box exposes only hosted routes" is
        // checked at the surface the client actually receives, and a boundary that can only be
        // asserted server-side is one nobody notices breaking.
        provider: model.provider,
        availability: model.availability,
        privacyRoute: model.privacyRoute
      })),
      instance: {
        mode: 'self_hosted',
        providerConfigured: Boolean(
          providerCredential?.status === 'active' ||
          config.AI_API_KEY ||
          config.OPENROUTER_API_KEY ||
          (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL)
        ),
        enforceZeroDataRetention: await requiresZeroDataRetention(user.id),
        /**
         * Where a web search on this box is answered, so the client can say "this query leaves the
         * computer" beside the box it is typed in without asking again.
         */
        webSearch: await webSearchRouteFor(user.id)
      },
      legal: {
        applicationLicense: 'AGPL-3.0-only',
        sourceUrl: config.PUBLIC_SOURCE_URL ?? null,
        privacyUrl: config.PUBLIC_PRIVACY_URL ?? null
      },
      usage: {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        consumedCredits: usage.settled,
        reservedCredits: usage.reserved,
        storageBytes: ownedWorkspaces.reduce((sum, workspace) => sum + workspace.storageBytes, 0),
        storageLimitBytes: serverLimits.storageBytes,
        providerSpend: await providerSpend(user.id)
      }
    };
  });

  app.get<{
    Querystring: { q?: string; workspaceId?: string; limit?: string };
  }>('/v1/search', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        q: z.string().trim().min(2).max(500),
        workspaceId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query);
    const workspaces = input.workspaceId
      ? [await store.getWorkspace(user.id, input.workspaceId)].filter(
          (workspace): workspace is WorkspaceRecord => Boolean(workspace?.wrappedKey)
        )
      : (await store.listWorkspaces(user.id)).filter((workspace) => Boolean(workspace.wrappedKey));
    const query = input.q.toLowerCase();
    const terms = [...new Set(query.split(/\s+/).filter((term) => term.length > 1))];
    const score = (content: string): number => {
      const lower = content.toLowerCase();
      return (
        (lower.includes(query) ? 10 : 0) +
        terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0)
      );
    };
    const excerpt = (content: string): string => {
      const flat = content.replace(/\s+/g, ' ').trim();
      const lower = flat.toLowerCase();
      const at =
        [lower.indexOf(query), ...terms.map((term) => lower.indexOf(term))]
          .filter((index) => index >= 0)
          .sort((left, right) => left - right)[0] ?? 0;
      const start = Math.max(0, at - 100);
      return `${start ? '…' : ''}${flat.slice(start, start + 280)}${
        start + 280 < flat.length ? '…' : ''
      }`;
    };
    const results: Array<{
      taskId: string;
      workspaceId: string;
      title: string;
      excerpt: string;
      score: number;
      updatedAt: string;
    }> = [];
    for (const workspace of workspaces) {
      const key = unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id);
      for (const task of await store.listTasks(user.id, workspace.id)) {
        let title = task.legacyTitle ?? 'Private task';
        if (task.titleCiphertext?.aad === `task-title:${workspace.id}`)
          title = decryptJson<{ title: string }>(task.titleCiphertext, key).title;
        const candidates: string[] = [title];
        if (task.promptCiphertext.aad === `task-prompt:${workspace.id}`)
          candidates.push(decryptJson<{ prompt: string }>(task.promptCiphertext, key).prompt);
        for (const event of await store.listTaskEvents(task.id)) {
          if (event.payloadCiphertext?.aad !== `task-event:${task.id}`) continue;
          try {
            candidates.push(JSON.stringify(decryptJson<unknown>(event.payloadCiphertext, key)));
          } catch {
            // A malformed legacy event is skipped rather than weakening the query boundary.
          }
        }
        const ranked = candidates
          .map((content) => ({ content, score: score(content) }))
          .sort((left, right) => right.score - left.score)[0];
        if (!ranked?.score) continue;
        results.push({
          taskId: task.id,
          workspaceId: workspace.id,
          title,
          excerpt: excerpt(ranked.content),
          score: ranked.score,
          updatedAt: task.updatedAt
        });
      }
    }
    return results
      .sort(
        (left, right) =>
          right.score - left.score ||
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
      .slice(0, input.limit)
      .map((result) => ({
        taskId: result.taskId,
        workspaceId: result.workspaceId,
        title: result.title,
        excerpt: result.excerpt,
        updatedAt: result.updatedAt
      }));
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/memories',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return (await store.listWorkspaceMemories(user.id, request.params.workspaceId)).map(
        (record) => {
          const document = decryptJson<MemoryDocument>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          );
          return {
            id: record.id,
            target: record.target,
            content: document.content,
            status: memoryTemporalStatus(document),
            validFrom: document.validFrom ?? null,
            validUntil: document.validUntil ?? null,
            source: document.source ?? 'owner',
            sourceTaskId: document.sourceTaskId ?? null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
          };
        }
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { target: 'workspace' | 'user'; content: string; validUntil?: string };
  }>('/v1/workspaces/:workspaceId/memories', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        target: z.enum(['workspace', 'user']),
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).optional()
      })
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const targetTotal = records
      .filter((record) => {
        if (record.target !== input.target) return false;
        const document = decryptJson<MemoryDocument>(
          record.contentCiphertext,
          key,
          `workspace-memory:${request.params.workspaceId}`
        );
        return memoryTemporalStatus(document) !== 'expired';
      })
      .reduce(
        (total, record) =>
          total +
          decryptJson<{ content: string }>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          ).content.length,
        0
      );
    const limit = input.target === 'user' ? 6_000 : 12_000;
    if (targetTotal + input.content.length > limit)
      throw new AthanorError(
        'memory_full',
        `${input.target} memory is full. Consolidate or remove an entry first.`
      );
    const document: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      ...(input.validUntil ? { validUntil: input.validUntil } : {})
    };
    assertMemoryValidity(document);
    const created = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      target: input.target,
      contentCiphertext: encryptJson(
        document,
        key,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    return {
      id: created.id,
      target: created.target,
      content: input.content,
      status: memoryTemporalStatus(document),
      validFrom: document.validFrom ?? null,
      validUntil: document.validUntil ?? null,
      source: document.source ?? 'owner',
      sourceTaskId: document.sourceTaskId ?? null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    };
  });

  app.patch<{
    Params: { workspaceId: string; memoryId: string };
    Body: { content: string; validUntil?: string | null };
  }>('/v1/workspaces/:workspaceId/memories/:memoryId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        content: KnowledgeText.pipe(z.string().max(4_000)),
        validUntil: z.string().datetime({ offset: true }).nullable().optional()
      })
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const records = await store.listWorkspaceMemories(user.id, request.params.workspaceId);
    const existing = records.find((record) => record.id === request.params.memoryId);
    if (!existing) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    const existingDocument = decryptJson<MemoryDocument>(
      existing.contentCiphertext,
      key,
      `workspace-memory:${request.params.workspaceId}`
    );
    const otherTotal = records
      .filter((record) => {
        if (record.target !== existing.target || record.id === existing.id) return false;
        const document = decryptJson<MemoryDocument>(
          record.contentCiphertext,
          key,
          `workspace-memory:${request.params.workspaceId}`
        );
        return memoryTemporalStatus(document) !== 'expired';
      })
      .reduce(
        (total, record) =>
          total +
          decryptJson<{ content: string }>(
            record.contentCiphertext,
            key,
            `workspace-memory:${request.params.workspaceId}`
          ).content.length,
        0
      );
    const limit = existing.target === 'user' ? 6_000 : 12_000;
    if (otherTotal + input.content.length > limit)
      throw new AthanorError('memory_full', 'Replacement would exceed the memory limit');
    const updatedDocument: MemoryDocument = {
      content: input.content,
      source: 'owner',
      validFrom: new Date().toISOString(),
      previousUpdatedAt: existing.updatedAt,
      ...(input.validUntil === null
        ? {}
        : input.validUntil
          ? { validUntil: input.validUntil }
          : existingDocument.validUntil
            ? { validUntil: existingDocument.validUntil }
            : {})
    };
    assertMemoryValidity(updatedDocument);
    const updated = await store.updateWorkspaceMemory({
      id: existing.id,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      contentCiphertext: encryptJson(
        updatedDocument,
        key,
        `workspace-memory:${request.params.workspaceId}`
      )
    });
    if (!updated) throw new AthanorError('memory_not_found', 'Memory entry not found', 404);
    return {
      id: updated.id,
      target: updated.target,
      content: input.content,
      status: memoryTemporalStatus(updatedDocument),
      validFrom: updatedDocument.validFrom ?? null,
      validUntil: updatedDocument.validUntil ?? null,
      source: updatedDocument.source ?? 'owner',
      sourceTaskId: updatedDocument.sourceTaskId ?? null,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete<{ Params: { workspaceId: string; memoryId: string } }>(
    '/v1/workspaces/:workspaceId/memories/:memoryId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceMemory(
          user.id,
          request.params.workspaceId,
          request.params.memoryId
        )
      };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/skills',
    async (request) => {
      const user = requireUser(request.user);
      const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      await store.curateWorkspaceSkills(request.params.workspaceId);
      return (await store.listWorkspaceSkills(user.id, request.params.workspaceId)).map(
        (record) => ({
          id: record.id,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          pinned: record.pinned,
          useCount: record.useCount,
          lastUsedAt: record.lastUsedAt,
          ...decryptJson<{ name: string; description: string; content: string }>(
            record.documentCiphertext,
            key,
            `workspace-skill:${request.params.workspaceId}`
          ),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { name: string; description: string; content: string };
  }>('/v1/workspaces/:workspaceId/skills', async (request) => {
    const user = requireUser(request.user);
    const input = SkillDocumentInput.parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const nameHash = createHmac('sha256', key).update(`athanor-skill:${input.name}`).digest('hex');
    const saved = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: request.params.workspaceId,
      nameHash,
      documentCiphertext: encryptJson(input, key, `workspace-skill:${request.params.workspaceId}`)
    });
    return {
      id: saved.id,
      version: saved.version,
      enabled: saved.enabled,
      status: saved.status,
      pinned: saved.pinned,
      useCount: saved.useCount,
      lastUsedAt: saved.lastUsedAt,
      ...input,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt
    };
  });

  app.patch<{
    Params: { workspaceId: string; skillId: string };
    Body: { status?: 'active' | 'stale' | 'archived'; pinned?: boolean };
  }>('/v1/workspaces/:workspaceId/skills/:skillId', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        status: z.enum(['active', 'stale', 'archived']).optional(),
        pinned: z.boolean().optional()
      })
      .refine((value) => value.status !== undefined || value.pinned !== undefined)
      .parse(request.body);
    const { key } = await workspaceKnowledgeKey(user.id, request.params.workspaceId);
    const updated = await store.setWorkspaceSkillState({
      id: request.params.skillId,
      userId: user.id,
      workspaceId: request.params.workspaceId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned })
    });
    if (!updated) throw new AthanorError('skill_not_found', 'Skill not found', 404);
    return {
      id: updated.id,
      version: updated.version,
      enabled: updated.enabled,
      status: updated.status,
      pinned: updated.pinned,
      useCount: updated.useCount,
      lastUsedAt: updated.lastUsedAt,
      ...decryptJson<{ name: string; description: string; content: string }>(
        updated.documentCiphertext,
        key,
        `workspace-skill:${request.params.workspaceId}`
      ),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  });

  app.delete<{ Params: { workspaceId: string; skillId: string } }>(
    '/v1/workspaces/:workspaceId/skills/:skillId',
    async (request) => {
      const user = requireUser(request.user);
      await workspaceKnowledgeKey(user.id, request.params.workspaceId);
      return {
        deleted: await store.deleteWorkspaceSkill(
          user.id,
          request.params.workspaceId,
          request.params.skillId
        )
      };
    }
  );

  app.get('/v1/workspaces', async (request) =>
    (await store.listWorkspaces(requireUser(request.user).id)).map((workspace) =>
      workspaceResponse(workspace)
    )
  );

  const provisionWorkspace = async (
    user: UserRecord,
    input: z.infer<typeof CreateWorkspaceRequest>
  ): Promise<Workspace> => {
    const existing = await store.listWorkspaces(user.id);
    if (existing.length >= serverLimits.maxWorkspaces)
      throw new AthanorError(
        'computer_already_exists',
        'This athanor installation already has its persistent computer',
        409
      );
    const remainingStorage =
      serverLimits.storageBytes - existing.reduce((sum, item) => sum + item.storageLimitBytes, 0);
    if (input.storageLimitBytes > remainingStorage)
      throw new AthanorError(
        'storage_limit',
        'The requested cloud storage exceeds your selected allowance'
      );
    const dataKey = generateDataKey();
    const workspaceId = randomUUID();
    const wrappedKey = wrapDataKey(dataKey, masterKey, workspaceId);
    const created = await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: input.name,
      storageLimitBytes: input.storageLimitBytes,
      imageRevision: config.WORKSPACE_IMAGE_REVISION,
      region: input.region,
      wrappedKey,
      keyProtection: keyRelease.mode,
      securityMode: input.securityMode
    });
    try {
      await runner.request({
        workspaceId: created.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${created.id}`,
        method: 'PUT',
        contentType: 'application/json',
        body: JSON.stringify({
          storageLimitBytes: created.storageLimitBytes,
          imageRevision: created.imageRevision
        })
      });
      await store.updateWorkspaceStatus(created.id, 'running', config.WORKSPACE_RUNNER_URL);
      return workspaceResponse((await store.getWorkspace(user.id, created.id))!);
    } catch (error) {
      await store.updateWorkspaceStatus(created.id, 'failed');
      throw error;
    }
  };

  app.post('/v1/workspaces', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateWorkspaceRequest.parse(request.body);
      return provisionWorkspace(user, input);
    });
  });

  /**
   * One computer per owner, made once.
   *
   * Deliberately counts a `failed` row as existing. A failed computer is the owner's computer with
   * their files in it that did not come up; provisioning a second one beside it would leave the
   * first orphaned and take its data out of reach, which is a worse answer than a computer that
   * needs starting. Repairing it is a different act, and the clients do it: the workbench asks the
   * box to resume a `failed` or `hibernated` computer on load and every five minutes, and Settings
   * offers the same call as a button.
   */
  const ensurePrimaryWorkspace = async (user: UserRecord): Promise<WorkspaceRecord[]> => {
    const existing = await store.listWorkspaces(user.id);
    if (existing.length) return existing;
    await provisionWorkspace(user, {
      name: 'My computer',
      storageLimitBytes: serverLimits.storageBytes,
      region: 'self-hosted',
      securityMode: 'balanced'
    });
    return store.listWorkspaces(user.id);
  };

  /**
   * The sidebar, a page at a time. `cursor` is the opaque position returned with the previous
   * page - and with the bootstrap, so reaching page two never costs a re-read of page one.
   */
  app.get<{
    Querystring: { workspaceId?: string; cursor?: string; limit?: string; include?: string };
  }>('/v1/tasks', async (request): Promise<TaskPage> => {
    const user = requireUser(request.user);
    const query = TaskPageQuery.parse(request.query);
    const page = await store.listTaskPage(user.id, {
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      include: query.include
    });
    return {
      tasks: await Promise.all(page.tasks.map((task) => privateTaskResponse(task))),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    };
  });

  app.get('/v1/schedules', async (request) => {
    const user = requireUser(request.user);
    return Promise.all(
      (await store.listTaskSchedules(user.id)).map((schedule) => privateScheduleResponse(schedule))
    );
  });

  app.post('/v1/schedules', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskScheduleRequest.parse(request.body);
      if (input.spec.kind === 'daily' || input.spec.kind === 'weekly') {
        try {
          assertTimeZone(input.spec.timeZone);
        } catch {
          throw new AthanorError('invalid_time_zone', 'Choose a valid IANA time zone');
        }
      }
      // No occurrence has been served yet, so there is no repeat to guard against - but a first
      // run that falls inside a spring-forward gap is recovered here exactly as a later one is.
      const nextRunAt = advanceScheduleRun(input.spec, null);
      if (!nextRunAt)
        throw new AthanorError('schedule_in_past', 'The one-time schedule must be in the future');
      const workspace = await store.getWorkspace(user.id, input.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (['failed', 'deleting'].includes(workspace.status))
        throw new AthanorError('workspace_unavailable', 'Workspace is unavailable');
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      if ((await store.countTaskSchedules(user.id)) >= serverLimits.maxSchedules) {
        throw new AthanorError(
          'schedule_limit',
          `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
        );
      }
      const catalog = await modelsForUser(user);
      const selected = input.modelId
        ? catalog.find((model) => model.id === input.modelId)
        : rankModels(catalog, {
            privacyRoute: input.privacyRoute,
            requiredCapabilities: ['chat', 'tools'],
            requiredModalities: ['text'],
            minContextTokens: 16_000,
            preference: 'balanced',
            taskKind: inferModelTask(input.prompt)
          })[0]?.model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new AthanorError(
          'model_unavailable',
          'The selected cloud model is unavailable for this privacy route'
        );
      }
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title =
        input.title ?? input.prompt.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 160);
      let schedule: TaskScheduleRecord;
      try {
        schedule = await store.createTaskSchedule({
          userId: user.id,
          workspaceId: workspace.id,
          titleCiphertext: encryptJson({ title }, key, `task-title:${workspace.id}`),
          promptCiphertext: encryptJson(
            { prompt: input.prompt },
            key,
            `task-prompt:${workspace.id}`
          ),
          modelId: selected.id,
          privacyRoute: input.privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          spec: input.spec,
          nextRunAt,
          maxSchedules: serverLimits.maxSchedules
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'schedule_limit') {
          throw new AthanorError(
            'schedule_limit',
            `This server supports up to ${serverLimits.maxSchedules} scheduled tasks`
          );
        }
        throw error;
      }
      reply.status(201);
      return privateScheduleResponse(schedule, workspace);
    });
  });

  app.post<{ Params: { scheduleId: string; action: string } }>(
    '/v1/schedules/:scheduleId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = z.enum(['pause', 'resume', 'run']).parse(request.params.action);
        const schedule = await store.getTaskSchedule(user.id, request.params.scheduleId);
        if (!schedule) throw new AthanorError('schedule_not_found', 'Schedule not found');
        const nextRunAt =
          action === 'run'
            ? new Date()
            : action === 'resume'
              ? advanceScheduleRun(schedule.spec, null)
              : null;
        if (action === 'resume' && !nextRunAt) {
          throw new AthanorError(
            'schedule_finished',
            'This one-time schedule has already passed; create a new schedule instead',
            409
          );
        }
        const updated = await store.setTaskScheduleEnabled(
          user.id,
          schedule.id,
          action !== 'pause',
          nextRunAt
        );
        if (!updated) throw new AthanorError('schedule_not_found', 'Schedule not found');
        return privateScheduleResponse(updated);
      });
    }
  );

  app.delete<{ Params: { scheduleId: string } }>(
    '/v1/schedules/:scheduleId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => ({
        deleted: await store.deleteTaskSchedule(user.id, request.params.scheduleId)
      }));
    }
  );

  app.post('/v1/tasks', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateTaskRequest.parse(request.body);
      const workspace = await store.getWorkspace(user.id, input.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      const catalog = await modelsForUser(user);
      const selected = input.modelId
        ? catalog.find((model) => model.id === input.modelId)
        : rankModels(catalog, {
            privacyRoute: input.privacyRoute,
            requiredCapabilities: ['chat', 'tools'],
            requiredModalities: ['text'],
            minContextTokens: 16_000,
            preference: 'balanced',
            taskKind: inferModelTask(input.prompt)
          })[0]?.model;
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== input.privacyRoute
      ) {
        throw new AthanorError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
      }
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const title =
        input.title ?? input.prompt.trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 160);
      const task = await store.createTask({
        userId: user.id,
        workspaceId: workspace.id,
        titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
        modelId: selected.id,
        privacyRoute: input.privacyRoute,
        maxComputeCredits: Math.max(
          input.maxComputeCredits,
          computeAllowanceFor(selected, config.TASK_MAX_STEPS)
        ),
        maxSpendUsd: spendCeilingUsd,
        securityMode: workspace.securityMode,
        promptCiphertext: encryptJson(
          { prompt: input.prompt },
          dataKey,
          `task-prompt:${workspace.id}`
        )
      });
      await store.recordUsage({
        userId: user.id,
        workspaceId: workspace.id,
        taskId: task.id,
        kind: 'task_compute',
        resourceClass: selected.usageClass,
        quantity: input.maxComputeCredits,
        unit: 'credits',
        credits: input.maxComputeCredits,
        state: 'reserved',
        idempotencyKey: `task:${task.id}:reservation`
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'task_created',
        summary: 'Task queued',
        payloadCiphertext: encryptJson(
          {
            model: selected.displayName,
            privacyRoute: selected.privacyRoute,
            budget: input.maxComputeCredits
          },
          dataKey,
          `task-event:${task.id}`
        )
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'user_message',
        summary: 'User message',
        payloadCiphertext: encryptJson({ markdown: input.prompt }, dataKey, `task-event:${task.id}`)
      });
      return taskResponse(task, title);
    });
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/messages', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = ContinueTaskRequest.parse(request.body);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (task.userId !== user.id)
        throw new AthanorError(
          'task_owner_required',
          'Start a new task to continue work created by another team member',
          403
        );
      const activeTask = ['queued', 'planning', 'running', 'awaiting_user', 'paused'].includes(
        task.status
      );
      /**
       * A stopped conversation continues like a finished one.
       *
       * Stop tells the owner "the work so far is kept - send a message to continue from here", and
       * that sentence has to be true: cancelling releases the reservations and ends the run, but
       * the agent state it wrote is intact, so the next message resumes the same conversation
       * rather than silently opening a new one and abandoning what they were reading.
       */
      if (
        !activeTask &&
        !['completed', 'failed', 'awaiting_resource', 'cancelled'].includes(task.status)
      )
        throw new AthanorError(
          'task_not_continuable',
          'This task cannot accept another message; branch it or start a new task',
          409
        );
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
      const privacyRoute = input.privacyRoute ?? task.privacyRoute;
      /**
       * A follow-up brings its own ceiling: the store anchors it to what the task has already
       * spent, so `additionalSpendUsd` is headroom for this turn rather than a new total. The task
       * itself is excluded from the open commitments it is checked against, for the same reason.
       */
      const spendCeilingUsd = await resolveSpendCeiling(user.id, input.maxSpendUsd);
      await assertSpendCeilingAllowed({
        userId: user.id,
        ceilingUsd: spendCeilingUsd,
        taskId: task.id
      });
      const catalog = await modelsForUser(user);
      const selected = catalog.find((model) => model.id === (input.modelId ?? task.modelId));
      if (
        !selected ||
        selected.availability !== 'available' ||
        selected.privacyRoute !== privacyRoute
      )
        throw new AthanorError(
          'model_unavailable',
          'The selected model is not available for this privacy route'
        );
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      if (activeTask) {
        const messageId = randomUUID();
        const queued = await store.enqueueTaskMessage({
          id: messageId,
          taskId: task.id,
          userId: user.id,
          modelId: selected.id,
          privacyRoute,
          maxComputeCredits: Math.max(
            input.maxComputeCredits,
            computeAllowanceFor(selected, config.TASK_MAX_STEPS)
          ),
          maxSpendUsd: spendCeilingUsd,
          resourceClass: selected.usageClass,
          reservationKey: `task:${task.id}:message:${messageId}:reservation`,
          ...(input.interrupt ? { interrupt: true } : {}),
          promptCiphertext: encryptJson(
            { prompt: input.prompt },
            dataKey,
            `task-message:${task.id}`
          ),
          queuedEventCiphertext: encryptJson(
            { markdown: input.prompt, position: task.queuedMessageCount + 1 },
            dataKey,
            `task-event:${task.id}`
          )
        });
        if (!queued)
          throw new AthanorError(
            'task_message_queue_conflict',
            'The task changed while this message was being queued; send it again',
            409
          );
        return privateTaskResponse(queued, workspace);
      }
      if (!task.agentStateCiphertext || task.agentStateCiphertext.aad !== `task-state:${task.id}`)
        throw new AthanorError(
          'task_context_unavailable',
          'This task stopped before a resumable conversation checkpoint was saved',
          409
        );
      const previousState = decryptJson<
        Record<string, unknown> & {
          messages: Array<Record<string, unknown>>;
          step: number;
          credits: number;
          turn?: number;
        }
      >(task.agentStateCiphertext, dataKey);
      if (!Array.isArray(previousState.messages))
        throw new AthanorError('task_context_invalid', 'Task conversation state is invalid');
      const nextTurn = Math.max(0, Number(previousState.turn ?? 0)) + 1;
      const reservationKey = `task:${task.id}:turn:${nextTurn}:reservation`;
      // The same reset the worker's own door performs, from the same function. These two had
      // drifted: this one cleared four fields where that one clears eleven and deletes three, and
      // this is the door an ordinary reply comes through - so the common case was the broken one.
      const nextState = startTurnState(previousState as unknown as Record<string, unknown>, {
        prompt: input.prompt,
        turn: nextTurn,
        reservationKey
      });
      const updated = await store.continueTask({
        id: task.id,
        userId: user.id,
        modelId: selected.id,
        privacyRoute,
        additionalComputeCredits: input.maxComputeCredits,
        additionalSpendUsd: spendCeilingUsd,
        agentStateCiphertext: encryptJson(nextState, dataKey, `task-state:${task.id}`),
        reservationKey,
        resourceClass: selected.usageClass,
        userMessageCiphertext: encryptJson(
          { markdown: input.prompt },
          dataKey,
          `task-event:${task.id}`
        )
      });
      if (!updated)
        throw new AthanorError(
          'task_continue_conflict',
          'This task changed before the follow-up could be queued',
          409
        );
      return privateTaskResponse(updated, workspace);
    });
  });

  const createTaskTrajectory = async (
    user: UserRecord,
    parentId: string,
    input: z.infer<typeof TaskTrajectoryRequest>
  ) => {
    const parent = await store.getTask(user.id, parentId);
    if (!parent) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, parent.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const events = await store.listTaskEvents(parent.id);
    const conversational = events.filter((event) =>
      ['user_message', 'assistant_message'].includes(event.kind)
    );
    const target = conversational.find((event) => event.id === input.eventId);
    if (!target)
      throw new AthanorError(
        'trajectory_point_not_found',
        'Choose a user or assistant message from this task',
        404
      );
    if (input.operation === 'edit' && target.kind !== 'user_message')
      throw new AthanorError('trajectory_point_invalid', 'Only a user message can be edited', 409);
    if (input.operation === 'retry' && target.kind !== 'assistant_message')
      throw new AthanorError(
        'trajectory_point_invalid',
        'Choose an assistant response to retry',
        409
      );

    /**
     * Which of the two the owner asked to rewind.
     *
     * A named checkpoint is honoured as given; omitting it means "whichever one covers this point",
     * which the server resolves and reports back. No checkpoint is a refusal rather than a silent
     * downgrade to a conversation-only fork: an undo that quietly did half of what was asked is
     * the thing this whole mechanism exists to stop.
     */
    const rewindScope: RewindScope = input.rewind ?? 'conversation';
    let restoredCheckpoint: WorkspaceCheckpointRecord | null = null;
    if (rewindScope !== 'conversation') {
      restoredCheckpoint = input.checkpointId
        ? await store.getWorkspaceCheckpoint(user.id, input.checkpointId)
        : await store.checkpointForTaskEvent(user.id, parent.id, target.id);
      if (!restoredCheckpoint || restoredCheckpoint.workspaceId !== workspace.id)
        throw new AthanorError(
          'checkpoint_unavailable',
          'The computer cannot be put back to this point: that turn changed nothing, or its undo point has been cleared',
          409
        );
      if (workspace.status !== 'running')
        throw new AthanorError('workspace_unavailable', 'Workspace is not running');
    }
    /**
     * Restoring is what makes the rewind true, so it happens before anything is written: a failed
     * restore must leave no task claiming a rewind that did not happen.
     */
    let safetySnapshotId: string | null = null;
    const restoreComputer = async (): Promise<void> => {
      if (!restoredCheckpoint) return;
      /*
       * Two things restoring a snapshot has always done, and rewinding the computer never did.
       *
       * The first is refusing while the agent is working. This deletes and rewrites the filesystem
       * under whatever is running: a file being written mid-call lands in a tree that is about to
       * be replaced, and the step continues against a machine that silently became a different one.
       *
       * The second is a way back. Every other destructive act in the product takes a point first;
       * this one asked the owner to choose a past state and then made the present unreachable by
       * any route in the product. The id goes into the transcript note, so the sentence saying what
       * happened also says how to undo it.
       */
      await assertWorkspaceHasNoActiveWork(user.id, workspace.id, {
        refusal:
          'The agent is working on this computer. Stop or pause it before putting its files back.',
        busyStatuses: EXECUTING_STATUSES
      });
      const safety = await store.createWorkspaceSnapshot({
        userId: user.id,
        workspaceId: workspace.id,
        name: `Safety before rewind · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        sizeBytes: 0
      });
      const archived = await runner.request<{ sizeBytes: number }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/snapshots`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ snapshotId: safety.id })
      });
      await store.completeWorkspaceSnapshot(String(safety.id), archived.sizeBytes);
      safetySnapshotId = String(safety.id);
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/checkpoints/${restoredCheckpoint.id}/restore`,
        method: 'POST',
        contentType: 'application/json',
        body: '{}'
      });
    };
    /**
     * `computer` alone is the machine going back while the conversation carries on forward, so it
     * forks nothing: the transcript the owner is reading stays the transcript they are reading,
     * with a note in it saying what happened to the files underneath.
     */
    if (rewindScope === 'computer') {
      await restoreComputer();
      await store.appendTaskEvent({
        taskId: parent.id,
        kind: 'status',
        summary: 'Computer rewound',
        payloadCiphertext: encryptJson(
          {
            filesystemRestored: true,
            restoredCheckpointId: restoredCheckpoint!.id,
            rewoundToEventId: target.id,
            // How to undo the undo. Named in the transcript because that is where somebody looks
            // when they realise the state they just left was the one they wanted.
            safetySnapshotId
          },
          dataKey,
          `task-event:${parent.id}`
        )
      });
      return privateTaskResponse((await store.getTask(user.id, parent.id))!, workspace);
    }

    const copiedEvents = conversational.filter((event) =>
      input.operation === 'branch'
        ? event.sequence <= target.sequence
        : event.sequence < target.sequence
    );
    const eventMarkdown = (event: (typeof conversational)[number]): string => {
      if (!event.payloadCiphertext) return '';
      if (event.payloadCiphertext.aad !== `task-event:${parent.id}`)
        throw new AthanorError(
          'encrypted_event_context',
          'Task event encryption context is invalid'
        );
      return decryptJson<{ markdown?: string }>(event.payloadCiphertext, dataKey).markdown ?? '';
    };
    let inheritedMessages: Array<Record<string, unknown> & { role: string; content: string }> =
      copiedEvents.flatMap((event) => {
        const markdown = eventMarkdown(event);
        return markdown
          ? [
              {
                role: event.kind === 'user_message' ? 'user' : 'assistant',
                content: markdown
              }
            ]
          : [];
      });

    let systemMessages: Array<{ role: string; content: string }> = [];
    if (parent.agentStateCiphertext) {
      if (parent.agentStateCiphertext.aad !== `task-state:${parent.id}`)
        throw new AthanorError('task_context_invalid', 'Task checkpoint context is invalid', 409);
      const parentState = decryptJson<{
        messages?: Array<Record<string, unknown> & { role: string; content: string }>;
      }>(parent.agentStateCiphertext, dataKey);
      systemMessages = Array.isArray(parentState.messages)
        ? parentState.messages.filter(
            (message) =>
              message.role === 'system' &&
              !message.content.startsWith('ACTIVE USER-VISIBLE PLAN') &&
              !message.content.startsWith('CONVERSATION TRAJECTORY')
          )
        : [];
      if (Array.isArray(parentState.messages)) {
        const eventIndexes = new Map<string, number>();
        let nextEvent = 0;
        for (const [messageIndex, message] of parentState.messages.entries()) {
          const expected = conversational[nextEvent];
          if (!expected) break;
          const expectedRole = expected.kind === 'user_message' ? 'user' : 'assistant';
          if (message.role !== expectedRole || message.content !== eventMarkdown(expected))
            continue;
          eventIndexes.set(expected.id, messageIndex);
          nextEvent += 1;
        }
        const targetMessageIndex = eventIndexes.get(target.id);
        const firstMessageIndex = eventIndexes.get(conversational[0]?.id ?? '');
        if (targetMessageIndex !== undefined && firstMessageIndex !== undefined) {
          const end = input.operation === 'branch' ? targetMessageIndex + 1 : targetMessageIndex;
          inheritedMessages = parentState.messages
            .slice(firstMessageIndex, end)
            .filter((message) => message.role !== 'system');
        }
      }
    }
    const editingInitialPrompt =
      input.operation === 'edit' && copiedEvents.length === 0 && target === conversational[0];
    if (!editingInitialPrompt && systemMessages.length === 0)
      throw new AthanorError(
        'task_context_unavailable',
        'This point is available after the task saves its first conversation checkpoint',
        409
      );

    const runsImmediately = input.operation !== 'branch';
    if (runsImmediately && workspace.status !== 'running')
      throw new AthanorError('workspace_unavailable', 'Workspace is not running');
    const maxComputeCredits = runsImmediately ? input.maxComputeCredits : 0;
    let selected: z.infer<typeof ModelRelease> | undefined;
    let reservedCredits = 0;
    // A branch is a copy that does not run, so it commits no money and is not measured against the
    // caps; an edit or a retry starts work immediately and is.
    let spendCeilingUsd: number | null = null;
    if (runsImmediately) {
      selected = (await modelsForUser(user)).find((model) => model.id === parent.modelId);
      if (!selected || selected.availability !== 'available')
        throw new AthanorError('model_unavailable', 'The selected model is not available');
      spendCeilingUsd = await resolveSpendCeiling(
        user.id,
        'maxSpendUsd' in input ? input.maxSpendUsd : undefined
      );
      await assertSpendCeilingAllowed({ userId: user.id, ceilingUsd: spendCeilingUsd });
      reservedCredits = maxComputeCredits;
    }

    const parentTitle = await taskTitle(parent, workspace);
    const editedPrompt = input.operation === 'edit' ? input.prompt : undefined;
    const title = (
      input.operation === 'edit'
        ? `${editedPrompt!.split(/\s+/).slice(0, 9).join(' ')} · edited`
        : `${parentTitle.replace(/\s+· (?:branch|retry|edited)$/, '')} · ${input.operation}`
    ).slice(0, 160);
    const forkId = randomUUID();
    const trajectoryInstruction = {
      role: 'system',
      content:
        rewindScope === 'both'
          ? 'CONVERSATION TRAJECTORY: This is a new, independent path through the conversation. Do not assume that later messages or decisions from the source path still apply. The machine has been put back to how it was at this point, so any file, install or process state you remember from after it no longer exists; work from what is there now.'
          : 'CONVERSATION TRAJECTORY: This is a new, independent path through the conversation. Do not assume that later messages or decisions from the source path still apply. The machine is shared with the source and was not rewound, so inspect current files and application state before changing them; rolling the chat back does not restore the filesystem.'
    };
    const trajectoryMessages = [
      ...systemMessages,
      ...inheritedMessages,
      ...(editedPrompt ? [{ role: 'user', content: editedPrompt }] : []),
      trajectoryInstruction
    ];
    const agentStateCiphertext = editingInitialPrompt
      ? null
      : encryptJson(
          { messages: trajectoryMessages, step: 0, credits: 0, turn: 0 },
          dataKey,
          `task-state:${forkId}`
        );
    const prompt =
      editedPrompt ??
      (input.operation === 'retry'
        ? ([...inheritedMessages].reverse().find((message) => message.role === 'user')?.content ??
          'Retry the preceding user request.')
        : 'Continue from this conversation branch.');
    await restoreComputer();
    const fork = await store.createTaskBranch({
      id: forkId,
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: target.id,
      forkKind: input.operation,
      titleCiphertext: encryptJson({ title }, dataKey, `task-title:${workspace.id}`),
      modelId: selected?.id ?? parent.modelId,
      privacyRoute: parent.privacyRoute,
      securityMode: parent.securityMode,
      status: runsImmediately ? 'queued' : 'completed',
      maxComputeCredits: reservedCredits,
      maxSpendUsd: spendCeilingUsd,
      promptCiphertext: encryptJson({ prompt }, dataKey, `task-prompt:${workspace.id}`),
      agentStateCiphertext,
      rewindScope,
      restoredCheckpointId: restoredCheckpoint?.id ?? null
    });
    if (runsImmediately && selected) {
      await store.recordUsage({
        userId: user.id,
        workspaceId: workspace.id,
        taskId: fork.id,
        kind: 'task_compute',
        resourceClass: selected.usageClass,
        quantity: reservedCredits,
        unit: 'credits',
        credits: reservedCredits,
        state: 'reserved',
        idempotencyKey: `task:${fork.id}:reservation`
      });
    }
    await store.appendTaskEvent({
      taskId: fork.id,
      kind: 'task_created',
      summary:
        input.operation === 'branch'
          ? 'Conversation branch ready'
          : input.operation === 'edit'
            ? 'Edited path queued'
            : 'Response retry queued',
      payloadCiphertext: encryptJson(
        {
          parentTaskId: parent.id,
          branchedFromEventId: target.id,
          forkKind: input.operation,
          filesystemRestored: Boolean(restoredCheckpoint),
          restoredCheckpointId: restoredCheckpoint?.id ?? null
        },
        dataKey,
        `task-event:${fork.id}`
      )
    });
    for (const event of copiedEvents) {
      const markdown = eventMarkdown(event);
      if (!markdown) continue;
      await store.appendTaskEvent({
        taskId: fork.id,
        kind: event.kind,
        summary: event.summary,
        payloadCiphertext: encryptJson({ markdown }, dataKey, `task-event:${fork.id}`)
      });
    }
    if (editedPrompt) {
      await store.appendTaskEvent({
        taskId: fork.id,
        kind: 'user_message',
        summary: 'Edited user message',
        payloadCiphertext: encryptJson(
          { markdown: editedPrompt, editedFromEventId: target.id },
          dataKey,
          `task-event:${fork.id}`
        )
      });
    }
    if (
      runsImmediately &&
      input.stopSource &&
      !['completed', 'failed', 'cancelled'].includes(parent.status) &&
      (await store.cancelTaskAndReleaseReservations(user.id, parent.id))
    )
      await store.appendTaskEvent({
        taskId: parent.id,
        kind: 'status',
        summary: 'Source path stopped',
        payloadCiphertext: encryptJson(
          { alternateTaskId: fork.id, forkKind: input.operation },
          dataKey,
          `task-event:${parent.id}`
        )
      });
    return taskResponse(fork, title);
  };

  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/trajectory',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () =>
        createTaskTrajectory(user, request.params.taskId, TaskTrajectoryRequest.parse(request.body))
      );
    }
  );

  /**
   * What rewinding to one point in the transcript would do, asked one point at a time.
   *
   * There is deliberately no second route listing a conversation's checkpoints. It would answer a
   * coarser version of the same question - a checkpoint may be pruned between the listing and the
   * restore, and a listing cannot say what a restore would change - and the dialog that asks this
   * one is the only thing that ever needed an answer.
   */
  app.get<{ Params: { taskId: string }; Querystring: { eventId?: string } }>(
    '/v1/tasks/:taskId/rewind-preview',
    async (request) => {
      const user = requireUser(request.user);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      const events = await store.listTaskEvents(task.id);
      const eventId =
        request.query.eventId ??
        events.filter((event) => ['user_message', 'assistant_message'].includes(event.kind)).at(-1)
          ?.id;
      const target = events.find((event) => event.id === eventId);
      if (!target)
        throw new AthanorError(
          'trajectory_point_not_found',
          'Choose a user or assistant message from this task',
          404
        );
      const checkpoint = await store.checkpointForTaskEvent(user.id, task.id, target.id);
      let computer: CheckpointRestorePreview | null = null;
      if (checkpoint) {
        // A preview that cannot be produced is not a failed request: the owner is told the
        // computer cannot be rewound to that point, which is a real answer to what they asked.
        computer = await runner
          .request<CheckpointRestorePreview>({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/checkpoints/${checkpoint.id}/preview`
          })
          .catch((error: unknown) => {
            log.warn('checkpoint.preview_failed', {
              checkpointId: checkpoint.id,
              ...errorFields(error)
            });
            return null;
          });
      }
      const preview: TaskRewindPreview = {
        taskId: task.id,
        eventId: target.id,
        droppedEventCount: events.filter((event) => event.sequence > target.sequence).length,
        checkpoint: checkpoint ? checkpointResponse(checkpoint) : null,
        computer
      };
      return preview;
    }
  );

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/branch', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = BranchTaskRequest.parse(request.body ?? {});
      const parent = await store.getTask(user.id, request.params.taskId);
      if (!parent) throw new AthanorError('task_not_found', 'Task not found');
      const events = await store.listTaskEvents(parent.id);
      const eventId =
        input.eventId ??
        events.filter((event) => ['user_message', 'assistant_message'].includes(event.kind)).at(-1)
          ?.id;
      if (!eventId)
        throw new AthanorError('trajectory_point_not_found', 'No message is available to branch');
      // This route branches the conversation and leaves the computer where the agent left it,
      // which is what it has always done; rewinding the workspace is asked for explicitly.
      return createTaskTrajectory(user, parent.id, {
        operation: 'branch',
        eventId,
        rewind: 'conversation'
      });
    });
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request) => {
    const task = await store.getTask(requireUser(request.user).id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    return privateTaskResponse(task);
  });

  app.patch<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateTaskRequest.parse(request.body ?? {});
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      let current = task;
      if (input.pinned !== undefined || input.archived !== undefined) {
        const filed = await store.updateTaskFiling(user.id, task.id, {
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          ...(input.archived === undefined ? {} : { archived: input.archived })
        });
        if (!filed) throw new AthanorError('task_not_found', 'Task not found');
        current = filed;
      }
      if (input.title === undefined) return privateTaskResponse(current, workspace);
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const renamed = await store.renameTask(
        user.id,
        task.id,
        encryptJson({ title: input.title }, key, `task-title:${workspace.id}`)
      );
      if (!renamed) throw new AthanorError('task_not_found', 'Task not found');
      return taskResponse(renamed, input.title);
    });
  });

  app.delete<{ Params: { taskId: string } }>('/v1/tasks/:taskId', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (['queued', 'planning', 'running'].includes(task.status))
        throw new AthanorError('task_active', 'Stop this task before deleting it', 409);
      return { deleted: await store.deleteTask(user.id, task.id) };
    });
  });

  /**
   * Device enrollment.
   *
   * The ticket is a connection ticket in the one shape a client can read - the shape the installer
   * prints for the first device, down to the version number and the field the one-time code
   * travels in. The endpoint set and the pinned identity go with the grant, which is what lets the
   * new device verify it is talking to this server rather than to whoever answered that address.
   *
   * It carried its own spelling until now - version 1, the code under a name of its own, no
   * expiry - and the client rejects unknown fields, so the ticket the settings screen has been
   * drawing as a QR code could not be imported by anything. The expiry is the grant's, in whole
   * seconds since the epoch, so a client can say "this link has expired" instead of failing at the
   * server.
   */
  app.post('/v1/devices/enrollments', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({ label: z.string().trim().min(1).max(60).default('New device') })
        .parse(request.body ?? {});
      const token = randomBytes(32).toString('base64url');
      const enrollment = await store.createDeviceEnrollment({
        userId: user.id,
        tokenHash: sha256(token),
        label: input.label,
        ...(request.cookies[sessionCookieName(config.PUBLIC_APP_URL.startsWith('https://'))]
          ? {
              issuedBySession: sha256(
                request.cookies[
                  sessionCookieName(config.PUBLIC_APP_URL.startsWith('https://'))
                ] as string
              )
            }
          : {}),
        // Short enough that a photographed screen stops being useful quickly; long enough to walk
        // to another room and finish a passkey ceremony.
        expiresAt: new Date(Date.now() + 10 * 60_000)
      });
      const connection = await connectionManifest();
      const ticket = Buffer.from(
        JSON.stringify({
          version: CONNECTION_TICKET_VERSION,
          endpoints: withRelayEndpoint(connection.endpoints, relay.publicHostname()),
          identity: connection.identity,
          // A manifest written before the watcher recorded discovery carries none; the service and
          // port are fixed for the whole product, so the ticket states them rather than omitting a
          // field the client requires.
          discovery: {
            mdnsService: connection.discovery?.mdnsService ?? MDNS_SERVICE,
            mdnsPort: connection.discovery?.mdnsPort ?? MDNS_PORT
          },
          pairingCode: token,
          expiresAt: Math.floor(new Date(enrollment.expiresAt).getTime() / 1000)
        })
      ).toString('base64url');
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'device_enrollment_created',
        outcome: 'completed',
        metadata: { enrollmentId: enrollment.id }
      });
      return {
        id: enrollment.id,
        expiresAt: enrollment.expiresAt,
        uri: `athanor://pair/${ticket}`,
        /**
         * The same grant as an address a camera can open.
         *
         * `athanor://` is what the native client registers, and it is the right thing to hand a
         * native client — but it is the wrong thing to put in a QR code, because the device being
         * added is by definition one that has nothing installed yet. Pointing a phone at that code
         * did nothing at all. This is an ordinary link to this box, so any camera opens it, and the
         * ticket rides in the fragment where it never appears in a request line or an access log.
         */
        webUri: `${config.PUBLIC_APP_URL.replace(/\/+$/, '')}/#pair=${ticket}`
      };
    });
  });

  app.get('/v1/devices/enrollments', async (request) =>
    store.listDeviceEnrollments(requireUser(request.user).id)
  );

  app.delete<{ Params: { enrollmentId: string } }>(
    '/v1/devices/enrollments/:enrollmentId',
    async (request) => {
      const user = requireUser(request.user);
      return {
        revoked: await store.revokeDeviceEnrollment(
          user.id,
          z.string().uuid().parse(request.params.enrollmentId)
        )
      };
    }
  );

  /**
   * The relay: off, and for most owners that is the right answer.
   *
   * A box on a public address, or one with a dynamic-DNS name, is reached directly and needs none
   * of this. The relay exists for a box behind carrier-grade NAT, and turning it on is two
   * deliberate acts - a hostname and an enrollment token - because it puts a third party in the
   * path of every connection. There is no default relay and nothing here contacts anyone until an
   * owner names one.
   */
  /**
   * What the box knows is wrong with itself, said where the owner is already looking.
   *
   * The certificate helper and the dynamic DNS helper each write a timestamped reason when they
   * fail, and nothing read either file. Renewal starts about thirty days before expiry, so a
   * failing certificate had a month in which the app was reachable, could have said what happened
   * and offered the command, and instead said nothing at all - until it expired, at which point
   * every device refused at once and the only way to find out why was a shell.
   *
   * Read-only, and deliberately thin: it reports what the box already wrote down rather than
   * running probes of its own. `athanor doctor` remains the fuller account for somebody who is
   * already at a terminal.
   */
  app.get('/v1/instance/diagnostics', async (request) => {
    requireUser(request.user);
    const read = async (name: string): Promise<{ failedAt: string; reason: string } | null> => {
      try {
        const [failedAt, ...rest] = (
          await readFile(join(config.ATHANOR_STATE_PATH, name), 'utf8')
        ).split('\n');
        const reason = rest.join('\n').trim();
        return failedAt?.trim() ? { failedAt: failedAt.trim(), reason } : null;
      } catch {
        // Absent is the healthy answer: both helpers delete their file on the next success.
        return null;
      }
    };
    const [certificate, dynamicDns] = await Promise.all([
      read('certificate.error'),
      read('ddns.error')
    ]);
    return { certificate, dynamicDns };
  });

  app.get('/v1/relay', async (request) => {
    requireUser(request.user);
    return relay.report();
  });

  app.post('/v1/relay/enrollment', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({
          // A relay is named, never addressed: the label lives under this domain and the
          // certificate the box will hold is for a name.
          host: z
            .string()
            .trim()
            .toLowerCase()
            .min(3)
            .max(253)
            .regex(
              /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
              'Use the relay’s hostname, such as relay.example.com'
            )
            // A dotted quad passes the shape above; the label the relay derives lives under this
            // domain and the certificate the box will hold is for a name, so an address never works.
            .refine(
              (value) => !isAddressLiteral(value),
              'Use the relay’s hostname, not an address'
            ),
          token: z.string().trim().min(8).max(500),
          // For a relay whose DNS the owner would rather not depend on. The relay still routes on
          // the name, so this only decides where the connection is opened.
          address: z.string().trim().min(1).max(255).nullish(),
          port: z.number().int().min(1).max(65_535).optional()
        })
        .parse(request.body ?? {});
      try {
        const report = await relay.enroll({
          host: input.host,
          token: input.token,
          address: input.address ?? null,
          ...(input.port === undefined ? {} : { port: input.port })
        });
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'relay_enrolled',
          outcome: 'completed'
        });
        return report;
      } catch (error) {
        // The relay wrote this text, so it is bounded before it is shown; it is the only place an
        // owner learns that a token was already used or has expired.
        throw new AthanorError(
          'relay_enrollment_failed',
          error instanceof Error
            ? redactText(error.message).slice(0, 200)
            : 'The relay refused this enrollment',
          422
        );
      }
    });
  });

  app.patch('/v1/relay', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const input = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    if (input.enabled && !relay.settings.label) {
      throw new AthanorError('relay_not_enrolled', 'Enroll with a relay before turning it on', 422);
    }
    const report = input.enabled ? await relay.enable() : await relay.disable();
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: input.enabled ? 'relay_enabled' : 'relay_disabled',
      outcome: 'completed'
    });
    return report;
  });

  /** Forgets the enrollment. The identity key stays, so re-enrolling keeps the same address. */
  app.delete('/v1/relay', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const report = await relay.forget();
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'relay_disabled',
      outcome: 'completed'
    });
    return report;
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const plan = await store.getLatestTaskPlan(task.id);
    return plan ? privateTaskPlanResponse(plan, workspace) : null;
  });

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plans', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    return Promise.all(
      (await store.listTaskPlans(task.id)).map((plan) => privateTaskPlanResponse(plan, workspace))
    );
  });

  app.post<{ Params: { taskId: string } }>('/v1/tasks/:taskId/plan', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    if (['completed', 'failed', 'cancelled'].includes(task.status))
      throw new AthanorError(
        'invalid_task_state',
        'A finished task plan is immutable; branch by starting a new task',
        409
      );
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const input = UpdateTaskPlanRequest.parse(request.body);
    const steps: TaskPlanStep[] = input.steps.map((step) => ({
      id: step.id ?? randomUUID(),
      title: step.title,
      status: step.status ?? 'pending'
    }));
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    let created;
    try {
      created = await store.createTaskPlan({
        taskId: task.id,
        expectedVersion: input.expectedVersion,
        ...(input.parentVersion ? { parentVersion: input.parentVersion } : {}),
        branchName: input.branchName,
        stepsCiphertext: encryptJson(
          { steps, branchName: input.branchName },
          key,
          `task-plan:${task.id}`
        ),
        createdBy: 'user'
      });
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'plan_version_conflict')
        throw new AthanorError(
          'plan_version_conflict',
          'The plan changed on another device; reload before saving',
          409
        );
      throw cause;
    }
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'plan',
      summary: 'Encrypted user plan event',
      payloadCiphertext: encryptJson(
        {
          __athanorEventVersion: 1,
          summary: `Plan updated to version ${created.version}`,
          payload: {
            planId: created.id,
            version: created.version,
            branchName: input.branchName,
            steps
          }
        },
        key,
        `task-event:${task.id}`
      )
    });
    return privateTaskPlanResponse(created, workspace);
  });

  /**
   * A window onto one conversation's trajectory, always oldest first.
   *
   * `after` reads forward from a cursor, which is what a poll resumes with. `before` reads the
   * page immediately preceding a sequence, which is how a reader walks back into history. `limit`
   * on its own asks for the newest N, which is what opening an hour-long conversation wants
   * instead of every frame ever recorded. Naming none of the three still returns everything, so
   * an export or a sync reads the whole trajectory as it always has. A backwards page shorter
   * than `limit` is the beginning of the conversation.
   */
  app.get<{
    Params: { taskId: string };
    Querystring: { after?: string; before?: string; limit?: string };
  }>('/v1/tasks/:taskId/events', async (request) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new AthanorError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found');
    const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const query = TaskEventWindowQuery.parse(request.query);
    const records =
      query.before !== undefined
        ? (
            await store.listTaskEventPage(task.id, {
              before: query.before,
              limit: query.limit ?? 200
            })
          ).events
        : query.limit === undefined
          ? await store.listTaskEvents(task.id, query.after ?? 0)
          : query.after === undefined
            ? (await store.listRecentTaskEvents(task.id, query.limit)).events
            : (await store.listTaskEventPage(task.id, { after: query.after, limit: query.limit }))
                .events;
    return records.map((event): TaskEvent => {
      const revealed = revealedTaskEvent(
        event.summary,
        event.payloadCiphertext
          ? decryptJson(event.payloadCiphertext, dataKey, `task-event:${task.id}`)
          : undefined
      );
      return {
        id: event.id,
        taskId: event.taskId,
        sequence: event.sequence,
        kind: event.kind,
        summary: revealed.summary,
        ...(revealed.payload === undefined ? {} : { payload: revealed.payload }),
        createdAt: event.createdAt
      };
    });
  });

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>(
    '/v1/tasks/:taskId/events/stream',
    async (request, reply) => {
      const user = requireUser(request.user);
      // Which credential opened this stream, so it can be re-checked while it is still open. A
      // session's own revocation already closes it - the cookie stops resolving on the next
      // request - but this connection makes no further requests, and a bearer token was checked
      // only at the moment it began.
      const streamToken = request.apiToken?.id ?? null;
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      const dataKey = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const lastEventId = Array.isArray(request.headers['last-event-id'])
        ? request.headers['last-event-id'][0]
        : request.headers['last-event-id'];
      let cursor = Math.max(
        0,
        Number(request.query.after ?? 0) || 0,
        Number(lastEventId ?? 0) || 0
      );
      let sending = false;
      let resend = false;
      let closed = false;
      let idleTerminalChecks = 0;
      const streams = openEventStreams.get(user.id) ?? new Map<number, () => void>();
      openEventStreams.set(user.id, streams);
      // A phone that went to sleep holds its half of the connection until TCP notices, which can
      // outlast the walk to the desk. Dropping the oldest is the only outcome that keeps the
      // device in front of the owner working.
      while (streams.size >= maxEventStreamsPerUser) {
        const oldest = streams.keys().next();
        if (oldest.done) break;
        const closeOldest = streams.get(oldest.value);
        streams.delete(oldest.value);
        closeOldest?.();
      }
      const streamId = (nextEventStreamId += 1);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'private, no-cache, no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      reply.raw.flushHeaders();

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(streamId);
        if (streams.size === 0) openEventStreams.delete(user.id);
        if (!reply.raw.destroyed) reply.raw.end();
      };
      const send = async () => {
        if (closed) return;
        // A signal that lands mid-read is remembered rather than dropped, so the frame it was
        // announcing is never left sitting in the table until the next safety-net tick.
        if (sending) {
          resend = true;
          return;
        }
        sending = true;
        try {
          const records = await store.listTaskEvents(task.id, cursor);
          for (const event of records) {
            const revealed = revealedTaskEvent(
              event.summary,
              event.payloadCiphertext
                ? decryptJson(event.payloadCiphertext, dataKey, `task-event:${task.id}`)
                : undefined
            );
            const response: TaskEvent = {
              id: event.id,
              taskId: event.taskId,
              sequence: event.sequence,
              kind: event.kind,
              summary: revealed.summary,
              ...(revealed.payload === undefined ? {} : { payload: revealed.payload }),
              createdAt: event.createdAt
            };
            reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(response)}\n\n`);
            cursor = event.sequence;
          }
          // Re-read through the caller's own access scope so a revoked membership ends the stream
          // instead of leaking events for the rest of the connection's life.
          /*
           * A revoked token stops being able to read part-way through, not only at the next
           * request. This stream is opened once and then lives for as long as the task does, so
           * revoking a token the owner no longer trusts left it reading every event of every
           * conversation until the task finished - which for a long job is hours after they
           * pressed the button and believed they had cut it off.
           */
          if (streamToken) {
            const stillValid = (await store.listApiTokens(user.id)).some(
              (candidate) => candidate.id === streamToken
            );
            if (!stillValid) {
              close();
              return;
            }
          }
          const latest = await store.getTask(user.id, task.id);
          if (!latest) {
            close();
            return;
          }
          if (['completed', 'failed', 'cancelled'].includes(latest.status)) {
            idleTerminalChecks = records.length === 0 ? idleTerminalChecks + 1 : 0;
            if (idleTerminalChecks >= 2) {
              reply.raw.write(
                `event: terminal\ndata: ${JSON.stringify({ status: latest.status })}\n\n`
              );
              close();
            }
          } else {
            idleTerminalChecks = 0;
          }
        } catch (error) {
          // The client sees the stream drop and reconnects, so the only record that the timeline
          // stopped because a read or a decrypt failed is this one.
          log.warn('events.stream_failed', { taskId: task.id, ...errorFields(error) });
          close();
        } finally {
          sending = false;
        }
        if (resend && !closed) {
          resend = false;
          await send();
        }
      };
      /**
       * The stream is fed by the write itself; the timer behind it is a safety net for the window
       * where a notification connection is re-establishing, and for the terminal check. Before
       * this, delivery was the timer, which put up to a second between the agent producing text
       * and the owner seeing it - and delivered several 400 ms flushes in one lump when it fired.
       */
      const unsubscribe = store.onTaskEvent(task.id, () => void send());
      const timer = setInterval(() => void send(), 1_000);
      timer.unref();
      // Proxies and sleeping phones both leave a connection that looks open and is not. A comment
      // frame is the cheapest thing that makes the socket fail, which is what releases the slot.
      const heartbeat = setInterval(() => {
        if (!closed && !reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
      }, 20_000);
      heartbeat.unref();
      streams.set(streamId, close);
      reply.raw.on('close', close);
      reply.raw.write(': connected\n\n');
      await send();
      return reply;
    }
  );

  app.post<{ Params: { taskId: string; action: string } }>(
    '/v1/tasks/:taskId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = request.params.action;
        if (!['pause', 'resume', 'cancel'].includes(action))
          throw new AthanorError('invalid_action', 'Unsupported task action');
        const task = await store.getTask(user.id, request.params.taskId);
        if (!task) throw new AthanorError('task_not_found', 'Task not found');
        if (['completed', 'failed', 'cancelled'].includes(task.status))
          throw new AthanorError('invalid_task_state', 'A finished task cannot be changed', 409);
        if (
          action === 'resume' &&
          !(resumableTaskStatuses as readonly string[]).includes(task.status)
        )
          throw new AthanorError(
            'invalid_task_state',
            'Only paused or resource-waiting tasks can be resumed',
            409
          );
        const status = action === 'pause' ? 'paused' : 'queued';
        if (action === 'cancel') await store.cancelTaskAndReleaseReservations(user.id, task.id);
        else await store.setTaskStatusForUser(user.id, task.id, status);
        log.info('task.action', { taskId: task.id, userId: user.id, kind: action, status });
        return privateTaskResponse((await store.getTask(user.id, task.id))!);
      });
    }
  );

  app.patch<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/security-mode',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateSecurityModeRequest.parse(request.body);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new AthanorError('task_not_found', 'Task not found');
      if (task.userId !== user.id)
        throw new AthanorError(
          'task_owner_required',
          'Only the task owner can change its security mode',
          403
        );
      /*
       * No second factor for choosing how much this run asks.
       *
       * Loosening used to demand a passkey inside the last five minutes, so in practice moving a
       * conversation to Autonomous meant a fingerprint every single time - on the setting whose
       * entire purpose is to be interrupted less. The session is already bound to a passkey; asking
       * again buys almost nothing here, because an attacker holding it can send tasks anyway, and
       * it costs the owner the one control they reach for most.
       *
       * Step-up stays where it protects something that cannot be undone by changing a setting
       * back: the provider credential, and raising a spending ceiling.
       */
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateTaskSecurityMode(user.id, task.id, input.securityMode);
        if (!updated) throw new AthanorError('task_not_found', 'Task not found');
        const workspace = await store.getWorkspace(user.id, task.workspaceId);
        if (workspace?.wrappedKey) {
          const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
          await store.appendTaskEvent({
            taskId: task.id,
            kind: 'status',
            summary: 'Security mode changed',
            payloadCiphertext: encryptJson(
              { securityMode: input.securityMode },
              key,
              `task-event:${task.id}`
            )
          });
        }
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'task_security_mode_changed',
          outcome: 'succeeded',
          metadata: { taskId: task.id, securityMode: input.securityMode }
        });
        return privateTaskResponse(updated, workspace ?? undefined);
      });
    }
  );

  /**
   * The provider this box will actually call for one account, and where that answer came from.
   *
   * The owner's own connection is held encrypted in the database and is what a running install
   * uses. The environment is the fallback a development checkout and a first start rely on, and
   * `configured` is false when neither carries enough to make a call - which is a state every
   * caller has to handle, because it is what a box looks like before Settings has been opened.
   *
   * There was a second copy of this inside the transcription route, resolving the same credential
   * with its own idea of the environment fallback. Two of them is one too many for the object that
   * decides which company sees the owner's words.
   */
  const inferenceCredential = async (
    userId: string
  ): Promise<{
    secret: InferenceSecret;
    source: 'encrypted_database' | 'server_environment';
    configured: boolean;
  }> => {
    const saved = await store.getManagedProviderCredential(userId, 'inference');
    if (saved?.status === 'active')
      return {
        secret: decryptJson<InferenceSecret>(
          saved.secretCiphertext,
          masterKey,
          inferenceCredentialAad(userId)
        ),
        source: 'encrypted_database',
        configured: true
      };
    const apiKey = config.AI_API_KEY ?? config.OPENROUTER_API_KEY;
    return {
      secret: {
        provider: config.AI_PROVIDER,
        baseUrl: config.AI_BASE_URL,
        ...(apiKey ? { apiKey } : {}),
        ...(config.AI_DEFAULT_MODEL ? { modelId: config.AI_DEFAULT_MODEL } : {}),
        enforceZeroDataRetention: config.AI_REQUIRE_ZDR
      },
      source: 'server_environment',
      configured: Boolean(
        apiKey || (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL)
      )
    };
  };

  /**
   * Where this box's web searches are answered.
   *
   * One verdict, not two. This used to publish an answer per privacy route, on the reasoning that
   * an owner should be told what choosing a route would mean before they chose it - but no box ever
   * offered that choice. A model's privacy route is set from the credential's retention flag and a
   * task may only run on a model whose route matches its own, so every conversation on a given box
   * is on the same route, and the second heading described a conversation that could not be started
   * here. Where a query goes is a fact about the box, so it is reported as one.
   *
   * The verdict itself is not computed here: `resolveWebToolPlan` in @athanor/contracts is the only
   * place in this repository that decides it, so the sentence on the settings page and the tools
   * that go on the wire cannot come from two different opinions.
   *
   * Only the verdict is published. The plan also carries the tool names that route would send and
   * withdraw, which are the worker's business and not an owner's: what an owner is owed here is
   * where their queries go and what decided it.
   *
   * The answer carries no `startedMode`, and that is the difference between this question and the
   * one a running task asks. The settings page asks what a conversation started now would do; a
   * task already in flight is additionally held to the mode it started on, so a credential edited
   * mid-run cannot move that task onto the provider's search behind the owner's back.
   */
  const webSearchRoute = (secret: { provider: string }) => {
    const { mode, reason, disclosure } = resolveWebToolPlan({
      provider: secret.provider,
      forceInHouse: config.AI_FORCE_INHOUSE_WEB
    });
    return { mode, reason, disclosure };
  };

  /**
   * The same verdict, for a client that has not asked for the provider settings.
   *
   * Every screen that can start a conversation needs this, so it travels in the first response the
   * client gets rather than costing a second request that most sessions would make and few would
   * use.
   *
   * A credential that cannot be read answers with the deployment's own configured provider, which
   * is the only thing left that is true about this box. The retention flag used to be read here as
   * well, and an unreadable one was assumed to be on; it is no longer part of this question, so
   * there is no longer a privacy fact to be cautious about on the way past.
   */
  const webSearchRouteFor = async (userId: string) => {
    try {
      return webSearchRoute((await inferenceCredential(userId)).secret);
    } catch {
      return webSearchRoute({ provider: config.AI_PROVIDER });
    }
  };

  const providerSettings = async (userId: string) => {
    const { secret, source, configured } = await inferenceCredential(userId);
    if (source === 'encrypted_database') {
      return {
        configured: true,
        source,
        provider: secret.provider,
        baseUrl: secret.baseUrl,
        modelId: secret.modelId ?? null,
        hasApiKey: Boolean(secret.apiKey),
        enforceZeroDataRetention: secret.enforceZeroDataRetention,
        webSearch: webSearchRoute(secret)
      };
    }
    return {
      configured,
      source: 'server_environment' as const,
      provider: config.AI_PROVIDER,
      baseUrl: config.AI_BASE_URL,
      modelId: config.AI_DEFAULT_MODEL ?? null,
      hasApiKey: Boolean(config.AI_API_KEY ?? config.OPENROUTER_API_KEY),
      enforceZeroDataRetention: config.AI_REQUIRE_ZDR,
      webSearch: webSearchRoute({ provider: config.AI_PROVIDER })
    };
  };

  app.get('/v1/providers', async (request) => providerSettings(requireUser(request.user).id));

  /**
   * One naming call, on the model the conversation itself ran on.
   *
   * Every reason to answer null is a reason not to name this conversation yet rather than a
   * failure: no provider connected, a model that has left the catalogue or lost its route, or a
   * catalogue entry that belongs to a provider this box is not connected to. The route is checked
   * against the one the conversation was started under, so a model that has since been reclassified
   * cannot quietly carry the request somewhere the owner did not agree to.
   */
  const titleCompletion = async (input: {
    userId: string;
    modelId: string;
    privacyRoute: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<TitleCompletion | null> => {
    const { secret, configured } = await inferenceCredential(input.userId);
    if (!configured) return null;
    const model = (await store.listModels())
      .map((record) => ModelRelease.parse(record))
      .find((candidate) => candidate.id === input.modelId);
    if (!model || model.availability !== 'available' || model.privacyRoute !== input.privacyRoute)
      return null;
    if (model.provider !== (secret.provider === 'openrouter' ? 'openrouter' : 'custom'))
      return null;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: secret.baseUrl,
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      provider: model.provider,
      privacyRoute: model.privacyRoute,
      appUrl: config.PUBLIC_APP_URL,
      appTitle: 'athanor',
      enforceZeroDataRetention: secret.provider === 'openrouter' && secret.enforceZeroDataRetention
    });
    const response = await adapter.chat({
      model: model.providerModelId,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: input.prompt }
      ],
      tools: [],
      temperature: 0.2,
      // A title is a few words. This is the ceiling that makes a model which decides to explain
      // itself cost the same as one that answers.
      maxTokens: 32,
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000)
    });
    return {
      text: response.text,
      costUsd: response.usage.costUsd ?? 0,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      providerRef: `${model.provider}:${model.providerModelId}`,
      resourceClass: model.usageClass
    };
  };

  app.post('/v1/audio/transcriptions', async (request) => {
    const user = requireUser(request.user);
    const input = z
      .object({
        data: z.string().min(1).max(20_000_000),
        format: z.enum(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'])
      })
      .parse(request.body);
    const { secret } = await inferenceCredential(user.id);
    if (secret.provider !== 'openrouter' || !secret.apiKey)
      throw new AthanorError(
        'transcription_provider_required',
        'Voice transcription currently requires an OpenRouter connection in Settings',
        409
      );
    const baseUrl = secret.baseUrl.replace(/\/$/, '');
    const headers = {
      authorization: `Bearer ${secret.apiKey}`,
      'content-type': 'application/json',
      'http-referer': config.PUBLIC_APP_URL,
      'x-title': 'athanor'
    };
    const catalogUrl = new URL(`${baseUrl}/models`);
    catalogUrl.searchParams.set('output_modalities', 'transcription');
    catalogUrl.searchParams.set('sort', 'top-weekly');
    const catalogResponse = await fetch(catalogUrl, {
      headers,
      signal: AbortSignal.timeout(15_000)
    }).catch(() => undefined);
    if (!catalogResponse?.ok)
      throw new AthanorError(
        'transcription_catalog_unavailable',
        'OpenRouter’s transcription catalog could not be reached',
        503
      );
    const catalog = (await catalogResponse.json()) as { data?: Array<{ id?: string }> };
    const model = catalog.data?.find((entry) => typeof entry.id === 'string')?.id;
    if (!model)
      throw new AthanorError(
        'transcription_model_unavailable',
        'No transcription model is currently available from OpenRouter',
        503
      );
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        input_audio: { data: input.data, format: input.format },
        temperature: 0,
        provider: {
          zdr: true,
          data_collection: 'deny',
          require_parameters: true,
          allow_fallbacks: true
        }
      })
    }).catch(() => undefined);
    if (!response?.ok)
      throw new AthanorError(
        'transcription_failed',
        response?.status === 429
          ? 'The transcription provider is busy or rate-limited; try again shortly'
          : 'No zero-retention transcription route accepted this voice note',
        response?.status === 429 ? 429 : 503
      );
    const result = (await response.json()) as {
      text?: string;
      usage?: {
        seconds?: number;
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
      };
    };
    if (!result.text?.trim())
      throw new AthanorError(
        'transcription_empty',
        'The transcription model did not return any speech',
        422
      );
    return {
      text: result.text.trim(),
      model,
      usage: result.usage ?? null,
      privacyRoute: 'provider_zdr' as const
    };
  });

  app.put('/v1/providers', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const existingCredential = await store.getManagedProviderCredential(user.id, 'inference');
      const existingSecret =
        existingCredential?.status === 'active'
          ? decryptJson<{
              provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
              apiKey?: string;
            }>(existingCredential.secretCiphertext, masterKey, inferenceCredentialAad(user.id))
          : undefined;
      const input = z
        .object({
          provider: z.enum(['openrouter', 'ollama-cloud', 'openai-compatible']),
          baseUrl: z.string().url().optional(),
          apiKey: z.string().max(2_000).optional(),
          modelId: z.string().trim().min(1).max(300).optional(),
          enforceZeroDataRetention: z.boolean().default(true),
          contextTokens: z.number().int().min(4_096).max(10_000_000).default(128_000),
          capabilities: z
            .array(z.enum(['chat', 'vision', 'tools', 'reasoning', 'embedding']))
            .min(1)
            .default(['chat', 'tools', 'reasoning']),
          modalities: z
            .array(z.enum(['text', 'image', 'audio', 'video']))
            .min(1)
            .default(['text'])
        })
        .superRefine((value, context) => {
          if (value.provider !== 'openrouter' && !value.modelId)
            context.addIssue({
              code: 'custom',
              path: ['modelId'],
              message: 'Choose the model ID exposed by this endpoint'
            });
        })
        .parse(request.body);
      const apiKey =
        input.apiKey?.trim() ||
        (existingSecret?.provider === input.provider ? existingSecret.apiKey : undefined) ||
        (config.AI_PROVIDER === input.provider
          ? (config.AI_API_KEY ?? config.OPENROUTER_API_KEY)
          : undefined);
      if (['openrouter', 'ollama-cloud'].includes(input.provider) && !apiKey)
        throw new AthanorError(
          'provider_key_required',
          `${input.provider === 'openrouter' ? 'OpenRouter' : 'Ollama Cloud'} requires an API key`,
          422
        );
      const baseUrl =
        input.provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : input.provider === 'ollama-cloud'
            ? 'https://ollama.com/v1'
            : (input.baseUrl ?? config.AI_BASE_URL);
      const url = new URL(baseUrl);
      if (url.username || url.password || url.search || url.hash)
        throw new AthanorError(
          'provider_url_invalid',
          'Provider URLs cannot contain credentials, query parameters, or fragments'
        );
      const privateHttp =
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' ||
          url.hostname === '127.0.0.1' ||
          url.hostname === '::1' ||
          /^10\./.test(url.hostname) ||
          /^192\.168\./.test(url.hostname) ||
          /^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname));
      if (url.protocol !== 'https:' && !(config.ALLOW_INSECURE_PROVIDER_URLS && privateHttp))
        throw new AthanorError(
          'provider_url_insecure',
          'Use HTTPS, or explicitly allow private HTTP provider URLs on this server'
        );
      /*
       * The key is proven before any of the work below reports success.
       *
       * Everything this route did for an OpenRouter key - `adapter.list()`, then the catalogue
       * refresh's `/models` and `/endpoints/zdr` - is a public route that answers 200 anonymously.
       * So the screen's "Verify and save" verified the provider was reachable and nothing about the
       * credential, and a mistyped or revoked key was stored, encrypted, under a green success
       * message. `/key` is the one call the provider gates, and it is made first so a refusal costs
       * one request and leaves the previously saved credential untouched.
       */
      if (input.provider === 'openrouter')
        await verifyOpenRouterKey({
          baseUrl,
          apiKey: apiKey!,
          ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
        });
      const adapter = new OpenAICompatibleAdapter({
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        provider: input.provider === 'openrouter' ? 'openrouter' : 'custom',
        privacyRoute: input.enforceZeroDataRetention ? 'provider_zdr' : 'external',
        appUrl: config.PUBLIC_APP_URL,
        appTitle: 'athanor',
        enforceZeroDataRetention: input.provider === 'openrouter' && input.enforceZeroDataRetention
      });
      const listed = await adapter.list(AbortSignal.timeout(15_000));
      if (input.provider !== 'openrouter') {
        if (!listed.some((model) => model.id === input.modelId))
          throw new AthanorError(
            'provider_model_not_found',
            `The endpoint did not list model ${input.modelId}`,
            422
          );
        await store.upsertModels([
          {
            id: `custom/${input.modelId}`,
            providerModelId: input.modelId!,
            displayName: input.modelId!,
            provider: 'custom',
            revision: 'provider-managed',
            availability: 'available',
            openness: 'remote_proprietary',
            license: 'Provider-defined',
            commercialUse: true,
            privacyRoute: input.enforceZeroDataRetention ? 'provider_zdr' : 'external',
            contextTokens: input.contextTokens,
            modalities: input.modalities,
            capabilities: input.capabilities,
            usageClass: 'medium',
            recommendationTags: [
              input.provider === 'ollama-cloud' ? 'Ollama Cloud' : 'Configured endpoint'
            ],
            measuredQuality: null,
            measuredLatencyMs: null,
            updatedAt: new Date().toISOString()
          }
        ]);
      } else {
        const liveModels = await refreshOpenRouterCatalog(seedModels(), {
          baseUrl,
          apiKey: apiKey!,
          scope: config.MODEL_CATALOG_SCOPE,
          ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
        });
        await store.upsertModels(liveModels);
      }
      await store.upsertManagedProviderCredential({
        userId: user.id,
        provider: 'inference',
        secretCiphertext: encryptJson(
          {
            provider: input.provider,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(input.modelId ? { modelId: input.modelId } : {}),
            enforceZeroDataRetention: input.enforceZeroDataRetention
          },
          masterKey,
          inferenceCredentialAad(user.id)
        ),
        externalRef: 'self-hosted',
        monthlyLimitUsd: 0,
        status: 'active'
      });
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'inference_provider_configured',
        outcome: 'completed',
        metadata: { provider: input.provider }
      });
      return providerSettings(user.id);
    });
  });

  app.delete('/v1/providers', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => ({
      deleted: await store.deleteManagedProviderCredential(user.id, 'inference')
    }));
  });

  app.get('/v1/models', async (request) => modelsForUser(requireUser(request.user)));
  app.get<{
    Querystring: {
      privacyRoute?: 'provider_zdr' | 'external';
      preference?: 'fast' | 'balanced' | 'best';
      taskKind?: 'general' | 'coding' | 'agentic';
    };
  }>('/v1/models/recommend', async (request) => {
    /*
     * A ranking, which is an order and the reason for it - not another copy of the catalogue.
     *
     * This returned every ranked model in full and came to 324 kB, on top of the 426 kB bootstrap,
     * on every model-preference change. Its only caller maps it to `entry.model.id`. The score and
     * the reasoning stay, because they are the answer to "why this one" and cost almost nothing;
     * what goes is the third copy of a record the client already has enough of.
     */
    const ranked = rankModels(await modelsForUser(requireUser(request.user)), {
      privacyRoute: request.query.privacyRoute ?? 'provider_zdr',
      requiredCapabilities: ['chat', 'tools'],
      requiredModalities: ['text'],
      minContextTokens: 16_000,
      preference: request.query.preference ?? 'balanced',
      taskKind: request.query.taskKind ?? 'general'
    });
    // Reasoning for the head, an order for the tail. Every entry carried seven sentences explaining
    // a placement no interface will ever show for the three-hundredth-best model; what the caller
    // needs from the tail is its position, and what it needs from the front is the argument.
    const EXPLAINED = 8;
    return ranked.map((entry, index) => ({
      modelId: entry.model.id,
      displayName: entry.model.displayName,
      score: entry.score,
      ...(index < EXPLAINED ? { reasons: entry.reasons } : {})
    }));
  });

  app.get('/v1/usage', async (request) => {
    const user = requireUser(request.user);
    const period = currentPeriod();
    const workspaces = await store.listWorkspaces(user.id);
    await Promise.all(workspaces.map(meterWorkspace));
    const totals = await store.usageTotals(user.id, period.start, period.end);
    // Re-read after metering: the records above were fetched before the walk, so summing them
    // reported the figure from the previous visit to this pane rather than the one just measured.
    const storageBytes = (await store.listWorkspaces(user.id)).reduce(
      (sum, item) => sum + item.storageBytes,
      0
    );
    return {
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      totals,
      providerSpend: await providerSpend(user.id),
      storageBytes,
      storageLimitBytes: serverLimits.storageBytes,
      storageThreshold: storageThreshold(storageBytes, serverLimits.storageBytes),
      history: await store.usageHistory(user.id)
    };
  });

  /**
   * Compute credits are a scheduling unit whose dollar value moves with the model class, so they
   * can never answer "stop before this costs me more than X". These three routes are that answer:
   * what the caps are, what has been spent against them, and where it went.
   */
  app.get('/v1/spend-limits', async (request) =>
    store.effectiveSpendLimits(requireUser(request.user).id)
  );

  app.put('/v1/spend-limits', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateSpendLimitsRequest.parse(request.body);
      /*
       * A passkey to loosen the brake, nothing to tighten it.
       *
       * Adding a device needs a passkey and reading an export needs a passkey, while removing the
       * one control standing between the owner and an unbounded provider bill needed only an
       * unlocked browser. Asking on every edit would be friction on a routine adjustment, and the
       * direction is what matters: raising a ceiling or clearing it is the escalation, lowering one
       * cannot hurt. A cap that was null is already unlimited, so setting a number there is a
       * tightening even though it "changes" the value.
       */
      const current = await store.effectiveSpendLimits(user.id);
      const loosens = (was: number | null, next: number | null | undefined): boolean =>
        next !== undefined && (next === null ? was !== null : was !== null && next > was);
      if (
        loosens(current.dailyCapUsd, input.dailyCapUsd) ||
        loosens(current.monthlyCapUsd, input.monthlyCapUsd) ||
        loosens(current.defaultTaskCapUsd, input.defaultTaskCapUsd)
      )
        await requireRecentStepUp(request, user);
      try {
        // An omitted field is left alone and an explicit null clears that cap, so an absent key is
        // forwarded as an absent key rather than as undefined.
        await store.setSpendLimits({
          userId: user.id,
          ...(input.dailyCapUsd !== undefined ? { dailyCapUsd: input.dailyCapUsd } : {}),
          ...(input.monthlyCapUsd !== undefined ? { monthlyCapUsd: input.monthlyCapUsd } : {}),
          ...(input.defaultTaskCapUsd !== undefined
            ? { defaultTaskCapUsd: input.defaultTaskCapUsd }
            : {}),
          ...(input.warnAtPercent !== undefined ? { warnAtPercent: input.warnAtPercent } : {}),
          ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {})
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Unknown IANA time zone'))
          throw new AthanorError('invalid_time_zone', 'Choose a valid IANA time zone');
        throw error;
      }
      return store.effectiveSpendLimits(user.id);
    });
  });

  app.get('/v1/spend', async (request) => store.spendSummary(requireUser(request.user).id));

  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/v1/workspaces/:workspaceId/files',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      const path = encodeURIComponent(request.query.path ?? 'workspace');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/files?path=${path}`
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/export',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      const response = await runner.raw({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/export`
      });
      if (!response.body)
        throw new AthanorError('workspace_export_failed', 'Workspace export stream is unavailable');
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'workspace_export',
        outcome: 'started',
        metadata: { workspaceId: workspace.id }
      });
      return reply
        .type('application/gzip')
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          `attachment; filename="athanor-workspace-${workspace.id}.tar.gz"`
        )
        .send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
    }
  );

  /**
   * Refuses while the computer is in use, for two different meanings of "in use".
   *
   * Changing the set of recovery points asks the wider question: anything not settled might still
   * write, and the owner is doing maintenance rather than working, so waiting is cheap.
   *
   * Rewinding the files asks the narrower one. It is reached from a conversation, and that
   * conversation is almost always `awaiting_user` — it is waiting for the person now clicking the
   * button. Refusing on that would have made "put the computer back" unreachable from the only
   * screen that offers it. What must not happen is the tree being replaced under a step that is
   * running or about to be picked up by a worker.
   */
  const EXECUTING_STATUSES = ['queued', 'planning', 'running'] as const;

  const assertWorkspaceHasNoActiveWork = async (
    userId: string,
    workspaceId: string,
    options?: { refusal?: string; busyStatuses?: readonly string[] }
  ): Promise<void> => {
    const settled = ['paused', 'completed', 'failed', 'cancelled'];
    const busy = options?.busyStatuses
      ? (task: { status: string }) => options.busyStatuses!.includes(task.status)
      : (task: { status: string }) => !settled.includes(task.status);
    const tasks = await store.listTasks(userId, workspaceId);
    if (tasks.some(busy))
      throw new AthanorError(
        'workspace_busy',
        options?.refusal ?? 'Pause or finish every agent task before changing recovery points',
        409
      );
  };

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return store.listWorkspaceSnapshots(user.id, workspace.id);
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { name: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        if (!['running', 'hibernated'].includes(workspace.status)) {
          throw new AthanorError(
            'workspace_unavailable',
            'Recovery points can only be created for a running or hibernated workspace',
            409
          );
        }
        const snapshots = await store.listWorkspaceSnapshots(user.id, workspace.id);
        if (snapshots.length >= serverLimits.maxSnapshots) {
          throw new AthanorError(
            'snapshot_limit',
            `This server keeps up to ${serverLimits.maxSnapshots} recovery points`,
            409
          );
        }
        const previousStatus = workspace.status;
        await meterWorkspace(workspace);
        await store.updateWorkspaceStatus(workspace.id, 'resizing');
        let snapshot: Awaited<ReturnType<DataStore['createWorkspaceSnapshot']>> | undefined;
        try {
          await assertWorkspaceHasNoActiveWork(user.id, workspace.id);
          snapshot = await store.createWorkspaceSnapshot({
            userId: user.id,
            workspaceId: workspace.id,
            name: input.name,
            sizeBytes: 0
          });
          const archived = await runner.request<{ sizeBytes: number }>({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/snapshots`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ snapshotId: snapshot.id })
          });
          await store.completeWorkspaceSnapshot(String(snapshot.id), archived.sizeBytes);
          await recordSecurityEvent(store, {
            userId: user.id,
            kind: 'workspace_snapshot_created',
            outcome: 'completed',
            metadata: { workspaceId: workspace.id, snapshotId: snapshot.id }
          });
          return {
            ...(await store.getWorkspaceSnapshot(user.id, workspace.id, String(snapshot.id))),
            scope: 'workspace_files_and_browser_profile',
            excludes: [
              'task_history',
              'account_metadata',
              'server_settings',
              'mounted_bulk_storage'
            ]
          };
        } catch (error) {
          if (snapshot) await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'failed');
          throw error;
        } finally {
          await store.updateWorkspaceStatus(workspace.id, previousStatus);
        }
      });
    }
  );

  app.delete<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        const snapshot = await store.getWorkspaceSnapshot(
          user.id,
          workspace.id,
          request.params.snapshotId
        );
        if (!snapshot)
          throw new AthanorError('snapshot_not_found', 'Recovery point not found', 404);
        if (snapshot.status === 'creating' || snapshot.status === 'deleting') {
          throw new AthanorError('snapshot_busy', 'This recovery point is still changing', 409);
        }
        await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'deleting');
        const snapshotId = String(snapshot.id);
        try {
          await runner.request({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/snapshots/${snapshotId}`,
            method: 'DELETE'
          });
          await store.deleteWorkspaceSnapshot(user.id, workspace.id, snapshotId);
          await recordSecurityEvent(store, {
            userId: user.id,
            kind: 'workspace_snapshot_deleted',
            outcome: 'completed',
            metadata: { workspaceId: workspace.id, snapshotId: snapshot.id }
          });
          return { deleted: true, id: snapshot.id };
        } catch (error) {
          await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'failed');
          throw error;
        }
      });
    }
  );

  app.post<{
    Params: { workspaceId: string; snapshotId: string };
    Body: { confirmName: string };
  }>('/v1/workspaces/:workspaceId/snapshots/:snapshotId/restore', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ confirmName: z.string() }).parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (input.confirmName !== workspace.name) {
        throw new AthanorError(
          'confirmation_mismatch',
          'Enter the exact computer name to restore this recovery point',
          400
        );
      }
      if (!['running', 'hibernated'].includes(workspace.status)) {
        throw new AthanorError(
          'workspace_unavailable',
          'A restore cannot start while another computer operation is active',
          409
        );
      }
      const target = await store.getWorkspaceSnapshot(
        user.id,
        workspace.id,
        request.params.snapshotId
      );
      if (!target || target.status !== 'ready') {
        throw new AthanorError(
          'snapshot_unavailable',
          'Only a ready recovery point can be restored',
          409
        );
      }
      const snapshots = await store.listWorkspaceSnapshots(user.id, workspace.id);
      if (snapshots.length >= serverLimits.maxSnapshots) {
        throw new AthanorError(
          'snapshot_limit',
          'Delete a recovery point first; restore creates an additional safety point',
          409
        );
      }
      const previousStatus = workspace.status;
      await meterWorkspace(workspace);
      await store.updateWorkspaceStatus(workspace.id, 'resizing');
      let safety: Awaited<ReturnType<DataStore['createWorkspaceSnapshot']>> | undefined;
      let safetyReady = false;
      let destructiveRestoreStarted = false;
      try {
        await assertWorkspaceHasNoActiveWork(user.id, workspace.id);
        safety = await store.createWorkspaceSnapshot({
          userId: user.id,
          workspaceId: workspace.id,
          name: `Safety before restore · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          sizeBytes: 0
        });
        const safetyArchive = await runner.request<{ sizeBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/snapshots`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify({ snapshotId: safety.id })
        });
        await store.completeWorkspaceSnapshot(String(safety.id), safetyArchive.sizeBytes);
        safetyReady = true;
        destructiveRestoreStarted = true;
        const targetId = String(target.id);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/snapshots/${targetId}/restore`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify({
            storageLimitBytes: workspace.storageLimitBytes,
            imageRevision: workspace.imageRevision
          })
        });
        await store.updateWorkspaceStatus(workspace.id, 'running');
        await meterWorkspace({ ...workspace, status: 'running' });
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_snapshot_restored',
          outcome: 'completed',
          metadata: {
            workspaceId: workspace.id,
            snapshotId: target.id,
            safetySnapshotId: safety.id
          }
        });
        return {
          workspace: workspaceResponse((await store.getWorkspace(user.id, workspace.id))!),
          restoredFrom: target.id,
          safetySnapshotId: safety.id,
          scope: 'workspace_files_and_browser_profile',
          excludes: ['task_history', 'account_metadata', 'server_settings', 'mounted_bulk_storage'],
          warning:
            'Artifact and task records remain current; verify file-backed artifacts after restore.'
        };
      } catch (error) {
        if (safety && !safetyReady) {
          await store.setWorkspaceSnapshotStatus(String(safety.id), 'failed');
        }
        await store.updateWorkspaceStatus(
          workspace.id,
          destructiveRestoreStarted ? 'failed' : previousStatus
        );
        throw error;
      }
    });
  });

  app.post<{ Params: { workspaceId: string; action: string } }>(
    '/v1/workspaces/:workspaceId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = z.enum(['hibernate', 'resume']).parse(request.params.action);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        if (action === 'hibernate') await meterWorkspace(workspace);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/${action}`,
          method: 'POST',
          body: '{}',
          contentType: 'application/json'
        });
        await store.updateWorkspaceStatus(
          workspace.id,
          action === 'hibernate' ? 'hibernated' : 'running'
        );
        return workspaceResponse((await store.getWorkspace(user.id, workspace.id))!);
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/heartbeat',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status === 'running') {
        // The client sends this on mount, so it is part of opening the app. The first heartbeat
        // after a restart waits for the walk because nothing else can tell the owner how much room
        // is left; every later one is served from the cache and refreshed behind the response.
        const usage = hostStorageCache.has(workspace.id)
          ? cachedHostStorage(workspace)
          : await meterWorkspace(workspace);
        await store.touchWorkspace(user.id, workspace.id);
        return {
          ok: true,
          status: workspace.status,
          storageBytes: usage?.storageBytes ?? workspace.storageBytes,
          ...(usage ?? {})
        };
      }
      await store.touchWorkspace(user.id, workspace.id);
      return { ok: true, status: workspace.status, storageBytes: workspace.storageBytes };
    }
  );

  const ResizeWorkspaceRequest = z.object({
    storageLimitBytes: z
      .number()
      .int()
      .min(10_000_000_000)
      .max(serverLimits.storageBytes)
      .optional()
  });

  const resizeWorkspace = async (
    user: UserRecord,
    workspaceId: string,
    input: z.infer<typeof ResizeWorkspaceRequest>
  ): Promise<Workspace> => {
    const workspace = await store.getWorkspace(user.id, workspaceId);
    if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
    if (input.storageLimitBytes && input.storageLimitBytes < workspace.storageBytes)
      throw new AthanorError(
        'storage_limit',
        'Remove files until usage is below the smaller storage limit'
      );
    if (input.storageLimitBytes) {
      const allocatedElsewhere = (await store.listWorkspaces(user.id))
        .filter((item) => item.id !== workspace.id)
        .reduce((sum, item) => sum + item.storageLimitBytes, 0);
      if (allocatedElsewhere + input.storageLimitBytes > serverLimits.storageBytes) {
        throw new AthanorError(
          'storage_limit',
          'The requested storage exceeds this server’s configured safety limit'
        );
      }
    }
    await meterWorkspace(workspace);
    await store.updateWorkspaceStatus(workspace.id, 'resizing');
    try {
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/resize`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          storageLimitBytes: input.storageLimitBytes ?? workspace.storageLimitBytes
        })
      });
      await store.updateWorkspaceResources(user.id, workspace.id, input.storageLimitBytes);
      await store.updateWorkspaceStatus(
        workspace.id,
        workspace.status === 'hibernated' ? 'hibernated' : 'running'
      );
      return workspaceResponse((await store.getWorkspace(user.id, workspace.id))!);
    } catch (error) {
      await store.updateWorkspaceStatus(workspace.id, 'failed');
      throw error;
    }
  };

  app.patch<{
    Params: { workspaceId: string };
    Body: { storageLimitBytes?: number };
  }>('/v1/workspaces/:workspaceId', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () =>
      resizeWorkspace(user, request.params.workspaceId, ResizeWorkspaceRequest.parse(request.body))
    );
  });

  app.patch<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/security-mode',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateSecurityModeRequest.parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace || workspace.userId !== user.id)
        throw new AthanorError(
          'workspace_owner_required',
          'Only the workspace owner can change its default security mode',
          403
        );
      // The same reasoning as the per-task route above: this is the setting the owner changes most,
      // and a passkey on it made Autonomous unreachable in practice.
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateWorkspaceSecurityMode(
          user.id,
          workspace.id,
          input.securityMode
        );
        if (!updated) throw new AthanorError('workspace_not_found', 'Workspace not found');
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_security_mode_changed',
          outcome: 'succeeded',
          metadata: { workspaceId: workspace.id, securityMode: input.securityMode }
        });
        return workspaceResponse(updated);
      });
    }
  );

  const workspaceBriefPath = 'workspace/ATHANOR.md';
  const legacyWorkspaceBriefPath = 'workspace/OPEN_CLOUD.md';

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/brief',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      const readBrief = (path: string) =>
        runner.raw({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`,
          acceptAnyStatus: true
        });
      let response = await readBrief(workspaceBriefPath);
      if (response.status === 404) response = await readBrief(legacyWorkspaceBriefPath);
      if (response.status === 404) return { markdown: '', path: workspaceBriefPath };
      if (!response.ok)
        throw new AthanorError(
          'workspace_brief_unavailable',
          `Workspace brief could not be read (${response.status})`,
          502
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 64 * 1024)
        throw new AthanorError(
          'workspace_brief_too_large',
          'Workspace brief exceeds the 64 KB safety limit'
        );
      return { markdown: bytes.toString('utf8'), path: workspaceBriefPath };
    }
  );

  app.put<{ Params: { workspaceId: string }; Body: { markdown: string } }>(
    '/v1/workspaces/:workspaceId/brief',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ markdown: z.string().max(50_000) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        const content = Buffer.from(input.markdown, 'utf8');
        if (workspace.storageBytes + content.byteLength > workspace.storageLimitBytes)
          throw new AthanorError('storage_limit', 'Workspace storage limit reached');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(workspaceBriefPath)}`,
          method: 'PUT',
          body: Uint8Array.from(content).buffer,
          contentType: 'text/markdown; charset=utf-8'
        });
        const usage = await runner.request<{ storageBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`
        });
        await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
        return { markdown: input.markdown, path: workspaceBriefPath };
      });
    }
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      const content = await runner.request<Buffer>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(request.query.path)}`
      });
      return reply.type('application/octet-stream').send(content);
    }
  );

  app.put<{ Params: { workspaceId: string }; Querystring: { path: string }; Body: Buffer }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        if (workspace.storageBytes + request.body.byteLength > workspace.storageLimitBytes)
          throw new AthanorError('storage_limit', 'Workspace storage limit reached');
        const result = await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(request.query.path)}`,
          method: 'PUT',
          body: Uint8Array.from(request.body).buffer,
          contentType: 'application/octet-stream'
        });
        const usage = await runner.request<{ storageBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`
        });
        await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
        return result;
      });
    }
  );

  /** Re-reads the machine's own total after something on it changed size. */
  const remeasureWorkspace = async (workspace: WorkspaceRecord, userId: string): Promise<void> => {
    const usage = await runner.request<{ storageBytes: number }>({
      workspaceId: workspace.id,
      userId,
      role: 'control',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/usage`
    });
    await store.setWorkspaceStorage(userId, workspace.id, usage.storageBytes);
    hostStorageCache.delete(workspace.id);
  };

  app.delete<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(request.query.path)}`,
          method: 'DELETE'
        });
        await remeasureWorkspace(workspace, user.id);
        reply.status(204);
        return null;
      });
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { from: string; to: string } }>(
    '/v1/workspaces/:workspaceId/files/rename',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z
          .object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) })
          .parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        return runner.request<{ path: string }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/files/rename`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      });
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { path: string } }>(
    '/v1/workspaces/:workspaceId/files/folder',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ path: z.string().min(1).max(1024) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        return runner.request<{ path: string }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/files/folder`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { path: string; name?: string; mimeType?: string; taskId?: string };
  }>('/v1/workspaces/:workspaceId/artifacts', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({
          path: z.string().min(1).max(1024),
          name: z.string().min(1).max(255).optional(),
          mimeType: z.string().min(1).max(160).default('application/octet-stream'),
          taskId: z.string().uuid().optional()
        })
        .parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (input.taskId && !(await store.getTask(user.id, input.taskId)))
        throw new AthanorError('task_not_found', 'Task not found');
      const content = await runner.request<Buffer>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(input.path)}`
      });
      if (workspace.storageBytes + content.byteLength > workspace.storageLimitBytes)
        throw new AthanorError('storage_limit', 'Artifact version would exceed workspace storage');
      const storageKey = `.athanor/artifacts/${randomUUID()}`;
      const digest = sha256(content);
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.write'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(storageKey)}`,
        method: 'PUT',
        body: Uint8Array.from(content).buffer,
        contentType: 'application/octet-stream'
      });
      const name = input.name ?? input.path.split('/').filter(Boolean).at(-1) ?? 'artifact';
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const artifact = await store.createArtifact({
        userId: user.id,
        workspaceId: workspace.id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        logicalKey: sha256(input.path),
        nameCiphertext: encryptJson({ name }, key, `artifact-name:${workspace.id}`),
        mimeType: input.mimeType,
        sizeBytes: content.byteLength,
        sha256: digest,
        storageKey
      });
      const usage = await runner.request<{ storageBytes: number }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/usage`
      });
      await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
      return {
        id: artifact.id,
        workspaceId: workspace.id,
        taskId: artifact.task_id ?? null,
        name,
        mimeType: input.mimeType,
        sizeBytes: content.byteLength,
        version: Number(artifact.version),
        sha256: digest,
        createdAt: new Date(String(artifact.created_at)).toISOString()
      };
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/artifacts',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      return (await store.listArtifacts(user.id, workspace.id)).map((artifact) => ({
        id: artifact.id,
        workspaceId: artifact.workspaceId,
        taskId: artifact.taskId,
        name: decryptJson<{ name: string }>(
          artifact.nameCiphertext as Parameters<typeof decryptJson>[0],
          key,
          `artifact-name:${workspace.id}`
        ).name,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        version: artifact.version,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt
      }));
    }
  );

  app.get<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId/content',
    async (request, reply) => {
      const user = requireUser(request.user);
      const artifact = await store.getArtifact(user.id, request.params.artifactId);
      if (!artifact) throw new AthanorError('not_found', 'Artifact not found');
      const workspace = await store.getWorkspace(user.id, String(artifact.workspaceId));
      if (!workspace?.wrappedKey)
        throw new AthanorError('workspace_not_found', 'Workspace not found');
      const content = await runner.request<Buffer>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(String(artifact.storageKey))}`
      });
      if (sha256(content) !== artifact.sha256)
        throw new AthanorError('artifact_integrity_failed', 'Artifact integrity check failed');
      const name = decryptJson<{ name: string }>(
        artifact.nameCiphertext as Parameters<typeof decryptJson>[0],
        unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id),
        `artifact-name:${workspace.id}`
      ).name;
      /*
       * Stored data does not get to choose how the browser treats this response.
       *
       * The type came from `publish_artifact`, whose `mimeType` is a free-form string the agent
       * supplies - and the agent takes instructions, in effect, from any page it reads. Replaying
       * it into `reply.type()` with `content-disposition: inline` meant a poisoned page could have
       * the agent save `text/html` with a script in it, which the owner then opened from the Saved
       * results list as a top-level document on this box's own origin. There is no CSP on /v1/ to
       * catch it, so that script ran with the owner's session against every route it can reach:
       * their transcripts, their files, their connectors, and - inside the five-minute step-up
       * window - a device enrollment that registers an attacker's own passkey for good.
       *
       * `nosniff` does not help when the declared type *is* the dangerous one, so the declaration
       * itself is what has to be constrained. Anything not on this list is handed over as bytes to
       * download rather than as a document to run, and the sandbox header is the same belt the
       * preview gateway already wears for agent-authored pages on this origin.
       */
      const declared = String(artifact.mimeType).toLowerCase().split(';', 1)[0]?.trim() ?? '';
      const inlineSafe = new Set([
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'image/avif',
        'application/pdf',
        'text/plain',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'audio/wav',
        'video/mp4',
        'video/webm'
      ]);
      const renderInline = inlineSafe.has(declared);
      return reply
        .type(renderInline ? declared : 'application/octet-stream')
        .header('x-content-sha256', String(artifact.sha256))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header(
          'content-disposition',
          `${renderInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
        )
        .send(content);
    }
  );

  app.delete<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const artifact = await store.getArtifact(user.id, request.params.artifactId);
        if (!artifact) throw new AthanorError('not_found', 'Artifact not found');
        const workspace = await store.getWorkspace(user.id, String(artifact.workspaceId));
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(String(artifact.storageKey))}`,
          method: 'DELETE'
        });
        await store.deleteArtifact(user.id, request.params.artifactId);
        const usage = await runner.request<{ storageBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`
        });
        await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
        return { deleted: true };
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/snapshot',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['browser.read'],
        path: `/v1/workspaces/${workspace.id}/browser/snapshot`,
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        const action = BrowserAction.parse(request.body);
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['browser.control'],
          path: `/v1/workspaces/${workspace.id}/browser/action`,
          method: 'POST',
          body: JSON.stringify(action),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/browser/holder', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['browser.takeover'],
        path: `/v1/workspaces/${workspace.id}/browser/holder`,
        method: 'POST',
        body: JSON.stringify(request.body),
        contentType: 'application/json'
      });
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/terminal-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        /*
         * A terminal token opens one socket and nothing else, so it is bound to that one request.
         *
         * The lifetime is the session's, not the handshake's. The runner closes the socket when the
         * capability expires - deliberately, so a shell on the box stays revocable - and at sixty
         * seconds that meant every terminal died about a minute in, mid-command, reporting "Session
         * closed" as though that were normal. The token is single-use and bound to this workspace,
         * this owner, the `terminal` scope and this exact path, so a longer life widens the window
         * to open one terminal rather than the blast radius of having one.
         *
         * `MAX_CAPABILITY_TTL_SECONDS` caps this at fifteen minutes, and that cap is right - it is
         * what stops a leaked signing secret minting a token that outlives the leak - so this asks
         * for the most it is allowed rather than the length of a session. Fifteen minutes is not
         * the answer, it is fifteen times the old one. The answer is a renewal frame: the client
         * refreshing shortly before expiry and the runner re-arming its timer, which keeps
         * revocation fine-grained without cutting a shell off mid-command.
         */
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['terminal'],
          MAX_CAPABILITY_TTL_SECONDS,
          {
            method: 'GET',
            path: `/v1/workspaces/${workspace.id}/terminal`
          }
        )
      };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['browser.read', 'browser.control', 'browser.takeover'],
          90
        )
      };
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/snapshot',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['desktop.read'],
        path: `/v1/workspaces/${workspace.id}/desktop/snapshot`,
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/launch',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['desktop.control'],
          path: `/v1/workspaces/${workspace.id}/desktop/launch`,
          method: 'POST',
          body: JSON.stringify(DesktopLaunchRequest.parse(request.body)),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['desktop.control'],
          path: `/v1/workspaces/${workspace.id}/desktop/action`,
          method: 'POST',
          body: JSON.stringify(DesktopAction.parse(request.body)),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/desktop/holder', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['desktop.takeover'],
        path: `/v1/workspaces/${workspace.id}/desktop/holder`,
        method: 'POST',
        body: JSON.stringify({ holder: DesktopHolder.parse(request.body.holder) }),
        contentType: 'application/json'
      });
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['desktop.read', 'desktop.control', 'desktop.takeover'],
          90
        )
      };
    }
  );

  /**
   * What this computer is running right now.
   *
   * The runner has always kept this list and has always served it; nothing on this side ever asked
   * for it, so the only account the owner had of their own machine's background work was whatever
   * the transcript happened to mention. The token is audience-bound to this one GET, so the `exec`
   * scope it carries cannot be turned round and used to start a process.
   *
   * A computer that is not running reports nothing rather than being woken to say so: stopping,
   * hibernating, snapshotting and restoring all clear the runner's session table
   * (services/workspace-runner/src/server.ts), so an asleep box has no background processes by
   * construction, and reading a panel must never be the thing that starts the machine.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      if (workspace.status !== 'running') return { processes: [] };
      return runner.request<{ processes: unknown[] }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['exec'],
        path: `/v1/workspaces/${workspace.id}/processes`,
        // Someone is watching this pane refresh, so a wedged runner has to fail in seconds rather
        // than hold the request for undici's five-minute header timeout.
        timeoutMs: 5_000
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/previews',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return (await store.listWorkspacePreviews(user.id, workspace.id)).map((preview) =>
        workspacePreviewResponse(preview)
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/previews',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = CreateWorkspacePreviewRequest.parse(request.body);
        assertPublishablePort(input.port, reservedPreviewPortSet);
        let workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        if (workspace.status === 'hibernated') {
          await runner.request({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/resume`,
            method: 'POST',
            body: '{}',
            contentType: 'application/json'
          });
          await store.updateWorkspaceStatus(workspace.id, 'running');
          workspace = (await store.getWorkspace(user.id, workspace.id))!;
        }
        if (workspace.status !== 'running')
          throw new AthanorError(
            'workspace_unavailable',
            'The computer must be running before exposing a preview'
          );
        const check = await runner.request<{ available: boolean }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: [`preview:${input.port}`],
          path: `/v1/workspaces/${workspace.id}/preview-check/${input.port}`
        });
        if (!check.available)
          throw new AthanorError(
            'preview_port_unavailable',
            `Nothing is listening on port ${input.port} of this computer`
          );
        const accessToken = randomBytes(32).toString('base64url');
        let preview: WorkspacePreviewRecord;
        try {
          preview = await store.createWorkspacePreview({
            userId: user.id,
            workspaceId: workspace.id,
            label: input.label,
            port: input.port,
            slug: randomBytes(16).toString('hex'),
            accessTokenHash: sha256(accessToken),
            entryPath: input.entryPath || null,
            maxPreviews: serverLimits.maxPreviews
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'preview_limit')
            throw new AthanorError(
              'preview_limit',
              `This server runs up to ${serverLimits.maxPreviews} previews at once`
            );
          throw error;
        }
        reply.status(201);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/access',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const accessToken = randomBytes(32).toString('base64url');
        const preview = await store.rotateWorkspacePreviewAccess(
          user.id,
          request.params.previewId,
          sha256(accessToken)
        );
        if (!preview)
          throw new AthanorError('preview_unavailable', 'Preview is expired or revoked', 404);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/publish',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        PublishWorkspacePreviewRequest.parse(request.body);
        const existing = await store.getWorkspacePreview(user.id, request.params.previewId);
        if (!existing) throw new AthanorError('preview_not_found', 'Preview not found', 404);
        const accessToken = randomBytes(32).toString('base64url');
        const preview = await store.publishWorkspacePreview(
          user.id,
          request.params.previewId,
          'public',
          sha256(accessToken)
        );
        if (!preview) throw new AthanorError('preview_not_found', 'Preview not found', 404);
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'preview_publish',
          outcome: 'completed',
          metadata: { previewId: preview.id, workspaceId: preview.workspaceId }
        });
        return {
          ...workspacePreviewResponse(preview),
          // What publishing actually does, and nothing else. This used to describe an "always
          // ready" hosting mode holding the computer awake and consuming included active hours -
          // a mechanism that does not exist, in the words of a plan nobody sells.
          warning:
            'This address is on the public internet: anyone holding it reaches the app on this computer, with no sign-in, until you unpublish or revoke it. If the computer is asleep the first request wakes it, so that one waits.'
        };
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/unpublish',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const accessToken = randomBytes(32).toString('base64url');
        // Taking a site off the public internet returns it to the owner's own private link, with a
        // fresh token so the public address stops working. It is not a two-hour grace period: the
        // app is still theirs and still running, and the only thing they asked to end is the part
        // other people could reach.
        const preview = await store.publishWorkspacePreview(
          user.id,
          request.params.previewId,
          'private',
          sha256(accessToken)
        );
        if (!preview) throw new AthanorError('preview_not_found', 'Preview not found', 404);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.delete<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => ({
        revoked: await store.revokeWorkspacePreview(user.id, request.params.previewId)
      }));
    }
  );

  /**
   * Pending is the default because that is the list with something to answer, but an approval
   * that lapsed is exactly what a returning owner is looking for: it explains why a task is
   * paused, and the wording of what was asked is the only record of it.
   */
  app.get<{ Querystring: { status?: string } }>('/v1/approvals', async (request) => {
    const user = requireUser(request.user);
    const status = z
      .enum(['pending', 'approved', 'denied', 'expired'])
      .default('pending')
      .parse(request.query.status);
    const approvals = await store.listApprovals(user.id, status);
    return Promise.all(
      approvals.map(async (approval) => {
        const task = await store.getTask(user.id, String(approval.taskId));
        const workspace = task ? await store.getWorkspace(user.id, task.workspaceId) : null;
        if (!workspace?.wrappedKey)
          return { ...approval, preview: '[unavailable]', previewCiphertext: undefined };
        const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
        const decryptedPreview = decryptJson<Record<string, unknown>>(
          approval.previewCiphertext as Parameters<typeof decryptJson>[0],
          key,
          `approval:${String(approval.taskId)}`
        );
        return {
          ...approval,
          action: textValue(decryptedPreview.action, textValue(approval.action)),
          preview: decryptedPreview,
          previewCiphertext: undefined
        };
      })
    );
  });

  app.post<{ Params: { approvalId: string; decision: string } }>(
    '/v1/approvals/:approvalId/:decision',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const decision = z.enum(['approve', 'deny']).parse(request.params.decision);
        const approval = await store.getApproval(request.params.approvalId);
        if (!approval || approval.userId !== user.id)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        const changed = await store.resolveApproval(
          user.id,
          request.params.approvalId,
          decision === 'approve' ? 'approved' : 'denied'
        );
        if (!changed)
          throw new AthanorError(
            'approval_unavailable',
            'Approval is missing, resolved, or expired'
          );
        await store.setTaskStatusForUser(user.id, String(approval.taskId), 'queued');
        return { ok: true };
      });
    }
  );

  app.get('/v1/connectors/catalog', async () => connectorCatalog);

  app.get('/v1/connectors', async (request) => {
    const user = requireUser(request.user);
    return (await store.listConnectors(user.id)).map(connectorResponse);
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/connectors/audit', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse(request.query.limit);
    return store.listConnectorAudit(user.id, limit);
  });

  const connectorScopes = (
    kind: Connector['kind'],
    requested: Connector['scopes']
  ): Connector['scopes'] => {
    const definition = connectorCatalog.find((entry) => entry.kind === kind);
    if (!definition) throw new AthanorError('connector_kind_invalid', 'Connector is unavailable');
    const allowedScopes = new Set(definition.scopes.map((scope) => scope.id));
    if (requested.some((scope) => !allowedScopes.has(scope)))
      throw new AthanorError(
        'connector_scope_invalid',
        'One or more capabilities do not belong to this connector'
      );
    return [...new Set(requested)];
  };

  const mcpOAuthPage = (
    reply: FastifyReply,
    ok: boolean,
    message: string,
    statusCode = ok ? 200 : 400
  ) => {
    const appUrl = new URL(config.PUBLIC_APP_URL);
    const targetOrigin = appUrl.origin;
    const event = JSON.stringify({ source: 'athanor-mcp-oauth', ok, message }).replaceAll(
      '<',
      '\\u003c'
    );
    const origin = JSON.stringify(targetOrigin).replaceAll('<', '\\u003c');
    const home = appUrl.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const title = ok ? 'Connection ready' : 'Connection not completed';
    const safeMessage = message
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    return reply
      .code(statusCode)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
      )
      .type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090b;color:#eef0f4;font:16px system-ui,sans-serif}.card{max-width:32rem;margin:2rem;padding:2rem;border:1px solid #5d626d;border-radius:1rem;background:#101217}h1{font-size:1.25rem}p{color:#c6c9d0;line-height:1.5}a{color:#fff}</style>
<main class="card"><h1>${title}</h1><p>${safeMessage}</p><a href="${home}">Return to athanor</a></main>
<script>if(window.opener){window.opener.postMessage(${event},${origin});setTimeout(()=>window.close(),500)}</script>
</html>`);
  };

  app.get('/v1/connectors/mcp/oauth/client-metadata', async (_request, reply) => {
    const clientId = new URL(
      '/v1/connectors/mcp/oauth/client-metadata',
      config.PUBLIC_APP_URL
    ).toString();
    const redirectUrl = new URL(
      '/v1/connectors/mcp/oauth/callback',
      config.PUBLIC_APP_URL
    ).toString();
    return reply.header('cache-control', 'public, max-age=3600').send({
      client_id: clientId,
      client_name: 'athanor',
      client_uri: config.PUBLIC_APP_URL,
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  });

  app.post('/v1/connectors/mcp/oauth/start', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = StartMcpOAuthRequest.parse(request.body);
      const scopes = connectorScopes('mcp_http', input.scopes);
      const baseUrl = new URL(input.baseUrl);
      const allowedHostSuffixes = connectorAllowedHosts('mcp_http', baseUrl.toString());
      assertConnectorUrl(baseUrl, allowedHostSuffixes);
      const state = randomBytes(32).toString('base64url');
      const attemptId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const redirectUrl = new URL('/v1/connectors/mcp/oauth/callback', config.PUBLIC_APP_URL);
      const clientMetadataUrl = new URL(
        '/v1/connectors/mcp/oauth/client-metadata',
        config.PUBLIC_APP_URL
      );
      const started = await beginMcpOAuth({
        baseUrl: baseUrl.toString(),
        redirectUrl: redirectUrl.toString(),
        state,
        ...(input.oauthScopes.length ? { scope: input.oauthScopes.join(' ') } : {}),
        ...(input.registration === 'static'
          ? {
              clientId: input.clientId,
              ...(input.clientSecret ? { clientSecret: input.clientSecret } : {})
            }
          : {}),
        ...(input.registration === 'dynamic' && clientMetadataUrl.protocol === 'https:'
          ? { clientMetadataUrl: clientMetadataUrl.toString() }
          : {}),
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      await store.createConnectorOAuthAttempt({
        id: attemptId,
        userId: user.id,
        label: input.label,
        baseUrl: baseUrl.toString(),
        scopes,
        stateHash: sha256(state),
        secretCiphertext: encryptJson(started.secret, masterKey, `connector-oauth:${attemptId}`),
        expiresAt
      });
      return {
        authorizationUrl: started.authorizationUrl,
        authorizationHost: new URL(started.authorizationUrl).hostname,
        expiresAt: expiresAt.toISOString()
      } satisfies StartMcpOAuthResponse;
    });
  });

  app.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>('/v1/connectors/mcp/oauth/callback', async (request, reply) => {
    try {
      const state = z.string().min(20).max(2048).parse(request.query.state);
      const attempt = await store.consumeConnectorOAuthAttempt(sha256(state));
      if (!attempt)
        throw new AthanorError(
          'connector_oauth_attempt_invalid',
          'This authorization link is invalid or has expired',
          400
        );
      if (request.query.error)
        return mcpOAuthPage(
          reply,
          false,
          'The MCP service did not grant access. You can safely close this window and try again.'
        );
      const authorizationCode = z.string().min(1).max(8192).parse(request.query.code);
      if (attempt.secretCiphertext.aad !== `connector-oauth:${attempt.id}`)
        throw new AthanorError(
          'connector_oauth_secret_context',
          'The authorization secret context is invalid'
        );
      const secret = decryptJson<ConnectorSecret>(attempt.secretCiphertext, masterKey);
      if (secret.mcpOAuth?.state !== state)
        throw new AthanorError(
          'connector_oauth_state_invalid',
          'The authorization state does not match'
        );
      const baseUrl = new URL(attempt.baseUrl);
      const allowedHostSuffixes = connectorAllowedHosts('mcp_http', baseUrl.toString());
      const completed = await completeMcpOAuth({
        baseUrl: baseUrl.toString(),
        secret,
        authorizationCode,
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      await verifyConnector({
        kind: 'mcp_http',
        baseUrl: baseUrl.toString(),
        secret: completed,
        allowedHostSuffixes,
        ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {})
      });
      const id = randomUUID();
      const connector = await store.createConnector({
        id,
        userId: attempt.userId,
        kind: 'mcp_http',
        authMode: 'oauth',
        label: attempt.label,
        baseUrl: baseUrl.toString(),
        scopes: attempt.scopes,
        secretCiphertext: encryptJson(completed, masterKey, `connector:${attempt.userId}:${id}`)
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: attempt.userId,
        operation: 'oauth_connection_verified',
        outcome: 'succeeded'
      });
      return mcpOAuthPage(
        reply,
        true,
        `${attempt.label} is connected. This window will close automatically.`
      );
    } catch (error) {
      request.log.warn(
        {
          code: error instanceof AthanorError ? error.code : 'connector_oauth_callback_failed'
        },
        'MCP OAuth callback failed'
      );
      return mcpOAuthPage(
        reply,
        false,
        'The secure connection could not be completed. Close this window and try again.'
      );
    }
  });

  app.post('/v1/connectors', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = CreateConnectorRequest.parse(request.body);
      const scopes = connectorScopes(input.kind, input.scopes);
      const baseUrl =
        input.kind === 'github' ? 'https://api.github.com' : new URL(input.baseUrl).toString();
      /**
       * A mailbox address is not an HTTPS URL, so it cannot be checked like one: `imaps://host:993`
       * fails `assertConnectorUrl` on both the scheme and the port. `parseImapEndpoint` is the same
       * check written for the protocol that is actually spoken, and it is given the deployment list
       * alone rather than the list plus this connector's own host - for mail and calendar the list
       * is a statement about which providers this install may talk to at all, and an install that
       * has set one means it. Empty, which is the default, leaves the owner's own choice standing.
       *
       * A calendar needs no check here: the connector layer applies the same deployment binding and
       * the same HTTPS shape check while building its request context, which happens before the
       * password is put on a header. The other kinds keep their existing shape - the owner names an
       * HTTPS host and it is allowed because they named it.
       */
      const allowedHostSuffixes = connectorAllowedHosts(input.kind, baseUrl);
      if (input.kind === 'imap') parseImapEndpoint(baseUrl, allowedHostSuffixes);
      else if (input.kind === 'webdav' || input.kind === 'mcp_http')
        assertConnectorUrl(new URL(baseUrl), allowedHostSuffixes);
      const connectorSecret = (): ConnectorSecret => {
        switch (input.kind) {
          case 'github':
            return { token: input.token };
          case 'webdav':
            return { username: input.username, password: input.password };
          case 'imap':
            return {
              mail: {
                version: 1,
                username: input.username,
                password: input.password,
                fromAddress: input.fromAddress,
                ...(input.fromName ? { fromName: input.fromName } : {}),
                smtpHost: input.smtpHost,
                smtpPort: input.smtpPort
              }
            };
          case 'caldav':
            return {
              calendar: {
                version: 1,
                username: input.username,
                password: input.password,
                address: input.address
              }
            };
          default:
            return { ...(input.token ? { token: input.token } : {}) };
        }
      };
      const secret = connectorSecret();
      try {
        // Verification runs before anything is stored, and for a mailbox it exercises both halves:
        // an IMAP login and listing, then an SMTP submission login. Discovering at the moment of an
        // approval that sending was never going to work is the worst possible time to discover it.
        await verifyConnector({
          kind: input.kind,
          baseUrl,
          secret,
          allowedHostSuffixes,
          ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {}),
          ...(overrides.mailSocketFactory ? { mailSocketFactory: overrides.mailSocketFactory } : {})
        });
      } catch (error) {
        if (error instanceof AthanorError) throw error;
        throw new AthanorError(
          'connector_connection_failed',
          error instanceof Error ? error.message : 'Connector could not be verified',
          400
        );
      }
      const id = randomUUID();
      const connector = await store.createConnector({
        id,
        userId: user.id,
        kind: input.kind,
        // Every kind but MCP carries a stored credential; MCP is the only one that can be reached
        // with a bearer token or with nothing at all.
        authMode: input.kind !== 'mcp_http' ? 'secret' : input.token ? 'bearer' : 'none',
        label: input.label,
        baseUrl,
        scopes,
        secretCiphertext: encryptJson(secret, masterKey, `connector:${user.id}:${id}`)
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: user.id,
        operation: 'connection_verified',
        outcome: 'succeeded'
      });
      return connectorResponse({ ...connector, lastUsedAt: new Date().toISOString() });
    });
  });

  /**
   * Ask a connected account whether it still works.
   *
   * A mailbox is verified once, when it is added, and then trusted for as long as it exists - so a
   * changed password, a moved server or an expired authorization is discovered by the agent, mid
   * task, as a failure the owner has to read backwards from. This is the same verification the
   * connect route runs, against the stored credential, on demand.
   *
   * It answers 200 whether or not the account replied: "does this still work" is a question, and
   * "no, the submission host refused the login" is a successful answer to it. There is no step-up
   * here, because nothing is revealed and nothing changes - except an MCP authorization, which is
   * refreshed and re-sealed exactly as it is when the agent uses one, so re-checking an expired
   * token is also how it is renewed.
   */
  app.post<{ Params: { connectorId: string } }>(
    '/v1/connectors/:connectorId/test',
    async (request) => {
      const user = requireUser(request.user);
      const connector = await store.getConnector(user.id, request.params.connectorId);
      if (!connector) throw new AthanorError('connector_not_found', 'Connector not found', 404);
      if (connector.secretCiphertext.aad !== `connector:${user.id}:${connector.id}`)
        throw new AthanorError(
          'connector_secret_context',
          'Connector secret encryption context is invalid'
        );
      const secret = decryptJson<ConnectorSecret>(connector.secretCiphertext, masterKey);
      const checkedAt = new Date().toISOString();
      try {
        const verified = await verifyConnector({
          kind: connector.kind,
          baseUrl: connector.baseUrl,
          secret,
          allowedHostSuffixes: connectorAllowedHosts(connector.kind, connector.baseUrl),
          onSecretUpdated: async (updated) => {
            const saved = await store.updateConnectorSecret(
              user.id,
              connector.id,
              encryptJson(updated, masterKey, `connector:${user.id}:${connector.id}`)
            );
            if (!saved)
              throw new AthanorError(
                'connector_secret_update_failed',
                'The refreshed connector authorization could not be saved'
              );
          },
          ...(overrides.connectorTransport ? { transport: overrides.connectorTransport } : {}),
          ...(overrides.mailSocketFactory ? { mailSocketFactory: overrides.mailSocketFactory } : {})
        });
        await store.recordConnectorAudit({
          connectorId: connector.id,
          userId: user.id,
          operation: 'connection_rechecked',
          outcome: 'succeeded',
          statusCode: verified.statusCode
        });
        return {
          connectorId: connector.id,
          ok: true,
          accountLabel: verified.accountLabel,
          checkedAt,
          failure: null
        } satisfies ConnectorTestResult;
      } catch (error) {
        const failure =
          error instanceof AthanorError
            ? { code: error.code, message: error.message }
            : {
                code: 'connector_connection_failed',
                message: error instanceof Error ? error.message : 'The account did not answer'
              };
        await store.recordConnectorAudit({
          connectorId: connector.id,
          userId: user.id,
          operation: 'connection_rechecked',
          outcome: 'failed'
        });
        request.log.warn({ connectorId: connector.id, code: failure.code }, 'connector.recheck');
        return {
          connectorId: connector.id,
          ok: false,
          accountLabel: null,
          checkedAt,
          failure
        } satisfies ConnectorTestResult;
      }
    }
  );

  app.delete<{ Params: { connectorId: string } }>(
    '/v1/connectors/:connectorId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const connector = await store.getConnector(user.id, request.params.connectorId);
        if (!connector) throw new AthanorError('connector_not_found', 'Connector not found', 404);
        const revoked = await store.revokeConnector(user.id, connector.id);
        if (revoked)
          await store.recordConnectorAudit({
            connectorId: connector.id,
            userId: user.id,
            operation: 'revoke',
            outcome: 'succeeded'
          });
        return { revoked };
      });
    }
  );

  app.get('/v1/privacy/export', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const base = await store.exportAccount(user.id);
    const workspaces = await store.listWorkspaces(user.id);
    const taskContents: Array<Record<string, unknown>> = [];
    const taskPlanContents: Array<Record<string, unknown>> = [];
    const scheduleContents: Array<Record<string, unknown>> = [];
    for (const workspace of workspaces) {
      if (!workspace.wrappedKey) continue;
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      for (const task of await store.listTasks(user.id, workspace.id)) {
        const prompt = decryptJson<{ prompt: string }>(
          task.promptCiphertext,
          key,
          `task-prompt:${workspace.id}`
        ).prompt;
        const events = (await store.listTaskEvents(task.id)).map((event) => {
          const content = revealedTaskEvent(
            event.summary,
            event.payloadCiphertext
              ? decryptJson(event.payloadCiphertext, key, `task-event:${task.id}`)
              : undefined
          );
          return {
            sequence: event.sequence,
            kind: event.kind,
            summary: content.summary,
            payload: content.payload ?? null,
            createdAt: event.createdAt
          };
        });
        taskContents.push({
          taskId: task.id,
          workspaceId: workspace.id,
          title: await taskTitle(task, workspace),
          prompt,
          events
        });
        for (const plan of await store.listTaskPlans(task.id)) {
          taskPlanContents.push(await privateTaskPlanResponse(plan, workspace));
        }
      }
      for (const schedule of (await store.listTaskSchedules(user.id)).filter(
        (item) => item.workspaceId === workspace.id
      )) {
        scheduleContents.push({
          scheduleId: schedule.id,
          workspaceId: workspace.id,
          title: await scheduleTitle(schedule, workspace),
          prompt: decryptJson<{ prompt: string }>(
            schedule.promptCiphertext,
            key,
            `task-prompt:${workspace.id}`
          ).prompt
        });
      }
    }
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'privacy_export',
      outcome: 'completed'
    });
    return reply
      .header(
        'content-disposition',
        `attachment; filename="athanor-export-${new Date().toISOString().slice(0, 10)}.json"`
      )
      .send({ ...base, taskContents, taskPlanContents, scheduleContents });
  });

  app.delete<{ Params: { workspaceId: string }; Body: { confirmName: string } }>(
    '/v1/workspaces/:workspaceId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ confirmName: z.string() }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
        if (input.confirmName !== workspace.name)
          throw new AthanorError(
            'confirmation_failed',
            'Type the exact workspace name to delete it'
          );
        await meterWorkspace(workspace);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}`,
          method: 'DELETE'
        });
        await store.deleteWorkspace(user.id, workspace.id);
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_delete',
          outcome: 'completed',
          metadata: { workspaceId: workspace.id }
        });
        return {
          deleted: true,
          workspaceId: workspace.id,
          volumeDeletionRequested: true,
          applicationKeyRecordDeleted: true,
          backupExpiry: 'according_to_deployment_retention_policy'
        };
      });
    }
  );

  /**
   * The owner's choices, saved where every one of their devices can read them.
   *
   * Merged rather than replaced, so a phone saving one key does not wipe what a laptop saved a
   * second earlier. Returned in full so the caller ends up holding what the server now holds
   * rather than what it hoped it had written.
   */
  /**
   * The half-typed message, kept where the owner's other device can find it.
   *
   * Sealed with the workspace key like the conversation it belongs to - a draft is the owner's
   * words, and the box holds no plaintext of those anywhere else either. An empty body deletes the
   * row rather than storing emptiness for every conversation ever opened.
   */
  app.put('/v1/drafts', async (request) => {
    const user = requireUser(request.user);
    const input = SaveDraftRequest.parse(request.body);
    const workspace = await store.getWorkspace(user.id, input.workspaceId);
    if (!workspace?.wrappedKey)
      throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    const body = input.body.trim();
    // Files already uploaded count as a draft even with nothing typed yet: dropping the row on an
    // empty body would have thrown away the attachments the owner had just spent a minute
    // uploading, which is the state a message that is mostly files sits in.
    const attachments = (input.attachments ?? []).filter((item) => item.path);
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: input.taskId ?? null,
      bodyCiphertext:
        body || attachments.length
          ? encryptJson(
              { body: input.body, attachments },
              unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id),
              `draft:${workspace.id}`
            )
          : null
    });
    return { saved: true };
  });

  app.put('/v1/account/preferences', async (request) => {
    const user = requireUser(request.user);
    const patch = OwnerPreferences.parse(request.body ?? {});
    return { preferences: await store.mergeUserPreferences(user.id, patch) };
  });

  app.delete<{ Body: { confirmUsername: string } }>('/v1/account', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ confirmUsername: z.string() }).parse(request.body);
      if (input.confirmUsername.toLowerCase() !== user.username.toLowerCase())
        throw new AthanorError(
          'confirmation_failed',
          'Type the exact username to delete the account'
        );
      for (const workspace of await store.listWorkspaces(user.id)) {
        await meterWorkspace(workspace);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}`,
          method: 'DELETE'
        });
      }
      await store.deleteUser(user.id);
      reply.clearCookie(sessionCookieName(secure), { path: '/' });
      return {
        deleted: true,
        volumeDeletionRequested: true,
        applicationKeyRecordsDeleted: true,
        backupExpiry: 'according_to_deployment_retention_policy'
      };
    });
  });

  /**
   * Started last, so nothing it might touch is still being built, and stopped first below.
   *
   * The interval is long because the answer itself is what wakes this: it is the safety net for a
   * dropped notification listener and for the backlog a restart leaves behind, not the schedule.
   */
  const titler = startTaskTitler({ store, masterKey, log, complete: titleCompletion }, 5 * 60_000);

  app.addHook('onClose', async () => {
    embeddedWorkerRunning = false;
    stopEmbeddedWorker();
    clearInterval(maintenanceTimer);
    clearInterval(schedulerTimer);
    /**
     * Stopped before the worker is drained, not after. The titler wakes on an answer, and the last
     * thing a draining worker does is produce one - so leaving it running through the drain is
     * asking it to start a provider call at the exact moment the process is trying to leave.
     */
    await titler.stop();
    /**
     * The turn in flight finishes against a live database rather than being cut off mid-write -
     * but only for so long. A turn can legitimately run for many minutes, and a restart that waited
     * for one would be killed by the service manager well before it finished. Past the grace the
     * task simply keeps its lease, which is what leases are for: the next process to come up takes
     * it back when that lease expires.
     */
    await Promise.race([
      embeddedWorkerLoop,
      new Promise<void>((resolve) => setTimeout(resolve, embeddedWorkerShutdownGraceMs).unref())
    ]);
    // Only the connection: the settings file is untouched, so a restart comes back on the relay if
    // that is what the owner asked for.
    relay.close();
    await previewApp.close();
    await database.close();
  });
  return { app, previewApp, store, database, relay, runMaintenance: maintain };
};
