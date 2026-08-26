import { type RefObject } from 'react';
import { RotateCcw, ShieldCheck, X } from 'lucide-react';
import { Dialog } from './Dialog.js';
import {
  offersStopSource,
  rewindDialogCopy,
  rewindOffer,
  rewindScopeChoices,
  rewindScopeNote,
  type RewindPreview,
  type TrajectoryDraft
} from './rewind.js';
import { formatBytes } from './timeline-state.js';
import type { CatalogueModel } from './types.js';
import './rewind.css';

/** The half of the preview that describes the machine, which only this dialog reads. */
type ComputerPreview = NonNullable<RewindPreview['computer']>;

/**
 * Which kind of point this is.
 *
 * The contract reports the mechanism because it is "the difference between 'this is exact' and
 * 'this is what was covered'", and nothing in this client read it: a copied checkpoint holds what
 * it could copy, and the files it could not are the ones listed as left alone. A filesystem
 * snapshot has no such gap, and saying so is the difference between trusting the list and trusting
 * the tree.
 */
const mechanismNote = (mechanism: ComputerPreview['mechanism']): string =>
  mechanism === 'content'
    ? 'This point was taken by copying files, so it holds what could be copied — anything too large for it is not in it.'
    : 'This point is a filesystem snapshot, so the whole tree goes back exactly as it was, not only the files listed here.';

/**
 * One group of paths, headed by what the restore does to them.
 *
 * The size is the one the file would have afterwards; a file that exists in both is shown as the
 * size it is now and the size it would become, because "goes back" is a number changing and the
 * direction of that change is the part worth reading before agreeing to it.
 */
function FileGroup({ title, files }: { title: string; files: ComputerPreview['added'] }) {
  if (!files.length) return null;
  return (
    <div className="rewind-file-group">
      <p>{title}</p>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <span className="rewind-file-path">{file.path}</span>
            <span className="rewind-file-size">
              {file.currentSizeBytes === undefined
                ? formatBytes(file.sizeBytes)
                : `${formatBytes(file.currentSizeBytes)} → ${formatBytes(file.sizeBytes)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Which files, for a person about to agree to an irreversible act on counts alone.
 *
 * Folded rather than laid out: the counts and the byte totals are the summary, and the paths are
 * what somebody checks when one of those numbers is bigger than they expected. `<details>` hides
 * its children rather than skipping them, so this is only safe because the server caps the lists
 * itself and reports `truncated` when it did — the counts above are always the true totals.
 */
function ComputerDetail({ computer }: { computer: ComputerPreview }) {
  const listed =
    computer.modified.length +
    computer.added.length +
    computer.deleted.length +
    computer.uncovered.length;
  // Counts with no paths behind them means the box sent none; an empty disclosure would promise a
  // list that is not there.
  if (!listed) return null;
  return (
    <details className="rewind-files">
      <summary>Which files</summary>
      <FileGroup title="Go back to how they were" files={computer.modified} />
      <FileGroup title="Removed" files={computer.added} />
      <FileGroup title="Come back" files={computer.deleted} />
      <FileGroup
        title="Left exactly as they are — too large to be held"
        files={computer.uncovered}
      />
    </details>
  );
}

/**
 * Everything inside the dialog, which is everything the owner reads before deciding.
 *
 * Held apart from the `Dialog` frame around it — the portal, the focus trap and Escape — because
 * this half renders without a DOM and so can be put into each of its states and read back: a scope
 * the server would refuse offered as a reason rather than as an option that does nothing, the
 * effects shown only where they apply, the heading agreeing with the button under it.
 *
 * The machine's own detail — the paths, the byte totals, the packages and which mechanism took the
 * point — is read from `preview.computer` here rather than through `rewind.ts`, which App imports
 * and which is therefore parsed before first paint by everyone who never opens this dialog.
 */
export function RewindChoice({
  trajectory,
  onChange,
  preview,
  promptRef,
  taskIsActive,
  busy,
  models,
  currentModelId,
  onConfirm,
  onCancel,
  onOpenRecoveryPoints
}: {
  trajectory: TrajectoryDraft;
  onChange: (next: TrajectoryDraft) => void;
  /** Undefined while the server is still being asked what this would change. */
  preview: RewindPreview | undefined;
  promptRef?: RefObject<HTMLTextAreaElement | null>;
  taskIsActive: boolean;
  busy: boolean;
  /**
   * The catalogue, when the caller both has one and sends `modelId` on the request it builds from
   * this draft. Absent means no model row at all — the fork runs on the parent's model, which is
   * what it has always done, and offering a choice the request then drops would be worse than
   * offering none.
   */
  models?: CatalogueModel[];
  /** The model this conversation is on, so "the same one" can be named rather than implied. */
  currentModelId?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onOpenRecoveryPoints: () => void;
}) {
  const copy = rewindDialogCopy(trajectory.operation, trajectory.rewind, busy);
  const offer = rewindOffer(preview);
  const computer = preview?.computer;
  /*
   * Which models this fork could actually run on.
   *
   * The server matches a named model against the fork's privacy route and refuses the pair with
   * `model_unavailable` when they disagree, so a model on another route is not a choice here — it
   * is a refusal the owner would meet after pressing the button. Unavailable models are out for
   * the same reason.
   */
  const currentModel = models?.find((model) => model.id === currentModelId);
  const modelChoices = (models ?? []).filter(
    (model) =>
      model.availability === 'available' &&
      model.id !== currentModelId &&
      (!currentModel || model.privacyRoute === currentModel.privacyRoute)
  );
  // Taking only the computer back runs nothing, so there is no model to choose for it.
  const runsAgain = trajectory.rewind !== 'computer';
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
      {runsAgain && modelChoices.length > 0 && (
        <label className="rewind-model">
          Model
          <select
            value={trajectory.modelId ?? ''}
            onChange={(event) => onChange({ ...trajectory, modelId: event.target.value })}
          >
            <option value="">
              {currentModel ? `The same model — ${currentModel.displayName}` : 'The same model'}
            </option>
            {modelChoices.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
          <span className="rewind-model-hint">
            A weak answer is often the wrong model rather than the wrong request, and naming one
            here is how that gets tried without retyping it. Only models on this
            conversation&rsquo;s privacy route are offered.
          </span>
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
                // A model named for a fork that then only rewinds the computer is accepted by the
                // server and dropped before it is read, so the draft drops it here instead.
                onChange={() =>
                  onChange({
                    ...trajectory,
                    rewind: scope,
                    ...(scope === 'computer' ? { modelId: '' } : {})
                  })
                }
              />
              <span className="rewind-label">{label}</span>
              <span className="rewind-hint">{unavailable ? offer.computerReason : hint}</span>
            </label>
          );
        })}
      </fieldset>
      {trajectory.rewind !== 'conversation' && offer.computerAvailable && computer && (
        <>
          <ul className="rewind-effects">
            {offer.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
            {/*
              How much, not only how many. A rewind is confirmed on counts alone otherwise, and
              "3 files go back" is a different decision depending on whether that is a config file
              or an afternoon's recording.
            */}
            {(computer.restoredBytes > 0 || computer.removedBytes > 0) && (
              <li>
                {[
                  computer.restoredBytes > 0
                    ? `${formatBytes(computer.restoredBytes)} written back`
                    : '',
                  computer.removedBytes > 0 ? `${formatBytes(computer.removedBytes)} deleted` : ''
                ]
                  .filter(Boolean)
                  .join(', ')}
              </li>
            )}
            {offer.caveats.map((caveat) => (
              <li key={caveat} className="rewind-caveat">
                {caveat}
              </li>
            ))}
            {/*
              The other direction of the caveat the offer already makes: a rewind puts files back,
              and an install is not a file it holds. Uninstalled packages stay uninstalled exactly
              as installed ones stay installed.
            */}
            {computer.packagesRemoved.length > 0 && (
              <li className="rewind-caveat">
                {computer.packagesRemoved.length === 1
                  ? '1 package removed since then stays removed'
                  : `${computer.packagesRemoved.length} packages removed since then stay removed`}{' '}
                — a rewind does not reinstall anything:{' '}
                {computer.packagesRemoved.map((entry) => entry.name).join(', ')}
              </li>
            )}
            <li className="rewind-caveat">{mechanismNote(computer.mechanism)}</li>
          </ul>
          <ComputerDetail computer={computer} />
        </>
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
