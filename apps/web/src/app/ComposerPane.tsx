import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Composer } from '../Composer.js';
import { composerStrip } from '../composer-strip.js';
import { hasSomethingToSend, type SendBlock } from '../composer-state.js';
import { hostStorageBlocksWork } from '../usage-model.js';
import { webSearchNote } from '../web-search-route.js';
import type { Bootstrap, SecurityMode, Task, TaskEvent, Workspace } from '../types.js';

import { ComposerBanners } from './ComposerBanners.js';
import { SpendCeilingBanner } from './SpendCeilingBanner.js';
import { importNativeFolder } from './native-folder-import.js';
import type { useAttachments } from './use-attachments.js';
import type { useAgentNotices } from './use-agent-notices.js';
import type { useComposerDraft } from './use-composer-draft.js';
import type { useInspector } from './use-inspector.js';
import type { useModelChoice } from './use-model-choice.js';
import type { useOverlays } from './use-overlays.js';
import type { useSend } from './use-send.js';
import type { useShellStatus } from './use-shell-status.js';
import type { useSpendCeiling } from './use-spend-ceiling.js';
import type { useVoiceNote } from './use-voice-note.js';

/**
 * The message box, and the one shelf above it.
 *
 * Both halves of the same question — what the owner is about to send, and the single thing the
 * window is allowed to say about whether it can be sent. Held together because the shelf's ranking
 * reads the send block, the connection, the disk and the queue, and every one of those is already
 * an argument to the box below it.
 */
export function ComposerPane(props: {
  data: Bootstrap;
  workspace: Workspace | undefined;
  task: Task | undefined;
  taskId: string | undefined;
  taskIsActive: boolean;
  offline: boolean;
  blocked: SendBlock | undefined;
  nativeFolderPicker: boolean;
  openTaskEvents: TaskEvent[];
  streamDegraded: boolean;
  taskTitles: Record<string, string>;
  composer: RefObject<HTMLTextAreaElement | null>;
  approvalCard: RefObject<HTMLDivElement | null>;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  setAnnouncement: (sentence: string) => void;
  load: () => Promise<void>;
  attachments: ReturnType<typeof useAttachments>;
  ceiling: ReturnType<typeof useSpendCeiling>;
  draft: ReturnType<typeof useComposerDraft>;
  inspector: ReturnType<typeof useInspector>;
  model: ReturnType<typeof useModelChoice>;
  notices: ReturnType<typeof useAgentNotices>;
  overlays: ReturnType<typeof useOverlays>;
  send: ReturnType<typeof useSend>;
  status: ReturnType<typeof useShellStatus>;
  voice: ReturnType<typeof useVoiceNote>;
}) {
  const {
    data,
    workspace,
    task,
    taskId,
    taskIsActive,
    blocked,
    nativeFolderPicker,
    composer,
    approvalCard,
    setTaskId,
    setAnnouncement,
    load,
    attachments,
    ceiling,
    draft,
    inspector,
    model,
    notices,
    overlays,
    send,
    status,
    voice
  } = props;
  const canSend = hasSomethingToSend(draft.prompt, attachments.attachments);
  /*
   * The block is the only thing that matters while it is on screen, so nothing else competes for
   * the strip above the composer.
   *
   * A missing computer is the exception, and it was the one state this got wrong. The box being
   * absent is a fact about the machine rather than an answer to a keystroke, and it was gated on
   * there being something to send — which on a first sign-in, while the box is still being
   * provisioned, there never is. So the sentence written for exactly this state could not be
   * reached from it, and a new owner got a grey message box and a pill.
   */
  const showBlock = Boolean(blocked) && (canSend || blocked?.code === 'workspace_unavailable');
  const stripKind = composerStrip({
    approval: notices.approvals.length > 0,
    block: showBlock,
    offline: props.offline,
    storage: hostStorageBlocksWork(workspace ?? {}),
    error: Boolean(status.error),
    streamDegraded: props.streamDegraded,
    notice: Boolean(status.notice)
  });
  /*
   * The ceiling question takes the empty shelf, which is strictly below all seven ranked kinds.
   * `stripKind` being set is the same thing as the banner drawing something: the two kinds whose
   * body is conditional — `block` and `storage` — are each ranked on the very value they read.
   */
  const banners = stripKind ? (
    <ComposerBanners
      kind={stripKind}
      approvals={notices.approvals}
      workspaceId={workspace?.id}
      openTaskId={taskId}
      taskTitles={props.taskTitles}
      openTaskEvents={props.openTaskEvents}
      approvalFailure={notices.approvalFailure}
      cardRef={approvalCard}
      onOpenTask={setTaskId}
      onOpenComputer={() => inspector.openTab('computer')}
      onOpenFiles={() => inspector.openTab('files')}
      onAnnounce={setAnnouncement}
      onResolve={notices.resolve}
      block={blocked}
      onOpenSettings={overlays.openSettings}
      onRetryConnection={() => void load()}
      diskFreeBytes={workspace?.hostStorageAvailableBytes}
      error={status.error}
      onDismissError={() => status.setError('')}
      notice={status.notice}
      onDismissNotice={() => status.setNotice('')}
    />
  ) : ceiling.ask ? (
    <SpendCeilingBanner
      ask={ceiling.ask}
      draft={ceiling.draft}
      busy={ceiling.busy}
      onDraft={ceiling.setDraft}
      onAnswer={(value) => void ceiling.answer(value)}
    />
  ) : undefined;
  const webRoute = data.instance.webSearch;
  return (
    <Composer
      banners={banners}
      prompt={draft.prompt}
      onPrompt={draft.setPrompt}
      textareaRef={composer}
      attachments={attachments.attachments}
      onRemoveAttachment={attachments.remove}
      onUploadFiles={attachments.add}
      workspaceAvailable={Boolean(workspace)}
      taskOpen={send.canContinueTask}
      taskLive={taskIsActive}
      busy={status.busy}
      canSend={canSend}
      onSend={(options) => void send.send(options ?? {})}
      onStop={() => void send.stop()}
      recording={voice.recording}
      onToggleRecording={() => void voice.toggle()}
      onSchedule={() => overlays.setSchedules(true)}
      {...(nativeFolderPicker
        ? {
            onImportFolder: () =>
              void importNativeFolder({
                workspace,
                addAttachments: attachments.setAttachments,
                setBusy: status.setBusy,
                onError: status.setError
              })
          }
        : {})}
      securityMode={task?.securityMode ?? workspace?.securityMode ?? 'balanced'}
      onSecurityMode={(mode: SecurityMode) => void send.changeSecurityMode(mode)}
      providerConfigured={data.instance.providerConfigured}
      enforceZeroDataRetention={data.instance.enforceZeroDataRetention}
      webSearchNote={webSearchNote(webRoute)}
      webSearchDisclosure={webRoute?.disclosure ?? ''}
      onOpenAiSettings={() => overlays.openSettings('ai')}
      models={model.models}
      unavailableModels={model.unavailableModels}
      modelReasons={model.reasons}
      capUsd={send.capUsd}
      onCapUsd={send.setCapUsd}
      taskCapUsd={task?.maxSpendUsd ?? null}
      modelChoice={
        model.automatic
          ? { automatic: true, preference: model.preference }
          : { automatic: false, modelId: model.modelId }
      }
      onModelChoice={model.choose}
    />
  );
}
