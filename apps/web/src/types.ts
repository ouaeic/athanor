import type {
  Connector,
  ConnectorAuditEvent,
  ConnectorTestResult,
  ApiToken,
  ApiTokenScope,
  ProviderSpend,
  ModelRelease,
  RewindScope,
  SpendBucket,
  SpendSummary,
  SpendWindowState,
  SpendLimits,
  UpdateSpendLimitsRequest,
  Task,
  TaskPlan,
  TaskPlanStep,
  TaskRewindPreview,
  TaskSchedule,
  TaskEvent,
  UsageSummary,
  Workspace,
  WorkspacePreview,
  WorkspaceSnapshot
} from '@athanor/contracts';
import type { SecurityMode } from '@athanor/contracts';
import type { WebSearchRoutes } from './web-search-route.js';

export type { Artifact } from '@athanor/contracts';

export interface User {
  id: string;
  username: string;
  displayName: string;
  /** Choices the server holds for this owner, so every device they sign in on agrees. */
  preferences?: {
    model?: { automatic: boolean; preference: 'fast' | 'balanced' | 'best'; modelId: string };
    /** Where this owner was, so a device that launches with no address to go on can go there. */
    place?: { taskId?: string | null; workspaceId?: string | null };
    /** Whether the computer panel is open and on which tab, so every device agrees. */
    inspector?: { open: boolean; tab: 'files' | 'computer' | 'terminal' | 'preview' };
  };
}

/** A half-typed message the box is holding, from whichever device it was typed on. */
export interface MessageDraft {
  workspaceId: string;
  taskId: string | null;
  body: string;
  /** Files already uploaded against it. Progress and thumbnails stay on the device that uploaded. */
  attachments: Array<{ path: string; name: string; sizeBytes: number; mimeType: string }>;
  /** When the box last saw this change, so a device can tell a newer sentence from its own. */
  updatedAt: string;
}

/** What the picker and the transcript need to know about a model. */
export interface CatalogueModel {
  id: string;
  providerModelId: string;
  displayName: string;
  /** Which service answers for it. Carried so the hosted-routes boundary is checkable here. */
  provider: string;
  availability: ModelRelease['availability'];
  privacyRoute: ModelRelease['privacyRoute'];
}

export interface Bootstrap {
  user: User;
  drafts?: MessageDraft[];
  workspaces: Workspace[];
  tasks: Task[];
  /** Where the conversation list resumes, or null when this page was all of them. */
  tasksCursor?: string | null;
  schedules: TaskSchedule[];
  /**
   * The catalogue as this client uses it: enough to name a model, order the picker and keep the
   * privacy routes apart. The full record - prices, benchmarks, cache behaviour, retirement dates -
   * is the router's business and lives on the server; shipping it here put 424 kB in front of first
   * paint for five fields' worth of reading.
   */
  models: CatalogueModel[];
  usage: UsageSummary;
  instance: {
    mode: 'self_hosted';
    providerConfigured: boolean;
    enforceZeroDataRetention: boolean;
    /** Where a search is answered, per privacy route. Absent from a box older than this field. */
    webSearch?: WebSearchRoutes;
    sourceUrl: string | null;
  };
  legal: {
    applicationLicense: 'AGPL-3.0-only';
    sourceUrl: string | null;
    privacyUrl: string | null;
  };
}

export interface Approval {
  id: string;
  taskId: string;
  action: string;
  sideEffect: string;
  expiresAt: string;
  preview: { preview?: string; tool?: string; arguments?: unknown } | string;
}

export interface ConversationSearchResult {
  taskId: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface WorkspaceMemory {
  id: string;
  target: 'workspace' | 'user';
  content: string;
  status: 'active' | 'upcoming' | 'expired';
  validFrom: string | null;
  validUntil: string | null;
  source: 'owner' | 'agent';
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  version: number;
  enabled: boolean;
  status: 'active' | 'stale' | 'archived';
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything the box knows about its relay, as `GET /v1/relay` reports it.
 *
 * Declared here rather than imported because the relay is server-side plumbing: the client is a
 * reader of this report and never constructs one.
 */
export interface RelayReport {
  enabled: boolean;
  host: string | null;
  address: string | null;
  port: number;
  label: string | null;
  /** Where clients reach this box over the relay, or null when there is no enrollment. */
  hostname: string | null;
  pinnedRelaySpkiSha256: string | null;
  enrolledAt: string | null;
  status: {
    state: 'off' | 'connecting' | 'online' | 'waiting' | 'revoked';
    label: string | null;
    hostname: string | null;
    openStreams: number;
    usedBytes: number;
    quota: 'ok' | 'warn' | 'shaped' | 'blocked' | null;
    lastError: string | null;
    nextAttemptAtMs: number | null;
  };
}

/**
 * One entry of `GET /v1/connectors/catalog`: the box's own statement of what a connection reaches,
 * where its credential lives, and what the owner must already have for it to work at all.
 *
 * Declared here rather than imported because the catalogue is written on the server and only read
 * here — and `requirements` is optional because the boxes that predate it simply say less.
 */
export interface ConnectorDefinition {
  kind: string;
  name: string;
  description: string;
  dataAccess: string;
  tokenLocation: string;
  providerLogging: string;
  requirements?: string;
  scopes: Array<{ id: string; label: string; sideEffect: 'read' | 'write' | 'delete' }>;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * An anti-bot challenge the runner recognised.
 *
 * It stops one tab on one site: the agent keeps the browser and carries on everywhere else, and
 * the challenge stands until the page passes on its own or a person opens it. So this is a request
 * for one page to be looked at, not a tool error and not a handover of the whole browser.
 */
export interface BotWall {
  vendor: string;
  url: string;
  reason: string;
  /**
   * Where the challenge was seen. Page evidence can clear itself on a later look; response evidence
   * arrived in headers that only a fresh request would produce, and that request is exactly the
   * retry that must not happen.
   */
  evidence?: 'page' | 'response';
  /** Which tab is stopped, so taking over can bring exactly that one to the front. */
  tabId?: string | null;
}

export interface DesktopSnapshot {
  available: boolean;
  mode: 'semantic_and_visual' | 'visual_fallback' | 'unavailable';
  holder: 'agent' | 'user' | 'secure_input';
  width: number;
  height: number;
  activeApplication: string;
  windows: Array<{ id: string; name: string; role: string }>;
  nodes: Array<{
    id: string;
    parentId: string | null;
    name: string;
    description: string;
    role: string;
    states: string[];
    actions: string[];
    interfaces: string[];
    bounds: { x: number; y: number; width: number; height: number } | null;
    text?: string;
    sensitive: boolean;
  }>;
  screenshotBase64: string;
  message?: string;
}

export type {
  ApiToken,
  ApiTokenScope,
  Connector,
  ConnectorAuditEvent,
  ConnectorTestResult,
  ProviderSpend,
  ModelRelease,
  RewindScope,
  SpendBucket,
  SpendSummary,
  SpendWindowState,
  SpendLimits,
  UpdateSpendLimitsRequest,
  Task,
  TaskPlan,
  TaskPlanStep,
  TaskEvent,
  TaskRewindPreview,
  TaskSchedule,
  Workspace,
  WorkspacePreview,
  WorkspaceSnapshot,
  SecurityMode
};
