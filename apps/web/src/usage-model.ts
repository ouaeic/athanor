import type {
  ProviderSpend,
  SpendBucket,
  SpendLimits,
  SpendSummary,
  SpendWindowState,
  UpdateSpendLimitsRequest
} from './types.js';

/*
 * Mirrors MAX_SPEND_CAP_USD and MAX_TASK_SPEND_USD in @athanor/contracts. Copied rather than
 * imported because every other use of that package here is `import type`, and pulling a runtime
 * value in would drag the whole schema library into the first paint to validate two numbers. The
 * server remains the authority; this only turns a typo into a sentence instead of a 400.
 */
const MAX_SPEND_CAP_USD = 1_000_000;
const MAX_TASK_SPEND_USD = 10_000;

export interface UsageEntry {
  id: string;
  workspaceId?: string;
  taskId?: string;
  kind: string;
  resourceClass: string;
  quantity: number;
  unit: string;
  credits: number;
  costUsd: number;
  modelId?: string;
  state: string;
  createdAt: string;
}

export interface UsageResponse {
  subscription: { periodStart: string; periodEnd: string; storageLimitBytes: number };
  totals: { settled: number; reserved: number };
  providerSpend: ProviderSpend;
  storageBytes: number;
  storageThreshold: 0 | 70 | 85 | 95 | 100;
  history: UsageEntry[];
}

export interface SpendMeter {
  id: 'today' | 'week' | 'month';
  label: string;
  spentUsd: number;
  /** Null when the owner has set no ceiling for this window, so it can only ever report. */
  capUsd: number | null;
  /** Money promised to work that is open but not finished. */
  pendingUsd: number;
  state: SpendWindowState;
  /** 0-100 against the cap, null when there is none. */
  percent: number | null;
  /** When the window rolls over, so "today" is anchored to something. */
  resetsAt: string | null;
}

/**
 * Money is shown to the cent, because the whole point of a dollar figure is that it reconciles
 * with the provider's bill. A charge smaller than a cent is shown at the precision that makes it a
 * number: most single turns cost less than a cent, and "<$0.01" beside every one of them says
 * nothing — while the same conversation's total, printed to four places elsewhere in the interface,
 * appeared to contradict it. One rule, everywhere money appears.
 */
export const formatUsd = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value >= 1_000) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toFixed(2)}`;
};

export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  /** How much of the input the provider served from its cache, 0-100. */
  cacheSharePercent: number;
}

/**
 * The provider's own account of a conversation: how many tokens went each way, and how much of the
 * input it did not have to re-read.
 *
 * It used to be printed under the last answer, where it competed with the answer. Nothing here can
 * be acted on in the transcript - it is diagnostic, and it belongs with the other diagnostics. The
 * cached count is clamped to the input it is a share of, because a provider that reports the two
 * from different counters has been observed to make the share exceed 100%.
 */
export const tokenSplit = (totals: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): TokenSplit | null => {
  if (!totals.inputTokens && !totals.outputTokens) return null;
  const cached = Math.min(Math.max(totals.cachedInputTokens, 0), totals.inputTokens);
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheSharePercent: totals.inputTokens ? Math.round((cached / totals.inputTokens) * 100) : 0
  };
};

/**
 * How full the box's disk is, or nothing when it has not said.
 *
 * The composer's warning strip and the usage pane each carried their own copy of this arithmetic,
 * which is how the strip and the meter come to disagree about the same disk.
 */
export const hostStoragePercent = (workspace: {
  hostStorageTotalBytes?: number | undefined;
  hostStorageAvailableBytes?: number | undefined;
}): number | undefined => {
  const total = workspace.hostStorageTotalBytes;
  const available = workspace.hostStorageAvailableBytes;
  if (!total || total <= 0 || available === undefined) return undefined;
  return Math.min(100, Math.max(0, ((total - available) / total) * 100));
};

const GIB = 1024 ** 3;

/**
 * The free space the box keeps for itself, below which it refuses the agent's writes.
 *
 * Mirrors `hostStorageFloorBytes` in services/workspace-runner/src/host-storage.ts, which is the
 * code that actually throws: PostgreSQL's data directory, the journal and the workspace share one
 * filesystem, so an agent that fills the disk stops the database and takes the interface with it.
 * Copied rather than imported for the same reason the spend ceilings above are - the runner is a
 * server package and every other use of shared code here is `import type`.
 */
export const hostStorageFloorBytes = (hostStorageTotalBytes: number): number =>
  Math.min(20 * GIB, Math.max(2 * GIB, hostStorageTotalBytes * 0.02));

/**
 * Whether the disk is full enough that work is already failing.
 *
 * The strip above the composer used to speak at ninety percent, which is a percentage of a number
 * the owner did not choose: ninety percent of a 4 TB disk is 400 GB free and nothing is wrong,
 * while ninety percent of a 32 GB box is already past the floor. What decides whether the agent's
 * next file write throws is the free bytes against that floor and nothing else, so that is what is
 * asked here - the banner and the runner now agree about the same disk.
 */
export const hostStorageBlocksWork = (workspace: {
  hostStorageTotalBytes?: number | undefined;
  hostStorageAvailableBytes?: number | undefined;
}): boolean => {
  const total = workspace.hostStorageTotalBytes;
  const available = workspace.hostStorageAvailableBytes;
  if (!total || total <= 0 || available === undefined) return false;
  return available < hostStorageFloorBytes(total);
};

/** A provider-qualified model id is unreadable in a table; the tail is the part people know. */
export const modelLabel = (key: string): string => key.split('/').pop() || key;

const meterPercent = (spentUsd: number, capUsd: number | null): number | null =>
  capUsd && capUsd > 0 ? Math.min(100, Math.round((spentUsd / capUsd) * 100)) : null;

/**
 * The three windows the owner actually asks about, from whichever source can answer.
 *
 * `/v1/usage` always carries the real settled spend for today, this week and this month. The caps
 * that spend is measured against live on the newer spend summary, so a box without it still gets
 * honest figures — just no ceilings drawn on them.
 */
export const spendMeters = (usage: UsageResponse, spend: SpendSummary | null): SpendMeter[] => {
  const windows = usage.providerSpend.windows;
  const daily = spend?.windows.find((item) => item.name === 'daily');
  const monthly = spend?.windows.find((item) => item.name === 'monthly');
  return [
    {
      id: 'today',
      label: 'Today',
      spentUsd: daily?.spentUsd ?? windows.daily.used,
      capUsd: daily?.capUsd ?? null,
      pendingUsd: daily?.pendingUsd ?? 0,
      state: daily?.state ?? 'ok',
      percent: meterPercent(daily?.spentUsd ?? windows.daily.used, daily?.capUsd ?? null),
      resetsAt: daily?.endsAt ?? windows.daily.resetsAt
    },
    {
      id: 'week',
      label: 'This week',
      spentUsd: windows.weekly.used,
      // Spend limits are a daily and a monthly ceiling; there is deliberately no weekly one.
      capUsd: null,
      pendingUsd: 0,
      state: 'ok',
      percent: null,
      resetsAt: windows.weekly.resetsAt
    },
    {
      id: 'month',
      label: 'This month',
      spentUsd: monthly?.spentUsd ?? windows.monthly.used,
      capUsd: monthly?.capUsd ?? null,
      pendingUsd: monthly?.pendingUsd ?? 0,
      state: monthly?.state ?? 'ok',
      percent: meterPercent(monthly?.spentUsd ?? windows.monthly.used, monthly?.capUsd ?? null),
      resetsAt: monthly?.endsAt ?? windows.monthly.resetsAt
    }
  ];
};

const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * The most expensive conversations, from the usage history, for a server that cannot aggregate
 * them itself. Only settled entries count: a reservation is not a charge.
 */
export const tasksBySpend = (history: UsageEntry[], limit = 5): SpendBucket[] => {
  const byTask = new Map<string, SpendBucket>();
  for (const entry of history) {
    if (entry.state !== 'settled' || !entry.taskId || !(entry.costUsd > 0)) continue;
    const bucket = byTask.get(entry.taskId) ?? { key: entry.taskId, costUsd: 0, calls: 0 };
    bucket.costUsd += entry.costUsd;
    bucket.calls += 1;
    byTask.set(entry.taskId, bucket);
  }
  return [...byTask.values()]
    .map((bucket) => ({ ...bucket, costUsd: roundUsd(bucket.costUsd) }))
    .sort((left, right) => right.costUsd - left.costUsd)
    .slice(0, limit);
};

/** Same shape, keyed by the model the provider billed for. */
export const modelsBySpend = (history: UsageEntry[], limit = 5): SpendBucket[] => {
  const byModel = new Map<string, SpendBucket>();
  for (const entry of history) {
    if (entry.state !== 'settled' || !(entry.costUsd > 0)) continue;
    const key = entry.modelId ?? entry.kind;
    const bucket = byModel.get(key) ?? { key, costUsd: 0, calls: 0 };
    bucket.costUsd += entry.costUsd;
    bucket.calls += 1;
    byModel.set(key, bucket);
  }
  return [...byModel.values()]
    .map((bucket) => ({ ...bucket, costUsd: roundUsd(bucket.costUsd) }))
    .sort((left, right) => right.costUsd - left.costUsd)
    .slice(0, limit);
};

/**
 * One row of a spend breakdown, as the pane needs it rather than as the wire carries it.
 *
 * A bucket is a key and two numbers, and the key of a conversation row is its task id — so the row
 * arrives with no name on it at all. `label` is the name the server put on the row when it could
 * read one; it is optional because a box that has not been updated yet sends none, and everything
 * below has to stay true on both.
 */
export interface SpendRow {
  key: string;
  costUsd: number;
  calls: number;
  label?: string;
}

export interface SpendBreakdown {
  byModel: SpendBucket[];
  byTask: SpendRow[];
  /** True when the figures cover the whole capped month rather than the recent history window. */
  complete: boolean;
}

export const spendBreakdown = (usage: UsageResponse, spend: SpendSummary | null): SpendBreakdown =>
  spend
    ? { byModel: spend.byModel.slice(0, 5), byTask: spend.byTask.slice(0, 5), complete: true }
    : {
        byModel: modelsBySpend(usage.history),
        byTask: tasksBySpend(usage.history),
        complete: false
      };

/**
 * What to call a conversation this pane is reporting money against.
 *
 * The names it can reach are the conversations the sidebar happens to have loaded — its first page,
 * active ones only — and the rows here are the twenty most expensive of the month, which are the
 * long-running and the long-finished. So the overlap is partial by construction, and every row
 * outside it used to be labelled "Conversation no longer here": a conversation the owner can open
 * from the sidebar, reported as deleted on the screen that accounts for their money.
 *
 * Nothing here can tell whether a conversation still exists, so nothing here says. A name is used
 * when one is in reach — the server's own, or the sidebar's, which is fresher because a rename
 * shows there before it is saved — and otherwise the row says only what is true, that this is a
 * conversation the screen cannot see from here. Opening it is what answers the question, and the
 * conversation view already fetches one the sidebar page did not carry and says so if it is
 * genuinely gone.
 */
export const UNNAMED_CONVERSATION = 'A conversation not in view';

export interface SpendRowName {
  label: string;
  /** The tooltip: the full name, or the raw id, which is what an owner debugging their bill has. */
  title: string;
  /** False when the label is a stand-in rather than this conversation's own name. */
  named: boolean;
}

export const taskRowName = (row: SpendRow, titles: ReadonlyMap<string, string>): SpendRowName => {
  const name = titles.get(row.key)?.trim() || row.label?.trim();
  return name
    ? { label: name, title: name, named: true }
    : { label: UNNAMED_CONVERSATION, title: row.key, named: false };
};

export interface SpendLimitsDraft {
  dailyCapUsd: string;
  monthlyCapUsd: string;
  defaultTaskCapUsd: string;
  warnAtPercent: string;
  timeZone: string;
}

export const spendLimitsDraft = (limits: SpendLimits): SpendLimitsDraft => ({
  dailyCapUsd: limits.dailyCapUsd === null ? '' : String(limits.dailyCapUsd),
  monthlyCapUsd: limits.monthlyCapUsd === null ? '' : String(limits.monthlyCapUsd),
  defaultTaskCapUsd: limits.defaultTaskCapUsd === null ? '' : String(limits.defaultTaskCapUsd),
  warnAtPercent: String(limits.warnAtPercent),
  timeZone: limits.timeZone
});

/**
 * Turns the form into the request the server expects, or into the reason it will not send.
 *
 * The API distinguishes "leave this alone" from "clear this cap", so an empty field has to become
 * an explicit `null` rather than being omitted — otherwise a cap could be set but never removed.
 * Bounds are checked here so a typo produces a sentence instead of a 400.
 */
export const spendLimitsPatch = (
  draft: SpendLimitsDraft
): { ok: true; body: UpdateSpendLimitsRequest } | { ok: false; message: string } => {
  const cap = (
    raw: string,
    label: string,
    max: number,
    allowZero: boolean
  ): number | null | string => {
    const text = raw.trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value <= 0))
      return `${label} must be an amount in dollars, or blank for no cap.`;
    if (value > max) return `${label} cannot be more than $${max.toLocaleString('en-US')}.`;
    return value;
  };

  const daily = cap(draft.dailyCapUsd, 'The daily cap', MAX_SPEND_CAP_USD, true);
  if (typeof daily === 'string') return { ok: false, message: daily };
  const monthly = cap(draft.monthlyCapUsd, 'The monthly cap', MAX_SPEND_CAP_USD, true);
  if (typeof monthly === 'string') return { ok: false, message: monthly };
  const perTask = cap(
    draft.defaultTaskCapUsd,
    'The per-conversation cap',
    MAX_TASK_SPEND_USD,
    false
  );
  if (typeof perTask === 'string') return { ok: false, message: perTask };
  if (daily !== null && monthly !== null && daily > monthly)
    return { ok: false, message: 'The daily cap cannot be higher than the monthly cap.' };

  const warnAtPercent = Number(draft.warnAtPercent.trim());
  if (!Number.isInteger(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 99)
    return { ok: false, message: 'Warn at must be a whole percentage between 1 and 99.' };
  const timeZone = draft.timeZone.trim();
  if (!timeZone) return { ok: false, message: 'Choose the time zone your day rolls over in.' };

  return {
    ok: true,
    body: {
      dailyCapUsd: daily,
      monthlyCapUsd: monthly,
      defaultTaskCapUsd: perTask,
      warnAtPercent,
      timeZone
    }
  };
};

/** A bar is only readable relative to the largest thing in the same chart. */
export const bucketShare = (bucket: SpendBucket, buckets: SpendBucket[]): number => {
  const largest = buckets.reduce((max, item) => Math.max(max, item.costUsd), 0);
  return largest > 0 ? Math.max(2, Math.round((bucket.costUsd / largest) * 100)) : 0;
};
