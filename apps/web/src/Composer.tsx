import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Paperclip, X, SlidersHorizontal, Mic, Square } from 'lucide-react';
import type { Task, Workspace } from '@athanor/contracts';
import type { Bootstrap, Draft, DraftAttachment } from './model';
import { defaultPrivacy, isWorking, text, data } from './model';
import { isNativeClient, post, put, request } from './client';
import { Button, ErrorNotice, Field } from './ui';
import { MAX_TASK_SPEND_USD } from './usage-model.js';
import {
  dictationSession,
  serialDraftWriter,
  spendCap,
  transcriptionPayload,
  uploadAttachments
} from './composer-operations.js';
import type { DictationState } from './composer-operations.js';
const LocalFolderAttachments = lazy(() => import('./LocalFolderAttachments.js'));

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
  const [modelId, setModelId] = useState('');
  const [privacyRoute, setPrivacyRoute] = useState(task?.privacyRoute ?? defaultPrivacy(bootstrap));
  const [cap, setCap] = useState('');
  const [interrupt, setInterrupt] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState('');
  const [dictationState, setDictationState] = useState<DictationState>('idle');
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const voice = useRef<ReturnType<typeof dictationSession> | null>(null);
  const voiceState = useRef<DictationState>('idle');
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
    const draft: Draft = { workspaceId: workspace.id, taskId: task?.id ?? null, body, attachments };
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
  }, [body, attachments, workspace.id, task?.id, busy, draftWrites]);
  useEffect(() => {
    mounted.current = true;
    voice.current = dictationSession({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createRecorder: (stream) => new MediaRecorder(stream),
      transcribe: async (audio, signal) => {
        const payload = await transcriptionPayload(audio, signal);
        signal.throwIfAborted();
        const result = await post<unknown>('/v1/audio/transcriptions', payload, { signal });
        return text(data(result).text);
      },
      onText: (transcript) => {
        changed.current = true;
        setBody((current) => [current, transcript].filter(Boolean).join('\n'));
        input.current?.focus();
      },
      onError: setError,
      onState: (state) => {
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
    void voice.current?.start();
  }
  const recording = dictationState === 'recording';
  const voiceBusy = dictationState !== 'idle';
  const editingDisabled = busy || Boolean(pendingTask);
  const models = bootstrap.models.filter(
    (model) => model.availability === 'available' && model.privacyRoute === privacyRoute
  );
  return (
    <form
      className={`intent-editor ${task ? 'follow-up' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
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
        rows={task ? 3 : 2}
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
        placeholder={
          task
            ? 'Add a thought, ask a question, or shape the next step…'
            : 'Describe what you want to do…'
        }
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
          <Button
            aria-label="Model and spending options"
            aria-expanded={advanced}
            disabled={editingDisabled || uploading || voiceBusy}
            onClick={() => setAdvanced(!advanced)}
          >
            <SlidersHorizontal size={17} />
            <span>
              {modelId
                ? (models.find((model) => model.id === modelId)?.displayName ?? 'Chosen model')
                : 'Automatic'}
            </span>
          </Button>
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
          {task ? (interrupt ? 'Steer now' : 'Send') : 'Begin'}
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
      {advanced && (
        <div className="intent-options">
          <Field label="Model">
            <select
              disabled={editingDisabled || uploading || voiceBusy}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">Automatic · match this request</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Privacy route">
            <select
              value={privacyRoute}
              disabled={
                editingDisabled ||
                uploading ||
                voiceBusy ||
                bootstrap.instance.enforceZeroDataRetention
              }
              onChange={(event) => {
                setPrivacyRoute(event.target.value === 'external' ? 'external' : 'provider_zdr');
                setModelId('');
              }}
            >
              <option value="provider_zdr">Zero data retention</option>
              <option value="external">External provider</option>
            </select>
          </Field>
          <Field
            label={task ? 'Additional spend limit (USD)' : 'Task spend limit (USD)'}
            hint="Leave blank to use your account limits."
          >
            <input
              type="number"
              min="0.01"
              max={MAX_TASK_SPEND_USD}
              disabled={editingDisabled || uploading || voiceBusy}
              step="0.01"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
              placeholder="Account default"
            />
          </Field>
        </div>
      )}
      {task && isWorking(task) && (
        <label className="check">
          <input
            type="checkbox"
            checked={interrupt}
            disabled={editingDisabled || uploading || voiceBusy}
            onChange={(event) => setInterrupt(event.target.checked)}
          />
          Steer the current run now
          {!interrupt && <span className="muted"> · otherwise queued after current work</span>}
        </label>
      )}
      <ErrorNotice error={error} />
      {saved && (
        <small className="draft-status" role="status">
          {saved}
        </small>
      )}
    </form>
  );
}
