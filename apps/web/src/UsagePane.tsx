import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CircleDollarSign,
  HardDrive,
  Hash,
  LoaderCircle,
  MessageSquare
} from 'lucide-react';
import { api } from './api.js';
import {
  bucketShare,
  formatUsd,
  hostStoragePercent,
  modelLabel,
  spendBreakdown,
  spendMeters,
  taskRowName,
  tokenSplit,
  type SpendRow,
  type UsageResponse
} from './usage-model.js';
import { conversationMeter, spendDays } from './spend-pane.js';
import type { SpendSummary, Task, TaskEvent, Workspace } from './types.js';
// One formatter for one quantity: the sidebar, the composer banner and this pane used to disagree
// about how many gigabytes the same files were.
import { conversationCost, formatBytes, formatTokens } from './timeline-state.js';

const resetLabel = (iso: string | null): string => {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hours = (at.getTime() - Date.now()) / 3_600_000;
  if (hours <= 0) return 'resets now';
  if (hours < 24) return `resets in ${Math.max(1, Math.round(hours))}h`;
  return `resets ${at.toLocaleDateString()}`;
};

export function SpendCard({
  label,
  spentUsd,
  capUsd,
  pendingUsd,
  percent,
  state,
  resetsAt,
  capNote
}: {
  label: string;
  spentUsd: number;
  capUsd: number | null;
  pendingUsd: number;
  percent: number | null;
  state: 'ok' | 'warning' | 'exceeded';
  resetsAt: string | null;
  /** What "no ceiling" means for this particular window, when it is not a wall-clock one. */
  capNote?: string;
}) {
  return (
    <div className={`spend-card ${state}`}>
      <span className="spend-card-label">{label}</span>
      <strong>{formatUsd(spentUsd)}</strong>
      {percent !== null && capUsd !== null && (
        <div className="meter spend">
          <i style={{ width: `${percent}%` }} />
        </div>
      )}
      <small>
        {capUsd !== null
          ? // `?? 0` because a cap of zero has no percentage to be a share of, and the line used to
            // print the word "null" at the one owner whose ceiling admits only free routes.
            `${percent ?? 0}% of the ${formatUsd(capUsd)} cap`
          : (capNote ?? 'No cap set for this window')}
        {pendingUsd > 0 ? ` · ${formatUsd(pendingUsd)} committed` : ''}
        {resetsAt ? ` · ${resetLabel(resetsAt)}` : ''}
      </small>
    </div>
  );
}

function BucketList({
  buckets,
  render
}: {
  buckets: SpendRow[];
  render: (bucket: SpendRow) => {
    label: string;
    title: string;
    /** False dims the label, which is how a stand-in is told apart from a name. */
    named?: boolean;
    onOpen?: () => void;
  };
}) {
  return (
    <div className="spend-bars">
      {buckets.map((bucket) => {
        const { label, title, named, onOpen } = render(bucket);
        const row = (
          <>
            <span className={`spend-bar-name${named === false ? ' unnamed' : ''}`} title={title}>
              {label}
            </span>
            <span className="spend-bar-value">{formatUsd(bucket.costUsd)}</span>
            <i style={{ width: `${bucketShare(bucket, buckets)}%` }} />
            <small>
              {bucket.calls} {bucket.calls === 1 ? 'call' : 'calls'}
            </small>
          </>
        );
        return onOpen ? (
          <button key={bucket.key} className="spend-bar" onClick={onOpen}>
            {row}
          </button>
        ) : (
          <div key={bucket.key} className="spend-bar">
            {row}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What each of the last days cost, which is the only shape an overnight runaway has.
 *
 * The failure the daily cap exists for is a night that spent a month's allowance, and a single
 * day's total cannot show it - it takes the days either side to say whether last night was unlike
 * them. The server has computed this series on every `/v1/spend` since the route existed, and
 * nothing has ever drawn it.
 */
export function DailySpend({ days }: { days: SpendRow[] }) {
  if (!days.length) return null;
  return (
    <div className="meter-card">
      <div>
        <span>
          <CalendarDays size={14} /> Day by day
        </span>
        <strong>What each day cost</strong>
      </div>
      <BucketList
        buckets={days}
        // The key is the day as the server grouped it, which is what an owner reconciling a bill
        // against a provider's statement needs to be able to read off the row.
        render={(bucket) => ({ label: bucket.label ?? bucket.key, title: bucket.key })}
      />
      <small>
        The most recent {days.length} {days.length === 1 ? 'day' : 'days'} money was billed on,
        newest first, in the zone your day rolls over in. A day nothing was billed on is not listed.
      </small>
    </div>
  );
}

/**
 * What the agent has actually cost, which is the one number a self-hoster pays for directly.
 *
 * Every model call already writes its settled provider cost; this is the surface that shows it,
 * measured against the owner's own daily and monthly ceilings. Storage stays because a full disk
 * stops the agent, but it is no longer the whole answer to "what is this costing me".
 */
export function UsagePane({
  workspace,
  tasks,
  conversationEvents,
  onOpenTask
}: {
  workspace: Workspace;
  tasks: Task[];
  /**
   * The open conversation's events, when there is one. The provider's token figures are written
   * into those events and nowhere the server can aggregate them from, so this is the only place
   * they can be read - which is why they are handed down rather than fetched.
   */
  conversationEvents?: TaskEvent[];
  onOpenTask?: (taskId: string) => void;
}) {
  const [usage, setUsage] = useState<UsageResponse>();
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setError('');
    // The caps are best-effort on purpose: losing them costs the ceilings drawn on the meters, and
    // reporting "usage is unavailable" over that would hide spend figures that loaded perfectly.
    void Promise.all([api.usage(), api.spend().catch(() => null)])
      .then(([nextUsage, nextSpend]) => {
        if (!active) return;
        setUsage(nextUsage);
        setSpend(nextSpend);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Usage could not be loaded right now');
      });
    return () => {
      active = false;
    };
  }, [workspace.id]);

  /*
   * The ceiling the open conversation is actually running under, when this pane can see the
   * conversation it belongs to.
   *
   * The task row carries the ceiling and the settled total together, so none of it is added up from
   * the transcript window the token card below has to warn about. The rows in reach are the
   * sidebar's page, so a conversation it has not loaded produces no card at all rather than a card
   * with a guessed ceiling on it.
   */
  const conversation = useMemo(() => {
    const openTaskId = conversationEvents?.[0]?.taskId;
    const open = openTaskId ? tasks.find((task) => task.id === openTaskId) : undefined;
    return open ? { spentUsd: open.spentUsd, maxSpendUsd: open.maxSpendUsd } : null;
  }, [tasks, conversationEvents]);

  /*
   * The conversation's own card sits after the three the owner already knows rather than in front
   * of them: it is only there while a conversation is open, and leading with it would move Today,
   * this week and this month one place along every time somebody opens this pane from a transcript.
   */
  const meters = useMemo(() => {
    if (!usage) return [];
    const own = conversationMeter(spend, conversation);
    return own ? [...spendMeters(usage, spend), own] : spendMeters(usage, spend);
  }, [usage, spend, conversation]);
  const days = useMemo(() => spendDays(spend), [spend]);
  const breakdown = useMemo(
    () => (usage ? spendBreakdown(usage, spend) : { byModel: [], byTask: [], complete: false }),
    [usage, spend]
  );
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const tokens = useMemo(
    () => (conversationEvents?.length ? tokenSplit(conversationCost(conversationEvents)) : null),
    [conversationEvents]
  );
  /*
   * What the server says the whole conversation spent, as against what the loaded transcript can
   * account for.
   *
   * The events handed down here are the transcript's own window, and a transcript opens at its
   * newest page - so on any conversation long enough to have paged, this card was adding up the
   * last few turns and labelling the answer "the conversation you have open". The cost line at the
   * foot of the transcript had exactly this bug and was fixed by preferring the server's settled
   * figure over the window; this is the same move with the figure the server actually holds.
   *
   * It holds a total, not a split: `usage_entries` stores one scalar quantity per model call
   * (`unit: 'tokens'`), so there is no server-side input/output/cache breakdown to prefer and none
   * is invented here. The total is enough to know when the window is short, which is the part that
   * was misleading. Read out of the usage response this pane already fetched, so it costs no extra
   * request; settled rows only, matching the cost line, and a ledger truncated by its own history
   * limit can only under-report, which leaves the card saying exactly what it says today.
   */
  const wholeConversationTokens = useMemo(() => {
    const openTaskId = conversationEvents?.[0]?.taskId;
    if (!usage || !openTaskId) return 0;
    return usage.history
      .filter(
        (entry) =>
          entry.taskId === openTaskId && entry.unit === 'tokens' && entry.state === 'settled'
      )
      .reduce((total, entry) => total + entry.quantity, 0);
  }, [usage, conversationEvents]);

  const storage = hostStoragePercent(workspace);

  return (
    <div className="usage-pane">
      {!usage && !error && (
        <div className="empty-pane">
          <LoaderCircle className="spin" />
          <strong>Reading your spend</strong>
        </div>
      )}
      {error && (
        <div className="empty-pane">
          <CircleDollarSign />
          <strong>Spend figures did not load</strong>
          <span>{error}</span>
        </div>
      )}
      {usage && (
        <>
          <div className="spend-cards">
            {meters.map((meter) => (
              <SpendCard
                key={meter.id}
                label={meter.label}
                spentUsd={meter.spentUsd}
                capUsd={meter.capUsd}
                pendingUsd={meter.pendingUsd}
                percent={meter.percent}
                state={meter.state}
                resetsAt={meter.resetsAt}
                {...(meter.id === 'task' ? { capNote: 'No ceiling on this conversation' } : {})}
              />
            ))}
          </div>
          {!spend && (
            <p className="spend-note">
              Spending caps are not available from this server, so the figures above are reported
              without ceilings.
            </p>
          )}

          <DailySpend days={days} />

          <div className="meter-card">
            <div>
              <span>
                <CircleDollarSign size={14} /> Where it went
              </span>
              <strong>By model</strong>
            </div>
            {breakdown.byModel.length ? (
              <BucketList
                buckets={breakdown.byModel}
                render={(bucket) => ({ label: modelLabel(bucket.key), title: bucket.key })}
              />
            ) : (
              <small>No billed model calls yet.</small>
            )}
            <small>
              {breakdown.complete
                ? 'Charged by your provider this month.'
                : 'Charged by your provider across the records kept here.'}
            </small>
          </div>

          <div className="meter-card">
            <div>
              <span>
                <MessageSquare size={14} /> Most expensive work
              </span>
              <strong>By conversation</strong>
            </div>
            {breakdown.byTask.length ? (
              <BucketList
                buckets={breakdown.byTask}
                render={(bucket) => ({
                  ...taskRowName(bucket, taskTitles),
                  // Every row opens, named or not. Whether a conversation is still there is a
                  // question this pane cannot answer and the conversation view can: it fetches one
                  // the sidebar page did not carry, and says so when it is genuinely gone. Refusing
                  // the click was the pane guessing, and guessing wrong on its most expensive rows.
                  ...(onOpenTask ? { onOpen: () => onOpenTask(bucket.key) } : {})
                })}
              />
            ) : (
              <small>No conversation has been billed yet.</small>
            )}
          </div>

          {/*
            Where the transcript's token line went. It draws nothing when no conversation is open,
            for the same reason the provenance panel does: a report nobody asked for, shown always,
            stops being read at all.
          */}
          {tokens && (
            <div className="meter-card">
              <div>
                <span>
                  <Hash size={14} /> Tokens
                </span>
                {/* The figure in the strong, the subject in the small: the same shape as the
                    storage card two below, which is the card people read most. */}
                <strong>
                  {formatTokens(tokens.inputTokens)} in · {formatTokens(tokens.outputTokens)} out
                </strong>
              </div>
              <small>
                {/*
                  A twentieth of margin before it says so. The ledger's per-call total is the
                  provider's own `total_tokens` and the split beside it is the provider's prompt and
                  completion counts, which are the same figures but need not reconcile to the token
                  on every route - while a genuine paging gap is at least one whole turn, thousands
                  of tokens and usually most of the conversation. The margin can only make this say
                  less than it knows, which is the safe direction for a line about under-reporting.
                */}
                {wholeConversationTokens > (tokens.inputTokens + tokens.outputTokens) * 1.05
                  ? `${formatTokens(wholeConversationTokens)} in the whole conversation; the split covers what is loaded here`
                  : 'The conversation you have open'}
                {tokens.cacheSharePercent > 0
                  ? `, ${tokens.cacheSharePercent}% of its input from cache`
                  : ''}
                .
              </small>
            </div>
          )}

          <div className="meter-card">
            <div>
              <span>
                <HardDrive size={14} /> Storage
              </span>
              <strong>
                {workspace.hostStorageTotalBytes &&
                workspace.hostStorageAvailableBytes !== undefined
                  ? `${formatBytes(workspace.hostStorageAvailableBytes)} free of ${formatBytes(workspace.hostStorageTotalBytes)}`
                  : `${formatBytes(workspace.storageBytes)} in agent files`}
              </strong>
            </div>
            {storage !== undefined && (
              <div className="meter storage">
                <i style={{ width: `${storage}%` }} />
              </div>
            )}
            <small>Agent files currently use {formatBytes(workspace.storageBytes)}.</small>
          </div>
        </>
      )}
    </div>
  );
}
