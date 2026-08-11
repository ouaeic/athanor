import { useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowUp,
  CalendarClock,
  Camera,
  CircleStop,
  Redo2,
  FolderKey,
  Mic,
  Paperclip,
  Plus,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { AttachmentTray } from './AttachmentTray.js';
import { Dialog } from './Dialog.js';
import {
  composerContextLabel,
  composerMenuItems,
  composerPlaceholder,
  modelChoiceFromValue,
  modelSelectValue,
  modelSheetGroups,
  privacyLine,
  sendsOnKey,
  type ComposerMenuItem,
  type ModelChoice
} from './composer-state.js';
import { securityModeCopy, securityModes } from './security-mode.js';
import type { Attachment } from './attachments.js';
import type { CatalogueModel, SecurityMode } from './types.js';

const menuIcons: Record<ComposerMenuItem['action'], ReactNode> = {
  attach: <Paperclip />,
  photo: <Camera />,
  schedule: <CalendarClock />,
  folder: <FolderKey />
};

/**
 * The message box, and the one row of controls under it.
 *
 * This is the control used every session and by every route into athanor, and its worst failures
 * are all failures of state: a box that goes dead while the agent is working, a Stop button that
 * turns back into Send the moment you start typing a correction, a model picker that pins a
 * conversation to a model that cannot answer. None of that is visible in a pure function, so it
 * lives in one component that renders from props alone and can be rendered in a test.
 *
 * It is two rows at every width, and that is a fixed budget rather than a layout that happens to
 * fit: measured at 375x812 the old composer was 176px at rest and 291px with the box full - 36% of
 * the phone - for a text field, six icon buttons, two full-width `<select>`s and a disclaimer
 * nobody reads twice. Everything that was permanent and rarely touched is now one tap behind the
 * `+` or the context chip, and nothing was removed.
 *
 * Typing is deliberately never blocked by work already in flight: the message is echoed locally and
 * the server decides when it runs. Disabling this box was the one thing that made a slow reply feel
 * like a frozen app.
 */
export function Composer({
  banners,
  prompt,
  onPrompt,
  textareaRef,
  attachments,
  onRemoveAttachment,
  onUploadFiles,
  workspaceAvailable,
  taskOpen,
  taskLive,
  busy,
  canSend,
  onSend,
  onStop,
  recording,
  onToggleRecording,
  onSchedule,
  onImportFolder,
  securityMode,
  onSecurityMode,
  providerConfigured,
  enforceZeroDataRetention,
  webSearchNote = '',
  webSearchDisclosure = '',
  onOpenAiSettings,
  models,
  unavailableModels,
  modelChoice,
  onModelChoice
}: {
  /** Whatever must appear directly above the composer: a storage warning, a block, a notice. */
  banners?: ReactNode;
  prompt: string;
  onPrompt: (value: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  attachments: Attachment[];
  onRemoveAttachment: (attachment: Attachment) => void;
  onUploadFiles: (files: File[]) => void;
  workspaceAvailable: boolean;
  taskOpen: boolean;
  /** The agent is working, so Stop is offered and a send becomes a queued follow-up. */
  taskLive: boolean;
  busy: boolean;
  canSend: boolean;
  onSend: (options?: { interrupt?: boolean }) => void;
  onStop: () => void;
  recording: boolean;
  onToggleRecording: () => void;
  onSchedule: () => void;
  /** Only the native client can hand over a local folder, so the item only exists there. */
  onImportFolder?: () => void;
  securityMode: SecurityMode;
  onSecurityMode: (mode: SecurityMode) => void;
  providerConfigured: boolean;
  enforceZeroDataRetention: boolean;
  /** Where this conversation's searches go, when that is somewhere other than this computer. */
  webSearchNote?: string;
  /** The whole sentence behind that note, for the control's title. */
  webSearchDisclosure?: string;
  onOpenAiSettings: () => void;
  models: CatalogueModel[];
  unavailableModels: CatalogueModel[];
  modelChoice: ModelChoice;
  onModelChoice: (choice: ModelChoice) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const cameraAttachments = useRef<HTMLInputElement>(null);

  const menuItems = composerMenuItems({
    workspaceAvailable,
    busy,
    canImportFolder: Boolean(onImportFolder)
  });
  const runMenuItem = (action: ComposerMenuItem['action']) => {
    if (action === 'attach') filePicker.current?.click();
    else if (action === 'photo') cameraAttachments.current?.click();
    else if (action === 'schedule') onSchedule();
    else onImportFolder?.();
    setMenuOpen(false);
  };

  const selectedModel = modelSelectValue(modelChoice);
  const contextLabel = composerContextLabel({
    providerConfigured,
    securityMode,
    modelChoice,
    // A pinned model that has gone unavailable still has to be named on the chip, or the chip stops
    // describing the conversation at exactly the moment the owner needs to know why it will not run.
    models: [...models, ...unavailableModels]
  });

  return (
    <section
      className={`composer-wrap ${dragging ? 'dropping' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        onUploadFiles([...event.dataTransfer.files]);
      }}
    >
      {/*
        Anything that has to sit above the composer sits inside it, in flow.

        These used to be absolutely positioned against the viewport with a hand-tuned `bottom` -
        144px, then 188px at one breakpoint, then `var(--bottom-bar) + 182px` at another - while the
        composer they were meant to clear is itself bottom-pinned and grows as the owner types. So
        the numbers were always chasing a moving target, and a storage warning painted over the
        first line of the sentence being written: the one moment the wording matters most. Stacked
        here they move with the composer at every width and every height, and there is no number to
        keep in sync.

        Exactly one of them at a time - `composerStrip` decides which - so this needs no bound of
        its own. The tallest thing that can appear here is the approval card, and that already caps
        itself at 40vh and scrolls its own overflow, which is what keeps the message box on a 667px
        phone where `.workbench` clips what does not fit.

        This is also where a send that cannot go anywhere is answered: `sendBlock` names what is
        wrong and the control that repairs it, and it is drawn here rather than inside the composer
        so the message never competes with the row that has to stay two lines tall.
      */}
      {banners}
      {/*
        The halo burns while the machine does.

        It used to orbit the composer for ever, which made the product's one piece of permanent
        decoration exactly as informative as wallpaper. Bound to the turn it becomes the largest
        thing on screen that says the computer is working - visible from across a room, and gone
        the moment it stops.
      */}
      <div className={`composer ${taskLive ? 'working' : ''}`}>
        <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
        {/*
          Writable while the box is still coming up.

          This carried `disabled={!workspaceAvailable}`, which is the state a new owner arrives in
          while their computer is being provisioned — so the first screen of the product was a grey
          box that could not be typed into, and the one sentence written to explain that state was
          gated behind having typed something. The draft is kept on this device and on the server,
          the strip above says what is happening, and Enter answers with the block rather than
          swallowing the keystroke; waiting is a fine thing to ask of someone, being stuck is not.
        */}
        <textarea
          {...(textareaRef ? { ref: textareaRef } : {})}
          rows={1}
          value={prompt}
          onPaste={(event) => {
            // Screenshots arrive as clipboard files with no name; give them one so the upload path
            // and the agent both have something meaningful to refer to.
            const files = [...event.clipboardData.files];
            if (!files.length) return;
            event.preventDefault();
            onUploadFiles(
              files.map((file, index) =>
                file.name
                  ? file
                  : new File([file], `pasted-${index + 1}.${file.type.split('/')[1] ?? 'png'}`, {
                      type: file.type
                    })
              )
            );
          }}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder={composerPlaceholder({ workspaceAvailable, taskOpen, taskLive })}
          onKeyDown={(event) => {
            if (!sendsOnKey(event)) return;
            event.preventDefault();
            onSend();
          }}
        />
        <div className="composer-bottom">
          {/*
            One row, and it may never become two. It carries a new class rather than the one the
            wrapping row had, because wrapping is exactly the behaviour being removed: below 430px
            that row took a second and sometimes a third line and the composer grew under the
            owner's thumb while they were reading it.
          */}
          <div className="composer-row">
            <button
              className="icon-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Add to this message"
              aria-label="Add to this message"
              onClick={() => setMenuOpen(true)}
            >
              <Plus />
            </button>
            {/*
              Voice keeps its own button at every width. It is the one input a phone is better at
              than a laptop, and putting the best thing about the small screen two taps deep on the
              small screen is the trade this row exists to avoid.
            */}
            <button
              className={`icon-btn ${recording ? 'recording' : ''}`}
              title={recording ? 'Stop voice recording' : 'Record a voice note'}
              aria-label={recording ? 'Stop voice recording' : 'Record a voice note'}
              aria-pressed={recording}
              disabled={!workspaceAvailable || busy}
              onClick={onToggleRecording}
            >
              {recording ? <CircleStop /> : <Mic />}
            </button>
            {/*
              The hidden inputs stay on the row rather than inside the menu: the menu unmounts on
              the same click that asks one of them to open, and a ref into an unmounted portal is
              null - the tap would do nothing at all.
            */}
            <input
              ref={filePicker}
              hidden
              type="file"
              multiple
              onChange={(event) => {
                onUploadFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <input
              ref={cameraAttachments}
              hidden
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => {
                onUploadFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            {/*
              One chip for how this turn is answered, in place of two selects and a footer.

              Without a provider there is nothing to answer with, so the chip is the owner's move
              and carries the one ember mark on this row. Ember is never used here for anything
              else: a configured composer is a machine at rest and says so in silver.
            */}
            <button
              className={`composer-context ${providerConfigured ? '' : 'needs-provider'}`}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              title={
                providerConfigured
                  ? securityModeCopy[securityMode].description
                  : 'Connect an AI provider'
              }
              onClick={() => setSheetOpen(true)}
            >
              {providerConfigured ? (
                <ShieldCheck />
              ) : (
                <span className="composer-context-dot" aria-hidden="true" />
              )}
              <span className="composer-context-label">{contextLabel}</span>
            </button>
          </div>
          {/*
            Stop and Send are two controls, not one control in two moods. Stop used to appear only
            while the composer was empty, so the realistic sequence — the agent goes wrong, you
            start typing a correction, you decide to just stop it — silently turned Stop back into
            Send and you had to delete what you typed to reach it. Escape does the same thing from
            anywhere in the workbench.
          */}
          {taskLive && (
            <button
              className="send-btn stopping"
              aria-label="Stop the agent"
              title="Stop the agent (Esc)"
              disabled={busy}
              onClick={onStop}
            >
              <CircleStop />
            </button>
          )}
          {/*
            A third control while the agent is working, for the same reason Stop is a second one:
            "queue this for after" and "no, do this instead" are different things to want, and a
            send that guessed between them from the fact that the task happened to be busy would be
            wrong half the time. Queueing stays on the plain arrow, so nothing changes for anyone
            who is not steering.
          */}
          {taskLive && (
            <button
              className="send-btn correcting"
              aria-label="Correct the running task now"
              title="Apply now, keeping the work so far"
              disabled={!canSend || busy}
              onClick={() => onSend({ interrupt: true })}
            >
              {/* One word, because there is no hover on a phone: three round buttons appear together
                  the moment work starts, two of them are arrows, and the only thing telling this one
                  from Send was a `title` a touchscreen never shows. */}
              <Redo2 />
              <span>Now</span>
            </button>
          )}
          <button
            className="send-btn"
            aria-label={taskLive ? 'Queue follow-up' : 'Send message'}
            disabled={!canSend || busy}
            onClick={() => onSend()}
          >
            <ArrowUp />
          </button>
        </div>
      </div>
      {menuOpen && (
        <Dialog
          backdropClassName="modal-backdrop composer-sheet-backdrop"
          className="modal composer-sheet composer-menu"
          label="Add to this message"
          closeOnBackdrop
          onClose={() => setMenuOpen(false)}
        >
          <div role="menu" aria-label="Add to this message">
            {menuItems.map((item) => (
              <button
                key={item.action}
                role="menuitem"
                className="composer-sheet-row"
                disabled={item.disabled}
                onClick={() => runMenuItem(item.action)}
              >
                {menuIcons[item.action]}
                <span className="composer-sheet-label">{item.label}</span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {sheetOpen && (
        <Dialog
          backdropClassName="modal-backdrop composer-sheet-backdrop"
          className="modal composer-sheet"
          label="How this turn is answered"
          closeOnBackdrop
          onClose={() => setSheetOpen(false)}
        >
          <div className="composer-sheet-group">
            <h3>How much it asks</h3>
            {securityModes.map((mode) => (
              <button
                key={mode}
                className={`composer-sheet-row ${mode === securityMode ? 'chosen' : ''}`}
                aria-pressed={mode === securityMode}
                disabled={!workspaceAvailable || busy}
                onClick={() => {
                  onSecurityMode(mode);
                  setSheetOpen(false);
                }}
              >
                <span className="composer-sheet-label">{securityModeCopy[mode].label}</span>
                <span className="composer-sheet-note">{securityModeCopy[mode].description}</span>
              </button>
            ))}
          </div>
          {providerConfigured ? (
            modelSheetGroups({ models, unavailableModels, enforceZeroDataRetention }).map(
              (group) => (
                <div className="composer-sheet-group" key={group.label}>
                  <h3>{group.label}</h3>
                  {group.options.map((option) => (
                    <button
                      key={option.value}
                      className={`composer-sheet-row ${
                        option.value === selectedModel ? 'chosen' : ''
                      }`}
                      aria-pressed={option.value === selectedModel}
                      disabled={option.disabled}
                      onClick={() => {
                        onModelChoice(modelChoiceFromValue(option.value));
                        setSheetOpen(false);
                      }}
                    >
                      <span className="composer-sheet-label">{option.label}</span>
                      {option.note ? (
                        <span className="composer-sheet-note">{option.note}</span>
                      ) : undefined}
                    </button>
                  ))}
                </div>
              )
            )
          ) : (
            <button
              className="composer-sheet-connect"
              onClick={() => {
                setSheetOpen(false);
                onOpenAiSettings();
              }}
            >
              <Sparkles />
              Connect an AI provider
            </button>
          )}
          {/*
            The footer used to carry five separate statements: no-logs, the privacy route, which
            model, how images are routed, and "your persistent agent computer". Four of those said
            something the owner already knows or cannot act on, and the fifth was printed under
            every conversation for ever, which is how a fact worth a glance became wallpaper. What
            remains is the one line that changes between installs - where inference goes, and where
            a search goes when that is somewhere else - inside the sheet that changes it.
          */}
          <button
            className={`composer-sheet-privacy ${
              enforceZeroDataRetention ? 'private' : 'provider-policy'
            }`}
            title={
              webSearchDisclosure
                ? `${webSearchDisclosure} Change this in Settings.`
                : 'Change model privacy in Settings'
            }
            onClick={() => {
              setSheetOpen(false);
              onOpenAiSettings();
            }}
          >
            <ShieldCheck />
            <span>{privacyLine({ enforceZeroDataRetention, webSearchNote })}</span>
          </button>
        </Dialog>
      )}
    </section>
  );
}
