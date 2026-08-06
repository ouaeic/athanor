import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  HardDrive,
  Keyboard,
  Menu,
  Monitor,
  MessageSquarePlus,
  PanelRight,
  Pause,
  Play,
  Sparkles,
  TerminalSquare,
  WifiOff,
  X
} from 'lucide-react';
import { Auth } from './Auth.js';
import { api, ApiFailure } from './api.js';
import { BrandMark } from './BrandMark.js';
import { Approvals, NoticeLog, ScheduleModal } from './TaskModals.js';
import type { SettingsPage } from './SelfHostedSettings.js';
import { Sidebar } from './Sidebar.js';
import { Timeline } from './Timeline.js';
import type {
  Approval,
  Bootstrap,
  ModelRelease,
  SecurityMode,
  Task,
  TaskEvent,
  TaskRewindPreview
} from './types.js';
import { nativeBridge, nativeTarget } from './native.js';
import { consumeSharedPayload } from './share-target.js';
import {
  activeBotWall,
  conversationMarkdown,
  formatBytes,
  mergeTaskEvent,
  taskStateAnnouncement,
  withPendingMessage,
  type PendingUserMessage
} from './timeline-state.js';
import { composerSubmission, hasSomethingToSend, sendBlock } from './composer-state.js';
import { removeTask, upsertTask } from './task-list.js';
import { isLiveTask, isTerminalTask, pauseAction, terminalTaskStatuses } from './task-status.js';
import { loosensSecurity, securityModeNotice } from './security-mode.js';
import { Dialog } from './Dialog.js';
import { UndoProvider, UndoToasts, useUndoQueue } from './Undo.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import {
  clearDraft,
  pruneDrafts,
  readDraft,
  readInspectorChoice,
  readModelChoice,
  writeDraft,
  writeInspectorChoice,
  writeModelChoice,
  type InspectorTab
} from './client-state.js';
import { describeFailure } from './failure-text.js';
import { modelDisplayName } from './model-names.js';
import type { AgentNotification } from './notice-log.js';
import { rewindOffer, rewindResultNotice, type TrajectoryDraft } from './rewind.js';
import { RewindDialog } from './RewindDialog.js';
import { shortcutRows, windowShortcut } from './shortcuts.js';
import { hostStoragePercent } from './usage-model.js';
import { attachmentPath, planUploads, voiceNoteExtension, type Attachment } from './attachments.js';
import { Composer } from './Composer.js';
import { webSearchNote, webSearchRouteFor } from './web-search-route.js';

const Inspector = lazy(() =>
  import('./Inspector.js').then(({ Inspector: InspectorComponent }) => ({
    default: InspectorComponent
  }))
);

/**
 * Settings is a modal nobody has open on first paint, and it carries the provider forms, the spend
 * limits, the connector catalogue, the security pages and the QR encoder with it. Behind `lazy` all
 * of that costs nothing until the owner actually opens Settings.
 */
const SelfHostedSettings = lazy(() =>
  import('./SelfHostedSettings.js').then(({ SelfHostedSettings: Settings }) => ({
    default: Settings
  }))
);

export function App() {
  const [auth, setAuth] = useState<'loading' | 'required' | 'ready'>('loading');
  const [data, setData] = useState<Bootstrap>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  // Read from the address bar on the first render rather than after bootstrap resolves, so the
  // conversation's own draft is the one restored into the composer instead of the new-chat draft.
  const [taskId, setTaskId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get('task') ?? undefined
  );
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // The device's own copy, kept only so the first paint has something and so a box that cannot be
  // reached still offers the last choice. The server's copy is the real one and replaces it below.
  const storedModel = useRef(readModelChoice());
  const storedInspector = useRef(readInspectorChoice());
  /**
   * Whether the box has told this device what the owner chose.
   *
   * Until it has, a save would be this browser's stale copy overwriting the shared one - which is
   * how a phone opened after a month quietly reverts a choice made on the laptop yesterday.
   */
  const serverPreferencesLoaded = useRef(false);
  const [prompt, setPrompt] = useState(() =>
    readDraft(new URLSearchParams(window.location.search).get('task') ?? undefined)
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelPreference, setModelPreference] = useState<'fast' | 'balanced' | 'best'>(
    storedModel.current?.preference ?? 'balanced'
  );
  const [modelAutomatic, setModelAutomatic] = useState(storedModel.current?.automatic ?? true);
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([]);
  const [modelId, setModelId] = useState(storedModel.current?.modelId ?? '');
  const [busy, setBusy] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(false);
  const [streamDegraded, setStreamDegraded] = useState(false);
  const lastSequence = useRef(0);
  const [trajectory, setTrajectory] = useState<TrajectoryDraft>();
  const [rewindPreview, setRewindPreview] = useState<TaskRewindPreview>();
  const [pendingSend, setPendingSend] = useState<PendingUserMessage>();
  const [missingTask, setMissingTask] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>();
  const [scheduleModal, setScheduleModal] = useState(false);
  const [notices, setNotices] = useState<AgentNotification[]>([]);
  const [noticeLog, setNoticeLog] = useState(false);
  const [shortcutSheet, setShortcutSheet] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(storedInspector.current?.open ?? false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(
    storedInspector.current?.tab ?? 'files'
  );
  const [nativeFolderPicker, setNativeFolderPicker] = useState(false);
  const [recording, setRecording] = useState(false);
  const [palette, setPalette] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const uploads = useRef(new Map<string, () => void>());
  // Window-level shortcuts are registered once and must not capture the first render's closures.
  const live = useRef<{ stop: () => void; editLast: () => void; active: boolean }>({
    stop: () => undefined,
    editLast: () => undefined,
    active: false
  });
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const recordedChunks = useRef<Blob[]>([]);
  const pendingShareId = useRef(new URLSearchParams(window.location.search).get('share'));
  const consumingShare = useRef(false);
  const currentData = useRef<Bootstrap | undefined>(undefined);
  const pendingNativeTarget = useRef<{ kind: 'task' | 'workspace'; id: string } | undefined>(
    undefined
  );
  const trajectoryPrompt = useRef<HTMLTextAreaElement>(null);

  // The composer grows with the draft up to the CSS max-height, then scrolls. Without this a
  // multi-paragraph prompt is edited through a single visible line.
  useEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [prompt]);

  /*
   * A draft belongs to the conversation it was typed against.
   *
   * It used to be one global string, so a half-written message followed the owner into a different
   * conversation and Enter sent it there. Swapping on `taskId` — banking what is on screen under
   * the conversation being left, then restoring whatever that conversation was owed — makes the
   * composer part of the conversation rather than part of the window.
   */
  const savedDraft = useRef({ taskId, prompt });
  useEffect(() => {
    if (savedDraft.current.taskId !== taskId) {
      writeDraft(savedDraft.current.taskId, savedDraft.current.prompt);
      const restored = readDraft(taskId);
      savedDraft.current = { taskId, prompt: restored };
      setPrompt(restored);
      // Uploads belong to the message being written, and that message stayed behind.
      for (const item of attachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      setAttachments([]);
      return;
    }
    savedDraft.current = { taskId, prompt };
    // Debounced: a write per keystroke on a multi-paragraph prompt is a synchronous storage call
    // on every character typed.
    const timer = window.setTimeout(() => {
      writeDraft(taskId, prompt);
      // And to the box, so the sentence is where the owner's other device can find it - which is
      // the whole reason drafts are kept at all. Longer than the local write because it is a
      // request rather than a string assignment, and a failure is silent: the device's own copy is
      // already saved, and there is nothing here worth interrupting someone mid-sentence for.
      if (!serverPreferencesLoaded.current || !workspaceId) return;
      void api
        .saveDraft({ workspaceId, taskId: taskId ?? null, body: prompt })
        .catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [taskId, prompt, workspaceId]);
  useEffect(() => {
    const choice = { automatic: modelAutomatic, preference: modelPreference, modelId };
    writeModelChoice(choice);
    // And to the box, because this is a choice about the owner rather than about the browser they
    // happened to make it in. Debounced: dragging through the preference list is one decision, not
    // three. A failed save leaves the device's copy in place and the next change tries again -
    // there is nothing here worth interrupting the owner over.
    if (!serverPreferencesLoaded.current) return;
    const timer = window.setTimeout(() => {
      void api.savePreferences({ model: choice }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [modelAutomatic, modelPreference, modelId]);
  useEffect(() => {
    writeInspectorChoice({ open: inspectorOpen, tab: inspectorTab });
  }, [inspectorOpen, inspectorTab]);
  // Where the owner is, told to the box so the next device can start there. Debounced like the
  // model choice, and only once the server's own answer has arrived, so opening the app never
  // reports the blank conversation it shows for an instant on the way to the real one.
  useEffect(() => {
    if (!serverPreferencesLoaded.current || !workspaceId) return;
    const timer = window.setTimeout(() => {
      void api
        .savePreferences({ place: { taskId: taskId ?? null, workspaceId } })
        .catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [taskId, workspaceId]);
  useEffect(() => {
    if (trajectory?.operation !== 'edit') return;
    const frame = window.requestAnimationFrame(() => trajectoryPrompt.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [trajectory?.operation]);
  /*
   * What taking the computer back would actually do, asked before it is offered.
   *
   * The dialog has always let the owner rewind files as well as conversation, and has always said
   * so in one generic sentence — including for turns where no restore point exists, where choosing
   * it would simply fail. The server can describe the restore; this asks it to.
   */
  useEffect(() => {
    setRewindPreview(undefined);
    if (!trajectory || !taskId) return;
    let active = true;
    void api
      .taskRewindPreview(taskId, trajectory.eventId)
      .then((preview) => {
        if (active) setRewindPreview(preview);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [taskId, trajectory?.eventId]);
  const openSettings = (page: SettingsPage = 'ai') => setSettingsPage(page);
  const undo = useUndoQueue((cause) =>
    setError(describeFailure(cause, 'That change could not be saved'))
  );

  const startNewConversation = () => {
    setTaskId(undefined);
    setMobileNav(false);
    setPrompt('');
    window.requestAnimationFrame(() => composer.current?.focus());
  };

  const applyNativeTarget = (
    target: { kind: 'task' | 'workspace'; id: string },
    source = currentData.current
  ): boolean => {
    if (!source) return false;
    if (target.kind === 'task') {
      const linkedTask = source.tasks.find((item) => item.id === target.id);
      if (!linkedTask) return false;
      setWorkspaceId(linkedTask.workspaceId);
      setTaskId(linkedTask.id);
      return true;
    }
    if (!source.workspaces.some((item) => item.id === target.id)) return false;
    setWorkspaceId(target.id);
    setTaskId(undefined);
    return true;
  };

  const load = useCallback(async () => {
    try {
      const response = await api.bootstrap();
      const next: Bootstrap = { ...response, schedules: response.schedules ?? [] };
      setData(next);
      // What the owner chose, from the one place that is the same on every device they use. Applied
      // once per load and before any save is allowed, so the device adopts the shared answer rather
      // than arguing with it. A box that has never been told anything leaves this device's copy be.
      const savedModel = next.user.preferences?.model;
      if (savedModel) {
        setModelPreference(savedModel.preference);
        setModelAutomatic(savedModel.automatic);
        if (savedModel.modelId) setModelId(savedModel.modelId);
      }
      // What the owner was part-way through typing, wherever they typed it. Only adopted when this
      // device has nothing of its own for that conversation: a sentence being typed here right now
      // must never be replaced by an older one the box is still holding.
      for (const draft of next.drafts ?? []) {
        const key = draft.taskId ?? undefined;
        if (readDraft(key)) continue;
        writeDraft(key, draft.body);
        if ((key ?? undefined) === (savedDraft.current.taskId ?? undefined)) {
          savedDraft.current = { taskId: savedDraft.current.taskId, prompt: draft.body };
          setPrompt(draft.body);
        }
      }
      serverPreferencesLoaded.current = true;
      setAuth('ready');
      setOffline(false);
      // Drafts for conversations this device can no longer open would otherwise accumulate forever
      // in a store the browser silently stops accepting writes to. The open conversation is spared
      // explicitly: bootstrap carries only the newest page, and an older one is still openable from
      // search or a link — losing its half-typed draft on refresh would be the original bug again.
      //
      // So is every conversation the server just sent a draft for. Without that, a draft on a
      // conversation older than the bootstrap page was written three statements above and deleted
      // here in the same tick, on every device, so the box held a sentence no client could ever
      // show — the failure looked exactly like the draft never having been saved at all.
      const open = savedDraft.current.taskId;
      pruneDrafts([
        ...next.tasks.map((item) => item.id),
        ...(next.drafts ?? []).flatMap((draft) => (draft.taskId ? [draft.taskId] : [])),
        ...(open ? [open] : [])
      ]);
      const requested = new URLSearchParams(window.location.search);
      const requestedTaskId = requested.get('task') ?? undefined;
      const requestedWorkspaceId = requested.get('workspace') ?? undefined;
      const requestedTask = next.tasks.find((item) => item.id === requestedTaskId);
      const requestedWorkspace = next.workspaces.find((item) => item.id === requestedWorkspaceId);
      // Where the box last saw this owner, used only when the address says nothing. A link always
      // wins — following one is a deliberate instruction about where to go, and the saved place is
      // only a guess at where they would otherwise want to be. Installed to a home screen there is
      // never a query to read, which is exactly the case this exists for.
      const place = requestedTaskId || requestedWorkspaceId ? undefined : next.user.preferences?.place;
      const resumedTaskId = requestedTaskId ?? place?.taskId ?? undefined;
      const resumedTask = requestedTask ?? next.tasks.find((item) => item.id === resumedTaskId);
      // A linked conversation is kept even when the bootstrap page does not carry it; it is
      // fetched on demand below rather than silently redirecting the user to a blank new task.
      setTaskId((current) => current ?? resumedTaskId);
      setWorkspaceId((current) =>
        current && next.workspaces.some((item) => item.id === current)
          ? current
          : (resumedTask?.workspaceId ??
            requestedWorkspace?.id ??
            next.workspaces.find((item) => item.id === place?.workspaceId)?.id ??
            next.workspaces[0]?.id)
      );
    } catch (cause) {
      /*
       * Only a real refusal signs the owner out.
       *
       * Every failure used to set `auth` to 'required', which unmounts the workbench and renders
       * the marketing sign-in page — and bootstrap is re-fired on focus, online and
       * visibilitychange, so a phone losing signal in a lift replaced the conversation being
       * watched with a passkey button while its session was still perfectly valid.
       */
      const refused =
        cause instanceof ApiFailure &&
        (cause.code === 'authentication_required' || cause.status === 401);
      if (refused) {
        setAuth('required');
        return;
      }
      setOffline(true);
      // A first load has nothing to keep on screen, so the failure has to be stated somewhere.
      if (!currentData.current) setError(describeFailure(cause, 'Could not reach your athanor'));
    }
  }, []);
  /**
   * Everything athanor has decided to tell the owner, across conversations.
   *
   * A box with no route for them and a box that has never sent one both come back with nothing to
   * show, which is the same thing to a reader: the entry point only exists once there is something
   * behind it.
   */
  const loadNotices = useCallback(() => {
    void api
      .agentNotifications()
      .then((list) => setNotices(list ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    /*
     * The service worker refuses to raise a notification over a window that is already open, and
     * tells the window instead. Without this the suppressed push would cost the owner up to three
     * seconds of polling to see the approval it was about — which is the whole reason the phone
     * was allowed to stay dark.
     */
    if (!('serviceWorker' in navigator)) return;
    const receivePush = (event: MessageEvent<unknown>) => {
      const message = event.data as { source?: unknown } | null;
      if (!message || message.source !== 'athanor-push') return;
      void api
        .approvals()
        .then(setApprovals)
        .catch(() => undefined);
      loadNotices();
      void load();
    };
    navigator.serviceWorker.addEventListener('message', receivePush);
    return () => navigator.serviceWorker.removeEventListener('message', receivePush);
  }, [load, loadNotices]);
  useEffect(() => {
    void load();
    loadNotices();
    const refreshWhenActive = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
      loadNotices();
    };
    window.addEventListener('focus', refreshWhenActive);
    window.addEventListener('online', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      window.removeEventListener('focus', refreshWhenActive);
      window.removeEventListener('online', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [load, loadNotices]);

  const workspace = data?.workspaces.find((item) => item.id === workspaceId);
  // Every computer by default: work the owner remembers clearly is not findable when the search is
  // silently scoped to whichever computer happens to be selected.
  const searchConversations = useCallback(
    (query: string, thisComputerOnly = false) =>
      api.search(query, thisComputerOnly ? workspaceId : undefined),
    [workspaceId]
  );

  /**
   * Uploads land in the tray above the composer, never in the draft.
   *
   * Every route in — paperclip, drag-and-drop, paste, camera, share target — comes through here, so
   * this is the one place that decides what an attachment is. Uploads run in parallel and report
   * their own progress, and the composer stays typeable throughout: a 49 MiB file on a home link is
   * minutes long and blocking the box for it was the reason a large attachment felt like a hang.
   */
  const uploadFiles = (files: File[]): void => {
    if (!workspace || files.length === 0) return;
    const { accepted, message } = planUploads(files);
    if (message) setError(message);
    for (const file of accepted) {
      const id = crypto.randomUUID();
      const path = attachmentPath(file.name, id);
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setAttachments((current) => [
        ...current,
        {
          id,
          name: file.name,
          sizeBytes: file.size,
          mimeType: file.type || 'application/octet-stream',
          path: '',
          status: 'uploading',
          progress: 0,
          ...(previewUrl ? { previewUrl } : {})
        }
      ]);
      const settle = (patch: Partial<Attachment>) =>
        setAttachments((current) =>
          current.map((item) => (item.id === id ? { ...item, ...patch } : item))
        );
      void file
        .arrayBuffer()
        .then((buffer) => {
          const upload = api.uploadFile(workspace.id, path, new Uint8Array(buffer), (fraction) =>
            settle({ progress: fraction })
          );
          uploads.current.set(id, upload.cancel);
          return upload.done;
        })
        .then(() => settle({ status: 'ready', path, progress: 1 }))
        .catch((cause: unknown) => {
          // A cancelled upload has already been taken off the tray by the control that cancelled it.
          if (cause instanceof Error && cause.name === 'AbortError') return;
          settle({
            status: 'failed',
            error: describeFailure(cause, 'The upload did not finish')
          });
        })
        .finally(() => uploads.current.delete(id));
    }
  };

  const removeAttachment = (attachment: Attachment): void => {
    uploads.current.get(attachment.id)?.();
    uploads.current.delete(attachment.id);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    // An upload that landed left a real file behind; taking the chip away has to take that too, or
    // the agent computer accumulates a copy of everything the owner changed their mind about.
    if (attachment.status === 'ready' && workspace)
      void api.deleteFile(workspace.id, attachment.path).catch(() => undefined);
  };

  useEffect(() => {
    const shareId = pendingShareId.current;
    if (!workspace || !shareId || consumingShare.current) return;
    consumingShare.current = true;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('share');
    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    void consumeSharedPayload(shareId)
      .then((shared) => {
        if (!shared) throw new Error('The shared item expired before it could be imported');
        if (shared.text) setPrompt((current) => `${current}${current ? '\n\n' : ''}${shared.text}`);
        uploadFiles(shared.files);
      })
      .catch((cause: unknown) =>
        setError(describeFailure(cause, 'Could not import the shared item'))
      )
      .finally(() => {
        pendingShareId.current = null;
      });
  }, [workspace?.id]);
  useEffect(() => {
    currentData.current = data;
    if (
      data &&
      pendingNativeTarget.current &&
      applyNativeTarget(pendingNativeTarget.current, data)
    ) {
      pendingNativeTarget.current = undefined;
    }
  }, [data]);
  useEffect(() => {
    if (!nativeBridge.available()) return;
    let unlisten: (() => void) | undefined;
    void nativeBridge
      .capabilities()
      .then((capabilities) => setNativeFolderPicker(capabilities.folderPicker))
      .catch(() => setNativeFolderPicker(false));
    void nativeBridge
      .onDeepLinks((raw) => {
        const target = nativeTarget(raw);
        if (!target) return;
        if (!applyNativeTarget(target)) pendingNativeTarget.current = target;
      })
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const openInspector = useCallback((tab: InspectorTab) => {
    setInspectorOpen(true);
    setInspectorTab(tab);
  }, []);

  const task = data?.tasks.find((item) => item.id === taskId);
  const privacyRoute =
    data?.models.find((model) => model.id === modelId)?.privacyRoute ??
    data?.models.find((model) => model.availability === 'available')?.privacyRoute ??
    'provider_zdr';
  /*
   * The route the search would take from here. An open conversation was started on a privacy route
   * and keeps it for life, so it answers for itself; an empty composer answers for the route the
   * model about to be used belongs to.
   */
  const webRoute = webSearchRouteFor(data?.instance.webSearch, task?.privacyRoute ?? privacyRoute);
  const taskIsActive = isLiveTask(task);
  /*
   * A stopped conversation continues in place.
   *
   * Excluding `cancelled` here sent the next message down the create-a-new-task path, so Stop's own
   * notice — "the work so far is kept, send a message to continue from here" — was false: the
   * transcript being read was replaced by an empty conversation. The server accepts a message on a
   * cancelled task precisely so that sentence is true.
   */
  const canContinueTask = Boolean(task);
  const models = useMemo(
    () =>
      (
        data?.models.filter(
          (model) => model.privacyRoute === privacyRoute && model.availability === 'available'
        ) ?? []
      ).sort((left, right) => {
        const ranked = (model: ModelRelease) => {
          const index = recommendedModelIds.indexOf(model.id);
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        };
        return ranked(left) - ranked(right) || left.displayName.localeCompare(right.displayName);
      }),
    [data?.models, privacyRoute, recommendedModelIds]
  );
  const unavailableModels = useMemo(
    () =>
      (data?.models ?? [])
        .filter(
          (model) => model.privacyRoute === privacyRoute && model.availability !== 'available'
        )
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [data?.models, privacyRoute]
  );
  const namedModel = useCallback(
    (id: string): string => modelDisplayName(data?.models ?? [], id),
    [data?.models]
  );
  const blocked = sendBlock({
    workspaceAvailable: Boolean(workspace),
    providerConfigured: Boolean(data?.instance.providerConfigured),
    enforceZeroDataRetention: Boolean(data?.instance.enforceZeroDataRetention),
    availableModelCount: models.length,
    modelId
  });
  const canSend = hasSomethingToSend(prompt, attachments);
  // A conversation carries its own mode; with none open the computer's default is what is shown.
  const currentSecurityMode: SecurityMode =
    task?.securityMode ?? workspace?.securityMode ?? 'balanced';
  // The block is the only thing that matters while it is on screen, so nothing else competes for
  // the strip above the composer.
  const showBlock = Boolean(blocked) && canSend;
  const visiblePending =
    pendingSend && (pendingSend.taskId === undefined || pendingSend.taskId === taskId)
      ? pendingSend
      : undefined;
  const timelineEvents = useMemo(
    () => withPendingMessage(events, visiblePending),
    [events, visiblePending]
  );
  /*
   * A challenge takes the browser away from the agent for the whole computer, not just for the
   * turn that walked into it, and only the owner handing control back clears it. The screen has to
   * be able to offer that even after the conversation has moved on.
   */
  const browserWall = useMemo(() => activeBotWall(events), [events]);
  useEffect(() => {
    // `withPendingMessage` returns the untouched list once the server echoes the message, which is
    // exactly when the local copy has nothing left to do. Leaving the conversation drops it too.
    if (!pendingSend) return;
    if (!visiblePending || timelineEvents === events) setPendingSend(undefined);
  }, [timelineEvents, events, pendingSend, visiblePending]);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (task) setAnnouncement(taskStateAnnouncement(task.title, task.status));
  }, [task?.id, task?.status, task?.title]);
  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    void api
      .recommendModels(privacyRoute, modelPreference)
      .then((ranked) => {
        if (!active) return;
        setRecommendedModelIds(ranked.map((entry) => entry.model.id));
        if (modelAutomatic) setModelId(ranked[0]?.model.id ?? '');
      })
      .catch(() => {
        if (active) setRecommendedModelIds([]);
      });
    return () => {
      active = false;
    };
  }, [auth, privacyRoute, modelPreference, modelAutomatic, data?.models]);
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    const keepAlive = async () => {
      try {
        if (workspace.status === 'hibernated') {
          const resumed = await api.workspaceAction(workspace.id, 'resume');
          if (active)
            setData((current) =>
              current
                ? {
                    ...current,
                    workspaces: current.workspaces.map((item) =>
                      item.id === resumed.id ? resumed : item
                    )
                  }
                : current
            );
        } else {
          const measured = await api.workspaceHeartbeat(workspace.id);
          if (active)
            setData((current) =>
              current
                ? {
                    ...current,
                    workspaces: current.workspaces.map((item) =>
                      item.id === workspace.id
                        ? {
                            ...item,
                            storageBytes: measured.storageBytes,
                            ...(measured.hostStorageTotalBytes
                              ? { hostStorageTotalBytes: measured.hostStorageTotalBytes }
                              : {}),
                            ...(measured.hostStorageAvailableBytes !== undefined
                              ? {
                                  hostStorageAvailableBytes: measured.hostStorageAvailableBytes
                                }
                              : {})
                          }
                        : item
                    )
                  }
                : current
            );
        }
      } catch {
        // The next heartbeat retries; the current workspace status stays visible.
      }
    };
    void keepAlive();
    const timer = window.setInterval(() => void keepAlive(), 5 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspace?.id, workspace?.status]);
  useEffect(() => {
    if (!models.some((model) => model.id === modelId)) setModelId(models[0]?.id ?? '');
  }, [models, modelId]);
  /*
   * The app is a text box, and the last step of opening it was a click nobody should have to make.
   * Once only, on the first successful bootstrap, and never over a dialog or a restored deep link
   * whose transcript is what the owner came back to read.
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (auth !== 'ready' || focusedOnce.current) return;
    focusedOnce.current = true;
    if (taskId || settingsPage || scheduleModal) return;
    const frame = window.requestAnimationFrame(() => composer.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [auth, taskId, settingsPage, scheduleModal]);
  /*
   * The approval queue is deliberately global — it is never filtered to the open conversation — so
   * what feeds it must be too. It used to be polled inside the transcript effect, which returns
   * early with no conversation open and cleared its own timer once the open one finished. An
   * approval raised by a scheduled run therefore never appeared on the new-conversation screen,
   * which is exactly the screen someone sits on while thinking.
   */
  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void api
        .approvals()
        .then((pending) => {
          if (active) setApprovals(pending);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, taskIsActive ? 3_000 : 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [auth, taskIsActive]);
  useEffect(() => {
    setEvents([]);
    lastSequence.current = 0;
  }, [taskId]);
  /*
   * The transcript, and what keeps it alive.
   *
   * Three failures used to end it silently. The effect was keyed on `taskId` alone, so continuing a
   * finished conversation left the closed stream closed and the cleared poll timer cleared, and the
   * transcript never grew again under running chrome. The `EventSource` had no `onerror`, so any
   * non-retryable failure — including the 429 the server returns once five streams are open, which
   * a laptop, a phone and two tabs reach — froze the transcript with no error at all. And a reopen
   * replayed from sequence zero. Liveness is now part of the key, the cursor is carried, and a
   * stream that will not come back is replaced by polling the same events over REST.
   */
  useEffect(() => {
    if (!taskId || !data) return;
    let active = true;
    let stream: EventSource | undefined;
    let backupTimer: number | undefined;
    let reopenTimer: number | undefined;
    let failures = 0;

    const absorb = (incoming: TaskEvent) => {
      lastSequence.current = Math.max(lastSequence.current, incoming.sequence);
      setEvents((current) => mergeTaskEvent(current, incoming));
    };

    /** The non-streaming route, used to catch up after a stream that could not be re-established. */
    const catchUp = () => {
      void api
        .events(taskId, lastSequence.current)
        .then((batch) => {
          if (!active) return;
          for (const incoming of batch) absorb(incoming);
          // The marker stays up while this is what is feeding the transcript; only a stream that
          // actually reopens takes it down.
        })
        .catch(() => undefined);
    };

    const open = () => {
      if (!active) return;
      const cursor = lastSequence.current;
      stream = new EventSource(
        `/v1/tasks/${encodeURIComponent(taskId)}/events/stream${cursor ? `?after=${cursor}` : ''}`
      );
      stream.onopen = () => {
        failures = 0;
        setStreamDegraded(false);
        if (backupTimer !== undefined) {
          window.clearInterval(backupTimer);
          backupTimer = undefined;
        }
      };
      stream.onmessage = (message: MessageEvent<string>) => {
        if (!active) return;
        try {
          absorb(JSON.parse(message.data) as TaskEvent);
        } catch {
          // A malformed frame is ignored; cursor replay supplies valid persisted events.
        }
      };
      stream.addEventListener('terminal', () => stream?.close());
      stream.onerror = () => {
        if (!active) return;
        // The browser retries a dropped connection on its own; what it cannot recover from is a
        // non-200, which is what the stream cap answers with.
        if (stream?.readyState !== EventSource.CLOSED) return;
        failures += 1;
        stream = undefined;
        if (failures >= 2 && backupTimer === undefined) {
          setStreamDegraded(true);
          catchUp();
          backupTimer = window.setInterval(catchUp, 2_000);
        }
        reopenTimer = window.setTimeout(open, Math.min(30_000, 1_000 * 2 ** failures));
      };
    };
    open();

    const poll = async () => {
      try {
        const updated = await api.task(taskId);
        if (!active) return;
        // Upsert, not map: a conversation older than the newest 200 is reachable from search and
        // from a link, and a map would drop it on the floor and render an empty canvas forever.
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, updated) } : current
        );
      } catch {
        /* a later cursor poll retries */
      }
    };
    void poll();
    // A finished conversation has nothing left to poll for, but the timer stays alive: a follow-up
    // puts the same conversation back to work without changing its id.
    const timer = window.setInterval(() => {
      if (
        terminalTaskStatuses.has(
          currentData.current?.tasks.find((item) => item.id === taskId)?.status ?? ''
        )
      )
        return;
      void poll();
    }, 3_000);
    return () => {
      active = false;
      stream?.close();
      window.clearInterval(timer);
      if (backupTimer !== undefined) window.clearInterval(backupTimer);
      if (reopenTimer !== undefined) window.clearTimeout(reopenTimer);
    };
  }, [taskId, Boolean(data), taskIsActive]);

  // A conversation the bootstrap page did not carry is fetched on demand, and one that genuinely
  // no longer exists says so instead of showing the empty canvas with a live stream behind it.
  useEffect(() => {
    setMissingTask(false);
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
        if (active) setMissingTask(true);
      });
    return () => {
      active = false;
    };
  }, [taskId, Boolean(data), Boolean(task)]);

  // Keep the address bar in step with the open conversation so back/forward and reload behave
  // the way every other web app does. `replaceState` on the first render avoids pushing a
  // duplicate entry for the conversation the bootstrap just restored.
  const routedTaskId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (auth !== 'ready') return;
    if (routedTaskId.current === taskId) return;
    const first = routedTaskId.current === undefined;
    routedTaskId.current = taskId;
    const url = new URL(window.location.href);
    if (taskId) url.searchParams.set('task', taskId);
    else url.searchParams.delete('task');
    if (workspaceId) url.searchParams.set('workspace', workspaceId);
    const next = `${url.pathname}${url.search}`;
    if (first) window.history.replaceState({ taskId }, '', next);
    else window.history.pushState({ taskId }, '', next);
  }, [auth, taskId, workspaceId]);
  useEffect(() => {
    const onPop = () => {
      const requested = new URLSearchParams(window.location.search).get('task') ?? undefined;
      routedTaskId.current = requested;
      setTaskId(requested);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /*
   * Retries on its own, with backoff, so a blip heals without the owner doing anything.
   *
   * `focus`, `online` and `visibilitychange` already re-fetch, but none of those fire while the tab
   * simply sits there with no network, which is the case this is for.
   */
  useEffect(() => {
    if (!offline || auth === 'required') return;
    let attempt = 0;
    let timer = 0;
    const retry = () => {
      attempt += 1;
      void load();
      timer = window.setTimeout(retry, Math.min(30_000, 2_000 * 2 ** attempt));
    };
    timer = window.setTimeout(retry, 2_000);
    return () => window.clearTimeout(timer);
  }, [offline, auth, load]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const action = windowShortcut(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          inField:
            event.target instanceof HTMLElement &&
            ['INPUT', 'TEXTAREA'].includes(event.target.tagName)
        },
        { agentWorking: live.current.active }
      );
      if (!action) return;
      event.preventDefault();
      if (action === 'palette') setPalette((current) => !current);
      else if (action === 'new-conversation') startNewConversation();
      else if (action === 'toggle-tools') setInspectorOpen((current) => !current);
      else if (action === 'focus-composer') composer.current?.focus();
      // The editor's own reflex for "that came out wrong": reopen the last thing you sent.
      else if (action === 'edit-last') live.current.editLast();
      else if (action === 'stop-agent') live.current.stop();
      else setShortcutSheet(true);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const send = async (options: { interrupt?: boolean } = {}) => {
    const submission = composerSubmission({ prompt, attachments, block: blocked, busy });
    if (submission.kind === 'nothing') return;
    if (submission.kind === 'wait') {
      setError(submission.message);
      return;
    }
    if (submission.kind === 'blocked') {
      setError('');
      composer.current?.focus();
      return;
    }
    if (!workspace) return;
    // The paths ride behind the message rather than inside the sentence, so what the transcript
    // shows, what search indexes and what the sidebar quotes is what the owner actually wrote.
    const { text, attachments: ready } = submission;
    const typed = prompt.trim();
    const optimistic: PendingUserMessage = {
      id: `pending-${crypto.randomUUID()}`,
      taskId: task?.id,
      markdown: text,
      createdAt: new Date().toISOString()
    };
    // The transcript shows the message on this tick; the round trip only decides when work starts.
    setPendingSend(optimistic);
    setPrompt('');
    clearDraft(task?.id);
    // And on the box, explicitly. Emptying the composer schedules the debounce above to save a
    // blank draft, which the server turns into a delete - but on a new conversation `setTaskId` runs
    // before those 900ms elapse, the effect's cleanup cancels the pending save, and the re-run
    // returns early on the changed id. The row for the sentence just sent therefore survived, and
    // every other device picked it up at its next bootstrap and put an already-sent message back in
    // the composer, one Enter away from sending it twice.
    if (serverPreferencesLoaded.current && workspaceId)
      void api.saveDraft({ workspaceId, taskId: task?.id ?? null, body: '' }).catch(() => undefined);
    setAttachments([]);
    setBusy(true);
    setError('');
    try {
      if (canContinueTask && task) {
        const continued = await api.continueTask(task.id, {
          prompt: text,
          modelId,
          privacyRoute,
          maxComputeCredits: 5,
          ...(options.interrupt ? { interrupt: true } : {})
        });
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, continued) } : current
        );
        if (taskIsActive)
          setNotice(
            options.interrupt
              ? 'Correction sent. The agent picks it up at its next step and keeps what it has done.'
              : `Follow-up queued in this conversation${continued.queuedMessageCount > 1 ? ` · ${continued.queuedMessageCount} waiting` : ''}.`
          );
      } else {
        const created = await api.createTask({
          workspaceId: workspace.id,
          prompt: text,
          modelId,
          privacyRoute,
          maxComputeCredits: 5
        });
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, created) } : current
        );
        setPendingSend((current) =>
          current?.id === optimistic.id ? { ...current, taskId: created.id } : current
        );
        setTaskId(created.id);
        setEvents([]);
      }
      for (const item of ready) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    } catch (cause) {
      setPendingSend(undefined);
      // The typed sentence comes back, not the sentence plus its trailer: the attachments are
      // still on the agent computer and go back on the tray so the retry is one keystroke.
      setPrompt((current) => (current ? current : typed));
      setAttachments((current) => (current.length ? current : ready));
      setError(describeFailure(cause, 'Could not start this conversation'));
    } finally {
      setBusy(false);
    }
  };

  const renameConversation = async (id: string, title: string) => {
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
      setError(describeFailure(cause, 'Could not rename this conversation'));
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
  const loadEarlierConversations = async () => {
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
              tasksCursor: page.hasMore ? page.nextCursor : null
            }
          : current
      );
    } catch (cause) {
      setError(describeFailure(cause, 'Could not load earlier conversations'));
    } finally {
      setLoadingEarlier(false);
    }
  };

  /**
   * Pinning and filing away, which the box has always been able to do and this client could not
   * ask for.
   *
   * Optimistic like the rename above it, and for the same reason: this is a list the owner has just
   * acted on, and a row that waits for a round trip before it moves reads as a control that did
   * nothing. A failure puts the row back where it was and says so, rather than leaving the screen
   * disagreeing with the box.
   */
  const fileConversation = async (
    target: Task,
    patch: { pinned?: boolean; archived?: boolean }
  ) => {
    setError('');
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
        setNotice('Filed away. It stays open here, and search still finds it.');
    } catch (cause) {
      setData((current) =>
        current ? { ...current, tasks: upsertTask(current.tasks, target) } : current
      );
      setError(describeFailure(cause, 'Could not change this conversation'));
    }
  };

  /*
    No confirmation dialog: the row goes now and the request that cannot be taken back waits
    behind Undo. A prompt people click through protects nobody, and this costs one click to
    reverse instead of asking permission for every one that was intended.
  */
  const deleteConversation = (target: Task) => {
    setError('');
    setData((current) =>
      current ? { ...current, tasks: removeTask(current.tasks, target.id) } : current
    );
    if (taskId === target.id) setTaskId(undefined);
    undo.queue.push({
      message: `Deleted “${target.title}”`,
      commit: () => api.deleteTask(target.id),
      restore: () =>
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, target) } : current
        )
    });
  };

  const stopTask = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      const stopped = await api.taskAction(task.id, 'cancel');
      setData((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((item) => (item.id === stopped.id ? stopped : item))
            }
          : current
      );
      setNotice('Stopped. The work so far is kept — send a message to continue from here.');
    } catch (cause) {
      setError(describeFailure(cause, 'Could not stop the agent'));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    live.current = {
      stop: () => void stopTask(),
      editLast: () => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const candidate = events[index]!;
          if (candidate.kind !== 'user_message') continue;
          const body =
            candidate.payload && typeof candidate.payload === 'object'
              ? (candidate.payload as Record<string, unknown>)
              : {};
          setTrajectory({
            rewind: 'conversation',
            operation: 'edit',
            eventId: candidate.id,
            prompt: typeof body.markdown === 'string' ? body.markdown : '',
            stopSource: taskIsActive
          });
          return;
        }
      },
      active: taskIsActive && !busy
    };
  });

  const branchFrom = async (eventId: string) => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      // A branch takes only the conversation. Taking the computer back as well would rewrite the
      // machine underneath the original conversation, which is still live and still true.
      const branch = await api.createTaskTrajectory(task.id, {
        operation: 'branch',
        eventId,
        rewind: 'conversation'
      });
      setData((current) => (current ? { ...current, tasks: [branch, ...current.tasks] } : current));
      setWorkspaceId(branch.workspaceId);
      setTaskId(branch.id);
      setNotice(
        'Branch created. The original conversation stays untouched; send a message to take this one somewhere new.'
      );
    } catch (cause) {
      setError(describeFailure(cause, 'Could not branch this conversation'));
    } finally {
      setBusy(false);
    }
  };

  const runTrajectory = async () => {
    if (!task || !trajectory) return;
    const sourceTask = task;
    const scope = trajectory.rewind;
    const checkpointId = rewindOffer(rewindPreview).checkpointId;
    setBusy(true);
    setError('');
    try {
      // The previewed checkpoint is named rather than re-resolved, so what comes back is what the
      // dialog described.
      const machine =
        scope !== 'conversation' && checkpointId
          ? { rewind: scope, checkpointId }
          : { rewind: scope };
      const fork = await api.createTaskTrajectory(
        sourceTask.id,
        trajectory.operation === 'edit'
          ? {
              operation: 'edit',
              eventId: trajectory.eventId,
              prompt: trajectory.prompt.trim(),
              maxComputeCredits: 5,
              stopSource: trajectory.stopSource,
              ...machine
            }
          : {
              operation: 'retry',
              eventId: trajectory.eventId,
              maxComputeCredits: 5,
              stopSource: trajectory.stopSource,
              ...machine
            }
      );
      setTrajectory(undefined);
      setNotice(rewindResultNotice(trajectory.operation, scope));
      /*
       * Taking only the computer back forks nothing: the server returns this same conversation with
       * a line in it saying what happened to the files. Treating that as a new version used to
       * replace the transcript being read with a copy of itself.
       */
      if (scope === 'computer') {
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, fork) } : current
        );
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              tasks: [
                fork,
                ...current.tasks.map((item) =>
                  item.id === sourceTask.id && trajectory.stopSource && !isTerminalTask(item)
                    ? { ...item, status: 'cancelled' as const }
                    : item
                )
              ]
            }
          : current
      );
      setWorkspaceId(fork.workspaceId);
      setTaskId(fork.id);
      setEvents([]);
    } catch (cause) {
      setError(describeFailure(cause, 'Could not start the new version'));
    } finally {
      setBusy(false);
    }
  };

  const changeSecurityMode = async (securityMode: SecurityMode) => {
    if (!workspace) return;
    const currentMode = task?.securityMode ?? workspace.securityMode;
    if (securityMode === currentMode) return;
    setBusy(true);
    setError('');
    try {
      if (loosensSecurity(currentMode, securityMode)) await api.stepUp();
      if (task) {
        const updated = await api.updateTaskSecurityMode(task.id, securityMode);
        setData((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((item) => (item.id === updated.id ? updated : item))
              }
            : current
        );
      } else {
        const updated = await api.updateWorkspaceSecurityMode(workspace.id, securityMode);
        setData((current) =>
          current
            ? {
                ...current,
                workspaces: current.workspaces.map((item) =>
                  item.id === updated.id ? updated : item
                )
              }
            : current
        );
      }
      // The raw enum contradicted the control that set it: the option reads "Ask first" and the
      // confirmation read "Security mode changed to review." Same words, both places.
      setNotice(securityModeNotice(securityMode, task ? 'task' : 'workspace'));
    } catch (cause) {
      setError(describeFailure(cause, 'Could not change security mode'));
    } finally {
      setBusy(false);
    }
  };

  const attachNativeFolder = async () => {
    if (!workspace) return;
    const grant = await nativeBridge.chooseFolder();
    if (!grant) return;
    setBusy(true);
    setError('');
    try {
      const uploaded: string[] = [];
      const skip = new Set(['.git', 'node_modules', '.env', '.DS_Store', 'dist', 'build']);
      const visit = async (relative = ''): Promise<void> => {
        const entries = (await nativeBridge.listFolder(grant.token, relative)) ?? [];
        for (const entry of entries) {
          if (uploaded.length >= 500 || skip.has(entry.name)) continue;
          if (entry.isDirectory) await visit(entry.relativePath);
          else if (entry.sizeBytes <= 100 * 1024 * 1024) {
            const bytes = await nativeBridge.readFile(grant.token, entry.relativePath);
            if (!bytes) continue;
            const destination = `workspace/imports/${grant.name}/${entry.relativePath}`;
            await api.writeFile(workspace.id, destination, Uint8Array.from(bytes));
            uploaded.push(destination);
          }
        }
      };
      await visit();
      // The imported files join the tray like any other attachment, rather than being listed by
      // path inside the message the owner is writing.
      setAttachments((current) => [
        ...current,
        ...uploaded.map((path) => ({
          id: crypto.randomUUID(),
          name: path.slice(`workspace/imports/${grant.name}/`.length) || path,
          sizeBytes: 0,
          mimeType: 'application/octet-stream',
          path,
          status: 'ready' as const,
          progress: 1
        }))
      ]);
    } catch (cause) {
      setError(describeFailure(cause, 'Could not import local folder'));
    } finally {
      await nativeBridge.revokeFolder(grant.token);
      setBusy(false);
    }
  };

  const toggleVoiceRecording = async () => {
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      return;
    }
    if (!workspace || !navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) {
      setError('Voice capture is not available on this device');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      const next = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recordedChunks.current = [];
      next.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.current.push(event.data);
      };
      next.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        recorder.current = undefined;
        const type = next.mimeType || 'audio/webm';
        const extension = voiceNoteExtension(type);
        const voice = new Blob(recordedChunks.current, { type });
        recordedChunks.current = [];
        setBusy(true);
        setError('');
        void api
          .transcribeAudio(new Uint8Array(await voice.arrayBuffer()), extension)
          .then(({ text }) => {
            setPrompt((current) => `${current}${current ? '\n\n' : ''}${text}`);
          })
          .catch((cause) => {
            setError(describeFailure(cause, 'Could not transcribe this voice note'));
          })
          .finally(() => setBusy(false));
      };
      next.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        recorder.current = undefined;
        setError('Voice recording stopped unexpectedly');
      };
      recorder.current = next;
      next.start(1_000);
      setRecording(true);
    } catch (cause) {
      setError(describeFailure(cause, 'Microphone permission was not granted'));
    }
  };

  /**
   * The whole conversation as text, which is the last mile of most sessions: the agent produced the
   * answer and getting it out used to mean clicking copy on every bubble in turn.
   */
  const exportConversation = (mode: 'copy' | 'download') => {
    if (!task) return;
    const markdown = conversationMarkdown(task.title, events);
    if (mode === 'copy') {
      void navigator.clipboard
        .writeText(markdown)
        .then(() => setNotice('Conversation copied as Markdown.'))
        .catch(() => setError('This browser would not let athanor write to the clipboard.'));
      return;
    }
    const name = `${task.title.replace(/[^a-zA-Z0-9 _-]+/g, ' ').trim() || 'conversation'}.md`;
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /*
   * The palette knows what is open.
   *
   * Its list was fixed at pane switching, Settings and Schedules, so with a conversation on screen
   * it could not stop, rename, delete, branch or copy the very thing being looked at — all of which
   * are functions two scopes up from it. Every entry carries its key, since the palette is also the
   * only place the shortcuts are discoverable.
   */
  const paletteCommands = ((): Command[] => {
    const surfaces: Array<[InspectorTab, string]> = [
      ['files', 'Files'],
      ['computer', 'Computer'],
      ['terminal', 'Terminal'],
      ['preview', 'Preview']
    ];
    const commands: Command[] = [
      {
        id: 'new-chat',
        label: 'New conversation',
        hint: '⌘⇧O',
        group: 'Actions',
        run: startNewConversation
      }
    ];
    if (task) {
      if (taskIsActive)
        commands.push({
          id: 'stop',
          label: 'Stop the agent',
          hint: 'Esc',
          group: 'This conversation',
          run: () => void stopTask()
        });
      if (taskIsActive)
        commands.push({
          id: 'pause',
          label:
            pauseAction(task) === 'resume' ? 'Resume this conversation' : 'Pause this conversation',
          group: 'This conversation',
          run: () =>
            void api
              .taskAction(task.id, pauseAction(task))
              .then((updated) =>
                setData((current) =>
                  current ? { ...current, tasks: upsertTask(current.tasks, updated) } : current
                )
              )
              .catch((cause: unknown) =>
                setError(describeFailure(cause, 'Could not change this conversation'))
              )
        });
      commands.push(
        {
          id: 'pin-conversation',
          label: task.pinned ? 'Unpin this conversation' : 'Pin this conversation',
          group: 'This conversation',
          run: () => void fileConversation(task, { pinned: !task.pinned })
        },
        {
          id: 'archive-conversation',
          label: task.archivedAt
            ? 'Put this conversation back in the list'
            : 'File this conversation away',
          group: 'This conversation',
          run: () => void fileConversation(task, { archived: !task.archivedAt })
        },
        {
          id: 'copy-conversation',
          label: 'Copy conversation as Markdown',
          group: 'This conversation',
          run: () => exportConversation('copy')
        },
        {
          id: 'download-conversation',
          label: 'Download conversation',
          group: 'This conversation',
          run: () => exportConversation('download')
        },
        {
          id: 'delete-conversation',
          label: 'Delete this conversation',
          group: 'This conversation',
          run: () => deleteConversation(task)
        }
      );
    }
    commands.push(
      ...surfaces.map(([tab, label]) => ({
        id: `open-${tab}`,
        label: `Open ${label}`,
        ...(tab === 'files' ? { hint: '⌘B' } : {}),
        group: 'Computer',
        run: () => openInspector(tab)
      })),
      { id: 'settings', label: 'Open Settings', group: 'Actions', run: openSettings },
      {
        id: 'schedules',
        label: 'Open Schedules',
        group: 'Actions',
        run: () => setScheduleModal(true)
      },
      // Listed only when there is something behind it, like the sidebar row it opens.
      ...(notices.length
        ? [
            {
              id: 'notices',
              label: 'What athanor told you',
              group: 'Actions',
              run: () => {
                loadNotices();
                setNoticeLog(true);
              }
            }
          ]
        : []),
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        hint: '?',
        group: 'Actions',
        run: () => setShortcutSheet(true)
      }
    );
    return commands;
  })();

  if (auth === 'loading')
    return (
      <div className="splash">
        <span className="brand-mark large">
          <BrandMark />
        </span>
        {/* A first load that cannot reach the box used to sit on "Opening…" for five minutes with
            no message and no way out, because the runner's own timeout was the only ceiling. */}
        {offline ? (
          <>
            <p>{error || 'Your athanor is not answering yet.'}</p>
            <button onClick={() => void load()}>Try again</button>
          </>
        ) : (
          <p>Opening your private computer…</p>
        )}
      </div>
    );
  if (auth === 'required' || !data) return <Auth onReady={() => void load()} />;
  const storagePercent = hostStoragePercent(workspace ?? {}) ?? 0;

  return (
    <UndoProvider value={undo.queue}>
      <div className={`app-shell ${inspectorOpen ? '' : 'inspector-closed'}`}>
        {/* The same sidebar is mounted twice - this one for the narrow layout, the one below for
            the wide - and CSS decides which is seen. `inert` is what stops the unseen copy from
            also being there for a screen reader and for the tab order: without it the page offers
            two conversation lists and two search fields, one of them invisible. */}
        <div className={`mobile-sidebar ${mobileNav ? 'open' : ''}`} inert={!mobileNav}>
          <Sidebar
            user={data.user}
            workspaces={data.workspaces}
            tasks={data.tasks}
            schedules={data.schedules}
            selectedWorkspaceId={workspaceId}
            selectedTaskId={taskId}
            onTask={(id) => {
              setTaskId(id);
              setMobileNav(false);
            }}
            onNewTask={startNewConversation}
            onComputerSettings={() => openSettings('server')}
            onSettings={() => openSettings()}
            onSchedules={() => setScheduleModal(true)}
            noticeCount={notices.length}
            onNotices={() => {
              // Opening it is the moment it has to be current; a notice can arrive while this
              // window has been open all along.
              loadNotices();
              setNoticeLog(true);
              setMobileNav(false);
            }}
            onSearch={searchConversations}
            onRename={(id, title) => void renameConversation(id, title)}
            onDelete={deleteConversation}
            onEarlier={data.tasksCursor ? () => void loadEarlierConversations() : undefined}
            loadingEarlier={loadingEarlier}
          />
        </div>
        {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} />}
        <Sidebar
          user={data.user}
          workspaces={data.workspaces}
          tasks={data.tasks}
          schedules={data.schedules}
          selectedWorkspaceId={workspaceId}
          selectedTaskId={taskId}
          onTask={setTaskId}
          onNewTask={startNewConversation}
          onComputerSettings={() => openSettings('server')}
          onSettings={() => openSettings()}
          onSchedules={() => setScheduleModal(true)}
          noticeCount={notices.length}
          onNotices={() => {
            loadNotices();
            setNoticeLog(true);
          }}
          onSearch={searchConversations}
          onRename={(id, title) => void renameConversation(id, title)}
          onDelete={deleteConversation}
          onEarlier={data.tasksCursor ? () => void loadEarlierConversations() : undefined}
          loadingEarlier={loadingEarlier}
        />
        <main className="workbench">
          <header className="workbench-header">
            <button
              className="icon-btn mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu />
            </button>
            <div className="task-title">
              <strong>{task?.title ?? 'New conversation'}</strong>
              {/*
              The sidebar already names the computer and shows whether it is ready, so repeating
              it here on every task spends a line saying nothing. What is left is the one thing
              this line can say that nothing else on the screen does: the computer is not there.
              A fork used to be labelled here as well, above a bar that says the same thing with
              the version number in it and a way to move between them.
            */}
              {!workspace && (
                <span>
                  <i />
                  Computer unavailable
                </span>
              )}
            </div>
            <div className="header-actions">
              {task && task.queuedMessageCount > 0 && (
                <span className="header-pill queue-pill">{task.queuedMessageCount} queued</span>
              )}
              {taskIsActive && task && (
                <button
                  className="header-pill"
                  onClick={() =>
                    void api
                      .taskAction(task.id, pauseAction(task))
                      .then((updated) =>
                        setData({
                          ...data,
                          tasks: data.tasks.map((item) => (item.id === updated.id ? updated : item))
                        })
                      )
                      .catch((cause: unknown) =>
                        setError(describeFailure(cause, 'Could not change this conversation'))
                      )
                  }
                >
                  {pauseAction(task) === 'resume' ? <Play /> : <Pause />}
                  {pauseAction(task) === 'resume' ? 'Resume' : 'Pause'}
                </button>
              )}
              <button
                className={`workspace-tools-button ${inspectorOpen ? 'active' : ''}`}
                title={inspectorOpen ? 'Hide computer tools' : 'Open computer tools'}
                aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen(!inspectorOpen)}
              >
                <PanelRight />
                <span>{inspectorOpen ? 'Hide tools' : 'Computer tools'}</span>
              </button>
            </div>
          </header>
          <section className="chat-canvas">
            <Timeline
              task={task}
              tasks={data.tasks}
              events={timelineEvents}
              missing={missingTask}
              modelName={namedModel}
              onOpenTask={setTaskId}
              onOpenSpendCaps={() => openSettings('ai')}
              onStarter={(starter) => {
                setPrompt(starter);
                window.requestAnimationFrame(() => composer.current?.focus());
              }}
              onBranch={(event) => void branchFrom(event.id)}
              onEdit={(event) => {
                const body =
                  event.payload && typeof event.payload === 'object'
                    ? (event.payload as Record<string, unknown>)
                    : {};
                setTrajectory({
                  rewind: 'conversation',
                  operation: 'edit',
                  eventId: event.id,
                  prompt: typeof body.markdown === 'string' ? body.markdown : '',
                  stopSource: taskIsActive
                });
              }}
              onRetry={(event) =>
                setTrajectory({
                  rewind: 'conversation',
                  operation: 'retry',
                  eventId: event.id,
                  stopSource: taskIsActive
                })
              }
              onOpenSurface={(tab) => {
                setInspectorTab(tab);
                setInspectorOpen(true);
              }}
            />
          </section>
          {/*
          A banner above the composer is the most expensive place in the interface, so storage only
          earns it once the situation is actually actionable. Seventy percent full on a large disk
          is normal and warning about it teaches people to ignore banners; ninety-five percent is
          about to block their work. The wording carries the one number that decides what to do.
        */}
          {storagePercent >= 90 && !error && !notice && !showBlock && (
            <div className={`usage-warning ${storagePercent >= 95 ? 'critical' : 'elevated'}`}>
              <HardDrive />
              <span>
                {workspace?.hostStorageAvailableBytes !== undefined
                  ? `${formatBytes(workspace.hostStorageAvailableBytes)} of disk left`
                  : `${storagePercent.toFixed(0)}% of the disk is used`}
                {storagePercent >= 95 ? ' — new work will start failing.' : '.'}
              </span>
              <button
                onClick={() => {
                  setInspectorTab('files');
                  setInspectorOpen(true);
                }}
              >
                Files
              </button>
            </div>
          )}
          {blocked && showBlock && (
            <div className="composer-block" role="status">
              <Sparkles />
              <span>{blocked.message}</span>
              <button
                onClick={() =>
                  blocked.code === 'private_route_unavailable' ||
                  blocked.code === 'provider_missing'
                    ? openSettings('ai')
                    : openSettings('server')
                }
              >
                {blocked.actionLabel}
              </button>
            </div>
          )}
          {/*
          The last-known state stays on screen behind this. A dropped connection is a strip, not a
          sign-out: the box is still working and this device reconnects on its own.
        */}
          {offline && (
            <div className="inline-error offline-strip" role="status">
              <WifiOff />
              <span>Can’t reach your athanor — retrying. It keeps working while you wait.</span>
              <button onClick={() => void load()}>Retry now</button>
            </div>
          )}
          {streamDegraded && !offline && (
            <div className="inline-notice" role="status">
              <span>
                Reconnecting to this conversation — new activity may arrive a little late.
              </span>
            </div>
          )}
          {error && (
            <div className="inline-error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">
                <X />
              </button>
            </div>
          )}
          {notice && (
            <div className="inline-notice" role="status">
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Dismiss status">
                <X />
              </button>
            </div>
          )}
          <Composer
            prompt={prompt}
            onPrompt={setPrompt}
            textareaRef={composer}
            attachments={attachments}
            onRemoveAttachment={removeAttachment}
            onUploadFiles={uploadFiles}
            workspaceAvailable={Boolean(workspace)}
            taskOpen={canContinueTask}
            taskLive={taskIsActive}
            busy={busy}
            canSend={canSend}
            onSend={(options) => void send(options ?? {})}
            onStop={() => void stopTask()}
            recording={recording}
            onToggleRecording={() => void toggleVoiceRecording()}
            onSchedule={() => setScheduleModal(true)}
            {...(nativeFolderPicker ? { onImportFolder: () => void attachNativeFolder() } : {})}
            securityMode={currentSecurityMode}
            onSecurityMode={(mode) => void changeSecurityMode(mode)}
            providerConfigured={data.instance.providerConfigured}
            enforceZeroDataRetention={data.instance.enforceZeroDataRetention}
            webSearchNote={webSearchNote(webRoute)}
            webSearchDisclosure={webRoute?.disclosure ?? ''}
            onOpenAiSettings={() => openSettings('ai')}
            models={models}
            unavailableModels={unavailableModels}
            modelChoice={
              modelAutomatic
                ? { automatic: true, preference: modelPreference }
                : { automatic: false, modelId }
            }
            onModelChoice={(choice) => {
              setModelAutomatic(choice.automatic);
              if (choice.automatic) setModelPreference(choice.preference);
              else setModelId(choice.modelId);
            }}
          />
          <Approvals
            approvals={approvals}
            {...(workspace ? { workspaceId: workspace.id } : {})}
            onOpenTask={setTaskId}
            openTaskId={taskId}
            /* So the card can say whether the agent asking had anybody else's text in its context.
               These are the events of the conversation on screen; the card reads them only for an
               approval that belongs to it. */
            openTaskEvents={events}
            onOpenComputer={() => openInspector('computer')}
            /*
              The card only goes when the decision actually landed. It used to be an unguarded
              `async` called as `void onResolve(...)`, so an expired approval or a dropped
              connection produced an unhandled rejection and a button that did nothing at all — on
              the one control where doing nothing silently is least acceptable. The wording matches
              what the lock-screen path already says for the same three outcomes.
            */
            onResolve={async (id, decision) => {
              try {
                await api.resolveApproval(id, decision);
                setApprovals((items) => items.filter((item) => item.id !== id));
                setError('');
              } catch (cause) {
                if (cause instanceof ApiFailure && cause.status === 404) {
                  setApprovals((items) => items.filter((item) => item.id !== id));
                  setError('That request was already answered, or it expired.');
                  return;
                }
                setError(describeFailure(cause, 'That decision could not be sent'));
              }
            }}
          />
          {/*
          One pane switcher on a phone, and it reaches everywhere.

          This bar and the Inspector's own strip were two switchers doing the same job and
          disagreeing about what existed: three of the seven destinations were only in the strip,
          so a phone reached them through an overflow menu that was a second mental model. There
          are four surfaces now, they all fit, and the menu is gone.
        */}
          <nav className="mobile-tabs" aria-label="Primary">
            {(
              [
                ['work', 'Work', MessageSquarePlus],
                ['files', 'Files', Archive],
                ['computer', 'Computer', Monitor],
                ['terminal', 'Terminal', TerminalSquare],
                ['preview', 'Preview', Play]
              ] as const
            ).map(([id, label, Icon]) => {
              const active = id === 'work' ? !inspectorOpen : inspectorOpen && inspectorTab === id;
              return (
                <button
                  key={id}
                  onClick={() => {
                    if (id === 'work') {
                      setInspectorOpen(false);
                      return;
                    }
                    openInspector(id);
                  }}
                  className={active ? 'active' : ''}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon />
                  {label}
                </button>
              );
            })}
          </nav>
        </main>
        {trajectory && task && (
          <RewindDialog
            trajectory={trajectory}
            onChange={setTrajectory}
            preview={rewindPreview}
            promptRef={trajectoryPrompt}
            taskIsActive={taskIsActive}
            busy={busy}
            onConfirm={() => void runTrajectory()}
            onCancel={() => setTrajectory(undefined)}
            onOpenRecoveryPoints={() => openSettings('server')}
          />
        )}
        {inspectorOpen && (
          <Suspense
            fallback={<aside className="inspector inspector-loading">Opening tools…</aside>}
          >
            <Inspector
              workspace={workspace}
              initialTab={inspectorTab}
              {...(browserWall ? { wall: browserWall } : {})}
              onTab={setInspectorTab}
            />
          </Suspense>
        )}
        {shortcutSheet && (
          <Dialog
            className="modal shortcut-sheet"
            labelledBy="shortcut-title"
            onClose={() => setShortcutSheet(false)}
          >
            <button
              className="modal-close"
              onClick={() => setShortcutSheet(false)}
              aria-label="Close"
            >
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
        )}
        <CommandPalette
          open={palette}
          onClose={() => setPalette(false)}
          commands={paletteCommands}
          tasks={data.tasks}
          onOpenTask={(target) => {
            setWorkspaceId(target.workspaceId);
            setTaskId(target.id);
            setMobileNav(false);
          }}
          search={searchConversations}
        />
        {noticeLog && (
          <NoticeLog
            notices={notices}
            onOpenTask={(target) => {
              setTaskId(target);
              setMobileNav(false);
            }}
            onClose={() => setNoticeLog(false)}
          />
        )}
        {scheduleModal && (
          <ScheduleModal
            schedules={data.schedules}
            workspaces={data.workspaces}
            models={data.models}
            {...(workspaceId ? { defaultWorkspaceId: workspaceId } : {})}
            initialPrompt={prompt}
            onClose={() => setScheduleModal(false)}
            onChanged={async () => {
              await load();
            }}
          />
        )}
        {settingsPage && (
          <Suspense fallback={null}>
            <SelfHostedSettings
              user={data.user}
              workspace={workspace}
              tasks={data.tasks}
              legal={data.legal}
              initialPage={settingsPage}
              onOpenTerminal={() => {
                setSettingsPage(undefined);
                openInspector('terminal');
              }}
              onOpenTask={(id) => {
                const target = data.tasks.find((item) => item.id === id);
                if (target) setWorkspaceId(target.workspaceId);
                setSettingsPage(undefined);
                setTaskId(id);
              }}
              onClose={() => {
                setSettingsPage(undefined);
                void load();
              }}
              onLogout={() =>
                void api
                  .logout()
                  .catch(() => undefined)
                  .then(() => {
                    setSettingsPage(undefined);
                    setAuth('required');
                    setData(undefined);
                  })
              }
            />
          </Suspense>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <UndoToasts queue={undo.queue} pending={undo.pending} />
      </div>
    </UndoProvider>
  );
}
