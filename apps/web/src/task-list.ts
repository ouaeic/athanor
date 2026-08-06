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

export interface ConversationBucket {
  label: string;
  tasks: Task[];
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
 */
export const groupConversations = (tasks: Task[], now = Date.now()): ConversationBucket[] => {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 86_400_000;
  const week = today - 6 * 86_400_000;
  const buckets: ConversationBucket[] = [
    { label: 'Pinned', tasks: [] },
    { label: 'Today', tasks: [] },
    { label: 'Yesterday', tasks: [] },
    { label: 'This week', tasks: [] },
    { label: 'Earlier', tasks: [] }
  ];
  for (const task of [...tasks]
    .filter((task) => !task.archivedAt)
    .sort((left, right) => lastActivityAt(right) - lastActivityAt(left))) {
    const at = lastActivityAt(task);
    const bucket = task.pinned ? 0 : at >= today ? 1 : at >= yesterday ? 2 : at >= week ? 3 : 4;
    buckets[bucket]!.tasks.push(task);
  }
  return buckets.filter((bucket) => bucket.tasks.length > 0);
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
