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
import {
  api,
  type MemoryItemOrigin,
  type MemoryReview as MemoryReviewQueue,
  type MemoryReviewItem
} from './api.js';
import { ApiFailure } from './api-failure.js';
import { describeFailure } from './failure-text.js';
import { memoryItemBody } from './memory-api.js';
import './memory-review.css';

/** A remembered command the queue is no longer sure of, with the reason it is here. */
type ProcedureRow = MemoryReviewQueue['procedures'][number];

/** Two things the owner said that contradict each other, carrying the ids of the other side. */
type DisputedRow = MemoryReviewQueue['disputed'][number];

/** A rule a model put forward, which nothing believes yet and the owner can refuse outright. */
type MemoryProposalRow = MemoryReviewQueue['proposals'][number];

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
 * Where a row came from, in three words rather than two.
 *
 * Every screen that has ever shown this drew it off `trust`, which has two values in use and calls
 * two entirely different things `derived`: a sentence a model wrote about the owner out of their
 * own messages, and a command the harness ran and watched the result of. So "the box worked this
 * out for itself" was said equally over a rule that is obeyed in every later conversation and over
 * a note that `pnpm check` passed - and the first of those is the one the owner would want to
 * argue with. The route answers the three-way question now and this is where it is read.
 */
export const memoryOriginLabel = (origin: MemoryItemOrigin): string =>
  origin === 'stated'
    ? 'You said this'
    : origin === 'proposed'
      ? 'A model wrote this'
      : 'The box watched this';

/**
 * The same three, said as the sentence a person would say, for the row's own expander.
 *
 * Longer than the label because the label is a heading and this is the claim. The middle one is the
 * whole reason the distinction exists: a promoted proposal is a machine's wording of something the
 * owner said, it is pinned in front of every later task in the workspace, and nothing on any screen
 * used to say so.
 */
export const memoryOriginFact = (origin: MemoryItemOrigin): string =>
  origin === 'stated'
    ? 'You said this; the box did not work it out.'
    : origin === 'proposed'
      ? 'A model wrote this sentence out of your own messages. The words are its, not yours, and it is acted on like the rest.'
      : 'The box wrote this down as it watched the work: nobody said it and no model was asked for it.';

/**
 * What a decision about this row would actually rest on.
 *
 * The review route projects all of it - which conversation wrote it, where it came from, when it
 * was last confirmed, what it has been worth in use - and "delete this or keep it" is unanswerable
 * without them.
 */
export const memoryReviewFacts = (item: MemoryReviewItem): string[] => {
  const facts = [
    memoryOriginFact(item.origin),
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
 * only signal there is that more is held. That was the whole of the promise until now: the rest
 * was on the box's disk with no route reaching it, and the row said so. `GET
 * .../memory-items/:itemId` reaches it, so a clipped row is now the cue to offer the rest rather
 * than to apologise for not having it.
 */
export const memoryExcerptIsClipped = (excerpt: string): boolean => excerpt.endsWith('…');

/**
 * Whether opening this row should ask the box for the rest of it.
 *
 * A value rather than four conditions inside a JSX handler, because there is no DOM in this
 * package's tests and this is the whole of the behaviour: `<details>` fires `toggle` on close as
 * loudly as on open, a row already read is still read when it is reopened, an unclipped excerpt is
 * the whole row already, and a screen mounted without a reader has nothing to ask.
 */
export const shouldReadWhole = (state: {
  open: boolean;
  excerpt: string;
  alreadyRead: boolean;
  hasReader: boolean;
}): boolean =>
  state.open && state.hasReader && !state.alreadyRead && memoryExcerptIsClipped(state.excerpt);

/** The queue without one row, whatever list it was in. */
export const withoutMemoryItem = (queue: MemoryReviewQueue, itemId: string): MemoryReviewQueue => ({
  procedures: queue.procedures.filter((row) => row.id !== itemId),
  disputed: queue.disputed.filter((row) => row.id !== itemId),
  proposals: queue.proposals
});

/**
 * The queue without a whole group of proposals, named one by one.
 *
 * Not `proposals: []`. The screen refuses exactly the handles it was showing, so anything the box
 * put forward while the owner was reading is still there afterwards - which is the same rule the
 * route keeps on its own side, and the reason neither end has a "refuse everything" flag.
 */
export const withoutMemoryProposals = (
  queue: MemoryReviewQueue,
  proposalIds: readonly string[]
): MemoryReviewQueue => {
  const refused = new Set(proposalIds);
  return { ...queue, proposals: queue.proposals.filter((row) => !refused.has(row.id)) };
};

/** The queue without one proposal, which is addressed by its own id and never by an item's. */
export const withoutMemoryProposal = (
  queue: MemoryReviewQueue,
  proposalId: string
): MemoryReviewQueue => withoutMemoryProposals(queue, [proposalId]);

/** Nothing to review at all, which is three empty lists and not two. */
export const memoryReviewIsEmpty = (queue: MemoryReviewQueue): boolean =>
  queue.procedures.length + queue.disputed.length + queue.proposals.length === 0;

/**
 * What a proposal still has to do, said as the thing that has not happened yet.
 *
 * Two sightings at least a day apart, and this line exists because the natural reading of a list
 * like this is "the computer has decided these". It has not. A proposal is a sentence a model
 * offered once; it is not injected into anything, it changes nothing, and it stays that way until
 * the same sentence is put forward again from a different conversation on a later day.
 */
export const memoryProposalStanding = (proposal: MemoryProposalRow): string => {
  const drawn =
    proposal.sightings === 1
      ? `Put forward once, from a conversation on ${on(proposal.firstSeen) ?? 'an unrecorded day'}.`
      : `Put forward ${proposal.sightings} times, between ${
          on(proposal.firstSeen) ?? '—'
        } and ${on(proposal.lastSeen) ?? '—'}.`;
  const needed =
    proposal.sightings < 2 || proposal.needsAnotherDay
      ? 'It has to come up again on a later day before this computer acts on it.'
      : 'It has met the bar and will become something this computer acts on.';
  return `${drawn} ${needed}`;
};

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
 * "No, don't remember that", about one rule or about the whole group, and the queue that leaves.
 *
 * One function for both gestures, so the round trip is assertable rather than living inside a
 * handler: what leaves this file for the box, and what the screen does with the answer, are the two
 * halves of a refusal that is permanent, and the second half is where a refusal goes wrong silently.
 *
 * Two bodies, deliberately. A single row's button sends the handle the route has always taken; the
 * group's button sends the list. Collapsing them onto the array would leave the route's single form
 * with nothing that sends it, which is exactly the shape of a feature nobody exercises - and the
 * two really are different gestures, which is worth saying on the wire.
 *
 * One request for the group rather than one per row. Twenty presses behind twenty idempotency keys
 * can half-succeed, and a screen holding the half that failed cannot say which half that was.
 *
 * A 404 takes the rows away too, exactly as the three verbs above do: the route answers
 * `memory_proposal_not_found` when NONE of the handles named is an open proposal in this workspace,
 * which means the screen is holding rows the box does not have. Anything else is a real failure and
 * is thrown, because a proposal that quietly vanishes on a network blip would leave the owner
 * believing they had refused something they had not.
 */
export const refuseMemoryProposals = async (
  workspaceId: string,
  proposals: readonly { id: string }[],
  queue: MemoryReviewQueue
): Promise<MemoryReviewQueue> => {
  const ids = proposals.map((proposal) => proposal.id);
  if (ids.length === 0) return queue;
  try {
    const only = ids.length === 1 ? ids[0] : undefined;
    if (only !== undefined) await api.dismissMemoryProposal(workspaceId, only);
    else await api.dismissMemoryProposals(workspaceId, ids);
  } catch (cause) {
    if (!(cause instanceof ApiFailure) || cause.status !== 404) throw cause;
  }
  return withoutMemoryProposals(queue, ids);
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
  onReadWhole,
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
  onReadWhole?: ((item: MemoryReviewItem) => Promise<string>) | undefined;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);
  /** Undefined until the row is opened, which is the point: fifty bodies for one question is not. */
  const [whole, setWhole] = useState<string>();
  const [wholeError, setWholeError] = useState('');
  const clipped = memoryExcerptIsClipped(item.excerpt);
  const taskId = item.taskId;
  return (
    <div>
      <span>
        <strong>{headline}</strong>
        {/*
          The fetch hangs off `onToggle` rather than off a button, because the expander is already
          the gesture that means "show me this one" — and `<details>` fires it on open and on close
          alike, so the guard is on `open`. Once, too: a row read and closed and reopened does not
          go back to the box for something it is still holding.
        */}
        <details
          className="memory-review-detail"
          onToggle={(event) => {
            if (
              !onReadWhole ||
              !shouldReadWhole({
                open: event.currentTarget.open,
                excerpt: item.excerpt,
                alreadyRead: whole !== undefined,
                hasReader: true
              })
            )
              return;
            setWholeError('');
            onReadWhole(item)
              .then(setWhole)
              .catch((cause: unknown) => {
                setWholeError(
                  memoryReviewFailure(cause, 'The rest of this could not be read from your box.')
                );
              });
          }}
        >
          <summary>
            <small className="memory-review-excerpt">{item.excerpt}</small>
          </summary>
          {/*
            Three states and each says a different true thing. The whole body, once it has arrived,
            replaces the excerpt's ellipsis with the text it was standing in for. A failure says so
            and keeps the opening, because a row the owner can no longer read any of is worse than
            one they can read the start of. And a screen mounted without a reader keeps the old
            sentence rather than drawing an expander onto nothing.
          */}
          {clipped && whole !== undefined ? (
            <small className="memory-review-whole">{whole}</small>
          ) : null}
          {clipped && whole === undefined && wholeError ? (
            <small className="memory-review-clipped" role="alert">
              {wholeError}
            </small>
          ) : null}
          {clipped && whole === undefined && !wholeError ? (
            <small className="memory-review-clipped">
              {onReadWhole
                ? 'This is the opening of what is stored; the rest is being read from your box.'
                : 'This is the opening of what is stored. The rest is on your box and no screen reaches it yet.'}
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
  onReadWhole,
  onDismiss,
  onDismissAll,
  busy = false
}: {
  queue: MemoryReviewQueue;
  onAct: (verb: MemoryReviewVerb, item: MemoryReviewItem) => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
  /**
   * How to fetch the rest of a clipped row, passed in rather than reached for.
   *
   * The same reason this component takes its queue instead of fetching one: what is on this screen
   * decides whether an owner deletes a working procedure, and the whole of a row is now part of
   * that. A stub here makes the expander assertable without a server. Optional, so a caller that
   * has no reader draws the old sentence rather than an expander onto nothing.
   */
  onReadWhole?: ((item: MemoryReviewItem) => Promise<string>) | undefined;
  /**
   * How to refuse a proposal, passed in like everything else here and optional like the reader.
   *
   * Optional so this component still renders without one, and the list draws no button when there
   * is nothing behind it — a refuse button that does nothing is worse than no list at all, because
   * the owner would believe they had refused something.
   */
  onDismiss?: ((proposal: MemoryProposalRow) => void) | undefined;
  /**
   * How to refuse the whole group at once, and the reason it is a separate prop rather than a loop
   * over `onDismiss`.
   *
   * Twenty presses to say one thing is the interface asking somebody to do a machine's counting,
   * and this queue in particular is never drained by anything else: the proposer stops outright
   * when the list is full, so a screenful nobody can clear in one gesture is a mechanism that
   * silently switches itself off. It is also one request rather than twenty, so the group either
   * lands or does not, instead of the screen ending up in a state neither end can name.
   */
  onDismissAll?: ((proposals: readonly MemoryProposalRow[]) => void) | undefined;
  busy?: boolean;
}) {
  /**
   * Armed by a first press, exactly as the delete inside a row is.
   *
   * A refusal here is permanent and this one is permanent twenty times over, so it is the one
   * control on this screen that would be worth a dialog - except that a dialog is what the approval
   * floor wears, and this is the owner acting on their own record on their own machine. The arming
   * is the same gesture the rest of the file already uses for exactly that reason.
   */
  const [refuseAllArmed, setRefuseAllArmed] = useState(false);
  return (
    <>
      {queue.proposals.length > 0 ? (
        <>
          {/*
            The strongest claim on this screen and the one most worth getting exactly right: these
            are not memories. A model read a day of the owner's own messages and offered a sentence;
            the store put it in the candidate table behind the same two-sightings-a-day-apart gate
            every observed candidate faces, and nothing recalls it, injects it or obeys it until it
            clears that gate. The note says so first, before any row, because a list of rules under
            a heading about memory reads as a list of things the computer has decided.
          */}
          <p className="memory-observed-note">
            Rules that have been put forward about how this computer should work, drawn from your
            own messages. None of them is remembered yet, and none of them is doing anything: a rule
            has to come up again from another conversation on a later day before this computer acts
            on it. Refusing one is permanent — it will not be put forward again.{' '}
            {/*
              The group refusal, in the note rather than in the list, because the note is what the
              group has instead of a row: these are twenty sentences a model wrote about the owner
              and "no, none of this" is one decision rather than twenty. Offered only from two,
              since "Refuse all 1" beside a row that already carries its own button is a second
              control for the same press. Armed first, like every other permanent thing here.
            */}
            {onDismissAll && queue.proposals.length > 1 ? (
              refuseAllArmed ? (
                <>
                  <button
                    type="button"
                    className="memory-observed-more"
                    disabled={busy}
                    onClick={() => {
                      setRefuseAllArmed(false);
                      onDismissAll(queue.proposals);
                    }}
                  >
                    Yes, refuse all {queue.proposals.length}
                  </button>{' '}
                  <button
                    type="button"
                    className="memory-observed-more"
                    onClick={() => setRefuseAllArmed(false)}
                  >
                    Keep them
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="memory-observed-more"
                  disabled={busy}
                  onClick={() => setRefuseAllArmed(true)}
                >
                  Refuse all {queue.proposals.length}
                </button>
              )
            ) : null}
          </p>
          <div className="settings-list">
            {queue.proposals.map((proposal) => (
              <div key={proposal.id}>
                <span>
                  <strong>Put forward, not remembered</strong>
                  <small className="memory-review-excerpt">{proposal.sentence}</small>
                  <small className="memory-review-reason">{memoryProposalStanding(proposal)}</small>
                </span>
                {onDismiss ? (
                  <div className="settings-row-actions">
                    <button disabled={busy} onClick={() => onDismiss(proposal)}>
                      Don&rsquo;t remember this
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
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
                onReadWhole={onReadWhole}
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
                headline={memoryOriginLabel(row.origin)}
                reason="This contradicts something else it holds."
                extra={memoryReviewContradictions(row, queue.disputed).map(
                  (line) => `It disagrees with: ${line}`
                )}
                verbs={['retract', 'forget']}
                onAct={onAct}
                onOpenTask={onOpenTask}
                onReadWhole={onReadWhole}
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

  /**
   * The rest of one row, read from the box on the press that asks for it.
   *
   * A row this key will not open comes back `readable: false` carrying the same standing sentence
   * the lists use rather than an error, and it is shown as the body it is: the row is on the
   * owner's disk either way, and a screen that threw would hide the one row they would most want
   * to reach. A failure to reach the box at all is different and is thrown, which the expander
   * catches and says beside the excerpt it still has.
   */
  const readWhole = (item: MemoryReviewItem): Promise<string> =>
    memoryItemBody(workspaceId, item.id).then((answer) => answer.body);

  /**
   * "No, don't remember that", about one row or about the group, and the rows leave on the answer
   * rather than on a refetch.
   *
   * One handler for both presses, because they are one statement: the whole of the difference is
   * how many handles are named, and `refuseMemoryProposals` is where that is decided and where it
   * is asserted. Exactly the handles that were on screen, so a proposal written between the screen
   * being drawn and the button being pressed survives, unseen and unrefused - which is what a
   * permanent refusal owes anything nobody has looked at.
   */
  const refuse = (proposals: readonly MemoryProposalRow[]): void => {
    if (!queue) return;
    setBusy(true);
    setError('');
    refuseMemoryProposals(workspaceId, proposals, queue)
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
            What the computer has stopped being sure of, what it holds that disagrees with itself,
            and what has been put forward about you that it does not believe yet.
          </span>
        </div>
      </div>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {queue ? (
        memoryReviewIsEmpty(queue) ? (
          <p className="memory-observed-note">
            Nothing needs review: every remembered way of doing things has been confirmed recently
            enough, nothing it holds disagrees with anything else, and nothing has been put forward
            for you to look at.
          </p>
        ) : (
          <MemoryReviewLists
            queue={queue}
            onAct={act}
            onOpenTask={onOpenTask}
            onReadWhole={readWhole}
            onDismiss={(proposal) => refuse([proposal])}
            onDismissAll={refuse}
            busy={busy}
          />
        )
      ) : null}
    </>
  );
}
