import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AthanorError,
  MEMORY_PACK_BUDGET_TOKENS,
  MEMORY_FUZZY_SIMILARITY_THRESHOLD,
  MEMORY_PACK_DEFAULT_QUOTA,
  MEMORY_PACK_QUOTAS,
  MEMORY_PREDICATES,
  MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
  MEMORY_PROCEDURE_STALE_DAYS,
  assertTimeZone,
  decryptJson,
  evaluateSpendCaps,
  isMemoryToken,
  localDayKey,
  memoryPredicate,
  readRoutingMetadata,
  roundUsd,
  spendWindowBounds,
  unwrapDataKey
} from '@athanor/core';
import type {
  EncryptedEnvelope,
  MemoryItemIndex,
  MemoryKind,
  MemoryPackQuota,
  MemoryQueryPlan,
  MemoryStatus,
  MemoryTrust,
  SpendWindowInput
} from '@athanor/core';
import {
  DEFAULT_SPEND_WARN_PERCENT,
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  MAX_WORKSPACE_PREVIEWS,
  PREVIEW_IDLE_EXPIRY_DAYS,
  TaskEventKind
} from '@athanor/contracts';
import type {
  NotificationKind,
  SpendBucket,
  SpendDecision,
  SpendLimits,
  SpendSummary
} from '@athanor/contracts';
import type { Database } from './database.js';
import type {
  AgentNotificationRecord,
  ConnectorAuditRecord,
  ConnectorOAuthAttemptRecord,
  ConnectorRecord,
  ApiTokenRecord,
  ManagedProviderCredentialRecord,
  PasskeyRecord,
  PendingNotificationRecord,
  PushSubscriptionRecord,
  SpendAlertRecord,
  SpendLimitsRecord,
  TaskEventRecord,
  TaskMessageQueueRecord,
  TaskPlanRecord,
  TaskRecord,
  TaskScheduleRecord,
  UserRecord,
  WorkspaceCheckpointRecord,
  WorkspaceMemoryRecord,
  WorkspacePreviewRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from './types.js';

/** Bound as a parameter and cast, so the window is one number in one place rather than SQL text. */
const PREVIEW_IDLE_INTERVAL = `${PREVIEW_IDLE_EXPIRY_DAYS} days`;

/**
 * How far back the notifier still looks for something to say, and how long the ledger row that
 * stops it saying it twice is kept. The second is comfortably longer than the first, so a delivery
 * record is only ever dropped once the thing it settled has fallen out of consideration entirely.
 */
const NOTIFICATION_CANDIDATE_INTERVAL = '14 days';
const NOTIFICATION_LEDGER_INTERVAL = '30 days';

const iso = (value: unknown): string => new Date(String(value)).toISOString();
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
/** Guards the one lookup whose ids arrive as model-written text rather than from a prior row. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optionalText = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : null;

/** A nullable numeric column. Zero is a real ceiling, so only NULL may collapse to null. */
const numericOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const providerRefModelId = (providerRef: string | undefined): string | null => {
  const separator = providerRef?.indexOf(':') ?? -1;
  return providerRef && separator > 0 ? providerRef.slice(separator + 1) : null;
};

/** Statuses in which a task can still spend, which is what a start-time cap has to price in. */
const OPEN_TASK_STATUSES =
  "('draft','queued','planning','running','awaiting_user','awaiting_resource','paused')";

const encryptedText = (
  value: unknown
): { ciphertext: EncryptedEnvelope | null; legacy: string | null } => {
  try {
    const parsed = json<Partial<EncryptedEnvelope>>(value);
    if (
      parsed.v === 1 &&
      typeof parsed.iv === 'string' &&
      typeof parsed.tag === 'string' &&
      typeof parsed.ciphertext === 'string'
    ) {
      return { ciphertext: parsed as EncryptedEnvelope, legacy: null };
    }
  } catch {
    // Rows created before encrypted titles remain readable during migration.
  }
  return { ciphertext: null, legacy: optionalText(value) };
};

const mapUser = (row: Record<string, unknown>): UserRecord => ({
  id: String(row.id),
  username: String(row.username),
  displayName: String(row.display_name),
  recoveryHash: optionalText(row.recovery_hash),
  preferences:
    row.preferences && typeof row.preferences === 'object'
      ? (row.preferences as Record<string, unknown>)
      : {},
  createdAt: iso(row.created_at)
});

const mapWorkspace = (row: Record<string, unknown>): WorkspaceRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  name: String(row.name),
  status: String(row.status),
  storageBytes: Number(row.storage_bytes),
  storageLimitBytes: Number(row.storage_limit_bytes),
  imageRevision: String(row.image_revision),
  region: String(row.region),
  keyProtection: (optionalText(row.wrapping_mode) ?? 'hosted') as WorkspaceRecord['keyProtection'],
  securityMode: (optionalText(row.security_mode) ?? 'balanced') as WorkspaceRecord['securityMode'],
  runnerRef: optionalText(row.runner_ref),
  computeMeteredAt: row.compute_metered_at ? iso(row.compute_metered_at) : null,
  ...(optionalText(row.wrapped_key) ? { wrappedKey: optionalText(row.wrapped_key)! } : {}),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapTask = (row: Record<string, unknown>): TaskRecord => {
  const title = encryptedText(row.title);
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    parentTaskId: optionalText(row.parent_task_id),
    branchedFromEventId: optionalText(row.branched_from_event_id),
    forkKind: optionalText(row.fork_kind) as TaskRecord['forkKind'],
    rewindScope: optionalText(row.rewind_scope) as TaskRecord['rewindScope'],
    restoredCheckpointId: optionalText(row.restored_checkpoint_id),
    titleCiphertext: title.ciphertext,
    legacyTitle: title.legacy,
    titleSource: (optionalText(row.title_source) ?? 'prompt') as TaskRecord['titleSource'],
    pinned: Boolean(row.pinned),
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
    status: String(row.status),
    modelId: String(row.model_id),
    privacyRoute: String(row.privacy_route),
    securityMode: (optionalText(row.security_mode) ?? 'balanced') as TaskRecord['securityMode'],
    maxComputeCredits: Number(row.max_compute_credits),
    actualComputeCredits: Number(row.actual_compute_credits),
    maxSpendUsd: numericOrNull(row.max_spend_usd),
    spentUsd: Number(row.spent_usd ?? 0),
    queuedMessageCount: Number(row.queued_message_count ?? 0),
    promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
    agentStateCiphertext: row.agent_state_ciphertext
      ? json<EncryptedEnvelope>(row.agent_state_ciphertext)
      : null,
    leaseOwner: optionalText(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
    attempt: Number(row.attempt),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
};

const mapWorkspaceCheckpoint = (row: Record<string, unknown>): WorkspaceCheckpointRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  taskId: optionalText(row.task_id),
  turn: Number(row.turn),
  eventSequence: numericOrNull(row.event_sequence),
  mechanism: String(row.mechanism) as WorkspaceCheckpointRecord['mechanism'],
  fileCount: numericOrNull(row.file_count),
  totalBytes: numericOrNull(row.total_bytes),
  storedBytes: Number(row.stored_bytes),
  durationMs: Number(row.duration_ms),
  createdAt: iso(row.created_at)
});

const mapTaskMessage = (row: Record<string, unknown>): TaskMessageQueueRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  userId: String(row.user_id),
  promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
  modelId: String(row.model_id),
  privacyRoute: String(row.privacy_route),
  maxComputeCredits: Number(row.max_compute_credits),
  maxSpendUsd: numericOrNull(row.max_spend_usd),
  resourceClass: String(row.resource_class),
  reservationKey: String(row.reservation_key),
  status: String(row.status) as TaskMessageQueueRecord['status'],
  interrupt: row.interrupt === true,
  createdAt: iso(row.created_at),
  promotedAt: row.promoted_at ? iso(row.promoted_at) : null
});

const mapTaskSchedule = (row: Record<string, unknown>): TaskScheduleRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  titleCiphertext: json<EncryptedEnvelope>(row.title_ciphertext),
  promptCiphertext: json<EncryptedEnvelope>(row.prompt_ciphertext),
  modelId: String(row.model_id),
  privacyRoute: String(row.privacy_route),
  maxComputeCredits: Number(row.max_compute_credits),
  maxSpendUsd: numericOrNull(row.max_spend_usd),
  spec: json<TaskScheduleRecord['spec']>(row.spec),
  enabled: Boolean(row.enabled),
  nextRunAt: row.next_run_at ? iso(row.next_run_at) : null,
  lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
  lastTaskId: optionalText(row.last_task_id),
  lastErrorCode: optionalText(row.last_error_code),
  leaseOwner: optionalText(row.lease_owner),
  leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapTaskEvent = (row: Record<string, unknown>): TaskEventRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  sequence: Number(row.sequence),
  kind: TaskEventKind.parse(row.kind),
  summary: String(row.summary),
  payloadCiphertext: row.payload_ciphertext
    ? json<EncryptedEnvelope>(row.payload_ciphertext)
    : null,
  createdAt: iso(row.created_at)
});

/** A page a phone on cellular can actually receive; the cursor is what reaches the rest. */
const MAX_TASK_EVENT_PAGE = 500;

/**
 * The owner's notification preferences as they are stored: kinds by their wire names, and quiet
 * hours as minutes past local midnight. The zone those minutes are read in is the one on
 * `spend_limits` - there is one answer on this box to when the owner's day rolls over.
 */
export interface StoredNotificationSettings {
  kinds: Record<NotificationKind, boolean>;
  quietHours: { startMinute: number; endMinute: number } | null;
  quietHoursAllowApprovals: boolean;
}

/**
 * A conversation's own name, for a notification that would otherwise have to say "a task".
 *
 * Failure is expected rather than exceptional here: a workspace whose key is held elsewhere, an
 * older row, a title written under a different context. All of those mean "no title", never a
 * notification that does not get sent.
 */
const decryptTaskTitle = (row: Record<string, unknown>, masterKey: Uint8Array): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  if (!row.title_ciphertext || !wrappedKey || !workspaceId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.title_ciphertext);
    return decryptJson<{ title: string }>(envelope, key, `task-title:${workspaceId}`).title;
  } catch {
    return null;
  }
};

/**
 * The additional data an agent-raised notification is sealed with. Bound to the conversation, so a
 * message lifted onto another task's row will not decrypt rather than being read out under the
 * wrong name.
 */
export const agentNotificationAad = (taskId: string): string => `agent-notification:${taskId}`;

/**
 * The sentence the agent asked to have pushed, unsealed here for the same reason the title is:
 * this is the only layer holding both the envelope and the key that opens it.
 *
 * A message that will not decrypt comes back null, and the notifier words the push from the
 * conversation name alone - a notification the owner can still act on beats one that never arrives.
 */
const decryptAgentMessage = (
  row: Record<string, unknown>,
  masterKey: Uint8Array
): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  const taskId = optionalText(row.task_id);
  if (!row.message_ciphertext || !wrappedKey || !workspaceId || !taskId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.message_ciphertext);
    return decryptJson<{ message: string }>(envelope, key, agentNotificationAad(taskId)).message;
  } catch {
    return null;
  }
};

/** Payload is the task id, so a stream only wakes for the conversation it is showing. */
const TASK_EVENT_CHANNEL = 'athanor_task_event';
/** Payload is the task id, but every worker slot wakes: whichever leases it first wins. */
const TASK_QUEUE_CHANNEL = 'athanor_task_queued';
/**
 * Payload is the task id of a conversation that just gained an answer, which is the only moment a
 * placeholder title can be replaced by a real one. Every titler wakes; the write is conditional on
 * the title still being a placeholder, so a second one finds nothing to do.
 */
const TASK_ANSWERED_CHANNEL = 'athanor_task_answered';

export interface TaskEventPage {
  /** Always oldest first, whichever direction the page was read in. */
  events: TaskEventRecord[];
  /** More events exist beyond this page in the direction it was read. */
  hasMore: boolean;
  /** Lowest sequence on this page; pass it as `before` to walk further back. */
  oldestSequence: number | null;
  /** Highest sequence seen; the cursor a forward reader or event stream resumes from. */
  nextCursor: number;
}

/** How much of the sidebar a page is allowed to be, whatever the caller asks for. */
const MAX_TASK_PAGE = 500;

export type TaskListFilter = 'active' | 'archived' | 'all';

export interface TaskPage {
  tasks: TaskRecord[];
  /** Pass back as `cursor` for the next page. Null when this page is the end of the list. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The sidebar's position, as the three values its ordering is built from.
 *
 * Keyset rather than an offset: conversations move as they are answered, and an offset would show
 * the same conversation twice or skip one entirely every time that happened while the owner was
 * reading. The id is the tiebreak, so two conversations touched in the same instant still have one
 * order.
 *
 * The timestamp is carried as the database's own text for it rather than as a JavaScript date,
 * because a position has to be able to express the ordering exactly. PostgreSQL keeps microseconds
 * and `Date` keeps milliseconds, so a cursor built from the mapped record rounded the last row of
 * the page up - and every conversation that shared its millisecond then sorted "after" the cursor
 * and was skipped by the next page. Nothing about that was visible: the page simply came back
 * short, and the conversation was still there, unreachable except through search.
 */
const encodeTaskCursor = (row: Record<string, unknown>): string =>
  Buffer.from(
    `${row.pinned === true ? '1' : '0'}|${String(row.activity_at)}|${String(row.id)}`,
    'utf8'
  ).toString('base64url');

const decodeTaskCursor = (cursor: string): { pinned: boolean; activityAt: string; id: string } => {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [pinned, activityAt, id] = parts;
  // Parsed only to reject what is not a timestamp at all; what travels on is the original text, at
  // whatever precision the database wrote it.
  const at = new Date(String(activityAt));
  if (parts.length !== 3 || (pinned !== '0' && pinned !== '1') || Number.isNaN(at.getTime()) || !id)
    throw new AthanorError('invalid_cursor', 'That conversation list position is not valid');
  return { pinned: pinned === '1', activityAt: String(activityAt), id };
};

const mapTaskPlan = (row: Record<string, unknown>): TaskPlanRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  version: Number(row.version),
  parentVersion: row.parent_version === null ? null : Number(row.parent_version),
  branchName: String(row.branch_name),
  stepsCiphertext: json<EncryptedEnvelope>(row.steps_ciphertext),
  createdBy: String(row.created_by) as TaskPlanRecord['createdBy'],
  createdAt: iso(row.created_at)
});

const mapWorkspaceMemory = (row: Record<string, unknown>): WorkspaceMemoryRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  target: String(row.target) as WorkspaceMemoryRecord['target'],
  contentCiphertext: json<EncryptedEnvelope>(row.content_ciphertext),
  validUntil: row.valid_until ? iso(row.valid_until) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const workspaceSkillStatus = (value: unknown): WorkspaceSkillRecord['status'] =>
  value === 'stale' || value === 'archived' ? value : 'active';

const mapWorkspaceSkill = (row: Record<string, unknown>): WorkspaceSkillRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  nameHash: String(row.name_hash),
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext),
  version: Number(row.version),
  enabled: Boolean(row.enabled),
  status: workspaceSkillStatus(row.status),
  pinned: Boolean(row.pinned),
  useCount: Number(row.use_count ?? 0),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapConnector = (row: Record<string, unknown>): ConnectorRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  kind: String(row.kind) as ConnectorRecord['kind'],
  authMode:
    row.auth_mode === 'none' || row.auth_mode === 'bearer' || row.auth_mode === 'oauth'
      ? row.auth_mode
      : 'secret',
  label: String(row.label),
  baseUrl: String(row.base_url),
  scopes: json<ConnectorRecord['scopes']>(row.scopes),
  secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
  enabled: Boolean(row.enabled),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapConnectorOAuthAttempt = (row: Record<string, unknown>): ConnectorOAuthAttemptRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  label: String(row.label),
  baseUrl: String(row.base_url),
  scopes: json<ConnectorOAuthAttemptRecord['scopes']>(row.scopes),
  stateHash: String(row.state_hash),
  secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
  expiresAt: iso(row.expires_at),
  createdAt: iso(row.created_at)
});

const mapApiToken = (row: Record<string, unknown>): ApiTokenRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  label: String(row.label),
  prefix: String(row.token_prefix),
  scopes: json<ApiTokenRecord['scopes']>(row.scopes),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  expiresAt: iso(row.expires_at),
  createdAt: iso(row.created_at)
});

const mapConnectorAudit = (row: Record<string, unknown>): ConnectorAuditRecord => ({
  id: String(row.id),
  connectorId: String(row.connector_id),
  taskId: optionalText(row.task_id),
  operation: String(row.operation),
  outcome: String(row.outcome) as ConnectorAuditRecord['outcome'],
  statusCode:
    row.status_code === null || row.status_code === undefined ? null : Number(row.status_code),
  requestBytes: Number(row.request_bytes),
  responseBytes: Number(row.response_bytes),
  durationMs: Number(row.duration_ms),
  createdAt: iso(row.created_at)
});

const mapWorkspacePreview = (row: Record<string, unknown>): WorkspacePreviewRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  label: String(row.label),
  port: Number(row.port),
  slug: String(row.slug),
  accessTokenHash: String(row.access_token_hash),
  visibility: String(row.visibility) as WorkspacePreviewRecord['visibility'],
  customDomain: optionalText(row.custom_domain),
  domainStatus: optionalText(row.domain_status) as WorkspacePreviewRecord['domainStatus'],
  domainVerificationHash: optionalText(row.domain_verification_hash),
  status: String(row.status) as WorkspacePreviewRecord['status'],
  expiresAt: row.expires_at ? iso(row.expires_at) : null,
  lastAccessedAt: row.last_accessed_at ? iso(row.last_accessed_at) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

/* ------------------------------------------------------------------------ *
 * Tiered agent memory (mem schema)
 * ------------------------------------------------------------------------ */

export interface MemoryCapabilities {
  /** True when pg_trgm is installed. Fuzzy recall does not depend on it; reporting does. */
  readonly trigram: boolean;
}

export interface MemoryItemRecord {
  id: string;
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  observedAt: string;
  retiredAt: string | null;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  predFunctional: boolean;
  objectKey: string | null;
  episodeId: string | null;
  taskId: string | null;
  lastVerified: string | null;
  okCount: number;
  failCount: number;
  pin: boolean;
  useCount: number;
  citedCount: number;
  negCount: number;
  lastUsedAt: string | null;
  salience: number;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySourceRecord {
  id: string;
  userId: string;
  workspaceId: string;
  occurredAt: string;
  channel: MemorySourceChannel;
  role: string | null;
  taskId: string | null;
  episodeId: string | null;
  originCiphertext: EncryptedEnvelope | null;
  originKey: string | null;
  bodyCiphertext: EncryptedEnvelope;
  chunkIndex: number;
  chunkOf: string | null;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
}

export type MemorySourceChannel = 'chat' | 'terminal' | 'file' | 'browser' | 'desktop' | 'tool';

export type MemoryUseOutcome = 'ok' | 'fail' | 'unknown';

export interface MemoryCandidateRecord {
  id: string;
  /** `item` rows come from the curated overlay, `source` rows from the verbatim layer. */
  layer: 'item' | 'source';
  kind: MemoryKind;
  trust: MemoryTrust;
  status: MemoryStatus;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  tokensEst: number;
  score: number;
  documentCiphertext: EncryptedEnvelope;
}

export interface MemoryPackRecord {
  taskId: string;
  workspaceId: string;
  briefVersion: string | null;
  bodyCiphertext: EncryptedEnvelope;
  sha256: string;
  itemIds: string[];
  tokensEst: number;
  createdAt: string;
}

export interface MemoryLinkRecord {
  srcId: string;
  dstId: string;
  rel: MemoryLinkRelation;
  weight: number;
  createdAt: string;
}

export type MemoryLinkRelation =
  | 'supersedes'
  | 'contradicts'
  | 'supports'
  | 'derived_from'
  | 'about'
  | 'part_of';

export interface MemoryFactCandidateRecord {
  workspaceId: string;
  subjectKey: string;
  predicate: string;
  objectKey: string;
  episodeCount: number;
  firstSeen: string;
  lastSeen: string;
  episodeIds: string[];
  draftCiphertext: EncryptedEnvelope | null;
}

/**
 * What the key holder has to supply for an observation to become a durable fact: the sealed
 * document and the blind index over it, neither of which the store can produce for itself.
 */
export interface PreparedMemoryFact {
  userId: string;
  documentCiphertext: EncryptedEnvelope;
  /** Its `subjectKey` and `objectKey` must be the candidate's, or the promotion is refused. */
  index: MemoryItemIndex;
  /** Defaults to `derived`: a promoted fact was assembled from episodes, not stated outright. */
  trust?: MemoryTrust;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  taskId?: string | null;
}

export interface MemoryFactPromotion {
  candidate: MemoryFactCandidateRecord;
  item: MemoryItemRecord;
  supersededIds: string[];
}

export interface CreateMemoryItemInput {
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  /** Keyed blind index built by `buildMemoryItemIndex`; plaintext never reaches the store. */
  index: MemoryItemIndex;
  id?: string;
  status?: MemoryStatus;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  predicate?: string | null;
  episodeId?: string | null;
  taskId?: string | null;
  triggerKey?: string | null;
  lastVerified?: Date | string | null;
  pin?: boolean;
  salience?: number;
}

export interface RecallMemoryInput {
  workspaceId: string;
  plan: MemoryQueryPlan;
  /** Anchors every decayed score. Pass the task's start instant to freeze a pack for its lifetime. */
  now?: Date | string;
  budgetTokens?: number;
  maxItems?: number;
  kinds?: readonly MemoryKind[];
  scope?: 'default' | 'archive';
  asOf?: Date | string | null;
  includeSuperseded?: boolean;
  quotas?: readonly MemoryPackQuota[];
  procedureStaleDays?: number;
  procedureMinSuccessRate?: number;
  /** Minimum keyed-trigram Jaccard for the fuzzy channel; defaults to pg_trgm's own threshold. */
  fuzzyThreshold?: number;
  /**
   * Rows the caller already has in context. Excluded before any channel spends a slot on them, so a
   * mid-task recall returns what the frozen pack did not, rather than a paraphrase of it.
   */
  excludeIds?: readonly string[];
  /**
   * `stable` orders by (kind, id) so the same rows always render to the same pack bytes, which is
   * what the prompt cache needs. `relevance` orders by fused score, for a recall the agent asked
   * for mid-task and nothing is caching.
   */
  order?: 'stable' | 'relevance';
}

export interface SearchMemorySourcesInput {
  workspaceId: string;
  /** Built by `planMemoryQuery`, exactly as for item recall: same tokenizer, same key. */
  plan: MemoryQueryPlan;
  /** Restricts the search to one task's transcript. */
  taskId?: string | null;
  since?: Date | string | null;
  until?: Date | string | null;
  limit?: number;
  /**
   * Most rows any one conversation may contribute. Defaults to `MEMORY_SOURCE_SEARCH_PER_TASK`;
   * a search already restricted to one task raises it, because there is nothing to crowd out.
   */
  perTask?: number;
}

export interface MemorySourceHit extends MemorySourceRecord {
  score: number;
}

export interface MemoryConsolidationReport {
  salienceUpdated: number;
  itemsArchived: number;
  sourcesUnindexed: number;
  usesPruned: number;
  candidatesPruned: number;
  packsPruned: number;
  staleProcedureIds: string[];
  /** True when this pass also did the periodic full rebuild of the BM25 corpus statistics. */
  corpusStatsRebuilt: boolean;
}

/** Provenance defaults to an empty object, which is not a seal; only a real envelope is returned. */
const optionalEnvelope = (value: unknown): EncryptedEnvelope | null => {
  if (!value) return null;
  const parsed = json<Partial<EncryptedEnvelope>>(value);
  return parsed.v === 1 && typeof parsed.ciphertext === 'string'
    ? (parsed as EncryptedEnvelope)
    : null;
};

const memoryKind = (value: unknown): MemoryKind => String(value) as MemoryKind;

const mapMemoryItem = (row: Record<string, unknown>): MemoryItemRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  kind: memoryKind(row.kind),
  status: String(row.status) as MemoryStatus,
  trust: String(row.trust) as MemoryTrust,
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext),
  observedAt: iso(row.observed_at),
  retiredAt: row.retired_at ? iso(row.retired_at) : null,
  validFrom: iso(row.valid_from),
  validTo: row.valid_to ? iso(row.valid_to) : null,
  subjectKey: optionalText(row.subject_key),
  predicate: optionalText(row.predicate),
  predFunctional: Boolean(row.pred_functional),
  objectKey: optionalText(row.object_key),
  episodeId: optionalText(row.episode_id),
  taskId: optionalText(row.task_id),
  lastVerified: row.last_verified ? iso(row.last_verified) : null,
  okCount: Number(row.ok_count),
  failCount: Number(row.fail_count),
  pin: Boolean(row.pin),
  useCount: Number(row.use_count),
  citedCount: Number(row.cited_count),
  negCount: Number(row.neg_count),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  salience: Number(row.salience),
  tokensEst: Number(row.tokens_est),
  indexed: Boolean(row.indexed),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at)
});

const mapMemorySource = (row: Record<string, unknown>): MemorySourceRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  workspaceId: String(row.workspace_id),
  occurredAt: iso(row.occurred_at),
  channel: String(row.channel) as MemorySourceChannel,
  role: optionalText(row.role),
  taskId: optionalText(row.task_id),
  episodeId: optionalText(row.episode_id),
  originCiphertext: optionalEnvelope(row.origin_ciphertext),
  originKey: optionalText(row.origin_key),
  bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
  chunkIndex: Number(row.chunk_ix),
  chunkOf: optionalText(row.chunk_of),
  tokensEst: Number(row.tokens_est),
  indexed: Boolean(row.indexed),
  createdAt: iso(row.created_at)
});

const mapMemoryCandidate = (row: Record<string, unknown>): MemoryCandidateRecord => ({
  id: String(row.id),
  layer: row.layer === 'source' ? 'source' : 'item',
  kind: memoryKind(row.kind),
  trust: String(row.trust) as MemoryTrust,
  status: String(row.status) as MemoryStatus,
  observedAt: iso(row.observed_at),
  validFrom: iso(row.valid_from),
  validTo: row.valid_to ? iso(row.valid_to) : null,
  subjectKey: optionalText(row.subject_key),
  predicate: optionalText(row.predicate),
  tokensEst: Number(row.tokens_est),
  score: Number(row.score),
  documentCiphertext: json<EncryptedEnvelope>(row.document_ciphertext)
});

const mapMemoryPack = (row: Record<string, unknown>): MemoryPackRecord => ({
  taskId: String(row.task_id),
  workspaceId: String(row.workspace_id),
  briefVersion: optionalText(row.brief_version),
  bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext),
  sha256: String(row.sha256),
  itemIds: (row.item_ids as string[] | null) ?? [],
  tokensEst: Number(row.tokens_est),
  createdAt: iso(row.created_at)
});

const mapMemoryFactCandidate = (row: Record<string, unknown>): MemoryFactCandidateRecord => ({
  workspaceId: String(row.workspace_id),
  subjectKey: String(row.subject_key),
  predicate: String(row.predicate),
  objectKey: String(row.object_key),
  episodeCount: Number(row.n_episodes),
  firstSeen: iso(row.first_seen),
  lastSeen: iso(row.last_seen),
  episodeIds: (row.episode_ids as string[] | null) ?? [],
  draftCiphertext: row.draft_ciphertext ? json<EncryptedEnvelope>(row.draft_ciphertext) : null
});

/** Retrieval never invents a scope: everything a caller can widen is a bound parameter. */
const MEMORY_ITEM_ADMISSIBLE = `
      i.workspace_id = q.ws
      AND (i.status = 'active'
           OR (q.want_superseded AND i.status IN ('superseded','disputed'))
           OR (q.scope = 'archive' AND i.status = 'archived'))
      AND (q.want_inferred OR i.trust <> 'inferred') -- want_inferred is pinned false
      AND (q.kinds IS NULL OR i.kind::text = ANY(q.kinds))
      -- Rows the caller already holds. An agent-initiated recall passes the ids its frozen pack
      -- printed, so the answer it did not get the first time is not paid for a second time - and it
      -- is excluded here, before a channel spends one of its capped slots on it, rather than after.
      AND NOT (i.id = ANY(q.exclude))
      AND (q.as_of IS NULL
           OR (i.valid_from <= q.as_of AND (i.valid_to IS NULL OR i.valid_to > q.as_of)))`;

// Each channel is capped before anything is sorted: BM25 is only ever evaluated over the rows a
// GIN probe already matched, which is the entire mitigation for "ranking gets slow at scale".
const MEMORY_LEXICAL_CANDIDATES = 120;
const MEMORY_FUZZY_CANDIDATES = 40;
/**
 * How many rows the fuzzy channel may compute an exact Jaccard score for. Array overlap is
 * satisfied by a single shared trigram, so the GIN probe generates candidates but no selectivity;
 * without this cap the per-row `unnest` scored the whole corpus on every recall and grew linearly
 * with it. Fifteen times the number of rows the channel can contribute is ample headroom.
 */
const MEMORY_FUZZY_SCAN_CANDIDATES = 600;
const MEMORY_STRUCTURAL_CANDIDATES = 40;
/** Sources older than this stop competing with the curated overlay for the lexical slot. */
const MEMORY_SOURCE_HORIZON_YEARS = 3;

/**
 * How many of the request's terms become tsquery branches.
 *
 * Every branch is its own GIN posting-list probe, so this is the one place recall cost is linear in
 * question length. The client now hands over the whole request rather than a pseudorandom sample of
 * it (see `planMemoryQuery`), which is what makes choosing here worth doing: the database is the
 * only party that knows document frequency, so it keeps the rarest - most discriminative - terms
 * and drops the ones a hundred rows already share.
 */
const MEMORY_QUERY_TERMS = 32;

/**
 * The `terms` CTE, shared by item recall and verbatim search.
 *
 * `mem.lexeme_df` holds one row per lexeme the workspace has ever indexed, so a term missing from
 * it appears in no document and cannot match anything. Those terms sort last rather than being
 * filtered out: they cost nothing (a tsquery branch that matches no row) and never displace a term
 * that could match. Among terms that do exist, ascending document frequency is exactly the
 * discriminative order.
 */
const MEMORY_TERMS_CTE = `
terms AS (
  SELECT t.lexeme, COALESCE(d.df, 1)::float8 AS df
  FROM q CROSS JOIN unnest($2::text[]) AS t(lexeme)
  LEFT JOIN mem.lexeme_df d ON d.workspace_id = q.ws AND d.lexeme = t.lexeme
  ORDER BY (d.df IS NULL) ASC, COALESCE(d.df, 1) ASC, t.lexeme ASC
  LIMIT ${MEMORY_QUERY_TERMS}
),
qq AS (
  SELECT array_agg(t.lexeme ORDER BY t.lexeme) AS q_lex,
         array_agg(ln(1 + GREATEST(s.n_docs - t.df + 0.5, 0.0) / (t.df + 0.5))
                   ORDER BY t.lexeme) AS q_idf,
         NULLIF(string_agg(t.lexeme, ' | ' ORDER BY t.lexeme), '')::tsquery AS q_ts
  FROM terms t CROSS JOIN stats s
)`;

/**
 * One statement: five capped recall channels, weighted reciprocal-rank fusion, a multiplicative
 * provenance/recency/salience prior, per-kind quotas and the token budget. Nothing is sorted in
 * the application, and the result already respects the budget it was asked for.
 *
 * The final ORDER BY is (kind, id), not score: the pack sits behind a prompt-cache breakpoint, so
 * the same set of rows must always render to the same bytes. `score` is returned for callers that
 * want relevance order for an interactive recall.
 */
const MEMORY_RECALL_SQL = `
WITH q AS (
  SELECT $1::uuid AS ws, $3::text[] AS q_trg, $4::text[] AS q_ents, $5::text[] AS q_tags,
         $6::timestamptz AS t_now, $7::bool AS temporal_intent, $8::bool AS want_inferred,
         $9::bool AS want_superseded, $12::timestamptz AS as_of, $13::text[] AS kinds,
         $14::text AS scope, $23::uuid[] AS exclude
),
stats AS (
  SELECT GREATEST(COALESCE(c.n_docs, 1), 1)::float8 AS n_docs,
         GREATEST(COALESCE(c.sum_len::float8 / NULLIF(c.n_docs, 0), 1), 1)::float8 AS avg_len
  FROM q LEFT JOIN mem.corpus_stats c ON c.workspace_id = q.ws
),
${MEMORY_TERMS_CTE},
lex_item AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, id) AS r FROM (
    SELECT i.id, mem.bm25(qq.q_lex, qq.q_idf, i.tsv, i.tsv_len, st.avg_len) AS s
    FROM mem.item i CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
    WHERE ${MEMORY_ITEM_ADMISSIBLE}
      AND i.tsv @@ qq.q_ts
    ORDER BY s DESC, i.id
    LIMIT ${MEMORY_LEXICAL_CANDIDATES}
  ) t
),
lex_src AS (
  SELECT id, row_number() OVER (ORDER BY s DESC, id) AS r FROM (
    SELECT sc.id, mem.bm25(qq.q_lex, qq.q_idf, sc.tsv, sc.tsv_len, st.avg_len) AS s
    FROM mem.source sc CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
    WHERE sc.workspace_id = q.ws AND sc.indexed AND sc.tsv @@ qq.q_ts
      AND (q.kinds IS NULL OR 'source' = ANY(q.kinds))
      AND NOT (sc.id = ANY(q.exclude))
      AND sc.occurred_at > q.t_now - make_interval(years => ${MEMORY_SOURCE_HORIZON_YEARS})
    ORDER BY s DESC, sc.id
    LIMIT ${MEMORY_LEXICAL_CANDIDATES}
  ) t
),
-- The array GIN index generates the candidates, but overlap is satisfied by one shared trigram,
-- so it supplies no selectivity: the cap has to come from the channel itself.
--
-- Jaccard bounds the two set sizes against each other. shared <= LEAST(n_item, n_query) and the
-- union is at least GREATEST(n_item, n_query), so sim <= LEAST/GREATEST for any pair. That makes
-- the size ratio both an exact admissibility test (anything outside it cannot reach the threshold
-- however many trigrams it shares) and the tightest score bound obtainable without touching the
-- arrays - which is what makes it a sound key to take the top candidates by. Recency breaks ties,
-- because that is what the prior prefers among rows the bound cannot separate.
trg_cand AS (
  SELECT i.id, i.trigram_len AS n_trg
  FROM mem.item i CROSS JOIN q
  WHERE ${MEMORY_ITEM_ADMISSIBLE}
    AND cardinality(q.q_trg) > 0
    AND i.trigrams && q.q_trg
    AND i.trigram_len >= $18::float8 * cardinality(q.q_trg)
    AND i.trigram_len * $18::float8 <= cardinality(q.q_trg)
  ORDER BY LEAST(i.trigram_len, cardinality(q.q_trg))::float8
             / GREATEST(i.trigram_len, cardinality(q.q_trg)) DESC,
           i.observed_at DESC, i.id
  LIMIT ${MEMORY_FUZZY_SCAN_CANDIDATES}
),
-- The threshold is what pg_trgm's % operator applies before a row counts as similar at all.
trg_raw AS (
  SELECT c.id,
         x.shared::float8 / NULLIF(c.n_trg + cardinality(q.q_trg) - x.shared, 0) AS sim
  FROM trg_cand c
  JOIN mem.item i ON i.id = c.id
  CROSS JOIN q
  CROSS JOIN LATERAL (
    SELECT count(*) AS shared FROM unnest(i.trigrams) g WHERE g = ANY($3::text[])
  ) x
),
trg AS (
  SELECT id, row_number() OVER (ORDER BY sim DESC, id) AS r FROM (
    SELECT id, sim FROM trg_raw WHERE sim >= $18::float8
    ORDER BY sim DESC, id
    LIMIT ${MEMORY_FUZZY_CANDIDATES}
  ) t
),
-- What this channel admits is structural - a fact about a subject the request named, a procedure
-- carrying one of its tags, a row the owner pinned - but the order inside it is not, and it used to
-- be pure recency fused at 1.30, the heaviest weight of any channel. For a subject with more facts
-- than this ladder is long that decided the whole result: the spread across the structural ladder
-- is wider than the entire lexical channel's, so recency chose which facts came back and the
-- request's own words chose nothing. "which programming language does the owner work in" ranked the
-- one row titled "working languages" eighth of the owner's nine facts, behind five that match only
-- the word "owner", and the per-subject cap then cut it - a hard zero at every k, on a question the
-- store held a titled, single-document-frequency answer to.
--
-- The candidate set is still taken by recency, which is the right bound when a subject has thousands
-- of facts. The fusion rank is taken by how well the row answers the request, over the forty rows
-- that survived - and when none of them match, every score is zero and this is exactly the old
-- order, which is what keeps the channel doing its original job for a request with no lexical grip.
struct AS (
  SELECT id, row_number() OVER (ORDER BY pr, s DESC, observed_at DESC, id) AS r FROM (
    SELECT c.id, c.pr, c.observed_at,
           mem.bm25(qq.q_lex, qq.q_idf, c.tsv, c.tsv_len, st.avg_len) AS s
    FROM (
      SELECT i.id, i.observed_at, i.tsv, i.tsv_len,
             CASE WHEN i.pin THEN 0 WHEN i.kind = 'fact' THEN 1 ELSE 2 END AS pr
      FROM mem.item i CROSS JOIN q
      WHERE ${MEMORY_ITEM_ADMISSIBLE}
        AND (i.pin
             OR (i.kind = 'fact' AND i.subject_key = ANY(q.q_ents))
             OR (i.kind = 'procedure' AND i.tags_hashed && q.q_tags))
      ORDER BY pr, i.observed_at DESC, i.id
      LIMIT ${MEMORY_STRUCTURAL_CANDIDATES}
    ) c CROSS JOIN qq CROSS JOIN stats st
  ) t
),
fused AS (
  SELECT id, SUM(w / (60.0 + r)) AS rrf FROM (
    SELECT id, r, 1.00::float8 AS w FROM lex_item
    UNION ALL SELECT id, r, 0.70 FROM lex_src
    UNION ALL SELECT id, r, 0.40 FROM trg
    UNION ALL SELECT id, r, 1.30 FROM struct
  ) u GROUP BY id
),
scored AS (
  SELECT i.id, 'item'::text AS layer, i.kind, i.trust, i.status, i.observed_at, i.valid_from,
         i.valid_to, i.subject_key, i.predicate, i.tokens_est, i.dedupe_key,
         i.document_ciphertext,
         f.rrf * mem.prior(i.kind, i.trust, i.valid_to, i.observed_at, i.salience, i.pin,
                           q.t_now, q.temporal_intent) AS score
  FROM fused f
  JOIN mem.item i ON i.id = f.id
  CROSS JOIN q
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.outcome = 'ok')::float8 AS ok_recent,
           count(*) FILTER (WHERE r.outcome <> 'unknown')::float8 AS graded_recent
    FROM (
      SELECT u.outcome FROM mem.item_use u
      WHERE u.item_id = i.id ORDER BY u.used_at DESC, u.id LIMIT 5
    ) r
  ) health ON TRUE
  WHERE ${MEMORY_ITEM_ADMISSIBLE}
    -- A wrong remembered command is worse than no command: an unverified or failing procedure
    -- stops being injected here, but the row itself is never deleted.
    AND (i.kind <> 'procedure'
         OR (COALESCE(i.last_verified, i.observed_at) > q.t_now - make_interval(days => $16::int)
             AND (health.graded_recent = 0
                  OR health.ok_recent / health.graded_recent >= $17::float8)))
  UNION ALL
  SELECT sc.id, 'source'::text, 'source'::mem.kind, 'stated'::mem.trust, 'active'::mem.status,
         sc.occurred_at, sc.occurred_at, NULL::timestamptz, NULL::text, NULL::text,
         sc.tokens_est, sc.id::text, sc.body_ciphertext,
         f.rrf * mem.prior('source'::mem.kind, 'stated'::mem.trust, NULL::timestamptz,
                           sc.occurred_at, 0::real, FALSE, q.t_now, q.temporal_intent)
  FROM fused f
  JOIN mem.source sc ON sc.id = f.id
  CROSS JOIN q
  WHERE sc.workspace_id = q.ws
),
quota AS (
  SELECT (v->>'kind')::mem.kind AS kind, (v->>'share')::float8 AS share,
         (v->>'cap')::int AS cap, (v->>'perSubject')::int AS per_subject
  FROM jsonb_array_elements($11::jsonb) v
),
-- LEFT JOIN, not JOIN: an inner join here silently deleted every row whose kind had no quota
-- entry, after ranking it: 'entity' was declared in MemoryKind, exported in MEMORY_KINDS and given
-- the first heading in the rendered pack, and could never reach one. A kind the quota table has
-- not heard of now degrades to a small allowance instead of disappearing.
deduped AS (
  SELECT DISTINCT ON (s.dedupe_key) s.*,
         COALESCE(qt.share, $20::float8) AS share,
         COALESCE(qt.cap, $21::int) AS cap,
         COALESCE(qt.per_subject, $22::int) AS per_subject
  FROM scored s LEFT JOIN quota qt ON qt.kind = s.kind
  ORDER BY s.dedupe_key, s.score DESC, s.id
),
windowed AS (
  SELECT d.*,
         row_number() OVER (PARTITION BY d.kind ORDER BY d.score DESC, d.id) AS kind_rank,
         -- Current and retired values of the same subject are ranked in separate windows. Sharing
         -- one meant that "which shell did I use before?" - the only question a retired row can
         -- answer - lost that row to four unrelated live facts about the same subject, because the
         -- prior deliberately discounts a retired row and the per-subject cap then cut from the
         -- bottom. Retired rows only enter this query when the caller asked for them at all.
         row_number() OVER (PARTITION BY d.kind, COALESCE(d.subject_key, d.id::text),
                                         (d.status <> 'active')
                            ORDER BY d.score DESC, d.id) AS subject_rank,
         SUM(d.tokens_est) OVER (PARTITION BY d.kind ORDER BY d.score DESC, d.id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS kind_tokens
  FROM deduped d
),
eligible AS (
  SELECT w.* FROM windowed w
  WHERE w.kind_rank <= w.cap AND w.subject_rank <= w.per_subject
    AND w.kind_tokens <= GREATEST(floor(w.share * $10::int), 1)
),
-- Both cuts are taken in score order. The item limit used to be a trailing LIMIT after the
-- (kind, id) sort, so whenever more rows fitted the budget than the caller asked for, the ones
-- discarded were the alphabetically last - not the least relevant.
budgeted AS (
  SELECT e.*, SUM(e.tokens_est) OVER (ORDER BY e.score DESC, e.id
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running,
         row_number() OVER (ORDER BY e.score DESC, e.id) AS score_rank
  FROM eligible e
)
SELECT id, layer, kind, trust, status, observed_at, valid_from, valid_to, subject_key,
       predicate, tokens_est, score, document_ciphertext
FROM budgeted
WHERE running <= $10::int AND score_rank <= $15::int
-- Stable order by default: the pack sits behind a cache breakpoint and the same rows must render
-- to the same bytes. An interactive recall asks for relevance instead, where "best first" is the
-- whole point and nothing is being cached.
ORDER BY CASE WHEN $19::bool THEN score END DESC NULLS LAST, kind, id`;

/**
 * How many scored rows the diversification window may choose from.
 *
 * Wide enough that the per-conversation cap has something to promote from behind a dominant thread,
 * bounded so a two-word query never sorts the whole verbatim layer.
 */
const MEMORY_SOURCE_SEARCH_CANDIDATES = 200;

/**
 * Rows one conversation may contribute to a result list that spans conversations. Three is a
 * question, its answer and the command that proved it - the shape a turn actually has here.
 */
export const MEMORY_SOURCE_SEARCH_PER_TASK = 3;

/**
 * Verbatim search: the same blind index, the same BM25, restricted to `mem.source`.
 *
 * This is the query behind "search my past conversations". The rows are already here - every turn
 * is chunked, sealed and indexed on the write path - so searching them costs one bounded GIN probe
 * instead of decrypting a workspace's entire history in the worker and matching substrings over it.
 * Stemming, document frequency and field length normalisation all come along for free, which is
 * what makes "restarted" find "restart".
 *
 * The per-conversation cap is what makes a result list worth reading. Turns inside one thread all
 * share its vocabulary, so the top of a raw BM25 list over a transcript is nearly always the same
 * conversation several times over: the question "when did we last change this" gets one answer,
 * repeated, and the other four threads that also touched it never appear. The cap is applied after
 * scoring and only ever moves a row down, so a conversation that genuinely holds the best rows
 * still leads - it just stops holding all of them.
 */
const MEMORY_SOURCE_SEARCH_SQL = `
WITH q AS (
  SELECT $1::uuid AS ws, $3::uuid AS task, $4::timestamptz AS since, $5::timestamptz AS until,
         $7::int AS per_task
),
stats AS (
  SELECT GREATEST(COALESCE(c.n_docs, 1), 1)::float8 AS n_docs,
         GREATEST(COALESCE(c.sum_len::float8 / NULLIF(c.n_docs, 0), 1), 1)::float8 AS avg_len
  FROM q LEFT JOIN mem.corpus_stats c ON c.workspace_id = q.ws
),
${MEMORY_TERMS_CTE},
hits AS (
  SELECT sc.id, sc.task_id, mem.bm25(qq.q_lex, qq.q_idf, sc.tsv, sc.tsv_len, st.avg_len) AS s
  FROM mem.source sc CROSS JOIN q CROSS JOIN qq CROSS JOIN stats st
  WHERE sc.workspace_id = q.ws AND sc.indexed AND sc.tsv @@ qq.q_ts
    AND (q.task IS NULL OR sc.task_id = q.task)
    AND (q.since IS NULL OR sc.occurred_at >= q.since)
    AND (q.until IS NULL OR sc.occurred_at <= q.until)
  ORDER BY s DESC, sc.id
  LIMIT ${MEMORY_SOURCE_SEARCH_CANDIDATES}
),
-- A row with no task_id is a standalone capture rather than part of a thread, so each one is its
-- own conversation and none of them crowds out another.
spread AS (
  SELECT h.id, h.s,
         row_number() OVER (PARTITION BY COALESCE(h.task_id::text, h.id::text)
                            ORDER BY h.s DESC, h.id) AS thread_rank
  FROM hits h
)
SELECT sc.*, r.s AS score
FROM (
  SELECT id, s FROM spread CROSS JOIN q
  WHERE thread_rank <= q.per_task
  ORDER BY s DESC, id
  LIMIT $6::int
) r JOIN mem.source sc ON sc.id = r.id
ORDER BY r.s DESC, sc.id`;

/**
 * The rows either side of a hit.
 *
 * A search result on its own is a fragment: the answer is very often in the reply to the message
 * that matched. A chunked document's siblings all carry `chunk_of` pointing at chunk zero, so
 * `COALESCE(chunk_of, id)` names the document; a turn inside a task is surrounded by the rest of
 * that task's transcript. Both are the same ordered stream, so one window serves both.
 */
const MEMORY_SOURCE_WINDOW_SQL = `
WITH anchor AS (
  SELECT * FROM mem.source WHERE workspace_id = $1::uuid AND id = $2::uuid
),
neighbours AS (
  SELECT s.*, row_number() OVER (ORDER BY s.occurred_at, s.chunk_ix, s.id) AS rn
  FROM mem.source s CROSS JOIN anchor a
  WHERE s.workspace_id = a.workspace_id
    AND (COALESCE(s.chunk_of, s.id) = COALESCE(a.chunk_of, a.id)
         OR (a.task_id IS NOT NULL AND s.task_id = a.task_id))
),
pivot AS (
  SELECT n.rn FROM neighbours n CROSS JOIN anchor a WHERE n.id = a.id
)
SELECT n.* FROM neighbours n CROSS JOIN pivot p
WHERE n.rn BETWEEN p.rn - $3::int AND p.rn + $4::int
ORDER BY n.rn`;

export class DataStore {
  constructor(private readonly database: Database) {}

  /** Detected once per process: extension availability cannot change under a running server. */
  #memoryCapabilities: Promise<MemoryCapabilities> | null = null;

  /**
   * Local delivery of the two signals below. One listener per open activity stream and one per
   * worker slot, so the ceiling is the stream cap rather than Node's default ten.
   */
  readonly #signals = new EventEmitter().setMaxListeners(0);
  #bridging = false;
  /** Channels this process has already subscribed to, so a retry never subscribes to one twice. */
  readonly #bridgedChannels = new Set<string>();
  readonly #bridged: ReadonlyArray<readonly [string, (payload: string) => void]> = [
    [TASK_EVENT_CHANNEL, (taskId) => this.#signals.emit(`${TASK_EVENT_CHANNEL}:${taskId}`)],
    [TASK_QUEUE_CHANNEL, () => this.#signals.emit(TASK_QUEUE_CHANNEL)],
    [TASK_ANSWERED_CHANNEL, () => this.#signals.emit(TASK_ANSWERED_CHANNEL)]
  ];

  /**
   * Cross-process delivery for the same signals.
   *
   * Started on the first subscription rather than in the constructor, so a process that only
   * writes - the notifier, a migration, a test - never opens the extra connection. Until the
   * bridge is up, local emission still works and the caller's timer covers the gap, which is why
   * nothing awaits it.
   */
  #bridge(): void {
    if (this.#bridging) return;
    this.#bridging = true;
    void (async () => {
      // Each channel is retried on its own. Subscribing to all three under one flag meant that a
      // failure on the third left the flag clear, and the next subscriber re-subscribed to the
      // first two - so every task event was then delivered twice, three times, once per retry.
      for (const [channel, deliver] of this.#bridged) {
        if (this.#bridgedChannels.has(channel)) continue;
        await this.database.listen(channel, deliver);
        this.#bridgedChannels.add(channel);
      }
    })().catch(() => {
      // Retried by the next subscriber. Until then local delivery still works and the reader's
      // own timer covers the gap, which is exactly what it is there for.
      this.#bridging = false;
    });
  }

  #signal(channel: string, payload: string): void {
    this.#signals.emit(channel === TASK_EVENT_CHANNEL ? `${channel}:${payload}` : channel);
    // A failed wake-up is not a failed write: the reader polls anyway, one second later.
    void this.database.notify(channel, payload).catch(() => undefined);
  }

  /**
   * Calls back when this task gains an event, wherever in the install it was written.
   *
   * This is what turns the activity stream from "re-read the table every second" into "write, then
   * deliver", which is the difference between a reply that steps and a reply that streams.
   */
  onTaskEvent(taskId: string, listener: () => void): () => void {
    this.#bridge();
    const name = `${TASK_EVENT_CHANNEL}:${taskId}`;
    this.#signals.on(name, listener);
    return () => {
      this.#signals.off(name, listener);
    };
  }

  /** Resolves as soon as any task is queued, or after `timeoutMs` - whichever comes first. */
  async waitForQueuedTask(timeoutMs: number): Promise<void> {
    this.#bridge();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#signals.off(TASK_QUEUE_CHANNEL, done);
        resolve();
      };
      // Unreferenced so an idle worker never keeps the process alive on its own.
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.#signals.on(TASK_QUEUE_CHANNEL, done);
    });
  }

  /** Resolves as soon as any conversation gains an answer, or after `timeoutMs`. */
  async waitForAnsweredTask(timeoutMs: number): Promise<void> {
    this.#bridge();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#signals.off(TASK_ANSWERED_CHANNEL, done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      this.#signals.on(TASK_ANSWERED_CHANNEL, done);
    });
  }

  async createUser(input: {
    username: string;
    displayName: string;
    recoveryHash?: string;
  }): Promise<UserRecord> {
    const result = await this.database.query(
      `INSERT INTO users(id, username, display_name, recovery_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [randomUUID(), input.username.toLowerCase(), input.displayName, input.recoveryHash ?? null]
    );
    return mapUser(result.rows[0]!);
  }

  async countUsers(): Promise<number> {
    const result = await this.database.query('SELECT COUNT(*) AS count FROM users');
    return Number(result.rows[0]?.count ?? 0);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE username = $1', [
      username.toLowerCase()
    ]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createChallenge(input: {
    username?: string;
    challenge: string;
    kind: 'registration' | 'authentication' | 'step_up' | 'recovery' | 'passkey_add';
    ttlSeconds?: number;
    expectedOrigin?: string;
    rpId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO auth_challenges(
        id, username, challenge, kind, expires_at, expected_origin, rp_id
      )
       VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6, $7)`,
      [
        id,
        input.username?.toLowerCase() ?? null,
        input.challenge,
        input.kind,
        input.ttlSeconds ?? 300,
        input.expectedOrigin ?? null,
        input.rpId ?? null
      ]
    );
    return id;
  }

  async consumeChallenge(
    id: string,
    kind: string
  ): Promise<{
    username: string | null;
    challenge: string;
    expectedOrigin: string | null;
    rpId: string | null;
  } | null> {
    const result = await this.database.query(
      `DELETE FROM auth_challenges
       WHERE id = $1 AND kind = $2 AND expires_at > NOW()
       RETURNING username, challenge, expected_origin, rp_id`,
      [id, kind]
    );
    const row = result.rows[0];
    return row
      ? {
          username: optionalText(row.username),
          challenge: String(row.challenge),
          expectedOrigin: optionalText(row.expected_origin),
          rpId: optionalText(row.rp_id)
        }
      : null;
  }

  async addPasskey(input: Omit<PasskeyRecord, 'id' | 'createdAt'>): Promise<PasskeyRecord> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO passkeys(
        id, user_id, credential_id, public_key, counter, transports, device_type, backed_up
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
      [
        id,
        input.userId,
        input.credentialId,
        input.publicKey,
        input.counter,
        JSON.stringify(input.transports),
        input.deviceType,
        input.backedUp
      ]
    );
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      credentialId: String(row.credential_id),
      publicKey: String(row.public_key),
      counter: Number(row.counter),
      transports: json<string[]>(row.transports),
      deviceType: String(row.device_type),
      backedUp: Boolean(row.backed_up),
      createdAt: iso(row.created_at)
    };
  }

  /**
   * Replaces the recovery code outright, for an owner who is already signed in and stepped up.
   *
   * Unconditional on the old hash, unlike the recovery path: this is not "prove you hold the old
   * code", it is "I have lost it, give me another", and the proof was the passkey ceremony that
   * had to happen first.
   */
  async setRecoveryHash(userId: string, hash: string): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE users SET recovery_hash=$2,updated_at=NOW() WHERE id=$1',
      [userId, hash]
    );
    return result.rowCount === 1;
  }

  async replacePasskeysForRecovery(input: {
    userId: string;
    username: string;
    expectedRecoveryHash: string;
    newRecoveryHash: string;
    passkey: Omit<PasskeyRecord, 'id' | 'userId' | 'createdAt'>;
  }): Promise<PasskeyRecord> {
    return this.database.transaction(async (tx) => {
      const rotated = await tx.query(
        `UPDATE users SET recovery_hash=$3,updated_at=NOW()
         WHERE id=$1 AND recovery_hash=$2 RETURNING id`,
        [input.userId, input.expectedRecoveryHash, input.newRecoveryHash]
      );
      if (rotated.rowCount !== 1) throw new Error('Recovery code has already been rotated');
      await tx.query('DELETE FROM passkeys WHERE user_id=$1', [input.userId]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [input.userId]);
      await tx.query("DELETE FROM auth_challenges WHERE username=$1 AND kind='recovery'", [
        input.username.toLowerCase()
      ]);
      const id = randomUUID();
      const result = await tx.query(
        `INSERT INTO passkeys(
          id,user_id,credential_id,public_key,counter,transports,device_type,backed_up
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
        [
          id,
          input.userId,
          input.passkey.credentialId,
          input.passkey.publicKey,
          input.passkey.counter,
          JSON.stringify(input.passkey.transports),
          input.passkey.deviceType,
          input.passkey.backedUp
        ]
      );
      const row = result.rows[0]!;
      return {
        id: String(row.id),
        userId: String(row.user_id),
        credentialId: String(row.credential_id),
        publicKey: String(row.public_key),
        counter: Number(row.counter),
        transports: json<string[]>(row.transports),
        deviceType: String(row.device_type),
        backedUp: Boolean(row.backed_up),
        createdAt: iso(row.created_at)
      };
    });
  }

  async listPasskeys(userId: string): Promise<PasskeyRecord[]> {
    const result = await this.database.query('SELECT * FROM passkeys WHERE user_id = $1', [userId]);
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      credentialId: String(row.credential_id),
      publicKey: String(row.public_key),
      counter: Number(row.counter),
      transports: json<string[]>(row.transports),
      deviceType: String(row.device_type),
      backedUp: Boolean(row.backed_up),
      createdAt: iso(row.created_at)
    }));
  }

  async getPasskeyByCredentialId(credentialId: string): Promise<PasskeyRecord | null> {
    const result = await this.database.query('SELECT * FROM passkeys WHERE credential_id = $1', [
      credentialId
    ]);
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          credentialId: String(row.credential_id),
          publicKey: String(row.public_key),
          counter: Number(row.counter),
          transports: json<string[]>(row.transports),
          deviceType: String(row.device_type),
          backedUp: Boolean(row.backed_up),
          createdAt: iso(row.created_at)
        }
      : null;
  }

  async deletePasskeyForUser(
    userId: string,
    passkeyId: string
  ): Promise<'deleted' | 'not_found' | 'last_passkey'> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query(
        'SELECT id FROM passkeys WHERE user_id=$1 ORDER BY created_at FOR UPDATE',
        [userId]
      );
      if (!locked.rows.some((row) => String(row.id) === passkeyId)) return 'not_found';
      if (locked.rows.length <= 1) return 'last_passkey';
      const deleted = await tx.query('DELETE FROM passkeys WHERE user_id=$1 AND id=$2', [
        userId,
        passkeyId
      ]);
      return deleted.rowCount === 1 ? 'deleted' : 'not_found';
    });
  }

  async updatePasskeyCounter(id: string, counter: number): Promise<void> {
    await this.database.query('UPDATE passkeys SET counter = $2 WHERE id = $1', [id, counter]);
  }

  async createSession(
    userId: string,
    idHash: string,
    expiresAt: Date,
    publicId = randomUUID(),
    deviceLabel = 'Unknown device',
    steppedUp = false
  ): Promise<string> {
    await this.database.query(
      `INSERT INTO sessions(id_hash,user_id,expires_at,public_id,device_label,step_up_at)
       VALUES ($1,$2,$3,$4,$5,CASE WHEN $6 THEN NOW() ELSE NULL END)`,
      [idHash, userId, expiresAt.toISOString(), publicId, deviceLabel, steppedUp]
    );
    return publicId;
  }

  /**
   * Resolves a session and slides its expiry.
   *
   * A fixed window signs an actively-used device out on a schedule, which is the behaviour people
   * recognise as "it keeps asking me to log in again". Renewing once the session is past halfway
   * through its window keeps an in-use device signed in indefinitely while an abandoned one still
   * lapses on time, and the halfway test means the common request writes no new expiry.
   * `renewedExpiresAt` is returned only when it moved, so the caller can refresh the cookie then
   * and not on every request.
   */
  async getSession(
    idHash: string,
    lifetimeSeconds: number
  ): Promise<{ user: UserRecord; renewedExpiresAt: Date | null } | null> {
    const result = await this.database.query(
      // The pre-update expiry is read in a CTE because RETURNING only exposes the new row, and
      // "did the CASE fire" cannot be recovered from the new value alone.
      `WITH previous AS (
         SELECT id_hash, expires_at
         FROM sessions
         WHERE id_hash = $1 AND expires_at > NOW()
       )
       UPDATE sessions s
         SET last_seen_at = NOW(),
             expires_at = CASE
               WHEN previous.expires_at < NOW() + make_interval(secs => $2 / 2.0)
                 THEN NOW() + make_interval(secs => $2)
               ELSE previous.expires_at
             END
       FROM previous
       WHERE s.id_hash = previous.id_hash
       RETURNING s.user_id, s.expires_at,
                 (previous.expires_at < NOW() + make_interval(secs => $2 / 2.0)) AS renewed`,
      [idHash, lifetimeSeconds]
    );
    const row = result.rows[0];
    const userId = optionalText(row?.user_id);
    if (!userId) return null;
    const user = await this.getUserById(userId);
    if (!user) return null;
    return {
      user,
      renewedExpiresAt: row?.renewed === true ? new Date(String(row.expires_at)) : null
    };
  }

  async createDeviceEnrollment(input: {
    userId: string;
    tokenHash: string;
    label: string;
    issuedBySession?: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: string }> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO device_enrollments(id,user_id,token_hash,label,issued_by_session,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,expires_at`,
      [
        id,
        input.userId,
        input.tokenHash,
        input.label,
        input.issuedBySession ?? null,
        input.expiresAt.toISOString()
      ]
    );
    return { id, expiresAt: iso(result.rows[0]!.expires_at) };
  }

  /**
   * Redeems an enrollment exactly once. The consumed_at guard is inside the UPDATE so two devices
   * racing the same QR code cannot both succeed: the second matches no row.
   */
  /**
   * Whether this grant is still good, without spending it.
   *
   * The registration ceremony needs to know whose account it is building options for before the
   * authenticator has done anything, and that question used to be asked by consuming the grant. A
   * biometric prompt the owner dismissed - or an authenticator that timed out, or a phone that rang
   * mid-tap - therefore burned the link permanently, and the only way forward was to walk back to a
   * device that is already signed in and mint another one behind a passkey confirmation. Reading it
   * here and spending it in `consumeDeviceEnrollment` once a credential actually exists keeps the
   * same single-use guarantee: the UPDATE is still the only thing that marks it spent, so a second
   * device racing for the same link still loses.
   */
  async findDeviceEnrollment(tokenHash: string): Promise<{ userId: string } | null> {
    const result = await this.database.query(
      `SELECT user_id FROM device_enrollments
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash]
    );
    const userId = optionalText(result.rows[0]?.user_id);
    return userId ? { userId } : null;
  }

  async consumeDeviceEnrollment(tokenHash: string): Promise<{ userId: string } | null> {
    const result = await this.database.query(
      `UPDATE device_enrollments SET consumed_at = NOW()
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
       RETURNING user_id`,
      [tokenHash]
    );
    const userId = optionalText(result.rows[0]?.user_id);
    return userId ? { userId } : null;
  }

  async listDeviceEnrollments(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT id,label,created_at,expires_at,consumed_at,revoked_at
       FROM device_enrollments
       WHERE user_id=$1 AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      status: row.revoked_at
        ? 'revoked'
        : row.consumed_at
          ? 'used'
          : new Date(String(row.expires_at)).getTime() <= Date.now()
            ? 'expired'
            : 'pending'
    }));
  }

  async revokeDeviceEnrollment(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE device_enrollments SET revoked_at = NOW()
       WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [id, userId]
    );
    return Boolean(result.rows[0]);
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.database.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
  }

  async listSessions(userId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT public_id,device_label,created_at,last_seen_at,expires_at
       FROM sessions WHERE user_id=$1 AND public_id IS NOT NULL AND expires_at>NOW()
       ORDER BY last_seen_at DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      id: String(row.public_id),
      deviceLabel: optionalText(row.device_label) ?? 'Unknown device',
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
      expiresAt: iso(row.expires_at)
    }));
  }

  async getSessionPublicId(userId: string, idHash: string): Promise<string | null> {
    const result = await this.database.query(
      'SELECT public_id FROM sessions WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()',
      [userId, idHash]
    );
    return optionalText(result.rows[0]?.public_id);
  }

  async markSessionStepUp(userId: string, idHash: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sessions SET step_up_at=NOW(),last_seen_at=NOW()
       WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()`,
      [userId, idHash]
    );
    return result.rowCount === 1;
  }

  async hasRecentSessionStepUp(
    userId: string,
    idHash: string,
    maxAgeSeconds = 300
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    const result = await this.database.query(
      `SELECT 1 FROM sessions WHERE user_id=$1 AND id_hash=$2 AND expires_at>NOW()
       AND step_up_at >= $3`,
      [userId, idHash, cutoff]
    );
    return result.rowCount === 1;
  }

  async deleteSessionForUser(userId: string, publicId: string): Promise<string | null> {
    const result = await this.database.query(
      'DELETE FROM sessions WHERE user_id=$1 AND public_id=$2 RETURNING id_hash',
      [userId, publicId]
    );
    return result.rows[0] ? String(result.rows[0].id_hash) : null;
  }

  async createApiToken(input: {
    userId: string;
    label: string;
    tokenHash: string;
    prefix: string;
    scopes: ApiTokenRecord['scopes'];
    expiresAt: Date;
  }): Promise<ApiTokenRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const count = await tx.query(
        `SELECT COUNT(*) AS count FROM api_tokens
         WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()`,
        [input.userId]
      );
      if (Number(count.rows[0]?.count ?? 0) >= 10) throw new Error('api_token_limit');
      const result = await tx.query(
        `INSERT INTO api_tokens(id,user_id,label,token_hash,token_prefix,scopes,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.label,
          input.tokenHash,
          input.prefix,
          JSON.stringify(input.scopes),
          input.expiresAt.toISOString()
        ]
      );
      return mapApiToken(result.rows[0]!);
    });
  }

  async authenticateApiToken(
    tokenHash: string
  ): Promise<{ token: ApiTokenRecord; user: UserRecord } | null> {
    const result = await this.database.query(
      `UPDATE api_tokens SET last_used_at=NOW()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()
       RETURNING *`,
      [tokenHash]
    );
    if (!result.rows[0]) return null;
    const token = mapApiToken(result.rows[0]);
    const user = await this.getUserById(token.userId);
    return user ? { token, user } : null;
  }

  async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM api_tokens
       WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>NOW()
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(mapApiToken);
  }

  async revokeApiToken(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE api_tokens SET revoked_at=NOW()
       WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL`,
      [userId, id]
    );
    return result.rowCount === 1;
  }

  async beginOperation(input: {
    userId: string;
    idempotencyKey: string;
    method: string;
    path: string;
    requestHash: string;
    ttlHours?: number;
  }): Promise<{
    state: string;
    method: string;
    path: string;
    requestHash: string;
    responseStatus: number | null;
    responseBody: unknown;
  } | null> {
    const inserted = await this.database.query(
      `INSERT INTO api_operations(user_id,idempotency_key,method,path,request_hash,state,expires_at)
       VALUES ($1,$2,$3,$4,$5,'running',NOW()+($6 * INTERVAL '1 hour'))
       ON CONFLICT(user_id,idempotency_key) DO UPDATE SET
         state='running',response_status=NULL,response_body=NULL,updated_at=NOW(),expires_at=EXCLUDED.expires_at
       WHERE api_operations.state='failed'
         AND api_operations.method=EXCLUDED.method AND api_operations.path=EXCLUDED.path
         AND api_operations.request_hash=EXCLUDED.request_hash
       RETURNING state`,
      [
        input.userId,
        input.idempotencyKey,
        input.method,
        input.path,
        input.requestHash,
        input.ttlHours ?? 24
      ]
    );
    if (inserted.rowCount === 1) return null;
    const existing = await this.database.query(
      `SELECT state,method,path,request_hash,response_status,response_body FROM api_operations
       WHERE user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey]
    );
    const row = existing.rows[0];
    return row
      ? {
          state: String(row.state),
          method: String(row.method),
          path: String(row.path),
          requestHash: String(row.request_hash),
          responseStatus: row.response_status === null ? null : Number(row.response_status),
          responseBody: row.response_body === null ? null : json(row.response_body)
        }
      : null;
  }

  async completeOperation(
    userId: string,
    idempotencyKey: string,
    status: number,
    body: unknown
  ): Promise<void> {
    await this.database.query(
      `UPDATE api_operations SET state='completed',response_status=$3,response_body=$4::jsonb,updated_at=NOW()
       WHERE user_id=$1 AND idempotency_key=$2`,
      [userId, idempotencyKey, status, JSON.stringify(body)]
    );
  }

  async failOperation(userId: string, idempotencyKey: string): Promise<void> {
    await this.database.query(
      `UPDATE api_operations SET state='failed',updated_at=NOW() WHERE user_id=$1 AND idempotency_key=$2`,
      [userId, idempotencyKey]
    );
  }

  async recordSecurityEvent(input: {
    userId?: string;
    kind: string;
    outcome: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO security_events(id,user_id,kind,outcome,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        randomUUID(),
        input.userId ?? null,
        input.kind,
        input.outcome,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }

  async createWorkspace(input: {
    id?: string;
    userId: string;
    name: string;
    storageLimitBytes: number;
    imageRevision: string;
    region: string;
    wrappedKey: string;
    keyProtection?: WorkspaceRecord['keyProtection'];
    securityMode?: WorkspaceRecord['securityMode'];
  }): Promise<WorkspaceRecord> {
    const id = input.id ?? randomUUID();
    const result = await this.database.query(
      `INSERT INTO workspaces(
        id, user_id, name, status, storage_limit_bytes, image_revision, region,
        security_mode
      ) VALUES ($1,$2,$3,'provisioning',$4,$5,$6,$7) RETURNING *`,
      [
        id,
        input.userId,
        input.name,
        input.storageLimitBytes,
        input.imageRevision,
        input.region,
        input.securityMode ?? 'balanced'
      ]
    );
    await this.database.query(
      'INSERT INTO workspace_keys(workspace_id, wrapped_key, wrapping_mode) VALUES ($1, $2, $3)',
      [id, input.wrappedKey, input.keyProtection ?? 'hosted']
    );
    return { ...mapWorkspace(result.rows[0]!), wrappedKey: input.wrappedKey };
  }

  async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const result = await this.database.query(
      `SELECT w.*, k.wrapped_key, k.wrapping_mode FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id
       WHERE w.user_id = $1 ORDER BY w.created_at DESC`,
      [userId]
    );
    return result.rows.map(mapWorkspace);
  }

  async getWorkspace(userId: string, id: string): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `SELECT w.*,k.wrapped_key,k.wrapping_mode FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id
       WHERE w.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  async getWorkspaceById(id: string): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `SELECT w.*, k.wrapped_key, k.wrapping_mode FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id = w.id WHERE w.id = $1`,
      [id]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  /** Whether this workspace is the caller's at all. The only access question left on one box. */
  async workspaceBelongsToUser(userId: string, workspaceId: string): Promise<boolean> {
    const result = await this.database.query(
      'SELECT 1 FROM workspaces WHERE id=$1 AND user_id=$2',
      [workspaceId, userId]
    );
    return result.rows.length === 1;
  }

  async updateWorkspaceStatus(
    id: string,
    status: string,
    runnerRef?: string | null
  ): Promise<void> {
    await this.database.query(
      `UPDATE workspaces
       SET status = $2,
           runner_ref = COALESCE($3, runner_ref),
           compute_metered_at = CASE
             WHEN $2='running' AND status<>'running' THEN NOW()
             WHEN $2<>'running' THEN NULL
             ELSE compute_metered_at
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [id, status, runnerRef ?? null]
    );
  }

  async listRunningWorkspaces(): Promise<WorkspaceRecord[]> {
    const result = await this.database.query(
      `SELECT w.*,k.wrapped_key,k.wrapping_mode FROM workspaces w
       JOIN workspace_keys k ON k.workspace_id=w.id
       WHERE w.status='running'
       ORDER BY w.compute_metered_at ASC NULLS FIRST, w.id LIMIT 500`
    );
    return result.rows.map(mapWorkspace);
  }

  async settleWorkspaceCompute(
    id: string,
    creditsPerHour: number,
    at = new Date()
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<{
        id: string;
        user_id: string;
        status: string;
        compute_metered_at: unknown;
        updated_at: unknown;
      }>(
        `SELECT id,user_id,status,compute_metered_at,updated_at
         FROM workspaces WHERE id=$1 FOR UPDATE`,
        [id]
      );
      const workspace = result.rows[0];
      if (!workspace || workspace.status !== 'running') return 0;
      const startedAt = new Date(String(workspace.compute_metered_at ?? workspace.updated_at));
      const milliseconds = Math.max(0, at.getTime() - startedAt.getTime());
      if (milliseconds === 0) return 0;
      const hours = milliseconds / 3_600_000;
      const credits = hours * creditsPerHour;
      const idempotencyKey = `workspace-runtime:${id}:${startedAt.toISOString()}:${at.toISOString()}`;
      await transaction.query(
        `INSERT INTO usage_entries(
          id,user_id,workspace_id,kind,resource_class,quantity,unit,credits,state,idempotency_key,
          created_at
         ) VALUES ($1,$2,$3,'workspace_compute',$4,$5,'hours',$6,'settled',$7,$8)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          workspace.user_id,
          id,
          // There is one computer and it is the box this is installed on, so the class of thing
          // these hours were spent on says exactly that.
          'workspace',
          hours,
          credits,
          idempotencyKey,
          at.toISOString()
        ]
      );
      await transaction.query('UPDATE workspaces SET compute_metered_at=$2 WHERE id=$1', [
        id,
        at.toISOString()
      ]);
      return credits;
    });
  }

  async touchWorkspace(userId: string, id: string): Promise<void> {
    await this.database.query('UPDATE workspaces SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [
      id,
      userId
    ]);
  }

  async setWorkspaceStorage(userId: string, id: string, storageBytes: number): Promise<void> {
    await this.database.query(
      'UPDATE workspaces SET storage_bytes=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2',
      [id, userId, storageBytes]
    );
  }

  async updateWorkspaceResources(
    userId: string,
    id: string,
    storageLimitBytes?: number
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workspaces SET storage_limit_bytes=COALESCE($3,storage_limit_bytes),updated_at=NOW()
       WHERE id=$1 AND user_id=$2`,
      [id, userId, storageLimitBytes ?? null]
    );
    return result.rowCount === 1;
  }

  async deleteWorkspace(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM workspaces WHERE id=$1 AND user_id=$2', [
      id,
      userId
    ]);
    return result.rowCount === 1;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM users WHERE id=$1', [id]);
    return result.rowCount === 1;
  }

  async createWorkspaceSnapshot(input: {
    userId: string;
    workspaceId: string;
    name: string;
    sizeBytes: number;
  }): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `INSERT INTO workspace_snapshots(id,user_id,workspace_id,name,status,size_bytes)
       SELECT $1,$2,w.id,$4,'creating',$5 FROM workspaces w
       WHERE w.id=$3 AND w.user_id=$2
       RETURNING *`,
      [randomUUID(), input.userId, input.workspaceId, input.name, input.sizeBytes]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Workspace not found');
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      status: String(row.status),
      sizeBytes: Number(row.size_bytes),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async listWorkspaceSnapshots(
    userId: string,
    workspaceId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT s.id,s.workspace_id,s.name,s.status,s.size_bytes,s.created_at,s.updated_at
       FROM workspace_snapshots s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.workspace_id=$2 AND w.user_id=$1
       ORDER BY s.created_at DESC`,
      [userId, workspaceId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      status: String(row.status),
      sizeBytes: Number(row.size_bytes),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async getWorkspaceSnapshot(
    userId: string,
    workspaceId: string,
    id: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.database.query(
      `SELECT s.id,s.workspace_id,s.name,s.status,s.size_bytes,s.created_at,s.updated_at
       FROM workspace_snapshots s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$1 AND s.workspace_id=$3 AND w.user_id=$2`,
      [id, userId, workspaceId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          name: String(row.name),
          status: String(row.status),
          sizeBytes: Number(row.size_bytes),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  async setWorkspaceSnapshotStatus(
    id: string,
    status: 'creating' | 'ready' | 'failed' | 'deleting'
  ): Promise<void> {
    await this.database.query(
      'UPDATE workspace_snapshots SET status=$2,updated_at=NOW() WHERE id=$1',
      [id, status]
    );
  }

  async completeWorkspaceSnapshot(id: string, sizeBytes: number): Promise<void> {
    await this.database.query(
      `UPDATE workspace_snapshots
       SET status='ready',size_bytes=$2,updated_at=NOW()
       WHERE id=$1`,
      [id, Math.max(0, Math.floor(sizeBytes))]
    );
  }

  async deleteWorkspaceSnapshot(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_snapshots WHERE id=$1 AND workspace_id=$3 AND EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id=workspace_snapshots.workspace_id AND w.user_id=$2
      )`,
      [id, userId, workspaceId]
    );
    return result.rowCount === 1;
  }

  /**
   * Records a turn checkpoint the runner has already taken.
   *
   * `event_sequence` is captured here rather than passed in, because the point of the column is to
   * anchor the checkpoint to the transcript as it stood at that instant, and the caller taking the
   * checkpoint is mid-turn and does not know that number.
   */
  async recordWorkspaceCheckpoint(input: {
    id: string;
    workspaceId: string;
    taskId: string | null;
    turn: number;
    mechanism: WorkspaceCheckpointRecord['mechanism'];
    fileCount: number | null;
    totalBytes: number | null;
    storedBytes: number;
    durationMs: number;
  }): Promise<WorkspaceCheckpointRecord> {
    const result = await this.database.query(
      // The owner is taken from the workspace rather than from the caller: the worker records a
      // fact about a machine, and every read below is what decides who may see it.
      `INSERT INTO workspace_checkpoints(
         id,user_id,workspace_id,task_id,turn,event_sequence,mechanism,
         file_count,total_bytes,stored_bytes,duration_ms)
       SELECT $1,w.user_id,w.id,$3,$4,
         -- The position this checkpoint's content belongs to, not the position it was written at.
         -- It holds the computer as it was before this turn changed anything, so it anchors to the
         -- message that started the turn. Recording where it happened to be taken - after that
         -- message and after the status lines - put it beyond the only anchor the client offers,
         -- and an owner asking to undo their own message was told there was nothing to undo. A run
         -- with no message of its own, which is what a schedule is, keeps the position it was
         -- taken at.
         COALESCE(
           (SELECT MAX(e.sequence) FROM task_events e
             WHERE e.task_id=$3 AND e.kind='user_message'),
           (SELECT MAX(e.sequence) FROM task_events e WHERE e.task_id=$3)),
         $5,$6,$7,$8,$9
       FROM workspaces w WHERE w.id=$2
       RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.taskId,
        Math.max(0, Math.floor(input.turn)),
        input.mechanism,
        input.fileCount === null ? null : Math.max(0, Math.floor(input.fileCount)),
        input.totalBytes === null ? null : Math.max(0, Math.floor(input.totalBytes)),
        Math.max(0, Math.floor(input.storedBytes)),
        Math.max(0, Math.floor(input.durationMs))
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Workspace not found');
    return mapWorkspaceCheckpoint(row);
  }

  async getWorkspaceCheckpoint(
    userId: string,
    id: string
  ): Promise<WorkspaceCheckpointRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM workspace_checkpoints WHERE id=$1 AND user_id=$2',
      [id, userId]
    );
    const row = result.rows[0];
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  /**
   * The checkpoint that holds the computer as it was at a point in the transcript.
   *
   * The newest one at or before that event, because a checkpoint is taken in front of the work a
   * turn is about to do: anything later already contains changes the owner is asking to undo. A
   * null answer is a real answer - the turn changed nothing, or its checkpoint has been pruned -
   * and the caller must say so rather than silently rewind somewhere else.
   *
   * `event_sequence` is the transcript position at the moment the checkpoint was taken, so two
   * checkpoints taken before the turn wrote anything carry the same number. The oldest of those is
   * the only one that is in front of all the work at that position, and it is chosen explicitly:
   * without the tiebreaker the database was free to hand back either, and restoring the wrong one
   * silently keeps changes the owner asked to undo.
   */
  async checkpointForTaskEvent(
    userId: string,
    taskId: string,
    eventId: string
  ): Promise<WorkspaceCheckpointRecord | null> {
    const result = await this.database.query(
      `SELECT c.* FROM workspace_checkpoints c
       WHERE c.task_id=$2 AND c.user_id=$1 AND c.event_sequence IS NOT NULL
         AND c.event_sequence <= COALESCE(
           (SELECT e.sequence FROM task_events e WHERE e.id=$3 AND e.task_id=$2), -1)
       ORDER BY c.event_sequence DESC, c.taken_seq ASC LIMIT 1`,
      [userId, taskId, eventId]
    );
    const row = result.rows[0];
    return row ? mapWorkspaceCheckpoint(row) : null;
  }

  /** Forgets checkpoints the runner has already pruned from disk. */
  async deleteWorkspaceCheckpoints(workspaceId: string, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const result = await this.database.query(
      'DELETE FROM workspace_checkpoints WHERE workspace_id=$1 AND id = ANY($2::uuid[])',
      [workspaceId, ids]
    );
    return result.rowCount ?? 0;
  }

  async createTask(input: {
    userId: string;
    workspaceId: string;
    titleCiphertext: EncryptedEnvelope;
    modelId: string;
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    promptCiphertext: EncryptedEnvelope;
    securityMode?: TaskRecord['securityMode'];
  }): Promise<TaskRecord> {
    const id = randomUUID();
    const result = await this.database.query(
      `INSERT INTO tasks(
        id,user_id,workspace_id,title,status,model_id,privacy_route,max_compute_credits,
        prompt_ciphertext,security_mode,max_spend_usd
       ) VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
      [
        id,
        input.userId,
        input.workspaceId,
        JSON.stringify(input.titleCiphertext),
        input.modelId,
        input.privacyRoute,
        input.maxComputeCredits,
        JSON.stringify(input.promptCiphertext),
        input.securityMode ?? 'balanced',
        input.maxSpendUsd ?? null
      ]
    );
    const task = mapTask(result.rows[0]!);
    this.#signal(TASK_QUEUE_CHANNEL, task.id);
    return task;
  }

  async createTaskBranch(input: {
    id?: string;
    userId: string;
    workspaceId: string;
    parentTaskId: string;
    branchedFromEventId?: string;
    forkKind?: NonNullable<TaskRecord['forkKind']>;
    titleCiphertext: EncryptedEnvelope;
    modelId: string;
    privacyRoute: string;
    promptCiphertext: EncryptedEnvelope;
    agentStateCiphertext: EncryptedEnvelope | null;
    status?: 'completed' | 'queued';
    maxComputeCredits?: number;
    maxSpendUsd?: number | null;
    securityMode?: TaskRecord['securityMode'];
    /** Which of the two this fork rewound. Defaults to the conversation, as it always did. */
    rewindScope?: NonNullable<TaskRecord['rewindScope']>;
    /** The checkpoint the computer was put back to, when this fork rewound it. */
    restoredCheckpointId?: string | null;
  }): Promise<TaskRecord> {
    const id = input.id ?? randomUUID();
    const result = await this.database.query(
      `INSERT INTO tasks(
        id,user_id,workspace_id,parent_task_id,branched_from_event_id,title,status,model_id,
        privacy_route,max_compute_credits,prompt_ciphertext,agent_state_ciphertext,completed_at,
        fork_kind,security_mode,max_spend_usd,rewind_scope,restored_checkpoint_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,
        CASE WHEN $7='completed' THEN NOW() ELSE NULL END,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        id,
        input.userId,
        input.workspaceId,
        input.parentTaskId,
        input.branchedFromEventId ?? null,
        JSON.stringify(input.titleCiphertext),
        input.status ?? 'completed',
        input.modelId,
        input.privacyRoute,
        input.maxComputeCredits ?? 0,
        JSON.stringify(input.promptCiphertext),
        input.agentStateCiphertext ? JSON.stringify(input.agentStateCiphertext) : null,
        input.forkKind ?? 'branch',
        input.securityMode ?? 'balanced',
        input.maxSpendUsd ?? null,
        input.rewindScope ?? 'conversation',
        input.restoredCheckpointId ?? null
      ]
    );
    const fork = mapTask(result.rows[0]!);
    if (fork.status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, fork.id);
    return fork;
  }

  async continueTask(input: {
    id: string;
    userId: string;
    modelId: string;
    privacyRoute: string;
    additionalComputeCredits: number;
    /** Extra real currency this follow-up may spend, on top of what the task already spent. */
    additionalSpendUsd?: number | null;
    agentStateCiphertext: EncryptedEnvelope;
    reservationKey: string;
    resourceClass: string;
    userMessageCiphertext: EncryptedEnvelope;
  }): Promise<TaskRecord | null> {
    const resumed = await this.database.transaction(async (tx) => {
      const updated = await tx.query(
        // A follow-up on a task that had no dollar ceiling is allowed to introduce one, so the new
        // ceiling is anchored to what the task has already spent rather than to zero - otherwise
        // asking for "$2 more" on a task that spent $5 would read as an instantly-breached cap.
        `UPDATE tasks SET
           status='queued', model_id=$3, privacy_route=$4,
           max_compute_credits=max_compute_credits+$5,
           max_spend_usd=CASE WHEN $7::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=tasks.id AND u.state='settled')) + $7::double precision END,
           agent_state_ciphertext=$6::jsonb,
           lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL, updated_at=NOW()
         WHERE id=$1 AND user_id=$2
           AND status IN ('completed','failed','awaiting_resource','cancelled')
           AND lease_owner IS NULL
         RETURNING *`,
        [
          input.id,
          input.userId,
          input.modelId,
          input.privacyRoute,
          input.additionalComputeCredits,
          JSON.stringify(input.agentStateCiphertext),
          input.additionalSpendUsd ?? null
        ]
      );
      if (!updated.rows[0]) return null;
      await tx.query(
        `INSERT INTO usage_entries(
           id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
           idempotency_key
         ) SELECT $1,$2,workspace_id,id,'task_compute',$3,$4,'credits',$4,'reserved',$5
           FROM tasks WHERE id=$6
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.userId,
          input.resourceClass,
          input.additionalComputeCredits,
          input.reservationKey,
          input.id
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'user_message','User message',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.id, JSON.stringify(input.userMessageCiphertext)]
      );
      return mapTask(updated.rows[0]);
    });
    if (resumed) {
      this.#signal(TASK_QUEUE_CHANNEL, resumed.id);
      this.#signal(TASK_EVENT_CHANNEL, resumed.id);
    }
    return resumed;
  }

  async enqueueTaskMessage(input: {
    id: string;
    taskId: string;
    userId: string;
    modelId: string;
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    resourceClass: string;
    reservationKey: string;
    promptCiphertext: EncryptedEnvelope;
    queuedEventCiphertext: EncryptedEnvelope;
    /** Apply this to the turn already running rather than waiting for it to finish. */
    interrupt?: boolean;
  }): Promise<TaskRecord | null> {
    const queued = await this.database.transaction(async (tx) => {
      const taskResult = await tx.query(
        `SELECT t.*,
           (SELECT COUNT(*) FROM task_message_queue q
             WHERE q.task_id=t.id AND q.status='queued') AS queued_message_count
         FROM tasks t WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE`,
        [input.taskId, input.userId]
      );
      const row = taskResult.rows[0];
      if (
        !row ||
        !['queued', 'planning', 'running', 'awaiting_user', 'paused'].includes(String(row.status))
      )
        return null;
      await tx.query(
        `INSERT INTO task_message_queue(
           id,task_id,user_id,prompt_ciphertext,model_id,privacy_route,max_compute_credits,
           resource_class,reservation_key,max_spend_usd,interrupt
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.id,
          input.taskId,
          input.userId,
          JSON.stringify(input.promptCiphertext),
          input.modelId,
          input.privacyRoute,
          input.maxComputeCredits,
          input.resourceClass,
          input.reservationKey,
          input.maxSpendUsd ?? null,
          input.interrupt ?? false
        ]
      );
      await tx.query(
        `INSERT INTO usage_entries(
           id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
           idempotency_key
         ) SELECT $1,$2,workspace_id,id,'task_compute',$3,$4,'credits',$4,'reserved',$5
           FROM tasks WHERE id=$6
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          input.userId,
          input.resourceClass,
          input.maxComputeCredits,
          input.reservationKey,
          input.taskId
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'queued_message','Follow-up queued',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, JSON.stringify(input.queuedEventCiphertext)]
      );
      return mapTask({
        ...row,
        queued_message_count: Number(row.queued_message_count ?? 0) + 1
      });
    });
    if (queued) this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    return queued;
  }

  async getNextQueuedTaskMessage(taskId: string): Promise<TaskMessageQueueRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM task_message_queue
       WHERE task_id=$1 AND status='queued'
       ORDER BY created_at,id LIMIT 1`,
      [taskId]
    );
    return result.rows[0] ? mapTaskMessage(result.rows[0]) : null;
  }

  /**
   * Takes a queued message into the turn that is already running, rather than handing it the next
   * one. The row is marked promoted, the credit ceiling is raised by what the message reserved -
   * without that the loop trips its own budget on the very next iteration - and a `user_message`
   * event is written so the transcript and the timeline show the correction where it landed.
   *
   * Deliberately not a variant of `promoteQueuedTaskMessage`: that one ends a turn and releases the
   * lease so the worker can pick the task up fresh. This one keeps both, because keeping the turn
   * is the entire point - everything the agent has already done stays in the window.
   */
  async consumeQueuedTaskMessageInTurn(input: {
    taskId: string;
    messageId: string;
    workerId: string;
    additionalComputeCredits: number;
    additionalSpendUsd?: number | null;
    userMessageCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    const consumed = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.taskId, input.workerId]
      );
      if (!locked.rows[0]) return false;
      const queued = await tx.query(
        `SELECT id FROM task_message_queue
         WHERE id=$1 AND task_id=$2 AND status='queued' FOR UPDATE`,
        [input.messageId, input.taskId]
      );
      if (!queued.rows[0]) return false;
      await tx.query(
        `UPDATE task_message_queue SET status='promoted',promoted_at=NOW() WHERE id=$1`,
        [input.messageId]
      );
      await tx.query(
        `UPDATE tasks SET
           max_compute_credits=max_compute_credits+$3,
           max_spend_usd=CASE WHEN $4::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=tasks.id AND u.state='settled')) + $4::double precision END,
           updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2`,
        [input.taskId, input.workerId, input.additionalComputeCredits, input.additionalSpendUsd ?? null]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         SELECT $1,$2,COALESCE(MAX(sequence),0)+1,'user_message','User message',$3::jsonb
         FROM task_events WHERE task_id=$2`,
        [randomUUID(), input.taskId, JSON.stringify(input.userMessageCiphertext)]
      );
      return true;
    });
    if (consumed) this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    return consumed;
  }

  async promoteQueuedTaskMessage(input: {
    taskId: string;
    messageId: string;
    workerId: string;
    modelId: string;
    privacyRoute: string;
    additionalComputeCredits: number;
    additionalSpendUsd?: number | null;
    agentStateCiphertext: EncryptedEnvelope;
    userMessageCiphertext: EncryptedEnvelope;
    statusEventCiphertext: EncryptedEnvelope;
  }): Promise<TaskRecord | null> {
    const promoted = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.taskId, input.workerId]
      );
      if (!locked.rows[0]) return null;
      const queued = await tx.query(
        `SELECT id FROM task_message_queue
         WHERE id=$1 AND task_id=$2 AND status='queued' FOR UPDATE`,
        [input.messageId, input.taskId]
      );
      if (!queued.rows[0]) return null;
      await tx.query(
        `UPDATE task_message_queue SET status='promoted',promoted_at=NOW() WHERE id=$1`,
        [input.messageId]
      );
      const updated = await tx.query(
        `UPDATE tasks SET
           status='queued',model_id=$3,privacy_route=$4,
           max_compute_credits=max_compute_credits+$5,
           max_spend_usd=CASE WHEN $7::double precision IS NULL THEN max_spend_usd ELSE
             COALESCE(max_spend_usd, (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=tasks.id AND u.state='settled')) + $7::double precision END,
           agent_state_ciphertext=$6::jsonb,lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NULL,updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2
         RETURNING *`,
        [
          input.taskId,
          input.workerId,
          input.modelId,
          input.privacyRoute,
          input.additionalComputeCredits,
          JSON.stringify(input.agentStateCiphertext),
          input.additionalSpendUsd ?? null
        ]
      );
      if (!updated.rows[0]) throw new Error('queued_message_promotion_conflict');
      const existingEvents = await tx.query(
        'SELECT COALESCE(MAX(sequence),0) AS sequence FROM task_events WHERE task_id=$1',
        [input.taskId]
      );
      const sequence = Number(existingEvents.rows[0]?.sequence ?? 0);
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         VALUES ($1,$2,$3,'status','Queued follow-up started',$4::jsonb),
                ($5,$2,$6,'user_message','User message',$7::jsonb)`,
        [
          randomUUID(),
          input.taskId,
          sequence + 1,
          JSON.stringify(input.statusEventCiphertext),
          randomUUID(),
          sequence + 2,
          JSON.stringify(input.userMessageCiphertext)
        ]
      );
      const remaining = await tx.query(
        `SELECT COUNT(*) AS count FROM task_message_queue
         WHERE task_id=$1 AND status='queued'`,
        [input.taskId]
      );
      return mapTask({
        ...updated.rows[0],
        queued_message_count: Number(remaining.rows[0]?.count ?? 0)
      });
    });
    if (promoted) this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    return promoted;
  }

  async completeTaskIfNoQueued(input: {
    id: string;
    workerId: string;
    actualComputeCredits: number;
    agentStateCiphertext: EncryptedEnvelope;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT id FROM tasks WHERE id=$1 AND lease_owner=$2 FOR UPDATE`,
        [input.id, input.workerId]
      );
      if (!locked.rows[0]) return false;
      const queued = await tx.query(
        `SELECT id FROM task_message_queue
         WHERE task_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1`,
        [input.id]
      );
      if (queued.rows[0]) return false;
      const result = await tx.query(
        `UPDATE tasks SET status='completed',actual_compute_credits=$3,
           agent_state_ciphertext=$4::jsonb,lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2`,
        [
          input.id,
          input.workerId,
          input.actualComputeCredits,
          JSON.stringify(input.agentStateCiphertext)
        ]
      );
      return result.rowCount === 1;
    });
  }

  /**
   * Every conversation in one workspace, archived ones included. Search, export and the "is
   * anything still running here" check all need the whole set, so this one is deliberately not
   * paged: truncating it would quietly narrow a search rather than slow it down.
   */
  async listTasks(userId: string, workspaceId: string): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT t.*,
         (SELECT COUNT(*) FROM task_message_queue q
           WHERE q.task_id=t.id AND q.status='queued') AS queued_message_count,
         (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
           WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) AS spent_usd
       FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.workspace_id=$2 AND w.user_id=$1
       ORDER BY t.created_at DESC`,
      [userId, workspaceId]
    );
    return result.rows.map(mapTask);
  }

  /**
   * One page of the sidebar.
   *
   * Ordered by last activity rather than by creation, because a conversation the owner returned to
   * this morning belongs at the top however old it is; pinned conversations sit above all of it.
   * The row comparison is exactly the ORDER BY read backwards, which is what makes the cursor a
   * position in this list rather than a count of rows already seen.
   */
  async listTaskPage(
    userId: string,
    options: {
      workspaceId?: string;
      limit?: number;
      cursor?: string | null;
      include?: TaskListFilter;
    } = {}
  ): Promise<TaskPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TASK_PAGE));
    const position = options.cursor ? decodeTaskCursor(options.cursor) : null;
    const include = options.include ?? 'active';
    const result = await this.database.query(
      // The ordering key is selected as the database's own text as well as being ordered on, so the
      // cursor for the last row of this page is the exact value the next page compares against.
      `SELECT t.*,
         GREATEST(t.updated_at, t.created_at)::text AS activity_at,
         (SELECT COUNT(*) FROM task_message_queue q
           WHERE q.task_id=t.id AND q.status='queued') AS queued_message_count,
         (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
           WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) AS spent_usd
       FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE w.user_id=$1
         AND ($2::uuid IS NULL OR t.workspace_id=$2)
         AND ($3::text = 'all'
              OR ($3::text = 'active' AND t.archived_at IS NULL)
              OR ($3::text = 'archived' AND t.archived_at IS NOT NULL))
         AND ($4::boolean IS NULL OR
              (t.pinned, GREATEST(t.updated_at, t.created_at), t.id)
                < ($4::boolean, $5::timestamptz, $6::uuid))
       ORDER BY t.pinned DESC, GREATEST(t.updated_at, t.created_at) DESC, t.id DESC
       LIMIT $7`,
      [
        userId,
        options.workspaceId ?? null,
        include,
        position?.pinned ?? null,
        position?.activityAt ?? null,
        position?.id ?? null,
        limit + 1
      ]
    );
    // One row past the page is what proves there is more without a second count query.
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows.at(-1);
    return {
      tasks: rows.map(mapTask),
      hasMore,
      nextCursor: hasMore && last ? encodeTaskCursor(last) : null
    };
  }

  /**
   * Pins a conversation above the recency buckets, files it away, or both.
   *
   * Neither touches `updated_at`: filing a conversation is not activity in it, and moving it to
   * the top of the list as a side effect of archiving it would be the opposite of what was asked.
   */
  async updateTaskFiling(
    userId: string,
    id: string,
    input: { pinned?: boolean; archived?: boolean }
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks t SET
         pinned = COALESCE($3::boolean, pinned),
         archived_at = CASE
           WHEN $4::boolean IS NULL THEN archived_at
           WHEN $4::boolean THEN COALESCE(archived_at, NOW())
           ELSE NULL END
       FROM workspaces w
       WHERE t.id=$1 AND w.id=t.workspace_id AND w.user_id=$2
       RETURNING t.*, 0 AS queued_message_count`,
      [id, userId, input.pinned ?? null, input.archived ?? null]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async getTask(userId: string, id: string): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `SELECT t.*,
         (SELECT COUNT(*) FROM task_message_queue q
           WHERE q.task_id=t.id AND q.status='queued') AS queued_message_count,
         (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
           WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) AS spent_usd
       FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Renames a conversation. The title is encrypted like every other task field, so the caller
   * supplies the envelope rather than plaintext.
   *
   * The name becomes the owner's, which is what stops the titler from ever touching it again.
   */
  async renameTask(
    userId: string,
    id: string,
    titleCiphertext: EncryptedEnvelope
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks t SET title=$3::jsonb, title_source='owner', updated_at=NOW()
       FROM workspaces w
       WHERE t.id=$1 AND w.id=t.workspace_id AND w.user_id=$2
       RETURNING t.*, 0 AS queued_message_count`,
      [id, userId, JSON.stringify(titleCiphertext)]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  /**
   * Conversations still wearing the first words of their prompt as a name, whose first exchange is
   * complete enough to be read. Ordered oldest first so a backlog left by a restart is worked
   * through in the order the owner created it.
   */
  async listTasksNeedingTitle(limit = 5): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT t.*, 0 AS queued_message_count
       FROM tasks t
       WHERE t.title_source='prompt'
         AND EXISTS (
           SELECT 1 FROM task_events e
           WHERE e.task_id=t.id AND e.kind='assistant_message')
       ORDER BY t.created_at, t.id
       LIMIT $1`,
      [Math.max(1, Math.min(Math.trunc(limit), 50))]
    );
    return result.rows.map(mapTask);
  }

  /**
   * Writes a title the box worked out for itself.
   *
   * Conditional on the placeholder still being in place: an owner who renamed the conversation
   * while the model was thinking keeps their name, and the answer that arrives late is dropped
   * rather than allowed to overwrite it. `updated_at` is left alone so naming a conversation does
   * not reorder the sidebar.
   */
  async setGeneratedTaskTitle(id: string, titleCiphertext: EncryptedEnvelope): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET title=$2::jsonb, title_source='generated'
       WHERE id=$1 AND title_source='prompt'`,
      [id, JSON.stringify(titleCiphertext)]
    );
    return result.rowCount === 1;
  }

  /**
   * Deletes a conversation and everything hanging off it. Child forks are detached rather than
   * deleted, so removing an experiment never silently takes the branches taken from it.
   */
  async deleteTask(userId: string, id: string): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const owned = await tx.query(
        `SELECT t.id FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
         WHERE t.id=$1 AND w.user_id=$2 FOR UPDATE OF t`,
        [id, userId]
      );
      if (!owned.rows[0]) return false;
      await tx.query('UPDATE tasks SET parent_task_id=NULL WHERE parent_task_id=$1', [id]);
      await tx.query('DELETE FROM task_events WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM task_message_queue WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM task_plans WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM approvals WHERE task_id=$1', [id]);
      await tx.query('DELETE FROM tasks WHERE id=$1', [id]);
      return true;
    });
  }

  async createTaskPlan(input: {
    taskId: string;
    expectedVersion: number;
    parentVersion?: number;
    branchName: string;
    stepsCiphertext: EncryptedEnvelope;
    createdBy: TaskPlanRecord['createdBy'];
  }): Promise<TaskPlanRecord> {
    return this.database.transaction(async (tx) => {
      const task = await tx.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [input.taskId]);
      if (!task.rows[0]) throw new Error('task_not_found');
      const latest = await tx.query(
        'SELECT COALESCE(MAX(version),0) AS version FROM task_plans WHERE task_id=$1',
        [input.taskId]
      );
      const currentVersion = Number(latest.rows[0]?.version ?? 0);
      if (currentVersion !== input.expectedVersion) throw new Error('plan_version_conflict');
      const parentVersion = input.parentVersion ?? (currentVersion || null);
      if (parentVersion !== null) {
        const parent = await tx.query('SELECT 1 FROM task_plans WHERE task_id=$1 AND version=$2', [
          input.taskId,
          parentVersion
        ]);
        if (!parent.rows[0]) throw new Error('plan_parent_not_found');
      }
      const result = await tx.query(
        `INSERT INTO task_plans(
          id,task_id,version,parent_version,branch_name,steps_ciphertext,created_by
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
        [
          randomUUID(),
          input.taskId,
          currentVersion + 1,
          parentVersion,
          'encrypted',
          JSON.stringify(input.stepsCiphertext),
          input.createdBy
        ]
      );
      return mapTaskPlan(result.rows[0]!);
    });
  }

  async getLatestTaskPlan(taskId: string): Promise<TaskPlanRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 1',
      [taskId]
    );
    return result.rows[0] ? mapTaskPlan(result.rows[0]) : null;
  }

  async listTaskPlans(taskId: string): Promise<TaskPlanRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM task_plans WHERE task_id=$1 ORDER BY version DESC LIMIT 100',
      [taskId]
    );
    return result.rows.map(mapTaskPlan);
  }

  async listWorkspaceMemories(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceMemoryRecord[]> {
    const result = await this.database.query(
      `SELECT m.* FROM workspace_memories m
       JOIN workspaces w ON w.id=m.workspace_id
       WHERE m.workspace_id=$2 AND w.user_id=$1
       ORDER BY m.target,m.created_at,m.id`,
      [userId, workspaceId]
    );
    return result.rows.map(mapWorkspaceMemory);
  }

  async createWorkspaceMemory(input: {
    userId: string;
    workspaceId: string;
    target: WorkspaceMemoryRecord['target'];
    contentCiphertext: EncryptedEnvelope;
    validUntil?: string | null;
  }): Promise<WorkspaceMemoryRecord> {
    const result = await this.database.query(
      `INSERT INTO workspace_memories(
        id,user_id,workspace_id,target,content_ciphertext,valid_until
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId,
        input.target,
        JSON.stringify(input.contentCiphertext),
        input.validUntil ?? null
      ]
    );
    return mapWorkspaceMemory(result.rows[0]!);
  }

  async updateWorkspaceMemory(input: {
    id: string;
    userId: string;
    workspaceId: string;
    contentCiphertext: EncryptedEnvelope;
    validUntil?: string | null;
  }): Promise<WorkspaceMemoryRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_memories SET content_ciphertext=$4::jsonb,valid_until=$5,updated_at=NOW()
       WHERE id=$1 AND workspace_id=$3 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_memories.workspace_id AND w.user_id=$2
       ) RETURNING *`,
      [
        input.id,
        input.userId,
        input.workspaceId,
        JSON.stringify(input.contentCiphertext),
        input.validUntil ?? null
      ]
    );
    return result.rows[0] ? mapWorkspaceMemory(result.rows[0]) : null;
  }

  async deleteWorkspaceMemory(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_memories WHERE id=$3 AND workspace_id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_memories.workspace_id AND w.user_id=$1
       )`,
      [userId, workspaceId, id]
    );
    return result.rowCount === 1;
  }

  /* ---------------------------------------------------------------- *
   * Tiered agent memory
   * ---------------------------------------------------------------- */

  async memoryCapabilities(): Promise<MemoryCapabilities> {
    this.#memoryCapabilities ??= this.database
      .query<{
        extname: string;
      }>(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)
      .then((result) => ({ trigram: result.rows.length > 0 }));
    return this.#memoryCapabilities;
  }

  /**
   * Reconciles the database copy of the predicate registry with the vetted in-repo one. The
   * registry is deliberately not extensible at runtime, so this only ever writes what ships.
   */
  async syncMemoryPredicates(): Promise<number> {
    let written = 0;
    for (const predicate of MEMORY_PREDICATES) {
      const result = await this.database.query(
        `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE
           SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
               description=EXCLUDED.description`,
        [predicate.name, predicate.cardinality, predicate.isTemporal, predicate.description]
      );
      written += result.rowCount;
    }
    return written;
  }

  async createMemorySource(input: {
    userId: string;
    workspaceId: string;
    channel: MemorySourceChannel;
    bodyCiphertext: EncryptedEnvelope;
    bodyTokens: string;
    tokensEst: number;
    indexed?: boolean;
    role?: string | null;
    taskId?: string | null;
    episodeId?: string | null;
    /** Sealed provenance: paths, URLs, cwd, exit codes. Never written in the clear. */
    originCiphertext?: EncryptedEnvelope | null;
    /** Keyed hash of the locator, from `memoryOriginKey`; the only origin column SQL can match. */
    originKey?: string | null;
    chunkIndex?: number;
    chunkOf?: string | null;
    occurredAt?: Date | string;
    /**
     * Every other memory write takes a caller-supplied id and this one minted its own, which made
     * a corpus impossible to reproduce: two rows the ranking cannot separate are ordered by id, so
     * a random one decides which of them the pack carries and the same store answers the same
     * question differently on a second run.
     */
    id?: string;
  }): Promise<MemorySourceRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.source(
         id,user_id,workspace_id,occurred_at,channel,role,task_id,episode_id,origin_ciphertext,
         origin_key,body_ciphertext,chunk_ix,chunk_of,tokens_est,indexed,body_tokens
       ) VALUES ($1,$2,$3,COALESCE($4,NOW()),$5,$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb),$10,
                 $11::jsonb,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.occurredAt ?? null,
        input.channel,
        input.role ?? null,
        input.taskId ?? null,
        input.episodeId ?? null,
        input.originCiphertext ? JSON.stringify(input.originCiphertext) : null,
        input.originKey ?? null,
        JSON.stringify(input.bodyCiphertext),
        input.chunkIndex ?? 0,
        input.chunkOf ?? null,
        input.tokensEst,
        input.indexed ?? true,
        input.indexed === false ? '' : input.bodyTokens
      ]
    );
    return mapMemorySource(result.rows[0]!);
  }

  /**
   * Reaches verbatim rows by where they came from. Compaction takes old sources out of the lexical
   * index but never deletes them, so this is the path that still finds them.
   */
  async listMemorySourcesByOrigin(
    workspaceId: string,
    originKey: string,
    limit = 50
  ): Promise<MemorySourceRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.source WHERE workspace_id=$1 AND origin_key=$2
       ORDER BY occurred_at DESC, id LIMIT $3`,
      [workspaceId, originKey, limit]
    );
    return result.rows.map(mapMemorySource);
  }

  async createMemoryItem(input: CreateMemoryItemInput): Promise<MemoryItemRecord> {
    return this.#insertMemoryItem(this.database, input);
  }

  async #insertMemoryItem(
    database: Database,
    input: CreateMemoryItemInput
  ): Promise<MemoryItemRecord> {
    const result = await database.query(
      `INSERT INTO mem.item(
         id,user_id,workspace_id,kind,status,trust,document_ciphertext,title_tokens,tag_tokens,
         alias_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,observed_at,valid_from,valid_to,
         subject_key,predicate,object_key,episode_id,task_id,trigger_key,last_verified,pin,salience,
         tokens_est,indexed
       ) VALUES (
         $1,$2,$3,$4::mem.kind,COALESCE($5::mem.status,'active'),$6::mem.trust,$7::jsonb,$8,$9,
         $28,$10,$11::text[],$12::text[],$13,COALESCE($14,NOW()),COALESCE($15,NOW()),$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27
       ) RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.kind,
        input.status ?? null,
        input.trust,
        JSON.stringify(input.documentCiphertext),
        input.index.titleTokens,
        input.index.tagTokens,
        input.index.bodyTokens,
        input.index.tagsHashed,
        input.index.trigrams,
        input.index.dedupeKey,
        input.observedAt ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.index.subjectKey,
        input.predicate ?? null,
        input.index.objectKey,
        input.episodeId ?? null,
        input.taskId ?? null,
        input.triggerKey ?? null,
        input.lastVerified ?? null,
        input.pin ?? false,
        input.salience ?? 0,
        input.index.tokensEst,
        input.index.indexed,
        input.index.aliasTokens
      ]
    );
    return mapMemoryItem(result.rows[0]!);
  }

  /**
   * Mints a fact and applies deterministic supersession: a second current value for a functional
   * predicate retires the first one, bitemporally and with a `supersedes` link, rather than being
   * deleted. That keeps "what did I use before?" answerable and keeps the audit trail behind every
   * brief line intact - and it costs no model call at all.
   */
  async recordMemoryFact(
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    return this.database.transaction(async (transaction) =>
      this.#recordMemoryFact(transaction, input)
    );
  }

  async #recordMemoryFact(
    transaction: Database,
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    const definition = memoryPredicate(input.predicate);
    if (!definition)
      throw new AthanorError(
        'memory_predicate_unknown',
        `Unknown memory predicate "${input.predicate}"`
      );
    if (!input.index.subjectKey)
      throw new AthanorError('memory_fact_subject_missing', 'A fact needs a subject');

    await transaction.query(
      `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
             description=EXCLUDED.description`,
      [definition.name, definition.cardinality, definition.isTemporal, definition.description]
    );
    const supersededIds: string[] = [];
    if (definition.cardinality === 'one') {
      const retired = await transaction.query<{ id: string }>(
        `UPDATE mem.item SET status='superseded', valid_to=COALESCE($4,NOW()), retired_at=NOW(),
                             updated_at=NOW()
         WHERE workspace_id=$1 AND kind='fact' AND status='active' AND valid_to IS NULL
           AND subject_key=$2 AND predicate=$3
         RETURNING id`,
        [input.workspaceId, input.index.subjectKey, input.predicate, input.validFrom ?? null]
      );
      supersededIds.push(...retired.rows.map((row) => row.id));
    }
    const item = await this.#insertMemoryItem(transaction, { ...input, kind: 'fact' });
    for (const supersededId of supersededIds)
      await transaction.query(
        `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supersedes')
         ON CONFLICT DO NOTHING`,
        [item.id, supersededId]
      );
    return { item, supersededIds };
  }

  async getMemoryItem(workspaceId: string, id: string): Promise<MemoryItemRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM mem.item WHERE id=$2 AND workspace_id=$1',
      [workspaceId, id]
    );
    return result.rows[0] ? mapMemoryItem(result.rows[0]) : null;
  }

  async listMemoryItems(
    workspaceId: string,
    filter: { kind?: MemoryKind; status?: MemoryStatus; limit?: number } = {}
  ): Promise<MemoryItemRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.item
       WHERE workspace_id=$1
         AND ($2::text IS NULL OR kind::text=$2)
         AND ($3::text IS NULL OR status::text=$3)
       ORDER BY observed_at DESC, id
       LIMIT $4`,
      [workspaceId, filter.kind ?? null, filter.status ?? null, filter.limit ?? 200]
    );
    return result.rows.map(mapMemoryItem);
  }

  async linkMemoryItems(input: {
    srcId: string;
    dstId: string;
    rel: MemoryLinkRelation;
    weight?: number;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO mem.link(src_id,dst_id,rel,weight) VALUES ($1,$2,$3,$4)
       ON CONFLICT (src_id,dst_id,rel) DO UPDATE SET weight=EXCLUDED.weight`,
      [input.srcId, input.dstId, input.rel, input.weight ?? 1]
    );
  }

  async listMemoryLinks(itemId: string): Promise<MemoryLinkRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.link WHERE src_id=$1 OR dst_id=$1 ORDER BY rel, src_id, dst_id`,
      [itemId]
    );
    return result.rows.map((row) => ({
      srcId: String(row.src_id),
      dstId: String(row.dst_id),
      rel: String(row.rel) as MemoryLinkRelation,
      weight: Number(row.weight),
      createdAt: iso(row.created_at)
    }));
  }

  /** Provenance: every curated item cites the verbatim rows it was extracted from. */
  async attachMemoryEvidence(
    itemId: string,
    sources: readonly { sourceId: string; span?: [number, number] | null }[]
  ): Promise<number> {
    let written = 0;
    for (const source of sources) {
      const result = await this.database.query(
        `INSERT INTO mem.evidence(item_id,source_id,span)
         VALUES ($1,$2,CASE WHEN $3::int IS NULL THEN NULL ELSE int4range($3::int,$4::int) END)
         ON CONFLICT (item_id,source_id) DO UPDATE SET span=EXCLUDED.span`,
        [itemId, source.sourceId, source.span?.[0] ?? null, source.span?.[1] ?? null]
      );
      written += result.rowCount;
    }
    return written;
  }

  async listMemoryEvidence(
    itemId: string
  ): Promise<{ sourceId: string; span: string | null; occurredAt: string }[]> {
    const result = await this.database.query(
      `SELECT e.source_id, e.span::text AS span, s.occurred_at
       FROM mem.evidence e JOIN mem.source s ON s.id=e.source_id
       WHERE e.item_id=$1 ORDER BY s.occurred_at, e.source_id`,
      [itemId]
    );
    return result.rows.map((row) => ({
      sourceId: String(row.source_id),
      span: optionalText(row.span),
      occurredAt: iso(row.occurred_at)
    }));
  }

  /**
   * Below-threshold observations wait here instead of entering mem.item. Requiring two independent
   * episodes at least a day apart is the single most effective anti-bloat rule in the design:
   * minting a fact per message pair is what makes a store unusable after a year.
   */
  async observeMemoryFactCandidate(input: {
    workspaceId: string;
    subjectKey: string;
    predicate: string;
    objectKey: string;
    episodeId: string;
    observedAt?: Date | string;
    draftCiphertext?: EncryptedEnvelope | null;
  }): Promise<MemoryFactCandidateRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.fact_candidate(
         workspace_id,subject_key,predicate,object_key,n_episodes,first_seen,last_seen,
         episode_ids,draft_ciphertext
       ) VALUES ($1,$2,$3,$4,1,COALESCE($6,NOW()),COALESCE($6,NOW()),ARRAY[$5::uuid],$7::jsonb)
       ON CONFLICT (workspace_id,subject_key,predicate,object_key) DO UPDATE SET
         n_episodes = mem.fact_candidate.n_episodes
           + CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids) THEN 0 ELSE 1 END,
         episode_ids = CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids)
           THEN mem.fact_candidate.episode_ids
           ELSE (mem.fact_candidate.episode_ids || ARRAY[$5::uuid])[1:32] END,
         first_seen = LEAST(mem.fact_candidate.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(mem.fact_candidate.last_seen, EXCLUDED.last_seen),
         draft_ciphertext = COALESCE(EXCLUDED.draft_ciphertext, mem.fact_candidate.draft_ciphertext)
       RETURNING *`,
      [
        input.workspaceId,
        input.subjectKey,
        input.predicate,
        input.objectKey,
        input.episodeId,
        input.observedAt ?? null,
        input.draftCiphertext ? JSON.stringify(input.draftCiphertext) : null
      ]
    );
    return mapMemoryFactCandidate(result.rows[0]!);
  }

  async listPromotableMemoryFactCandidates(
    workspaceId: string,
    options: { minEpisodes?: number; minGapHours?: number; limit?: number } = {}
  ): Promise<MemoryFactCandidateRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.fact_candidate
       WHERE workspace_id=$1 AND n_episodes >= $2
         AND last_seen - first_seen >= make_interval(hours => $3::int)
       ORDER BY n_episodes DESC, last_seen DESC, subject_key, predicate, object_key
       LIMIT $4`,
      [
        workspaceId,
        options.minEpisodes ?? 2,
        Math.trunc(options.minGapHours ?? 24),
        options.limit ?? 50
      ]
    );
    return result.rows.map(mapMemoryFactCandidate);
  }

  async deleteMemoryFactCandidate(
    workspaceId: string,
    subjectKey: string,
    predicate: string,
    objectKey: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
      [workspaceId, subjectKey, predicate, objectKey]
    );
    return result.rowCount === 1;
  }

  /**
   * The other half of the observation gate: candidates that have now cleared it become facts and
   * stop being candidates. Only the key holder can seal a document or build a blind index, so it
   * supplies both through `prepare`; everything that has to happen together - supersession, the
   * `derived_from` links back to the episodes that vouched for the fact, and the removal of the
   * candidate row - happens in one transaction per candidate, so a crash cannot leave a promoted
   * fact whose candidate would be promoted again on the next pass.
   *
   * `prepare` returning null leaves the candidate exactly where it is. That is the right answer
   * when the caller cannot open the draft, and it is why nothing here is ever destructive on its
   * own: a candidate only disappears once it has become something.
   */
  async promoteMemoryFactCandidates(
    workspaceId: string,
    prepare: (
      candidate: MemoryFactCandidateRecord
    ) => Promise<PreparedMemoryFact | null> | PreparedMemoryFact | null,
    options: { minEpisodes?: number; minGapHours?: number; limit?: number } = {}
  ): Promise<MemoryFactPromotion[]> {
    const candidates = await this.listPromotableMemoryFactCandidates(workspaceId, options);
    const promoted: MemoryFactPromotion[] = [];
    for (const candidate of candidates) {
      // A predicate that has left the vetted in-repo registry can never become a fact, so its
      // candidates are not held for a review that will never come.
      if (!memoryPredicate(candidate.predicate)) {
        await this.deleteMemoryFactCandidate(
          workspaceId,
          candidate.subjectKey,
          candidate.predicate,
          candidate.objectKey
        );
        continue;
      }
      const prepared = await prepare(candidate);
      if (!prepared) continue;
      // The fact that gets minted has to be the one that was actually observed twice; the keyed
      // subject and object are the only handles the store has on that identity.
      if (
        prepared.index.subjectKey !== candidate.subjectKey ||
        prepared.index.objectKey !== candidate.objectKey
      )
        throw new AthanorError(
          'memory_promotion_mismatch',
          'A promoted fact must carry the subject and object of the candidate it came from'
        );
      const result = await this.database.transaction(async (transaction) => {
        const recorded = await this.#recordMemoryFact(transaction, {
          userId: prepared.userId,
          workspaceId,
          trust: prepared.trust ?? 'derived',
          documentCiphertext: prepared.documentCiphertext,
          index: prepared.index,
          predicate: candidate.predicate,
          observedAt: prepared.observedAt ?? candidate.lastSeen,
          validFrom: prepared.validFrom ?? candidate.lastSeen,
          taskId: prepared.taskId ?? null,
          episodeId: candidate.episodeIds.at(-1) ?? null
        });
        for (const episodeId of candidate.episodeIds)
          await transaction.query(
            `INSERT INTO mem.link(src_id,dst_id,rel)
             SELECT $1,$2,'derived_from' FROM mem.item WHERE id=$2 AND workspace_id=$3
             ON CONFLICT DO NOTHING`,
            [recorded.item.id, episodeId, workspaceId]
          );
        await transaction.query(
          `DELETE FROM mem.fact_candidate
           WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
          [workspaceId, candidate.subjectKey, candidate.predicate, candidate.objectKey]
        );
        return recorded;
      });
      promoted.push({ candidate, item: result.item, supersededIds: result.supersededIds });
    }
    return promoted;
  }

  /**
   * Two things the owner stated that genuinely conflict are never auto-resolved: both go to
   * `disputed`, neither is retrieved by default, and the pair surfaces in the review queue.
   */
  async markMemoryFactsDisputed(workspaceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.database.query(
      `UPDATE mem.item SET status='disputed', updated_at=NOW()
       WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND status='active'`,
      [workspaceId, [...ids]]
    );
    for (const [index, left] of ids.entries())
      for (const right of ids.slice(index + 1))
        await this.database.query(
          `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'contradicts')
           ON CONFLICT DO NOTHING`,
          [left, right]
        );
    return result.rowCount;
  }

  async retractMemoryItem(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.item SET status='retracted', retired_at=NOW(), valid_to=COALESCE(valid_to,NOW()),
                           neg_count=neg_count+1, updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND status <> 'retracted'`,
      [workspaceId, id]
    );
    return result.rowCount === 1;
  }

  /** Records the outcome of injecting an item so salience and procedure health stay honest. */
  async recordMemoryUse(input: {
    workspaceId: string;
    itemIds: readonly string[];
    taskId?: string | null;
    cited?: boolean;
    outcome?: MemoryUseOutcome;
    usedAt?: Date | string;
  }): Promise<number> {
    if (input.itemIds.length === 0) return 0;
    const workspaceId = input.workspaceId;
    const itemIds = [...input.itemIds];
    const usedAt = input.usedAt ?? null;
    const cited = input.cited ?? false;
    const outcome = input.outcome ?? 'unknown';
    await this.database.query(
      `INSERT INTO mem.item_use(id,item_id,workspace_id,task_id,used_at,cited,outcome)
       SELECT gen_random_uuid(), i.id, $1::uuid, $3::uuid, COALESCE($4::timestamptz,NOW()),
              $5::boolean, $6::text
       FROM mem.item i WHERE i.id = ANY($2::uuid[]) AND i.workspace_id=$1::uuid`,
      [workspaceId, itemIds, input.taskId ?? null, usedAt, cited, outcome]
    );
    const updated = await this.database.query(
      `UPDATE mem.item SET
         use_count=use_count+1,
         last_used_at=COALESCE($3::timestamptz,NOW()),
         cited_count=cited_count + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
         ok_count=ok_count + CASE WHEN $5::text='ok' THEN 1 ELSE 0 END,
         fail_count=fail_count + CASE WHEN $5::text='fail' THEN 1 ELSE 0 END,
         updated_at=NOW()
       WHERE id = ANY($2::uuid[]) AND workspace_id=$1::uuid`,
      [workspaceId, itemIds, usedAt, cited, outcome]
    );
    return updated.rowCount;
  }

  async verifyMemoryProcedure(
    workspaceId: string,
    id: string,
    verifiedAt?: Date | string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.item SET last_verified=COALESCE($3,NOW()), updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND kind='procedure'`,
      [workspaceId, id, verifiedAt ?? null]
    );
    return result.rowCount === 1;
  }

  /**
   * The review queue. A procedure that stops being injected is never deleted for the owner: it is
   * listed here as "verify or delete", because silently dropping it destroys the audit trail.
   */
  async listStaleMemoryProcedures(
    workspaceId: string,
    options: { now?: Date | string; staleDays?: number; minSuccessRate?: number } = {}
  ): Promise<MemoryItemRecord[]> {
    const result = await this.database.query(
      `SELECT i.* FROM mem.item i
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.outcome='ok')::float8 AS ok_recent,
                count(*) FILTER (WHERE r.outcome<>'unknown')::float8 AS graded_recent
         FROM (SELECT u.outcome FROM mem.item_use u WHERE u.item_id=i.id
               ORDER BY u.used_at DESC, u.id LIMIT 5) r
       ) health ON TRUE
       WHERE i.workspace_id=$1 AND i.kind='procedure' AND i.status='active'
         AND (COALESCE(i.last_verified, i.observed_at)
                <= COALESCE($2::timestamptz, NOW()) - make_interval(days => $3::int)
              OR (health.graded_recent > 0
                  AND health.ok_recent / health.graded_recent < $4::float8))
       ORDER BY i.observed_at, i.id`,
      [
        workspaceId,
        options.now ?? null,
        Math.trunc(options.staleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
        options.minSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE
      ]
    );
    return result.rows.map(mapMemoryItem);
  }

  /**
   * The fused ranking query. Returns an already-budgeted set in deterministic (kind, id) order, so
   * two calls anchored at the same `now` produce byte-identical packs.
   */
  async recallMemoryCandidates(input: RecallMemoryInput): Promise<MemoryCandidateRecord[]> {
    // The tsquery is assembled inside SQL from this array. Tokens come from the blind index and
    // are alphabetic by construction; anything else could only be a caller bug, and could not
    // match a stored token anyway, so it is dropped rather than allowed to reach the parser.
    const result = await this.database.query(MEMORY_RECALL_SQL, [
      input.workspaceId,
      input.plan.lexemes.filter(isMemoryToken),
      [...input.plan.trigrams],
      [...input.plan.entityKeys],
      [...input.plan.tagTokens],
      input.now ?? new Date(),
      input.plan.temporalIntent,
      // Pinned false rather than removed. No writer on this computer produces an `inferred` row and
      // no caller can ask for one any more, so the clause this feeds is now a guard against a
      // legacy row rather than a switch - and leaving the parameter in place keeps the other
      // twenty-two positions where the query already expects them.
      false,
      input.includeSuperseded ?? false,
      Math.trunc(input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS),
      JSON.stringify(input.quotas ?? MEMORY_PACK_QUOTAS),
      input.asOf ?? null,
      input.kinds ? [...input.kinds] : null,
      input.scope ?? 'default',
      Math.trunc(input.maxItems ?? 60),
      Math.trunc(input.procedureStaleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
      input.procedureMinSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
      input.fuzzyThreshold ?? MEMORY_FUZZY_SIMILARITY_THRESHOLD,
      input.order === 'relevance',
      MEMORY_PACK_DEFAULT_QUOTA.share,
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.cap),
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.perSubject),
      // Ids reach the store from a model-authored tool call by way of the pack, so anything that is
      // not a UUID is dropped here rather than reaching PostgreSQL as a cast error.
      [...new Set((input.excludeIds ?? []).filter((id) => UUID_PATTERN.test(id)))]
    ]);
    return result.rows.map(mapMemoryCandidate);
  }

  /**
   * BM25 over the verbatim layer alone: past conversations, terminal output and tool results, in
   * the same keyed index the curated overlay uses. Bodies come back sealed; only the key holder
   * ever sees what matched.
   */
  async searchMemorySources(input: SearchMemorySourcesInput): Promise<MemorySourceHit[]> {
    const lexemes = input.plan.lexemes.filter(isMemoryToken);
    if (lexemes.length === 0) return [];
    const limit = Math.trunc(input.limit ?? 20);
    const result = await this.database.query(MEMORY_SOURCE_SEARCH_SQL, [
      input.workspaceId,
      lexemes,
      input.taskId ?? null,
      input.since ?? null,
      input.until ?? null,
      limit,
      // Inside a single conversation there is no second thread to make room for, so the cap would
      // only throw away rows the caller asked for by name.
      Math.max(
        1,
        Math.trunc(input.perTask ?? (input.taskId ? limit : MEMORY_SOURCE_SEARCH_PER_TASK))
      )
    ]);
    return result.rows.map((row) => ({ ...mapMemorySource(row), score: Number(row.score) }));
  }

  /**
   * How far back the verbatim layer actually reaches.
   *
   * A search that returns nothing has two completely different meanings - the owner never discussed
   * it, or it happened before this workspace started recording - and an agent that cannot tell them
   * apart will state the first one as fact. Capture began when the memory schema did, so on a
   * computer that has been in use longer than that there is a real horizon, and it is a number
   * rather than a guess.
   */
  async memorySourceCoverage(workspaceId: string): Promise<{
    turns: number;
    conversations: number;
    earliest: string | null;
  }> {
    const result = await this.database.query<{
      turns: string;
      conversations: string;
      earliest: unknown;
    }>(
      `SELECT count(*) AS turns, count(DISTINCT task_id) AS conversations,
              min(occurred_at) AS earliest
       FROM mem.source WHERE workspace_id = $1`,
      [workspaceId]
    );
    const row = result.rows[0];
    return {
      turns: Number(row?.turns ?? 0),
      conversations: Number(row?.conversations ?? 0),
      earliest: row?.earliest ? iso(row.earliest) : null
    };
  }

  /**
   * The verbatim rows around one hit, in the order they happened. `before` and `after` are counts
   * of rows, not bytes: a caller that wants more context asks for more rows.
   */
  async listMemorySourceWindow(
    workspaceId: string,
    sourceId: string,
    window: { before?: number; after?: number } = {}
  ): Promise<MemorySourceRecord[]> {
    const result = await this.database.query(MEMORY_SOURCE_WINDOW_SQL, [
      workspaceId,
      sourceId,
      Math.max(0, Math.trunc(window.before ?? 2)),
      Math.max(0, Math.trunc(window.after ?? 2))
    ]);
    return result.rows.map(mapMemorySource);
  }

  /**
   * Dereferences the ids a memory pack printed. Ids reach the agent as opaque text, so anything
   * that is not a UUID is discarded here rather than reaching PostgreSQL as a cast error - a model
   * quoting an id back imprecisely must get an empty result, never a failed turn.
   */
  async getMemoryItems(workspaceId: string, ids: readonly string[]): Promise<MemoryItemRecord[]> {
    const wanted = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
    if (wanted.length === 0) return [];
    const result = await this.database.query(
      `SELECT * FROM mem.item WHERE workspace_id=$1 AND id = ANY($2::uuid[]) ORDER BY kind, id`,
      [workspaceId, wanted]
    );
    return result.rows.map(mapMemoryItem);
  }

  async getMemoryPack(taskId: string): Promise<MemoryPackRecord | null> {
    const result = await this.database.query('SELECT * FROM mem.pack WHERE task_id=$1', [taskId]);
    return result.rows[0] ? mapMemoryPack(result.rows[0]) : null;
  }

  /**
   * First writer wins. A worker that restarts mid-task re-reads the bytes it already emitted
   * instead of re-ranking against a newer clock, which is what keeps the cached prefix alive.
   */
  async saveMemoryPack(input: {
    taskId: string;
    workspaceId: string;
    bodyCiphertext: EncryptedEnvelope;
    sha256: string;
    itemIds: readonly string[];
    tokensEst: number;
    briefVersion?: string | null;
  }): Promise<MemoryPackRecord> {
    const inserted = await this.database.query(
      `INSERT INTO mem.pack(
         task_id,workspace_id,brief_version,body_ciphertext,sha256,item_ids,tokens_est
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7)
       ON CONFLICT (task_id) DO NOTHING RETURNING *`,
      [
        input.taskId,
        input.workspaceId,
        input.briefVersion ?? null,
        JSON.stringify(input.bodyCiphertext),
        input.sha256,
        [...input.itemIds],
        input.tokensEst
      ]
    );
    if (inserted.rows[0]) return mapMemoryPack(inserted.rows[0]);
    const existing = await this.getMemoryPack(input.taskId);
    if (!existing) throw new AthanorError('memory_pack_missing', 'Memory pack could not be stored');
    return existing;
  }

  async deleteMemoryPack(taskId: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM mem.pack WHERE task_id=$1', [taskId]);
    return result.rowCount === 1;
  }

  /**
   * The nightly pass. Salience is recomputed from raw counters rather than stored decayed, old
   * material is demoted rather than deleted, and every table that could grow without bound is
   * trimmed. Nothing here calls a model: the expensive residue is the caller's business.
   */
  async consolidateMemory(
    workspaceId: string,
    options: {
      now?: Date | string;
      archiveAfterDays?: number;
      useRetentionDays?: number;
      candidateRetentionDays?: number;
      statsRebuildDays?: number;
    } = {}
  ): Promise<MemoryConsolidationReport> {
    const now = options.now ?? null;
    const archiveAfterDays = Math.trunc(options.archiveAfterDays ?? 730);
    const useRetentionDays = Math.trunc(options.useRetentionDays ?? 180);
    const candidateRetentionDays = Math.trunc(options.candidateRetentionDays ?? 180);
    const statsRebuildDays = Math.trunc(options.statsRebuildDays ?? 30);

    // Reliability and usage dominate retention decisions; "did this match the last query" is
    // deliberately not an input, because it is exactly the signal that over-weights recency.
    const salience = await this.database.query(
      `WITH usage AS (
         SELECT i.id, i.pin,
                COALESCE(NULLIF(i.neg_count,0)::float8 / NULLIF(i.use_count,0), 0) AS neg_rate,
                count(u.id) FILTER (
                  WHERE u.used_at > COALESCE($2::timestamptz,NOW()) - INTERVAL '90 days'
                )::float8 AS uses,
                count(u.id) FILTER (
                  WHERE u.cited
                    AND u.used_at > COALESCE($2::timestamptz,NOW()) - INTERVAL '90 days'
                )::float8 AS cites
         FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
         WHERE i.workspace_id=$1
         GROUP BY i.id, i.pin, i.neg_count, i.use_count
       ),
       moments AS (
         SELECT AVG(uses) AS mu, COALESCE(STDDEV_POP(uses),0) AS su,
                AVG(cites) AS mc, COALESCE(STDDEV_POP(cites),0) AS sc
         FROM usage
       )
       UPDATE mem.item SET salience =
           0.50 * COALESCE((g.uses - m.mu) / NULLIF(m.su,0), 0)
         + 0.20 * COALESCE((g.cites - m.mc) / NULLIF(m.sc,0), 0)
         - 0.30 * g.neg_rate
         + CASE WHEN g.pin THEN 1.0 ELSE 0.0 END,
         updated_at=NOW()
       FROM usage g, moments m
       WHERE mem.item.id = g.id`,
      [workspaceId, now]
    );
    // An episode lends part of its salience to what was extracted from it, so a fact from a
    // heavily used episode outranks an equally unused fact from a forgotten one.
    await this.database.query(
      `UPDATE mem.item SET salience = mem.item.salience + 0.20 * GREATEST(e.salience, 0)
       FROM mem.item e
       WHERE mem.item.workspace_id=$1 AND mem.item.episode_id = e.id AND e.kind='episode'`,
      [workspaceId]
    );

    // Compaction never deletes verbatim text: items are demoted to 'archived' and sources merely
    // leave the lexical index. Anything pinned or cited by a live item is exempt.
    const archived = await this.database.query(
      `UPDATE mem.item SET status='archived', updated_at=NOW()
       WHERE workspace_id=$1 AND status='active' AND NOT pin
         AND observed_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (SELECT 1 FROM mem.link l WHERE l.dst_id=mem.item.id)`,
      [workspaceId, now, archiveAfterDays]
    );
    const unindexed = await this.database.query(
      `UPDATE mem.source SET indexed=FALSE, body_tokens=''
       WHERE workspace_id=$1 AND indexed
         AND occurred_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (SELECT 1 FROM mem.evidence e WHERE e.source_id=mem.source.id)`,
      [workspaceId, now, archiveAfterDays]
    );

    const uses = await this.database.query(
      `DELETE FROM mem.item_use
       WHERE workspace_id=$1
         AND used_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, useRetentionDays]
    );
    const candidates = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1
         AND last_seen < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, candidateRetentionDays]
    );
    const packs = await this.database.query(
      `DELETE FROM mem.pack WHERE workspace_id=$1 AND task_id IN (
         SELECT t.id FROM tasks t
         WHERE t.id=mem.pack.task_id AND t.status IN ('completed','failed','cancelled')
       )`,
      [workspaceId]
    );

    // The AFTER INSERT trigger keeps document frequency fresh but never subtracts, so archived
    // items and unindexed sources leave their lexemes counted forever and IDF drifts low. The full
    // rebuild is too expensive to run nightly, so this pass is where its own cadence is kept -
    // there is no other timer in the product that knows a workspace has memory in it.
    const drifted = await this.database.query<{ stale: boolean }>(
      `SELECT refreshed_at <= COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
                AS stale
       FROM mem.corpus_stats WHERE workspace_id=$1`,
      [workspaceId, now, statsRebuildDays]
    );
    const corpusStatsRebuilt = drifted.rows[0]?.stale === true;
    if (corpusStatsRebuilt) await this.rebuildMemoryCorpusStats(workspaceId);

    const stale = await this.listStaleMemoryProcedures(
      workspaceId,
      options.now ? { now: options.now } : {}
    );
    return {
      salienceUpdated: salience.rowCount,
      itemsArchived: archived.rowCount,
      sourcesUnindexed: unindexed.rowCount,
      usesPruned: uses.rowCount,
      candidatesPruned: candidates.rowCount,
      packsPruned: packs.rowCount,
      staleProcedureIds: stale.map((item) => item.id),
      corpusStatsRebuilt
    };
  }

  /**
   * Monthly full rebuild of the corpus statistics. Doing this nightly would be a sequential scan
   * plus a hash aggregate over every lexeme; the AFTER INSERT trigger keeps df fresh in between.
   *
   * Single-occurrence lexemes are kept. Discarding them saved a fraction of a table that the
   * insert trigger repopulates anyway - the trigger writes df=1 for every lexeme of every row it
   * indexes - and it cost the one distinction retrieval most needs: a term in exactly one document
   * is the most discriminative term there is, and a term in no document cannot match at all. With
   * the df=1 rows dropped those two cases were indistinguishable, so the query planner had to treat
   * the rarest terms as if they were unknown.
   */
  async rebuildMemoryCorpusStats(workspaceId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query('DELETE FROM mem.lexeme_df WHERE workspace_id=$1', [workspaceId]);
      await transaction.query(
        `INSERT INTO mem.lexeme_df(workspace_id, lexeme, df)
         SELECT $1, u.lexeme, count(*) FROM (
           SELECT tsv FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d CROSS JOIN LATERAL unnest(d.tsv) u
         GROUP BY u.lexeme`,
        [workspaceId]
      );
      await transaction.query(
        `INSERT INTO mem.corpus_stats(workspace_id,n_docs,sum_len,refreshed_at)
         SELECT $1, count(*), COALESCE(SUM(tsv_len),0), NOW() FROM (
           SELECT tsv_len FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv_len FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d
         ON CONFLICT (workspace_id) DO UPDATE
           SET n_docs=EXCLUDED.n_docs, sum_len=EXCLUDED.sum_len, refreshed_at=EXCLUDED.refreshed_at`,
        [workspaceId]
      );
    });
  }

  async listWorkspaceSkills(userId: string, workspaceId: string): Promise<WorkspaceSkillRecord[]> {
    const result = await this.database.query(
      `SELECT s.* FROM workspace_skills s
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.workspace_id=$2 AND w.user_id=$1
       ORDER BY s.updated_at DESC,s.id`,
      [userId, workspaceId]
    );
    return result.rows.map(mapWorkspaceSkill);
  }

  async getWorkspaceSkill(
    userId: string,
    workspaceId: string,
    id: string
  ): Promise<WorkspaceSkillRecord | null> {
    const result = await this.database.query(
      `SELECT s.* FROM workspace_skills s
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$3 AND s.workspace_id=$2 AND w.user_id=$1`,
      [userId, workspaceId, id]
    );
    return result.rows[0] ? mapWorkspaceSkill(result.rows[0]) : null;
  }

  async upsertWorkspaceSkill(input: {
    userId: string;
    workspaceId: string;
    nameHash: string;
    documentCiphertext: EncryptedEnvelope;
  }): Promise<WorkspaceSkillRecord> {
    const result = await this.database.query(
      `INSERT INTO workspace_skills(
        id,user_id,workspace_id,name_hash,document_ciphertext
       ) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(workspace_id,name_hash) DO UPDATE SET
         document_ciphertext=EXCLUDED.document_ciphertext,
         version=workspace_skills.version+1,
         enabled=TRUE,
         status='active',
         updated_at=NOW()
       RETURNING *`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId,
        input.nameHash,
        JSON.stringify(input.documentCiphertext)
      ]
    );
    return mapWorkspaceSkill(result.rows[0]!);
  }

  async markWorkspaceSkillUsed(userId: string, workspaceId: string, id: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_skills SET
         use_count=use_count+1,last_used_at=NOW(),status='active',updated_at=NOW()
       WHERE id=$3 AND workspace_id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$1
       )`,
      [userId, workspaceId, id]
    );
  }

  /**
   * Ages a workspace skill out of the index once its trigger has stopped coming up.
   *
   * The clock is `last_used_at` and nothing else. It used to be `COALESCE(last_used_at,updated_at)`
   * while the same statement wrote `updated_at`, so for a skill that had never been used the anchor
   * was the column the transition overwrote: on day 31 it went stale and reset its own clock, on
   * day 61 it went stale again, and it could never reach 'archived' - it simply blinked out of the
   * index and back every thirty days for the life of the workspace.
   *
   * A skill that has never been used is now left alone rather than given a different anchor. Every
   * workspace skill was shown to this owner in full and approved by them, and demoting one because
   * its occasion has not arisen yet is the wrong answer for a single-owner computer - they already
   * have pinning, enabling and deletion as direct controls. The guard also makes this statement a
   * true no-op in the steady state, so the per-turn call stops rewriting the whole table.
   */
  async curateWorkspaceSkills(workspaceId: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_skills SET
         status=CASE
           WHEN last_used_at < NOW()-INTERVAL '90 days' THEN 'archived'
           WHEN last_used_at < NOW()-INTERVAL '30 days' THEN 'stale'
           ELSE 'active'
         END,
         updated_at=NOW()
       WHERE workspace_id=$1 AND pinned=FALSE AND last_used_at IS NOT NULL
         AND status IS DISTINCT FROM CASE
           WHEN last_used_at < NOW()-INTERVAL '90 days' THEN 'archived'
           WHEN last_used_at < NOW()-INTERVAL '30 days' THEN 'stale'
           ELSE 'active'
         END`,
      [workspaceId]
    );
  }

  async setWorkspaceSkillState(input: {
    userId: string;
    workspaceId: string;
    id: string;
    status?: WorkspaceSkillRecord['status'];
    pinned?: boolean;
  }): Promise<WorkspaceSkillRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_skills SET
         status=COALESCE($4,status),
         pinned=COALESCE($5,pinned),
         updated_at=NOW()
       WHERE id=$1 AND workspace_id=$3 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$2
       ) RETURNING *`,
      [input.id, input.userId, input.workspaceId, input.status ?? null, input.pinned ?? null]
    );
    return result.rows[0] ? mapWorkspaceSkill(result.rows[0]) : null;
  }

  async deleteWorkspaceSkill(userId: string, workspaceId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM workspace_skills WHERE id=$3 AND workspace_id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=workspace_skills.workspace_id AND w.user_id=$1
       )`,
      [userId, workspaceId, id]
    );
    return result.rowCount === 1;
  }

  async createTaskSchedule(input: {
    userId: string;
    workspaceId: string;
    titleCiphertext: EncryptedEnvelope;
    promptCiphertext: EncryptedEnvelope;
    modelId: string;
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    spec: TaskScheduleRecord['spec'];
    nextRunAt: Date;
    maxSchedules?: number;
  }): Promise<TaskScheduleRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      if (input.maxSchedules !== undefined) {
        const count = await tx.query(
          'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
          [input.userId]
        );
        if (Number(count.rows[0]?.count ?? 0) >= input.maxSchedules) {
          throw new Error('schedule_limit');
        }
      }
      const result = await tx.query(
        `INSERT INTO task_schedules(
          id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,model_id,privacy_route,
          max_compute_credits,spec,next_run_at,max_spend_usd
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          JSON.stringify(input.titleCiphertext),
          JSON.stringify(input.promptCiphertext),
          input.modelId,
          input.privacyRoute,
          input.maxComputeCredits,
          JSON.stringify(input.spec),
          input.nextRunAt.toISOString(),
          input.maxSpendUsd ?? null
        ]
      );
      return mapTaskSchedule(result.rows[0]!);
    });
  }

  async countTaskSchedules(userId: string): Promise<number> {
    const result = await this.database.query(
      'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listTaskSchedules(userId: string): Promise<TaskScheduleRecord[]> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE w.user_id=$1 ORDER BY s.created_at DESC`,
      [userId]
    );
    return result.rows.map(mapTaskSchedule);
  }

  async getTaskSchedule(userId: string, id: string): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$2 AND w.user_id=$1`,
      [userId, id]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async setTaskScheduleEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    nextRunAt: Date | null
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET enabled=$3,
       next_run_at=CASE WHEN $3 THEN $4 ELSE next_run_at END,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [userId, id, enabled, nextRunAt?.toISOString() ?? null]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async updateTaskSchedule(
    userId: string,
    id: string,
    input: {
      titleCiphertext: EncryptedEnvelope;
      promptCiphertext: EncryptedEnvelope;
      spec: TaskScheduleRecord['spec'];
      maxComputeCredits: number;
      maxSpendUsd?: number | null;
      nextRunAt: Date | null;
    }
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET title_ciphertext=$3::jsonb,prompt_ciphertext=$4::jsonb,
       spec=$5::jsonb,max_compute_credits=$6,next_run_at=$7,max_spend_usd=$8,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [
        userId,
        id,
        JSON.stringify(input.titleCiphertext),
        JSON.stringify(input.promptCiphertext),
        JSON.stringify(input.spec),
        input.maxComputeCredits,
        input.nextRunAt?.toISOString() ?? null,
        input.maxSpendUsd ?? null
      ]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async deleteTaskSchedule(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM task_schedules WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       )`,
      [userId, id]
    );
    return result.rowCount === 1;
  }

  async leaseDueTaskSchedule(
    workerId: string,
    leaseSeconds = 120
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET lease_owner=$1,
       lease_expires_at=NOW()+($2 * INTERVAL '1 second'),updated_at=NOW()
       WHERE id=(
         SELECT id FROM task_schedules
         WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
         ORDER BY next_run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ) RETURNING *`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async deferTaskSchedule(
    scheduleId: string,
    workerId: string,
    errorCode: string,
    delaySeconds = 300
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE task_schedules SET next_run_at=NOW()+($4 * INTERVAL '1 second'),
       last_error_code=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
       WHERE id=$1 AND lease_owner=$2 AND enabled=TRUE`,
      [scheduleId, workerId, errorCode, delaySeconds]
    );
    return result.rowCount === 1;
  }

  async materializeTaskSchedule(input: {
    scheduleId: string;
    workerId: string;
    taskId: string;
    nextRunAt: Date | null;
    resourceClass: string;
    preparingEventCiphertext: EncryptedEnvelope;
    failureEventCiphertext: EncryptedEnvelope;
    forceFailureCode?: string;
  }): Promise<{ task: TaskRecord; outcome: 'queued' | 'failed'; errorCode: string | null } | null> {
    const materialized = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT * FROM task_schedules WHERE id=$1 AND lease_owner=$2
         AND enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW() FOR UPDATE`,
        [input.scheduleId, input.workerId]
      );
      const schedule = locked.rows[0];
      if (!schedule) return null;

      let errorCode = input.forceFailureCode ?? null;
      if (!errorCode) {
        // The unattended path is the one that has to fail closed: nobody is watching a 3am run,
        // so a schedule that would take the account past its ceiling never starts at all. The
        // ceiling is the owner's own spend cap, in the currency the provider bills - there is no
        // allowance to check it against, because there is nobody selling one.
        const decision = await this.spendGuardIn(tx, {
          userId: String(schedule.user_id),
          estimateUsd: numericOrNull(schedule.max_spend_usd) ?? 0,
          includeOpenCommitments: true,
          taskCapUsd: numericOrNull(schedule.max_spend_usd)
        });
        if (decision.outcome === 'deny') errorCode = 'spend_cap_reached';
      }

      const outcome: 'queued' | 'failed' = errorCode ? 'failed' : 'queued';
      const status = errorCode ? 'failed' : 'awaiting_resource';
      const eventKind = errorCode ? 'error' : 'task_created';
      const eventCiphertext = errorCode
        ? input.failureEventCiphertext
        : input.preparingEventCiphertext;
      const taskResult = await tx.query(
        `INSERT INTO tasks(
          id,user_id,workspace_id,title,status,model_id,privacy_route,max_compute_credits,
          prompt_ciphertext,security_mode,completed_at,max_spend_usd
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
           (SELECT security_mode FROM workspaces WHERE id=$3),
           CASE WHEN $5='failed' THEN NOW() ELSE NULL END,$10) RETURNING *`,
        [
          input.taskId,
          schedule.user_id,
          schedule.workspace_id,
          JSON.stringify(json(schedule.title_ciphertext)),
          status,
          schedule.model_id,
          schedule.privacy_route,
          schedule.max_compute_credits,
          JSON.stringify(json(schedule.prompt_ciphertext)),
          numericOrNull(schedule.max_spend_usd)
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         VALUES ($1,$2,1,$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          input.taskId,
          eventKind,
          errorCode ? 'Encrypted schedule error event' : 'Encrypted scheduled task event',
          JSON.stringify(eventCiphertext)
        ]
      );
      if (!errorCode) {
        await tx.query(
          `INSERT INTO usage_entries(
            id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
            idempotency_key
           ) VALUES ($1,$2,$3,$4,'task_compute',$5,$6,'credits',$6,'reserved',$7)`,
          [
            randomUUID(),
            schedule.user_id,
            schedule.workspace_id,
            input.taskId,
            input.resourceClass,
            schedule.max_compute_credits,
            `task:${input.taskId}:reservation`
          ]
        );
      }
      await tx.query(
        `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome,error_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.scheduleId, schedule.next_run_at, input.taskId, outcome, errorCode]
      );
      await tx.query(
        `UPDATE task_schedules SET enabled=$3,next_run_at=$4,last_run_at=$5,last_task_id=$6,
         last_error_code=$7,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2`,
        [
          input.scheduleId,
          input.workerId,
          input.nextRunAt !== null,
          input.nextRunAt?.toISOString() ?? null,
          schedule.next_run_at,
          input.taskId,
          errorCode
        ]
      );
      return { task: mapTask(taskResult.rows[0]!), outcome, errorCode };
    });
    if (materialized) {
      if (materialized.task.status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
      this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    }
    return materialized;
  }

  async failMaterializedTaskSchedule(
    scheduleId: string,
    taskId: string,
    errorCode: string
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE task_schedule_runs SET outcome='failed',error_code=$3
         WHERE schedule_id=$1 AND task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
      await tx.query(
        `UPDATE task_schedules SET last_error_code=$3,updated_at=NOW()
         WHERE id=$1 AND last_task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
    });
  }

  /**
   * One batch of tasks still carrying a plaintext title. The API re-encrypts these while booting,
   * so the batch stays small: startup then costs a bounded index lookup instead of a scan whose
   * length grows with the task history, and any remainder is picked up on the next boot.
   */
  async listLegacyTaskTitles(limit = 500): Promise<TaskRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM tasks WHERE title NOT LIKE '{"v":%' ORDER BY created_at, id LIMIT $1`,
      [limit]
    );
    return result.rows.map(mapTask).filter((task) => task.legacyTitle !== null);
  }

  async setTaskTitleCiphertext(id: string, titleCiphertext: EncryptedEnvelope): Promise<void> {
    await this.database.query('UPDATE tasks SET title=$2,updated_at=NOW() WHERE id=$1', [
      id,
      JSON.stringify(titleCiphertext)
    ]);
  }

  /**
   * Replaces summaries and action names written before they were redacted. Also a boot-path
   * backfill, so it rewrites at most `batchSize * maxBatches` rows per call and reports whether
   * anything is left; the caller decides whether to keep draining or wait for the next boot.
   */
  async scrubLegacyContentSummaries(batchSize = 500, maxBatches = 20): Promise<boolean> {
    const events = await this.rewriteInBatches(
      `UPDATE task_events SET summary='Encrypted legacy event'
       WHERE id IN (
         SELECT id FROM task_events WHERE summary NOT LIKE 'Encrypted % event' LIMIT $1
       )`,
      batchSize,
      maxBatches
    );
    const approvals = await this.rewriteInBatches(
      `UPDATE approvals SET action='legacy_approval'
       WHERE id IN (
         SELECT id FROM approvals
         WHERE action NOT IN ('shell','browser_action','secure_input_handoff','legacy_approval')
         LIMIT $1
       )`,
      batchSize,
      maxBatches
    );
    return events || approvals;
  }

  /** Runs a `LIMIT $1` rewrite until it stops filling batches. True means rows may remain. */
  private async rewriteInBatches(
    sql: string,
    batchSize: number,
    maxBatches: number
  ): Promise<boolean> {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.database.query(sql, [batchSize]);
      if (result.rowCount < batchSize) return false;
    }
    return true;
  }

  async setTaskStatusForUser(userId: string, id: string, status: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET status = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW(),
       -- Resuming answers the spend pause, so the task stops being one the owner has not heard about.
       spend_paused_at = CASE WHEN $3 = 'queued' THEN NULL ELSE spend_paused_at END,
       completed_at = CASE WHEN $3 IN ('completed','failed','cancelled') THEN NOW() ELSE completed_at END
       WHERE id=$1 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=tasks.workspace_id AND w.user_id=$2
       )`,
      [id, userId, status]
    );
    if (result.rowCount === 1 && status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, id);
    return result.rowCount === 1;
  }

  async cancelTaskAndReleaseReservations(userId: string, id: string): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const changed = await tx.query(
        `UPDATE tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,
           completed_at=NOW(),updated_at=NOW()
         WHERE id=$1 AND status NOT IN ('completed','failed','cancelled') AND EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.id=tasks.workspace_id AND w.user_id=$2
         )`,
        [id, userId]
      );
      if (changed.rowCount !== 1) return false;
      await tx.query(
        `UPDATE task_message_queue SET status='cancelled'
         WHERE task_id=$1 AND status='queued'`,
        [id]
      );
      await tx.query(
        `UPDATE approvals SET status='denied',resolved_at=NOW()
         WHERE task_id=$1 AND status='pending'`,
        [id]
      );
      await tx.query(
        `UPDATE usage_entries SET state='released'
         WHERE task_id=$1 AND state='reserved'`,
        [id]
      );
      return true;
    });
  }

  async updateTaskSecurityMode(
    userId: string,
    id: string,
    securityMode: TaskRecord['securityMode']
  ): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks SET security_mode=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, securityMode]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async updateWorkspaceSecurityMode(
    userId: string,
    id: string,
    securityMode: WorkspaceRecord['securityMode']
  ): Promise<WorkspaceRecord | null> {
    const result = await this.database.query(
      `UPDATE workspaces SET security_mode=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, securityMode]
    );
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }

  async leaseNextTask(workerId: string, leaseSeconds = 60): Promise<TaskRecord | null> {
    const result = await this.database.query(
      `UPDATE tasks SET
         lease_owner = $1,
         lease_expires_at = NOW() + ($2 * INTERVAL '1 second'),
         status = CASE WHEN status = 'queued' THEN 'planning' ELSE status END,
         attempt = attempt + 1,
         updated_at = NOW()
       WHERE id = (
         SELECT id FROM tasks
         WHERE status IN ('queued','planning','running')
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async renewTaskLease(taskId: string, workerId: string, leaseSeconds = 60): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE tasks SET lease_expires_at = NOW() + ($3 * INTERVAL '1 second')
       WHERE id = $1 AND lease_owner = $2`,
      [taskId, workerId, leaseSeconds]
    );
    return result.rowCount === 1;
  }

  async updateTask(input: {
    id: string;
    workerId?: string;
    status: string;
    agentStateCiphertext?: EncryptedEnvelope | null;
    actualComputeCredits?: number;
    clearLease?: boolean;
    /**
     * When the box stopped this task at a spending ceiling, or null to clear it. Undefined leaves
     * it alone. This is the only thing that distinguishes a spend pause from a Pause the owner
     * asked for, and it is what decides whether their phone hears about it.
     */
    spendPausedAt?: Date | null;
  }): Promise<void> {
    const params: unknown[] = [
      input.id,
      input.status,
      input.agentStateCiphertext ? JSON.stringify(input.agentStateCiphertext) : null,
      input.actualComputeCredits ?? null,
      input.clearLease ?? false,
      input.workerId ?? null,
      input.spendPausedAt === undefined ? null : input.spendPausedAt,
      input.spendPausedAt !== undefined
    ];
    await this.database.query(
      `UPDATE tasks SET
         status = $2,
         agent_state_ciphertext = COALESCE($3::jsonb, agent_state_ciphertext),
         actual_compute_credits = COALESCE($4, actual_compute_credits),
         lease_owner = CASE WHEN $5 THEN NULL ELSE lease_owner END,
         lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END,
         spend_paused_at = CASE WHEN $8 THEN $7::timestamptz ELSE spend_paused_at END,
         completed_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE completed_at END,
         updated_at = NOW()
       WHERE id = $1 AND ($6::text IS NULL OR lease_owner = $6)`,
      params
    );
  }

  /**
   * Writes one event onto a conversation's timeline.
   *
   * `kind` is parsed rather than trusted: the enum is the surface the API serves and the client
   * branches on, and the callers that reach this method hold it as a plain string. A kind nobody
   * declared is a programming error, and it is worth far more as a failed write here than as a row
   * the read side has to either lie about or refuse a whole page over.
   */
  async appendTaskEvent(input: {
    taskId: string;
    kind: string;
    summary: string;
    payloadCiphertext?: EncryptedEnvelope;
    /**
     * This event carries the whole of the same-kind run it closes, so those rows can go.
     *
     * The writer states it because the store cannot read it: the payload is encrypted here, so the
     * `replace` flag the client branches on is not visible in SQL. It exists for the streamed
     * thinking, where the row that consolidates the frames is the same kind as the frames it
     * supersedes - which the assistant_message rule below, a fixed pair of kinds, cannot express.
     */
    replacesEarlierFrames?: boolean;
  }): Promise<TaskEventRecord> {
    const kind = TaskEventKind.parse(input.kind);
    const result = await this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [input.taskId]);
      const inserted = await tx.query(
        `INSERT INTO task_events(id, task_id, sequence, kind, summary, payload_ciphertext)
         SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1, $3, $4, $5::jsonb
         FROM task_events WHERE task_id = $2
         RETURNING *`,
        [
          randomUUID(),
          input.taskId,
          kind,
          input.summary,
          input.payloadCiphertext ? JSON.stringify(input.payloadCiphertext) : null
        ]
      );
      // A reply is streamed a frame at a time, and the assistant_message that closes it carries the
      // final text - so the moment that message exists, every delta before it is a redundant slice
      // of it. Dropping them here rather than waiting for the retention sweep is what stops opening
      // a finished conversation from replaying every fragment it was ever assembled from; the live
      // stream has already delivered them to whoever was watching.
      if (kind === 'assistant_message')
        await tx.query(
          `DELETE FROM task_events
           WHERE task_id = $1 AND kind = 'assistant_delta' AND sequence < $2`,
          [input.taskId, Number(inserted.rows[0]!.sequence)]
        );
      // The same trade for a stream whose closing row is its own kind, which is the streamed
      // thinking: it has no assistant_message of its own, so nothing superseded its frames and they
      // were kept and decrypted forever. Only back to the last row of any other kind, though: the
      // step before this one closed with a row of this same kind too, and reaching past the tool
      // result or the answer that separates them would leave a thirty-step task holding nothing but
      // the thinking of its final step.
      if (input.replacesEarlierFrames)
        await tx.query(
          `DELETE FROM task_events
           WHERE task_id = $1 AND kind = $2 AND sequence < $3
             AND sequence > COALESCE(
               (SELECT MAX(sequence) FROM task_events
                WHERE task_id = $1 AND kind <> $2 AND sequence < $3), 0)`,
          [input.taskId, kind, Number(inserted.rows[0]!.sequence)]
        );
      return inserted;
    });
    // After the transaction, never inside it: a stream woken by an uncommitted insert would read
    // the table, find nothing, and go back to sleep having spent the wake-up.
    this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    // A settled answer is the first moment there is enough of a conversation to name it.
    if (kind === 'assistant_message') this.#signal(TASK_ANSWERED_CHANNEL, input.taskId);
    const row = result.rows[0]!;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      sequence: Number(row.sequence),
      kind,
      summary: String(row.summary),
      payloadCiphertext: row.payload_ciphertext
        ? json<EncryptedEnvelope>(row.payload_ciphertext)
        : null,
      createdAt: iso(row.created_at)
    };
  }

  /** Whole trajectory, oldest first. For export, search and branching, which need every row. */
  async listTaskEvents(taskId: string, after = 0): Promise<TaskEventRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM task_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence`,
      [taskId, after]
    );
    return result.rows.map(mapTaskEvent);
  }

  /**
   * Bounded window over one task's trajectory, for the timeline and its stream. `after` reads
   * forward from a cursor, which is what a live stream resumes with; `before` walks backwards
   * through older material a page at a time, which is how a reader reaches history that
   * `listRecentTaskEvents` deliberately did not send.
   *
   * Rows always come back oldest first whichever direction was asked for, so a caller can append
   * them to a cursor-ordered timeline without re-sorting.
   */
  async listTaskEventPage(
    taskId: string,
    options: { after?: number; before?: number; limit?: number } = {}
  ): Promise<TaskEventPage> {
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 200), MAX_TASK_EVENT_PAGE));
    const forward = options.before === undefined;
    const result = await this.database.query(
      forward
        ? `SELECT * FROM task_events WHERE task_id = $1 AND sequence > $2
           ORDER BY sequence LIMIT $3`
        : `SELECT * FROM task_events WHERE task_id = $1 AND sequence < $2
           ORDER BY sequence DESC LIMIT $3`,
      [taskId, forward ? Math.max(0, Math.trunc(options.after ?? 0)) : options.before, limit + 1]
    );
    // One row past the page is what proves there is more without a second count query.
    const overflowed = result.rows.length > limit;
    const rows = overflowed ? result.rows.slice(0, limit) : result.rows;
    const events = (forward ? rows : [...rows].reverse()).map(mapTaskEvent);
    const oldest = events[0]?.sequence ?? null;
    const newest = events.at(-1)?.sequence ?? null;
    if (forward)
      return {
        events,
        hasMore: overflowed,
        oldestSequence: oldest,
        nextCursor: newest ?? Math.max(0, Math.trunc(options.after ?? 0))
      };
    return { events, hasMore: overflowed, oldestSequence: oldest, nextCursor: newest ?? 0 };
  }

  /**
   * The newest page plus whether anything precedes it: the shape an initial timeline load wants,
   * because it also yields the cursor the event stream should be opened at.
   */
  async listRecentTaskEvents(taskId: string, limit = 200): Promise<TaskEventPage> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_TASK_EVENT_PAGE));
    const result = await this.database.query<{ next: string | null }>(
      'SELECT MAX(sequence)::text AS next FROM task_events WHERE task_id = $1',
      [taskId]
    );
    const latest = Number(result.rows[0]?.next ?? 0);
    if (!latest) return { events: [], hasMore: false, oldestSequence: null, nextCursor: 0 };
    return this.listTaskEventPage(taskId, { before: latest + 1, limit: bounded });
  }

  async createArtifact(input: {
    userId: string;
    workspaceId: string;
    taskId?: string;
    logicalKey: string;
    nameCiphertext: EncryptedEnvelope;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  }): Promise<Record<string, unknown>> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId]);
      const version = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM artifacts
         WHERE workspace_id=$1 AND logical_key=$2`,
        [input.workspaceId, input.logicalKey]
      );
      const id = randomUUID();
      const result = await tx.query(
        `INSERT INTO artifacts(id,user_id,workspace_id,task_id,name_ciphertext,mime_type,size_bytes,version,sha256,storage_key,logical_key)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          input.userId,
          input.workspaceId,
          input.taskId ?? null,
          JSON.stringify(input.nameCiphertext),
          input.mimeType,
          input.sizeBytes,
          Number(version.rows[0]?.next_version ?? 1),
          input.sha256,
          input.storageKey,
          input.logicalKey
        ]
      );
      return result.rows[0]!;
    });
  }

  async listArtifacts(
    userId: string,
    workspaceId: string
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT a.* FROM artifacts a JOIN workspaces w ON w.id=a.workspace_id
       WHERE a.workspace_id=$2 AND w.user_id=$1
       ORDER BY a.created_at DESC`,
      [userId, workspaceId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      taskId: optionalText(row.task_id),
      nameCiphertext: json<EncryptedEnvelope>(row.name_ciphertext),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      version: Number(row.version),
      sha256: String(row.sha256),
      storageKey: String(row.storage_key),
      logicalKey: String(row.logical_key),
      createdAt: iso(row.created_at)
    }));
  }

  async getArtifact(userId: string, id: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.query(
      `SELECT a.* FROM artifacts a JOIN workspaces w ON w.id=a.workspace_id
       WHERE a.id=$1 AND w.user_id=$2`,
      [id, userId]
    );
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          taskId: optionalText(row.task_id),
          nameCiphertext: json<EncryptedEnvelope>(row.name_ciphertext),
          mimeType: String(row.mime_type),
          sizeBytes: Number(row.size_bytes),
          version: Number(row.version),
          sha256: String(row.sha256),
          storageKey: String(row.storage_key),
          logicalKey: String(row.logical_key),
          createdAt: iso(row.created_at)
        }
      : null;
  }

  async deleteArtifact(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM artifacts WHERE id=$1 AND EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id=artifacts.workspace_id AND w.user_id=$2
      )`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async exportAccount(userId: string): Promise<Record<string, unknown>> {
    const [
      user,
      workspaces,
      tasks,
      taskPlans,
      schedules,
      previews,
      apiTokens,
      usage,
      providers,
      connectors,
      connectorAudit,
      approvals,
      security
    ] = await Promise.all([
      this.database.query('SELECT id,username,display_name,created_at FROM users WHERE id=$1', [
        userId
      ]),
      this.database.query(
        `SELECT w.id,w.name,w.status,w.storage_bytes,w.storage_limit_bytes,
        w.image_revision,w.region,k.wrapping_mode AS key_protection,w.created_at,w.updated_at
        FROM workspaces w JOIN workspace_keys k ON k.workspace_id=w.id
        WHERE w.user_id=$1 ORDER BY w.created_at`,
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,title AS title_ciphertext,status,model_id,privacy_route,max_compute_credits,actual_compute_credits,created_at,updated_at,completed_at FROM tasks WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        `SELECT p.id,p.task_id,p.version,p.parent_version,p.branch_name,p.created_by,p.created_at
        FROM task_plans p JOIN tasks t ON t.id=p.task_id
        WHERE t.user_id=$1 ORDER BY p.task_id,p.version`,
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,model_id,privacy_route,max_compute_credits,spec,enabled,next_run_at,last_run_at,last_task_id,last_error_code,created_at,updated_at FROM task_schedules WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,workspace_id,label,port,visibility,status,expires_at,last_accessed_at,created_at,updated_at FROM workspace_previews WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,label,token_prefix,scopes,last_used_at,expires_at,created_at,revoked_at FROM api_tokens WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,created_at FROM usage_entries WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      // The connection itself, never its secret: this file is downloaded to a laptop, and the key
      // it names is the one that pays the provider.
      this.database.query(
        'SELECT provider,status,external_ref,monthly_limit_usd,created_at,updated_at FROM managed_provider_credentials WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT id,kind,auth_mode,label,base_url,scopes,enabled,last_used_at,created_at,updated_at FROM connectors WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT connector_id,task_id,operation,outcome,status_code,request_bytes,response_bytes,duration_ms,created_at FROM connector_audit_events WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT task_id,action,origin,side_effect,status,expires_at,created_at,resolved_at FROM approvals WHERE user_id=$1 ORDER BY created_at',
        [userId]
      ),
      this.database.query(
        'SELECT kind,outcome,metadata,created_at FROM security_events WHERE user_id=$1 ORDER BY created_at',
        [userId]
      )
    ]);
    return {
      schemaVersion: 12,
      exportedAt: new Date().toISOString(),
      user: user.rows[0] ?? null,
      workspaces: workspaces.rows,
      tasks: tasks.rows,
      taskPlans: taskPlans.rows,
      schedules: schedules.rows,
      previews: previews.rows,
      apiTokens: apiTokens.rows,
      usage: usage.rows,
      providers: providers.rows,
      connectors: connectors.rows,
      connectorAudit: connectorAudit.rows,
      approvals: approvals.rows,
      securityEvents: security.rows
    };
  }

  /** Adds or refreshes the given releases and leaves everything else in the catalogue alone. */
  async upsertModels(models: Array<Record<string, unknown>>): Promise<void> {
    for (const model of models) await this.#upsertModel(this.database, model);
  }

  /**
   * A whole-catalogue refresh. Anything the provider still offers is written and anything it has
   * withdrawn is removed, in one transaction, so a deprecated model stops appearing in the picker
   * instead of failing at the provider the next time a task is routed to it.
   *
   * Two things bound the blast radius. An empty refresh prunes nothing at all, because a provider
   * outage that returned no models must never empty the picker. And the delete is scoped to the
   * providers this refresh actually covered, which is what keeps a self-hosted `custom/...` entry
   * and any provider it said nothing about.
   */
  async replaceModelCatalog(
    models: Array<Record<string, unknown>>
  ): Promise<{ upserted: number; removed: number }> {
    if (models.length === 0) return { upserted: 0, removed: 0 };
    const ids = models.map((model) => String(model.id));
    const providers = [...new Set(models.map((model) => String(model.provider)))];
    return this.database.transaction(async (transaction) => {
      for (const model of models) await this.#upsertModel(transaction, model);
      const removed = await transaction.query(
        `DELETE FROM model_releases
         WHERE provider = ANY($1::text[]) AND NOT (id = ANY($2::text[]))`,
        [providers, ids]
      );
      return { upserted: models.length, removed: removed.rowCount };
    });
  }

  async #upsertModel(database: Database, model: Record<string, unknown>): Promise<void> {
    await database.query(
      `INSERT INTO model_releases(
        id,provider_model_id,display_name,provider,revision,availability,openness,license,commercial_use,
        privacy_route,context_tokens,modalities,capabilities,usage_class,recommendation_tags,
        measured_quality,measured_latency_ms,metadata,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17,$18::jsonb,NOW())
      ON CONFLICT(id) DO UPDATE SET
        provider_model_id=EXCLUDED.provider_model_id,
        display_name=EXCLUDED.display_name, provider=EXCLUDED.provider,
        revision=EXCLUDED.revision, availability=EXCLUDED.availability,
        openness=EXCLUDED.openness, license=EXCLUDED.license,
        commercial_use=EXCLUDED.commercial_use, privacy_route=EXCLUDED.privacy_route,
        context_tokens=EXCLUDED.context_tokens, modalities=EXCLUDED.modalities,
        capabilities=EXCLUDED.capabilities, usage_class=EXCLUDED.usage_class,
        recommendation_tags=EXCLUDED.recommendation_tags,
        measured_quality=EXCLUDED.measured_quality,
        measured_latency_ms=EXCLUDED.measured_latency_ms,
        metadata=EXCLUDED.metadata, updated_at=NOW()`,
      [
        model.id,
        model.providerModelId,
        model.displayName,
        model.provider,
        model.revision,
        model.availability,
        model.openness,
        model.license,
        model.commercialUse,
        model.privacyRoute,
        model.contextTokens,
        JSON.stringify(model.modalities),
        JSON.stringify(model.capabilities),
        model.usageClass,
        JSON.stringify(model.recommendationTags),
        model.measuredQuality,
        model.measuredLatencyMs,
        JSON.stringify({
          ...(typeof model.metadata === 'object' && model.metadata ? model.metadata : {}),
          // The fields an unattended server routes on - provenance, retirement, cache style, price
          // tiers, output ceiling - travel through one contract rather than a hand-written list
          // here and a second one in listModels. Two lists is how they silently fell behind the
          // type and were dropped in transit, which made the whole routing layer inert.
          ...readRoutingMetadata(model),
          inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
          outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
          benchmarkRank: model.benchmarkRank ?? null,
          benchmarkSource: model.benchmarkSource ?? null,
          benchmarkUpdatedAt: model.benchmarkUpdatedAt ?? null,
          agenticQuality: model.agenticQuality ?? null,
          codingQuality: model.codingQuality ?? null,
          intelligenceQuality: model.intelligenceQuality ?? null,
          // JSON.stringify drops undefined, which is what keeps "the refresh never reported
          // availability" distinguishable from a live `false`; the privacy projection only
          // applies to catalogues that actually carry live endpoint data.
          providerAvailable: model.providerAvailable,
          zeroDataRetentionAvailable: model.zeroDataRetentionAvailable
        })
      ]
    );
  }

  async listModels(): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query('SELECT * FROM model_releases ORDER BY display_name');
    return result.rows.map((row) => {
      const metadata = json<Record<string, unknown>>(row.metadata ?? {});
      return {
        id: String(row.id),
        providerModelId: String(row.provider_model_id),
        displayName: String(row.display_name),
        provider: String(row.provider),
        revision: String(row.revision),
        availability: String(row.availability),
        openness: String(row.openness),
        license: String(row.license),
        commercialUse: Boolean(row.commercial_use),
        privacyRoute: String(row.privacy_route),
        contextTokens: Number(row.context_tokens),
        modalities: json(row.modalities),
        capabilities: json(row.capabilities),
        usageClass: String(row.usage_class),
        recommendationTags: json(row.recommendation_tags),
        measuredQuality: row.measured_quality === null ? null : Number(row.measured_quality),
        measuredLatencyMs:
          row.measured_latency_ms === null ? null : Number(row.measured_latency_ms),
        inputUsdPerMillionTokens:
          typeof metadata.inputUsdPerMillionTokens === 'number'
            ? metadata.inputUsdPerMillionTokens
            : null,
        outputUsdPerMillionTokens:
          typeof metadata.outputUsdPerMillionTokens === 'number'
            ? metadata.outputUsdPerMillionTokens
            : null,
        benchmarkRank: typeof metadata.benchmarkRank === 'number' ? metadata.benchmarkRank : null,
        benchmarkSource:
          typeof metadata.benchmarkSource === 'string' ? metadata.benchmarkSource : null,
        benchmarkUpdatedAt:
          typeof metadata.benchmarkUpdatedAt === 'string' ? metadata.benchmarkUpdatedAt : null,
        agenticQuality:
          typeof metadata.agenticQuality === 'number' ? metadata.agenticQuality : null,
        codingQuality: typeof metadata.codingQuality === 'number' ? metadata.codingQuality : null,
        intelligenceQuality:
          typeof metadata.intelligenceQuality === 'number' ? metadata.intelligenceQuality : null,
        // Rows written before these fields existed must stay undefined rather than become `false`,
        // or the privacy projection would read them as "no live endpoint" and hide the catalogue.
        ...(typeof metadata.providerAvailable === 'boolean'
          ? { providerAvailable: metadata.providerAvailable }
          : {}),
        ...(typeof metadata.zeroDataRetentionAvailable === 'boolean'
          ? { zeroDataRetentionAvailable: metadata.zeroDataRetentionAvailable }
          : {}),
        ...readRoutingMetadata(metadata),
        updatedAt: iso(row.updated_at)
      };
    });
  }

  async recordUsage(input: {
    userId: string;
    workspaceId?: string;
    taskId?: string;
    kind: string;
    resourceClass: string;
    quantity: number;
    unit: string;
    credits: number;
    state: 'reserved' | 'settled' | 'released' | 'credited';
    idempotencyKey: string;
    providerRef?: string;
    costUsd?: number;
    modelId?: string;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO usage_entries(
        id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
        idempotency_key,provider_ref,cost_usd,model_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.userId,
        input.workspaceId ?? null,
        input.taskId ?? null,
        input.kind,
        input.resourceClass,
        input.quantity,
        input.unit,
        input.credits,
        input.state,
        input.idempotencyKey,
        input.providerRef ?? null,
        input.costUsd ?? 0,
        // provider_ref is "<provider>:<model>". Splitting it here means callers that already pass
        // the composite reference get an exact per-model spend breakdown without being changed.
        input.modelId ?? providerRefModelId(input.providerRef)
      ]
    );
  }

  async transitionUsage(idempotencyKey: string, from: string, to: string): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE usage_entries SET state = $3 WHERE idempotency_key = $1 AND state = $2',
      [idempotencyKey, from, to]
    );
    return result.rowCount === 1;
  }

  async reservedUsageForTask(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(credits),0) AS credits FROM usage_entries
       WHERE task_id=$1 AND state='reserved'`,
      [taskId]
    );
    return Number(result.rows[0]?.credits ?? 0);
  }

  /**
   * What one task has actually been charged for generated media, which is what the second brake on
   * a runaway generation loop is measured against. Read from the ledger rather than from a job
   * table because the ledger is where the provider's own figure lands.
   */
  async mediaSpendForTask(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost FROM usage_entries
       WHERE task_id=$1 AND resource_class LIKE 'media:%'`,
      [taskId]
    );
    return Number(result.rows[0]?.cost ?? 0);
  }

  /**
   * Merges rather than replaces, so two devices saving different choices at the same moment do not
   * each erase the other's - the last writer of a key wins, which is the smallest unit anyone
   * actually changed.
   */
  async mergeUserPreferences(
    userId: string,
    patch: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `UPDATE users SET preferences = preferences || $2::jsonb, updated_at = NOW()
       WHERE id = $1 RETURNING preferences`,
      [userId, JSON.stringify(patch)]
    );
    const value = result.rows[0]?.preferences;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  /**
   * The half-typed message for one conversation, or for the one not started yet.
   *
   * Written on a debounce from the client, so this is a hot path for a keyboard: upsert on the
   * unique index rather than read-then-write, and an empty draft deletes the row instead of storing
   * emptiness for every conversation the owner ever opened.
   */
  async saveMessageDraft(input: {
    userId: string;
    workspaceId: string;
    taskId?: string | null;
    bodyCiphertext: EncryptedEnvelope | null;
  }): Promise<void> {
    const taskId = input.taskId ?? null;
    if (!input.bodyCiphertext) {
      await this.database.query(
        `DELETE FROM message_drafts WHERE workspace_id=$1 AND task_id IS NOT DISTINCT FROM $2`,
        [input.workspaceId, taskId]
      );
      return;
    }
    // Two partial unique indexes, so two conflict targets: one insert cannot name both, and the
    // draft with no conversation yet is the one most first sentences are typed into.
    const conflict =
      taskId === null
        ? 'ON CONFLICT (workspace_id) WHERE task_id IS NULL'
        : 'ON CONFLICT (workspace_id, task_id) WHERE task_id IS NOT NULL';
    await this.database.query(
      `INSERT INTO message_drafts(user_id,workspace_id,task_id,body_ciphertext,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,NOW())
       ${conflict}
         DO UPDATE SET body_ciphertext=EXCLUDED.body_ciphertext, updated_at=NOW()`,
      [input.userId, input.workspaceId, taskId, JSON.stringify(input.bodyCiphertext)]
    );
  }

  async listMessageDrafts(
    userId: string,
    workspaceId: string
  ): Promise<Array<{ taskId: string | null; bodyCiphertext: EncryptedEnvelope }>> {
    const result = await this.database.query(
      `SELECT task_id, body_ciphertext FROM message_drafts
       WHERE user_id=$1 AND workspace_id=$2`,
      [userId, workspaceId]
    );
    return result.rows.map((row) => ({
      taskId: optionalText(row.task_id) ?? null,
      bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext)
    }));
  }

  async usageTotals(
    userId: string,
    from: Date,
    to: Date
  ): Promise<{ settled: number; reserved: number }> {
    const result = await this.database.query(
      `SELECT
        COALESCE(SUM(CASE WHEN state = 'settled' THEN credits ELSE 0 END), 0) AS settled,
        COALESCE(SUM(CASE WHEN state = 'reserved' THEN credits ELSE 0 END), 0) AS reserved
       FROM usage_entries WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
         AND kind IN ('workspace_compute','task_compute','media_gpu')`,
      [userId, from.toISOString(), to.toISOString()]
    );
    return {
      settled: Number(result.rows[0]?.settled ?? 0),
      reserved: Number(result.rows[0]?.reserved ?? 0)
    };
  }

  async usageHistory(userId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,cost_usd,state,created_at
       FROM usage_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      workspaceId: optionalText(row.workspace_id),
      taskId: optionalText(row.task_id),
      kind: String(row.kind),
      resourceClass: String(row.resource_class),
      quantity: Number(row.quantity),
      unit: String(row.unit),
      credits: Number(row.credits),
      costUsd: Number(row.cost_usd ?? 0),
      modelId: optionalText(row.model_id),
      state: String(row.state),
      createdAt: iso(row.created_at)
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Spend in real currency.
  //
  // Compute credits price a task against a shared scheduler; they do not price it against a bank
  // account, because the dollars a credit stands for move with the model class. Everything below
  // reads usage_entries.cost_usd, which is what the provider actually billed, so that "stop before
  // this costs me more than X" has one answer regardless of which model the router picked.
  // ---------------------------------------------------------------------------------------------

  async getSpendLimits(userId: string): Promise<SpendLimitsRecord | null> {
    return this.spendLimitsIn(this.database, userId);
  }

  private async spendLimitsIn(db: Database, userId: string): Promise<SpendLimitsRecord | null> {
    const result = await db.query('SELECT * FROM spend_limits WHERE user_id=$1', [userId]);
    const row = result.rows[0];
    return row
      ? {
          userId: String(row.user_id),
          dailyCapUsd: numericOrNull(row.daily_cap_usd),
          monthlyCapUsd: numericOrNull(row.monthly_cap_usd),
          defaultTaskCapUsd: numericOrNull(row.default_task_cap_usd),
          warnAtPercent: Number(row.warn_at_percent),
          timeZone: String(row.time_zone),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  /**
   * Every field is optional and an omitted field is left alone, because the three caps are set at
   * different moments - a monthly ceiling once, a daily one when a run gets away from you.
   * Clearing a cap is `null`, which is why absent and null cannot be the same thing here.
   */
  async setSpendLimits(input: {
    userId: string;
    dailyCapUsd?: number | null;
    monthlyCapUsd?: number | null;
    defaultTaskCapUsd?: number | null;
    warnAtPercent?: number;
    timeZone?: string;
  }): Promise<SpendLimitsRecord> {
    if (input.timeZone !== undefined) assertTimeZone(input.timeZone);
    const result = await this.database.query(
      `INSERT INTO spend_limits(
         user_id,daily_cap_usd,monthly_cap_usd,default_task_cap_usd,warn_at_percent,time_zone
       ) VALUES ($1,$2,$3,$4,COALESCE($5,80),COALESCE($6,'UTC'))
       ON CONFLICT(user_id) DO UPDATE SET
         daily_cap_usd=CASE WHEN $7 THEN $2 ELSE spend_limits.daily_cap_usd END,
         monthly_cap_usd=CASE WHEN $8 THEN $3 ELSE spend_limits.monthly_cap_usd END,
         default_task_cap_usd=CASE WHEN $9 THEN $4 ELSE spend_limits.default_task_cap_usd END,
         warn_at_percent=COALESCE($5,spend_limits.warn_at_percent),
         time_zone=COALESCE($6,spend_limits.time_zone),
         updated_at=NOW()
       RETURNING *`,
      [
        input.userId,
        input.dailyCapUsd ?? null,
        input.monthlyCapUsd ?? null,
        input.defaultTaskCapUsd ?? null,
        input.warnAtPercent ?? null,
        input.timeZone ?? null,
        input.dailyCapUsd !== undefined,
        input.monthlyCapUsd !== undefined,
        input.defaultTaskCapUsd !== undefined
      ]
    );
    const row = result.rows[0]!;
    return {
      userId: String(row.user_id),
      dailyCapUsd: numericOrNull(row.daily_cap_usd),
      monthlyCapUsd: numericOrNull(row.monthly_cap_usd),
      defaultTaskCapUsd: numericOrNull(row.default_task_cap_usd),
      warnAtPercent: Number(row.warn_at_percent),
      timeZone: String(row.time_zone),
      updatedAt: iso(row.updated_at)
    };
  }

  /** Settled provider cost in a half-open interval, whatever it was spent on. */
  async spendTotal(userId: string, from: Date, to: Date): Promise<number> {
    return this.spendTotalIn(this.database, userId, from, to);
  }

  private async spendTotalIn(db: Database, userId: string, from: Date, to: Date): Promise<number> {
    const result = await db.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3`,
      [userId, from.toISOString(), to.toISOString()]
    );
    return Number(result.rows[0]?.cost_usd ?? 0);
  }

  async taskSpend(taskId: string): Promise<number> {
    const result = await this.database.query(
      `SELECT COALESCE(SUM(cost_usd),0) AS cost_usd FROM usage_entries
       WHERE task_id=$1 AND state='settled' AND cost_usd>0`,
      [taskId]
    );
    return Number(result.rows[0]?.cost_usd ?? 0);
  }

  /**
   * The unspent headroom of work that is already open. Without it two tasks started in the same
   * second each see the same settled total, each fit under the cap, and together sail past it.
   */
  async openSpendCommitment(userId: string, excludeTaskId?: string): Promise<number> {
    return this.openSpendCommitmentIn(this.database, userId, excludeTaskId);
  }

  private async openSpendCommitmentIn(
    db: Database,
    userId: string,
    excludeTaskId?: string
  ): Promise<number> {
    const result = await db.query(
      `SELECT COALESCE(SUM(GREATEST(t.max_spend_usd - COALESCE(s.spent,0),0)),0) AS pending
       FROM tasks t
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(u.cost_usd),0) AS spent FROM usage_entries u
         WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0
       ) s ON TRUE
       WHERE t.user_id=$1 AND t.max_spend_usd IS NOT NULL
         AND t.status IN ${OPEN_TASK_STATUSES}
         AND ($2::uuid IS NULL OR t.id<>$2::uuid)`,
      [userId, excludeTaskId ?? null]
    );
    return Number(result.rows[0]?.pending ?? 0);
  }

  /**
   * One round trip that answers "may this work start, and should the owner be warned". Callers
   * differ only in the estimate they bring and in whether other open tasks count against them:
   * they do when deciding to start something new, and they must not when a running task is
   * checking itself, or it would block on its own reservation.
   */
  async spendGuard(input: {
    userId: string;
    taskId?: string;
    estimateUsd: number;
    includeOpenCommitments?: boolean;
    /** Ceiling to price the task window against when the task row does not exist yet. */
    taskCapUsd?: number | null;
    now?: Date;
  }): Promise<SpendDecision> {
    return this.spendGuardIn(this.database, input);
  }

  private async spendGuardIn(
    db: Database,
    input: {
      userId: string;
      taskId?: string;
      estimateUsd: number;
      includeOpenCommitments?: boolean;
      taskCapUsd?: number | null;
      now?: Date;
    }
  ): Promise<SpendDecision> {
    const now = input.now ?? new Date();
    const limits = await this.spendLimitsIn(db, input.userId);
    const timeZone = limits?.timeZone ?? 'UTC';
    const bounds = spendWindowBounds(timeZone, now);
    // Sequential rather than concurrent: `db` may be a transaction, which is one client, and two
    // queries in flight on one client is how a transaction ends up interleaved.
    const daily = await this.spendTotalIn(db, input.userId, bounds.daily.start, bounds.daily.end);
    const monthly = await this.spendTotalIn(
      db,
      input.userId,
      bounds.monthly.start,
      bounds.monthly.end
    );
    const pending = input.includeOpenCommitments
      ? await this.openSpendCommitmentIn(db, input.userId, input.taskId)
      : 0;
    const task = input.taskId
      ? await db.query(
          `SELECT t.max_spend_usd,
             (SELECT COALESCE(SUM(u.cost_usd),0) FROM usage_entries u
               WHERE u.task_id=t.id AND u.state='settled' AND u.cost_usd>0) AS spent
           FROM tasks t WHERE t.id=$1`,
          [input.taskId]
        )
      : null;

    const taskRow = task?.rows[0];
    const taskCapUsd =
      input.taskCapUsd !== undefined
        ? input.taskCapUsd
        : taskRow
          ? numericOrNull(taskRow.max_spend_usd)
          : null;
    const windows: SpendWindowInput[] = [
      {
        name: 'daily',
        spentUsd: daily,
        pendingUsd: pending,
        capUsd: limits?.dailyCapUsd ?? null,
        startsAt: bounds.daily.start,
        endsAt: bounds.daily.end
      },
      {
        name: 'monthly',
        spentUsd: monthly,
        pendingUsd: pending,
        capUsd: limits?.monthlyCapUsd ?? null,
        startsAt: bounds.monthly.start,
        endsAt: bounds.monthly.end
      }
    ];
    if (taskCapUsd !== null)
      windows.unshift({
        name: 'task',
        spentUsd: Number(taskRow?.spent ?? 0),
        capUsd: taskCapUsd
      });

    return evaluateSpendCaps({
      windows,
      estimateUsd: input.estimateUsd,
      warnAtPercent: limits?.warnAtPercent ?? DEFAULT_SPEND_WARN_PERCENT
    });
  }

  /**
   * Records that a window crossed a threshold, and answers whether this is the first time. The
   * primary key is the window occurrence, so a soft threshold produces one alert for the day it
   * was crossed on rather than one per model call for the rest of it.
   */
  async claimSpendAlert(input: {
    userId: string;
    windowName: 'daily' | 'monthly';
    windowStart: Date;
    level: 'warning' | 'exceeded';
    spentUsd: number;
    capUsd: number;
  }): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO spend_alerts(user_id,window_name,window_start,level,spent_usd,cap_usd)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id,window_name,window_start,level) DO NOTHING`,
      [
        input.userId,
        input.windowName,
        input.windowStart.toISOString(),
        input.level,
        Math.max(0, input.spentUsd),
        Math.max(0, input.capUsd)
      ]
    );
    return result.rowCount === 1;
  }

  async listSpendAlerts(userId: string, limit = 50): Promise<SpendAlertRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM spend_alerts WHERE user_id=$1
       ORDER BY created_at DESC, window_name, window_start DESC, level LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({
      userId: String(row.user_id),
      windowName: String(row.window_name) as SpendAlertRecord['windowName'],
      windowStart: iso(row.window_start),
      level: String(row.level) as SpendAlertRecord['level'],
      spentUsd: Number(row.spent_usd),
      capUsd: Number(row.cap_usd),
      createdAt: iso(row.created_at)
    }));
  }

  /**
   * Spend grouped by the owner's calendar day. The grouping is done here rather than in SQL so it
   * uses exactly the same zone arithmetic the caps do; a day that shows $4 in the chart and $4 in
   * the cap is the whole point of the surface.
   */
  async spendByDay(userId: string, from: Date, to: Date, timeZone = 'UTC'): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT created_at,cost_usd FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3
       ORDER BY created_at`,
      [userId, from.toISOString(), to.toISOString()]
    );
    const days = new Map<string, SpendBucket>();
    for (const row of result.rows) {
      const key = localDayKey(timeZone, new Date(String(row.created_at)));
      const bucket = days.get(key) ?? { key, costUsd: 0, calls: 0 };
      bucket.costUsd += Number(row.cost_usd);
      bucket.calls += 1;
      days.set(key, bucket);
    }
    return [...days.values()].map((bucket) => ({ ...bucket, costUsd: roundUsd(bucket.costUsd) }));
  }

  async spendByModel(userId: string, from: Date, to: Date, limit = 20): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT COALESCE(model_id,kind) AS key,SUM(cost_usd) AS cost_usd,COUNT(*) AS calls
       FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0
         AND created_at>=$2 AND created_at<$3
       GROUP BY 1 ORDER BY SUM(cost_usd) DESC, 1 LIMIT $4`,
      [userId, from.toISOString(), to.toISOString(), limit]
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      costUsd: roundUsd(Number(row.cost_usd)),
      calls: Number(row.calls)
    }));
  }

  /**
   * The limits as they are actually applied, with the defaults filled in for an owner who has
   * never opened the settings. The epoch timestamp is how a caller tells a default apart from a
   * deliberate choice that happens to match it.
   */
  async effectiveSpendLimits(userId: string): Promise<SpendLimits> {
    const stored = await this.getSpendLimits(userId);
    return {
      dailyCapUsd: stored?.dailyCapUsd ?? null,
      monthlyCapUsd: stored?.monthlyCapUsd ?? null,
      defaultTaskCapUsd: stored?.defaultTaskCapUsd ?? null,
      warnAtPercent: stored?.warnAtPercent ?? DEFAULT_SPEND_WARN_PERCENT,
      timeZone: stored?.timeZone ?? 'UTC',
      updatedAt: stored?.updatedAt ?? new Date(0).toISOString()
    };
  }

  /**
   * Everything the spend surface needs in one call. The breakdowns cover the capped month so the
   * numbers reconcile with the monthly ceiling; the daily series runs a month back from today so
   * the trend is still readable on the first of the month.
   */
  async spendSummary(userId: string, now = new Date()): Promise<SpendSummary> {
    const limits = await this.effectiveSpendLimits(userId);
    const bounds = spendWindowBounds(limits.timeZone, now);
    const seriesStart = new Date(bounds.daily.end.getTime() - 30 * 24 * 60 * 60_000);
    const [decision, byDay, byModel, byTask] = await Promise.all([
      this.spendGuard({ userId, estimateUsd: 0, includeOpenCommitments: true, now }),
      this.spendByDay(userId, seriesStart, bounds.daily.end, limits.timeZone),
      this.spendByModel(userId, bounds.monthly.start, bounds.monthly.end),
      this.spendByTask(userId, bounds.monthly.start, bounds.monthly.end)
    ]);
    return { limits, windows: decision.windows, byDay, byModel, byTask };
  }

  async spendByTask(userId: string, from: Date, to: Date, limit = 20): Promise<SpendBucket[]> {
    const result = await this.database.query(
      `SELECT task_id AS key,SUM(cost_usd) AS cost_usd,COUNT(*) AS calls
       FROM usage_entries
       WHERE user_id=$1 AND state='settled' AND cost_usd>0 AND task_id IS NOT NULL
         AND created_at>=$2 AND created_at<$3
       GROUP BY 1 ORDER BY SUM(cost_usd) DESC, 1 LIMIT $4`,
      [userId, from.toISOString(), to.toISOString(), limit]
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      costUsd: roundUsd(Number(row.cost_usd)),
      calls: Number(row.calls)
    }));
  }

  async createApproval(input: {
    userId: string;
    taskId: string;
    action: string;
    origin?: string;
    sideEffect: string;
    previewCiphertext: EncryptedEnvelope;
    previewHash: string;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO approvals(id,user_id,task_id,action,origin,side_effect,preview_ciphertext,preview_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        id,
        input.userId,
        input.taskId,
        input.action,
        input.origin ?? null,
        input.sideEffect,
        JSON.stringify(input.previewCiphertext),
        input.previewHash,
        input.expiresAt.toISOString()
      ]
    );
    return id;
  }

  async listApprovals(userId: string, status = 'pending'): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `SELECT * FROM approvals WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC`,
      [userId, status]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      action: String(row.action),
      origin: optionalText(row.origin),
      sideEffect: String(row.side_effect),
      previewCiphertext: json<EncryptedEnvelope>(row.preview_ciphertext),
      previewHash: String(row.preview_hash),
      status: String(row.status),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at)
    }));
  }

  async resolveApproval(
    userId: string,
    id: string,
    decision: 'approved' | 'denied'
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE approvals SET status = $3, resolved_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()`,
      [id, userId, decision]
    );
    return result.rowCount === 1;
  }

  async getApproval(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.query('SELECT * FROM approvals WHERE id = $1', [id]);
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          taskId: String(row.task_id),
          action: String(row.action),
          status: String(row.status),
          previewHash: String(row.preview_hash),
          expiresAt: iso(row.expires_at)
        }
      : null;
  }

  async getManagedProviderCredential(
    userId: string,
    provider: string
  ): Promise<ManagedProviderCredentialRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    const row = result.rows[0];
    return row
      ? {
          userId: String(row.user_id),
          provider: String(row.provider),
          secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
          externalRef: String(row.external_ref),
          monthlyLimitUsd: Number(row.monthly_limit_usd),
          status: String(row.status) as ManagedProviderCredentialRecord['status'],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  async upsertManagedProviderCredential(input: {
    userId: string;
    provider: string;
    secretCiphertext: EncryptedEnvelope;
    externalRef: string;
    monthlyLimitUsd: number;
    status?: ManagedProviderCredentialRecord['status'];
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO managed_provider_credentials(
         user_id,provider,secret_ciphertext,external_ref,monthly_limit_usd,status
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT(user_id,provider) DO UPDATE SET
         secret_ciphertext=EXCLUDED.secret_ciphertext,
         external_ref=EXCLUDED.external_ref,
         monthly_limit_usd=EXCLUDED.monthly_limit_usd,
         status=EXCLUDED.status,
         updated_at=NOW()`,
      [
        input.userId,
        input.provider,
        JSON.stringify(input.secretCiphertext),
        input.externalRef,
        input.monthlyLimitUsd,
        input.status ?? 'active'
      ]
    );
  }

  async deleteManagedProviderCredential(userId: string, provider: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    return result.rowCount === 1;
  }

  async createConnector(input: {
    id: string;
    userId: string;
    kind: ConnectorRecord['kind'];
    authMode: ConnectorRecord['authMode'];
    label: string;
    baseUrl: string;
    scopes: ConnectorRecord['scopes'];
    secretCiphertext: EncryptedEnvelope;
  }): Promise<ConnectorRecord> {
    const result = await this.database.query(
      `INSERT INTO connectors(id,user_id,kind,auth_mode,label,base_url,scopes,secret_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.kind,
        input.authMode,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        JSON.stringify(input.secretCiphertext)
      ]
    );
    return mapConnector(result.rows[0]!);
  }

  async listConnectors(userId: string): Promise<ConnectorRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE user_id=$1 ORDER BY enabled DESC, created_at DESC`,
      [userId]
    );
    return result.rows.map(mapConnector);
  }

  async getConnector(userId: string, id: string): Promise<ConnectorRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rows[0] ? mapConnector(result.rows[0]) : null;
  }

  async revokeConnector(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET enabled=FALSE,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async updateConnectorSecret(
    userId: string,
    id: string,
    secretCiphertext: EncryptedEnvelope
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET secret_ciphertext=$3::jsonb,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId, JSON.stringify(secretCiphertext)]
    );
    return result.rowCount === 1;
  }

  async createConnectorOAuthAttempt(input: {
    id: string;
    userId: string;
    label: string;
    baseUrl: string;
    scopes: ConnectorOAuthAttemptRecord['scopes'];
    stateHash: string;
    secretCiphertext: EncryptedEnvelope;
    expiresAt: Date;
  }): Promise<ConnectorOAuthAttemptRecord> {
    const result = await this.database.query(
      `INSERT INTO connector_oauth_attempts(
         id,user_id,label,base_url,scopes,state_hash,secret_ciphertext,expires_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        input.stateHash,
        JSON.stringify(input.secretCiphertext),
        input.expiresAt.toISOString()
      ]
    );
    return mapConnectorOAuthAttempt(result.rows[0]!);
  }

  async consumeConnectorOAuthAttempt(
    stateHash: string
  ): Promise<ConnectorOAuthAttemptRecord | null> {
    const result = await this.database.query(
      `DELETE FROM connector_oauth_attempts
       WHERE state_hash=$1 AND expires_at>NOW()
       RETURNING *`,
      [stateHash]
    );
    return result.rows[0] ? mapConnectorOAuthAttempt(result.rows[0]) : null;
  }

  async recordConnectorAudit(input: {
    connectorId: string;
    userId: string;
    taskId?: string;
    operation: string;
    outcome: ConnectorAuditRecord['outcome'];
    statusCode?: number;
    requestBytes?: number;
    responseBytes?: number;
    durationMs?: number;
  }): Promise<ConnectorAuditRecord> {
    const result = await this.database.query(
      `WITH inserted AS (
         INSERT INTO connector_audit_events(
           id,connector_id,user_id,task_id,operation,outcome,status_code,
           request_bytes,response_bytes,duration_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *
       ), touched AS (
         UPDATE connectors SET last_used_at=NOW(),updated_at=NOW()
         WHERE id=$2 AND user_id=$3
       ) SELECT * FROM inserted`,
      [
        randomUUID(),
        input.connectorId,
        input.userId,
        input.taskId ?? null,
        input.operation,
        input.outcome,
        input.statusCode ?? null,
        input.requestBytes ?? 0,
        input.responseBytes ?? 0,
        input.durationMs ?? 0
      ]
    );
    return mapConnectorAudit(result.rows[0]!);
  }

  async listConnectorAudit(userId: string, limit = 100): Promise<ConnectorAuditRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connector_audit_events WHERE user_id=$1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(500, limit))]
    );
    return result.rows.map(mapConnectorAudit);
  }

  /**
   * A private preview, live until the owner ends it or stops opening it.
   *
   * There is no lifetime to pass: the deadline this writes is an idle window that every visit
   * through the preview gateway pushes back out, so the owner's own app stays reachable from their
   * own devices for as long as they keep using it, and a link nobody has opened in a month closes
   * itself rather than leaving a bearer token live in a chat history.
   */
  async createWorkspacePreview(input: {
    userId: string;
    workspaceId: string;
    label: string;
    port: number;
    slug: string;
    accessTokenHash: string;
    maxPreviews?: number;
  }): Promise<WorkspacePreviewRecord> {
    const maxPreviews = input.maxPreviews ?? MAX_WORKSPACE_PREVIEWS;
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      const count = await tx.query(
        `SELECT COUNT(*) AS count FROM workspace_previews
         WHERE user_id=$1 AND status='active'
           AND (expires_at IS NULL OR expires_at>NOW())`,
        [input.userId]
      );
      if (Number(count.rows[0]?.count ?? 0) >= maxPreviews) throw new Error('preview_limit');
      const result = await tx.query(
        `INSERT INTO workspace_previews(
           id,user_id,workspace_id,label,port,slug,access_token_hash,expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+$8::interval) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          input.label,
          input.port,
          input.slug,
          input.accessTokenHash,
          PREVIEW_IDLE_INTERVAL
        ]
      );
      return mapWorkspacePreview(result.rows[0]!);
    });
  }

  async listWorkspacePreviews(
    userId: string,
    workspaceId?: string
  ): Promise<WorkspacePreviewRecord[]> {
    const result = workspaceId
      ? await this.database.query(
          `SELECT p.* FROM workspace_previews p JOIN workspaces w ON w.id=p.workspace_id
           WHERE p.workspace_id=$2 AND w.user_id=$1
           ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
          [userId, workspaceId]
        )
      : await this.database.query(
          `SELECT * FROM workspace_previews WHERE user_id=$1
           ORDER BY created_at DESC, id DESC LIMIT 100`,
          [userId]
        );
    return result.rows.map(mapWorkspacePreview);
  }

  async getWorkspacePreview(userId: string, id: string): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM workspace_previews WHERE id=$1 AND user_id=$2',
      [id, userId]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async getWorkspacePreviewBySlug(slug: string): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query('SELECT * FROM workspace_previews WHERE slug=$1', [
      slug
    ]);
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async getWorkspacePreviewByCustomDomain(domain: string): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM workspace_previews
       WHERE LOWER(custom_domain)=LOWER($1) AND domain_status='active'
         AND visibility='public' AND status='active'
         AND (expires_at IS NULL OR expires_at>NOW())`,
      [domain]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async rotateWorkspacePreviewAccess(
    userId: string,
    id: string,
    accessTokenHash: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET access_token_hash=$3,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active'
         AND (expires_at IS NULL OR expires_at>NOW()) RETURNING *`,
      [id, userId, accessTokenHash]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  /**
   * Moves a preview between private and public, rotating the access token either way.
   *
   * Neither destination is timed. A published site stays up until it is unpublished or revoked,
   * because a link the owner has handed to other people should not expire underneath them; going
   * back to private restores the idle window, so an app the owner keeps using keeps working and
   * one they forget closes on its own.
   */
  async publishWorkspacePreview(
    userId: string,
    id: string,
    visibility: 'private' | 'public',
    accessTokenHash: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET visibility=$3,access_token_hash=$4,
       expires_at=CASE WHEN $3='public' THEN NULL ELSE NOW()+$5::interval END,
       status='active',published_at=CASE WHEN $3='public' THEN NOW() ELSE published_at END,
       updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, visibility, accessTokenHash, PREVIEW_IDLE_INTERVAL]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async beginWorkspacePreviewDomain(input: {
    userId: string;
    id: string;
    domain: string;
    verificationHash: string;
  }): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET custom_domain=$3,domain_status='pending',
       domain_verification_hash=$4,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND visibility='public' AND status='active'
       RETURNING *`,
      [input.id, input.userId, input.domain, input.verificationHash]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async verifyWorkspacePreviewDomain(
    userId: string,
    id: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET domain_status='active',updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND custom_domain IS NOT NULL
         AND domain_verification_hash IS NOT NULL AND visibility='public' AND status='active'
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async clearWorkspacePreviewDomain(
    userId: string,
    id: string
  ): Promise<WorkspacePreviewRecord | null> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET custom_domain=NULL,domain_status=NULL,
       domain_verification_hash=NULL,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId]
    );
    return result.rows[0] ? mapWorkspacePreview(result.rows[0]) : null;
  }

  async revokeWorkspacePreview(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE workspace_previews SET status='revoked',updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND status='active'`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  /**
   * Records a visit, and pushes the idle deadline back out with it.
   *
   * This is what makes a private preview persistent: use is the renewal, so nothing has to be
   * re-published and no ceiling has to be chosen. A published site has no deadline to move, so the
   * CASE leaves its NULL alone rather than accidentally giving it one.
   */
  async touchWorkspacePreview(id: string): Promise<void> {
    await this.database.query(
      `UPDATE workspace_previews SET last_accessed_at=NOW(),
       expires_at=CASE WHEN expires_at IS NULL THEN NULL ELSE NOW()+$2::interval END
       WHERE id=$1 AND status='active'`,
      [id, PREVIEW_IDLE_INTERVAL]
    );
  }

  async upsertPushSubscription(input: {
    userId: string;
    sessionPublicId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<PushSubscriptionRecord> {
    const result = await this.database.query(
      `INSERT INTO push_subscriptions(id,user_id,session_public_id,endpoint,p256dh,auth)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(endpoint) DO UPDATE SET
         session_public_id=EXCLUDED.session_public_id,p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,updated_at=NOW()
       WHERE push_subscriptions.user_id=EXCLUDED.user_id
       RETURNING *`,
      [randomUUID(), input.userId, input.sessionPublicId, input.endpoint, input.p256dh, input.auth]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Push endpoint is already registered to another account');
    return {
      id: String(row.id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [userId, endpoint]
    );
    return result.rowCount === 1;
  }

  async deletePushSubscriptionById(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM push_subscriptions WHERE id=$1', [id]);
    return result.rowCount === 1;
  }

  /**
   * One notification the agent decided the owner should have.
   *
   * This is the only way a push exists because something chose to send it rather than because a
   * row changed status, and it is what makes a watcher possible: the run itself is silent, and the
   * message arrives on the mornings the page actually moved.
   *
   * The cap is per conversation and enforced inside the transaction, so a model that decides
   * everything is urgent runs out of notifications rather than out of the owner's patience. It
   * throws `agent_notification_limit`, which the caller turns into a tool error the agent can read
   * and keep working through - a refused notification is not a reason to abandon the task.
   */
  async createAgentNotification(input: {
    userId: string;
    taskId: string;
    kind: AgentNotificationRecord['kind'];
    messageCiphertext: EncryptedEnvelope;
  }): Promise<AgentNotificationRecord> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.query(
        `SELECT COUNT(*) AS count FROM agent_notifications
         WHERE task_id=$1 AND user_id=$2`,
        [input.taskId, input.userId]
      );
      if (Number(existing.rows[0]?.count ?? 0) >= MAX_AGENT_NOTIFICATIONS_PER_TASK)
        throw new AthanorError(
          'agent_notification_limit',
          `This conversation has already sent its ${MAX_AGENT_NOTIFICATIONS_PER_TASK} notifications`
        );
      const result = await tx.query(
        `INSERT INTO agent_notifications(id,user_id,task_id,kind,message_ciphertext)
         SELECT $1,$2,$3,$4,$5::jsonb FROM tasks WHERE id=$3 AND user_id=$2
         RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.taskId,
          input.kind,
          JSON.stringify(input.messageCiphertext)
        ]
      );
      const row = result.rows[0];
      if (!row) throw new AthanorError('task_not_found', 'Conversation not found', 404);
      return {
        id: String(row.id),
        userId: String(row.user_id),
        taskId: String(row.task_id),
        kind: String(row.kind) as AgentNotificationRecord['kind'],
        messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
        createdAt: iso(row.created_at)
      };
    });
  }

  /**
   * Everything the agent has told this owner, newest first, across every conversation.
   *
   * A push is a moment and a device: it fires once, on whatever was subscribed, and is gone. This
   * is the standing record of the same rows, for the owner who was asleep, whose phone was off, or
   * who wants to read a week of a watcher's findings in one place instead of one conversation at a
   * time. It deliberately ignores the delivery ledger - whether a device was reached says nothing
   * about whether the owner has seen it.
   */
  async listAgentNotifications(
    userId: string,
    limit = 50,
    masterKey?: Uint8Array
  ): Promise<
    Array<AgentNotificationRecord & { taskTitle: string | null; message: string | null }>
  > {
    const result = await this.database.query(
      `SELECT n.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM agent_notifications n
       JOIN tasks t ON t.id=n.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(Math.trunc(limit), 200))]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      kind: String(row.kind) as AgentNotificationRecord['kind'],
      messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
      createdAt: iso(row.created_at),
      taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
      message: masterKey ? decryptAgentMessage(row, masterKey) : null
    }));
  }

  /**
   * Everything waiting to be told to a device that has not been told it yet.
   *
   * `masterKey` is optional and buys two things: the conversation's own name, and the sentence an
   * agent-raised notification carries. Both are encrypted with a workspace key, and this is the
   * only layer holding both the envelope and the key to unwrap it - so a notification that can say
   * which conversation it is about is decrypted here rather than by the service that sends it,
   * which has neither. Either one failing to decrypt comes back null and the notification is
   * worded without it.
   */
  async listPendingNotifications(
    limit = 100,
    masterKey?: Uint8Array
  ): Promise<PendingNotificationRecord[]> {
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'approval_required'::text AS kind, a.id AS resource_id, a.task_id,
           NULL::text AS task_status, a.created_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN approvals a ON a.user_id=ps.user_id
          AND a.status='pending' AND a.expires_at>NOW() AND a.created_at>=ps.created_at
         UNION ALL
         -- A conversation the owner started and walked away from is worth a receipt. A scheduled
         -- run is not: it finishes on a timer whether or not anything happened, and pushing that
         -- turns a fifteen-minute watcher into ninety-six identical notifications a day. Those say
         -- nothing unless the agent raises one itself, below - except when the run failed, because
         -- a watcher that has silently stopped watching is exactly what the silence would hide.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'task_finished'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, COALESCE(t.completed_at,t.updated_at) AS event_at,
           NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN tasks t ON t.user_id=ps.user_id
          AND t.status IN ('completed','failed','cancelled')
          AND COALESCE(t.completed_at,t.updated_at)>=ps.created_at
          AND (t.status='failed'
               OR NOT EXISTS (SELECT 1 FROM task_schedule_runs r WHERE r.task_id=t.id))
         UNION ALL
         -- A task the box stopped at a ceiling, which is the one pause nobody chose and which
         -- waits forever if the owner is not told. An ordinary Pause has no spend_paused_at.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'spend_paused'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, t.spend_paused_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN tasks t ON t.user_id=ps.user_id
          AND t.status='paused' AND t.spend_paused_at IS NOT NULL
          AND t.spend_paused_at>=ps.created_at
         UNION ALL
         -- The two the agent raises: something it was asked to watch for, and a wall it cannot get
         -- past on its own. Both carry their own sentence, and both are already the agent's
         -- decision, so nothing here re-derives whether they are worth sending.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           n.kind, n.id AS resource_id, n.task_id,
           NULL::text AS task_status, n.created_at AS event_at, n.message_ciphertext
         FROM push_subscriptions ps
         JOIN agent_notifications n ON n.user_id=ps.user_id AND n.created_at>=ps.created_at
       )
       SELECT c.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM candidates c
       LEFT JOIN notification_deliveries d ON d.subscription_id=c.subscription_id
         AND d.kind=c.kind AND d.resource_id=c.resource_id
       LEFT JOIN tasks t ON t.id=c.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       -- A terminal task stays terminal, so without a horizon every finished conversation is a
       -- candidate forever and the ledger row that stops it firing twice can never be pruned. Past
       -- this age the event has stopped being news anyway.
       WHERE d.subscription_id IS NULL AND c.event_at > NOW() - $2::interval
       -- Ordered by how stopped the work is. An approval and a takeover are both the agent waiting
       -- on a person; a spend pause is the box refusing to spend more; the rest is news. The id is
       -- the final tiebreaker so a page is stable - without it two rows sharing a timestamp swap
       -- places between reads, which looks to a delivering process like a set it has not seen.
       ORDER BY c.event_at,
         CASE c.kind
           WHEN 'approval_required' THEN 0
           WHEN 'takeover_needed' THEN 1
           WHEN 'spend_paused' THEN 2
           WHEN 'agent_message' THEN 3
           ELSE 4
         END,
         c.resource_id
       LIMIT $1`,
      [limit, NOTIFICATION_CANDIDATE_INTERVAL]
    );
    return result.rows.map((row) => ({
      id: String(row.subscription_id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      createdAt: iso(row.subscription_created_at),
      updatedAt: iso(row.subscription_updated_at),
      kind: String(row.kind) as PendingNotificationRecord['kind'],
      resourceId: String(row.resource_id),
      taskId: String(row.task_id),
      taskStatus: optionalText(row.task_status),
      eventAt: iso(row.event_at),
      taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
      message: masterKey ? decryptAgentMessage(row, masterKey) : null
    }));
  }

  /** The kinds this owner still wants, and the window the box may not wake them in. */
  async notificationSettings(userId: string): Promise<StoredNotificationSettings | null> {
    const result = await this.database.query(
      'SELECT * FROM notification_settings WHERE user_id=$1',
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const startMinute = numericOrNull(row.quiet_start_minute);
    const endMinute = numericOrNull(row.quiet_end_minute);
    return {
      kinds: {
        approval_required: row.approval_required !== false,
        task_finished: row.task_finished !== false,
        spend_paused: row.spend_paused !== false,
        agent_message: row.agent_message !== false,
        takeover_needed: row.takeover_needed !== false
      },
      quietHours:
        startMinute === null || endMinute === null
          ? null
          : { startMinute: Math.trunc(startMinute), endMinute: Math.trunc(endMinute) },
      quietHoursAllowApprovals: row.quiet_allow_approvals !== false
    };
  }

  /** Upsert. A null window is how quiet hours are turned off; there is no separate flag. */
  async setNotificationSettings(
    userId: string,
    input: StoredNotificationSettings
  ): Promise<StoredNotificationSettings> {
    await this.database.query(
      `INSERT INTO notification_settings(
         user_id,approval_required,task_finished,spend_paused,agent_message,takeover_needed,
         quiet_start_minute,quiet_end_minute,quiet_allow_approvals,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT(user_id) DO UPDATE SET
         approval_required=EXCLUDED.approval_required,
         task_finished=EXCLUDED.task_finished,
         spend_paused=EXCLUDED.spend_paused,
         agent_message=EXCLUDED.agent_message,
         takeover_needed=EXCLUDED.takeover_needed,
         quiet_start_minute=EXCLUDED.quiet_start_minute,
         quiet_end_minute=EXCLUDED.quiet_end_minute,
         quiet_allow_approvals=EXCLUDED.quiet_allow_approvals,
         updated_at=NOW()`,
      [
        userId,
        input.kinds.approval_required,
        input.kinds.task_finished,
        input.kinds.spend_paused,
        input.kinds.agent_message,
        input.kinds.takeover_needed,
        input.quietHours?.startMinute ?? null,
        input.quietHours?.endMinute ?? null,
        input.quietHoursAllowApprovals
      ]
    );
    return (await this.notificationSettings(userId))!;
  }

  async recordNotificationDelivery(
    subscriptionId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO notification_deliveries(subscription_id,kind,resource_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [subscriptionId, kind, resourceId]
    );
  }

  async cleanupExpired(securityEventRetentionDays = 30, deltaPruneLimit = 10_000): Promise<void> {
    await this.database.query('DELETE FROM auth_challenges WHERE expires_at <= NOW()');
    await this.database.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    await this.database.query(
      "DELETE FROM device_enrollments WHERE created_at < NOW() - INTERVAL '7 days'"
    );
    await this.database.query(
      `DELETE FROM api_tokens
       WHERE expires_at < NOW() - INTERVAL '30 days'
          OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days')`
    );
    await this.database.query('DELETE FROM api_operations WHERE expires_at <= NOW()');
    await this.database.query('DELETE FROM connector_oauth_attempts WHERE expires_at <= NOW()');
    await this.database.query(
      "DELETE FROM security_events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')",
      [securityEventRetentionDays]
    );
    await this.database.query(
      `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()`
    );
    await this.database.query(
      `DELETE FROM workspace_previews
       WHERE expires_at < NOW() - INTERVAL '30 days'
          OR (status='revoked' AND updated_at < NOW() - INTERVAL '30 days')`
    );
    // One row per notification per device, and nothing ever removed them. They exist to stop a
    // message being sent twice, so they are only needed while the thing they settled is still
    // something `listPendingNotifications` would consider.
    await this.database.query(
      'DELETE FROM notification_deliveries WHERE delivered_at < NOW() - $1::interval',
      [NOTIFICATION_LEDGER_INTERVAL]
    );
    // Streaming writes an assistant_delta several times a second, each an encrypted row of its own.
    // The assistant_message that closes the turn holds the final text, which makes every delta
    // before it redundant - but only once the task has stopped, because a live task is still
    // streaming into its own timeline. The writer already drops them as the closing message lands;
    // this catches the turns that ended without one, and the rows written before it did.
    await this.database.query(
      `DELETE FROM task_events WHERE id IN (
         SELECT delta.id FROM task_events delta
         JOIN tasks t ON t.id=delta.task_id
         WHERE delta.kind='assistant_delta'
           AND t.status IN ('completed','failed','cancelled')
           AND EXISTS (
             SELECT 1 FROM task_events final
             WHERE final.task_id=delta.task_id AND final.kind='assistant_message'
               AND final.sequence>delta.sequence
           )
         LIMIT $1
       )`,
      [deltaPruneLimit]
    );
    // Memories that expired long ago are never assembled into context again. The grace period
    // leaves room to notice and undo a wrong expiry date before the row is actually gone.
    await this.database.query(
      `DELETE FROM workspace_memories
       WHERE valid_until IS NOT NULL AND valid_until < NOW() - INTERVAL '90 days'`
    );
  }
}
