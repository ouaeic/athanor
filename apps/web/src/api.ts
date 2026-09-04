import type {
  Approval,
  Artifact,
  ApiToken,
  ApiTokenScope,
  BackgroundProcess,
  Bootstrap,
  ConnectorDefinition,
  ConversationSearchResult,
  DesktopSnapshot,
  FileEntry,
  OwnerBlock,
  RelayReport,
  RewindScope,
  Task,
  TaskEvent,
  TaskPlan,
  TaskPlanStep,
  TaskRewindPreview,
  TaskSchedule,
  Workspace,
  WorkspaceMemory,
  WorkspacePreview,
  WorkspaceSkill,
  WorkspaceSnapshot
} from './types.js';
import type { BackupStatus } from './backup-evidence.js';
import type {
  Connector,
  ConnectorAuditEvent,
  ConnectorTestResult,
  SpendLimits,
  SpendSummary,
  UpdateSpendLimitsRequest,
  User
} from './types.js';
import type { UsageResponse } from './usage-model.js';
import type { WebSearchRoute } from './web-search-route.js';
import {
  notificationSettingsFromResponse,
  type NotificationSettings,
  type UpdateNotificationSettingsRequest
} from './notification-settings.js';
import { readNotices, type AgentNotification } from './notice-log.js';
import type { BuildIdentity, SecurityMode } from '@athanor/contracts';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import { ApiFailure } from './api-failure.js';

export { ApiFailure } from './api-failure.js';

export interface ProviderSettings {
  configured: boolean;
  source: 'encrypted_database' | 'server_environment';
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
  baseUrl: string;
  modelId: string | null;
  hasApiKey: boolean;
  enforceZeroDataRetention: boolean;
  /** Where a web search would be answered under this credential. */
  webSearch?: WebSearchRoute;
}

/**
 * Which side of the computer put a row into memory, which is the question `trust` cannot answer.
 *
 * `stated` is the owner's own sentence. `proposed` is a model's wording of what it read them say,
 * corroborated on two days and now pinned into every task in the workspace. `watched` is the
 * harness: a command it ran, or a turn it filed as that turn finished. The store's `trust` column
 * has two values in use and calls the last two both `derived`, so the list served it faithfully and
 * still could not tell an owner which of the three they were looking at.
 */
export type MemoryItemOrigin = 'stated' | 'proposed' | 'watched';

/**
 * A row the agent wrote into its own memory as work finished, rather than one the owner typed.
 *
 * `excerpt` is the opening of the stored text, decrypted on the server with the workspace key: the
 * client is shown what is actually held, not a description of it. `trust` and `origin` say where it
 * came from: a row a model proposed is obeyed exactly like a sentence the owner typed, and until
 * these two fields were served this list drew them identically.
 */
export interface MemoryItem {
  id: string;
  kind: 'source' | 'episode' | 'fact' | 'procedure';
  status: 'active' | 'superseded' | 'disputed' | 'archived' | 'retracted';
  excerpt: string;
  observedAt: string;
  /** Whether the owner said this or the box worked it out, which decides how firmly it is put. */
  trust: 'stated' | 'derived';
  /** The three-way answer `trust` collapses to two. */
  origin: MemoryItemOrigin;
}

/**
 * The same row with everything a decision about it would rest on: which conversation wrote it, when
 * it was last confirmed, and what it has been worth in use.
 */
export interface MemoryReviewItem extends MemoryItem {
  taskId: string | null;
  validFrom: string;
  validTo: string | null;
  lastVerified: string | null;
  okCount: number;
  failCount: number;
  useCount: number;
  pin: boolean;
}

/**
 * A rule a model has put forward about how this computer should work, which nothing believes yet.
 *
 * It is not a memory and the fields say so. `sightings` is how many separate conversations it has
 * been drawn from, `needsAnotherDay` is true while those are too close together to count as two,
 * and until both clear it does nothing at all. `sentence` is the whole rule rather than an excerpt,
 * because accepting or refusing one while reading its opening is not a decision anybody can make.
 */
export interface MemoryProposal {
  id: string;
  sentence: string;
  sightings: number;
  firstSeen: string;
  lastSeen: string;
  needsAnotherDay: boolean;
}

/** What the box has stopped being sure of, in the two shapes that being unsure comes in. */
export interface MemoryReview {
  procedures: Array<
    MemoryReviewItem & {
      /**
       * Why it is here, and the three cases mean different things to whoever reads them: nobody
       * has confirmed it in a season (`unverified`) may be a good procedure that is merely unused,
       * `failing` is broken now, and `both` is both.
       */
      reason: 'unverified' | 'failing' | 'both';
      recentOkCount: number;
      recentGradedCount: number;
    }
  >;
  disputed: Array<MemoryReviewItem & { contradicts: string[] }>;
  /** Rules a model has put forward and the owner has not refused. Nothing here is believed yet. */
  proposals: MemoryProposal[];
}

/**
 * The router's own vocabulary for what a turn is going to be, which `/v1/models/recommend` has
 * accepted all along and this client never sent. Copied rather than imported: `@athanor/core` is
 * a server package and this list is eight strings, so the alternative is a dependency edge for a
 * type that erases.
 */
export type ModelTaskKind =
  | 'general'
  | 'coding'
  | 'agentic'
  | 'conversation'
  | 'reasoning'
  | 'vision'
  | 'long_context'
  | 'bulk_summarisation';

/**
 * What starting a conversation says, written out rather than `unknown`.
 *
 * `maxSpendUsd` is the reason it is written out: the route has taken a per-conversation ceiling
 * since the contract did, and a body typed `unknown` is a body no compiler can tell you is missing
 * a field. Omitted means "use the account default", which is not the same as no ceiling.
 */
export interface CreateTaskBody {
  workspaceId: string;
  prompt: string;
  title?: string;
  modelId?: string;
  privacyRoute?: 'provider_zdr' | 'external';
  maxComputeCredits?: number;
  maxSpendUsd?: number;
  attachments?: string[];
}

/** The same, for the next message in a conversation that already exists. */
export interface ContinueTaskBody {
  prompt: string;
  modelId?: string;
  privacyRoute?: 'provider_zdr' | 'external';
  maxComputeCredits?: number;
  maxSpendUsd?: number;
  attachments?: string[];
  /** Apply this to the turn already running rather than the one after it. */
  interrupt?: boolean;
}

let nativeGateway = false;

/**
 * How long any one request may hang before it is treated as a failure.
 *
 * Nothing in this client had a deadline, so a connection that opened and then stalled - a phone
 * moving between networks is the ordinary case - left the promise pending forever. Whatever it was
 * feeding showed its loading state and never left it, and no error was ever raised because none
 * ever arrived. Generous, because a slow answer is still an answer; a caller that wants longer
 * passes its own signal, which wins.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * The passkey ceremony, fetched at the moment one is actually run.
 *
 * `@simplewebauthn/browser` is 2.4 kB gzipped and it was the largest single thing in the first
 * paint: every caller of it — the sign-in screen and the security page — is already behind `lazy`,
 * and this module's static import was the one edge keeping it in the eager graph. Both call sites
 * were already `async`, so nothing above them changes and no Suspense boundary is involved.
 */
const webauthn = () => import('@simplewebauthn/browser');

/**
 * Exported for the one caller outside this file: the phone transport's calls live in a module
 * only the settings screen loads, so their weight stays out of the first paint.
 */
export const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    // After the spread, so an `init` carrying an explicit `signal: undefined` cannot silently
    // remove the deadline. A caller with its own signal still wins.
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...(init?.body instanceof ArrayBuffer
        ? { 'content-type': 'application/octet-stream' }
        : { 'content-type': 'application/json' }),
      ...init?.headers
    }
  });
  if (response.headers.get('x-athanor-native-client') === '1') nativeGateway = true;
  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => ({ error: { code: 'request_failed', message: 'Request failed' } }))) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    // A route this server does not implement answers in Fastify's own shape, which carries no
    // athanor error envelope at all; the status is then the only thing worth trusting.
    throw new ApiFailure(
      body.error?.code ?? 'request_failed',
      body.error?.message ?? `Request failed (${response.status})`,
      response.status,
      // Carried only when the box actually minted one. An envelope without it came from something
      // that is not this API, and inventing a blank id would make the log line unfindable rather
      // than absent.
      body.error?.requestId
    );
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (
    type.includes('application/json') ? response.json() : response.arrayBuffer()
  ) as Promise<T>;
};

export const mutation = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'idempotency-key': crypto.randomUUID() }
});

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const webauthnContext = (): { nativeOrigin?: string } =>
  location.protocol === 'http:' && location.hostname === 'localhost'
    ? { nativeOrigin: location.origin }
    : {};

const runnerUrlForClient = (remote: string): string =>
  nativeGateway
    ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/runner`
    : remote;

const previewForClient = <T extends WorkspacePreview>(preview: T): T => {
  if (!nativeGateway) return preview;
  try {
    const remote = new URL(preview.url);
    if (!remote.pathname.startsWith('/__athanor/preview/')) return preview;
    return {
      ...preview,
      url: `${location.origin}${remote.pathname}${remote.search}${remote.hash}`
    };
  } catch {
    return preview;
  }
};

export const api = {
  nativeBootstrap: async () => {
    if (location.protocol !== 'http:' || location.hostname !== 'localhost') return null;
    try {
      const response = await fetch('/__athanor/client/bootstrap', {
        credentials: 'same-origin'
      });
      if (!response.ok) return null;
      nativeGateway = true;
      return (await response.json()) as { pairingCode: string | null; installerUrl: string };
    } catch {
      return null;
    }
  },
  /**
   * What this program is, whether a passkey ceremony can run here at all, and whether this box is
   * still accepting a first owner. It carried four more fields — a terms URL, a document version,
   * and two acceptance flags — after the server stopped sending any of them: a machine somebody
   * installed does not present its owner with terms, and the route says so in as many words.
   */
  legal: () =>
    request<{
      applicationLicense: 'AGPL-3.0-only';
      sourceUrl: string | null;
      privacyUrl: string | null;
      passkeysUsable: boolean;
      registrationAvailable: boolean;
      /** One account on the box, so recovery has nothing to disambiguate and asks for no name. */
      singleOwner: boolean;
    }>('/v1/legal'),
  devLogin: (username: string) =>
    request('/v1/auth/dev', { method: 'POST', body: JSON.stringify({ username }) }),
  registerOptions: (displayName: string, pairingCode: string) =>
    request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      '/v1/auth/register/options',
      {
        method: 'POST',
        body: JSON.stringify({ displayName, pairingCode, ...webauthnContext() })
      }
    ),
  registerVerify: (body: unknown) =>
    request<{ user: Bootstrap['user']; recoveryCode: string }>('/v1/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  /**
   * Adding a second device, which is a different door from claiming the box.
   *
   * Registration is the first owner's path and a claimed box refuses it outright, so every device
   * after the first redeems a single-use grant minted by one that is already signed in. The grant
   * authorises exactly one thing - adding a credential to this account - and the ceremony still has
   * to complete, so the token on its own produces nothing.
   */
  enrollOptions: (token: string) =>
    request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      '/v1/auth/enroll/options',
      { method: 'POST', body: JSON.stringify({ token, ...webauthnContext() }) }
    ),
  enrollVerify: (body: unknown) =>
    request<{ id: string; username: string; displayName: string }>('/v1/auth/enroll/verify', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  loginOptions: () =>
    request<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      '/v1/auth/login/options',
      { method: 'POST', body: JSON.stringify(webauthnContext()) }
    ),
  loginVerify: (body: unknown) =>
    request('/v1/auth/login/verify', { method: 'POST', body: JSON.stringify(body) }),
  recoverOptions: (username: string, recoveryCode: string) =>
    request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      '/v1/auth/recover/options',
      {
        method: 'POST',
        body: JSON.stringify({ username, recoveryCode, ...webauthnContext() })
      }
    ),
  recoverVerify: (body: unknown) =>
    request<{ user: Bootstrap['user']; recoveryCode: string }>('/v1/auth/recover/verify', {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  stepUp: async () => {
    const pending = await request<{
      verified?: boolean;
      challengeId?: string;
      options?: PublicKeyCredentialRequestOptionsJSON;
    }>('/v1/auth/step-up/options', {
      method: 'POST',
      body: JSON.stringify(webauthnContext())
    });
    if (pending.verified) return;
    if (!pending.challengeId || !pending.options)
      throw new ApiFailure('step_up_failed', 'Passkey verification could not start');
    const { startAuthentication } = await webauthn();
    const response = await startAuthentication({ optionsJSON: pending.options });
    await request('/v1/auth/step-up/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: pending.challengeId, response })
    });
  },
  /**
   * Replaces the recovery code with a fresh one. Step-up first, because anyone who can reach an
   * unlocked browser could otherwise mint themselves a permanent way back into the account.
   */
  reissueRecoveryCode: () =>
    request<{ recoveryCode: string }>('/v1/auth/recovery-code', mutation('POST', {})),
  logout: () => request('/v1/auth/logout', { method: 'POST', body: '{}' }),
  provider: () => request<ProviderSettings>('/v1/providers'),
  transcribeAudio: (bytes: Uint8Array, format: 'm4a' | 'ogg' | 'webm') =>
    request<{ text: string; model: string; privacyRoute: 'provider_zdr' }>(
      '/v1/audio/transcriptions',
      {
        method: 'POST',
        body: JSON.stringify({ data: bytesToBase64(bytes), format })
      }
    ),
  saveProvider: (body: {
    provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
    baseUrl?: string;
    apiKey?: string;
    modelId?: string;
    enforceZeroDataRetention: boolean;
    contextTokens?: number;
    capabilities?: Array<'chat' | 'vision' | 'tools' | 'reasoning' | 'embedding'>;
    modalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  }) => request<ProviderSettings>('/v1/providers', mutation('PUT', body)),
  deleteProvider: () => request<{ deleted: boolean }>('/v1/providers', mutation('DELETE', {})),
  sessions: () =>
    request<
      Array<{
        id: string;
        deviceLabel: string;
        createdAt: string;
        lastSeenAt: string;
        expiresAt: string;
        current: boolean;
      }>
    >('/v1/sessions'),
  revokeSession: (id: string) =>
    request<{ revoked: boolean; current: boolean }>(`/v1/sessions/${id}`, mutation('DELETE', {})),
  apiTokens: () => request<ApiToken[]>('/v1/api-tokens'),
  createApiToken: (body: { label: string; scopes: ApiTokenScope[]; expiresInDays: number }) =>
    request<{ apiToken: ApiToken; token: string }>('/v1/api-tokens', mutation('POST', body)),
  revokeApiToken: (id: string) =>
    request<{ revoked: boolean }>(`/v1/api-tokens/${id}`, mutation('DELETE', {})),
  passkeys: () =>
    request<
      Array<{
        id: string;
        deviceType: string;
        backedUp: boolean;
        transports: string[];
        createdAt: string;
      }>
    >('/v1/auth/passkeys'),
  addPasskey: async () => {
    const pending = await request<{
      challengeId: string;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>('/v1/auth/passkeys/options', {
      method: 'POST',
      body: JSON.stringify(webauthnContext())
    });
    const { startRegistration } = await webauthn();
    const response = await startRegistration({ optionsJSON: pending.options });
    return request<{
      id: string;
      deviceType: string;
      backedUp: boolean;
      transports: string[];
      createdAt: string;
    }>('/v1/auth/passkeys/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: pending.challengeId, response })
    });
  },
  revokePasskey: (id: string) =>
    request<{ revoked: boolean }>(`/v1/auth/passkeys/${id}`, mutation('DELETE', {})),
  bootstrap: () => request<Bootstrap>('/v1/bootstrap'),
  workspaceAction: (id: string, action: 'hibernate' | 'resume') =>
    request<Workspace>(`/v1/workspaces/${id}/${action}`, mutation('POST', {})),
  workspaceHeartbeat: (id: string) =>
    request<{
      ok: true;
      status: string;
      storageBytes: number;
      hostStorageTotalBytes?: number;
      hostStorageAvailableBytes?: number;
    }>(`/v1/workspaces/${id}/heartbeat`, { method: 'POST', body: '{}' }),
  updateWorkspaceSecurityMode: (id: string, securityMode: SecurityMode) =>
    request<Workspace>(`/v1/workspaces/${id}/security-mode`, mutation('PATCH', { securityMode })),
  /**
   * Handed to the browser's download manager rather than buffered in the tab: a workspace archive
   * is arbitrarily large, and the response already carries its own content-disposition. The caller
   * proves step-up first, on the same session cookie the download sends.
   */
  downloadWorkspaceExport: (id: string) => {
    const anchor = document.createElement('a');
    anchor.href = `/v1/workspaces/${id}/export`;
    anchor.download = `athanor-workspace-${id}.tar.gz`;
    anchor.rel = 'noopener';
    anchor.click();
  },
  workspaceSnapshots: (id: string) =>
    request<WorkspaceSnapshot[]>(`/v1/workspaces/${id}/snapshots`),
  createWorkspaceSnapshot: (id: string, name: string) =>
    request<WorkspaceSnapshot>(`/v1/workspaces/${id}/snapshots`, mutation('POST', { name })),
  deleteWorkspaceSnapshot: (workspaceId: string, snapshotId: string) =>
    request<{ deleted: boolean }>(
      `/v1/workspaces/${workspaceId}/snapshots/${snapshotId}`,
      mutation('DELETE', {})
    ),
  restoreWorkspaceSnapshot: (workspaceId: string, snapshotId: string, confirmName: string) =>
    request<{
      workspace: Workspace;
      restoredFrom: string;
      safetySnapshotId: string;
      scope: string;
      excludes: string[];
      warning: string;
    }>(
      `/v1/workspaces/${workspaceId}/snapshots/${snapshotId}/restore`,
      mutation('POST', { confirmName })
    ),
  createTask: (body: CreateTaskBody) => request<Task>('/v1/tasks', mutation('POST', body)),
  /**
   * The next page of conversations, from where the bootstrap left off.
   *
   * The bootstrap carries the newest page and the cursor that resumes it, and the cursor had no
   * caller: a box with more conversations than one page could only reach the older ones through
   * search, which needs the owner to remember something about them.
   *
   * `include` is the second half of archiving. `updateTask` has filed a conversation away since
   * this client learned to, and the list route has answered `archived` and `all` for as long — so
   * a conversation the owner put out of the way became one they could only reach by remembering a
   * word in it. Omitted means `active`, which is what the sidebar wants and what the route
   * defaults to, so the query string is left off entirely rather than saying so.
   */
  tasks: (cursor: string | null, include?: 'active' | 'archived' | 'all') => {
    const query = new URLSearchParams();
    // Null is the top of the list, not a position. `TaskPageQuery` types the cursor as
    // `z.string().min(1)`, so sending an empty one is a 400 - and the archived list has to be asked
    // for from the start: the bootstrap's cursor is a position in the *active* list, and the filed
    // conversation the owner is looking for is usually a recent one.
    if (cursor) query.set('cursor', cursor);
    if (include !== undefined && include !== 'active') query.set('include', include);
    return request<{
      tasks: Task[];
      nextCursor: string | null;
      hasMore: boolean;
      scheduleRunCounts?: Record<string, number>;
    }>(`/v1/tasks?${query}`);
  },
  search: (query: string, workspaceId?: string) =>
    request<ConversationSearchResult[]>(
      `/v1/search?q=${encodeURIComponent(query)}${
        workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''
      }`
    ),
  saveDraft: (body: unknown) => request<{ saved: boolean }>('/v1/drafts', mutation('PUT', body)),
  savePreferences: (body: unknown) =>
    request<{ preferences: User['preferences'] }>('/v1/account/preferences', mutation('PUT', body)),
  continueTask: (id: string, body: ContinueTaskBody) =>
    request<Task>(`/v1/tasks/${id}/messages`, mutation('POST', body)),
  /**
   * What rewinding the computer to a point in this conversation would do, before it is done.
   *
   * `checkpoint` is null when no restore point covers that point — a turn that only read, or one
   * old enough to have been pruned. That is the answer, not a failure, and it is the difference
   * between offering the choice and offering one that would quietly do nothing.
   */
  taskRewindPreview: (id: string, eventId: string) =>
    request<TaskRewindPreview>(
      `/v1/tasks/${id}/rewind-preview?eventId=${encodeURIComponent(eventId)}`
    ),
  /**
   * Branch, edit or retry, each of which may take the computer back with it.
   *
   * `rewind: 'computer'` forks nothing: the server puts the machine back and returns this same
   * task with a line appended to its transcript, because the machine goes back while the
   * conversation carries on. The checkpoint is named rather than left to be resolved, so what is
   * restored is what the preview described.
   *
   * `modelId` and `privacyRoute` are on all three because the contract has carried them on all
   * three since forking existed, and omitting them means "the model the source task used" — which
   * is what made "that answer was weak, try the stronger one" a retype rather than a retry. The
   * route refuses a model whose route does not match rather than downgrading it quietly.
   *
   * `maxSpendUsd` is on `edit` and `retry` and deliberately not on `branch`: branching runs
   * nothing, and the server's discriminated union has no such field there, so a ceiling sent with
   * a branch would be stripped in silence — a control that reports success and does nothing.
   */
  createTaskTrajectory: (
    id: string,
    body:
      | {
          operation: 'branch';
          eventId: string;
          rewind: RewindScope;
          checkpointId?: string;
          modelId?: string;
          privacyRoute?: 'provider_zdr' | 'external';
        }
      | {
          operation: 'edit';
          eventId: string;
          prompt: string;
          maxComputeCredits: number;
          stopSource: boolean;
          rewind: RewindScope;
          checkpointId?: string;
          modelId?: string;
          privacyRoute?: 'provider_zdr' | 'external';
          maxSpendUsd?: number;
        }
      | {
          operation: 'retry';
          eventId: string;
          maxComputeCredits: number;
          stopSource: boolean;
          rewind: RewindScope;
          checkpointId?: string;
          modelId?: string;
          privacyRoute?: 'provider_zdr' | 'external';
          maxSpendUsd?: number;
        }
  ) => request<Task>(`/v1/tasks/${id}/trajectory`, mutation('POST', body)),
  createSchedule: (body: unknown) => request<TaskSchedule>('/v1/schedules', mutation('POST', body)),
  scheduleAction: (id: string, action: 'pause' | 'resume' | 'run') =>
    request<TaskSchedule>(`/v1/schedules/${id}/${action}`, mutation('POST', {})),
  deleteSchedule: (id: string) =>
    request<{ deleted: boolean }>(`/v1/schedules/${id}`, mutation('DELETE', {})),
  /**
   * Change a watcher without recreating it: its title, its instruction, its timing, or what one
   * run of it may spend. The model and privacy route are the two it keeps — the route refuses a
   * change to either with `schedule_model_immutable` rather than answering 200 and ignoring it —
   * so they are not on this body at all.
   *
   * The server refuses a patch that would change nothing, which is why every field is optional and
   * a caller is expected to name at least one.
   */
  updateSchedule: (
    id: string,
    patch: {
      title?: string;
      prompt?: string;
      spec?: TaskSchedule['spec'];
      maxComputeCredits?: number;
      /** An explicit null clears the per-run ceiling; omitting it leaves the current one alone. */
      maxSpendUsd?: number | null;
    }
  ) => request<TaskSchedule>(`/v1/schedules/${id}`, mutation('PATCH', patch)),
  /**
   * The catalogue in the order it should be tried, and the argument for the front of it.
   *
   * `taskKind` is the router's five profiles — vision, long context, reasoning, bulk
   * summarisation, conversation — which were written, weighted and tested and which this client
   * never named, so every ranking it asked for fell through to general work. Omitted still means
   * general, so a caller that does not know what the turn will be does not have to guess.
   */
  recommendModels: (
    privacyRoute: 'provider_zdr' | 'external',
    preference: 'fast' | 'balanced' | 'best',
    taskKind?: ModelTaskKind
  ) => {
    const query = new URLSearchParams({ privacyRoute, preference });
    if (taskKind !== undefined) query.set('taskKind', taskKind);
    return request<
      Array<{ modelId: string; displayName: string; score: number; reasons?: string[] }>
    >(`/v1/models/recommend?${query}`);
  },
  task: (id: string) => request<Task>(`/v1/tasks/${id}`),
  taskPlan: (id: string) => request<TaskPlan | null>(`/v1/tasks/${id}/plan`),
  taskPlans: (id: string) => request<TaskPlan[]>(`/v1/tasks/${id}/plans`),
  updateTaskPlan: (
    id: string,
    body: {
      expectedVersion: number;
      parentVersion?: number;
      branchName: string;
      steps: TaskPlanStep[];
    }
  ) => request<TaskPlan>(`/v1/tasks/${id}/plan`, mutation('POST', body)),
  /**
   * A window onto one conversation's trajectory, always oldest first.
   *
   * This took `after` and nothing else, so the only window this client could ask for was "the whole
   * of it from here" - and opening a conversation asked from zero. The route has answered `limit`
   * and `before` all along, backed by two store methods nothing called: `limit` alone is the newest
   * page, which is what opening wants, and `before` is the page immediately preceding a sequence,
   * which is how a reader walks back into history. Naming none of the three still returns
   * everything, which is what the catch-up poll wants once it already holds a cursor.
   */
  events: (
    id: string,
    window: { after?: number; before?: number; limit?: number } = {}
  ): Promise<TaskEvent[]> => {
    const query = new URLSearchParams();
    if (window.after !== undefined) query.set('after', String(window.after));
    if (window.before !== undefined) query.set('before', String(window.before));
    if (window.limit !== undefined) query.set('limit', String(window.limit));
    return request<TaskEvent[]>(
      `/v1/tasks/${encodeURIComponent(id)}/events${query.size ? `?${query}` : ''}`
    );
  },
  taskAction: (id: string, action: 'pause' | 'resume' | 'cancel') =>
    request<Task>(`/v1/tasks/${id}/${action}`, mutation('POST', {})),
  createEnrollment: (label: string) =>
    request<{ id: string; expiresAt: string; uri: string; webUri: string }>(
      '/v1/devices/enrollments',
      mutation('POST', { label })
    ),
  /**
   * The device links minted in the last week and what became of each.
   *
   * Minting one and revoking one were both reachable and the list between them was not, so an
   * owner who made a link and walked away had no way to see whether it was still open, whether it
   * had been redeemed, or by which of the several they made. A grant that adds a credential to this
   * account is exactly the thing that should be countable.
   */
  enrollments: () =>
    request<
      Array<{
        id: string;
        label: string;
        createdAt: string;
        expiresAt: string;
        status: 'pending' | 'used' | 'expired' | 'revoked';
      }>
    >('/v1/devices/enrollments'),
  revokeEnrollment: (id: string) =>
    request<{ revoked: boolean }>(`/v1/devices/enrollments/${id}`, mutation('DELETE', {})),
  /**
   * Rename a conversation, hold it above the list, or file it away — one route, one wrapper.
   *
   * The server refuses a patch that would change nothing, so every caller names at least one of
   * them. Pinning and filing were reachable through this route and through nothing in this client,
   * which is why the sidebar sorted by recency alone while the contract said pinned rows sit above
   * it.
   */
  updateTask: (id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) =>
    request<Task>(`/v1/tasks/${id}`, mutation('PATCH', patch)),
  deleteTask: (id: string) =>
    request<{ deleted: boolean }>(`/v1/tasks/${id}`, mutation('DELETE', {})),
  updateTaskSecurityMode: (id: string, securityMode: SecurityMode) =>
    request<Task>(`/v1/tasks/${id}/security-mode`, mutation('PATCH', { securityMode })),
  /**
   * The questions the agent stopped to ask, and — asked for by status — the answers already given.
   *
   * Pending is the default and stays the default, because that is the list with something to
   * answer and it is what every existing caller means. The other three are the record: an approval
   * that lapsed is exactly what a returning owner is looking for, since it explains why a task is
   * paused and the wording of what was asked is the only account of it that exists.
   *
   * `cursor` is the `cursor` field of the last row of the previous page, not a count: approvals
   * raised by one turn share a timestamp, so a position made of the timestamp alone would skip
   * every row that tied with the last one shown.
   */
  approvals: (
    status?: 'pending' | 'approved' | 'denied' | 'expired',
    limit?: number,
    cursor?: string
  ) => {
    const query = new URLSearchParams();
    if (status !== undefined) query.set('status', status);
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor !== undefined) query.set('cursor', cursor);
    return request<Approval[]>(`/v1/approvals${query.size ? `?${query}` : ''}`);
  },
  resolveApproval: (id: string, decision: 'approve' | 'deny') =>
    request(`/v1/approvals/${id}/${decision}`, mutation('POST', {})),
  files: (workspaceId: string, path = 'workspace') =>
    request<{ entries: FileEntry[] }>(
      `/v1/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`
    ),
  file: (workspaceId: string, path: string) =>
    request<ArrayBuffer>(`/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`),
  /**
   * The same read as `file`, plus what the machine says it read.
   *
   * A separate method rather than a wider return from `file`, because `file` has callers that want
   * the bytes and nothing else, and widening what they already destructure is how a shape change
   * becomes eight of them. What this adds is `sha256`: the digest of what was on disk at the
   * moment of the read, which is the value `writeFile` sends back as `expectSha256` so the write
   * can be refused if the agent changed the file in between.
   *
   * Null when the answer was a window rather than the whole file: the runner computes the digest
   * over what it read, and a digest of lines 40-80 is not a claim about the file. A caller asking
   * for a window is reading, not preparing to overwrite.
   */
  readFile: async (
    workspaceId: string,
    path: string,
    window: { startLine?: number; endLine?: number; maxBytes?: number } = {}
  ) => {
    const query = new URLSearchParams();
    for (const key of ['startLine', 'endLine', 'maxBytes'] as const)
      if (window[key] !== undefined) query.set(key, String(window[key]));
    const response = await fetch(
      `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}${
        query.size ? `&${query}` : ''
      }`,
      {
        credentials: 'include',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; requestId?: string };
      };
      throw new ApiFailure(
        body.error?.code ?? 'request_failed',
        body.error?.message ?? `Request failed (${response.status})`,
        response.status,
        body.error?.requestId
      );
    }
    const number = (header: string): number | null => {
      const value = response.headers.get(header);
      return value === null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
    };
    return {
      bytes: await response.arrayBuffer(),
      sha256: response.headers.get('x-content-sha256'),
      startLine: number('x-start-line'),
      endLine: number('x-end-line'),
      fileBytes: number('x-file-bytes'),
      totalLines: number('x-total-lines'),
      nextStartLine: number('x-next-start-line'),
      truncated: response.headers.get('x-truncated') === 'true'
    };
  },
  /**
   * `expectSha256` is the digest `readFile` returned, sent back as a claim about what is being
   * replaced. The runner checks it under the write's own descriptor and refuses with `file_changed`
   * if the file moved underneath — which on this computer is the ordinary case, not the edge, since
   * the agent is usually still working in the tree the owner is editing. Without it the later write
   * wins in silence and the agent's work is simply gone.
   */
  writeFile: (workspaceId: string, path: string, content: Uint8Array, expectSha256?: string) =>
    request(
      `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}${
        expectSha256 === undefined ? '' : `&expectSha256=${encodeURIComponent(expectSha256)}`
      }`,
      {
        method: 'PUT',
        body: content.buffer as ArrayBuffer,
        headers: { 'idempotency-key': crypto.randomUUID() }
      }
    ),
  /**
   * The same write as `writeFile`, reported as it goes and cancellable while it runs.
   *
   * `fetch` cannot report upload progress — there is no request-body stream event — so this is the
   * one place the older transport earns its keep. A 49 MiB attachment over a home upstream link is
   * minutes long, and the composer used to show nothing at all for the whole of it.
   */
  uploadFile: (
    workspaceId: string,
    path: string,
    content: Uint8Array,
    onProgress?: (fraction: number) => void
  ): { done: Promise<void>; cancel: () => void } => {
    const transfer = new XMLHttpRequest();
    const done = new Promise<void>((resolve, reject) => {
      transfer.open(
        'PUT',
        `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`,
        true
      );
      transfer.withCredentials = true;
      transfer.setRequestHeader('content-type', 'application/octet-stream');
      transfer.setRequestHeader('idempotency-key', crypto.randomUUID());
      transfer.responseType = 'text';
      transfer.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
      transfer.onload = () => {
        if (transfer.status >= 200 && transfer.status < 300) {
          onProgress?.(1);
          resolve();
          return;
        }
        const body = (() => {
          try {
            return JSON.parse(transfer.responseText) as {
              error?: { code?: string; message?: string; requestId?: string };
            };
          } catch {
            return {};
          }
        })();
        reject(
          new ApiFailure(
            body.error?.code ?? 'request_failed',
            body.error?.message ?? `Upload failed (${transfer.status})`,
            transfer.status,
            body.error?.requestId
          )
        );
      };
      transfer.onerror = () => reject(new TypeError('Failed to fetch'));
      transfer.onabort = () => {
        const aborted = new Error('Upload cancelled');
        aborted.name = 'AbortError';
        reject(aborted);
      };
      transfer.send(content.buffer as ArrayBuffer);
    });
    return { done, cancel: () => transfer.abort() };
  },
  deleteFile: (workspaceId: string, path: string) =>
    request<void>(`/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: { 'idempotency-key': crypto.randomUUID() }
    }),
  /** Rename or move within the workspace. `to` is a full path, so this covers both. */
  renameFile: (workspaceId: string, from: string, to: string) =>
    request<{ path: string }>(
      `/v1/workspaces/${workspaceId}/files/rename`,
      mutation('POST', { from, to })
    ),
  createFolder: (workspaceId: string, path: string) =>
    request<{ path: string }>(
      `/v1/workspaces/${workspaceId}/files/folder`,
      mutation('POST', { path })
    ),
  workspaceBrief: (workspaceId: string) =>
    request<{ markdown: string; path: string }>(`/v1/workspaces/${workspaceId}/brief`),
  updateWorkspaceBrief: (workspaceId: string, markdown: string) =>
    request<{ markdown: string; path: string }>(
      `/v1/workspaces/${workspaceId}/brief`,
      mutation('PUT', { markdown })
    ),
  /**
   * The owner's own block, which is addressed to the person rather than to a computer.
   *
   * No workspace id in either path, deliberately: everything else in this section is about the box
   * the owner happens to have open, and this text outlives every box they ever make.
   */
  ownerBlock: () => request<OwnerBlock>('/v1/account/memory-block'),
  /**
   * Saves the whole block, or is refused.
   *
   * `expectedVersion` is the version this screen loaded. Sending it is what turns "the other tab
   * saved first" into a message the owner can act on instead of a silent overwrite of whichever
   * text they typed second.
   */
  saveOwnerBlock: (text: string, expectedVersion: number) =>
    request<OwnerBlock>('/v1/account/memory-block', mutation('PUT', { text, expectedVersion })),
  memories: (workspaceId: string) =>
    request<WorkspaceMemory[]>(`/v1/workspaces/${workspaceId}/memories`),
  addMemory: (
    workspaceId: string,
    body: { target: 'workspace' | 'user'; content: string; validUntil?: string }
  ) => request<WorkspaceMemory>(`/v1/workspaces/${workspaceId}/memories`, mutation('POST', body)),
  /**
   * Correct a line the box holds about the owner, rather than deleting it and typing it again.
   *
   * The route has taken this patch for as long as the list has existed and nothing in this client
   * called it, so the only way to fix a wrong word in a remembered instruction was to remove the
   * line and lose the record that it had ever been there. An explicit `null` on `validUntil` makes
   * the line permanent; omitting it keeps whatever expiry it already had.
   */
  updateMemory: (
    workspaceId: string,
    memoryId: string,
    patch: { content: string; validUntil?: string | null }
  ) =>
    request<WorkspaceMemory>(
      `/v1/workspaces/${workspaceId}/memories/${memoryId}`,
      mutation('PATCH', patch)
    ),
  deleteMemory: (workspaceId: string, memoryId: string) =>
    request<{ deleted: boolean }>(
      `/v1/workspaces/${workspaceId}/memories/${memoryId}`,
      mutation('DELETE', {})
    ),
  memoryItems: (workspaceId: string, limit: number) =>
    request<MemoryItem[]>(`/v1/workspaces/${workspaceId}/memory-items?limit=${limit}`),
  /**
   * The review queue: what the box has stopped being sure of, and why.
   *
   * Two lists because they are two questions. `procedures` is "this remembered command may no
   * longer work" — either nobody has confirmed it in a season (`unverified`) or it lost more of its
   * last five uses than it won (`failing`), with `recentOkCount` of `recentGradedCount` as the
   * evidence. `disputed` is "two things you said contradict each other", and carries `contradicts`
   * because naming a dispute without naming the other side is not something a person can act on.
   *
   * The projection is wider than `memoryItems` on purpose: which conversation wrote it, when it was
   * last confirmed and what it has been worth are exactly the fields a decision rests on, and the
   * narrower route has no use for them. Provenance is not among them any more - `memoryItems`
   * carries `trust` and `origin` too, because where a row came from is a fact about the row rather
   * than about the decision.
   */
  memoryReview: (workspaceId: string, options: { staleDays?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.staleDays !== undefined) query.set('staleDays', String(options.staleDays));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return request<MemoryReview>(
      `/v1/workspaces/${workspaceId}/memory-review${query.size ? `?${query}` : ''}`
    );
  },
  /** "This is still right." Moves the procedure out of the queue by moving the clock it reads. */
  verifyMemoryItem: (workspaceId: string, itemId: string) =>
    request<{ verified: boolean }>(
      `/v1/workspaces/${workspaceId}/memory-items/${itemId}/verify`,
      mutation('POST', {})
    ),
  /**
   * "Stop believing this", which is not "delete this". `deleteMemoryItem` next door removes the row
   * and every trace of it, which is what an owner means when they say a line is gone; retracting
   * keeps the row, stops it being recalled, and records that it stopped being true. Both exist
   * because they are different decisions.
   */
  retractMemoryItem: (workspaceId: string, itemId: string) =>
    request<{ retracted: boolean }>(
      `/v1/workspaces/${workspaceId}/memory-items/${itemId}/retract`,
      mutation('POST', {})
    ),
  deleteMemoryItem: (workspaceId: string, itemId: string) =>
    request<{ deleted: boolean }>(
      `/v1/workspaces/${workspaceId}/memory-items/${itemId}`,
      mutation('DELETE', {})
    ),
  /**
   * "No, don't remember that", about a rule that is not a memory yet.
   *
   * Durable, and deliberately not a delete on the box's side: the refusal is kept so the same
   * sentence is refused the next time it is put forward, rather than reappearing every night.
   */
  dismissMemoryProposal: (workspaceId: string, proposalId: string) =>
    request<{ dismissed: number }>(
      `/v1/workspaces/${workspaceId}/memory-proposals/dismiss`,
      mutation('POST', { proposal: proposalId })
    ),
  /**
   * The same refusal said once about the whole group, which is the unit the owner judges in.
   *
   * The handles are sent rather than a "refuse everything open" flag, and the difference is a
   * proposal written between the screen being drawn and the button being pressed: a flag would
   * refuse it permanently without anybody having seen it, which is the one thing a durable refusal
   * must never do. The answer is how many of the named rows were still open and are now refused;
   * the ones that resolved to nothing had already gone.
   */
  dismissMemoryProposals: (workspaceId: string, proposalIds: readonly string[]) =>
    request<{ dismissed: number }>(
      `/v1/workspaces/${workspaceId}/memory-proposals/dismiss`,
      mutation('POST', { proposals: [...proposalIds] })
    ),
  skills: (workspaceId: string) =>
    request<WorkspaceSkill[]>(`/v1/workspaces/${workspaceId}/skills`),
  saveSkill: (workspaceId: string, body: { name: string; description: string; content: string }) =>
    request<WorkspaceSkill>(`/v1/workspaces/${workspaceId}/skills`, mutation('POST', body)),
  /**
   * Pin a learned procedure above the curation that would archive it, file it away, or turn it off.
   *
   * `pinned` and `status` are what the route has always taken. `enabled` is the one the owner has
   * needed and never had: the column has a reader — a disabled skill is dropped from the model's
   * own index — and until the server half of this lands it has no writer, so the approval card that
   * says "You had turned X off. Approving this switches it back on" describes a state nothing could
   * reach. It is named here because the door is the same door, and a client that sends it against
   * a box that has not caught up is refused rather than answered 200 and ignored.
   */
  setSkillState: (
    workspaceId: string,
    skillId: string,
    patch: { enabled?: boolean; pinned?: boolean; status?: 'active' | 'stale' | 'archived' }
  ) =>
    request<WorkspaceSkill>(
      `/v1/workspaces/${workspaceId}/skills/${skillId}`,
      mutation('PATCH', patch)
    ),
  deleteSkill: (workspaceId: string, skillId: string) =>
    request<{ deleted: boolean }>(
      `/v1/workspaces/${workspaceId}/skills/${skillId}`,
      mutation('DELETE', {})
    ),
  browserToken: async (workspaceId: string) => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/browser-token`
    );
    return { ...result, runnerUrl: runnerUrlForClient(result.runnerUrl) };
  },
  browserPrivateAction: async (workspaceId: string, action: unknown) => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/browser-token`
    );
    const { token } = result;
    const runnerUrl = runnerUrlForClient(result.runnerUrl);
    const baseUrl = runnerUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/$/, '');
    const target = new URL(
      `${baseUrl}/v1/workspaces/${workspaceId}/browser/action`,
      window.location.href
    );
    // A cross-origin runner is proxied through this API rather than reached directly. It used to
    // refuse `text_input` here, on the ground that private text wants a same-origin route — but
    // the Inspector sends over the surface socket whenever one is open and only falls back to this
    // when it has dropped, and that socket goes to the same cross-origin runner with no such
    // check. The refusal therefore protected nothing: it fired on a reconnect and never on the
    // path the text actually took. Removed rather than mirrored onto the socket, because the
    // restriction it stated was not one this client was keeping.
    if (target.origin !== window.location.origin)
      return request(`/v1/workspaces/${workspaceId}/browser/action`, mutation('POST', action));
    const response = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(action)
    });
    if (!response.ok)
      throw new ApiFailure(
        'browser_input_failed',
        `Cloud browser input failed (${response.status})`
      );
    return (await response.json()) as unknown;
  },
  browserPrivateHolder: async (workspaceId: string, holder: 'agent' | 'user' | 'secure_input') => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/browser-token`
    );
    const { token } = result;
    const runnerUrl = runnerUrlForClient(result.runnerUrl);
    const baseUrl = runnerUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/$/, '');
    const target = new URL(
      `${baseUrl}/v1/workspaces/${workspaceId}/browser/holder`,
      window.location.href
    );
    if (target.origin !== window.location.origin)
      return request(`/v1/workspaces/${workspaceId}/browser/holder`, mutation('POST', { holder }));
    const response = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ holder })
    });
    if (!response.ok)
      throw new ApiFailure(
        'browser_takeover_failed',
        `Could not transfer browser control (${response.status})`
      );
    return (await response.json()) as unknown;
  },
  desktopSnapshot: (workspaceId: string) =>
    request<DesktopSnapshot>(`/v1/workspaces/${workspaceId}/desktop/snapshot`, {
      method: 'POST',
      body: '{}'
    }),
  desktopToken: async (workspaceId: string) => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/desktop-token`
    );
    return { ...result, runnerUrl: runnerUrlForClient(result.runnerUrl) };
  },
  desktopPrivateAction: async (workspaceId: string, action: unknown) => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/desktop-token`
    );
    const { token } = result;
    const runnerUrl = runnerUrlForClient(result.runnerUrl);
    const baseUrl = runnerUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/$/, '');
    const target = new URL(
      `${baseUrl}/v1/workspaces/${workspaceId}/desktop/action`,
      window.location.href
    );
    // The same removal as the browser surface above, for the same reason: the refusal could only
    // ever fire on the fallback, and the socket it falls back from carried the identical text to
    // the identical cross-origin runner unchecked.
    if (target.origin !== window.location.origin)
      return request(`/v1/workspaces/${workspaceId}/desktop/action`, mutation('POST', action));
    const response = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(action)
    });
    if (!response.ok)
      throw new ApiFailure(
        'desktop_input_failed',
        `The agent computer would not take that input (${response.status})`
      );
    return (await response.json()) as unknown;
  },
  desktopPrivateHolder: async (workspaceId: string, holder: 'agent' | 'user' | 'secure_input') => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/desktop-token`
    );
    const { token } = result;
    const runnerUrl = runnerUrlForClient(result.runnerUrl);
    const baseUrl = runnerUrl
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/$/, '');
    const target = new URL(
      `${baseUrl}/v1/workspaces/${workspaceId}/desktop/holder`,
      window.location.href
    );
    if (target.origin !== window.location.origin)
      return request(`/v1/workspaces/${workspaceId}/desktop/holder`, mutation('POST', { holder }));
    const response = await fetch(target, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ holder })
    });
    if (!response.ok)
      throw new ApiFailure(
        'desktop_takeover_failed',
        `Could not transfer control of the agent computer (${response.status})`
      );
    return (await response.json()) as unknown;
  },
  terminalToken: async (workspaceId: string) => {
    const result = await request<{ runnerUrl: string; token: string }>(
      `/v1/workspaces/${workspaceId}/terminal-token`
    );
    return { ...result, runnerUrl: runnerUrlForClient(result.runnerUrl) };
  },
  /** What the computer is running in the background, as the machine itself reports it. */
  workspaceProcesses: async (workspaceId: string) =>
    (await request<{ processes: BackgroundProcess[] }>(`/v1/workspaces/${workspaceId}/processes`))
      .processes,
  /** Stop one of them. A service stopped here is forgotten, so it does not come back on restart. */
  stopWorkspaceProcess: async (workspaceId: string, sessionId: string) => {
    await request(
      `/v1/workspaces/${workspaceId}/processes/${encodeURIComponent(sessionId)}`,
      mutation('POST', { action: 'kill' })
    );
  },
  previews: async (workspaceId: string) =>
    (await request<WorkspacePreview[]>(`/v1/workspaces/${workspaceId}/previews`)).map(
      previewForClient
    ),
  createPreview: async (workspaceId: string, body: unknown) =>
    previewForClient(
      await request<WorkspacePreview>(
        `/v1/workspaces/${workspaceId}/previews`,
        mutation('POST', body)
      )
    ),
  previewAccess: async (id: string) =>
    previewForClient(
      await request<WorkspacePreview>(`/v1/previews/${id}/access`, mutation('POST', {}))
    ),
  /** One way to publish: an address anyone holding it can open, up until it is taken down. */
  publishPreview: async (id: string) =>
    previewForClient(
      await request<WorkspacePreview & { warning: string }>(
        `/v1/previews/${id}/publish`,
        mutation('POST', { confirmPublic: true })
      )
    ),
  unpublishPreview: async (id: string) =>
    previewForClient(
      await request<WorkspacePreview>(`/v1/previews/${id}/unpublish`, mutation('POST', {}))
    ),
  /** What the box has written down about the parts of itself the API does not run. */
  instanceDiagnostics: () =>
    request<{
      certificate: { failedAt: string; reason: string } | null;
      dynamicDns: { failedAt: string; reason: string } | null;
      /** The last backup run and the newest copy it left. Absent from a box older than this field. */
      backup?: BackupStatus | null;
      /** Which build is answering. Absent from a box older than this field. */
      build?: BuildIdentity;
    }>('/v1/instance/diagnostics'),
  revokePreview: (id: string) =>
    request<{ revoked: boolean }>(`/v1/previews/${id}`, mutation('DELETE', {})),
  artifacts: (workspaceId: string) =>
    request<Artifact[]>(`/v1/workspaces/${workspaceId}/artifacts`),
  deleteArtifact: (id: string) =>
    request<{ deleted: boolean }>(`/v1/artifacts/${id}`, mutation('DELETE', {})),
  connectors: () => request<Connector[]>('/v1/connectors'),
  connectorCatalog: () => request<ConnectorDefinition[]>('/v1/connectors/catalog'),
  connectorAudit: () => request<ConnectorAuditEvent[]>('/v1/connectors/audit?limit=30'),
  addConnector: (body: unknown) => request<Connector>('/v1/connectors', mutation('POST', body)),
  /** Asks the account itself whether the stored credential still works; nothing is revealed. */
  testConnector: (id: string) =>
    request<ConnectorTestResult>(`/v1/connectors/${id}/test`, mutation('POST', {})),
  startMcpOAuth: (body: {
    label: string;
    baseUrl: string;
    scopes: Connector['scopes'];
    oauthScopes: string[];
    registration: 'dynamic' | 'static';
    clientId?: string;
    clientSecret?: string;
  }) =>
    request<{ authorizationUrl: string; authorizationHost: string; expiresAt: string }>(
      '/v1/connectors/mcp/oauth/start',
      mutation('POST', body)
    ),
  revokeConnector: (id: string) =>
    request<{ revoked: boolean }>(`/v1/connectors/${id}`, mutation('DELETE', {})),
  usage: () => request<UsageResponse>('/v1/usage'),
  /**
   * Null rather than a throw when the server has no spend route: the caps are a newer surface than
   * the usage totals, and a box that predates them should still show what it has actually spent.
   */
  spend: async (): Promise<SpendSummary | null> => {
    try {
      return await request<SpendSummary>('/v1/spend');
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) return null;
      throw cause;
    }
  },
  spendLimits: () => request<SpendLimits>('/v1/spend-limits'),
  // An omitted field is left alone and an explicit null clears that cap, so the body is sent as
  // written rather than merged with the current values.
  updateSpendLimits: (body: UpdateSpendLimitsRequest) =>
    request<SpendLimits>('/v1/spend-limits', mutation('PUT', body)),
  notificationConfig: () =>
    request<{ enabled: boolean; publicKey: string | null }>('/v1/notifications/config'),
  subscribeNotifications: (body: PushSubscriptionJSON) =>
    request<{ id: string; enabled: boolean }>(
      '/v1/notifications/subscriptions',
      mutation('POST', body)
    ),
  unsubscribeNotifications: (endpoint: string) =>
    request<{ enabled: boolean }>(
      '/v1/notifications/subscriptions',
      mutation('DELETE', { endpoint })
    ),
  /**
   * Null rather than a throw on a server with no settings route, matching `spend`: per-kind
   * switches and quiet hours are only meaningful if the server honours them, so a box that cannot
   * store them shows no controls for them instead of controls that quietly do nothing.
   */
  notificationSettings: async (): Promise<NotificationSettings | null> => {
    try {
      return notificationSettingsFromResponse(await request<unknown>('/v1/notifications/settings'));
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) return null;
      throw cause;
    }
  },
  /**
   * Everything athanor has raised for itself, newest first. Null rather than a throw on a box that
   * has no route for it, the same way the spend report is: an older box shows no list rather than
   * an error where a list would have been.
   */
  agentNotifications: async (): Promise<AgentNotification[] | null> => {
    try {
      return readNotices(await request<unknown>('/v1/notifications/agent?limit=50'));
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) return null;
      throw cause;
    }
  },
  updateNotificationSettings: async (body: UpdateNotificationSettingsRequest) =>
    notificationSettingsFromResponse(
      await request<unknown>('/v1/notifications/settings', mutation('PUT', body))
    ),
  /**
   * What the agent may generate on the owner's provider account, and what it may not.
   *
   * Read rather than written: there is no second console for starting a generation. The owner asks
   * the agent, and this is where they see what that costs and what is refused.
   */
  /**
   * Null rather than a throw on a server with no relay route, matching `spend`: the relay is a
   * newer surface than the rest of Settings, and a box that predates it should show nothing about
   * it rather than an error the owner can do nothing with.
   */
  relay: async (): Promise<RelayReport | null> => {
    try {
      return await request<RelayReport>('/v1/relay');
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) return null;
      throw cause;
    }
  },
  enrollRelay: (body: { host: string; token: string; address?: string | null; port?: number }) =>
    request<RelayReport>('/v1/relay/enrollment', mutation('POST', body)),
  setRelayEnabled: (enabled: boolean) =>
    request<RelayReport>('/v1/relay', mutation('PATCH', { enabled })),
  forgetRelay: () => request<RelayReport>('/v1/relay', mutation('DELETE', {})),
  privacyExport: () => request<Record<string, unknown>>('/v1/privacy/export'),
  deleteAccount: (confirmUsername: string) =>
    request('/v1/account', mutation('DELETE', { confirmUsername }))
};
