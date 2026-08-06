import { type RefObject } from 'react';
import { RotateCcw, ShieldCheck, X } from 'lucide-react';
import { Dialog } from './Dialog.js';
import {
  offersStopSource,
  rewindDialogCopy,
  rewindOffer,
  rewindScopeChoices,
  rewindScopeNote,
  type TrajectoryDraft
} from './rewind.js';
import type { TaskRewindPreview } from './types.js';

/**
 * Everything inside the dialog, which is everything the owner reads before deciding.
 *
 * Held apart from the `Dialog` frame around it — the portal, the focus trap and Escape — because
 * this half renders without a DOM and so can be put into each of its states and read back: a scope
 * the server would refuse offered as a reason rather than as an option that does nothing, the
 * effects shown only where they apply, the heading agreeing with the button under it.
 */
export function RewindChoice({
  trajectory,
  onChange,
  preview,
  promptRef,
  taskIsActive,
  busy,
  onConfirm,
  onCancel,
  onOpenRecoveryPoints
}: {
  trajectory: TrajectoryDraft;
  onChange: (next: TrajectoryDraft) => void;
  /** Undefined while the server is still being asked what this would change. */
  preview: TaskRewindPreview | undefined;
  promptRef?: RefObject<HTMLTextAreaElement | null>;
  taskIsActive: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onOpenRecoveryPoints: () => void;
}) {
  const copy = rewindDialogCopy(trajectory.operation, trajectory.rewind, busy);
  const offer = rewindOffer(preview);
  return (
    <>
      <button className="modal-close" onClick={onCancel} aria-label="Close">
        <X />
      </button>
      <p className="eyebrow">{copy.eyebrow}</p>
      <h2 id="trajectory-title">{copy.title}</h2>
      <p className="subtle">{copy.explanation}</p>
      {trajectory.operation === 'edit' && (
        <label>
          Message
          <textarea
            {...(promptRef ? { ref: promptRef } : {})}
            rows={7}
            value={trajectory.prompt}
            onChange={(event) => onChange({ ...trajectory, prompt: event.target.value })}
          />
        </label>
      )}
      <fieldset className="trajectory-rewind">
        <legend>Take back</legend>
        {rewindScopeChoices.map(({ scope, label, hint }) => {
          // A choice that would fail is not a choice. The server refuses a computer rewind with no
          // checkpoint, so the dialog says so instead of offering it.
          const unavailable = scope !== 'conversation' && !offer.computerAvailable;
          return (
            <label
              key={scope}
              className={`${trajectory.rewind === scope ? 'selected' : ''} ${
                unavailable ? 'unavailable' : ''
              }`.trim()}
            >
              <input
                type="radio"
                name="rewind-scope"
                disabled={unavailable}
                checked={trajectory.rewind === scope}
                onChange={() => onChange({ ...trajectory, rewind: scope })}
              />
              <span className="rewind-label">{label}</span>
              <span className="rewind-hint">{unavailable ? offer.computerReason : hint}</span>
            </label>
          );
        })}
      </fieldset>
      {trajectory.rewind !== 'conversation' && offer.computerAvailable && (
        <ul className="rewind-effects">
          {offer.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
          {offer.caveats.map((caveat) => (
            <li key={caveat} className="rewind-caveat">
              {caveat}
            </li>
          ))}
        </ul>
      )}
      <div className="trajectory-scope-note">
        <ShieldCheck />
        <span>{rewindScopeNote(trajectory.rewind)}</span>
        <button className="link-button" onClick={onOpenRecoveryPoints}>
          Recovery points
        </button>
      </div>
      {offersStopSource(trajectory.rewind, taskIsActive) && (
        <label className="trajectory-stop-source">
          <input
            type="checkbox"
            checked={trajectory.stopSource}
            onChange={(event) => onChange({ ...trajectory, stopSource: event.target.checked })}
          />
          Stop this conversation so two agents do not change the same computer
        </label>
      )}
      <div className="modal-actions">
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || (trajectory.operation === 'edit' && !trajectory.prompt.trim())}
        >
          <RotateCcw /> {copy.confirm}
        </button>
      </div>
    </>
  );
}

/**
 * The only control in athanor where a click can undo work on the machine, in its frame.
 *
 * The frame is all this adds: a modal with a focus trap and an Escape route. Everything it says is
 * in `RewindChoice`, and everything that says it is in `rewind.ts`, so the words a person reads and
 * the request the button sends cannot describe different things.
 */
export function RewindDialog(props: Parameters<typeof RewindChoice>[0]) {
  return (
    <Dialog
      className="modal trajectory-modal"
      labelledBy="trajectory-title"
      onClose={props.onCancel}
    >
      <RewindChoice {...props} />
    </Dialog>
  );
}
