import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BellRing,
  BookOpen,
  CalendarClock,
  LockKeyhole,
  MessageSquare,
  Pause,
  Play,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
  Zap
} from 'lucide-react';
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
import { describeFailure } from './failure-text.js';
import { Dialog } from './Dialog.js';
import { DiffView } from './DiffView.js';
import { fileChangesFromTool, type FileChange } from './diff.js';
import { noticeWhen, type AgentNotification } from './notice-log.js';
import { contextNote } from './provenance.js';
import { scheduleDescription, scheduleSpecFromForm, scheduleStanding } from './schedule-rows.js';
import { useUndo } from './Undo.js';
import type { Approval, CatalogueModel, TaskEvent, TaskSchedule, Workspace } from './types.js';

const localDateTimeInput = (date: Date): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScheduleModal({
  schedules,
  workspaces,
  models,
  defaultWorkspaceId,
  initialPrompt,
  onClose,
  onChanged
}: {
  schedules: TaskSchedule[];
  workspaces: Workspace[];
  models: CatalogueModel[];
  defaultWorkspaceId?: string;
  initialPrompt: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const workspaceId = defaultWorkspaceId ?? workspaces[0]?.id ?? '';
  const privacyRoute =
    models.find((model) => model.availability === 'available')?.privacyRoute ?? 'provider_zdr';
  const eligibleModels = models.filter(
    (model) => model.privacyRoute === privacyRoute && model.availability === 'available'
  );
  const [modelId, setModelId] = useState(eligibleModels[0]?.id ?? '');
  // Cron is not offered here: a five-field expression is not something anyone should have to write
  // to get a daily briefing, and the four shapes below are what people actually schedule. The
  // agent can still create one on request, and `scheduleDescription` still reads it back.
  const [kind, setKind] = useState<'once' | 'interval' | 'daily' | 'weekly'>('daily');
  const [runAt, setRunAt] = useState(localDateTimeInput(new Date(Date.now() + 60 * 60_000)));
  const [localTime, setLocalTime] = useState('09:00');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);
  const visibleSchedules = schedules.filter((schedule) => !removed.includes(schedule.id));
  const undo = useUndo();

  useEffect(() => {
    if (!eligibleModels.some((model) => model.id === modelId))
      setModelId(eligibleModels[0]?.id ?? '');
  }, [eligibleModels, modelId]);

  /*
   * The default is the recommendation, not whatever the catalogue happens to list first.
   *
   * Listed first was `claude-3-haiku` - alphabetical, and years old - so a schedule created without
   * touching this ran every morning on it. The composer has always asked the box which model it
   * would pick; this is the same question, and a run nobody is watching is the last place to answer
   * it by accident. Only the untouched default moves: once the owner has chosen, this leaves it be.
   */
  const [modelTouched, setModelTouched] = useState(false);
  useEffect(() => {
    if (modelTouched) return;
    let active = true;
    void api
      .recommendModels(privacyRoute === 'provider_zdr' ? 'provider_zdr' : 'external', 'balanced')
      .then((ranked) => {
        const best = ranked.find((entry) =>
          eligibleModels.some((model) => model.id === entry.modelId)
        );
        if (active && best) setModelId(best.modelId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // Deliberately not keyed on eligibleModels: that array is rebuilt on every render, and asking
    // again on each one would fight the owner's own selection.
  }, [privacyRoute, modelTouched]);

  const create = async () => {
    if (!workspaceId || !prompt.trim() || !modelId) return;
    setBusy(true);
    setError('');
    try {
      const built = scheduleSpecFromForm({
        kind,
        runAt,
        localTime,
        everyMinutes,
        weekdays,
        timeZone
      });
      if (!built.ok) throw new Error(built.message);
      const spec = built.spec;
      await api.createSchedule({
        workspaceId,
        prompt: prompt.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        modelId,
        privacyRoute,
        // The same ceiling a message typed into the composer gets. Real spending is bounded by the
        // daily and monthly caps in Settings, which is one control instead of two currencies.
        maxComputeCredits: 5,
        spec
      });
      setPrompt('');
      setTitle('');
      await onChanged();
    } catch (cause) {
      setError(describeFailure(cause, 'Could not create schedule'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog className="modal schedule-modal" labelledBy="schedule-title" onClose={onClose}>
      <button className="modal-close" aria-label="Close scheduled work" onClick={onClose}>
        <X />
      </button>
      <h2 id="schedule-title">Scheduled work</h2>
      <p className="subtle">
        Runs on your agent computer whether or not you are here, under the same approval rules.
      </p>
      <div className="schedule-layout">
        <div className="schedule-existing">
          <strong>Your schedules</strong>
          {!visibleSchedules.length && <small>No scheduled work yet.</small>}
          {visibleSchedules.map((schedule) => (
            <div className={`schedule-row ${schedule.enabled ? '' : 'paused'}`} key={schedule.id}>
              <CalendarClock />
              <span>
                <strong>{schedule.title}</strong>
                <small>{scheduleDescription(schedule.spec)}</small>
                <small>{scheduleStanding(schedule)}</small>
              </span>
              <button
                className="icon-btn"
                title="Run now"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api.scheduleAction(schedule.id, 'run');
                    await onChanged();
                  } catch (cause) {
                    setError(describeFailure(cause, 'Could not run schedule'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Zap />
              </button>
              <button
                className="icon-btn"
                title={schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api.scheduleAction(schedule.id, schedule.enabled ? 'pause' : 'resume');
                    await onChanged();
                  } catch (cause) {
                    setError(describeFailure(cause, 'Could not update schedule'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {schedule.enabled ? <Pause /> : <Play />}
              </button>
              <button
                className="icon-btn destructive"
                title="Delete schedule"
                disabled={busy}
                onClick={() => {
                  setRemoved((current) => [...current, schedule.id]);
                  undo({
                    message: `Deleted “${schedule.title}”`,
                    commit: async () => {
                      await api.deleteSchedule(schedule.id);
                      await onChanged();
                    },
                    restore: () =>
                      setRemoved((current) => current.filter((id) => id !== schedule.id))
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
        <div className="schedule-form">
          <strong>Create a schedule</strong>
          <label>
            Name <small>optional</small>
            <input
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            What should athanor do?
            <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <div className="schedule-grid">
            <label>
              Repeats
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="once">Once</option>
                <option value="interval">At an interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            {kind === 'once' && (
              <label>
                Run at
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                />
              </label>
            )}
            {kind === 'interval' && (
              <label>
                Every minutes
                <input
                  type="number"
                  min={15}
                  max={10080}
                  value={everyMinutes}
                  onChange={(event) => setEveryMinutes(Number(event.target.value))}
                />
              </label>
            )}
            {(kind === 'daily' || kind === 'weekly') && (
              <label>
                Local time
                <input
                  type="time"
                  value={localTime}
                  onChange={(event) => setLocalTime(event.target.value)}
                />
              </label>
            )}
          </div>
          {kind === 'weekly' && (
            <div className="weekday-picker">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((name, day) => (
                <button
                  type="button"
                  aria-label={
                    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                      day
                    ]
                  }
                  aria-pressed={weekdays.includes(day)}
                  className={weekdays.includes(day) ? 'active' : ''}
                  key={`${name}-${day}`}
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(day)
                        ? current.filter((item) => item !== day)
                        : [...current, day].sort()
                    )
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <label>
            Model for every run
            <select
              value={modelId}
              onChange={(event) => {
                setModelTouched(true);
                setModelId(event.target.value);
              }}
            >
              {!eligibleModels.length && <option value="">Connect an AI provider first</option>}
              {eligibleModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <small className="schedule-zone">
            Times are {timeZone}. Anything consequential still waits for you.
          </small>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button
            className="primary wide"
            disabled={
              busy ||
              !workspaceId ||
              !prompt.trim() ||
              !modelId ||
              (kind === 'weekly' && !weekdays.length)
            }
            onClick={() => void create()}
          >
            <CalendarClock /> {busy ? 'Saving…' : 'Create schedule'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Everything athanor has told the owner, in one place and across every conversation.
 *
 * Each of these already appeared twice: once in the conversation it was decided in, and once on
 * whatever device happened to be awake. Neither is somewhere you can look something up — the first
 * needs the conversation found first, and the second is gone the moment it is swiped away. This is
 * the record, newest first, and every row opens the work it came out of.
 */
export function NoticeLog({
  notices,
  onOpenTask,
  onClose
}: {
  notices: AgentNotification[];
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog className="modal notice-modal" labelledBy="notice-title" onClose={onClose}>
      <button className="modal-close" aria-label="Close messages" onClick={onClose}>
        <X />
      </button>
      <h2 id="notice-title">What athanor told you</h2>
      <p className="subtle">
        Messages athanor decided to send, whether or not a device was awake to receive them.
      </p>
      <div className="notice-list">
        {/* Reachable while empty: the last notice can be read, and then the list refreshes under
            the open dialog. An empty box with a heading over it reads as a failure to load. */}
        {!notices.length && (
          <small>Nothing yet. athanor only writes here when it has something.</small>
        )}
        {notices.map((notice) => (
          <button
            key={notice.id}
            className="notice-row"
            // A row with no conversation behind it is still worth reading; it is just not a way in.
            disabled={!notice.taskId}
            onClick={() => {
              onOpenTask(notice.taskId);
              onClose();
            }}
          >
            {notice.kind === 'takeover_needed' ? <ShieldAlert /> : <BellRing />}
            <span>
              <strong>{notice.message}</strong>
              <small>
                {notice.taskTitle || 'Untitled conversation'} · {noticeWhen(notice.createdAt)}
              </small>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

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
