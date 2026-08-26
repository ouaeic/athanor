/**
 * What the computer has stopped being sure of, and the three answers an owner can give.
 *
 * Two documents and the store's own comment have promised a memory review queue for as long as the
 * memory subsystem has existed. The SQL behind it has been running all along: a procedure nobody
 * has confirmed in a season, or one that lost more of its last five uses than it won, drops out of
 * recall and is never injected again - and until this file there was nowhere to see that happen.
 * The owner's symptom was "it used to know how to do that and now it doesn't", with nothing
 * anywhere to look at.
 *
 * Three verbs, because the queue is not a delete button and that distinction is the whole reason it
 * exists. **Still right** moves the clock the queue reads and the row leaves. **Stop believing it**
 * retracts: the row stays, stops being recalled, and records that it stopped being true, which is
 * the audit trail. **Delete** removes the row and every trace of it, which is what an owner means
 * when they say a line is gone. Only the third is armed by a first press, exactly as the remembered
 * list below it arms its own delete: the other two are recoverable by the box itself, and putting a
 * dialog in front of them would dress an ordinary correction as the approval floor.
 *
 * Self-contained on purpose. It fetches its own queue and owns its own failure sentence, so
 * mounting it is one line in the settings page rather than four pieces of state threaded through a
 * file that already carries a hundred.
 */
import { useEffect, useState } from 'react';
import { BookOpenText, Trash2, X } from 'lucide-react';
import { api, type MemoryReview as MemoryReviewQueue, type MemoryReviewItem } from './api.js';
import { ApiFailure } from './api-failure.js';
import { describeFailure } from './failure-text.js';
import './memory-review.css';

/** A remembered command the queue is no longer sure of, with the reason it is here. */
type ProcedureRow = MemoryReviewQueue['procedures'][number];

/** Two things the owner said that contradict each other, carrying the ids of the other side. */
type DisputedRow = MemoryReviewQueue['disputed'][number];

/** The three verbs, named as the store names them rather than as the buttons read. */
export type MemoryReviewVerb = 'verify' | 'retract' | 'forget';

/** A date said the way a person says one, or nothing at all when the field is empty. */
const on = (value: string | null): string | null =>
  value === null ? null : new Date(value).toLocaleDateString();

/** `1 of the last 1 time` is not a sentence anybody wrote on purpose. */
const times = (count: number): string => (count === 1 ? 'time' : 'times');

/**
 * Why this procedure is in the queue, in the case's own words.
 *
 * There are three cases and not two, and the store's own comment insists they mean opposite things
 * to whoever is reading: a procedure nobody has confirmed in a season may be perfectly good and
 * merely unused, while one that lost most of its recent uses is broken now. Collapsing them into
 * one "stale" would tell the owner to delete something that was only ever quiet.
 *
 * The horizon is stated as the date it was last confirmed rather than as "in six months", because
 * the number of days is the server's to choose - it is a query parameter this client does not send
 * - and a client that hard-codes the default is asserting something it has not been told.
 */
export const memoryReviewReason = (row: ProcedureRow): string => {
  const unverified = `Nobody has confirmed this since ${
    on(row.lastVerified) ?? on(row.observedAt) ?? 'it was written down'
  }. It may still be right and merely unused.`;
  const failing =
    `It worked ${row.recentOkCount} of the last ${row.recentGradedCount} ` +
    `${times(row.recentGradedCount)} it was used, so this one is failing now rather than idle.`;
  if (row.reason === 'unverified') return unverified;
  if (row.reason === 'failing') return failing;
  return `${failing} ${unverified}`;
};

/**
 * What a decision about this row would actually rest on.
 *
 * The review route projects all of it - which conversation wrote it, how far it is trusted, when it
 * was last confirmed, what it has been worth in use - precisely because the narrower memory list
 * drops every one of those fields, and "delete this or keep it" is unanswerable without them.
 */
export const memoryReviewFacts = (item: MemoryReviewItem): string[] => {
  const facts = [
    item.trust === 'stated'
      ? 'You said this; the box did not work it out.'
      : 'The box worked this out for itself.',
    `Written down ${on(item.observedAt) ?? 'at an unrecorded time'}.`,
    item.lastVerified === null
      ? 'Never confirmed since.'
      : `Last confirmed ${on(item.lastVerified) ?? 'at an unrecorded time'}.`
  ];
  if (item.validTo !== null) facts.push(`Was only meant to hold until ${on(item.validTo) ?? '—'}.`);
  facts.push(
    item.useCount === 0
      ? 'It has never been used.'
      : `Used ${item.useCount} ${times(item.useCount)}: it worked ${item.okCount} and failed ` +
          `${item.failCount}.`
  );
  if (item.pin) facts.push('Pinned, so the curation that files rows away leaves it alone.');
  return facts;
};

/**
 * The other side of a dispute, said as a line rather than as a row of identifiers.
 *
 * The route carries the ids because "this is disputed" with no answer to "with what" is not
 * something a person can act on, and the ids alone are no better: both sides are in the same
 * answer, so the other one is looked up here and shown in its own words. When it is not - it may
 * have been retracted or deleted since the pair was written - that is said rather than papered
 * over with a hexadecimal string nothing on this screen can resolve.
 */
export const memoryReviewContradictions = (
  row: DisputedRow,
  disputed: readonly MemoryReviewItem[]
): string[] =>
  row.contradicts.map(
    (id) =>
      disputed.find((other) => other.id === id)?.excerpt ??
      'The other side of this is not in the list; it may already have been retracted or deleted.'
  );

/**
 * The server sends the opening of a stored row, not the whole of it.
 *
 * `memoryItemExcerpt` clamps at 200 characters and marks the cut with an ellipsis, which is the
 * only signal there is that more is held. Saying so is the honest half of "read the whole of what
 * was remembered": the rest is on the box's disk and no route reaches it yet, and an expander that
 * opened onto the same 200 characters while implying otherwise would be one more control that
 * lies.
 */
export const memoryExcerptIsClipped = (excerpt: string): boolean => excerpt.endsWith('…');

/** The queue without one row, whatever list it was in. */
export const withoutMemoryItem = (queue: MemoryReviewQueue, itemId: string): MemoryReviewQueue => ({
  procedures: queue.procedures.filter((row) => row.id !== itemId),
  disputed: queue.disputed.filter((row) => row.id !== itemId)
});

/**
 * Run one verb against the box and hand back the queue the answer implies.
 *
 * Every one of the three removes the row from this screen, and each for its own reason: a verified
 * procedure has had the clock the queue reads moved past the horizon, a retracted one is no longer
 * `active`, and a deleted one is gone. Refetching to discover that would cost a round trip to be
 * told what the verb already means.
 *
 * A 404 removes it too. The two POSTs answer `memory_item_not_found` rather than `{verified:false}`
 * deliberately - the route's own comment says a client shown 200-with-false would have to guess -
 * and what it means here is that the screen is holding a row the box does not have. Leaving it up
 * would be the interface insisting on something it has just been told is not there. Anything else
 * is a real failure and is thrown, because a row that quietly disappears on a network blip is the
 * same defect from the other side.
 */
export const applyMemoryReviewVerb = async (
  workspaceId: string,
  itemId: string,
  verb: MemoryReviewVerb,
  queue: MemoryReviewQueue
): Promise<MemoryReviewQueue> => {
  try {
    if (verb === 'verify') await api.verifyMemoryItem(workspaceId, itemId);
    else if (verb === 'retract') await api.retractMemoryItem(workspaceId, itemId);
    else await api.deleteMemoryItem(workspaceId, itemId);
  } catch (cause) {
    if (!(cause instanceof ApiFailure) || cause.status !== 404) throw cause;
  }
  return withoutMemoryItem(queue, itemId);
};

/**
 * One sentence for a failure, carrying the one thing an owner of their own box can act on.
 *
 * The API writes a request id onto every error body and its own log line, so quoting it is the
 * whole of the support channel a self-hosted machine has. It is absent rather than empty when the
 * answer did not come from this API at all - a proxy, or a transport that never arrived - and in
 * that case nothing is said, because "request id:" with a blank after it is worse than silence.
 */
export const memoryReviewFailure = (cause: unknown, fallback: string): string => {
  const sentence = describeFailure(cause, fallback);
  const requestId = cause instanceof ApiFailure ? cause.requestId : undefined;
  return requestId ? `${sentence} Quote ${requestId} to find it in the box's own log.` : sentence;
};

/**
 * One row, in the shape the remembered list below it already uses.
 *
 * The excerpt is the summary of a `<details>`: closed, the stylesheet holds it to two lines; open,
 * it runs its full length and the provenance follows it. That is the expander this row needed and
 * it costs no state and no script - `<details>` renders its content either way, so what is on
 * screen is the only thing that changes.
 */
function MemoryReviewRow({
  item,
  headline,
  reason,
  extra,
  verbs,
  onAct,
  onOpenTask,
  busy
}: {
  item: MemoryReviewItem;
  headline: string;
  reason: string;
  /** Lines that belong to this kind of row alone, such as the other side of a dispute. */
  extra?: string[];
  verbs: readonly MemoryReviewVerb[];
  onAct: (verb: MemoryReviewVerb, item: MemoryReviewItem) => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const taskId = item.taskId;
  return (
    <div>
      <span>
        <strong>{headline}</strong>
        <details className="memory-review-detail">
          <summary>
            <small className="memory-review-excerpt">{item.excerpt}</small>
          </summary>
          {memoryExcerptIsClipped(item.excerpt) ? (
            <small className="memory-review-clipped">
              This is the opening of what is stored. The rest is on your box and no screen reaches
              it yet.
            </small>
          ) : null}
          {memoryReviewFacts(item).map((fact) => (
            <small key={fact}>{fact}</small>
          ))}
          {taskId !== null && onOpenTask ? (
            <button
              type="button"
              className="memory-review-source"
              onClick={() => onOpenTask(taskId)}
            >
              Open the conversation this came from
            </button>
          ) : null}
        </details>
        <small className="memory-review-reason">{reason}</small>
        {extra?.map((line) => (
          <small key={line} className="memory-review-against">
            {line}
          </small>
        ))}
      </span>
      {armed ? (
        <div className="settings-row-actions">
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              setArmed(false);
              onAct('forget', item);
            }}
          >
            Delete for good
          </button>
          <button className="icon-btn" aria-label="Keep it" onClick={() => setArmed(false)}>
            <X />
          </button>
        </div>
      ) : (
        <div className="settings-row-actions">
          {verbs.includes('verify') ? (
            <button disabled={busy} onClick={() => onAct('verify', item)}>
              Still right
            </button>
          ) : null}
          <button disabled={busy} onClick={() => onAct('retract', item)}>
            Stop believing it
          </button>
          <button
            className="icon-btn"
            aria-label="Delete what was remembered"
            onClick={() => setArmed(true)}
          >
            <Trash2 />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The queue itself, drawn from an answer that is already in hand.
 *
 * Separate from the component that fetches it so the two lists can be rendered and read without a
 * server: what is on this screen decides whether an owner deletes a working procedure, and that is
 * worth asserting directly rather than through a spy on a request.
 */
export function MemoryReviewLists({
  queue,
  onAct,
  onOpenTask,
  busy = false
}: {
  queue: MemoryReviewQueue;
  onAct: (verb: MemoryReviewVerb, item: MemoryReviewItem) => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
  busy?: boolean;
}) {
  return (
    <>
      {queue.procedures.length > 0 ? (
        <>
          {/*
            The claim in this sentence is checkable, which is why it is put this plainly: the recall
            statement gates procedures on the same two criteria this list is built from, with the
            same two constants, and its own comment says so - "a wrong remembered command is worse
            than no command: an unverified or failing procedure stops being injected here, but the
            row itself is never deleted". So one of these rows really has stopped being used, and
            this list really is the only place that says so.
          */}
          <p className="memory-observed-note">
            Remembered ways of doing things that have stopped being certain. A procedure the box is
            no longer sure of stops being used, quietly, and this is the only place that says so.
            Saying it is still right puts it back to work; stopping believing it keeps the line and
            the record that it stopped being true.
          </p>
          <div className="settings-list">
            {queue.procedures.map((row) => (
              <MemoryReviewRow
                key={row.id}
                item={row}
                headline={
                  row.reason === 'failing'
                    ? 'Failing now'
                    : row.reason === 'both'
                      ? 'Failing, and unconfirmed'
                      : 'Not confirmed in a long time'
                }
                reason={memoryReviewReason(row)}
                /* Verify is offered here and nowhere else: the statement behind it updates a row
                   only when the row is a procedure, so offering it on a disputed fact would be a
                   button that answers 404 every time it is pressed. */
                verbs={['verify', 'retract', 'forget']}
                onAct={onAct}
                onOpenTask={onOpenTask}
                busy={busy}
              />
            ))}
          </div>
        </>
      ) : null}
      {queue.disputed.length > 0 ? (
        <>
          {/*
            "Ordinary recall" and not "recall": the admissibility clause drops a disputed row unless
            the caller asks for what the box has stopped believing by name, which the agent's own
            recall tool can still do. Saying it flatly would be a smaller sentence and a false one.
          */}
          <p className="memory-observed-note">
            Two things it holds that cannot both be true. A line in dispute is left out of ordinary
            recall, so neither of these is doing any work while they disagree; stopping believing
            the wrong one settles it and leaves the other standing.
          </p>
          <div className="settings-list">
            {queue.disputed.map((row) => (
              <MemoryReviewRow
                key={row.id}
                item={row}
                headline={row.trust === 'stated' ? 'You said this' : 'The box worked this out'}
                reason="This contradicts something else it holds."
                extra={memoryReviewContradictions(row, queue.disputed).map(
                  (line) => `It disagrees with: ${line}`
                )}
                verbs={['retract', 'forget']}
                onAct={onAct}
                onOpenTask={onOpenTask}
                busy={busy}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * The review queue as the settings page mounts it: one line, one workspace id.
 *
 * An empty queue says so rather than drawing nothing. Three documents promise this screen, and an
 * owner who came looking for it because of one of them cannot tell a queue with nothing in it from
 * a queue that was never built - which is the defect this whole file is here to remove.
 */
export function MemoryReview({
  workspaceId,
  onOpenTask
}: {
  workspaceId: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const [queue, setQueue] = useState<MemoryReviewQueue>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setQueue(undefined);
    setError('');
    api
      .memoryReview(workspaceId)
      .then((answer) => {
        if (live) setQueue(answer);
      })
      .catch((cause: unknown) => {
        if (live) setError(memoryReviewFailure(cause, 'The review queue could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const act = (verb: MemoryReviewVerb, item: MemoryReviewItem): void => {
    if (!queue) return;
    setBusy(true);
    setError('');
    applyMemoryReviewVerb(workspaceId, item.id, verb, queue)
      .then(setQueue)
      .catch((cause: unknown) => {
        setError(memoryReviewFailure(cause, 'That did not reach your box; nothing has changed.'));
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="section-heading compact">
        <BookOpenText />
        <div>
          <strong>Needs review</strong>
          <span>
            What the computer has stopped being sure of, and what it holds that disagrees with
            itself.
          </span>
        </div>
      </div>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {queue ? (
        queue.procedures.length + queue.disputed.length === 0 ? (
          <p className="memory-observed-note">
            Nothing needs review: every remembered way of doing things has been confirmed recently
            enough, and nothing it holds disagrees with anything else.
          </p>
        ) : (
          <MemoryReviewLists queue={queue} onAct={act} onOpenTask={onOpenTask} busy={busy} />
        )
      ) : null}
    </>
  );
}
