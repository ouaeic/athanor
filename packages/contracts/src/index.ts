import { z } from 'zod';

/**
 * Which computer answers a web search, and what that discloses to whom. It lives in its own file
 * because the API, the worker, the gateway and the web client all have to reach the same verdict
 * from the same facts, and a second opinion anywhere is a privacy failure rather than a bug.
 */
export * from './web-tools.js';

export const Id = z.string().uuid();
export const IsoDate = z.string().datetime();

export const WORKSPACE_STORAGE_GB_BYTES = 1_000_000_000;
export const MIN_WORKSPACE_STORAGE_BYTES = 10 * WORKSPACE_STORAGE_GB_BYTES;
export const MAX_WORKSPACE_STORAGE_BYTES = 100_000 * WORKSPACE_STORAGE_GB_BYTES;

export const WorkspaceStatus = z.enum([
  'provisioning',
  'running',
  'hibernated',
  'resizing',
  'failed',
  'deleting'
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const PrivacyRoute = z.enum(['provider_zdr', 'external']);
export type PrivacyRoute = z.infer<typeof PrivacyRoute>;

export const SecurityMode = z.enum(['review', 'balanced', 'autonomous']);
export type SecurityMode = z.infer<typeof SecurityMode>;

/** Where the soft spend threshold sits when the owner has never moved it. */
export const DEFAULT_SPEND_WARN_PERCENT = 80;
export const MAX_SPEND_CAP_USD = 1_000_000;
export const MAX_TASK_SPEND_USD = 10_000;

const CapUsd = z.number().nonnegative().max(MAX_SPEND_CAP_USD);
const TaskSpendUsd = z.number().positive().max(MAX_TASK_SPEND_USD);

export const Workspace = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  status: WorkspaceStatus,
  storageBytes: z.number().int().nonnegative(),
  storageLimitBytes: z.number().int().positive(),
  hostStorageTotalBytes: z.number().int().positive().optional(),
  hostStorageAvailableBytes: z.number().int().nonnegative().optional(),
  imageRevision: z.string(),
  region: z.string(),
  /**
   * How the workspace data key is held. One value, because one mechanism exists: the key is
   * unwrapped by this server with the master key on its own disk. An 'attested' arm was declared
   * alongside a hardware key-release receipt table that has since been dropped, and nothing ever
   * produced it - a second value here would be a promise about where a key lives that no code keeps.
   */
  keyProtection: z.literal('hosted').default('hosted'),
  securityMode: SecurityMode.default('balanced'),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceSnapshotStatus = z.enum(['creating', 'ready', 'failed', 'deleting']);
export const WorkspaceSnapshot = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(80),
  status: WorkspaceSnapshotStatus,
  sizeBytes: z.number().int().nonnegative(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;

/**
 * How a turn checkpoint was taken. `content` is the portable one and works on any filesystem; the
 * other two are instant because the filesystem itself does the work. The owner never picks this -
 * the runner establishes what the host can do by doing it - but a restore preview says which was
 * used, because it is the difference between "this is exact" and "this is what was covered".
 */
export const WorkspaceCheckpointMechanism = z.enum(['btrfs', 'zfs', 'content']);
export type WorkspaceCheckpointMechanism = z.infer<typeof WorkspaceCheckpointMechanism>;

/**
 * A point the computer can be put back to, taken automatically before the first turn of work that
 * could change anything. Distinct from a WorkspaceSnapshot: those are named recovery points the
 * owner asks for and keeps, these are cheap, numerous and pruned.
 */
export const WorkspaceCheckpoint = z.object({
  id: Id,
  workspaceId: Id,
  taskId: Id.nullable(),
  /** Which turn of that task this checkpoint sits in front of. */
  turn: z.number().int().nonnegative(),
  /**
   * The timeline position this checkpoint sits at: the highest event sequence the task had reached
   * when it was taken. This is what lets "rewind to here" in the transcript find the right one.
   */
  eventSequence: z.number().int().nonnegative().nullable(),
  mechanism: WorkspaceCheckpointMechanism,
  /** Null for a filesystem snapshot, which is instant precisely because it counts nothing. */
  fileCount: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  /** What this checkpoint cost on disk. Zero when the turn changed nothing. */
  storedBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  createdAt: IsoDate
});
export type WorkspaceCheckpoint = z.infer<typeof WorkspaceCheckpoint>;

export const CheckpointFileChange = z.object({
  path: z.string(),
  /** The size this file would have after a restore. */
  sizeBytes: z.number().int().nonnegative(),
  /** Its size right now, when it exists in both and differs. */
  currentSizeBytes: z.number().int().nonnegative().optional()
});
export type CheckpointFileChange = z.infer<typeof CheckpointFileChange>;

export const CheckpointPackageChange = z.object({
  name: z.string(),
  version: z.string(),
  previousVersion: z.string().optional()
});
export type CheckpointPackageChange = z.infer<typeof CheckpointPackageChange>;

/**
 * What rewinding the computer to a checkpoint would do, before it does it.
 *
 * `added` disappears, `modified` goes back, `deleted` returns. `packagesInstalled` is the honest
 * part: a rewind does not uninstall anything, so those stay, and the owner should be told rather
 * than left to discover it. Lists are capped; the counts are always the true totals.
 */
export const CheckpointRestorePreview = z.object({
  id: Id,
  mechanism: WorkspaceCheckpointMechanism,
  createdAt: IsoDate,
  added: z.array(CheckpointFileChange),
  modified: z.array(CheckpointFileChange),
  deleted: z.array(CheckpointFileChange),
  addedCount: z.number().int().nonnegative(),
  modifiedCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  restoredBytes: z.number().int().nonnegative(),
  removedBytes: z.number().int().nonnegative(),
  packagesInstalled: z.array(CheckpointPackageChange),
  packagesRemoved: z.array(CheckpointPackageChange),
  /** Files too large for a checkpoint to hold, which a rewind therefore leaves exactly as they are. */
  uncovered: z.array(CheckpointFileChange),
  truncated: z.boolean()
});
export type CheckpointRestorePreview = z.infer<typeof CheckpointRestorePreview>;

/**
 * How far back a rewind reaches.
 *
 * The conversation and the computer are two different things and always have been: editing a
 * message has never restored a file. Naming the choice is what stops an owner believing they undid
 * something they did not.
 */
export const RewindScope = z.enum(['conversation', 'computer', 'both']);
export type RewindScope = z.infer<typeof RewindScope>;

export const TaskStatus = z.enum([
  'draft',
  'queued',
  'planning',
  'running',
  'awaiting_user',
  'awaiting_resource',
  'paused',
  'completed',
  'failed',
  'cancelled'
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const SideEffectLevel = z.enum([
  'read',
  'workspace_write',
  'external_reversible',
  'external_consequential'
]);
export type SideEffectLevel = z.infer<typeof SideEffectLevel>;

export const ConnectorKind = z.enum(['github', 'webdav', 'mcp_http', 'imap', 'caldav']);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const ConnectorScope = z.enum([
  'github:profile.read',
  'github:repository.read',
  'github:issues.read',
  'github:issues.write',
  'github:pull_requests.write',
  'webdav:files.read',
  'webdav:files.write',
  'webdav:files.delete',
  'mcp:tools.read',
  'mcp:tools.execute',
  'mail:mailbox.read',
  'mail:message.write',
  'mail:message.send',
  'calendar:calendars.read',
  'calendar:events.write'
]);
export type ConnectorScope = z.infer<typeof ConnectorScope>;

export const Connector = z.object({
  id: Id,
  kind: ConnectorKind,
  authMode: z.enum(['secret', 'none', 'bearer', 'oauth']),
  label: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  scopes: z.array(ConnectorScope),
  enabled: z.boolean(),
  lastUsedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Connector = z.infer<typeof Connector>;

export const ConnectorAuditEvent = z.object({
  id: Id,
  connectorId: Id,
  taskId: Id.nullable(),
  operation: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'denied']),
  statusCode: z.number().int().nullable(),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  createdAt: IsoDate
});
export type ConnectorAuditEvent = z.infer<typeof ConnectorAuditEvent>;

/**
 * What POST /v1/connectors/:id/test found when it asked the account whether it still works.
 *
 * A credential is verified once, when the account is added, and then trusted until something uses
 * it. Passwords change, servers move and authorizations expire, so this is the answer to "is this
 * still good", asked deliberately rather than discovered by a task that failed.
 *
 * `ok: false` is a successful reply to that question, not a failed request, so it arrives with the
 * reason attached: the code names it for a client, the message is what the far end actually said.
 */
export const ConnectorTestResult = z.object({
  connectorId: Id,
  ok: z.boolean(),
  /** What the account called itself: a mail address, a GitHub login, an MCP server name. */
  accountLabel: z.string().nullable(),
  checkedAt: IsoDate,
  failure: z.object({ code: z.string(), message: z.string() }).nullable()
});
export type ConnectorTestResult = z.infer<typeof ConnectorTestResult>;

export const CreateConnectorRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('github'),
    label: z.string().min(1).max(80),
    token: z.string().min(1).max(4096),
    scopes: z.array(ConnectorScope).min(1)
  }),
  z.object({
    kind: z.literal('webdav'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    scopes: z.array(ConnectorScope).min(1)
  }),
  z.object({
    kind: z.literal('mcp_http'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    token: z.string().max(4096).optional(),
    scopes: z.array(ConnectorScope).min(1)
  }),
  /**
   * A mailbox is two endpoints, not one: mail arrives over IMAP and leaves over SMTP submission,
   * and on most providers they are different hosts. `baseUrl` carries the reading half as
   * `imaps://mail.example.com:993` - a URL rather than a bare host so it goes through the same
   * parsing every other connector address does - and the sending half is named separately because
   * there is nowhere in a URL to put a second host and port honestly.
   *
   * `fromAddress` is the address mail is sent as, which is also the identity matched against an
   * invitation's attendee list; it is asked for rather than derived from the username because a
   * username is frequently not an address.
   */
  z.object({
    kind: z.literal('imap'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    fromAddress: z.string().email().max(320),
    fromName: z.string().min(1).max(200).optional(),
    smtpHost: z.string().min(1).max(255),
    smtpPort: z.number().int().min(1).max(65_535).default(465),
    scopes: z.array(ConnectorScope).min(1)
  }),
  /**
   * `address` is the address other people invite the owner by. It is what tells athanor which
   * attendee on an event is the owner, so answering an invitation changes the right line.
   */
  z.object({
    kind: z.literal('caldav'),
    label: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    username: z.string().min(1).max(512),
    password: z.string().min(1).max(4096),
    address: z.string().email().max(320),
    scopes: z.array(ConnectorScope).min(1)
  })
]);
export type CreateConnectorRequest = z.input<typeof CreateConnectorRequest>;

const McpOAuthBase = z.object({
  label: z.string().min(1).max(80),
  baseUrl: z.string().url().max(2048),
  scopes: z.array(ConnectorScope).min(1),
  oauthScopes: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9:._/-]+$/)
    )
    .max(32)
    .default([])
});

export const StartMcpOAuthRequest = z.discriminatedUnion('registration', [
  McpOAuthBase.extend({
    registration: z.literal('dynamic')
  }),
  McpOAuthBase.extend({
    registration: z.literal('static'),
    clientId: z.string().min(1).max(2048),
    clientSecret: z.string().min(1).max(4096).optional()
  })
]);
export type StartMcpOAuthRequest = z.infer<typeof StartMcpOAuthRequest>;

export const StartMcpOAuthResponse = z.object({
  authorizationUrl: z.string().url(),
  authorizationHost: z.string().min(1),
  expiresAt: IsoDate
});
export type StartMcpOAuthResponse = z.infer<typeof StartMcpOAuthResponse>;

/**
 * How long a private preview survives without being opened.
 *
 * A private preview does not expire on a clock: the owner's own app on the owner's own computer
 * should still answer their phone next month, and a link that dies overnight forces the choice
 * between re-publishing every day and putting the app on the public internet. What bounds it
 * instead is use. The access token travels in a URL, so a link nobody has opened in a month is a
 * bearer credential sitting in a chat history for no reason; every visit pushes the deadline back
 * out to this window, so a preview the owner actually uses never lapses and one they have
 * forgotten closes itself.
 */
export const PREVIEW_IDLE_EXPIRY_DAYS = 30;

/** How many live previews one computer may hold at once, so a loop cannot exhaust its ports. */
export const MAX_WORKSPACE_PREVIEWS = 100;

export const WorkspacePreview = z.object({
  id: Id,
  workspaceId: Id,
  label: z.string().min(1).max(80),
  port: z.number().int().min(1024).max(65_535),
  visibility: z.enum(['private', 'public']),
  status: z.enum(['active', 'revoked', 'expired']),
  url: z.string().url(),
  /**
   * When this link stops answering if nothing opens it before then, refreshed by every visit.
   * Null for a published public site, which stays up until it is unpublished or revoked.
   */
  expiresAt: IsoDate.nullable(),
  lastAccessedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type WorkspacePreview = z.infer<typeof WorkspacePreview>;

export const CreateWorkspacePreviewRequest = z.object({
  label: z.string().min(1).max(80),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65_535)
    .refine((port) => port !== 4300),
  /*
   * Where inside the served port the owner lands.
   *
   * Absolute and relative to the port, never to a host: a value carrying a scheme, a host or a
   * `..` segment is refused rather than cleaned up, because the only thing it could be doing is
   * pointing the link somewhere the preview is not.
   */
  entryPath: z
    .string()
    .max(300)
    .transform((value) => value.trim())
    .refine(
      (value) =>
        value === '' ||
        (!/^[a-z][a-z0-9+.-]*:/i.test(value) &&
          !value.startsWith('//') &&
          !value.split(/[/\\]/).includes('..')),
      'entryPath cannot leave the preview'
    )
    .optional()
});
export type CreateWorkspacePreviewRequest = z.input<typeof CreateWorkspacePreviewRequest>;

/**
 * Publishing is a one-way door, not a lease: the owner asked for an address other people can
 * reach, and a public site that vanished on its own schedule would be a broken link to everyone
 * they gave it to. It stays up until they unpublish or revoke it, which is also the only pair of
 * actions that can end it.
 */
export const PublishWorkspacePreviewRequest = z.object({
  confirmPublic: z.literal(true)
});
export type PublishWorkspacePreviewRequest = z.input<typeof PublishWorkspacePreviewRequest>;

export const SetWorkspacePreviewDomainRequest = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(4)
    .max(253)
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
});
export type SetWorkspacePreviewDomainRequest = z.input<typeof SetWorkspacePreviewDomainRequest>;

export const Task = z.object({
  id: Id,
  workspaceId: Id,
  parentTaskId: Id.nullable().optional(),
  branchedFromEventId: Id.nullable().optional(),
  forkKind: z.enum(['branch', 'edit', 'retry']).nullable().optional(),
  /**
   * The schedule that minted this conversation, or null for one the owner started.
   *
   * Nothing on a materialised run recorded where it came from, so a watcher firing every fifteen
   * minutes put ninety-six conversations a day into the same recency order as the owner's own work
   * and buried it. This is the fact that lets a client collapse them: it is provenance, not a live
   * reference, and it stays true after the schedule itself is deleted.
   */
  scheduleId: Id.nullable().default(null),
  title: z.string().min(1).max(160),
  status: TaskStatus,
  modelId: z.string(),
  privacyRoute: PrivacyRoute,
  securityMode: SecurityMode.default('balanced'),
  maxComputeCredits: z.number().nonnegative(),
  actualComputeCredits: z.number().nonnegative(),
  /** The task's own ceiling in real currency. Null when only the account-level caps apply. */
  maxSpendUsd: z.number().positive().nullable().default(null),
  /** Settled provider cost for this task so far. */
  spentUsd: z.number().nonnegative().default(0),
  queuedMessageCount: z.number().int().nonnegative().default(0),
  /** How far the fork that created this task reached back. Null for a task nobody rewound into. */
  rewind: RewindScope.nullable().default(null),
  /** The checkpoint the computer was put back to, when this fork rewound it. */
  restoredCheckpointId: Id.nullable().default(null),
  /** Held above the recency buckets in the sidebar. */
  pinned: z.boolean().default(false),
  /** When the owner filed this conversation away. Null for one still in the sidebar. */
  archivedAt: IsoDate.nullable().default(null),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type Task = z.infer<typeof Task>;

/**
 * One page of the conversation list, newest activity first with pinned conversations above it.
 *
 * `nextCursor` is opaque and encodes a position in that order rather than a row count, so a
 * conversation answered while the owner is reading page three neither duplicates nor disappears.
 */
export const TaskPage = z.object({
  tasks: z.array(Task),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
});
export type TaskPage = z.infer<typeof TaskPage>;

export const TaskPageQuery = z.object({
  workspaceId: Id.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Archived conversations are out of the way by default, and reachable by asking for them. */
  include: z.enum(['active', 'archived', 'all']).default('active')
});
export type TaskPageQuery = z.input<typeof TaskPageQuery>;

/**
 * Renaming, pinning and archiving a conversation. Every field is optional and at least one is
 * required, so a request that would change nothing is refused rather than silently accepted.
 */
export const UpdateTaskRequest = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
  })
  .refine(
    (input) =>
      input.title !== undefined || input.pinned !== undefined || input.archived !== undefined,
    { message: 'Name, pin or archive the conversation' }
  );
export type UpdateTaskRequest = z.input<typeof UpdateTaskRequest>;

export const BranchTaskRequest = z.object({
  eventId: Id.optional()
});
export type BranchTaskRequest = z.input<typeof BranchTaskRequest>;

/**
 * Rewinding the computer as well as the conversation.
 *
 * `conversation` is the historical behaviour and stays the default: a new path through the chat,
 * with the machine exactly as the agent left it. `computer` and `both` put the workspace back to a
 * checkpoint - named explicitly, because an implicit "nearest" would be a rewind the owner did not
 * choose. Omitting it with scope `computer` or `both` means the caller wants the checkpoint that
 * covers the chosen event, which the server resolves and reports back.
 */
const RewindChoice = {
  rewind: RewindScope.default('conversation'),
  checkpointId: Id.optional()
};

/**
 * Which model the new path runs on. Omitted means the one the source task used, which is what a
 * fork has always done - naming one is how "that answer was weak, try the stronger model" happens
 * without retyping the request. The privacy route travels with it because a model belongs to a
 * route, and a route the account does not allow is refused rather than quietly downgraded.
 */
const TrajectoryModelChoice = {
  modelId: z.string().min(1).max(200).optional(),
  privacyRoute: PrivacyRoute.optional()
};

export const TaskTrajectoryRequest = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('branch'),
    eventId: Id,
    ...RewindChoice,
    ...TrajectoryModelChoice
  }),
  z.object({
    operation: z.literal('edit'),
    eventId: Id,
    prompt: z.string().trim().min(1).max(200_000),
    maxComputeCredits: z.number().min(0.01).max(10_000).default(5),
    maxSpendUsd: TaskSpendUsd.optional(),
    stopSource: z.boolean().default(true),
    ...RewindChoice,
    ...TrajectoryModelChoice
  }),
  z.object({
    operation: z.literal('retry'),
    eventId: Id,
    maxComputeCredits: z.number().min(0.01).max(10_000).default(5),
    maxSpendUsd: TaskSpendUsd.optional(),
    stopSource: z.boolean().default(true),
    ...RewindChoice,
    ...TrajectoryModelChoice
  })
]);
export type TaskTrajectoryRequest = z.input<typeof TaskTrajectoryRequest>;

/**
 * Everything the owner needs to see before confirming a rewind: how much conversation goes, which
 * checkpoint the computer would go back to, and what that would do to their files.
 *
 * `checkpoint` is null when no checkpoint covers the chosen point - a turn that only read, or one
 * old enough to have been pruned. That is not an error; it is the answer, and it is the difference
 * between offering a three-way choice and offering a choice that would quietly do nothing.
 */
export const TaskRewindPreview = z.object({
  taskId: Id,
  eventId: Id,
  /** Conversation events after the chosen one, which a conversation rewind leaves behind. */
  droppedEventCount: z.number().int().nonnegative(),
  checkpoint: WorkspaceCheckpoint.nullable(),
  computer: CheckpointRestorePreview.nullable()
});
export type TaskRewindPreview = z.infer<typeof TaskRewindPreview>;

export const UpdateSecurityModeRequest = z.object({ securityMode: SecurityMode });
export type UpdateSecurityModeRequest = z.input<typeof UpdateSecurityModeRequest>;

export const TaskEventKind = z.enum([
  'task_created',
  'user_message',
  'queued_message',
  'plan',
  'status',
  'assistant_delta',
  /**
   * The model's reasoning as it arrives, when the route produces any.
   *
   * Separate from `assistant_delta` because it is a different thing to read: it is how the answer
   * was reached rather than the answer, it is often much longer, and it should be foldable. On a
   * long step the alternative is a spinner - the model has been thinking for forty seconds and the
   * owner has been given no reason to believe anything is happening.
   */
  'assistant_reasoning',
  'assistant_message',
  'tool_started',
  'tool_result',
  'preview',
  'artifact',
  'approval_requested',
  'approval_resolved',
  /**
   * The agent stopped and put a question to the owner.
   *
   * Its own kind rather than an approval, because the two are different acts and were being drawn
   * as one: a blocker used to come back as a `finish` with a `not_applicable` verification, which
   * lands as a completion card indistinguishable from finished work. An approval asks permission for
   * something the agent is about to do and is answered yes or no; this asks for a decision the agent
   * cannot make and is answered in words, or by picking one of the options it listed.
   */
  'question_asked',
  'cost',
  /** Something the agent decided the owner should be told at that moment, not on their next visit. */
  'notice',
  'warning',
  'error',
  'completed'
]);
export type TaskEventKind = z.infer<typeof TaskEventKind>;

export const TaskEvent = z.object({
  id: Id,
  taskId: Id,
  sequence: z.number().int().positive(),
  kind: TaskEventKind,
  summary: z.string().max(500),
  payload: z.unknown().optional(),
  createdAt: IsoDate
});
export type TaskEvent = z.infer<typeof TaskEvent>;

/**
 * How much of a trajectory to read. Naming nothing still means the whole of it, which is what an
 * export needs; a reader opening a long conversation names a limit and gets the newest page.
 */
export const TaskEventWindowQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional()
});
export type TaskEventWindowQuery = z.input<typeof TaskEventWindowQuery>;

export const TaskPlanStep = z.object({
  id: Id,
  title: z.string().trim().min(1).max(240),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).default('pending')
});
export type TaskPlanStep = z.infer<typeof TaskPlanStep>;

export const TaskPlan = z.object({
  id: Id,
  taskId: Id,
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().nullable(),
  branchName: z.string().min(1).max(80),
  steps: z.array(TaskPlanStep).min(1).max(30),
  createdBy: z.enum(['agent', 'user']),
  createdAt: IsoDate
});
export type TaskPlan = z.infer<typeof TaskPlan>;

export const UpdateTaskPlanRequest = z.object({
  expectedVersion: z.number().int().nonnegative(),
  parentVersion: z.number().int().positive().optional(),
  branchName: z.string().trim().min(1).max(80).default('Main'),
  steps: z
    .array(
      z.object({
        id: Id.optional(),
        title: z.string().trim().min(1).max(240),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).default('pending')
      })
    )
    .min(1)
    .max(30)
});
export type UpdateTaskPlanRequest = z.input<typeof UpdateTaskPlanRequest>;

export const Artifact = z.object({
  id: Id,
  workspaceId: Id,
  taskId: Id.nullable(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  sha256: z.string(),
  createdAt: IsoDate
});
export type Artifact = z.infer<typeof Artifact>;

export const ModelAvailability = z.enum(['available', 'degraded', 'unavailable', 'review']);
export const ModelOpenness = z.enum([
  'osaid_open_source',
  'permissive_open_weight',
  'restricted_open_weight',
  'remote_proprietary'
]);

export const ModelRelease = z.object({
  id: z.string(),
  providerModelId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  revision: z.string(),
  availability: ModelAvailability,
  openness: ModelOpenness,
  license: z.string(),
  commercialUse: z.boolean(),
  privacyRoute: PrivacyRoute,
  contextTokens: z.number().int().positive(),
  modalities: z.array(z.enum(['text', 'image', 'audio', 'video'])),
  capabilities: z.array(z.enum(['chat', 'vision', 'tools', 'reasoning', 'embedding'])),
  usageClass: z.enum(['light', 'medium', 'high', 'extra_high']),
  recommendationTags: z.array(z.string()),
  measuredQuality: z.number().min(0).max(1).nullable(),
  agenticQuality: z.number().min(0).max(1).nullable().optional(),
  codingQuality: z.number().min(0).max(1).nullable().optional(),
  intelligenceQuality: z.number().min(0).max(1).nullable().optional(),
  measuredLatencyMs: z.number().nonnegative().nullable(),
  inputUsdPerMillionTokens: z.number().nonnegative().nullable().optional(),
  outputUsdPerMillionTokens: z.number().nonnegative().nullable().optional(),
  benchmarkRank: z.number().positive().nullable().optional(),
  benchmarkSource: z.string().nullable().optional(),
  benchmarkUpdatedAt: IsoDate.nullable().optional(),
  /** Whether at least one live provider endpoint currently serves this reviewed model. */
  providerAvailable: z.boolean().optional(),
  /** Whether at least one live endpoint also satisfies the provider's zero-retention contract. */
  zeroDataRetentionAvailable: z.boolean().optional(),
  updatedAt: IsoDate
});
export type ModelRelease = z.infer<typeof ModelRelease>;

export const Approval = z.object({
  id: Id,
  taskId: Id,
  action: z.string(),
  origin: z.string().nullable(),
  sideEffect: SideEffectLevel,
  preview: z.string(),
  previewHash: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  expiresAt: IsoDate,
  createdAt: IsoDate
});
export type Approval = z.infer<typeof Approval>;

/**
 * What a push to the owner's devices is about.
 *
 * The first three are derived by the server from state it can already see: an approval is pending,
 * a conversation reached a terminal status, a task stopped at a spending ceiling. Nothing decides
 * to send them, which is why a fifteen-minute watcher used to push "finished" ninety-six times a
 * day without ever saying whether anything had changed.
 *
 * The last two are raised by the agent, and they are the two moments only the agent knows about.
 * `agent_message` is the one it chose to send - the page moved, the build went red, the thing the
 * owner asked to be told about happened. `takeover_needed` is the agent stopped at something no
 * amount of retrying will clear, a bot check being the case that matters, where the work resumes
 * the moment a person takes the screen.
 */
export const NotificationKind = z.enum([
  'approval_required',
  'task_finished',
  'spend_paused',
  'agent_message',
  'takeover_needed'
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds the agent raises for itself. Nothing else may write a row of these. */
export const AgentNotificationKind = z.enum(['agent_message', 'takeover_needed']);
export type AgentNotificationKind = z.infer<typeof AgentNotificationKind>;

/**
 * One thing the agent chose to tell the owner, read back later.
 *
 * A push is a moment: it fires once, on whichever devices were subscribed, and is gone. This is
 * the record of what was said, across every conversation, for the owner who was asleep or whose
 * phone was off - which is the only place several days of a watcher's findings sit together.
 *
 * `message` always carries a sentence. When the workspace key cannot unwrap the one the agent
 * wrote, the server says so in the field rather than serving null: a null message is a row that
 * means nothing, and a client with nothing to render drops it - so the one row that says a
 * conversation has become unreadable is the row that would disappear. `taskTitle` is null in the
 * same case, because there is no honest stand-in for a name.
 */
export const AgentNotification = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string().nullable(),
  kind: AgentNotificationKind,
  message: z.string().min(1),
  createdAt: IsoDate
});
export type AgentNotification = z.infer<typeof AgentNotification>;

/**
 * How many notifications one conversation may raise. A scheduled watcher gets a fresh task per
 * run, so this is generous for honest use and still bounds a loop that decides everything is
 * urgent - the failure the derived `task_finished` push had no way to stop.
 */
export const MAX_AGENT_NOTIFICATIONS_PER_TASK = 10;

export const ProviderSpendWindow = z.object({
  /** Settled provider cost inside the window, in the currency the provider bills. */
  used: z.number().nonnegative(),
  resetsAt: IsoDate
});

/**
 * What the owner's provider has actually charged, over the three periods the usage pane draws.
 *
 * There is no allowance here and no ceiling: the owner holds the account and pays the provider
 * directly, so the only limits that exist are the ones they set themselves, and those live on the
 * spend summary next to the caps they are measured against.
 */
export const ProviderSpend = z.object({
  windows: z.object({
    daily: ProviderSpendWindow,
    weekly: ProviderSpendWindow,
    monthly: ProviderSpendWindow
  })
});
export type ProviderSpend = z.infer<typeof ProviderSpend>;

/**
 * What this box has spent and stored so far this month.
 *
 * Credits are a scheduling unit: they price one task against another on the same machine. They
 * carried an "included" allowance and an overage limit until the last of the hosted shape came
 * out - both were fixed sentinels standing in for a plan nobody sells, and a ceiling that cannot
 * be reached is worse than no ceiling, because it reads like one. What actually stops a runaway is
 * the owner's own spend cap, in the currency the provider bills, on the spend summary.
 */
export const UsageSummary = z.object({
  periodStart: IsoDate,
  periodEnd: IsoDate,
  consumedCredits: z.number().nonnegative(),
  reservedCredits: z.number().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  storageLimitBytes: z.number().int().positive(),
  providerSpend: ProviderSpend
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/**
 * Every ceiling below is denominated in the currency the provider actually bills. A compute credit
 * is a scheduling unit whose dollar value moves with the model class, so it can never answer "stop
 * before this costs me more than X"; these fields exist so that question has one answer.
 */
export const SpendWindowName = z.enum(['task', 'daily', 'monthly']);
export type SpendWindowName = z.infer<typeof SpendWindowName>;

export const SpendWindowState = z.enum(['ok', 'warning', 'exceeded']);
export type SpendWindowState = z.infer<typeof SpendWindowState>;

export const SpendWindow = z.object({
  name: SpendWindowName,
  /** Money the provider has already billed. Never inflated by anything still in flight. */
  spentUsd: z.number().nonnegative(),
  /** Unspent headroom already promised to work that is open but not finished. */
  pendingUsd: z.number().nonnegative(),
  /** Null means the owner has set no ceiling of this kind, so the window can only ever report. */
  capUsd: z.number().nonnegative().nullable(),
  /** The soft threshold as an amount rather than a percentage, so a client never re-derives it. */
  warnAtUsd: z.number().nonnegative().nullable(),
  /** spent + pending + the estimate this decision was asked about. */
  projectedUsd: z.number().nonnegative(),
  state: SpendWindowState,
  /** Null on the task window, which is bounded by the task rather than by wall-clock time. */
  startsAt: IsoDate.nullable(),
  endsAt: IsoDate.nullable()
});
export type SpendWindow = z.infer<typeof SpendWindow>;

export const SpendDecision = z.object({
  outcome: z.enum(['allow', 'warn', 'deny']),
  estimateUsd: z.number().nonnegative(),
  blockedBy: SpendWindowName.nullable(),
  warnedBy: z.array(SpendWindowName),
  reason: z.string().nullable(),
  windows: z.array(SpendWindow)
});
export type SpendDecision = z.infer<typeof SpendDecision>;

export const SpendLimits = z.object({
  dailyCapUsd: CapUsd.nullable(),
  monthlyCapUsd: CapUsd.nullable(),
  /** Applied to a task that does not name its own ceiling, including every scheduled run. */
  defaultTaskCapUsd: TaskSpendUsd.nullable(),
  warnAtPercent: z.number().int().min(1).max(99),
  /** The IANA zone the daily and monthly windows roll over in, so "today" means the owner's day. */
  timeZone: z.string().min(1).max(100),
  updatedAt: IsoDate
});
export type SpendLimits = z.infer<typeof SpendLimits>;

export const UpdateSpendLimitsRequest = z.object({
  dailyCapUsd: CapUsd.nullable().optional(),
  monthlyCapUsd: CapUsd.nullable().optional(),
  defaultTaskCapUsd: TaskSpendUsd.nullable().optional(),
  warnAtPercent: z.number().int().min(1).max(99).optional(),
  timeZone: z.string().min(1).max(100).optional()
});
export type UpdateSpendLimitsRequest = z.input<typeof UpdateSpendLimitsRequest>;

export const SpendBucket = z.object({
  key: z.string(),
  costUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative()
});
export type SpendBucket = z.infer<typeof SpendBucket>;

export const SpendSummary = z.object({
  limits: SpendLimits,
  windows: z.array(SpendWindow),
  /** One entry per calendar day in the owner's zone, oldest first, gaps omitted. */
  byDay: z.array(SpendBucket),
  /** Keyed by the model the provider actually billed for, heaviest first. */
  byModel: z.array(SpendBucket),
  /** Keyed by task id, heaviest first: the answer to "what burned the money". */
  byTask: z.array(SpendBucket)
});
export type SpendSummary = z.infer<typeof SpendSummary>;

export const CreateWorkspaceRequest = z.object({
  name: z.string().min(1).max(80),
  storageLimitBytes: z
    .number()
    .int()
    .min(MIN_WORKSPACE_STORAGE_BYTES)
    .max(MAX_WORKSPACE_STORAGE_BYTES)
    .default(50 * WORKSPACE_STORAGE_GB_BYTES),
  region: z.string().default('local'),
  securityMode: SecurityMode.default('balanced')
});
export type CreateWorkspaceRequest = z.input<typeof CreateWorkspaceRequest>;

/**
 * Workspace-relative paths of files the owner attached to this message.
 *
 * They are carried beside the sentence rather than appended to it: an attachment is context for
 * the turn, not something the owner wrote, and a transcript that says what they typed is the only
 * one that can be read back to them honestly.
 */
export const MessageAttachments = z.array(z.string().trim().min(1).max(400)).max(20);
export type MessageAttachments = z.infer<typeof MessageAttachments>;

export const CreateTaskRequest = z.object({
  workspaceId: Id,
  prompt: z.string().min(1).max(200_000),
  title: z.string().min(1).max(160).optional(),
  modelId: z.string().optional(),
  privacyRoute: PrivacyRoute.default('provider_zdr'),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  /** Omitted means "use the account default", not "unlimited". */
  maxSpendUsd: TaskSpendUsd.optional(),
  attachments: MessageAttachments.optional()
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const ContinueTaskRequest = z.object({
  prompt: z.string().trim().min(1).max(200_000),
  modelId: z.string().optional(),
  privacyRoute: PrivacyRoute.optional(),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  maxSpendUsd: TaskSpendUsd.optional(),
  attachments: MessageAttachments.optional(),
  /**
   * Apply this to the turn already running instead of the one after it. Off by default: a
   * follow-up and a correction are different intentions, and deciding between them from the fact
   * that the task happens to be busy would get it wrong in one direction or the other.
   */
  interrupt: z.boolean().optional()
});
export type ContinueTaskRequest = z.input<typeof ContinueTaskRequest>;

export const TaskScheduleSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: IsoDate
  }),
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(15).max(10_080)
  }),
  z.object({
    kind: z.literal('daily'),
    timeZone: z.string().min(1).max(100),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  }),
  z.object({
    kind: z.literal('weekly'),
    timeZone: z.string().min(1).max(100),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
  }),
  z.object({
    kind: z.literal('cron'),
    timeZone: z.string().min(1).max(100),
    expression: z
      .string()
      .trim()
      .min(9)
      .max(100)
      .regex(/^[A-Za-z0-9*/,\-\s]+$/)
  })
]);
export type TaskScheduleSpec = z.infer<typeof TaskScheduleSpec>;

export const TaskSchedule = z.object({
  id: Id,
  workspaceId: Id,
  title: z.string().min(1).max(160),
  modelId: z.string(),
  privacyRoute: PrivacyRoute,
  maxComputeCredits: z.number().positive(),
  maxSpendUsd: z.number().positive().nullable().default(null),
  spec: TaskScheduleSpec,
  enabled: z.boolean(),
  nextRunAt: IsoDate.nullable(),
  lastRunAt: IsoDate.nullable(),
  lastTaskId: Id.nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate
});
export type TaskSchedule = z.infer<typeof TaskSchedule>;

export const CreateTaskScheduleRequest = z.object({
  workspaceId: Id,
  prompt: z.string().min(1).max(200_000),
  title: z.string().min(1).max(160).optional(),
  modelId: z.string().optional(),
  privacyRoute: PrivacyRoute.default('provider_zdr'),
  maxComputeCredits: z.number().min(0.01).max(10_000).default(1),
  maxSpendUsd: TaskSpendUsd.optional(),
  spec: TaskScheduleSpec
});
export type CreateTaskScheduleRequest = z.input<typeof CreateTaskScheduleRequest>;

/**
 * A tab identity handed out by the runner. It is bound to the page itself, so it survives
 * navigation, reordering and other tabs closing — none of which is true of a strip position.
 */
export const BrowserTabId = z.string().min(1).max(32);
export type BrowserTabId = z.infer<typeof BrowserTabId>;

/**
 * Every page-directed action may name the tab it applies to. Omitting it means the active tab,
 * which is what a single-tab flow wants; naming one lets the agent work in a background tab
 * without bringing it to the front and disturbing what the user is watching.
 */
const tabScoped = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...shape, tabId: BrowserTabId.optional() });

/** Actions that can appear inside a batch: everything except a batch itself. */
export const BrowserPrimitiveAction = z.discriminatedUnion('type', [
  tabScoped({ type: z.literal('navigate'), url: z.string().url() }),
  tabScoped({ type: z.literal('click'), selector: z.string().min(1) }),
  tabScoped({ type: z.literal('double_click'), selector: z.string().min(1) }),
  tabScoped({ type: z.literal('hover'), selector: z.string().min(1) }),
  tabScoped({
    type: z.literal('click_at'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900)
  }),
  tabScoped({
    type: z.literal('type'),
    selector: z.string().min(1),
    text: z.string().max(20_000),
    // `fill` sets the value in one shot; `keys` sends real keystrokes at human pace, which is
    // the only thing that wakes a typeahead, a masked input or a keydown validator. `auto`
    // lets the runner pick from what the control actually is.
    mode: z.enum(['auto', 'fill', 'keys']).default('auto')
  }),
  tabScoped({
    type: z.literal('select_option'),
    selector: z.string().min(1),
    // A multiple-select needs every chosen option in one call; one value is the common case.
    values: z.array(z.string().max(1_000)).min(1).max(50)
  }),
  tabScoped({
    type: z.literal('upload'),
    selector: z.string().min(1),
    // Workspace-relative paths only. The runner re-validates them against the same user-data
    // boundary as the file API, so this can never become a host-filesystem read primitive.
    paths: z.array(z.string().min(1).max(1_024)).min(1).max(10)
  }),
  tabScoped({ type: z.literal('text_input'), text: z.string().max(20_000) }),
  tabScoped({ type: z.literal('press'), key: z.string().min(1) }),
  tabScoped({
    type: z.literal('scroll'),
    // Without a target the wheel lands wherever the pointer happens to be; a ref scrolls the
    // container the agent actually means, such as a modal body or a virtualised list.
    selector: z.string().min(1).optional(),
    deltaX: z.number().min(-5_000).max(5_000).default(0),
    deltaY: z.number().min(-5_000).max(5_000)
  }),
  tabScoped({
    // Condition-based waiting. A fixed sleep is either a flake or dead time; every one of
    // these resolves the moment the page actually reaches the state the agent is waiting for.
    type: z.literal('wait_for'),
    selector: z.string().min(1).optional(),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
    text: z.string().min(1).max(400).optional(),
    urlIncludes: z.string().min(1).max(2_000).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000)
  }),
  tabScoped({ type: z.literal('back') }),
  tabScoped({ type: z.literal('reload') }),
  z.object({
    type: z.literal('new_tab'),
    url: z.string().url().optional(),
    // A background tab lets the agent open a reference page without losing its place.
    activate: z.boolean().default(true)
  }),
  z.object({ type: z.literal('select_tab'), tabId: BrowserTabId }),
  z.object({ type: z.literal('close_tab'), tabId: BrowserTabId }),
  // Reads a named tab in place: no bring-to-front, no change of active tab.
  z.object({ type: z.literal('inspect_tab'), tabId: BrowserTabId }),
  z.object({
    type: z.literal('dialog'),
    response: z.enum(['accept', 'dismiss']),
    promptText: z.string().max(4_000).optional()
  })
]);
export type BrowserPrimitiveAction = z.infer<typeof BrowserPrimitiveAction>;

export const BrowserAction = z.discriminatedUnion('type', [
  ...BrowserPrimitiveAction.options,
  z.object({
    // One round trip for a whole form. Steps run in order, stop at the first failure, and
    // report individually, so a batch is never less legible than the calls it replaces.
    type: z.literal('batch'),
    actions: z.array(BrowserPrimitiveAction).min(1).max(24)
  })
]);
export type BrowserAction = z.infer<typeof BrowserAction>;

/**
 * Public pages read as documents, in throwaway browsers of their own.
 *
 * One URL or a batch, because the same capability is called both ways and must present the same
 * name either way. A provider-side fetch takes one URL per call and is called several times within
 * a turn; athanor's own route takes the batch and opens up to twelve browsers at once. If those
 * were two differently named tools the model would be choosing between two descriptions of one
 * thing, and the name would change under it whenever the privacy route did - so the schema accepts
 * both shapes and the difference stops at this boundary.
 */
export const WebFetchRequest = z
  .object({
    url: z.string().url().optional(),
    urls: z.array(z.string().url()).max(12).default([]),
    maxCharactersPerPage: z.number().int().min(1_000).max(20_000).default(12_000)
  })
  .transform((value) => ({
    urls: [...(value.url === undefined ? [] : [value.url]), ...value.urls].slice(0, 12),
    maxCharactersPerPage: value.maxCharactersPerPage
  }))
  .refine((value) => value.urls.length > 0, {
    message: 'A web fetch needs at least one URL'
  });
export type WebFetchRequest = z.input<typeof WebFetchRequest>;

export const DesktopHolder = z.enum(['agent', 'user', 'secure_input']);
export type DesktopHolder = z.infer<typeof DesktopHolder>;

export const DesktopAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('invoke'),
    nodeId: z.string().min(1).max(512),
    actionIndex: z.number().int().nonnegative().max(100).default(0)
  }),
  z.object({ type: z.literal('focus'), nodeId: z.string().min(1).max(512) }),
  z.object({
    type: z.literal('set_text'),
    nodeId: z.string().min(1).max(512),
    text: z.string().max(200_000)
  }),
  z.object({
    type: z.literal('click_at'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900),
    button: z.enum(['left', 'middle', 'right']).default('left'),
    clicks: z.number().int().min(1).max(3).default(1)
  }),
  z.object({
    type: z.literal('drag'),
    fromX: z.number().min(0).max(1440),
    fromY: z.number().min(0).max(900),
    toX: z.number().min(0).max(1440),
    toY: z.number().min(0).max(900),
    durationMs: z.number().int().min(50).max(10_000).default(500)
  }),
  z.object({ type: z.literal('press'), key: z.string().min(1).max(100) }),
  z.object({ type: z.literal('text_input'), text: z.string().max(200_000) }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(100).default(3)
  }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(50).max(30_000) }),
  /**
   * A closer look at one rectangle of the screen, in the same coordinates every other action uses.
   *
   * The agent's still is reduced to fit a bounded image, so a checkbox or a small toolbar button
   * arrives a few pixels across and clicking it is a guess. This returns those pixels at their own
   * size instead of the whole screen shrunk, which is the largest single accuracy gain available on
   * this surface and costs one more screenshot.
   */
  z.object({
    type: z.literal('zoom'),
    x: z.number().min(0).max(1440),
    y: z.number().min(0).max(900),
    width: z.number().min(16).max(1440),
    height: z.number().min(16).max(900)
  })
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

export const DesktopLaunchRequest = z.object({
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(100_000)).max(256).default([]),
  cwd: z.string().default('workspace'),
  env: z.record(z.string(), z.string()).default({})
});
export type DesktopLaunchRequest = z.infer<typeof DesktopLaunchRequest>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional()
  })
});

/**
 * Choices that follow the owner from device to device.
 *
 * Open at the top level on purpose - the set grows, and an older build reading a newer row should
 * ignore what it does not know rather than refuse the whole object - but each key it does know is
 * validated, so a device cannot write a shape another device will choke on.
 */
export const OwnerPreferences = z.object({
  model: z
    .object({
      automatic: z.boolean(),
      preference: z.enum(['fast', 'balanced', 'best']),
      modelId: z.string().max(200)
    })
    .optional(),
  /**
   * Which conversation, on which computer, the owner had open.
   *
   * Held here rather than in the address bar, because the address bar is the one place a second
   * device cannot see. Installed to a home screen the app launches at `/` with no query at all, so
   * every launch landed on a blank new conversation however long the owner had spent in an old one
   * - the opposite of picking up where they left off, on the device most likely to be picked up.
   *
   * Nullable rather than absent when there is no conversation: a new conversation is a real place to
   * be, and the owner who deliberately left one should not be returned to it by the next device.
   */
  place: z
    .object({
      taskId: Id.nullish(),
      workspaceId: Id.nullish()
    })
    .optional(),
  /**
   * Whether the computer panel is open, and on which tab.
   *
   * A device-local choice until now, which made it one of the few things about this software that
   * was a fact about a browser rather than about its owner: open the files on the laptop, pick the
   * phone up, and the phone had its own idea. On a computer whose whole point is being the same
   * computer from anywhere, a panel that does not travel is not a setting.
   */
  inspector: z
    .object({
      open: z.boolean(),
      tab: z.enum(['files', 'computer', 'terminal', 'preview'])
    })
    .optional()
});
export type OwnerPreferences = z.infer<typeof OwnerPreferences>;

/** A half-typed message, saved against the conversation it belongs to, or none for a new one. */
export const SaveDraftRequest = z.object({
  workspaceId: Id,
  taskId: Id.nullish(),
  body: z.string().max(200_000),
  /**
   * The files already uploaded against this half-written message.
   *
   * They were held in the composer's own memory and nowhere else, so a message that was mostly its
   * attachments synced as an empty draft: the other device saw the sentence and none of the files,
   * and switching conversation on the first device dropped them there too while leaving the
   * uploaded bytes on the agent computer with nothing referring to them.
   *
   * Only the durable facts travel. Upload progress and a locally-made thumbnail belong to the
   * device that did the uploading.
   */
  attachments: z
    .array(
      z.object({
        path: z.string().min(1).max(1_024),
        name: z.string().min(1).max(240),
        sizeBytes: z.number().int().nonnegative(),
        mimeType: z.string().max(255)
      })
    )
    .max(50)
    .optional()
});
export type SaveDraftRequest = z.input<typeof SaveDraftRequest>;

export const ApiTokenScope = z.enum([
  'workspaces:read',
  'workspaces:write',
  'tasks:read',
  'tasks:write',
  'files:read',
  'files:write',
  'approvals:read',
  'approvals:write',
  'models:read',
  'usage:read',
  'connectors:read'
]);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

export const ApiToken = z.object({
  id: Id,
  label: z.string().min(1).max(80),
  prefix: z.string(),
  scopes: z.array(ApiTokenScope),
  lastUsedAt: IsoDate.nullable(),
  expiresAt: IsoDate,
  createdAt: IsoDate
});
export type ApiToken = z.infer<typeof ApiToken>;

export const CreateApiTokenRequest = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(ApiTokenScope).min(1).max(ApiTokenScope.options.length),
  expiresInDays: z.number().int().min(1).max(365).default(90)
});
export type CreateApiTokenRequest = z.input<typeof CreateApiTokenRequest>;

/**
 * What the runner answers a parallel web read with.
 *
 * Declared here because it is a wire shape between two packages that were each guessing at it
 * separately. The runner sent `sources`; all three readers in the worker asked for `pages` and got
 * nothing, silently - a turn never learnt the hosts it had just read and asked the owner to approve
 * the same one again, the untrusted-content label lost its host names, and an acceptance check
 * comparing a quoted span against a web source compared it against an empty string. A shape both
 * sides name from one place turns that into a build failure.
 */
export interface ResearchReadSource {
  requestedUrl: string;
  /** The address actually read, after redirects. Absent when the source could not be read. */
  url?: string;
  title?: string;
  text?: string;
  /** Set only on the retry, so a source that needed scripting is legible as such in the answer. */
  renderedWithScripts?: true;
  error?: string;
}

export interface ParallelWebReadResult {
  sources: ResearchReadSource[];
  requested: number;
  read: number;
}
