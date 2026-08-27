import { Keyboard, X } from 'lucide-react';
import { Dialog } from '../Dialog.js';
import { shortcutRows } from '../shortcuts.js';

/**
 * Every key this window answers to, listed from the same table the window reads.
 *
 * `shortcutRows` is the one source: a chord that works and is not on this sheet is a chord nobody
 * finds, and a chord on this sheet that does nothing is worse than no sheet at all.
 */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog className="modal shortcut-sheet" labelledBy="shortcut-title" onClose={onClose}>
      <button className="modal-close" onClick={onClose} aria-label="Close">
        <X />
      </button>
      <p className="eyebrow">
        <Keyboard /> Keyboard
      </p>
      <h2 id="shortcut-title">Shortcuts</h2>
      <dl className="shortcut-list">
        {shortcutRows.map((row) => (
          <div key={row.keys}>
            <dt>
              <kbd>{row.keys}</kbd>
            </dt>
            <dd>{row.meaning}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
