import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  ArrowLeft,
  Bot,
  Download,
  File,
  FileCode2,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe2,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  PencilLine,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Share2,
  Trash2,
  Upload,
  UserRound,
  X
} from 'lucide-react';
import { api } from './api.js';
import { deletionMessage, newFolderPath, renamedPath } from './file-actions.js';
import { nextTabIndex } from './focus-trap.js';
import { describeFailure } from './failure-text.js';
import { botWallClearance, formatBytes, hostOf } from './timeline-state.js';
import { previewPortProblem, previewSummary } from './preview-rows.js';
import { advanceFrame, drainFrames, emptyFrameSlots, type FrameSlots } from './remote-frame.js';
import { DiffView } from './DiffView.js';
import { useUndo } from './Undo.js';
import type {
  Artifact,
  BotWall,
  DesktopSnapshot,
  FileEntry,
  Workspace,
  WorkspacePreview
} from './types.js';

/*
 * Four places, and every one of them is somewhere work actually happens.
 *
 * There were seven, and two of them — Computer and Browser — had become the same window: the
 * agent's browser is launched onto the workspace display that Computer already streams, so the
 * owner was offered two top-level destinations for one screen, each with its own idea of who was
 * holding it. Computer is now the screen, whatever is on it. Studio was a second way to ask for a
 * picture the agent can already make by being asked, and Usage was a report rather than a place,
 * so it sits with the spending caps it is measured against.
 */
const inspectorTabs = [
  ['files', 'Files'],
  ['computer', 'Computer'],
  ['terminal', 'Terminal'],
  ['preview', 'Preview']
] as const;
type Tab = (typeof inspectorTabs)[number][0];
const tabIds = inspectorTabs.map(([id]) => id);

/*
 * Reconnecting, with an end to it.
 *
 * Both live panes retried on a fixed timer with no cap, so a pane left open against an unavailable
 * runner minted a fresh capability token roughly seventy-five times a minute, forever, behind a
 * spinner that never resolved. The backoff bounds the traffic and the wording stops promising a
 * reconnection that is not coming.
 */
const RECONNECT_ATTEMPT_LIMIT = 6;

const reconnectDelay = (attempt: number): number => Math.min(30_000, 800 * 2 ** (attempt - 1));

const reconnectMessage = (attempt: number, surface: 'computer' | 'browser'): string =>
  attempt < 2
    ? `Reconnecting to the private ${surface}…`
    : `The agent ${surface === 'computer' ? 'computer' : 'browser'} isn’t answering. Run \`athanor doctor\` on the server.`;

type Holder = 'agent' | 'user' | 'secure_input';

/** Whatever the last state frame said about the surface. Both streams send a subset of this. */
interface SurfaceState {
  holder: Holder;
  width?: number;
  height?: number;
  activeApplication?: string;
  url?: string;
  title?: string;
  /**
   * The newest challenge from any tab, browser stream only. It rides the stream because a wall
   * raised on a background tab is exactly the one nobody would otherwise see, and because a pane
   * opened without a conversation open has no event log to read it out of.
   */
  botWall?: BotWall | null;
}

/**
 * The screen, and the private browser's own view of its page, are the same kind of thing: a live
 * JPEG stream over a capability-scoped socket, a state frame, and a way to send clicks and keys
 * back. They were two copies of this code in two panes; they are one pane now, so they are one
 * implementation, and the second view exists only for a box whose desktop is not running — where
 * a page stream is the only way left to reach a site that is asking for a person.
 */
const surfaceRoutes = {
  display: {
    label: 'computer' as const,
    token: (workspaceId: string) => api.desktopToken(workspaceId),
    stream: (workspaceId: string) => `/v1/workspaces/${workspaceId}/desktop/stream`,
    action: (workspaceId: string, action: unknown) => api.desktopPrivateAction(workspaceId, action),
    holder: (workspaceId: string, holder: Holder) => api.desktopPrivateHolder(workspaceId, holder)
  },
  page: {
    label: 'browser' as const,
    token: (workspaceId: string) => api.browserToken(workspaceId),
    stream: (workspaceId: string) => `/v1/workspaces/${workspaceId}/browser/stream`,
    action: (workspaceId: string, action: unknown) => api.browserPrivateAction(workspaceId, action),
    holder: (workspaceId: string, holder: Holder) => api.browserPrivateHolder(workspaceId, holder)
  }
} as const;

type SurfaceKind = keyof typeof surfaceRoutes;

function useRemoteSurface(workspaceId: string, kind: SurfaceKind | undefined) {
  const [frameUrl, setFrameUrl] = useState('');
  const [state, setState] = useState<SurfaceState>();
  const [error, setError] = useState('');
  const [stalled, setStalled] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  /** See `remote-frame.ts`: the newest frame and the one behind it, which is not safe to revoke. */
  const framesRef = useRef<FrameSlots>(emptyFrameSlots);
  useEffect(() => {
    if (!kind) return;
    const route = surfaceRoutes[kind];
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let stopped = false;
    let attempts = 0;
    const connect = async () => {
      attempts += 1;
      if (stopped) return;
      if (attempts > RECONNECT_ATTEMPT_LIMIT) {
        setStalled(true);
        return;
      }
      try {
        const { runnerUrl, token } = await route.token(workspaceId);
        if (stopped) return;
        socket = new WebSocket(`${runnerUrl.replace(/\/$/, '')}${route.stream(workspaceId)}`, [
          'athanor-capability',
          token
        ]);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;
        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            const next = URL.createObjectURL(new Blob([event.data], { type: 'image/jpeg' }));
            const advanced = advanceFrame(framesRef.current, next);
            framesRef.current = advanced.slots;
            if (advanced.revoke) URL.revokeObjectURL(advanced.revoke);
            setFrameUrl(next);
            setError('');
            attempts = 0;
            return;
          }
          const message = JSON.parse(String(event.data)) as {
            type: string;
            message?: string;
            state?: SurfaceState;
          };
          if (message.type === 'state' && message.state) {
            const incoming = message.state;
            setState((current) => ({ ...current, ...incoming }));
            setError('');
            // Secure input is a promise that nothing is watching, and a stale frame would break it.
            if (incoming.holder === 'secure_input' && framesRef.current.current) {
              const drained = drainFrames(framesRef.current);
              framesRef.current = drained.slots;
              for (const url of drained.revoke) URL.revokeObjectURL(url);
              setFrameUrl('');
            }
          } else if (message.type === 'control_error') {
            setError(message.message ?? 'That control did not reach the agent computer');
          }
        };
        socket.onclose = () => {
          if (!stopped) retry = window.setTimeout(() => void connect(), reconnectDelay(attempts));
        };
        socket.onerror = () => setError(reconnectMessage(attempts, route.label));
      } catch (cause) {
        setError(
          attempts >= 2
            ? reconnectMessage(attempts, route.label)
            : describeFailure(cause, `The agent ${route.label} is not answering`)
        );
        if (!stopped) retry = window.setTimeout(() => void connect(), reconnectDelay(attempts));
      }
    };
    void connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
      socketRef.current = undefined;
      const drained = drainFrames(framesRef.current);
      framesRef.current = drained.slots;
      for (const url of drained.revoke) URL.revokeObjectURL(url);
      setFrameUrl('');
    };
  }, [workspaceId, kind, reconnectNonce]);

  /** Over the open socket when there is one; the REST route is the fallback, not the norm. */
  const direct = (message: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ ...message, requestId: crypto.randomUUID() }));
    return true;
  };
  const send = async (action: unknown): Promise<void> => {
    if (!kind) return;
    if (!direct({ type: 'action', action })) await surfaceRoutes[kind].action(workspaceId, action);
  };
  const setHolder = async (next: Holder): Promise<void> => {
    if (!kind) return;
    setState((current) => ({ ...current, holder: next }));
    if (!direct({ type: 'holder', holder: next }))
      await surfaceRoutes[kind].holder(workspaceId, next);
  };
  return {
    frameUrl,
    state,
    error,
    stalled,
    send,
    setHolder,
    setError,
    reconnect: () => {
      setStalled(false);
      setError('');
      setReconnectNonce((current) => current + 1);
    }
  };
}

function Files({ workspace }: { workspace: Workspace }) {
  const [path, setPath] = useState('workspace');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{
    name: string;
    text?: string;
    url?: string;
    mime?: string;
    captionsUrl?: string;
    captionsLanguage?: string;
    editable?: boolean;
    path?: string;
  }>();
  const [overwrite, setOverwrite] = useState<{
    file: File;
    path: string;
    before: string;
    after: string;
    existingBytes: number;
    /** A screenshot or a PDF has no readable diff; sizes are the honest comparison. */
    binary: boolean;
  }>();
  const [uploadError, setUploadError] = useState('');
  /** Distinct from "empty": a listing that failed must never be reported as an empty computer. */
  const [listingError, setListingError] = useState('');
  /** The decoded text as it was loaded, so Save is inert until something actually changed. */
  const [edit, setEdit] = useState<{ path: string; text: string } | undefined>();
  const [saving, setSaving] = useState(false);
  /** The edited text, held until the owner has seen the diff their save would apply. */
  const [saveReview, setSaveReview] = useState<string>();
  /** One inline form at a time: a new folder here, or a new name for one entry. */
  const [naming, setNaming] = useState<{ entry?: FileEntry; value: string }>();
  /*
   * Finished results are files too, so they live with the files rather than in a pane of their own.
   * They are fixed copies with a version each, which is why they are listed apart from the tree the
   * agent is still working in — and why deleting one is the only way to get its bytes back.
   */
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const undo = useUndo();
  // The form appears where the pointer already is, so the caret follows it — but only when the
  // form opens, which is why this keys on which entry it opened for rather than on every keystroke.
  const namingFor = naming ? (naming.entry?.path ?? '') : null;
  useEffect(() => {
    if (namingFor !== null) nameInput.current?.select();
  }, [namingFor]);
  /*
   * A failed listing used to fall straight through to "Your computer is empty" — a confident false
   * statement about the owner's own data, printed next to a Usage pane reporting several gigabytes.
   */
  const load = async (next = path) => {
    setLoading(true);
    try {
      setEntries((await api.files(workspace.id, next)).entries);
      setPath(next);
      setPreview(undefined);
      setEdit(undefined);
      setListingError('');
    } catch (cause) {
      setEntries([]);
      setListingError(describeFailure(cause, 'Couldn’t read the agent’s files'));
    } finally {
      setLoading(false);
    }
  };
  const loadArtifacts = () =>
    void api
      .artifacts(workspace.id)
      .then(setArtifacts)
      .catch(() => setArtifacts([]));
  useEffect(() => {
    void load('workspace');
    loadArtifacts();
  }, [workspace.id]);
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
      if (preview?.captionsUrl) URL.revokeObjectURL(preview.captionsUrl);
    },
    [preview?.url, preview?.captionsUrl]
  );
  const open = async (entry: FileEntry) => {
    if (entry.type === 'directory') return load(entry.path);
    setListingError('');
    const bytes = await api.file(workspace.id, entry.path).catch((cause: unknown) => {
      // Clicking a file used to do nothing whatsoever when the runner was unavailable.
      setListingError(describeFailure(cause, `Couldn’t open ${entry.name}`));
      return undefined;
    });
    if (!bytes) return;
    const extension = entry.name.split('.').pop()?.toLowerCase();
    const mime = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')
      ? `image/${extension === 'jpg' ? 'jpeg' : extension}`
      : ['mp4', 'webm'].includes(extension ?? '')
        ? `video/${extension}`
        : undefined;
    if (mime) {
      const stem = entry.name.replace(/\.[^.]+$/, '');
      const captionEntry = mime.startsWith('video/')
        ? entries.find(
            (candidate) =>
              candidate.type === 'file' &&
              (candidate.name === `${stem}.vtt` ||
                (candidate.name.startsWith(`${stem}.`) && candidate.name.endsWith('.vtt')))
          )
        : undefined;
      const captionBytes = captionEntry
        ? await api.file(workspace.id, captionEntry.path).catch(() => undefined)
        : undefined;
      const language = captionEntry?.name.match(/\.([a-z]{2,3}(?:-[A-Z]{2})?)\.vtt$/)?.[1] ?? 'en';
      setPreview({
        name: entry.name,
        url: URL.createObjectURL(new Blob([bytes], { type: mime })),
        mime,
        ...(captionBytes
          ? {
              captionsUrl: URL.createObjectURL(new Blob([captionBytes], { type: 'text/vtt' })),
              captionsLanguage: language
            }
          : {})
      });
    } else {
      const text = new TextDecoder().decode(bytes);
      setPreview({
        name: entry.name,
        text: text.slice(0, 2_000_000),
        // Editable when it is genuinely text and small enough to hold whole: binary bytes and
        // oversized files stay exactly as they were, read-only.
        editable: !text.includes('\u0000') && bytes.byteLength <= 1_000_000,
        path: entry.path
      });
      setEdit(
        !text.includes('\u0000') && bytes.byteLength <= 1_000_000
          ? { path: entry.path, text }
          : undefined
      );
    }
  };

  /** The file goes back through the same diff an overwriting upload already has to pass. */
  const saveEdit = async (next: string) => {
    if (!edit) return;
    setSaving(true);
    setUploadError('');
    try {
      await api.writeFile(workspace.id, edit.path, new TextEncoder().encode(next));
      setEdit({ path: edit.path, text: next });
      setPreview((current) => (current ? { ...current, text: next } : current));
      setSaveReview(undefined);
    } catch (cause) {
      setUploadError(describeFailure(cause, 'Could not save this file'));
    } finally {
      setSaving(false);
    }
  };
  const parent = path.split('/').slice(0, -1).join('/') || 'workspace';
  const submitName = async () => {
    if (!naming) return;
    const result = naming.entry
      ? renamedPath(naming.entry, naming.value, entries)
      : newFolderPath(path, naming.value, entries);
    if (!result.ok) {
      setUploadError(result.message);
      return;
    }
    setUploadError('');
    try {
      if (naming.entry) await api.renameFile(workspace.id, naming.entry.path, result.path);
      else await api.createFolder(workspace.id, result.path);
      setNaming(undefined);
      await load();
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : 'That change could not be saved');
    }
  };
  return (
    <div className="inspector-content files-pane">
      <div className="pane-toolbar">
        <button
          className="icon-btn"
          aria-label="Up one folder"
          disabled={path === 'workspace'}
          onClick={() => void load(parent)}
        >
          <ArrowLeft />
        </button>
        <div className="breadcrumbs">
          <FolderOpen size={14} />
          <span>{path.replace(/^workspace\/?/, '') || 'Files'}</span>
        </div>
        <button
          className="icon-btn"
          title="New folder"
          aria-label="New folder"
          onClick={() => {
            setUploadError('');
            setNaming({ value: '' });
          }}
        >
          <FolderPlus />
        </button>
        <button
          className="icon-btn"
          onClick={() => input.current?.click()}
          title="Upload"
          aria-label="Upload files"
        >
          <Upload />
        </button>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          onChange={async (event) => {
            const chosen = Array.from(event.target.files ?? []);
            event.target.value = '';
            setUploadError('');
            for (const file of chosen) {
              // Writing over a file the agent produced used to happen silently. A name that
              // already exists now stops and shows exactly what would be replaced.
              const existing = entries.find(
                (entry) => entry.type === 'file' && entry.name === file.name
              );
              if (existing) {
                const [before, after] = await Promise.all([
                  api
                    .file(workspace.id, existing.path)
                    .then((bytes) => new TextDecoder().decode(new Uint8Array(bytes)))
                    .catch(() => ''),
                  file.text().catch(() => '')
                ]);
                setOverwrite({
                  file,
                  path: `${path}/${file.name}`,
                  before,
                  after,
                  existingBytes: existing.sizeBytes,
                  binary: before.includes('\u0000') || after.includes('\u0000')
                });
                continue;
              }
              await api.writeFile(
                workspace.id,
                `${path}/${file.name}`,
                new Uint8Array(await file.arrayBuffer())
              );
            }
            await load();
          }}
        />
        <button className="icon-btn" aria-label="Refresh files" onClick={() => void load()}>
          <RefreshCw />
        </button>
      </div>
      {naming && (
        <form
          className="file-naming"
          onSubmit={(event) => {
            event.preventDefault();
            void submitName();
          }}
        >
          <label htmlFor="file-naming-input">
            {naming.entry ? `Rename ${naming.entry.name}` : 'New folder'}
          </label>
          <input
            id="file-naming-input"
            ref={nameInput}
            maxLength={255}
            value={naming.value}
            placeholder={naming.entry ? naming.entry.name : 'March reports'}
            onChange={(event) => setNaming({ ...naming, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNaming(undefined);
            }}
          />
          <button type="submit">{naming.entry ? 'Rename' : 'Create'}</button>
          <button type="button" className="secondary" onClick={() => setNaming(undefined)}>
            Cancel
          </button>
        </form>
      )}
      {uploadError && (
        <div className="form-error" role="alert">
          {uploadError}
        </div>
      )}
      {overwrite && (
        <div className="overwrite-choice">
          <strong>{overwrite.file.name} already exists here</strong>
          {overwrite.binary ? (
            <p>
              Replacing it swaps {formatBytes(overwrite.existingBytes)} for{' '}
              {formatBytes(overwrite.file.size)}. This file is not text, so there is nothing to
              compare line by line.
            </p>
          ) : (
            <DiffView path={overwrite.path} before={overwrite.before} after={overwrite.after} />
          )}
          <div className="modal-actions">
            <button className="secondary" onClick={() => setOverwrite(undefined)}>
              Cancel
            </button>
            <button
              className="secondary"
              onClick={async () => {
                const stem = overwrite.file.name.replace(/(\.[^.]+)?$/, '');
                const extension = overwrite.file.name.slice(stem.length);
                setOverwrite(undefined);
                try {
                  await api.writeFile(
                    workspace.id,
                    `${path}/${stem}-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}${extension}`,
                    new Uint8Array(await overwrite.file.arrayBuffer())
                  );
                  await load();
                } catch (cause) {
                  setUploadError(
                    cause instanceof Error ? cause.message : 'Could not save the file'
                  );
                }
              }}
            >
              Keep both
            </button>
            <button
              onClick={async () => {
                setOverwrite(undefined);
                try {
                  await api.writeFile(
                    workspace.id,
                    overwrite.path,
                    new Uint8Array(await overwrite.file.arrayBuffer())
                  );
                  await load();
                } catch (cause) {
                  setUploadError(
                    cause instanceof Error ? cause.message : 'Could not save the file'
                  );
                }
              }}
            >
              Replace
            </button>
          </div>
        </div>
      )}
      {/*
        A save is reviewed the same way an overwriting upload already is. Fixing a typo in a
        document the agent produced used to mean re-uploading a corrected copy or dropping into
        the terminal, and neither is a reasonable price for one character.
      */}
      {saveReview !== undefined && edit && (
        <div className="overwrite-choice">
          <strong>Save changes to {preview?.name}</strong>
          <DiffView path={edit.path} before={edit.text} after={saveReview} />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setSaveReview(undefined)}>
              Cancel
            </button>
            <button disabled={saving} onClick={() => void saveEdit(saveReview)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
      {preview ? (
        <div className="file-preview">
          <div className="preview-header">
            <FileCode2 />
            <strong>{preview.name}</strong>
            {preview.editable && edit && (
              <>
                <button
                  className="icon-btn"
                  aria-label={`Discard changes to ${preview.name}`}
                  title="Discard changes"
                  disabled={preview.text === edit.text}
                  onClick={() =>
                    setPreview((current) => (current ? { ...current, text: edit.text } : current))
                  }
                >
                  <RotateCcw />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Save ${preview.name}`}
                  title="Save (⌘S)"
                  disabled={preview.text === edit.text || saving}
                  onClick={() => setSaveReview(preview.text)}
                >
                  <Save />
                </button>
              </>
            )}
            <button
              className="icon-btn"
              aria-label={`Download ${preview.name}`}
              title="Download to this device"
              onClick={async () => {
                const href =
                  preview.url ??
                  URL.createObjectURL(new Blob([preview.text ?? ''], { type: 'text/plain' }));
                const anchor = document.createElement('a');
                anchor.href = href;
                anchor.download = preview.name;
                anchor.click();
                if (!preview.url) URL.revokeObjectURL(href);
              }}
            >
              <Download />
            </button>
            <button
              className="icon-btn"
              aria-label="Close file preview"
              onClick={() => setPreview(undefined)}
            >
              <X />
            </button>
          </div>
          {preview.url && preview.mime?.startsWith('image/') && (
            <img src={preview.url} alt={preview.name} />
          )}
          {preview.url && preview.mime?.startsWith('video/') && (
            <>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- User-owned files cannot be assumed to have captions; companion WebVTT tracks are loaded when present and absence is disclosed below. */}
              <video controls src={preview.url} aria-label={preview.name}>
                {preview.captionsUrl && (
                  <track
                    default
                    kind="captions"
                    src={preview.captionsUrl}
                    srcLang={preview.captionsLanguage}
                    label={`${preview.captionsLanguage?.toUpperCase()} captions`}
                  />
                )}
              </video>
              {!preview.captionsUrl && (
                <small className="caption-note">
                  No companion WebVTT caption file was found for this video.
                </small>
              )}
            </>
          )}
          {preview.text !== undefined &&
            (preview.editable && edit ? (
              <textarea
                className="file-editor"
                value={preview.text}
                spellCheck={false}
                aria-label={`Contents of ${preview.name}`}
                onChange={(event) =>
                  setPreview((current) =>
                    current ? { ...current, text: event.target.value } : current
                  )
                }
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault();
                    if (preview.text !== edit.text) setSaveReview(preview.text);
                  }
                }}
              />
            ) : (
              <pre>{preview.text}</pre>
            ))}
        </div>
      ) : loading ? (
        <div className="pane-loading">
          <LoaderCircle className="spin" /> Loading files
        </div>
      ) : listingError ? (
        <div className="empty-pane">
          <FolderOpen />
          <strong>{listingError}</strong>
          <span>Nothing was deleted — this device could not read the listing.</span>
          <button onClick={() => void load()}>Try again</button>
        </div>
      ) : (
        <div className="file-list">
          {entries
            .sort((a, b) =>
              a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
            )
            .map((entry) => (
              <div className="file-row" key={entry.path}>
                <button className="file-open" onClick={() => void open(entry)}>
                  {entry.type === 'directory' ? <Folder /> : <File />}
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.type === 'directory' ? 'Folder' : formatBytes(entry.sizeBytes)}
                    </small>
                  </span>
                </button>
                <button
                  className="icon-btn"
                  title="Rename"
                  aria-label={`Rename ${entry.name}`}
                  onClick={() => {
                    setUploadError('');
                    setNaming({ entry, value: entry.name });
                  }}
                >
                  <PencilLine />
                </button>
                <button
                  className="icon-btn"
                  title={entry.type === 'directory' ? 'Delete folder and contents' : 'Delete'}
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => {
                    // Removed from the list at once and from the disk a few seconds later, so the
                    // mistake costs one click rather than a restore from a recovery point.
                    setEntries((current) => current.filter((item) => item.path !== entry.path));
                    setNaming(undefined);
                    undo({
                      message: deletionMessage(entry),
                      commit: () => api.deleteFile(workspace.id, entry.path),
                      restore: () => void load()
                    });
                  }}
                >
                  <Trash2 />
                </button>
              </div>
            ))}
          {!entries.length && !listingError && (
            <div className="empty-pane">
              <FolderOpen />
              <strong>Nothing here yet</strong>
              <span>Files you send and files athanor makes both land here.</span>
            </div>
          )}
          {artifacts.length > 0 && (
            <div className="deliverable-library">
              <div>
                <p className="eyebrow">Saved results</p>
                <small>Fixed copies of finished work. The editable originals are above.</small>
              </div>
              {artifacts.slice(0, 30).map((artifact) => (
                <div className="deliverable-row" key={artifact.id}>
                  <File />
                  <span>
                    <strong>{artifact.name}</strong>
                    <small>
                      v{artifact.version} · {formatBytes(artifact.sizeBytes)} ·{' '}
                      {new Date(artifact.createdAt).toLocaleString()}
                    </small>
                  </span>
                  <a
                    href={`/v1/artifacts/${encodeURIComponent(artifact.id)}/content`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open this version"
                  >
                    <ExternalLink />
                  </a>
                  <button
                    title="Delete this fixed copy"
                    aria-label={`Delete ${artifact.name} version ${artifact.version}`}
                    onClick={() => {
                      setArtifacts((current) => current.filter((item) => item.id !== artifact.id));
                      undo({
                        message: `Deleted ${artifact.name} v${artifact.version}`,
                        commit: () => api.deleteArtifact(artifact.id),
                        restore: loadArtifacts
                      });
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What the private browser renders into, so a click on the page stream lands where it looks. */
const PAGE_VIEWPORT = { width: 1440, height: 900 };

/**
 * The agent computer: one screen, whoever is driving it.
 *
 * The browser is launched onto this same display, so a page the agent is reading, an editor it
 * opened and a challenge it cannot pass are all here, in the one view a person can already watch
 * and take over. The page stream is the fallback for a box with no desktop running, where it is
 * the only way left to reach a site by hand.
 */
function Computer({
  workspace,
  wall
}: {
  workspace: Workspace;
  /** The challenge the browser is sitting behind, from the conversation that hit it. */
  wall?: BotWall | undefined;
}) {
  const [desktop, setDesktop] = useState<DesktopSnapshot>();
  const [probe, setProbe] = useState<{ done: boolean; error: string }>({ done: false, error: '' });
  const [address, setAddress] = useState('');
  const [privateText, setPrivateText] = useState('');
  /** The wall the owner has already dealt with, so the banner goes when they say it is done. */
  const [handled, setHandled] = useState('');
  /** Whether this pane has taken the browser, and so has one to hand back. */
  const [browserHeld, setBrowserHeld] = useState(false);
  /*
   * Which view this is, decided once by the box rather than offered as a choice. `available` is
   * false only when the host has no GUI at all — the session itself starts on demand — and that is
   * the one case where the browser is headless and its own page stream is all there is to watch.
   */
  const kind: SurfaceKind | undefined =
    !probe.done || probe.error ? undefined : desktop?.available ? 'display' : 'page';
  const surface = useRemoteSurface(workspace.id, kind);
  const holder = surface.state?.holder ?? 'agent';
  /*
   * The stream's own answer wins where there is one: it is the newest wall from any tab, including
   * a background one, and it is null the moment the challenge clears. The conversation's copy is
   * the fallback, and the only source at all while the screen is being streamed rather than the
   * page — asking the browser for its state there would start a Chromium nobody asked for.
   */
  const liveWall = surface.state?.botWall ?? wall;
  const openWall = liveWall && liveWall.url !== handled ? liveWall : undefined;

  const look = () => {
    setProbe({ done: false, error: '' });
    void api
      .desktopSnapshot(workspace.id)
      .then((snapshot) => {
        setDesktop(snapshot);
        setProbe({ done: true, error: '' });
      })
      .catch((cause: unknown) => {
        setDesktop(undefined);
        setProbe({
          done: true,
          error: describeFailure(cause, 'The agent computer is not answering')
        });
      });
  };
  useEffect(() => {
    setHandled('');
    setAddress('');
    setBrowserHeld(false);
    look();
  }, [workspace.id]);

  const frameSize =
    kind === 'page'
      ? PAGE_VIEWPORT
      : {
          width: surface.state?.width ?? desktop?.width ?? PAGE_VIEWPORT.width,
          height: surface.state?.height ?? desktop?.height ?? PAGE_VIEWPORT.height
        };
  const clickFrame = async (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0 || holder !== 'user') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    await surface.send({
      type: 'click_at',
      x: Math.max(
        0,
        Math.min(frameSize.width, ((event.clientX - bounds.left) / bounds.width) * frameSize.width)
      ),
      y: Math.max(
        0,
        Math.min(
          frameSize.height,
          ((event.clientY - bounds.top) / bounds.height) * frameSize.height
        )
      ),
      button: 'left',
      clicks: 1
    });
  };
  const keyFrame = async (event: KeyboardEvent<HTMLButtonElement>) => {
    if (holder !== 'user' || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    await surface.send({ type: 'press', key: event.key === ' ' ? 'space' : 'Enter' });
  };
  const sendPrivateText = async () => {
    if (!privateText) return;
    const value = privateText;
    setPrivateText('');
    await surface.send({ type: 'text_input', text: value });
  };
  /*
   * Driving the browser somewhere is taking it: the agent cannot be mid-form on a page that just
   * moved out from under it. Opening a site by hand here is also how a one-time sign-in is done —
   * the browser profile is persistent, so what the owner logs into stays logged in afterwards.
   */
  const openAddress = async () => {
    const target = address.trim();
    if (!target) return;
    const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    try {
      await surface.setHolder('user');
      if (kind === 'display') await api.browserPrivateHolder(workspace.id, 'user');
      setBrowserHeld(true);
      await api.browserPrivateAction(workspace.id, { type: 'navigate', url });
    } catch (cause) {
      surface.setError(describeFailure(cause, 'That address did not open'));
    }
  };
  /*
   * The screen and the browser go back together, because on this box they are one window.
   *
   * The browser is only spoken to when it is known to be running and held — a challenge put it
   * there, or the address bar did. Otherwise handing the screen back would start a browser nobody
   * asked for. Handing it back is also the only thing that clears a challenge: no model action can.
   */
  const handBack = async () => {
    try {
      if (kind === 'page' || browserHeld || openWall)
        await (kind === 'page'
          ? surface.setHolder('agent')
          : api.browserPrivateHolder(workspace.id, 'agent'));
      if (kind === 'display' && holder !== 'agent') await surface.setHolder('agent');
      setBrowserHeld(false);
      setHandled(openWall?.url ?? '');
    } catch (cause) {
      surface.setError(describeFailure(cause, 'Could not hand the computer back'));
    }
  };
  const takeOver = async () => {
    await surface.setHolder('user');
  };
  /*
   * Taking over a challenge brings the stopped tab to the front, because it is very often not the
   * one on screen — the agent walked into it in a background tab and carried on elsewhere. A user
   * action is never refused by a wall, so this is the one navigation that always works.
   */
  const openStoppedTab = async () => {
    if (!openWall) return;
    try {
      await surface.setHolder('user');
      if (kind === 'display') await api.browserPrivateHolder(workspace.id, 'user');
      setBrowserHeld(true);
      if (openWall.tabId)
        await api.browserPrivateAction(workspace.id, {
          type: 'select_tab',
          tabId: openWall.tabId
        });
    } catch (cause) {
      surface.setError(describeFailure(cause, 'That page could not be brought to the front'));
    }
  };

  return (
    <div className="inspector-content browser-pane computer-pane">
      <div className="computer-toolbar">
        <span>
          <Monitor />
          <strong>
            {kind === 'page'
              ? surface.state?.title ||
                (surface.state?.url ? hostOf(surface.state.url) : 'Private browser')
              : surface.state?.activeApplication || desktop?.activeApplication || 'Agent computer'}
          </strong>
        </span>
        <small>
          {kind === 'page'
            ? 'Browser view · this host has no desktop'
            : desktop?.available
              ? `${desktop.windows.length} ${desktop.windows.length === 1 ? 'window' : 'windows'} open`
              : 'Nothing open yet'}
        </small>
      </div>
      <div className="browser-controls">
        <div className="address">
          <LockKeyhole />
          <input
            aria-label="Open a web address on this computer"
            placeholder="Open a website on this computer"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void openAddress();
            }}
          />
        </div>
        <button
          className="icon-btn"
          aria-label="Open this address"
          disabled={!address.trim()}
          onClick={() => void openAddress()}
        >
          <Play />
        </button>
      </div>
      {openWall && (
        <div className="wall-banner" role="alert">
          <ShieldAlert />
          <div>
            <strong>{hostOf(openWall.url)} is checking that a person is here</strong>
            <span>
              {openWall.vendor}
              {openWall.reason ? ` · ${openWall.reason}` : ''}
            </span>
            <small>
              athanor has left this page alone and is working elsewhere. Clear the check on the
              screen below, then hand the browser back. {botWallClearance(openWall)}
            </small>
          </div>
          <div className="wall-actions">
            <button onClick={() => void openStoppedTab()}>
              {holder === 'user' ? 'Show the page' : 'Take over'}
            </button>
            <button className="primary" onClick={() => void handBack()}>
              Done — hand back
            </button>
          </div>
        </div>
      )}
      <div className={`browser-viewport ${surface.frameUrl ? '' : 'loading'}`}>
        {surface.frameUrl || (kind === 'display' && desktop?.screenshotBase64) ? (
          <button
            type="button"
            className={`remote-frame-button ${holder === 'user' ? 'interactive' : ''}`}
            aria-disabled={holder !== 'user'}
            aria-label={
              holder === 'user'
                ? 'Interactive agent computer. Click a position, or press Enter or Space to activate the focused control.'
                : 'Live view of the agent computer. Take over below to interact.'
            }
            onClick={(event) => void clickFrame(event)}
            onKeyDown={(event) => void keyFrame(event)}
          >
            <img
              draggable={false}
              src={surface.frameUrl || `data:image/jpeg;base64,${desktop?.screenshotBase64 ?? ''}`}
              alt=""
            />
          </button>
        ) : holder === 'secure_input' ? (
          <div className="empty-pane">
            <LockKeyhole />
            <strong>Secure input is active</strong>
            <span>
              The stream and the accessibility tree are blacked out until you return control.
            </span>
          </div>
        ) : probe.error ? (
          <div className="empty-pane">
            <Monitor />
            <strong>{probe.error}</strong>
            <span>
              Run <code>sudo athanor doctor</code> on the server. It says which service is down.
            </span>
            <button onClick={look}>Try again</button>
          </div>
        ) : (
          <div className="empty-pane">
            <LoaderCircle className="spin" />
            <strong>{kind === 'page' ? 'Starting the browser' : 'Waking the screen'}</strong>
            <span>
              {kind === 'page'
                ? 'Its sign-ins and history stay on the agent computer.'
                : 'This takes a few seconds the first time.'}
            </span>
          </div>
        )}
        {surface.error && !probe.error && (
          <div className="browser-error">
            <strong>The computer needs attention</strong>
            <span>{surface.error}</span>
            {surface.stalled && <button onClick={surface.reconnect}>Try again</button>}
          </div>
        )}
        {kind && !probe.error && (
          <div className="browser-status">
            <span className={holder}>
              {holder === 'agent' ? <Bot /> : <UserRound />}
              {holder === 'agent'
                ? 'Agent has control'
                : holder === 'secure_input'
                  ? 'Secure input mode'
                  : 'You have control'}
            </span>
            <div>
              {holder === 'user' && (
                <button onClick={() => void surface.setHolder('secure_input')}>Secure input</button>
              )}
              <button
                onClick={() => void (holder === 'agent' ? takeOver() : handBack())}
                title={
                  holder === 'agent'
                    ? 'Drive this computer yourself. The agent stops touching it.'
                    : 'Give the screen and the browser back to the agent.'
                }
              >
                {holder === 'agent' ? 'Take over' : 'Return to agent'}
              </button>
            </div>
          </div>
        )}
      </div>
      {holder !== 'agent' && kind && (
        <>
          <div className={`browser-input ${holder === 'secure_input' ? 'secure' : ''}`}>
            <LockKeyhole />
            <input
              type={holder === 'secure_input' ? 'password' : 'text'}
              autoComplete="off"
              value={privateText}
              onChange={(event) => setPrivateText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void sendPrivateText();
              }}
              placeholder={
                holder === 'secure_input'
                  ? 'Type privately into the focused control'
                  : 'Type into the focused control'
              }
            />
            <button onClick={() => void sendPrivateText()}>Send</button>
            <button onClick={() => void surface.send({ type: 'press', key: 'Tab' })}>Tab</button>
            <button onClick={() => void surface.send({ type: 'press', key: 'Enter' })}>
              Enter
            </button>
            <button onClick={() => void surface.send({ type: 'press', key: 'Escape' })}>Esc</button>
          </div>
          {/* Only while it is true, and only where it explains the control right above it. */}
          <div className="browser-note">
            <LockKeyhole />
            {holder === 'secure_input'
              ? 'The view is blacked out and your keystrokes go straight to the page. The agent never sees them.'
              : 'What you type here goes to the screen and nowhere else.'}
          </div>
        </>
      )}
    </div>
  );
}

function TerminalPane({ workspace }: { workspace: Workspace }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      // xterm paints into a canvas, so without this a screen reader is handed a blank element and
      // everything the agent's shell prints - the one surface where the output *is* the content -
      // is silent. The option makes xterm keep its accessibility buffer and announce new lines.
      screenReaderMode: true,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#101214',
        foreground: '#e1e4e5',
        cursor: '#bac0c4',
        selectionBackground: '#34383b'
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    terminal.current = term;
    let socket: WebSocket | undefined;
    void api
      .terminalToken(workspace.id)
      .then(({ runnerUrl, token }) => {
        socket = new WebSocket(`${runnerUrl}/v1/workspaces/${workspace.id}/terminal`, [
          'athanor-capability',
          token
        ]);
        socket.onopen = () => term.writeln('\x1b[32mConnected to private agent computer\x1b[0m');
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; data?: string };
          if (message.type === 'data') term.write(message.data ?? '');
        };
        socket.onclose = () => term.writeln('\r\n\x1b[33mSession closed\x1b[0m');
        term.onData(
          (data) =>
            socket?.readyState === WebSocket.OPEN &&
            socket.send(JSON.stringify({ type: 'input', data }))
        );
        term.onResize(
          ({ cols, rows }) =>
            socket?.readyState === WebSocket.OPEN &&
            socket.send(JSON.stringify({ type: 'resize', cols, rows }))
        );
      })
      .catch((error) =>
        term.writeln(
          `\x1b[31m${error instanceof Error ? error.message : 'Connection failed'}\x1b[0m`
        )
      );
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      socket?.close();
      term.dispose();
    };
  }, [workspace.id]);
  return <div className="terminal-pane" ref={host} />;
}

function PreviewPane({ workspace }: { workspace: Workspace }) {
  const [previews, setPreviews] = useState<WorkspacePreview[]>([]);
  const undo = useUndo();
  const [port, setPort] = useState(3000);
  const [label, setLabel] = useState('App preview');
  const [activeUrl, setActiveUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () =>
    void api
      .previews(workspace.id)
      .then(setPreviews)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Could not load previews')
      );
  useEffect(() => {
    setActiveUrl('');
    load();
  }, [workspace.id]);
  const openPreview = async (preview: WorkspacePreview) => {
    setBusy(true);
    setError('');
    try {
      const launch =
        preview.visibility === 'public' ? preview : await api.previewAccess(preview.id);
      setActiveUrl(launch.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open preview');
    } finally {
      setBusy(false);
    }
  };
  // A dead button with no reason on it is the worst of both: this says which port to use instead.
  const portProblem = previewPortProblem(port);
  // No title card: the tab is called Preview and the form under it says what it does.
  return (
    <div className="inspector-content preview-pane">
      <div className="preview-create">
        <label>
          Name
          <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
        </label>
        {/* The port decides whether this works at all, so it is not hidden behind "Advanced". */}
        <label className="preview-port">
          Port
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !label.trim() || portProblem !== ''}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              // No lifetime is named here on purpose: a private preview lasts as long as the box
              // says it does, and the row below reports whatever that turns out to be.
              const created = await api.createPreview(workspace.id, { label, port });
              setPreviews((current) => [created, ...current]);
              setActiveUrl(created.url);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not expose this port');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Play /> {busy ? 'Opening…' : 'Open preview'}
        </button>
      </div>
      {portProblem && <p className="subtle">{portProblem}</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="preview-boundary">
        <LockKeyhole />
        <span>A preview cannot read your athanor session, even if its code tries.</span>
      </div>
      <div className="preview-list">
        {previews.map((preview) => (
          <div className={`preview-row ${preview.status}`} key={preview.id}>
            <div>
              <strong>{preview.label}</strong>
              {/* How long it lasts is the server's answer, not a promise made when it was made. */}
              <small>{previewSummary(preview)}</small>
            </div>
            <div className="preview-actions">
              <button
                title="Open preview"
                disabled={busy || preview.status !== 'active'}
                onClick={() => void openPreview(preview)}
              >
                <ExternalLink />
              </button>
              <button
                title={
                  preview.visibility === 'public'
                    ? 'Make private'
                    : 'Publish publicly · anyone with the URL can open it, and this asks for your passkey'
                }
                disabled={busy || preview.status !== 'active'}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await api.stepUp();
                    const updated =
                      preview.visibility === 'public'
                        ? await api.unpublishPreview(preview.id)
                        : await api.publishPreview(preview.id);
                    setPreviews((current) =>
                      current.map((item) => (item.id === updated.id ? updated : item))
                    );
                    setActiveUrl(updated.url);
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : 'Could not change visibility'
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {preview.visibility === 'public' ? <LockKeyhole /> : <Share2 />}
              </button>
              <button
                title={
                  preview.visibility === 'public'
                    ? 'Revoke this public link'
                    : 'Revoke this preview'
                }
                aria-label={`Revoke ${preview.label}`}
                disabled={busy || preview.status !== 'active'}
                onClick={() => {
                  setPreviews((current) => current.filter((item) => item.id !== preview.id));
                  if (activeUrl.startsWith(preview.url)) setActiveUrl('');
                  undo({
                    message: `Revoked “${preview.label}”${
                      preview.visibility === 'public' ? ' · the public URL stops working' : ''
                    }`,
                    commit: () => api.revokePreview(preview.id),
                    restore: load
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          </div>
        ))}
      </div>
      {activeUrl ? (
        <div className="preview-frame-wrap">
          <div>
            <span>{new URL(activeUrl).host}</span>
            <button onClick={() => window.open(activeUrl, '_blank', 'noopener,noreferrer')}>
              <ExternalLink /> Open tab
            </button>
          </div>
          {/*
            `allow-same-origin` is deliberately absent. The installer serves previews from the
            app's own origin (PREVIEW_BASE_URL is $public_url/__athanor/preview), so granting it
            alongside allow-scripts would let an agent-authored page reach `parent` and act with
            the owner's authenticated session — a demo app would hold the same authority as the
            client. Without it the frame gets an opaque origin: scripts still run, but the page
            cannot touch athanor, and it also has no cookies or localStorage of its own. An app
            that genuinely needs storage should be opened in its own tab, where it is a top-level
            document rather than a frame inside the authenticated client.
          */}
          <iframe
            src={activeUrl}
            title="Agent computer preview"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          />
        </div>
      ) : (
        <div className="empty-pane compact">
          <Globe2 />
          <strong>Nothing open</strong>
          <span>Pick a preview above, or ask athanor to start the app and open it for you.</span>
        </div>
      )}
    </div>
  );
}

export function Inspector({
  workspace,
  initialTab,
  wall,
  onTab
}: {
  workspace: Workspace | undefined;
  initialTab: Tab;
  /** The challenge the open conversation stopped at, so the screen can offer the way out of it. */
  wall?: BotWall | undefined;
  onTab?: (tab: Tab) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  // The row scrolls on a narrow phone, so the selected tab has to bring itself into view.
  useEffect(() => {
    document
      .getElementById(`inspector-tab-${tab}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  const select = (next: Tab) => {
    setTab(next);
    onTab?.(next);
  };
  // Arrow keys move between tabs, which is what a screen-reader user expects from a tablist and
  // what the roving tabIndex above is for: one stop in the tab order, arrows inside it.
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextTabIndex(event.key, tabIds.indexOf(tab), tabIds.length);
    const target = tabIds[next];
    if (!target) return;
    event.preventDefault();
    select(target);
    document.getElementById(`inspector-tab-${target}`)?.focus();
  };
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Computer tools">
        {inspectorTabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`inspector-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="inspector-panel"
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onKeyDown={moveTab}
            onClick={() => select(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
        className="inspector-panel"
      >
        {!workspace ? (
          <div className="empty-pane grow">
            <HardDrive />
            <strong>The agent computer is not answering</strong>
            <span>
              Run <code>sudo athanor doctor</code> on the server. It checks the file, browser and
              desktop services and says which one is down.
            </span>
          </div>
        ) : tab === 'files' ? (
          <Files workspace={workspace} />
        ) : tab === 'computer' ? (
          <Computer workspace={workspace} {...(wall ? { wall } : {})} />
        ) : tab === 'terminal' ? (
          <TerminalPane workspace={workspace} />
        ) : (
          <PreviewPane workspace={workspace} />
        )}
      </div>
    </aside>
  );
}
