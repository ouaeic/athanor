export interface UndoableRequest {
  /** What the user sees in the toast, phrased as something that already happened. */
  message: string;
  /** The irreversible half. It runs only once the undo window closes. */
  commit: () => Promise<unknown>;
  /** Puts the optimistically removed row back when the user undoes. */
  restore?: () => void;
}

export interface PendingUndo {
  id: string;
  message: string;
}

export interface UndoQueue {
  /** Removes the row from the interface now and starts the undo window. */
  push: (request: UndoableRequest) => string;
  undo: (id: string) => void;
  /** Commits one entry immediately, e.g. because the user started a conflicting action. */
  commit: (id: string) => void;
  /** Commits everything still waiting, e.g. when the surface holding the toast goes away. */
  commitAll: () => void;
  pending: () => PendingUndo[];
}

export interface UndoQueueOptions {
  onChange: (pending: PendingUndo[]) => void;
  onError?: (cause: unknown, request: UndoableRequest) => void;
  delayMs?: number;
  setTimer?: (run: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  createId?: () => string;
}

interface QueuedUndo extends PendingUndo {
  request: UndoableRequest;
  handle: number;
}

/**
 * The reversible half of a destructive action.
 *
 * A confirmation dialog asks before anything happens and people learn to click through it; this
 * does the opposite, acting immediately and holding the irreversible call back for a few seconds
 * so the mistake costs one click to undo. Nothing is deleted on the server until the window
 * closes, so "undo" is genuinely a no-op rather than a second write that has to succeed.
 */
export const createUndoQueue = (options: UndoQueueOptions): UndoQueue => {
  const delayMs = options.delayMs ?? 6_000;
  const setTimer = options.setTimer ?? ((run, delay) => window.setTimeout(run, delay));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  const createId = options.createId ?? (() => crypto.randomUUID());
  let queue: QueuedUndo[] = [];

  const publish = () => options.onChange(queue.map(({ id, message }) => ({ id, message })));

  const settle = (id: string) => {
    const entry = queue.find((item) => item.id === id);
    if (!entry) return;
    queue = queue.filter((item) => item.id !== id);
    publish();
    /*
     * A commit that failed has to put the row back.
     *
     * The row is removed from the interface the moment the undo window opens, on the promise that
     * the server call behind it will happen. When that call fails the promise is broken: the file
     * is still on the computer and gone from the screen, and the only thing that happened was a
     * message. `restore` existed on the request for exactly this and was never called - so every
     * failed delete, of a file, an artifact, a preview, a session or a token, left the interface
     * describing a world that is not there.
     */
    void entry.request.commit().catch((cause) => {
      entry.request.restore?.();
      options.onError?.(cause, entry.request);
    });
  };

  return {
    push: (request) => {
      const id = createId();
      const handle = setTimer(() => settle(id), delayMs);
      queue = [...queue, { id, message: request.message, request, handle }];
      publish();
      return id;
    },
    undo: (id) => {
      const entry = queue.find((item) => item.id === id);
      if (!entry) return;
      clearTimer(entry.handle);
      queue = queue.filter((item) => item.id !== id);
      publish();
      entry.request.restore?.();
    },
    commit: (id) => {
      const entry = queue.find((item) => item.id === id);
      if (!entry) return;
      clearTimer(entry.handle);
      settle(id);
    },
    commitAll: () => {
      for (const entry of [...queue]) {
        clearTimer(entry.handle);
        settle(entry.id);
      }
    },
    pending: () => queue.map(({ id, message }) => ({ id, message }))
  };
};
