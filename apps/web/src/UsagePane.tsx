import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, HardDrive, Hash, LoaderCircle, MessageSquare } from 'lucide-react';
import { api } from './api.js';
import {
  bucketShare,
  formatUsd,
  hostStoragePercent,
  modelLabel,
  spendBreakdown,
  spendMeters,
  tokenSplit,
  type UsageResponse
} from './usage-model.js';
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

function SpendCard({
  label,
  spentUsd,
  capUsd,
  pendingUsd,
  percent,
  state,
  resetsAt
}: {
  label: string;
  spentUsd: number;
  capUsd: number | null;
  pendingUsd: number;
  percent: number | null;
  state: 'ok' | 'warning' | 'exceeded';
  resetsAt: string | null;
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
          ? `${percent}% of the ${formatUsd(capUsd)} cap`
          : 'No cap set for this window'}
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
  buckets: Array<{ key: string; costUsd: number; calls: number }>;
  render: (key: string) => { label: string; title: string; onOpen?: () => void };
}) {
  return (
    <div className="spend-bars">
      {buckets.map((bucket) => {
        const { label, title, onOpen } = render(bucket.key);
        const row = (
          <>
            <span className="spend-bar-name" title={title}>
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

  const meters = useMemo(() => (usage ? spendMeters(usage, spend) : []), [usage, spend]);
  const breakdown = useMemo(
    () => (usage ? spendBreakdown(usage, spend) : { byModel: [], byTask: [], complete: false }),
    [usage, spend]
  );
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const tokens = useMemo(
    () => (conversationEvents?.length ? tokenSplit(conversationCost(conversationEvents)) : null),
    [conversationEvents]
  );

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
              />
            ))}
          </div>
          {!spend && (
            <p className="spend-note">
              Spending caps are not available from this server, so the figures above are reported
              without ceilings.
            </p>
          )}

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
                render={(key) => ({ label: modelLabel(key), title: key })}
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
                render={(key) => ({
                  label: taskTitles.get(key) ?? 'Conversation no longer here',
                  title: taskTitles.get(key) ?? key,
                  ...(onOpenTask && taskTitles.has(key) ? { onOpen: () => onOpenTask(key) } : {})
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
                The conversation you have open
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
