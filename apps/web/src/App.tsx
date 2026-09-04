import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { BrandMark } from './BrandMark.js';
import { useUndoQueue } from './Undo.js';
import { composerTaskKind, sendBlock } from './composer-state.js';
import { describeFailure } from './failure-text.js';
import { activeBotWall, taskStateAnnouncement } from './timeline-state.js';
import { upsertTask } from './task-list.js';
import { isLiveTask, pauseAction } from './task-status.js';
import type { Task } from './types.js';

import { exportConversation } from './app/conversation-export.js';
import { paletteCommands } from './app/palette-commands.js';
import { useAgentNotices } from './app/use-agent-notices.js';
import { useAttachments } from './app/use-attachments.js';
import { useBootstrap, useRefreshTriggers, useShellSuperseded } from './app/use-bootstrap.js';
import type { BootstrapRestore } from './app/use-bootstrap.js';
import { useComposerDraft } from './app/use-composer-draft.js';
import { useConversationList } from './app/use-conversation-list.js';
import { useFire } from './app/use-fire.js';
import { useInspector } from './app/use-inspector.js';
import { useMobileNav } from './app/use-mobile-nav.js';
import { useNativeFolderPicker } from './app/use-native-shell.js';
import { useModelChoice } from './app/use-model-choice.js';
import { useOverlays } from './app/use-overlays.js';
import { usePaneFocus } from './app/use-pane-focus.js';
import { useSend } from './app/use-send.js';
import { useShareTarget } from './app/use-share-target.js';
import { useShellStatus } from './app/use-shell-status.js';
import { useSpendCeiling } from './app/use-spend-ceiling.js';
import { useTaskAddressBar, useTaskId } from './app/use-task-route.js';
import { useTrajectory } from './app/use-trajectory.js';
import { useTranscript } from './app/use-transcript.js';
import { useTurnChanges } from './app/use-turn-changes.js';
import { useVoiceNote } from './app/use-voice-note.js';
import { useWindowShortcuts } from './app/use-window-shortcuts.js';
import { useWorkspaceHeartbeat } from './app/use-workspace-heartbeat.js';
import { Workbench } from './app/Workbench.js';

/**
 * Signing in carries the whole passkey dance - enrolment, the recovery path, the QR hand-off to a
 * second device - and an owner who is already signed in never needs a byte of it. Behind `lazy` it
 * leaves the first paint entirely, and the owner who does need it is looking at the splash while it
 * arrives, which is where they were already waiting for the bootstrap request.
 */
const Auth = lazy(() =>
  import('./Auth.js').then(({ Auth: AuthScreen }) => ({ default: AuthScreen }))
);

/**
 * The window: one composition, and every decision in it delegated to something with a name.
 *
 * This was one function of 3,203 lines holding fifty independent `useState` cells — an unaudited
 * state machine with no transition table, and the largest single defect in the repository. Nothing
 * about the screen has changed; what has changed is that each group of cells now sits behind the
 * question it answers, so a reader can find where a rule lives without reading the other forty-nine.
 * The order below is the order the answers depend on each other in, and it is the only order that
 * works: the box first, then what it says about this owner, then what the owner is doing with it.
 */
export function App() {
  const status = useShellStatus();
  const overlays = useOverlays();
  const nav = useMobileNav();
  const composer = useRef<HTMLTextAreaElement>(null);
  const approvalCard = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the box has told this device what the owner chose.
   *
   * Until it has, a save would be this browser's stale copy overwriting the shared one - which is
   * how a phone opened after a month quietly reverts a choice made on the laptop yesterday.
   */
  const serverPreferencesLoaded = useRef(false);
  const focusComposer = useCallback(() => composer.current?.focus(), []);
  const restore = useRef<BootstrapRestore | null>(null);
  const [taskId, setTaskId] = useTaskId();

  const box = useBootstrap({
    restore,
    setTaskId,
    serverPreferencesLoaded,
    onError: status.setError
  });
  const { auth, data, setData, workspaceId, setWorkspaceId, currentData, load } = box;
  const workspace = data?.workspaces.find((item) => item.id === workspaceId);
  const task = data?.tasks.find((item) => item.id === taskId);
  const taskIsActive = isLiveTask(task);
  useTaskAddressBar({ auth, taskId, workspaceId, setTaskId });
  useWorkspaceHeartbeat({ workspace, setData });

  const notices = useAgentNotices({
    auth,
    settingsOpen: Boolean(overlays.settingsPage),
    tasks: data?.tasks,
    taskIsActive,
    currentData,
    focusComposer,
    onError: status.setError
  });
  useRefreshTriggers({
    auth,
    load,
    refreshNotices: notices.loadNotices,
    refreshApprovals: notices.refreshApprovals
  });
  const shellSuperseded = useShellSuperseded();

  const transcript = useTranscript({
    taskId,
    ready: Boolean(data),
    taskIsActive,
    setData,
    currentData,
    onError: status.setError
  });
  const inspector = useInspector({
    taskId,
    task,
    events: transcript.events,
    serverPreferencesLoaded
  });
  const openTools = useCallback(() => inspector.setOpen(true), [inspector.setOpen]);
  const panes = usePaneFocus({ composer, openTools });
  const attachments = useAttachments({ workspace, onError: status.setError });
  const draft = useComposerDraft({
    taskId,
    workspaceId,
    composer,
    attachments: attachments.attachments,
    setAttachments: attachments.setAttachments,
    clearAttachments: attachments.clear,
    serverPreferencesLoaded
  });
  const voice = useVoiceNote({
    workspace,
    // A voice note is usually the second half of a sentence somebody started with their hands.
    onTranscript: (text) =>
      draft.setPrompt((current) => `${current}${current ? '\n\n' : ''}${text}`),
    onError: status.setError,
    onBusy: status.setBusy
  });
  useShareTarget({
    workspace,
    setPrompt: draft.setPrompt,
    uploadFiles: attachments.add,
    onError: status.setError
  });
  const nativeFolderPicker = useNativeFolderPicker();
  /*
   * A challenge takes the browser away from the agent for the whole computer, not just for the turn
   * that walked into it, and only the owner handing control back clears it. The screen has to be
   * able to offer that even after the conversation has moved on.
   */
  const browserWall = useMemo(() => activeBotWall(transcript.events), [transcript.events]);
  const model = useModelChoice({
    auth,
    models: data?.models,
    /* Derived rather than computed inside the effect, so re-ranking is triggered by the answer
       changing and not by the tray being a new array on every render. */
    taskKind: composerTaskKind(attachments.attachments),
    serverPreferencesLoaded
  });
  const blocked = sendBlock({
    workspaceAvailable: Boolean(workspace),
    providerConfigured: Boolean(data?.instance.providerConfigured),
    enforceZeroDataRetention: Boolean(data?.instance.enforceZeroDataRetention),
    availableModelCount: model.models.length,
    modelId: model.modelId
  });
  const send = useSend({
    events: transcript.events,
    taskId,
    task,
    taskIsActive,
    workspace,
    prompt: draft.prompt,
    setPrompt: draft.setPrompt,
    attachments: attachments.attachments,
    setAttachments: attachments.setAttachments,
    block: blocked,
    busy: status.busy,
    setBusy: status.setBusy,
    modelId: model.modelId,
    privacyRoute: model.privacyRoute,
    clearDraftForSend: draft.clearForSend,
    setData,
    setTaskId,
    carryInspectorChoiceInto: inspector.carryChoiceInto,
    clearEvents: () => transcript.setEvents([]),
    focusComposer,
    onNotice: status.setNotice,
    onError: status.setError
  });
  const trajectory = useTrajectory({
    task,
    taskId,
    taskIsActive,
    setData,
    setWorkspaceId,
    setTaskId,
    clearEvents: () => transcript.setEvents([]),
    setBusy: status.setBusy,
    onNotice: status.setNotice,
    onError: status.setError
  });
  const undo = useUndoQueue((cause) =>
    status.setError(describeFailure(cause, 'That change could not be saved'))
  );
  const list = useConversationList({
    data,
    setData,
    currentData,
    taskId,
    setTaskId,
    setWorkspaceId,
    undo: undo.queue,
    onNotice: status.setNotice,
    onError: status.setError
  });
  const ceiling = useSpendCeiling({
    spentTodayUsd: data?.usage.providerSpend.windows.daily.used ?? 0,
    spentThisMonthUsd: data?.usage.providerSpend.windows.monthly.used ?? 0,
    onNotice: status.setNotice,
    onError: status.setError
  });
  const fire = useFire({
    auth,
    data,
    offline: box.offline,
    workspace,
    approvalCount: notices.approvals.length
  });
  const turnChanges = useTurnChanges({
    taskId,
    events: send.timelineEvents,
    status: task?.status ?? ''
  });

  /*
   * The one cycle this screen has, closed here: bootstrap fetches what the owner chose, and the
   * three things that answer to it are built above out of what bootstrap fetched. Assigned during
   * render, so it is in place before any effect can call `load`.
   */
  restore.current = {
    inspector: inspector.applySaved,
    model: model.applySaved,
    drafts: draft.adoptFromBox,
    pruneDrafts: draft.prune
  };

  const startNewConversation = () => {
    setTaskId(undefined);
    nav.setOpen(false);
    draft.setPrompt('');
    window.requestAnimationFrame(() => composer.current?.focus());
  };
  /*
   * Taking the offer to reload, without spending anything on the way through. Everything else on
   * this screen is the box's and arrives again with the next bootstrap; the turn that is running is
   * the box's too, and does not notice.
   */
  const reloadForNewShell = () => {
    draft.bankNow();
    window.location.reload();
  };
  /** Pause and resume, from the header pill and from the palette, through one route. */
  const pauseConversation = (target: Task) =>
    void api
      .taskAction(target.id, pauseAction(target))
      .then((updated) =>
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, updated) } : current
        )
      )
      .catch((cause: unknown) =>
        status.setError(describeFailure(cause, 'Could not change this conversation'))
      );
  const openNotices = () => {
    // Opening it is the moment it has to be current; a notice can arrive while this window has
    // been open all along.
    notices.loadNotices();
    overlays.setNoticeLog(true);
  };
  // Every computer by default: work the owner remembers clearly is not findable when the search is
  // silently scoped to whichever computer happens to be selected.
  const searchConversations = useCallback(
    (query: string, thisComputerOnly = false) =>
      api.search(query, thisComputerOnly ? workspaceId : undefined),
    [workspaceId]
  );

  /** What an export needs, in one place, because two commands ask for the same document. */
  const exportable = {
    task,
    events: transcript.events,
    windowed: transcript.eventWindow.more,
    onNotice: status.setNotice,
    onError: status.setError
  };
  /**
   * The way back to a request that is waiting, from the palette.
   *
   * Deferred a frame on purpose. The palette is a Dialog, and a Dialog returns focus to whatever
   * opened it as it closes — so running this on the same tick focuses the card and then has it
   * taken away again, which is precisely the "Shift+Tab and hope" this exists to end.
   */
  const focusApproval = useCallback(() => {
    window.requestAnimationFrame(() => approvalCard.current?.focus());
  }, []);
  const commands = paletteCommands({
    approvalCount: notices.approvals.length,
    task,
    taskIsActive,
    noticeCount: notices.notices.length,
    actions: {
      focusApproval,
      newConversation: startNewConversation,
      stop: () => void send.stop(),
      pause: pauseConversation,
      pin: (target) => void list.file(target, { pinned: !target.pinned }),
      archive: (target) => void list.file(target, { archived: !target.archivedAt }),
      copy: () => exportConversation({ ...exportable, mode: 'copy' }),
      download: () => exportConversation({ ...exportable, mode: 'download' }),
      share: () => overlays.setShare(true),
      remove: list.remove,
      openTab: inspector.openTab,
      openSettings: () => overlays.openSettings(),
      openSchedules: () => overlays.setSchedules(true),
      openNotices,
      showShortcuts: () => overlays.setShortcutSheet(true)
    }
  });

  useWindowShortcuts({
    stop: () => void send.stop(),
    editLast: () => trajectory.editLast(transcript.events),
    openTool: inspector.openTab,
    active: taskIsActive && !status.busy,
    togglePalette: () => overlays.setPalette((current) => !current),
    newConversation: startNewConversation,
    toggleTools: () => inspector.setOpen((current) => !current),
    focusComposer,
    focusPane: panes.focusPane,
    stepFocus: panes.stepFocus,
    showShortcuts: () => overlays.setShortcutSheet(true)
  });

  const [announcement, setAnnouncement] = useState('');
  /*
   * One sentence per state change, and `awaiting_user` is not one of them.
   *
   * That state means a request card is up, and the card announces itself through this same region
   * with the thing it is about to do named — "Runs a command on your computer" against this one's
   * "The agent needs your approval". Two sentences for one event is the narration this interface is
   * meant to be losing, and worse, they raced: effects run child-first, so whenever the approval
   * poll and the status change landed in one commit this line silently overwrote the better one.
   */
  useEffect(() => {
    if (task && task.status !== 'awaiting_user')
      setAnnouncement(taskStateAnnouncement(task.title, task.status));
  }, [task?.id, task?.status, task?.title]);
  /*
   * The app is a text box, and the last step of opening it was a click nobody should have to make.
   * Once only, on the first successful bootstrap, and never over a dialog or a restored deep link
   * whose transcript is what the owner came back to read.
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (auth !== 'ready' || focusedOnce.current) return;
    focusedOnce.current = true;
    if (taskId || overlays.settingsPage || overlays.schedules) return;
    const frame = window.requestAnimationFrame(() => composer.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [auth, taskId, overlays.settingsPage, overlays.schedules]);

  if (auth === 'loading')
    return (
      <div className="splash">
        <span className="brand-mark large">
          <BrandMark />
        </span>
        {/* A first load that cannot reach the box used to sit on "Opening…" for five minutes with
            no message and no way out, because the runner's own timeout was the only ceiling. */}
        {box.offline ? (
          <>
            <p>{status.error || 'Your athanor is not answering yet.'}</p>
            <button onClick={() => void load()}>Try again</button>
          </>
        ) : (
          <p>Opening your private computer…</p>
        )}
      </div>
    );
  if (auth === 'required' || !data)
    return (
      <Suspense fallback={<div className="splash" />}>
        <Auth onReady={() => void load()} />
      </Suspense>
    );

  return (
    <Workbench
      data={data}
      workspace={workspace}
      task={task}
      taskId={taskId}
      workspaceId={workspaceId}
      taskIsActive={taskIsActive}
      offline={box.offline}
      fire={fire}
      browserWall={browserWall}
      blocked={blocked}
      turnChanges={turnChanges}
      shellSuperseded={shellSuperseded}
      nativeFolderPicker={nativeFolderPicker}
      commands={commands}
      announcement={announcement}
      setAnnouncement={setAnnouncement}
      composer={composer}
      approvalCard={approvalCard}
      setTaskId={setTaskId}
      setWorkspaceId={setWorkspaceId}
      setData={setData}
      setAuth={box.setAuth}
      load={load}
      startNewConversation={startNewConversation}
      reloadForNewShell={reloadForNewShell}
      pauseConversation={pauseConversation}
      openNotices={openNotices}
      searchConversations={searchConversations}
      attachments={attachments}
      ceiling={ceiling}
      draft={draft}
      inspector={inspector}
      list={list}
      model={model}
      nav={nav}
      notices={notices}
      overlays={overlays}
      panes={panes}
      send={send}
      status={status}
      trajectory={trajectory}
      transcript={transcript}
      undo={undo}
      voice={voice}
    />
  );
}
