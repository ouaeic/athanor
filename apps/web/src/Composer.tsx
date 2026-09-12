import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, Paperclip, X, Mic, Square, SlidersHorizontal } from 'lucide-react';
import type {
  Task,
  Workspace,
  TaskLifetime,
  TaskReasoningEffort,
  ProjectModelChoices,
  ProjectModelPreferences
} from '@athanor/contracts';
import { modeFloors } from './asking-rules';
import { effortChoices, effortLabel } from './reasoning-options';
import type { Bootstrap, Draft, DraftAttachment } from './model';
import { defaultPrivacy, isWorking, text, data } from './model';
import { get, isNativeClient, patch, post, request } from './client';
import ModelPicker from './ModelPicker.js';
import { ConfirmButton } from './management';
import { Button, Dialog, ErrorNotice } from './ui';
import { useAutosizeTextarea } from './use-autosize-textarea';
import { MAX_TASK_SPEND_USD } from './usage-model.js';
const PromptModelChoices = lazy(() => import('./PromptModels'));
import {
  dictationSession,
  spendCap,
  transcriptionPayload,
  uploadAttachments
} from './composer-operations.js';
import { DraftConflict, DraftSync } from './draft-sync';
import { draftStorage, keepsDeviceDrafts, recoveryFor, writeDraft } from './draft-storage';
import type { DictationState } from './composer-operations.js';
import type { DictationConsent } from './dictation-preflight';
const LocalFolderAttachments = lazy(() => import('./LocalFolderAttachments.js'));
const DictationSetup = lazy(() => import('./DictationSetup'));

export interface ComposerProps {
  workspace: Workspace;
  task?: Task | null;
  bootstrap: Bootstrap;
  initialDraft?: Draft;
  scope?: string;
  /** Extra trigger docked at the right of the attach/voice toolbar (shape selection lives there). */
  toolbarExtra?: ReactNode;
  onSent: (task: Task) => void;
  onDraft: (draft: Draft) => void;
}
export default function Composer({
  workspace,
  task = null,
  bootstrap,
  initialDraft,
  scope,
  toolbarExtra,
  onSent,
  onDraft
}: ComposerProps) {
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    initialDraft?.attachments ?? []
  );
  const [modelId, setModelId] = useState(initialDraft?.controls?.modelId ?? '');
  const [modelChoices, setModelChoices] = useState<ProjectModelChoices>(
    initialDraft?.controls?.modelChoices ?? {}
  );
  const [projectMain, setProjectMain] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<TaskReasoningEffort>(
    initialDraft?.controls?.reasoningEffort ?? task?.reasoningEffort ?? 'auto'
  );
  const [privacyRoute, setPrivacyRoute] = useState(
    initialDraft?.controls?.privacyRoute ?? task?.privacyRoute ?? defaultPrivacy(bootstrap)
  );
  /*
   * How long this conversation is meant to live, which two very different things read: how long
   * anything it publishes stays up, and how far past one step budget the run may carry itself.
   * Only offered when starting work - a run already under way has a lifetime, and changing it
   * mid-flight would move a ceiling the turn is already being held to.
   */
  const [lifetime, setLifetime] = useState<TaskLifetime>(
    initialDraft?.controls?.lifetime ?? 'standard'
  );
  const [securityMode, setSecurityMode] = useState<Task['securityMode']>(
    initialDraft?.controls?.securityMode ?? task?.securityMode ?? workspace.securityMode
  );
  const [cap, setCap] = useState(initialDraft?.controls?.spendCap ?? '');
  const [advancedModels, setAdvancedModels] = useState(false);
  const [interrupt, setInterrupt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(
    initialDraft?.recoveryId ? 'Recovered draft from this device' : ''
  );
  const [draftConflict, setDraftConflict] = useState<Draft | null>(null);
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [dictationSetup, setDictationSetup] = useState(false);
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [pendingSend, setPendingSend] = useState(Boolean(recoveryFor(initialDraft)?.submission));
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useAutosizeTextarea(body);
  const voice = useRef<ReturnType<typeof dictationSession> | null>(null);
  const voiceState = useRef<DictationState>('idle');
  const dictationConsent = useRef<DictationConsent | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const changed = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRevision = useRef(0);
  const pendingDraft = useRef<Draft | null>(null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const [draftWrites] = useState(
    () =>
      new DraftSync({
        draft: initialDraft ?? {
          workspaceId: workspace.id,
          taskId: task?.id ?? null,
          body: '',
          attachments: []
        },
        recovery: recoveryFor(initialDraft),
        storage: draftStorage,
        write: writeDraft,
        onStatus: (status, cause) => {
          if (!mounted.current || sending.current) return;
          setSaved(
            status === 'pending_delivery'
              ? 'Send not confirmed · retry safely below'
              : status === 'synced'
                ? 'Draft synced'
                : status === 'device'
                  ? keepsDeviceDrafts()
                    ? 'Saved on this device · waiting to sync'
                    : 'Draft not synced'
                  : status === 'saving'
                    ? 'Saving draft…'
                    : status === 'conflict'
                      ? 'Choose a draft version'
                      : 'Draft not saved'
          );
          if (status === 'conflict' && cause instanceof DraftConflict)
            setDraftConflict(cause.server);
          else if (status === 'unsaved') setError(cause);
        },
        onSynced: (draft) => {
          if (pendingDraft.current && draft.revision !== undefined)
            pendingDraft.current.revision = draft.revision;
          onDraftRef.current(pendingDraft.current ?? draft);
        }
      })
  );
  useEffect(() => {
    const sync = () => {
      void draftWrites.flush().catch(() => undefined);
    };
    sync();
    window.addEventListener('online', sync);
    return () => window.removeEventListener('online', sync);
  }, [draftWrites]);
  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    let currentPreferences: ProjectModelPreferences | null = null;
    const apply = (current: ProjectModelPreferences) => {
      if (controller.signal.aborted || current.revision < (currentPreferences?.revision ?? 0))
        return;
      currentPreferences = current;
      setProjectMain(
        current.choices.main
          ? (current.purposes.find((item) => item.purpose === 'main')?.effective?.id ?? null)
          : null
      );
    };
    const load = () => {
      void get<ProjectModelPreferences>(`/v1/tasks/${task.id}/model-preferences`, {
        signal: controller.signal
      })
        .then(apply)
        .catch(() => undefined);
    };
    const updated = (event: Event) => {
      const next = (event as CustomEvent<ProjectModelPreferences>).detail;
      if (next.projectTaskId !== (currentPreferences?.projectTaskId ?? task.id)) return;
      if (JSON.stringify(next.choices.main) !== JSON.stringify(currentPreferences?.choices.main)) {
        changed.current = true;
        setModelId('');
        setReasoningEffort('auto');
      }
      apply(next);
    };
    load();
    window.addEventListener('garden-model-preferences', updated);
    return () => {
      controller.abort();
      window.removeEventListener('garden-model-preferences', updated);
    };
  }, [task?.id]);
  useEffect(() => {
    if (!changed.current || sending.current || busy) return;
    const draft: Draft = {
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      body,
      attachments,
      controls: {
        modelId,
        reasoningEffort,
        securityMode,
        privacyRoute,
        spendCap: cap,
        ...(!task ? { modelChoices, lifetime } : {})
      }
    };
    onDraftRef.current(draft);
    pendingDraft.current = draft;
    const revision = ++draftRevision.current;
    void draftWrites.stage(draft).catch(() => undefined);
    draftTimer.current = setTimeout(() => {
      setSaved('Saving draft…');
      void draftWrites
        .flush()
        .then(() => {
          if (mounted.current && !sending.current && revision === draftRevision.current)
            setSaved('Draft synced');
          if (pendingDraft.current === draft) pendingDraft.current = null;
        })
        .catch((err: unknown) => {
          if (
            mounted.current &&
            !sending.current &&
            revision === draftRevision.current &&
            !keepsDeviceDrafts()
          )
            setError(err);
        });
    }, 650);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [
    body,
    attachments,
    modelId,
    modelChoices,
    lifetime,
    reasoningEffort,
    securityMode,
    privacyRoute,
    cap,
    workspace.id,
    task?.id,
    busy,
    draftWrites
  ]);
  useEffect(() => {
    mounted.current = true;
    voice.current = dictationSession({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createRecorder: (stream) => new MediaRecorder(stream),
      transcribe: async (audio, signal) => {
        const consent = dictationConsent.current;
        if (!consent) throw new Error('Review dictation options before recording.');
        const payload = await transcriptionPayload(audio, signal);
        signal.throwIfAborted();
        const result = await post<unknown>(
          '/v1/audio/transcriptions',
          { ...payload, ...consent },
          { signal }
        );
        return text(data(result).text);
      },
      onText: (transcript) => {
        changed.current = true;
        setBody((current) => [current, transcript].filter(Boolean).join('\n'));
        input.current?.focus();
      },
      onError: setError,
      onState: (state) => {
        if (state === 'idle') dictationConsent.current = null;
        voiceState.current = state;
        setDictationState(state);
      }
    });
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
      voice.current?.dispose();
      voiceState.current = 'idle';
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (pendingDraft.current && !sending.current) {
        void draftWrites.save(pendingDraft.current).catch(() => undefined);
      }
    };
  }, []);
  async function upload(files: FileList | readonly File[] | null): Promise<boolean> {
    if (
      !files?.length ||
      sending.current ||
      uploadController.current ||
      voiceState.current !== 'idle' ||
      pendingTask
    )
      return false;
    setUploading(true);
    setError(null);
    const controller = new AbortController();
    uploadController.current = controller;
    try {
      await uploadAttachments(
        Array.from(files),
        attachments.length,
        controller.signal,
        (path, file, signal) =>
          request(`/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal
          }),
        (attachment) => {
          if (!mounted.current) return;
          changed.current = true;
          setAttachments((current) => [...current, attachment]);
        }
      );
      return true;
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(err);
      return false;
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      if (mounted.current) setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  const clearedDraft = (): Draft => ({
    workspaceId: workspace.id,
    taskId: task?.id ?? null,
    body: '',
    attachments: []
  });
  async function finishDelivery(result: Task) {
    try {
      await draftWrites.finishSubmission(clearedDraft());
      if (mounted.current) {
        setPendingTask(null);
        setPendingSend(false);
        setSaved('');
        onSent(result);
      }
    } catch (cause) {
      if (mounted.current) {
        setPendingTask(result);
        setSaved('Work sent · draft not synced');
        setError(
          new Error(
            'Your work was sent, but its saved draft could not be cleared. Retry draft sync to open it.',
            { cause }
          )
        );
      }
    }
  }
  async function resolveDraft(choice: 'device' | 'server') {
    setBusy(true);
    try {
      const draft = await draftWrites.resolve(choice);
      if (choice === 'server') {
        changed.current = false;
        pendingDraft.current = null;
        setBody(draft.body);
        setAttachments(draft.attachments);
        setModelId(draft.controls?.modelId ?? '');
        setModelChoices(draft.controls?.modelChoices ?? {});
        setReasoningEffort(draft.controls?.reasoningEffort ?? task?.reasoningEffort ?? 'auto');
        setPrivacyRoute(
          draft.controls?.privacyRoute ?? task?.privacyRoute ?? defaultPrivacy(bootstrap)
        );
        setSecurityMode(
          draft.controls?.securityMode ?? task?.securityMode ?? workspace.securityMode
        );
        setLifetime(draft.controls?.lifetime ?? 'standard');
        setCap(draft.controls?.spendCap ?? '');
      }
      setDraftConflict(null);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (
      dictationSetup ||
      !body.trim() ||
      sending.current ||
      uploadController.current ||
      voiceState.current !== 'idle' ||
      workspace.status !== 'running' ||
      pendingTask
    )
      return;
    if (!navigator.onLine) {
      setError(new Error('You are offline. Your draft is kept; reconnect before sending.'));
      return;
    }
    let limit: number | undefined;
    try {
      limit = spendCap(cap);
    } catch (cause) {
      setError(cause);
      return;
    }
    sending.current = true;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    ++draftRevision.current;
    setBusy(true);
    setError(null);
    const prompt = scope
      ? `${body.trim()}\n\nSelected context for this direction:\n${scope}`
      : body.trim();
    const payload = {
      prompt,
      attachments: attachments.map((file) => file.path),
      ...(modelId ? { modelId } : {}),
      ...(!task && Object.keys(modelChoices).length ? { modelChoices } : {}),
      reasoningEffort,
      securityMode,
      privacyRoute,
      ...(limit !== undefined ? { maxSpendUsd: limit } : {}),
      // Only on a new conversation, and only when it is not the default: a follow-up inherits the
      // lifetime the run already has, and sending `standard` explicitly would say nothing.
      ...(task || lifetime === 'standard' ? {} : { lifetime }),
      ...(task ? { interrupt } : { workspaceId: workspace.id })
    };
    const previous = draftWrites.pendingSubmission;
    const signature = previous?.signature ?? JSON.stringify(payload);
    const submittedPayload: unknown = previous ? JSON.parse(previous.signature) : payload;
    try {
      await draftWrites.flush();
      const key = await draftWrites.prepareSubmission(
        signature,
        pendingDraft.current ?? {
          workspaceId: workspace.id,
          taskId: task?.id ?? null,
          body,
          attachments,
          controls: {
            modelId,
            modelChoices,
            lifetime,
            reasoningEffort,
            securityMode,
            privacyRoute,
            spendCap: cap
          }
        }
      );
      setPendingSend(true);
      const result = await post<Task>(
        task ? `/v1/tasks/${task.id}/messages` : '/v1/tasks',
        submittedPayload,
        {
          idempotencyKey: key,
          ...(previous ? { headers: { 'idempotency-replay-only': 'true' } } : {})
        }
      );
      changed.current = false;
      pendingDraft.current = null;
      if (mounted.current) {
        setBody('');
        setAttachments([]);
      }
      onDraftRef.current(clearedDraft());
      await finishDelivery(result);
    } catch (err) {
      if (mounted.current) {
        setError(err);
        if (err instanceof DraftConflict) setDraftConflict(err.server);
      }
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function dictate() {
    if (voiceState.current === 'recording') {
      voice.current?.stop();
      return;
    }
    if (sending.current || uploadController.current || pendingTask || voiceState.current !== 'idle')
      return;
    setError(null);
    setDictationSetup(true);
  }
  function changeSecurityMode(next: Task['securityMode']) {
    changed.current = true;
    setSecurityMode(next);
    setError(null);
    if (!task || !isWorking(task)) return;
    setBusy(true);
    void patch<Task>(`/v1/tasks/${task.id}/security-mode`, { securityMode: next })
      .then((updated) => {
        if (mounted.current) onSent(updated);
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setSecurityMode(task.securityMode);
          setError(cause);
        }
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }
  const recording = dictationState === 'recording';
  const voiceBusy = dictationState !== 'idle';
  const editingDisabled = busy || Boolean(pendingTask) || pendingSend;
  const models = bootstrap.models.filter((model) => model.privacyRoute === privacyRoute);
  const projectModel = models.find((model) => model.id === (projectMain || task?.modelId));
  const selectedModel = models.find(
    (model) => model.id === (modelId || projectMain || task?.modelId)
  );
  const efforts = effortChoices(selectedModel?.reasoning);
  return (
    <form
      className={`intent-editor ${task ? 'follow-up' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {dictationSetup && (
        <Suspense fallback={null}>
          <DictationSetup
            onClose={() => setDictationSetup(false)}
            onStart={(consent, maxSeconds) => {
              dictationConsent.current = consent;
              setDictationSetup(false);
              void voice.current?.start({ maxMilliseconds: maxSeconds * 1000 });
            }}
          />
        </Suspense>
      )}
      {scope && <div className="scope-label">This direction includes your selected context.</div>}
      <label className="sr-only" htmlFor={`intent-${task?.id ?? 'new'}`}>
        {task ? 'Add direction to this work' : 'Describe what you want to do'}
      </label>
      <textarea
        id={`intent-${task?.id ?? 'new'}`}
        ref={input}
        value={body}
        disabled={editingDisabled || voiceBusy}
        maxLength={200000}
        rows={1}
        onChange={(event) => {
          changed.current = true;
          setBody(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={task ? 'Add a direction…' : 'Describe what you want to do…'}
      />
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((file) => (
            <span key={file.path}>
              {file.name}
              <button
                type="button"
                aria-label={`Remove ${file.name} from this direction`}
                disabled={editingDisabled || uploading || voiceBusy}
                onClick={() => {
                  changed.current = true;
                  setAttachments((current) => current.filter((item) => item.path !== file.path));
                }}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="intent-toolbar">
        <div className="row">
          <input
            ref={fileInput}
            type="file"
            multiple
            disabled={editingDisabled || uploading || voiceBusy}
            className="sr-only"
            tabIndex={-1}
            aria-label="Attach files"
            onChange={(event) => upload(event.target.files)}
          />
          <Button
            aria-label="Attach files"
            onClick={() => fileInput.current?.click()}
            disabled={editingDisabled || uploading || voiceBusy}
          >
            <Paperclip size={18} />
          </Button>
          {isNativeClient() && (
            <Suspense fallback={null}>
              <LocalFolderAttachments
                disabled={editingDisabled || uploading || voiceBusy}
                remaining={Math.max(0, 20 - attachments.length)}
                onFiles={upload}
                onCancel={() => uploadController.current?.abort()}
              />
            </Suspense>
          )}
          {toolbarExtra && <div className="toolbar-extra">{toolbarExtra}</div>}
          {typeof MediaRecorder !== 'undefined' && (
            <Button
              aria-label={recording ? 'Stop dictation' : 'Dictate direction'}
              onClick={dictate}
              disabled={editingDisabled || uploading || (voiceBusy && !recording)}
            >
              {recording ? <Square size={16} /> : <Mic size={18} />}
            </Button>
          )}
        </div>
        <Button
          type="submit"
          className="primary"
          disabled={
            !body.trim() ||
            uploading ||
            voiceBusy ||
            Boolean(pendingTask) ||
            workspace.status !== 'running'
          }
          busy={busy}
        >
          {pendingSend
            ? 'Retry send'
            : task
              ? isWorking(task)
                ? interrupt
                  ? 'Update run'
                  : 'Queue next'
                : 'Send'
              : 'Begin'}
          <ArrowUpRight size={18} />
        </Button>
      </div>
      {uploading && (
        <div className="row muted" role="status">
          Uploading…<Button onClick={() => uploadController.current?.abort()}>Cancel upload</Button>
        </div>
      )}
      {voiceBusy && (
        <div className="row muted" role="status">
          {dictationState === 'requesting'
            ? 'Waiting for microphone access…'
            : recording
              ? 'Recording…'
              : 'Transcribing…'}
          <Button onClick={() => voice.current?.cancel()}>Cancel dictation</Button>
        </div>
      )}
      {pendingSend && !pendingTask && !busy && (
        <div className="draft-conflict" role="status">
          <p>
            The earlier send was not confirmed. Retry send looks up the saved receipt for that exact
            request. It does not start another task.
          </p>
          <ConfirmButton
            label="Keep as an unsent draft"
            description="The earlier request may already have created work. Check All work before sending this as a new request. Keep the text and discard its saved retry identity?"
            action={async () => {
              await draftWrites.abandonSubmission();
              setPendingSend(false);
              setError(null);
            }}
          />
        </div>
      )}
      {pendingTask && (
        <div className="row">
          <Button
            busy={busy}
            onClick={() => {
              if (sending.current) return;
              sending.current = true;
              setBusy(true);
              setError(null);
              void finishDelivery(pendingTask).finally(() => {
                sending.current = false;
                if (mounted.current) setBusy(false);
              });
            }}
          >
            Retry draft sync and open work
          </Button>
        </div>
      )}
      <div className="garden-model-controls">
        <div className="garden-model-settings">
          <div className="garden-model-select">
            <span>Model</span>
            <ModelPicker
              label="Model for this direction"
              loadDetails
              privacyRoute={privacyRoute}
              value={!task && modelChoices.main?.automatic ? '__automatic' : modelId}
              models={models}
              shortcuts={[
                {
                  value: '',
                  label: task
                    ? (projectModel?.displayName ?? 'Current project model')
                    : 'Use global default'
                },
                ...(!task ? [{ value: '__automatic', label: 'Automatic for this project' }] : [])
              ]}
              disabled={editingDisabled || uploading || voiceBusy}
              onChange={(value) => {
                changed.current = true;
                setModelId(value === '__automatic' ? '' : value);
                if (!task)
                  setModelChoices((current) => {
                    const next = { ...current };
                    if (!value) delete next.main;
                    else
                      next.main = {
                        automatic: value === '__automatic',
                        preference: current.main?.preference ?? 'balanced',
                        modelId: value === '__automatic' ? '' : value
                      };
                    return next;
                  });
                setReasoningEffort('auto');
              }}
            />
          </div>
          <Button
            aria-label="Model choices for this direction"
            aria-expanded={advancedModels}
            title="Model choices for this direction"
            onClick={() => setAdvancedModels((open) => !open)}
          >
            <SlidersHorizontal size={14} />
          </Button>
          {!task && (
            <label className="garden-approval-select">
              <span>Runs for</span>
              <select
                aria-label="How long this work is meant to run"
                title="How long anything this publishes stays up, and how far past one step budget the run may carry itself"
                value={lifetime}
                disabled={editingDisabled}
                onChange={(event) => {
                  changed.current = true;
                  setLifetime(event.target.value as TaskLifetime);
                }}
              >
                <option value="brief">Minutes — output expires in a day</option>
                <option value="standard">Normal</option>
                <option value="sustained">Days — keeps going unattended</option>
              </select>
            </label>
          )}
          <label className="garden-approval-select">
            <span>Approvals</span>
            <select
              aria-label="Approvals for this prompt"
              title={modeFloors[securityMode]}
              value={securityMode}
              disabled={editingDisabled}
              onChange={(event) => changeSecurityMode(event.target.value as Task['securityMode'])}
            >
              <option value="review">Review</option>
              <option value="balanced">Balanced</option>
              <option value="autonomous">Autonomous</option>
            </select>
          </label>
          <label className="garden-effort-control">
            <span>Effort</span>
            <select
              aria-label="Model reasoning effort"
              title={
                efforts.length < 2
                  ? selectedModel
                    ? 'This model does not expose adjustable effort'
                    : 'Select a model to choose its effort'
                  : 'Reasoning effort'
              }
              value={efforts.includes(reasoningEffort) ? reasoningEffort : 'auto'}
              disabled={editingDisabled || efforts.length < 2}
              onChange={(event) => {
                changed.current = true;
                setReasoningEffort(event.target.value as TaskReasoningEffort);
              }}
            >
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effortLabel(effort)}
                </option>
              ))}
            </select>
          </label>
          <label className="garden-route-control">
            <span>Privacy</span>
            <select
              value={privacyRoute}
              disabled={
                editingDisabled ||
                uploading ||
                voiceBusy ||
                bootstrap.instance.enforceZeroDataRetention
              }
              onChange={(event) => {
                changed.current = true;
                setPrivacyRoute(event.target.value === 'external' ? 'external' : 'provider_zdr');
                setModelId('');
                setModelChoices((current) => {
                  const next = { ...current };
                  delete next.main;
                  return next;
                });
                setReasoningEffort('auto');
              }}
            >
              <option value="provider_zdr">Private</option>
              <option value="external">External</option>
            </select>
          </label>
          <label className="garden-cap-control">
            <span>{task ? 'Extra limit' : 'Limit'}</span>
            <input
              type="number"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              min="0.01"
              max={MAX_TASK_SPEND_USD}
              disabled={editingDisabled || uploading || voiceBusy}
              step="0.01"
              value={cap}
              onChange={(event) => {
                changed.current = true;
                setCap(event.target.value);
              }}
              placeholder="USD"
              aria-label={task ? 'Additional spend limit in USD' : 'Task spend limit in USD'}
            />
          </label>
          {task && isWorking(task) && (
            <label className="garden-route-control">
              <span>Apply</span>
              <select
                value={interrupt ? 'now' : 'next'}
                disabled={editingDisabled || uploading || voiceBusy}
                onChange={(event) => setInterrupt(event.target.value === 'now')}
                aria-label="Apply this direction"
              >
                <option value="now">Now</option>
                <option value="next">Next run</option>
              </select>
            </label>
          )}
        </div>
      </div>
      {advancedModels && (
        <Dialog title="Model choices" onClose={() => setAdvancedModels(false)} wide>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <PromptModelChoices
              {...(task ? { taskId: task.id } : { taskId: '' })}
              disabled={editingDisabled}
              choices={modelChoices}
              privacyRoute={privacyRoute}
              onChange={(choices) => {
                changed.current = true;
                setModelChoices(choices);
                setModelId(choices.main?.automatic === false ? choices.main.modelId : '');
                if (JSON.stringify(choices.main) !== JSON.stringify(modelChoices.main))
                  setReasoningEffort('auto');
              }}
            />
          </Suspense>
        </Dialog>
      )}
      <ErrorNotice error={error} />
      {draftConflict && (
        <div className="draft-conflict" role="alert">
          <strong>A newer draft exists on another device.</strong>
          <p>Your text is kept here. Choose which version to continue with.</p>
          <details>
            <summary>View the other draft</summary>
            <pre>{draftConflict.body || '(No text)'}</pre>
          </details>
          <div className="row">
            <Button disabled={busy} onClick={() => void resolveDraft('device')}>
              Keep my draft
            </Button>
            <Button disabled={busy} onClick={() => void resolveDraft('server')}>
              Use other draft
            </Button>
          </div>
        </div>
      )}
      {saved && (
        <small className="draft-status" role="status">
          {saved}
        </small>
      )}
    </form>
  );
}
