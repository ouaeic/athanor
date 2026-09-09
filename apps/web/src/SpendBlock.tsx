/**
 * The card an owner sees when a spending ceiling has stopped a run.
 *
 * A halt used to be a status line in the activity log and a `paused` badge that looked exactly like
 * a pause the owner had pressed themselves. The one control on offer, Resume, re-queued the run
 * into the same ceiling and it stopped again a step later - so the honest reading of that interface
 * was that Resume was broken. What was missing was never a button; it was the question. This asks
 * it, in the shape the rest of the product asks questions in: the same card, the same two actions,
 * the figures that explain the stop, and the one change that actually lets the work continue.
 *
 * The figures are read from the server rather than computed here, and re-read when the card mounts,
 * because they move: a daily ceiling rolls over at midnight and the run that could not resume last
 * night resumes this morning untouched. A card drawn from a remembered halt would send its owner to
 * raise a limit that is no longer in the way.
 */
import { useEffect, useState } from 'react';
import { CircleDollarSign } from 'lucide-react';
import type { SpendWindow, Task, TaskSpendBlock } from '@athanor/contracts';
import { get, post, put, ApiError } from './client';
import { stepUp } from './auth';
import { Button, ErrorNotice, Spinner } from './ui';
import { money } from './model';

const WINDOW_LABEL: Record<string, string> = {
  task: 'this project',
  daily: 'today',
  monthly: 'this month'
};

/**
 * What to offer as the new ceiling: enough headroom that the work is not stopped again by the same
 * window within the hour, rounded to something an owner recognises as a decision rather than an
 * arithmetic result. Doubling is the rule, with a floor of five dollars over what has been
 * committed so a ceiling sitting just above a large spend still moves somewhere useful.
 */
export const suggestedCeiling = (window: SpendWindow): number => {
  const committed = window.spentUsd + window.pendingUsd;
  const doubled = Math.max((window.capUsd ?? committed) * 2, committed + 5);
  return Math.max(1, Math.ceil(doubled));
};

/** The per-run ceiling is a column on the task, so it moves through the task itself. */
const patchTaskCeiling = async (taskId: string, maxSpendUsd: number): Promise<void> => {
  await post(`/v1/tasks/${taskId}/spend-ceiling`, { maxSpendUsd });
};

export default function SpendBlock({ task, onResumed }: { task: Task; onResumed: () => void }) {
  const [block, setBlock] = useState<TaskSpendBlock | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setBlock(null);
    setError(null);
    get<TaskSpendBlock>(`/v1/tasks/${task.id}/spend-block`)
      .then((next) => live && setBlock(next))
      .catch((cause) => live && setError(cause));
    return () => {
      live = false;
    };
  }, [task.id]);
  if (error && !block) return <ErrorNotice error={error} />;
  if (!block) return <Spinner label="Reading why this stopped…" />;
  const blocked = block.decision.windows.find((window) => window.name === block.decision.blockedBy);
  /*
   * The window may have rolled over between the halt and this card. Nothing needs raising then, and
   * offering to raise a ceiling that is not in the way would be a lie about what is stopping the
   * work - so the card says the run can simply carry on.
   */
  const clear = !block.blocked || !blocked;
  const raiseTo = blocked ? suggestedCeiling(blocked) : null;

  async function act(raise: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (raise && blocked && raiseTo !== null) {
        /*
         * A task ceiling is a property of the run and the other two are account-wide, so they are
         * raised through different routes. Loosening an account ceiling can demand a passkey - the
         * same escalation the caps pane asks for - and that prompt belongs here rather than sending
         * the owner to Settings to do by hand what this card just offered.
         */
        const body =
          blocked.name === 'daily'
            ? { dailyCapUsd: raiseTo }
            : blocked.name === 'monthly'
              ? { monthlyCapUsd: raiseTo }
              : null;
        if (body) {
          try {
            await put('/v1/spend-limits', body);
          } catch (cause) {
            if (
              !(cause instanceof ApiError) ||
              !['step_up_required', 'recent_authentication_required'].includes(cause.code)
            )
              throw cause;
            await stepUp();
            await put('/v1/spend-limits', body);
          }
        } else {
          await patchTaskCeiling(task.id, raiseTo);
        }
      }
      await post(`/v1/tasks/${task.id}/resume`);
      onResumed();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="decision-card">
      <div className="eyebrow">
        <CircleDollarSign size={14} aria-hidden="true" />
        {clear ? 'Stopped on spending' : 'Your decision'}
      </div>
      <h3>{clear ? 'Nothing is over its limit now' : 'A spending limit stopped this work'}</h3>
      <p>
        {clear
          ? 'The limit that stopped this run is no longer in the way — a daily limit resets, and work already open can settle for less than it reserved. It can carry on as it is.'
          : block.summary}
      </p>
      {block.unchosen && !clear && (
        <p className="muted">
          This is the ceiling garden applies until you set one of your own, not a limit you chose.
        </p>
      )}
      {blocked && (
        <dl className="facts">
          <div>
            <dt>Limit for</dt>
            <dd>{WINDOW_LABEL[blocked.name] ?? blocked.name}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd>{money(blocked.spentUsd)}</dd>
          </div>
          {blocked.pendingUsd > 0 && (
            <div>
              <dt>Promised to open work</dt>
              <dd>{money(blocked.pendingUsd)}</dd>
            </div>
          )}
          <div>
            <dt>Limit</dt>
            <dd>{blocked.capUsd === null ? 'None' : money(blocked.capUsd)}</dd>
          </div>
        </dl>
      )}
      <ErrorNotice error={error} />
      <div className="row decision-actions">
        {clear ? (
          <Button className="primary" busy={busy} onClick={() => act(false)}>
            Carry on
          </Button>
        ) : (
          <Button className="primary" busy={busy} onClick={() => act(true)}>
            Raise to {money(raiseTo ?? 0)} and carry on
          </Button>
        )}
        {!clear && (
          <Button disabled={busy} onClick={onResumed}>
            Leave it stopped
          </Button>
        )}
      </div>
      <small>
        {clear
          ? 'Nothing is changed by carrying on.'
          : 'Raising the limit changes it for everything, not only this project. You can change it again in Spending.'}
      </small>
    </article>
  );
}
