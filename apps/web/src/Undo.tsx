import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Undo2, X } from 'lucide-react';
import {
  createUndoQueue,
  type PendingUndo,
  type UndoableRequest,
  type UndoQueue
} from './undo-queue.js';

const UndoContext = createContext<UndoQueue | undefined>(undefined);
export const UndoProvider = UndoContext.Provider;

/**
 * Every destructive action in the client runs through this: it happens immediately, and the
 * request that cannot be taken back waits a few seconds behind a visible Undo.
 */
export const useUndo = (): ((request: UndoableRequest) => void) => {
  const queue = useContext(UndoContext);
  if (!queue) throw new Error('useUndo must be used inside an undo provider');
  return queue.push;
};

export const useUndoQueue = (
  onError: (cause: unknown) => void
): { queue: UndoQueue; pending: PendingUndo[] } => {
  const [pending, setPending] = useState<PendingUndo[]>([]);
  const report = useRef(onError);
  report.current = onError;
  const queue = useMemo(
    () => createUndoQueue({ onChange: setPending, onError: (cause) => report.current(cause) }),
    []
  );
  // Leaving the tab must not strand a delete the user already watched disappear. Committing on the
  // way out keeps the server and the interface telling the same story on the next load.
  useEffect(() => {
    const commitOnExit = () => queue.commitAll();
    window.addEventListener('pagehide', commitOnExit);
    return () => {
      window.removeEventListener('pagehide', commitOnExit);
      queue.commitAll();
    };
  }, [queue]);
  return { queue, pending };
};

export function UndoToasts({ queue, pending }: { queue: UndoQueue; pending: PendingUndo[] }) {
  if (pending.length === 0) return null;
  // Portalled and marked as its own layer: an open dialog makes the rest of the body inert, and
  // the undo for something deleted inside that dialog has to stay reachable.
  return createPortal(
    <div className="undo-stack" data-layer="undo" role="status" aria-live="polite">
      {pending.map((entry) => (
        <div className="undo-toast" key={entry.id}>
          <span>{entry.message}</span>
          <button className="undo-action" onClick={() => queue.undo(entry.id)}>
            <Undo2 /> Undo
          </button>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => queue.commit(entry.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
