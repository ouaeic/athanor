/**
 * Everything the agent stopped to ask, including the questions nobody was there to answer.
 *
 * The store has kept every approval since the table existed and the route has always been able to
 * hand back any of the four statuses — the client asked for one of them, from two call sites, with
 * no parameter at all. So the whole record of what this computer asked permission for was reachable
 * only as "what is waiting right now", and the answers already given were reachable only by
 * scrolling the conversation they were given in.
 *
 * `expired` is why this screen exists. A lapse is not a block and not a denial: the worker treats an
 * unanswered request as expired, skips the action and carries the turn on, so an owner who was
 * asleep or away comes back to work that quietly did less than it was asked to. The only trace was
 * one line buried in one transcript. Here it is a list, with the wording of what was asked still on
 * it, because that wording is the only account of the thing that did not happen.
 *
 * Read-only on purpose. Answering a request is done on the card in its own conversation, which
 * carries the diffs, the destinations and the trajectory this row cannot: a row that offered
 * Approve while showing less than the card does would be inviting a decision on less evidence than
 * the product already insists on. What it offers instead is the way back to that card.
 */
import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { api } from './api.js';
import { ApiFailure } from './api-failure.js';
import { describeFailure } from './failure-text.js';
import { approvalProvenance, approvalReach, expiryNote } from './approval-copy.js';
import {
  agentSentence,
  approvalDestinations,
  approvalFacts,
  approvalRequestText
} from './approval-facts.js';
import type { Approval } from './types.js';
import './decisions.css';

/** The four the route accepts, which are also the four the store ever writes. */
export type DecisionStatus = 'pending' | 'approved' | 'denied' | 'expired';

/**
 * How many rows one page asks for.
 *
 * Well under the route's ceiling of 200, because each row on this list costs the server two queries,
 * a key unwrap and a decrypt, and a history screen is read a page at a time by somebody scrolling.
 * The number is also how "there may be more" is decided, below.
 */
export const DECISIONS_PAGE = 25;

/**
 * Each filter, and what its list means once it is empty.
 *
 * The empty sentences are not decoration. A four-status list that draws nothing for `expired`
 * cannot be told apart from a screen that was never wired up — which is the defect this whole file
 * is here to remove — and "nothing has lapsed" is a genuinely reassuring fact about a box that has
 * been running unattended.
 */
export const decisionStatuses: ReadonlyArray<{
  id: DecisionStatus;
  label: string;
  note: string;
  empty: string;
}> = [
  {
    id: 'pending',
    label: 'Waiting',
    note: 'Asked, and not yet answered. Answering one is done on the card in its own conversation, which shows the file changes and the addresses this row cannot.',
    empty: 'Nothing is waiting for an answer.'
  },
  {
    id: 'approved',
    label: 'Approved',
    note: 'What you let it do, newest first.',
    empty: 'Nothing has been approved on this box yet.'
  },
  {
    id: 'denied',
    label: 'Refused',
    note: 'Refused by you — or refused for you, since stopping a conversation refuses everything it was still waiting on.',
    empty: 'Nothing has been refused.'
  },
  {
    id: 'expired',
    label: 'Lapsed',
    note: 'Nobody answered in time. The action was not run and athanor carried on without it, so this list is the only account there is of what was skipped.',
    empty: 'Nothing has lapsed. Every request has been answered while it was still open.'
  }
];

/** The first letter of a phrase written to sit mid-sentence, made to start one. */
const opens = (phrase: string): string => phrase.replace(/^./, (first) => first.toUpperCase());

/**
 * What became of this request, in the words its own status earns.
 *
 * Pending is the only one that reads the clock, and it reads it through `expiryNote` — which says
 * both how long is left and which way it fails — because a row can sit in this list already past
 * its deadline. Nothing lapses on its own: the sweep that writes `expired` runs with the rest of
 * maintenance, so between the deadline and the sweep the honest answer is the one the card gives.
 */
export const decisionOutcome = (
  approval: Approval,
  status: DecisionStatus,
  now = Date.now()
): string => {
  if (status === 'pending') return opens(expiryNote(approval.expiresAt, now));
  if (status === 'approved') return 'You approved it, and it ran.';
  if (status === 'denied') return 'Refused, so it was not run.';
  return 'It lapsed with no answer, so it was not run and athanor carried on without it.';
};

/**
 * Where the next page starts, or nothing at all.
 *
 * The route answers with a bare array and no `nextCursor`, so a position is the `cursor` of the last
 * row that came back. Two things mean there is no next page: a short page, which is the end of the
 * list; and a row with no cursor on it, which is a box older than the field. Offering "Show older"
 * in either case would be a button that re-fetched the page already on screen for ever.
 */
export const nextDecisionCursor = (rows: readonly Approval[]): string | undefined =>
  rows.length < DECISIONS_PAGE ? undefined : rows[rows.length - 1]?.cursor;

/** One page, asked for the way the route wants it asked for. */
export const loadDecisions = (status: DecisionStatus, cursor?: string): Promise<Approval[]> =>
  api.approvals(status, DECISIONS_PAGE, cursor);

/**
 * The request as stored, when this server cannot read it back.
 *
 * The route substitutes this exact string for the preview of an approval whose workspace key it
 * cannot unwrap. Rendering it as though it were the model's own sentence would put the word
 * "[unavailable]" in a quotation attributed to the agent.
 */
export const decisionUnreadable = (approval: Approval): boolean =>
  approval.preview === '[unavailable]';

/**
 * One sentence for a failure, carrying the one thing an owner of their own box can act on.
 *
 * The API writes a request id onto every error body and onto its own log line, so quoting it is the
 * whole of the support channel a self-hosted machine has. It is absent rather than empty when the
 * answer did not come from this API — a proxy in front of it, or a request that never arrived — and
 * then nothing is said, because "request id:" with a blank after it is worse than silence.
 */
export const decisionsFailure = (cause: unknown, fallback: string): string => {
  const sentence = describeFailure(cause, fallback);
  const requestId = cause instanceof ApiFailure ? cause.requestId : undefined;
  return requestId ? `${sentence} Quote ${requestId} to find it in the box's own log.` : sentence;
};

/**
 * One decision, in the shape the settings lists around it already use.
 *
 * The facts and the model's wording are folded into a `<details>` for the same reason the card
 * separates them: the harness's own record of what was asked is what a person going back through
 * this list is looking for, and it is longer than a row. Closed, the row is the reach, the outcome
 * and the date; open, it is everything the card would have shown.
 */
export function DecisionRow({
  approval,
  status,
  now = Date.now(),
  onOpenTask
}: {
  approval: Approval;
  status: DecisionStatus;
  now?: number;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const unreadable = decisionUnreadable(approval);
  const facts = approvalFacts(approval);
  const destinations = approvalDestinations(approval);
  const wording = unreadable ? '' : agentSentence(approval);
  /* Only when there are no rows to draw: `approvalRequestText` is the raw call, and it is the
     answer for a tool this client has never heard of rather than an addition to one it has. */
  const request = facts.length || destinations.length ? '' : approvalRequestText(approval);
  // The origin recorded on the row, and only that: the trajectory-derived note the card can also
  // draw needs the conversation on screen, and this list is deliberately about the ones that are
  // not. A repeat origin across conversations is the thing this record exists to make visible.
  const provenance = approvalProvenance(approval, undefined);
  return (
    <div>
      <span>
        <strong>{approvalReach(approval)}</strong>
        <small className="decision-outcome">{decisionOutcome(approval, status, now)}</small>
        {approval.createdAt ? (
          <small>Asked {new Date(approval.createdAt).toLocaleString()}</small>
        ) : null}
        {unreadable ? (
          <small className="decision-unreadable">
            This server cannot decrypt what was asked, so only what it was allowed to do is left.
          </small>
        ) : (
          <details className="decision-detail">
            <summary>
              <small className="decision-asked">{wording || 'What was asked'}</small>
            </summary>
            {facts.length || destinations.length ? (
              <dl className="approval-facts">
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
                {/* Named below, because the fact above says they are: a `parallel_web_read` states
                    how many doors it opens and leaves the first six of them to this list. */}
                {destinations.map((destination) => (
                  <div key={destination.url} className="approval-destination">
                    <dt>Reaches</dt>
                    <dd>
                      <strong>{destination.host}</strong>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : request ? (
              /* A tool this client has no rows for, from a box newer than it. The call as it would
                 have run is the honest answer then, and it is still the harness's own record —
                 unreadable is better than persuasive, which is why it is not prose. */
              <pre className="approval-request">{request}</pre>
            ) : (
              <small className="decision-unreadable">
                Nothing was recorded about this request beyond what it was allowed to do.
              </small>
            )}
          </details>
        )}
        {provenance?.exposed ? <small className="decision-origin">{provenance.text}</small> : null}
      </span>
      {onOpenTask ? (
        <div className="settings-row-actions">
          <button type="button" onClick={() => onOpenTask(approval.taskId)}>
            Open the conversation
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The log itself, drawn from rows that are already in hand.
 *
 * Separate from the component that fetches them so what an owner reads about a lapsed request can
 * be asserted directly rather than through a spy on a request.
 */
export function DecisionsList({
  rows,
  status,
  now,
  onOpenTask
}: {
  rows: readonly Approval[];
  status: DecisionStatus;
  now?: number;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const filter = decisionStatuses.find((entry) => entry.id === status);
  return (
    <>
      <p className="memory-observed-note">{filter?.note}</p>
      {rows.length === 0 ? (
        <p className="memory-observed-note">{filter?.empty}</p>
      ) : (
        <div className="settings-list">
          {rows.map((approval) => (
            <DecisionRow
              key={approval.id}
              approval={approval}
              status={status}
              {...(now === undefined ? {} : { now })}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The record as the settings page mounts it: one line, no arguments.
 *
 * Self-contained like the review queue beside it — it fetches its own pages and owns its own failure
 * sentence — so mounting it does not thread four more pieces of state through a file that already
 * carries a hundred.
 */
export function DecisionsLog({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [status, setStatus] = useState<DecisionStatus>('pending');
  const [rows, setRows] = useState<Approval[]>();
  /*
   * Where the next page starts, taken from the page that was just read rather than from everything
   * on screen. `nextDecisionCursor` asks whether *a page* was full, so handing it the accumulated
   * list would make a second page of ten rows look like a full one and offer "Show older" for ever.
   */
  const [older, setOlder] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setRows(undefined);
    setOlder(undefined);
    setError('');
    loadDecisions(status)
      .then((page) => {
        if (!live) return;
        setRows(page);
        setOlder(nextDecisionCursor(page));
      })
      .catch((cause: unknown) => {
        if (live) setError(decisionsFailure(cause, 'That record could not be read.'));
      });
    return () => {
      live = false;
    };
  }, [status]);

  return (
    <>
      <div className="section-heading compact">
        <ScrollText />
        <div>
          <strong>Decisions</strong>
          <span>
            Every request the agent stopped to make, across all your conversations — including the
            ones that lapsed while nobody was there to answer them.
          </span>
        </div>
      </div>
      <nav className="settings-nav decisions-filter" aria-label="Decisions by outcome">
        {decisionStatuses.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === status ? 'active' : ''}
            /* `aria-current`, not `aria-pressed`: this is the same segmented nav the settings pages
               above it use, and marking one of four filters as a pressed toggle would say that the
               other three could be pressed at the same time. */
            aria-current={entry.id === status ? 'true' : undefined}
            onClick={() => setStatus(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {rows ? (
        <>
          <DecisionsList rows={rows} status={status} onOpenTask={onOpenTask} />
          {older ? (
            <p className="memory-observed-note">
              <button
                type="button"
                className="memory-observed-more"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  loadDecisions(status, older)
                    .then((page) => {
                      setRows((current) => [...(current ?? []), ...page]);
                      setOlder(nextDecisionCursor(page));
                    })
                    .catch((cause: unknown) => {
                      setError(decisionsFailure(cause, 'The older rows could not be read.'));
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Show older
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
