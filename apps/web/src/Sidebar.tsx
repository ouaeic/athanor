import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  CalendarClock,
  ChevronRight,
  Monitor,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2
} from 'lucide-react';
import { BrandMark } from './BrandMark.js';
import {
  arrivalLine,
  conversationMatches,
  groupConversations,
  renameCommit,
  type ScheduleGroup
} from './task-list.js';
import { shortcutKeys } from './shortcuts.js';
import { formatUsd } from './usage-model.js';
import { workspaceStatusLabel } from './workspace-status.js';
import type { ConversationSearchResult, Task, TaskSchedule, User, Workspace } from './types.js';

const relative = (iso: string) => {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
};

export function Sidebar(props: {
  /**
   * The id the keyboard aims at, on the one copy of this list that is a place focus can go.
   *
   * The shell mounts this component twice - once for the drawer a phone opens, once for the wide
   * layout - and an id has to belong to exactly one of them, so the shell passes it only to the
   * copy that is on screen when there is a keyboard to walk with.
   */
  regionId?: string;
  user: User;
  workspaces: Workspace[];
  tasks: Task[];
  schedules: TaskSchedule[];
  selectedWorkspaceId: string | undefined;
  selectedTaskId: string | undefined;
  onTask: (id: string) => void;
  onNewTask: () => void;
  onComputerSettings: () => void;
  onSettings: () => void;
  onSchedules: () => void;
  /** How many things athanor has told the owner. Zero means the entry is not drawn at all. */
  noticeCount: number;
  onNotices: () => void;
  /**
   * Loads the conversations older than this page, where there are any. Absent means there are
   * none, and the row is not drawn: a control that reveals nothing teaches that there is nothing
   * behind it.
   */
  onEarlier?: (() => void) | undefined;
  loadingEarlier?: boolean;
  onSearch: (query: string, thisComputerOnly?: boolean) => Promise<ConversationSearchResult[]>;
  onRename?: (id: string, title: string) => void;
  onDelete?: (task: Task) => void;
}) {
  const [query, setQuery] = useState('');
  // Searching everything is the default because the alternative is work the owner remembers
  // clearly simply not being findable until they guess which computer it happened on.
  const [thisComputerOnly, setThisComputerOnly] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState('');
  /**
   * Which schedules are showing their runs. Collapsed is the default and stays the default across
   * a reload: the whole point of the row is that ninety-six runs cost one line until the owner
   * asks for them.
   */
  const [openSchedules, setOpenSchedules] = useState<ReadonlySet<string>>(new Set());
  const renameField = useRef<HTMLInputElement>(null);
  // Focus is moved after the field mounts rather than with autoFocus, which steals focus on
  // first paint and is flagged as an accessibility hazard.
  useEffect(() => {
    if (!renaming) return;
    const frame = window.requestAnimationFrame(() => renameField.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [renaming]);
  const [contentMatches, setContentMatches] = useState<ConversationSearchResult[]>([]);
  /** Whether the search could not be run, as opposed to having found nothing. */
  const [searchFailed, setSearchFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeResult, setActiveResult] = useState(-1);
  const workspace = props.workspaces.find((item) => item.id === props.selectedWorkspaceId);
  const searchQuery = query.trim();
  const isSearching = searchQuery.length >= 2;
  useEffect(() => {
    if (searchQuery.length < 2) {
      setContentMatches([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void props
        .onSearch(searchQuery, thisComputerOnly)
        .then((results) => {
          if (active) {
            setContentMatches(results);
            setSearchFailed(false);
          }
        })
        // "Nothing matched" and "this could not be asked" read identically once the list is empty,
        // and the owner would conclude their conversation is gone.
        .catch(() => {
          if (active) {
            setContentMatches([]);
            setSearchFailed(true);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchQuery, thisComputerOnly, props.onSearch]);
  useEffect(() => setActiveResult(-1), [searchQuery, thisComputerOnly]);

  const results = useMemo(
    () =>
      conversationMatches({
        query: searchQuery,
        tasks: props.tasks,
        matches: contentMatches,
        searching
      }),
    [searching, contentMatches, props.tasks, searchQuery]
  );

  const buckets = useMemo(
    () =>
      isSearching
        ? []
        : groupConversations(
            props.tasks.filter((task) => !workspace || task.workspaceId === workspace.id)
          ),
    [isSearching, props.tasks, workspace]
  );
  /**
   * Read across every computer, not the one in view: this line only ever replaces the invitation
   * below, which is drawn when the list in view has nothing in it, and the runs that happened
   * overnight are exactly the ones that are somewhere else or already filed.
   */
  const arrival = useMemo(() => arrivalLine(props.tasks), [props.tasks]);

  const commitRename = (task: Task) => {
    setRenaming(undefined);
    const next = renameCommit(draft, task.title);
    if (next) props.onRename?.(task.id, next);
  };

  const conversationRow = (task: Task, excerpt: string, elsewhere: Workspace | undefined) =>
    renaming === task.id ? (
      <form
        key={task.id}
        className="task-row renaming"
        onSubmit={(event) => {
          event.preventDefault();
          commitRename(task);
        }}
      >
        <input
          ref={renameField}
          value={draft}
          aria-label="Conversation name"
          maxLength={160}
          onChange={(event) => setDraft(event.target.value)}
          /* Clicking away saves. Discarding what someone just typed, with no warning and no
             way back, is the one thing an inline rename must never do. */
          onBlur={() => commitRename(task)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Consumed, or the same keystroke also reaches the window shortcut that stops the
            // running agent - cancelling a rename would quietly cancel the work.
            event.stopPropagation();
            setRenaming(undefined);
          }}
        />
      </form>
    ) : (
      <div key={task.id} className={`task-row ${task.id === props.selectedTaskId ? 'active' : ''}`}>
        {/* The row's own text concatenates into "Quarterly board deckrunning · 2m$0.42" for a
            screen reader, so the name is stated rather than inferred. */}
        <button
          className="task-open"
          aria-label={`${task.title}, ${task.status.replace('_', ' ')}`}
          onClick={() => props.onTask(task.id)}
        >
          <span className={`status-dot ${task.status}`} />
          <span className="task-copy">
            <strong>{task.title}</strong>
            <small>
              {elsewhere && (
                <em className="task-elsewhere" title={`On ${elsewhere.name}`}>
                  <Monitor size={11} /> {elsewhere.name}
                </em>
              )}
              {excerpt || `${task.status.replace('_', ' ')} · ${relative(task.updatedAt)}`}
              {/* What this conversation has actually cost, next to the conversation it
                  cost it on. A total in a separate pane never reaches the person deciding
                  whether to keep going. */}
              {task.spentUsd > 0 && !excerpt && (
                <em
                  className="task-spend"
                  title={`Provider cost so far: ${formatUsd(task.spentUsd)}`}
                >
                  {formatUsd(task.spentUsd)}
                </em>
              )}
            </small>
          </span>
        </button>
        {(props.onRename || props.onDelete) && (
          <span className="task-row-actions">
            {props.onRename && (
              <button
                aria-label={`Rename ${task.title}`}
                title="Rename"
                onClick={() => {
                  setDraft(task.title);
                  setRenaming(task.id);
                }}
              >
                <Pencil size={13} />
              </button>
            )}
            {props.onDelete && (
              <button
                aria-label={`Delete ${task.title}`}
                title="Delete"
                onClick={() => props.onDelete?.(task)}
              >
                <Trash2 size={13} />
              </button>
            )}
          </span>
        )}
      </div>
    );

  /**
   * One schedule, one line.
   *
   * A watcher on a fifteen-minute interval minted ninety-six conversations a day and every one of
   * them took a row in the same list as the owner's own work, in the same recency order, so by
   * mid-morning their work was off the bottom of it. What is left on screen is the schedule's name,
   * how its last run ended and how long ago, and how many runs there have been — the same three
   * facts an ordinary row carries, plus the count that makes the collapse honest. The runs are one
   * click away and none of them has been hidden.
   *
   * The name comes from the schedule when this device has it, because a run can be renamed — by the
   * owner, or by the titler once it has said something — and forty renamed runs should still answer
   * to the schedule they came from. The newest run's name is the fallback, so a group survives the
   * schedule being deleted.
   */
  const scheduleGroupRows = (group: ScheduleGroup) => {
    const open = openSchedules.has(group.scheduleId);
    const name = props.schedules.find((item) => item.id === group.scheduleId)?.title ?? group.title;
    const outcome = group.latest.status.replace('_', ' ');
    return (
      <Fragment key={`schedule-${group.scheduleId}`}>
        <div className="task-row schedule-run-group">
          <button
            className="task-open"
            aria-expanded={open}
            aria-label={`${name}, ${group.runs.length} scheduled runs, last ${outcome}`}
            onClick={() =>
              setOpenSchedules((current) => {
                const next = new Set(current);
                if (!next.delete(group.scheduleId)) next.add(group.scheduleId);
                return next;
              })
            }
          >
            <span className={`status-dot ${group.latest.status}`} />
            <span className="task-copy">
              <strong>{name}</strong>
              <small>
                {outcome} · {relative(group.latest.updatedAt)} · {group.runs.length} runs
              </small>
            </span>
            <ChevronRight size={13} className={`schedule-run-chevron ${open ? 'open' : ''}`} />
          </button>
        </div>
        {open && (
          <div className="schedule-run-list">
            {group.runs.map((run) => conversationRow(run, '', undefined))}
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <aside className="sidebar" id={props.regionId} tabIndex={-1} aria-label="Conversations">
      <button className="workspace-switcher computer-summary" onClick={props.onComputerSettings}>
        <span className="workspace-avatar agent-brand-avatar">
          <BrandMark />
        </span>
        <span>
          <strong>{workspace ? 'Agent computer' : 'Server computer'}</strong>
          <small>{workspace ? workspaceStatusLabel(workspace.status) : 'Check server setup'}</small>
        </span>
      </button>
      <button className="new-task" onClick={props.onNewTask}>
        <Plus size={18} /> New conversation <kbd>{shortcutKeys('new-conversation')}</kbd>
      </button>
      <button className="schedule-task" onClick={props.onSchedules}>
        <CalendarClock size={17} /> Scheduled work
        {props.schedules.some((item) => item.enabled) && (
          <span>{props.schedules.filter((item) => item.enabled).length}</span>
        )}
      </button>
      {/* Nothing to read means no row: a permanent entry to an empty list is a control that only
          ever teaches that there is nothing behind it. */}
      {props.noticeCount > 0 && (
        <button className="schedule-task" onClick={props.onNotices}>
          <BellRing size={17} /> What athanor told you<span>{props.noticeCount}</span>
        </button>
      )}
      <div className="search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search conversations"
          /* The palette has arrow-key navigation and the sidebar did not, so the results right
             under the cursor could only be reached with the mouse. */
          onKeyDown={(event) => {
            if (!results.length) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveResult((current) => Math.min(results.length - 1, current + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveResult((current) => Math.max(-1, current - 1));
            } else if (event.key === 'Enter' && activeResult >= 0) {
              event.preventDefault();
              const target = results[activeResult];
              if (target) props.onTask(target.taskId);
            }
          }}
        />
      </div>
      {isSearching && props.workspaces.length > 1 && (
        <label className="search-scope">
          <input
            type="checkbox"
            checked={thisComputerOnly}
            onChange={(event) => setThisComputerOnly(event.target.checked)}
          />
          This computer only
        </label>
      )}
      {/* No "Conversations" heading: the date buckets below name themselves, and a search field
          directly above a list of results does not need the list captioned. */}
      <nav className="task-list" aria-label="Conversations">
        {/*
          What the computer did while nobody was watching, above the list rather than instead of it.

          This used to be drawn only when the list was empty — and a scheduled run is itself a
          conversation, so on the computer where the schedule fired the list is never empty and the
          line never appeared. One sentence, only when there is one to say, above the work it is
          about.
        */}
        {!isSearching && arrival && <p className="arrival-line">{arrival}</p>}
        {isSearching
          ? results.map((result, index) => {
              const elsewhere =
                result.workspaceId !== props.selectedWorkspaceId
                  ? props.workspaces.find((item) => item.id === result.workspaceId)
                  : undefined;
              const task =
                result.task ??
                ({
                  id: result.taskId,
                  workspaceId: result.workspaceId,
                  title: result.title,
                  status: 'completed',
                  spentUsd: 0,
                  updatedAt: new Date().toISOString()
                } as Task);
              return (
                <div
                  key={result.taskId}
                  className={index === activeResult ? 'search-result active-result' : undefined}
                >
                  {conversationRow(task, result.excerpt, elsewhere)}
                </div>
              );
            })
          : buckets.map((bucket) => (
              <div key={bucket.label} className="task-bucket">
                <p className="task-bucket-label">{bucket.label}</p>
                {bucket.entries.map((entry) =>
                  entry.kind === 'conversation'
                    ? conversationRow(entry.task, '', undefined)
                    : scheduleGroupRows(entry.group)
                )}
              </div>
            ))}
        {isSearching && !results.length && !searching && searchFailed && (
          <div className="empty-mini">
            <Sparkles size={18} />
            <span>
              The search could not be run just now, so this is not an answer about “{searchQuery}”.
            </span>
          </div>
        )}
        {isSearching && !results.length && !searching && !searchFailed && (
          <div className="empty-mini">
            <Sparkles size={18} />
            <span>
              Nothing matched “{searchQuery}”
              {thisComputerOnly && props.workspaces.length > 1
                ? ' on this computer. Untick the box above to search them all.'
                : '.'}
            </span>
          </div>
        )}
        {!isSearching && !buckets.length && (
          <div className="empty-mini">
            <Sparkles size={18} />
            <span>No conversations yet. Start one above.</span>
          </div>
        )}
        {!isSearching && props.onEarlier && (
          <button
            className="earlier-conversations"
            disabled={props.loadingEarlier}
            onClick={props.onEarlier}
          >
            {props.loadingEarlier ? 'Loading…' : 'Earlier conversations'}
          </button>
        )}
        {searching && (
          <div className="empty-mini">
            <Search size={16} />
            <span>Searching…</span>
          </div>
        )}
      </nav>
      {/*
        No standing storage figure. It was a number that is unremarkable on all but a handful of
        days, printed where the eye passes every time — and the day it matters the composer already
        says so, in a strip that names the free space and opens Files.
      */}
      <div className="sidebar-bottom">
        <button className="account-row" onClick={props.onSettings}>
          <span className="user-avatar">{props.user.displayName.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{props.user.displayName}</strong>
          </span>
          <Settings2 size={16} />
        </button>
      </div>
    </aside>
  );
}
