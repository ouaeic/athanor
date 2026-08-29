import type { EncryptedEnvelope } from '@athanor/core';
import type {
  AgentNotificationKind,
  ApiTokenScope,
  ConnectorKind,
  ConnectorScope,
  NotificationKind,
  TaskEventKind,
  TaskScheduleSpec
} from '@athanor/contracts';
import type { SecurityMode } from '@athanor/contracts';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  recoveryHash: string | null;
  /**
   * Choices that belong to the owner rather than to whichever browser they are sitting at. Stored
   * as an open object because the set grows; every reader validates the shape it wants and ignores
   * the rest, so a row written by a newer build is readable by an older one.
   */
  preferences: Record<string, unknown>;
  createdAt: string;
}

export interface ManagedProviderCredentialRecord {
  userId: string;
  provider: string;
  secretCiphertext: EncryptedEnvelope;
  externalRef: string;
  monthlyLimitUsd: number;
  status: 'active' | 'disabled' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface PasskeyRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  scopes: ApiTokenScope[];
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  status: string;
  storageBytes: number;
  storageLimitBytes: number;
  imageRevision: string;
  region: string;
  keyProtection: 'hosted';
  securityMode: SecurityMode;
  runnerRef: string | null;
  computeMeteredAt: string | null;
  wrappedKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  workspaceId: string;
  parentTaskId: string | null;
  branchedFromEventId: string | null;
  forkKind: 'branch' | 'edit' | 'retry' | null;
  /**
   * The schedule that minted this task, or null for one the owner started. Provenance rather than a
   * live reference: it outlives the schedule row, because the runs it names are conversations the
   * owner keeps after they turn the schedule off.
   */
  scheduleId: string | null;
  /** How far the fork that created this task reached back. Null for a task nobody rewound into. */
  rewindScope: 'conversation' | 'computer' | 'both' | null;
  restoredCheckpointId: string | null;
  titleCiphertext: EncryptedEnvelope | null;
  legacyTitle: string | null;
  /**
   * Who named this conversation. `prompt` is the placeholder cut from the first words of the
   * request and is the only value the titler is allowed to replace.
   */
  titleSource: 'prompt' | 'generated' | 'owner';
  /** Held above the recency buckets in the sidebar. */
  pinned: boolean;
  /** When the owner filed this conversation away. Null for one still in the sidebar. */
  archivedAt: string | null;
  status: string;
  modelId: string;
  privacyRoute: string;
  securityMode: SecurityMode;
  maxComputeCredits: number;
  actualComputeCredits: number;
  /** Ceiling in real currency. Null means only the account-level caps bound this task. */
  maxSpendUsd: number | null;
  /**
   * Settled provider cost for this task. The owner-facing reads carry it; a row returned by a
   * write or a lease reports zero rather than a number nobody computed.
   */
  spentUsd: number;
  queuedMessageCount: number;
  promptCiphertext: EncryptedEnvelope;
  agentStateCiphertext: EncryptedEnvelope | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCheckpointRecord {
  id: string;
  userId: string;
  workspaceId: string;
  taskId: string | null;
  turn: number;
  /** Highest task-event sequence reached when this was taken; null for a checkpoint outside a task. */
  eventSequence: number | null;
  mechanism: 'btrfs' | 'zfs' | 'content';
  /** Null for a filesystem snapshot, which counts nothing - that is why it is instant. */
  fileCount: number | null;
  totalBytes: number | null;
  storedBytes: number;
  durationMs: number;
  createdAt: string;
}

export interface TaskMessageQueueRecord {
  id: string;
  taskId: string;
  userId: string;
  promptCiphertext: EncryptedEnvelope;
  modelId: string;
  privacyRoute: string;
  maxComputeCredits: number;
  maxSpendUsd: number | null;
  resourceClass: string;
  reservationKey: string;
  /** `undelivered` is a message the conversation stopped for good before it could be started. */
  status: 'queued' | 'promoted' | 'cancelled' | 'undelivered';
  /** The owner wants this applied to the turn already running, not the one after it. */
  interrupt: boolean;
  createdAt: string;
  promotedAt: string | null;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  sequence: number;
  kind: TaskEventKind;
  summary: string;
  payloadCiphertext: EncryptedEnvelope | null;
  createdAt: string;
}

export interface TaskPlanRecord {
  id: string;
  taskId: string;
  version: number;
  parentVersion: number | null;
  branchName: string;
  stepsCiphertext: EncryptedEnvelope;
  createdBy: 'agent' | 'user';
  createdAt: string;
}

export interface WorkspaceMemoryRecord {
  id: string;
  userId: string;
  /** NULL on an owner-tier row, which belongs to the person and to no workspace. */
  workspaceId: string | null;
  target: 'workspace' | 'user';
  /**
   * Which key sealed `contentCiphertext`, in the clear because the reader has to choose a key
   * before it can open anything. `'workspace'` is the workspace data key under
   * `workspace-memory:${workspaceId}`; `'user'` is `userMemoryKey(master, userId)` under
   * `userMemoryAad(userId)`. Rows written before migration 70 are all `'workspace'`, including
   * `target: 'user'` ones, because a migration cannot re-encrypt.
   */
  keyScope: 'workspace' | 'user';
  contentCiphertext: EncryptedEnvelope;
  /**
   * Mirrors the expiry inside the encrypted document. Kept in the clear because retention has to
   * find expired rows without the workspace key, which only a signed-in owner ever holds.
   */
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSkillRecord {
  id: string;
  userId: string;
  workspaceId: string;
  nameHash: string;
  documentCiphertext: EncryptedEnvelope;
  version: number;
  enabled: boolean;
  status: 'active' | 'stale' | 'archived';
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskScheduleRecord {
  id: string;
  userId: string;
  workspaceId: string;
  titleCiphertext: EncryptedEnvelope;
  promptCiphertext: EncryptedEnvelope;
  modelId: string;
  privacyRoute: string;
  maxComputeCredits: number;
  maxSpendUsd: number | null;
  spec: TaskScheduleSpec;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastErrorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRecord {
  id: string;
  userId: string;
  kind: ConnectorKind;
  authMode: 'secret' | 'none' | 'bearer' | 'oauth';
  label: string;
  baseUrl: string;
  scopes: ConnectorScope[];
  secretCiphertext: EncryptedEnvelope;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorOAuthAttemptRecord {
  id: string;
  userId: string;
  label: string;
  baseUrl: string;
  scopes: ConnectorScope[];
  stateHash: string;
  secretCiphertext: EncryptedEnvelope;
  expiresAt: string;
  createdAt: string;
}

export interface ConnectorAuditRecord {
  id: string;
  connectorId: string;
  taskId: string | null;
  operation: string;
  outcome: 'succeeded' | 'failed' | 'denied';
  statusCode: number | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  createdAt: string;
}

export interface WorkspacePreviewRecord {
  id: string;
  userId: string;
  workspaceId: string;
  label: string;
  port: number;
  slug: string;
  accessTokenHash: string;
  /** Where inside the served port the owner should land; null when its root is the app. */
  entryPath: string | null;
  visibility: 'private' | 'public';
  /*
   * There is no `customDomain` here, and there are no `domainStatus` or `domainVerificationHash`
   * beside it. All three were columns on `workspace_previews` from migration 25 that no statement
   * in this repository ever wrote, lifted onto this record and served on every preview response as
   * a null - which reads as "no custom domain is configured" rather than as "this build does not do
   * custom domains". Migration 69 drops the columns, the same way migration 51 dropped
   * `hosting_mode` from this table for the same reason. If custom domains are built, they arrive
   * with a writer, a route and a contract field, not with three fields that were already here.
   */
  status: 'active' | 'revoked';
  expiresAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentNotificationRecord {
  id: string;
  userId: string;
  taskId: string;
  kind: AgentNotificationKind;
  messageCiphertext: EncryptedEnvelope;
  createdAt: string;
}

export interface PendingNotificationRecord extends PushSubscriptionRecord {
  kind: NotificationKind;
  resourceId: string;
  taskId: string;
  taskStatus: string | null;
  /**
   * When the thing being reported happened - the approval was raised, the task reached its final
   * status, the agent asked for the owner. The staleness horizon is measured from this, so it is
   * carried rather than re-derived from whichever row the sender happens to be able to read.
   */
  eventAt: string;
  /**
   * The conversation's own name, decrypted by the data layer because it is the only place holding
   * both the envelope and the workspace key. Null when the caller asked for pending work without
   * supplying a master key, or when this particular title could not be read.
   */
  taskTitle: string | null;
  /**
   * What the agent asked to have said, decrypted alongside the title and for the same reason. Null
   * for every kind the server derives rather than the agent raising, which carry no sentence of
   * their own.
   */
  message: string | null;
}

export interface SpendLimitsRecord {
  userId: string;
  dailyCapUsd: number | null;
  monthlyCapUsd: number | null;
  defaultTaskCapUsd: number | null;
  warnAtPercent: number;
  timeZone: string;
  /**
   * The owner's price ceiling, as two published rates. The caps above stop a task that is already
   * spending; these stop an over-priced route being chosen at all. Null is "no ceiling" and zero is
   * "only a route that publishes no charge", and they are different states.
   */
  maxInputUsdPerMillionTokens: number | null;
  maxOutputUsdPerMillionTokens: number | null;
  updatedAt: string;
}

export interface SpendAlertRecord {
  userId: string;
  windowName: 'daily' | 'monthly';
  windowStart: string;
  level: 'warning' | 'exceeded';
  spentUsd: number;
  capUsd: number;
  createdAt: string;
}

/**
 * A creative-media job as the API reads it back: what was asked for, what came of it, and - when
 * the workspace key was unavailable at the moment it failed - the code that is all the reason there
 * is. The prompt and the generated paths arrive sealed, because only the caller holding the
 * workspace key can open them, and the owner's list is the one place a generation the agent started
 * on its own is ever described.
 */
