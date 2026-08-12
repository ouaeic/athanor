import type { ConversationSearchResult, Task } from './types.js';

/**
 * Merges a task into the bootstrap list, inserting it when it is not there yet.
 *
 * The bootstrap only carries the newest conversations, while search and deep links reach all of
 * them. A plain `map` silently dropped anything older, so an openable conversation rendered as a
 * blank canvas forever. Insertion keeps the newest-first order the list is built with.
 */
export const upsertTask = (tasks: Task[], incoming: Task): Task[] => {
  const index = tasks.findIndex((task) => task.id === incoming.id);
  if (index >= 0) {
    const next = [...tasks];
    next[index] = incoming;
    return next;
  }
  const position = tasks.findIndex((task) => task.createdAt.localeCompare(incoming.createdAt) < 0);
  if (position < 0) return [...tasks, incoming];
  return [...tasks.slice(0, position), incoming, ...tasks.slice(position)];
};

export const removeTask = (tasks: Task[], id: string): Task[] =>
  tasks.filter((task) => task.id !== id);

/** When a conversation was last touched, which is what "5m" beside its row has always claimed. */
export const lastActivityAt = (task: Task): number =>
  Math.max(Date.parse(task.updatedAt) || 0, Date.parse(task.createdAt) || 0);

/** Every run of one schedule that is currently in the list, folded into a single line. */
export interface ScheduleGroup {
  scheduleId: string;
  /** The name the runs carry, taken from the newest of them. */
  title: string;
  /** The runs, newest first. Always more than one: a lone run is just a conversation. */
  runs: Task[];
  /** The newest run, whose status and time the collapsed line reports. */
  latest: Task;
}

export type ConversationEntry =
  | { kind: 'conversation'; task: Task }
  | { kind: 'schedule'; group: ScheduleGroup };

export interface ConversationBucket {
  label: string;
  entries: ConversationEntry[];
}

/**
 * The list, in the order it is actually used.
 *
 * The rows were ordered by creation while printing time-since-last-touched beside each one, so a
 * conversation replied to five minutes ago sat wherever it had been created three weeks earlier and
 * the two facts on the row contradicted each other. Buckets are relative to the caller's clock so
 * "Today" means today where the owner is, not where the box is.
 *
 * Two filing decisions the owner can make are honoured here, because this is the only place the
 * order is decided. A pinned conversation is held above the dates — the server has always sorted
 * that way and said so in the contract, and the client sorted by recency alone, so pinning a
 * conversation moved nothing on the screen the owner was looking at. A filed one leaves the list
 * entirely: it is still open if it is open, still reachable from search, and no longer in the way.
 *
 * The third decision is not the owner's, it is the machine's. A schedule mints a fresh conversation
 * every time it fires, so a watcher on a fifteen-minute interval put ninety-six rows a day into this
 * order and pushed the owner's own work off the end of the list by mid-morning. Runs of one schedule
 * collapse into a single entry, filed by the newest of them, so a watcher costs one line whether it
 * has fired twice or four hundred times. A schedule with exactly one run so far stays an ordinary
 * conversation: a group of one is a control that hides nothing.
 *
 * Pinning still wins. A run the owner pinned is a conversation they singled out, so it is held above
 * the dates on its own and the count beside its schedule no longer includes it.
 */
export const groupConversations = (tasks: Task[], now = Date.now()): ConversationBucket[] => {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 86_400_000;
  const week = today - 6 * 86_400_000;
  const buckets: ConversationBucket[] = [
    { label: 'Pinned', entries: [] },
    { label: 'Today', entries: [] },
    { label: 'Yesterday', entries: [] },
    { label: 'This week', entries: [] },
    { label: 'Earlier', entries: [] }
  ];
  const ordered = [...tasks]
    .filter((task) => !task.archivedAt)
    .sort((left, right) => lastActivityAt(right) - lastActivityAt(left));
  const runs = new Map<string, Task[]>();
  for (const task of ordered) {
    if (task.pinned || !task.scheduleId) continue;
    const existing = runs.get(task.scheduleId);
    if (existing) existing.push(task);
    else runs.set(task.scheduleId, [task]);
  }
  const placed = new Set<string>();
  for (const task of ordered) {
    const scheduleId = task.pinned ? null : (task.scheduleId ?? null);
    const group = scheduleId ? runs.get(scheduleId) : undefined;
    const collapsed = scheduleId && group && group.length > 1 ? { scheduleId, runs: group } : null;
    if (collapsed && placed.has(collapsed.scheduleId)) continue;
    const at = lastActivityAt(task);
    const bucket = task.pinned ? 0 : at >= today ? 1 : at >= yesterday ? 2 : at >= week ? 3 : 4;
    if (collapsed) {
      placed.add(collapsed.scheduleId);
      // The first run reached is the newest, because the list is already sorted, so the group is
      // filed and named by it without a second pass.
      buckets[bucket]!.entries.push({
        kind: 'schedule',
        group: { ...collapsed, title: task.title, latest: task }
      });
    } else buckets[bucket]!.entries.push({ kind: 'conversation', task });
  }
  return buckets.filter((bucket) => bucket.entries.length > 0);
};

/** A day, which is as far back as "while you were away" can honestly reach with nothing to measure
    from. */
const AWAY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * What the computer did while nobody was watching, in one sentence, or nothing worth saying.
 *
 * The owner arrives to a machine that has been working all night, so the screen that greets them
 * should carry the evidence of that rather than ask them what to do. "While you were away" is read
 * from the work itself: anything a schedule ran since the owner last touched a conversation of their
 * own happened without them. No dashboard, no digest — one line, and only when there is one to say.
 *
 * Floored at a day. With no conversation of the owner's own in view - every one archived, or a box
 * that has only ever run schedules - "since they last looked" reduced to the beginning of time, and
 * the line reported every run the schedule had ever made as having happened overnight.
 *
 * The number is only spoken when this device is holding every run it would be counting. The list is
 * capped at a handful of runs per schedule, so ninety failed runs behind five good ones read as
 * "5 scheduled runs finished while you were away" - the count of what fitted, on the one screen the
 * owner reads after being away, saying the opposite of what happened. `scheduleRunCounts` is how
 * many runs each schedule really has, and where that is more than this device is holding, the
 * sentence says what did happen and leaves the arithmetic to the schedule's own line, which has the
 * real total beside it. A floor stated as a total is worse than no total.
 */
export const arrivalLine = (
  tasks: Task[],
  now = Date.now(),
  scheduleRunCounts: Readonly<Record<string, number>> = {}
): string | undefined => {
  const lastOwnTouch = tasks.reduce(
    (latest, task) => (task.scheduleId ? latest : Math.max(latest, lastActivityAt(task))),
    now - AWAY_WINDOW_MS
  );
  const away = tasks.filter((task) => task.scheduleId && lastActivityAt(task) > lastOwnTouch);
  if (!away.length) return undefined;
  // Held per schedule against the count the box reported for it. Anything short means runs of that
  // schedule exist whose outcome this device cannot see, and any of them could have been the one
  // that failed or the one that is waiting.
  //
  // Pinned and filed runs are outside both sides of the comparison, because the count is taken over
  // the same list the sidebar draws: a run the owner pinned is theirs now, and a filed one is out of
  // the way.
  const held = new Map<string, number>();
  for (const task of tasks)
    if (task.scheduleId && !task.pinned && !task.archivedAt)
      held.set(task.scheduleId, (held.get(task.scheduleId) ?? 0) + 1);
  const whole = away.every(
    (task) =>
      task.scheduleId !== null &&
      (scheduleRunCounts[task.scheduleId] ?? 0) <= (held.get(task.scheduleId) ?? 0)
  );
  const runs = (count: number) => `${count} scheduled run${count === 1 ? '' : 's'}`;
  const waiting = away.filter((task) => task.status === 'awaiting_user').length;
  if (waiting)
    return whole
      ? `${runs(waiting)} ${waiting === 1 ? 'needs' : 'need'} you.`
      : 'Scheduled work needs you.';
  const failed = away.filter((task) => task.status === 'failed').length;
  if (failed)
    return whole
      ? `${runs(failed)} failed while you were away.`
      : 'Scheduled work failed while you were away.';
  return whole
    ? `${runs(away.length)} finished while you were away.`
    : 'Scheduled work ran while you were away.';
};

export interface ConversationMatch {
  taskId: string;
  workspaceId: string;
  title: string;
  /** The line from the conversation that matched, or empty for a title match on this device. */
  excerpt: string;
  /** The loaded conversation, when this device has it. A search reaches ones it does not. */
  task: Task | undefined;
}

/**
 * What the search field should list.
 *
 * Two sources, never intersected. A result from another agent computer, or from a conversation
 * older than the page the bootstrap carried, is very often not in `tasks` at all — intersecting
 * them dropped exactly the conversation the search had just found. While the box is still
 * answering, the titles already on this device stand in, so typing produces something immediately
 * instead of an empty list that fills in a fifth of a second later.
 */
export const conversationMatches = (input: {
  query: string;
  tasks: Task[];
  matches: ConversationSearchResult[];
  searching: boolean;
}): ConversationMatch[] => {
  const query = input.query.trim();
  if (query.length < 2) return [];
  if (input.searching && !input.matches.length) {
    const needle = query.toLowerCase();
    return input.tasks
      .filter((task) => task.title.toLowerCase().includes(needle))
      .map((task) => ({
        taskId: task.id,
        workspaceId: task.workspaceId,
        title: task.title,
        excerpt: '',
        task
      }));
  }
  const known = new Map(input.tasks.map((task) => [task.id, task]));
  return input.matches.map((match) => {
    const task = known.get(match.taskId);
    return {
      taskId: match.taskId,
      workspaceId: match.workspaceId,
      // A conversation this device has may have been renamed since the box indexed it.
      title: task?.title ?? match.title,
      excerpt: match.excerpt,
      task
    };
  });
};

/**
 * The title an inline rename should save, or undefined when there is nothing to save.
 *
 * Both the Enter path and the click-away path go through this, which is the point: they used to
 * disagree, and the one that ran more often threw the edit away.
 */
export const renameCommit = (draft: string, currentTitle: string): string | undefined => {
  const next = draft.trim();
  return next && next !== currentTitle ? next : undefined;
};
