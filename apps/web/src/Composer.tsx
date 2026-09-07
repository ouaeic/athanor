import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Paperclip, X, Mic, Square } from 'lucide-react';
import type { Task, Workspace, TaskReasoningEffort } from '@athanor/contracts';
import { modeFloors } from './asking-rules';
import { effortChoices, effortLabel } from './reasoning-options';
import type { Bootstrap, Draft, DraftAttachment } from './model';
import { defaultPrivacy, isWorking, text, data } from './model';
import { isNativeClient, patch, post, put, request } from './client';
import { Button, ErrorNotice } from './ui';
import { useAutosizeTextarea } from './use-autosize-textarea';
import { MAX_TASK_SPEND_USD } from './usage-model.js';
import {
  dictationSession,
  serialDraftWriter,
  spendCap,
  transcriptionPayload,
  uploadAttachments
} from './composer-operations.js';
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
  onSent: (task: Task) => void;
  onDraft: (draft: Draft) => void;
}
export default function Composer({
  workspace,
  task = null,
  bootstrap,
  initialDraft,
  scope,
  onSent,
  onDraft
}: ComposerProps) {
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [attachments, setAttachments] = useState<DraftAttachment[]>(
    initialDraft?.attachments ?? []
  );
  const [modelId, setModelId] = useState(initialDraft?.controls?.modelId ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<TaskReasoningEffort>(
    initialDraft?.controls?.reasoningEffort ?? task?.reasoningEffort ?? 'auto'
  );
  const [privacyRoute, setPrivacyRoute] = useState(
    initialDraft?.controls?.privacyRoute ?? task?.privacyRoute ?? defaultPrivacy(bootstrap)
  );
  const [securityMode, setSecurityMode] = useState<Task['securityMode']>(
    initialDraft?.controls?.securityMode ?? task?.securityMode ?? workspace.securityMode
  );
  const [cap, setCap] = useState(initialDraft?.controls?.spendCap ?? '');
  const [interrupt, setInterrupt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState('');
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [dictationSetup, setDictationSetup] = useState(false);
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useAutosizeTextarea(body);
  const voice = useRef<ReturnType<typeof dictationSession> | null>(null);
  const voiceState = useRef<DictationState>('idle');
  const dictationConsent = useRef<DictationConsent | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const operation = useRef<{ signature: string; key: string } | null>(null);
  const changed = useRef(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRevision = useRef(0);
  const [draftWrites] = useState(() =>
    serialDraftWriter<Draft>((draft) => put('/v1/drafts', draft))
  );
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  useEffect(() => {
    if (!changed.current || sending.current || busy) return;
    const draft: Draft = {
      workspaceId: workspace.id,
      taskId: task?.id ?? null,
      body,
      attachments,
      controls: { modelId, reasoningEffort, securityMode, privacyRoute, spendCap: cap }
    };
    onDraftRef.current(draft);
    const revision = ++draftRevision.current;
    draftTimer.current = setTimeout(() => {
      setSaved('Saving draft…');
      void draftWrites
        .save(draft)
        .then(() => {
          if (mounted.current && !sending.current && revision === draftRevision.current)
            setSaved('Draft saved');
        })
        .catch((err: unknown) => {
          if (mounted.current && !sending.current && revision === draftRevision.current) {
            setSaved('Draft not synced');
            setError(err);
          }
        });
    }, 650);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [
    body,
    attachments,
    modelId,
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
      await draftWrites.save(clearedDraft());
      operation.current = null;
      if (mounted.current) {
        setPendingTask(null);
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
      reasoningEffort,
      securityMode,
      privacyRoute,
      ...(limit !== undefined ? { maxSpendUsd: limit } : {}),
      ...(task ? { interrupt } : { workspaceId: workspace.id })
    };
    const signature = JSON.stringify(payload);
    if (operation.current?.signature !== signature)
      operation.current = { signature, key: crypto.randomUUID() };
    try {
      await draftWrites.flush();
      const result = await post<Task>(
        task ? `/v1/tasks/${task.id}/messages` : '/v1/tasks',
        payload,
        { idempotencyKey: operation.current.key }
      );
      changed.current = false;
      if (mounted.current) {
        setBody('');
        setAttachments([]);
      }
      onDraftRef.current(clearedDraft());
      await finishDelivery(result);
    } catch (err) {
      if (mounted.current) setError(err);
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
  const editingDisabled = busy || Boolean(pendingTask);
  const models = bootstrap.models.filter(
    (model) => model.availability === 'available' && model.privacyRoute === privacyRoute
  );
  const selectedModel = models.find((model) => model.id === (modelId || task?.modelId));
  const efforts = effortChoices(selectedModel?.reasoning);
  const effortIndex = efforts.indexOf(reasoningEffort);
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
          {task ? (isWorking(task) ? (interrupt ? 'Update run' : 'Queue next') : 'Send') : 'Begin'}
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
        <label className="garden-model-select">
          <span>Model</span>
          <select
            aria-label="Model for this direction"
            value={modelId}
            disabled={editingDisabled || uploading || voiceBusy}
            onChange={(event) => {
              changed.current = true;
              setModelId(event.target.value);
              setReasoningEffort('auto');
            }}
          >
            <option value="">
              {task ? (selectedModel?.displayName ?? 'Current model') : 'Automatic selection'}
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName} ·{' '}
                {model.recommendationTags.includes('Ollama Cloud')
                  ? 'Ollama Cloud'
                  : model.provider === 'openrouter'
                    ? 'OpenRouter'
                    : 'Connected endpoint'}
              </option>
            ))}
          </select>
        </label>
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
          <span>
            Effort <strong>{effortLabel(reasoningEffort)}</strong>
          </span>
          <input
            type="range"
            aria-label="Model reasoning effort"
            aria-valuetext={effortLabel(reasoningEffort)}
            min={0}
            max={Math.max(1, efforts.length - 1)}
            step={1}
            value={Math.max(0, effortIndex)}
            disabled={editingDisabled || efforts.length < 2}
            onChange={(event) => {
              changed.current = true;
              setReasoningEffort(efforts[Number(event.target.value)] ?? 'auto');
            }}
          />
          <small>
            {efforts.length < 2
              ? selectedModel
                ? 'No adjustable levels advertised'
                : 'Choose a model for exact levels'
              : 'Provider-supported levels'}
          </small>
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
      <ErrorNotice error={error} />
      {saved && (
        <small className="draft-status" role="status">
          {saved}
        </small>
      )}
    </form>
  );
}
