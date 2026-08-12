import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { BookOpen, LockKeyhole, MessageSquare, ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import {
  approvalAnnouncement,
  approvalDiffState,
  approvalReach,
  expiryPhrase,
  needsComputer,
  nextApproval
} from './approval-copy.js';
import { decisionKey } from './shortcuts.js';
import {
  agentSentence,
  approvalDestinations,
  approvalFacts,
  approvalRequestText
} from './approval-facts.js';
import { DiffView } from './DiffView.js';
import { fileChangesFromTool, type FileChange } from './diff.js';
import { contextNote } from './provenance.js';
import type { Approval, TaskEvent } from './types.js';

/**
 * The change a file-touching approval would make, taken from the arguments the approval is bound
 * to. `file_write` only carries the new contents, so the current file is read back to diff
 * against; if it does not exist yet the diff correctly shows a new file.
 */
const useApprovalDiffs = (
  approvalId: string,
  workspaceId: string | undefined,
  changes: FileChange[]
): { changes: FileChange[]; ready: boolean } => {
  const [current, setCurrent] = useState<Record<string, string | null>>({});
  const missing = changes
    .filter((change) => change.before === undefined)
    .map((change) => change.path)
    .join('\n');
  useEffect(() => {
    setCurrent({});
    if (!workspaceId || !missing) return;
    let active = true;
    void Promise.all(
      missing.split('\n').map(async (path) => {
        const bytes = await api.file(workspaceId, path).catch(() => undefined);
        return [path, bytes ? new TextDecoder().decode(new Uint8Array(bytes)) : null] as const;
      })
    ).then((entries) => {
      if (active) setCurrent(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [approvalId, workspaceId, missing]);
  return approvalDiffState(changes, current);
};

/**
 * The half of the card the agent did not write.
 *
 * Every row here is read out of the argument object the worker will execute, which the approval
 * carries a hash of and re-checks before it acts. The heading says where it came from, because the
 * whole value of the separation is that the owner can tell which half is which — a card whose facts
 * and whose prose look alike is a card whose prose still does the persuading.
 */
function RequestFacts({ approval }: { approval: Approval }) {
  const facts = approvalFacts(approval);
  const destinations = approvalDestinations(approval);
  if (!facts.length && !destinations.length) {
    const request = approvalRequestText(approval);
    return request ? <pre className="approval-request">{request}</pre> : null;
  }
  return (
    <dl className="approval-facts">
      {facts.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
      {destinations.map((destination) => (
        <div key={destination.url} className="approval-destination">
          <dt>Reaches</dt>
          <dd>
            <strong>{destination.host}</strong>
            {destination.carriedCharacters > 0 && (
              <span>
                {' '}
                · the address carries {destination.carriedCharacters} characters of data past the
                host
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Approvals({
  approvals,
  workspaceId,
  openTaskId,
  taskTitles,
  openTaskEvents,
  onOpenTask,
  onOpenComputer,
  onAnnounce,
  cardRef,
  failure,
  onResolve
}: {
  approvals: Approval[];
  workspaceId?: string;
  openTaskId: string | undefined;
  /**
   * What each conversation is called, so a request raised in one the owner is not looking at can say
   * which one. `nextApproval` deliberately surfaces requests from any conversation, so the common
   * case is a card asking about a shell command that belongs somewhere else - and the card said
   * nothing about that at all, offering only an unnamed "Open conversation".
   */
  taskTitles?: Record<string, string>;
  /**
   * The trajectory of the conversation on screen, when there is one, so the card can say whether
   * the agent asking had anybody else's text in its context. Only ever read for an approval that
   * belongs to that conversation: for one raised elsewhere the card offers to open it instead of
   * answering a question it cannot answer.
   */
  openTaskEvents?: TaskEvent[];
  onOpenTask?: (taskId: string) => void;
  /** The browser is part of the computer's screen, so a handoff of either lands in one place. */
  onOpenComputer?: () => void;
  /**
   * Said once, through the one polite region the window already has.
   *
   * The card announced itself by being an assertive live region, which meant it announced itself
   * again on every countdown tick. See `approvalAnnouncement`: arrival is news, 43 seconds becoming
   * 23 seconds is not.
   */
  onAnnounce?: (message: string) => void;
  /**
   * The card itself, so the window can send the owner back to it from the palette entry — the only
   * route, deliberately: see `windowShortcut`. A request answered from the keyboard is otherwise
   * reachable only by Shift+Tabbing out of the composer and hoping.
   */
  cardRef?: RefObject<HTMLDivElement | null>;
  /**
   * Why the last answer did not land, and which request it was about.
   *
   * Said here rather than in the strip above the composer because this card is what occupies that
   * strip while a decision is pending: sent there it would never be drawn, and Approve would once
   * again do nothing visible at all. Carried with its request's id because the pending list is
   * refetched every few seconds and the next card up must not inherit the last one's failure.
   */
  failure?: { approvalId: string; message: string };
  onResolve: (id: string, decision: 'approve' | 'deny') => Promise<void>;
}) {
  const item = nextApproval(approvals, openTaskId);
  // The countdown has to move on its own; the approval list is refetched far less often than the
  // last minute of an expiry window is worth watching. It moves on screen only — nothing here is a
  // live region any more, so this tick no longer talks over whoever is reading the command.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((current) => current + 1), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  const ownCard = useRef<HTMLDivElement | null>(null);
  const card = cardRef ?? ownCard;
  /*
   * Focus goes to the request the moment there is one, and again when a different one takes its
   * place. Both halves matter. The first is simply that it is the owner's turn: this is not a
   * banner reporting something, it is a question with the agent stopped in front of it. The second
   * is the safety half — the buttons are reused across requests, so leaving focus on Approve while
   * the card underneath it becomes a *different* decision is one stray Enter from answering a
   * question nobody read.
   *
   * Keyed on the id rather than on the render: the countdown re-renders this four times a minute,
   * and a card that grabbed focus back on every tick would be unusable.
   *
   * Never out of a field somebody is typing in, though. A request arrives on a poll, at a moment
   * the owner did not choose, and pulling the caret out of the message box mid-sentence sends the
   * next few keystrokes to a div that does nothing with them — they are simply gone. The card is
   * on screen, the polite region has said so, and the palette carries the labelled way to it, so
   * nothing is lost by letting a typist finish their word.
   */
  useEffect(() => {
    if (!item) return;
    const focused = document.activeElement;
    const typing =
      focused instanceof HTMLElement &&
      (focused.isContentEditable || ['INPUT', 'TEXTAREA'].includes(focused.tagName));
    if (!typing) card.current?.focus();
  }, [item?.id]);
  /*
   * Announced once per request, through the window's polite region. Deliberately after the focus
   * move above, which is what a screen reader reads first; this adds the fact that something is now
   * waiting, for the case where the owner's attention was somewhere else entirely.
   */
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = approvalAnnouncement({
      approval: item,
      waiting: approvals.length,
      announcedId: announced.current
    });
    if (!next) return;
    announced.current = next.id;
    onAnnounce?.(next.message);
  }, [item?.id]);
  /*
   * The two answers, bound on the card rather than on the window, so they exist exactly while the
   * owner is inside the decision and nowhere else. Listened for on the element instead of through
   * JSX because the keystroke has to stop here: Escape carries on to the window and still stops the
   * agent, but an answer must not also be read as something else on its way past.
   *
   * The handler is re-read from a ref so that re-binding is keyed on which request is on screen —
   * `onResolve` is an inline closure in App and changes on every render, and a listener that
   * detached and reattached four times a minute would eventually do it between keydown and the
   * decision landing.
   */
  const resolve = useRef(onResolve);
  useEffect(() => {
    resolve.current = onResolve;
  });
  useEffect(() => {
    const node = card.current;
    const id = item?.id;
    if (!node || !id) return;
    const answer = (event: KeyboardEvent) => {
      const decision = decisionKey(event);
      if (!decision) return;
      event.preventDefault();
      event.stopPropagation();
      void resolve.current(id, decision);
    };
    node.addEventListener('keydown', answer);
    return () => node.removeEventListener('keydown', answer);
  }, [item?.id]);
  /*
   * Stated only when this card belongs to the conversation on screen and that conversation has
   * actually loaded. An empty array is a trajectory nobody has fetched yet, and reading it as "this
   * conversation has read nothing from outside" would be the card's one false sentence.
   *
   * Memoised because a streaming turn re-renders this drawer on every delta, and the report is a
   * pass over the whole trajectory. It recomputes when the trajectory grows, which is when the
   * answer can actually change, and not when a countdown ticks.
   */
  const here = Boolean(item && (!openTaskId || item.taskId === openTaskId));
  const context = useMemo(
    () => (here && openTaskEvents?.length ? contextNote(openTaskEvents) : undefined),
    [here, openTaskEvents]
  );
  const structured = item && typeof item.preview !== 'string' ? item.preview : undefined;
  const { changes, ready } = useApprovalDiffs(
    item?.id ?? '',
    workspaceId,
    item ? fileChangesFromTool(structured?.tool, structured?.arguments) : []
  );
  if (!item) return null;
  // The model-authored strings, folded into one attributed quotation. The headline used to be
  // `action` on its own and the body `preview`, which repeats it — so a compromised agent got the
  // top line, the body, and the last word.
  const wording = agentSentence(item);
  const elsewhere = Boolean(openTaskId) && item.taskId !== openTaskId;
  const elsewhereTitle = elsewhere ? (taskTitles?.[item.taskId] ?? '') : '';
  return (
    /*
      A group, not an alert dialog. It was `role="alertdialog"` and it is not one: nothing was made
      inert behind it, nothing trapped Tab inside it, Escape did not close it and nothing moved
      focus to it — a dialog by assertion only, which is worse than no role at all, because a screen
      reader promises the owner a modal and then hands them the page behind it. It is a region of
      the workbench that is asking a question, so it says so, names itself from the two lines that
      are its heading, and takes focus by being focusable.

      `tabIndex={-1}` rather than 0: its buttons are already in the tab order, and adding an empty
      stop in front of them would tax every Tab through the composer for the benefit of the moments
      when a request is up. The focus that matters here is the one this card moves itself.
    */
    <div
      className="approval-drawer"
      ref={card}
      role="group"
      aria-labelledby="approval-eyebrow approval-headline"
      tabIndex={-1}
    >
      <div className="approval-symbol">
        <LockKeyhole />
      </div>
      <div className="approval-copy">
        <p className="eyebrow" id="approval-eyebrow">
          Your confirmation is required
          {elsewhereTitle ? ` · in ${elsewhereTitle}` : ''}
          {approvals.length > 1 ? ` · ${approvals.length} waiting` : ''}
        </p>
        {/* What the box will do, said by the box. `item.action` is the model's own sentence for
            every tool that takes a `purpose`, so it is no longer the headline: the headline is the
            reversibility class and the tool, both of which the harness recorded itself. */}
        <strong id="approval-headline">{approvalReach(item)}</strong>
        <RequestFacts approval={item} />
        {/* Where the request came from, as against what it does. Both answers are drawn, because a
            line that only appears when something is wrong teaches its own absence to mean safety. */}
        {context && (
          <p className={`approval-context ${context.exposed ? 'exposed' : 'clean'}`}>
            {context.exposed ? <BookOpen /> : <ShieldCheck />}
            <span>{context.text}</span>
          </p>
        )}
        {changes.length > 0 && ready && (
          <div className="approval-diffs">
            {changes.map((change) => (
              <DiffView
                key={`${item.id}-${change.path}`}
                path={change.path}
                before={change.before}
                after={change.after}
                defaultOpen={changes.length === 1}
              />
            ))}
          </div>
        )}
        {/* The model's own words, kept and attributed. An agent working honestly has a reason worth
            reading; an agent following an injected instruction writes one too, and the owner is
            told which of the two kinds of statement they are looking at. */}
        {wording && (
          <blockquote className="approval-agent-wording">
            <span>athanor&apos;s own description, written by the model</span>
            <p>{wording}</p>
          </blockquote>
        )}
        {/* An absolute timestamp answers a question nobody asked. What decides whether to get up
            and answer this is how long is left.

            How far the request reaches is the card's headline, above; repeating it here said the
            same sentence twice on a card already fighting to keep its buttons on screen. */}
        <small>{expiryPhrase(item.expiresAt)}</small>
        {failure?.approvalId === item.id && (
          <p className="approval-failure" role="alert">
            {failure.message}
          </p>
        )}
      </div>
      <div className="approval-actions">
        {elsewhere && onOpenTask && (
          <button className="ghost" onClick={() => onOpenTask(item.taskId)}>
            <MessageSquare /> {elsewhereTitle ? `Open ${elsewhereTitle}` : 'Open conversation'}
          </button>
        )}
        {needsComputer(item) && onOpenComputer && (
          <button className="ghost" onClick={onOpenComputer}>
            Open computer
          </button>
        )}
        {/* The keys are stated on the controls themselves rather than printed beside them: a
            screen reader reads them out with the button, and the card stays two words wide. */}
        <button
          className="ghost"
          aria-keyshortcuts="Meta+Backspace"
          onClick={() => void onResolve(item.id, 'deny')}
        >
          Deny
        </button>
        {/* "Approve once" implied a persistent approve that does not exist. */}
        <button
          className="primary"
          aria-keyshortcuts="Meta+Enter"
          onClick={() => void onResolve(item.id, 'approve')}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
