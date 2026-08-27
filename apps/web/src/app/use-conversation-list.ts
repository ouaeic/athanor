import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.js';
import { describeFailure } from '../failure-text.js';
import { removeTask, upsertTask } from '../task-list.js';
import type { Bootstrap, Task } from '../types.js';

/** The one-click reversal the sidebar's delete waits behind. */
interface UndoQueue {
  push: (entry: { message: string; commit: () => Promise<unknown>; restore: () => void }) => void;
}

/**
 * The sidebar's list of conversations, and every way the owner rearranges it.
 *
 * Archived rows are kept apart from the bootstrap's list rather than merged into it, because the
 * bootstrap is re-read on focus, on regaining the network and once a minute, and every one of those
 * replaces the list wholesale — merged, the archived rows would blink out of the sidebar while the
 * toggle still said they were showing.
 *
 * Rename, pin, archive and delete are all optimistic, for one reason: this is a list the owner has
 * just acted on, and a row that waits for a round trip before it moves reads as a control that did
 * nothing. A failure puts the row back where it was and says so, rather than leaving the screen
 * disagreeing with the box.
 */
export const useConversationList = (input: {
  data: Bootstrap | undefined;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
  currentData: { current: Bootstrap | undefined };
  taskId: string | undefined;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  setWorkspaceId: Dispatch<SetStateAction<string | undefined>>;
  undo: UndoQueue;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) => {
  const { data, setData, currentData, taskId, setTaskId, setWorkspaceId, undo, onNotice, onError } =
    input;
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [missing, setMissing] = useState(false);

  /*
   * The bootstrap's list wins wherever the two hold the same conversation: un-archiving one puts a
   * fresh copy in `data.tasks`, and folding the other way would let the stale archived copy of it
   * overwrite that and file it away again on screen.
   */
  const rows = useMemo(
    () =>
      showArchived && archivedTasks.length
        ? (data?.tasks ?? []).reduce(upsertTask, archivedTasks)
        : (data?.tasks ?? []),
    [showArchived, archivedTasks, data?.tasks]
  );

  /* What each conversation is called, for the approval card: a request raised in one the owner is
     not looking at has to say which one, and the list is already here. */
  const titles = useMemo(
    () => Object.fromEntries((data?.tasks ?? []).map((item) => [item.id, item.title])),
    [data?.tasks]
  );

  const task = data?.tasks.find((item) => item.id === taskId);
  // A conversation the bootstrap page did not carry is fetched on demand, and one that genuinely
  // no longer exists says so instead of showing the empty canvas with a live stream behind it.
  useEffect(() => {
    setMissing(false);
    if (!taskId || !data || data.tasks.some((item) => item.id === taskId)) return;
    let active = true;
    void api
      .task(taskId)
      .then((found) => {
        if (!active) return;
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, found) } : current
        );
        setWorkspaceId(found.workspaceId);
      })
      .catch(() => {
        if (active) setMissing(true);
      });
    return () => {
      active = false;
    };
  }, [taskId, Boolean(data), Boolean(task)]);

  const rename = async (id: string, title: string) => {
    const previous = currentData.current?.tasks.find((item) => item.id === id);
    // Optimistic: the sidebar is a list the user just typed into, so it should settle instantly.
    setData((current) =>
      current
        ? { ...current, tasks: current.tasks.map((t) => (t.id === id ? { ...t, title } : t)) }
        : current
    );
    try {
      await api.updateTask(id, { title });
    } catch (cause) {
      onError(describeFailure(cause, 'Could not rename this conversation'));
      if (previous)
        setData((current) =>
          current
            ? { ...current, tasks: current.tasks.map((t) => (t.id === id ? previous : t)) }
            : current
        );
    }
  };

  /**
   * The conversations older than the page the bootstrap carried.
   *
   * The box has always answered this - the bootstrap even carries the cursor that resumes the list -
   * and nothing asked, so a long-running install could reach its own older work only by remembering
   * enough about it to search for it. Each page is merged rather than appended, because a
   * conversation replied to since the first page was taken is already on this device.
   */
  const loadEarlier = async () => {
    const cursor = currentData.current?.tasksCursor;
    if (!cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.tasks(cursor);
      setData((current) =>
        current
          ? {
              ...current,
              tasks: page.tasks.reduce(upsertTask, current.tasks),
              // Merged rather than replaced: a later page carries counts only for the schedules it
              // happens to hold, and dropping the rest would take the real total back off the folded
              // lines the first page drew.
              scheduleRunCounts: {
                ...current.scheduleRunCounts,
                ...page.scheduleRunCounts
              },
              tasksCursor: page.hasMore ? page.nextCursor : null
            }
          : current
      );
    } catch (cause) {
      onError(describeFailure(cause, 'Could not load earlier conversations'));
    } finally {
      setLoadingEarlier(false);
    }
  };

  /**
   * The conversations the owner put out of the way, fetched the one way there is to reach them.
   *
   * `include=archived` has been implemented on all three arms of the list route since the contract
   * named them, and nothing ever asked for it. So Archive — a control on every row in the sidebar —
   * took a conversation off every screen this client draws, and the only route back was remembering
   * a word in it and searching for that. Asked for from the top of the list rather than from the
   * bootstrap's cursor: that cursor is a position in the *active* list, and the archived ones the
   * owner is looking for are usually the recent ones.
   */
  const revealArchived = async (next: boolean) => {
    setShowArchived(next);
    if (!next || archivedTasks.length || loadingArchived) return;
    setLoadingArchived(true);
    try {
      const page = await api.tasks(null, 'archived');
      setArchivedTasks(page.tasks);
    } catch (cause) {
      // Back off the toggle as well as saying so: leaving it on over a list that never arrived
      // would read as "you have archived nothing", which is the opposite of the truth.
      setShowArchived(false);
      onError(describeFailure(cause, 'Could not load your archived conversations'));
    } finally {
      setLoadingArchived(false);
    }
  };

  /** Pinning and filing away, which the box has always been able to do and this client could not ask for. */
  const file = async (target: Task, patch: { pinned?: boolean; archived?: boolean }) => {
    onError('');
    const optimistic: Task = {
      ...target,
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      ...(patch.archived === undefined
        ? {}
        : { archivedAt: patch.archived ? new Date().toISOString() : null })
    };
    setData((current) =>
      current ? { ...current, tasks: upsertTask(current.tasks, optimistic) } : current
    );
    try {
      const updated = await api.updateTask(target.id, patch);
      setData((current) =>
        current ? { ...current, tasks: upsertTask(current.tasks, updated) } : current
      );
      if (patch.archived === true)
        onNotice('Filed away. It stays open here, and search still finds it.');
    } catch (cause) {
      setData((current) =>
        current ? { ...current, tasks: upsertTask(current.tasks, target) } : current
      );
      onError(describeFailure(cause, 'Could not change this conversation'));
    }
  };

  /*
    No confirmation dialog: the row goes now and the request that cannot be taken back waits
    behind Undo. A prompt people click through protects nobody, and this costs one click to
    reverse instead of asking permission for every one that was intended.
  */
  const remove = (target: Task) => {
    onError('');
    setData((current) =>
      current ? { ...current, tasks: removeTask(current.tasks, target.id) } : current
    );
    if (taskId === target.id) setTaskId(undefined);
    undo.push({
      message: `Deleted “${target.title}”`,
      commit: () => api.deleteTask(target.id),
      restore: () =>
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, target) } : current
        )
    });
  };

  return {
    rows,
    titles,
    missing,
    showArchived,
    loadingArchived,
    loadingEarlier,
    rename,
    loadEarlier,
    revealArchived,
    file,
    remove
  };
};
