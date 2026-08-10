import { useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowUp,
  CalendarClock,
  Camera,
  ChevronDown,
  CircleStop,
  Redo2,
  FolderKey,
  Mic,
  Paperclip,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { AttachmentTray } from './AttachmentTray.js';
import {
  composerPlaceholder,
  modelChoiceFromValue,
  modelSelectValue,
  sendsOnKey,
  type ModelChoice
} from './composer-state.js';
import { securityModeCopy, securityModes } from './security-mode.js';
import type { Attachment } from './attachments.js';
import type { CatalogueModel, SecurityMode } from './types.js';

/**
 * The message box, and everything on its two rails.
 *
 * This is the control used every session and by every route into athanor, and its worst failures
 * are all failures of state: a box that goes dead while the agent is working, a Stop button that
 * turns back into Send the moment you start typing a correction, a model picker that pins a
 * conversation to a model that cannot answer. None of that is visible in a pure function, so it
 * lives in one component that renders from props alone and can be rendered in a test.
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
  /** Only the native client can hand over a local folder, so the button only exists there. */
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
  const filePicker = useRef<HTMLInputElement>(null);
  const cameraAttachments = useRef<HTMLInputElement>(null);
  const noModels = models.length === 0;

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
          disabled={!workspaceAvailable}
          onKeyDown={(event) => {
            if (!sendsOnKey(event)) return;
            event.preventDefault();
            onSend();
          }}
        />
        <div className="composer-bottom">
          <div className="composer-tools">
            <button
              className="icon-btn composer-attachment"
              title="Attach files"
              aria-label="Attach files"
              onClick={() => filePicker.current?.click()}
            >
              <Paperclip />
            </button>
            <button
              className="icon-btn mobile-capture"
              title="Take a photo"
              aria-label="Take a photo"
              disabled={!workspaceAvailable || busy}
              onClick={() => cameraAttachments.current?.click()}
            >
              <Camera />
            </button>
            <button
              className={`icon-btn mobile-capture ${recording ? 'recording' : ''}`}
              title={recording ? 'Stop voice recording' : 'Record a voice note'}
              aria-label={recording ? 'Stop voice recording' : 'Record a voice note'}
              aria-pressed={recording}
              disabled={!workspaceAvailable || busy}
              onClick={onToggleRecording}
            >
              {recording ? <CircleStop /> : <Mic />}
            </button>
            <button
              className="icon-btn"
              title="Schedule this work"
              aria-label="Schedule this work"
              disabled={!workspaceAvailable}
              onClick={onSchedule}
            >
              <CalendarClock />
            </button>
            {onImportFolder && (
              <button
                className="icon-btn"
                title="Import a local folder"
                aria-label="Import a local folder"
                onClick={onImportFolder}
              >
                <FolderKey />
              </button>
            )}
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
            <div className="security-select" title={securityModeCopy[securityMode].description}>
              <ShieldCheck />
              <select
                aria-label="Security mode"
                value={securityMode}
                disabled={!workspaceAvailable || busy}
                onChange={(event) => onSecurityMode(event.target.value as SecurityMode)}
              >
                {securityModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {securityModeCopy[mode].label}
                  </option>
                ))}
              </select>
              <ChevronDown />
            </div>
            {!providerConfigured ? (
              <button className="model-connect-button" onClick={onOpenAiSettings}>
                <Sparkles /> Connect AI
              </button>
            ) : (
              <div className="model-select">
                <Sparkles />
                <select
                  aria-label="Model"
                  value={modelSelectValue(modelChoice)}
                  onChange={(event) => onModelChoice(modelChoiceFromValue(event.target.value))}
                >
                  <optgroup label="Automatic">
                    <option value="auto:balanced" disabled={noModels}>
                      {noModels ? 'No model available' : 'Recommended'}
                    </option>
                    <option value="auto:fast" disabled={noModels}>
                      Faster
                    </option>
                    <option value="auto:best" disabled={noModels}>
                      Higher quality
                    </option>
                  </optgroup>
                  <optgroup label="Choose a specific model">
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </optgroup>
                  {unavailableModels.length > 0 && (
                    <optgroup
                      label={
                        enforceZeroDataRetention
                          ? 'Unavailable · no verified private route'
                          : 'Currently unavailable'
                      }
                    >
                      {unavailableModels.map((model) => (
                        <option key={model.id} value={model.id} disabled>
                          {model.displayName}
                          {model.availability === 'review'
                            ? ' · licence review required'
                            : enforceZeroDataRetention
                              ? ' · private route unavailable'
                              : ' · provider unavailable'}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <ChevronDown />
              </div>
            )}
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
              <Redo2 />
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
      {/*
        The footer used to carry five separate statements: no-logs, the privacy route, which model,
        how images are routed, and "your persistent agent computer". Four of those said something
        the user already knows or cannot act on. What remains is the one fact that changes between
        installs and is worth a glance - where inference goes - and it is the control that changes
        it.

        Where the searches go is the second half of that same fact, and it is added to the same
        control rather than beside it: one button, one place to change both. It appears only when a
        query would actually leave this computer, because the in-house answer is the default posture
        and a badge that is always there is a badge nobody reads on the day it changes.
      */}
      <div className="composer-foot">
        <button
          className={`composer-privacy ${enforceZeroDataRetention ? 'private' : 'provider-policy'}`}
          onClick={onOpenAiSettings}
          title={
            webSearchNote
              ? `${webSearchDisclosure} Change this in Settings.`
              : 'Change model privacy in Settings'
          }
        >
          <ShieldCheck />
          {enforceZeroDataRetention ? 'Private AI routes only' : 'Provider data policy applies'}
          {webSearchNote ? ` · ${webSearchNote}` : ''}
        </button>
      </div>
    </section>
  );
}
