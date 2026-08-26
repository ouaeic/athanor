import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  ArrowLeft,
  Bot,
  CircleStop,
  Download,
  File,
  FileCode2,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Minimize2,
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
import { api, ApiFailure } from './api.js';
import { deletionMessage, newFolderPath, renamedPath } from './file-actions.js';
import { nextTabIndex } from './focus-trap.js';
import { describeFailure } from './failure-text.js';
import { previewMime, readFilePreview, TEXT_PREVIEW_LIMIT } from './file-preview.js';
import { botWallClearance, formatBytes, hostOf } from './timeline-state.js';
import { previewPortProblem, previewSummary } from './preview-rows.js';
import {
  isLive,
  processCommand,
  processElapsed,
  processState,
  runningOrder
} from './running-rows.js';
import { advanceFrame, drainFrames, emptyFrameSlots, type FrameSlots } from './remote-frame.js';
import { inertOutside } from './inert-outside.js';
import { paneId } from './shortcuts.js';
import { fileLine, sortEntries, type FileOrder } from './file-rows.js';
import { capabilityDeadline, shouldRenew } from './session-renewal.js';
import { sessionEnd, type SessionClose } from './terminal-session.js';
import {
  canDecodeVideo,
  parseDisplayMessage,
  type DisplayVideoConfig
} from './display-protocol.js';
import {
  browserSnapshot,
  desktopLaunch,
  dragAction,
  DRAG_THRESHOLD_PX,
  framePassesThrough,
  dialogBanner,
  framePoint,
  heldFor,
  keyChord,
  movedPath,
  pointerAction,
  processLog,
  streamStalled,
  surfaceNotice,
  viewportMessage,
  wheelAction,
  type BrowserTabRow,
  type FramePoint
} from './inspector-api.js';
import { DiffView } from './DiffView.js';
import { useUndo } from './Undo.js';
import './inspector.css';
import type {
  Artifact,
  BackgroundProcess,
  BotWall,
  DesktopSnapshot,
  FileEntry,
  FileTarget,
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
/*
 * The fourth place is called Running, because that is what it now shows: the background processes
 * this computer has going, with the published addresses under them. It was called Preview and led
 * with a form asking the owner to guess a port.
 *
 * The identifier stays `preview`. It is not a private label - it is the stored value of the owner's
 * inspector preference, sent to the box and validated there (packages/contracts/src/index.ts), so
 * renaming it would refuse every device that has ever had this tab open until the owner clicked
 * something else. What the owner reads is the second element.
 */
const inspectorTabs = [
  ['files', 'Files'],
  ['computer', 'Computer'],
  ['terminal', 'Terminal'],
  ['preview', 'Running']
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
  /**
   * What the agent last did to this screen, in the sentence the approval card would have used.
   *
   * The runner has put it on every state frame since the display was written
   * (`services/workspace-runner/src/desktop.ts`) and nothing read it, so the only account of what
   * had just moved the pixels was the transcript, after the fact, once the tool result landed.
   */
  lastAction?: string;
  /** When control last changed hands, so the holder line can say how long it has been that way. */
  holderSince?: string;
  /**
   * The dialog holding this page, browser stream only.
   *
   * Parking a Playwright dialog suppresses its auto-dismiss, so the page is *blocked* until
   * something answers — and the native dialog never renders, because Playwright intercepted it.
   * An owner who took the browser over and clicked something raising `confirm()` watched the page
   * stop with nothing on screen to explain it and no way out but hibernating the browser.
   */
  pendingDialog?: { type: string; message: string } | null;
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
  /** Where decoded video lands. Only the computer surface uses it; the browser surface is JPEG. */
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  /**
   * A freshly configured decoder cannot start mid-GOP. Access units that arrive before the first
   * keyframe are dropped rather than fed in, because feeding them raises an error the viewer would
   * have to recover from for no gain - the next keyframe is along shortly.
   */
  const needKeyframeRef = useRef(true);
  /**
   * When a frame last reached the screen, and when the socket last said anything at all.
   *
   * The pair is the freeze detector; `streamStalled` (inspector-api.ts) carries the reasoning for
   * why it takes two marks rather than one. In short: an idle desktop legitimately sends nothing,
   * so silence is not evidence, and the freeze this pane actually had was the opposite of silence.
   */
  const lastPaintRef = useRef<number | undefined>(undefined);
  const lastSignalRef = useRef<number | undefined>(undefined);
  /**
   * The pane's way of publishing its own size the moment there is a socket to publish it down.
   *
   * A ref rather than a parameter because the size is measured where the picture is laid out and
   * the socket is opened here, and the two do not happen in a fixed order: a `ResizeObserver` that
   * fires before the handshake finishes would have its answer dropped, and the agent's screen would
   * stay at the boot resolution until the owner next dragged something.
   */
  const viewportRef = useRef<(() => void) | undefined>(undefined);
  /** True once video has actually painted, which is what decides whether the still is still shown. */
  const [painting, setPainting] = useState(false);
  useEffect(() => {
    if (!kind) return;
    const route = surfaceRoutes[kind];
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let stopped = false;
    let attempts = 0;

    /** A frame that has reached the screen, whichever transport carried it. See `streamStalled`. */
    const painted = (): void => {
      lastPaintRef.current = Date.now();
      setStalled(false);
    };

    const showJpeg = (data: ArrayBuffer): void => {
      const next = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
      const advanced = advanceFrame(framesRef.current, next);
      framesRef.current = advanced.slots;
      if (advanced.revoke) URL.revokeObjectURL(advanced.revoke);
      setFrameUrl(next);
      painted();
    };

    const paint = (frame: VideoFrame): void => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      // The runner may resize the display mid-session; the canvas follows rather than scaling.
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
      // Closing is not optional: a VideoFrame holds a decoder buffer, and leaking a few stalls the
      // whole pipeline rather than merely wasting memory.
      frame.close();
      setPainting(true);
      setError('');
      painted();
    };

    const configureDecoder = (config: DisplayVideoConfig): void => {
      if (!canDecodeVideo()) {
        setError('This browser cannot play the computer stream, so only the last still is shown.');
        return;
      }
      try {
        if (decoderRef.current && decoderRef.current.state !== 'closed') decoderRef.current.close();
      } catch {
        // A decoder that was already torn down is not a problem worth reporting.
      }
      try {
        const decoder = new VideoDecoder({
          output: paint,
          error: () => setError('The computer stream could not be decoded.')
        });
        decoder.configure({
          codec: config.codec,
          codedWidth: config.width,
          codedHeight: config.height,
          optimizeForLatency: true
        });
        decoderRef.current = decoder;
        needKeyframeRef.current = true;
      } catch {
        setError('This browser cannot play the codec the computer is sending.');
      }
    };

    const decodeVideo = (message: {
      keyframe: boolean;
      timestamp: number;
      payload: Uint8Array;
    }) => {
      const decoder = decoderRef.current;
      if (!decoder || decoder.state !== 'configured') return;
      if (needKeyframeRef.current) {
        if (!message.keyframe) return;
        needKeyframeRef.current = false;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: message.keyframe ? 'key' : 'delta',
            timestamp: message.timestamp,
            data: message.payload
          })
        );
      } catch {
        // One bad access unit should cost one frame, not the stream: wait for the next keyframe.
        needKeyframeRef.current = true;
      }
    };

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
        /*
         * What this viewer can take, said before the first frame is encoded.
         *
         * `session.codec` was fixed at `avc1` when the session was constructed and nothing ever
         * assigned it again, so the whole JPEG transport - which exists precisely for a browser
         * with no `VideoDecoder` - was unreachable, and such a viewer got one still photograph for
         * the life of the session with the takeover controls under it as though it were live. The
         * runner now reads this and re-syncs the encoder on the spot.
         */
        socket.onopen = () => {
          if (kind !== 'display') return;
          direct({ type: 'hello', canDecodeVideo: canDecodeVideo() });
          viewportRef.current?.();
        };
        socket.onmessage = (event) => {
          lastSignalRef.current = Date.now();
          if (event.data instanceof ArrayBuffer) {
            attempts = 0;
            // Two different wires behind one hook. The browser surface publishes Chromium's
            // screencast as bare JPEG bytes; the computer surface speaks `athanor.display.v1`,
            // where a type byte says whether this is a video configuration, an H.264 access unit
            // or a JPEG tile. Reading the framed one as a bare image is what painted the computer
            // black - and reading the bare one as framed would break the browser, which works.
            if (kind !== 'display') {
              showJpeg(event.data);
              setError('');
              return;
            }
            const message = parseDisplayMessage(event.data);
            if (message.kind === 'config') {
              configureDecoder(message.config);
              return;
            }
            if (message.kind === 'video') {
              decodeVideo(message);
              return;
            }
            if (message.kind === 'jpeg') {
              // `payload` is a view onto the socket's buffer; copy it so the Blob owns its bytes.
              showJpeg(message.payload.slice().buffer);
              setError('');
              return;
            }
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
      // Clear the src first and revoke a tick later. This cleanup does not only run on unmount: it
      // runs whenever the surface changes, which is every time the owner switches tab. Revoking
      // here and now killed the URL the element was still displaying, so the view went black and
      // stayed black until the new socket produced its first frame - a page appearing and then
      // vanishing. Letting the empty src commit first means the element has already let go.
      try {
        if (decoderRef.current && decoderRef.current.state !== 'closed') decoderRef.current.close();
      } catch {
        // Already gone.
      }
      decoderRef.current = null;
      needKeyframeRef.current = true;
      setPainting(false);
      const drained = drainFrames(framesRef.current);
      framesRef.current = drained.slots;
      setFrameUrl('');
      if (drained.revoke.length)
        setTimeout(() => {
          for (const url of drained.revoke) URL.revokeObjectURL(url);
        }, 0);
    };
  }, [workspaceId, kind, reconnectNonce]);

  /*
   * The watchdog that turns a frozen picture into something the owner can press.
   *
   * Recovery was already built and was shown only on `error || stalled`. Neither is set when the
   * stream stops delivering pixels down a socket that is otherwise healthy, so the one case where
   * the pane is a photograph of the agent's screen from some seconds ago was exactly the case with
   * no error, no spinner and no button. This is the missing half: it sets `stalled`, and the
   * existing "Try again" appears.
   */
  useEffect(() => {
    if (!kind) return;
    lastPaintRef.current = undefined;
    lastSignalRef.current = undefined;
    const timer = window.setInterval(() => {
      if (
        streamStalled(
          { lastPaintAt: lastPaintRef.current, lastSignalAt: lastSignalRef.current },
          Date.now()
        )
      )
        setStalled(true);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [kind, workspaceId, reconnectNonce]);

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
    canvasRef,
    painting,
    state,
    error,
    stalled,
    send,
    setHolder,
    setError,
    viewportRef,
    /** Anything that is not an action or a handover: the `hello`, and the viewport this pane is. */
    sendMessage: direct,
    reconnect: () => {
      setStalled(false);
      setError('');
      /*
       * The decoder is what was stuck, so the decoder is what has to be let go of.
       *
       * Without this the reconnect opened a new socket into a `needKeyframeRef` still holding
       * `false` from the session before it, and the first access unit of the new stream - which is
       * a delta, because the encoder's GOP is infinite - was fed to a decoder that had never seen
       * its keyframe. Pressing "Try again" produced the same frozen picture, which is the worst
       * possible answer to a recovery control.
       */
      needKeyframeRef.current = true;
      lastPaintRef.current = undefined;
      lastSignalRef.current = undefined;
      setReconnectNonce((current) => current + 1);
    }
  };
}

function Files({
  workspace,
  taskIsActive,
  target
}: {
  workspace: Workspace;
  taskIsActive: boolean;
  /** One file the transcript asked to be shown here, stamped so the same one can be asked twice. */
  target?: FileTarget;
}) {
  const [path, setPath] = useState('workspace');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  /*
   * The order follows the work until the owner says otherwise - the same bargain the panel itself
   * makes with the tab it is showing (App.tsx `shownInspectorTab`).
   *
   * While the agent is working, the question this pane is open to answer is "what did it just
   * make", and alphabetical order buries that among everything that was already there. Once the
   * owner picks an order it is theirs and nothing takes it back.
   */
  const [chosenOrder, setChosenOrder] = useState<FileOrder>();
  const order = chosenOrder ?? (taskIsActive ? 'recent' : 'name');
  /* Read once for the whole list, so forty rows cannot disagree about what "now" is. */
  const nowMs = Date.now();
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{
    name: string;
    text?: string;
    url?: string;
    /**
     * The file itself, as it arrived.
     *
     * Download used to rebuild the file out of `text`, which is a decoded, truncated string - so a
     * PDF, a zip or a photo came back with every byte the decoder could not read replaced by U+FFFD
     * and everything past two million characters missing, and the copy on the owner's device was
     * quietly not their file. Kept separately from `url` so a video still gets a typed blob to play
     * from while the download stays byte-exact.
     */
    downloadUrl?: string;
    mime?: string;
    captionsUrl?: string;
    captionsLanguage?: string;
    editable?: boolean;
    path?: string;
    sizeBytes?: number;
    /** Why what is on screen is not the whole file, or not editable, when it is not. */
    reason?: 'binary' | 'truncated' | 'read_only';
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
  /**
   * The digest of what was read, which is what a save claims it is replacing.
   *
   * Without it the later write won in silence: the owner saving a file the agent was part-way
   * through writing discarded that work with nothing anywhere recording that it had, and the pane
   * defaults to Recent order *because* the agent is working, so this is the ordinary case rather
   * than the edge. Null for a windowed read — see `open`.
   */
  const [readSha, setReadSha] = useState<string | null>(null);
  /** Which lines of a file too large to hold are on screen, and where the next of them start. */
  const [fileWindow, setFileWindow] = useState<{
    startLine: number;
    endLine: number;
    totalLines: number | null;
    nextStartLine: number | null;
  }>();
  /** The file the pager is paging, kept so "next" knows what it is reading more of. */
  const [windowEntry, setWindowEntry] = useState<FileEntry>();
  const [saving, setSaving] = useState(false);
  /** The edited text, held until the owner has seen the diff their save would apply. */
  const [saveReview, setSaveReview] = useState<string>();
  /** One inline form at a time: a new folder here, or a new name for one entry. */
  const [naming, setNaming] = useState<{ entry?: FileEntry; value: string }>();
  /** The entry being moved into another folder, and the folder chosen for it. */
  const [moving, setMoving] = useState<FileEntry>();
  const [moveTo, setMoveTo] = useState('');
  /*
   * Finished results are files too, so they live with the files rather than in a pane of their own.
   * They are fixed copies with a version each, which is why they are listed apart from the tree the
   * agent is still working in — and why deleting one is the only way to get its bytes back.
   */
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  /**
   * Whether the saved results simply could not be read.
   *
   * An empty array meant both "you have none" and "this device could not ask", and the section is
   * only drawn when the array has something in it - so a failed load looked exactly like a clean
   * workspace. The owner had no way to tell that their finished work was still there.
   */
  const [artifactsUnavailable, setArtifactsUnavailable] = useState(false);
  /**
   * The saved result the transcript sent the owner here to see.
   *
   * A fixed copy has no path in the tree — its bytes live under a storage key — so "open it at that
   * file" can only mean the row in the library below. Held rather than scrolled-to-and-forgotten
   * because thirty rows all look alike and the owner arrived looking for one of them.
   */
  const [markedArtifact, setMarkedArtifact] = useState('');
  /** A file the transcript pointed at that the agent has since moved or deleted. */
  const [missingFile, setMissingFile] = useState('');
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
    api
      .artifacts(workspace.id)
      .then((next) => {
        setArtifacts(next);
        setArtifactsUnavailable(false);
      })
      .catch(() => {
        setArtifacts([]);
        setArtifactsUnavailable(true);
      });
  useEffect(() => {
    void load('workspace');
    void loadArtifacts();
  }, [workspace.id]);
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
      if (preview?.captionsUrl) URL.revokeObjectURL(preview.captionsUrl);
      /*
       * Revoked when the preview is replaced or the pane goes, never in the click that started the
       * download. Some browsers treat a synchronous revoke after `anchor.click()` as the transfer
       * being withdrawn and drop the file - which is the same complaint as a corrupted copy, from
       * the other end.
       */
      // A window's download is a route rather than an object URL; there is nothing to revoke.
      if (preview?.downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(preview.downloadUrl);
    },
    [preview?.url, preview?.captionsUrl, preview?.downloadUrl]
  );
  /*
   * `listing` is the folder this file was found in, and it defaults to what is on screen because
   * that is where a click comes from. It is passed explicitly when the pane was pointed at a file
   * by the transcript: the listing was fetched moments earlier and React has not committed it yet,
   * so reading `entries` there would search the folder the owner was looking at before, and a video
   * opened that way would silently lose its companion captions.
   */
  const open = async (entry: FileEntry, listing: FileEntry[] = entries, startLine?: number) => {
    if (entry.type === 'directory') return load(entry.path);
    setListingError('');
    /*
     * A window when the file is too big to hold, the whole of it otherwise.
     *
     * The runner has read line ranges under a byte budget all along and answers with where the
     * window starts and ends, how many lines there are and where to resume - and this pane could
     * only ever ask for everything, so a large log was two million characters cut off mid-line with
     * "download it for the whole file" as the only way on. The agent has known how much it did not
     * read since the tool was written; the owner did not.
     */
    const paged =
      startLine !== undefined || (entry.sizeBytes > TEXT_PREVIEW_LIMIT && !previewMime(entry.name));
    const read = await api
      .readFile(
        workspace.id,
        entry.path,
        paged ? { startLine: startLine ?? 1, maxBytes: TEXT_PREVIEW_LIMIT } : {}
      )
      .catch((cause: unknown) => {
        // Clicking a file used to do nothing whatsoever when the runner was unavailable.
        setListingError(describeFailure(cause, `Couldn’t open ${entry.name}`));
        return undefined;
      });
    if (!read) return;
    const bytes = read.bytes;
    /*
     * What was on disk at the moment of the read, kept so the save can claim it.
     *
     * Null for a windowed read, deliberately: the runner computes the digest over what it read,
     * and a digest of lines 40-80 is not a claim about the file. A window is therefore never
     * editable here, which is also why the pager below renders read-only.
     */
    setReadSha(read.sha256);
    setWindowEntry(paged ? entry : undefined);
    setFileWindow(
      paged
        ? {
            startLine: read.startLine ?? startLine ?? 1,
            endLine: read.endLine ?? 0,
            totalLines: read.totalLines,
            nextStartLine: read.truncated ? read.nextStartLine : null
          }
        : undefined
    );
    /*
     * The file as it arrived, before anything decodes or truncates it. Every branch below carries
     * this through to the download, so what lands on the owner's device is what is on the server.
     *
     * A window is the one case where the bytes in hand are not the file, so it gets the route
     * itself rather than a blob of the slice: downloading "the whole file" and receiving lines
     * 1-8,000 of it would be the same silent substitution the decoded-string download used to be.
     */
    const downloadUrl = paged
      ? `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(entry.path)}`
      : URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const shown = readFilePreview(entry.name, bytes);
    // The size of the file, not of the window: `x-file-bytes` is what the runner read it from,
    // and reporting the slice as though it were the whole is how a pane starts misinforming.
    const common = {
      name: entry.name,
      downloadUrl,
      sizeBytes: read.fileBytes ?? bytes.byteLength
    };
    if (shown.kind === 'media') {
      const stem = entry.name.replace(/\.[^.]+$/, '');
      const captionEntry = shown.mime.startsWith('video/')
        ? listing.find(
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
        ...common,
        url: URL.createObjectURL(new Blob([bytes], { type: shown.mime })),
        mime: shown.mime,
        ...(captionBytes
          ? {
              captionsUrl: URL.createObjectURL(new Blob([captionBytes], { type: 'text/vtt' })),
              captionsLanguage: language
            }
          : {})
      });
      setEdit(undefined);
      return;
    }
    if (shown.kind === 'binary') {
      setPreview({ ...common, reason: 'binary' });
      setEdit(undefined);
      return;
    }
    setPreview({
      ...common,
      text: shown.text,
      // A window is never editable, whatever its size: saving it would write those lines over the
      // whole file and silently drop everything outside the window that was just read.
      editable: !paged && shown.editableText !== undefined,
      path: entry.path,
      ...(paged ? { reason: 'read_only' as const } : shown.reason ? { reason: shown.reason } : {})
    });
    setEdit(
      paged || shown.editableText === undefined
        ? undefined
        : { path: entry.path, text: shown.editableText }
    );
  };

  /**
   * The pane, pointed at one file the owner clicked on in the conversation.
   *
   * Its folder first, then the file, because a preview with no listing behind it leaves the owner
   * nowhere to go when they close it. A file the agent has since moved or deleted says so on the
   * pane's own error line rather than opening the wrong thing or nothing at all.
   */
  const openAt = async (asked: string) => {
    /*
     * Where the file actually landed, which is not always where the model said to put it.
     *
     * The runner resolves a bare or relative name under `workspace/`
     * (`assertUserDataPath`, services/workspace-runner/src/files.ts), and the transcript carries
     * the argument the model wrote rather than the path the write resolved to. `file_write` with
     * `notes.md` - which the tool's own schema invites - therefore arrives here as `notes.md` and
     * would be looked for in a listing where every entry is `workspace/notes.md`, sending the
     * owner to "not on the agent computer any more" about a file sitting in the folder that was
     * just listed. Same rule as the worker applies before it spends anything on a generation.
     */
    const wanted =
      asked.startsWith('workspace/') || asked.startsWith('.athanor/')
        ? asked
        : `workspace/${asked}`;
    const folder = wanted.slice(0, wanted.lastIndexOf('/')) || 'workspace';
    setLoading(true);
    setNaming(undefined);
    setMissingFile('');
    try {
      const listing = (await api.files(workspace.id, folder)).entries;
      setEntries(listing);
      setPath(folder);
      setPreview(undefined);
      setEdit(undefined);
      setListingError('');
      const entry = listing.find((item) => item.path === wanted);
      if (!entry) {
        /*
         * A banner over the folder, not the pane's listing-failure state.
         *
         * That state replaces the whole listing with "this device could not read the listing",
         * which here would be a false statement about a listing that was just read successfully -
         * and it would take away the folder the file used to be in, which is the one useful thing
         * left to show someone whose file the agent has since moved or deleted.
         */
        setMissingFile(`${wanted} is not on the agent computer any more.`);
        return;
      }
      await open(entry, listing);
    } catch (cause) {
      setEntries([]);
      setListingError(describeFailure(cause, `Couldn’t open ${wanted}`));
    } finally {
      setLoading(false);
    }
  };
  /*
   * The transcript asking for a file, obeyed once per ask.
   *
   * Keyed on the stamp rather than on the request, so clicking the same file twice - after the
   * owner has wandered off into another folder in between - moves the pane both times.
   */
  const askedFor = target?.nonce;
  useEffect(() => {
    if (!target) return;
    if ('artifactId' in target) {
      // A fixed copy lives in the library under the listing, so the listing has to be what is on
      // screen for it to be reachable at all.
      setPreview(undefined);
      setMissingFile('');
      setMarkedArtifact(target.artifactId);
      // Refetched because the artifact the owner just clicked was published seconds ago, after this
      // pane last asked - the commonest case for this button is the card at the end of a turn.
      void loadArtifacts();
      return;
    }
    setMarkedArtifact('');
    void openAt(target.path);
  }, [askedFor]);
  /*
   * Brought into view once the row exists, which is a render later than the request when the
   * library had to be refetched to find it.
   */
  useEffect(() => {
    if (markedArtifact)
      document
        .getElementById(`artifact-row-${markedArtifact}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [markedArtifact, artifacts]);

  /** The file goes back through the same diff an overwriting upload already has to pass. */
  const saveEdit = async (next: string) => {
    if (!edit) return;
    setSaving(true);
    setUploadError('');
    try {
      /*
       * The claim about what is being replaced, checked by the runner under the write's own
       * descriptor. On a collision it answers `file_changed` with a sentence written for a person,
       * which `describeFailure` puts on the pane - and the file is re-read, so what is on screen
       * afterwards is the agent's version rather than a save that quietly won.
       */
      await api.writeFile(
        workspace.id,
        edit.path,
        new TextEncoder().encode(next),
        readSha ?? undefined
      );
      setEdit({ path: edit.path, text: next });
      setPreview((current) => (current ? { ...current, text: next } : current));
      setSaveReview(undefined);
    } catch (cause) {
      setUploadError(describeFailure(cause, 'Could not save this file'));
      if (cause instanceof ApiFailure && cause.code === 'file_changed') {
        const entry = entries.find((item) => item.path === edit.path);
        if (entry) await open(entry);
      }
    } finally {
      setSaving(false);
    }
  };
  /*
   * The thirty most recent, and the one that was asked for.
   *
   * The list has always been capped, which is fine for browsing and wrong for arriving: a card from
   * a conversation a fortnight old sends the owner to a library where its own row was cut off, and
   * the pane would have said nothing about why. The asked-for row goes first, where they are looking.
   */
  const recentArtifacts = artifacts.slice(0, 30);
  const askedArtifact =
    markedArtifact && !recentArtifacts.some((item) => item.id === markedArtifact)
      ? artifacts.find((item) => item.id === markedArtifact)
      : undefined;
  const listedArtifacts = askedArtifact ? [askedArtifact, ...recentArtifacts] : recentArtifacts;
  const parent = path.split('/').slice(0, -1).join('/') || 'workspace';
  /*
   * Where a file can be moved to from here: the folders in this listing, and the one above.
   *
   * Offered rather than typed, so a destination is always a folder that exists and no path leaves
   * the workspace. A listing with neither is a listing with nowhere to move to, and the control
   * does not appear.
   */
  const moveTargets = [
    ...(path === 'workspace' ? [] : [parent]),
    ...entries.filter((entry) => entry.type === 'directory').map((entry) => entry.path)
  ];
  const submitMove = async () => {
    if (!moving) return;
    const target = moveTo || moveTargets[0];
    if (!target) return;
    const result = movedPath(moving, target);
    if (!result.ok) {
      setUploadError(result.message);
      return;
    }
    setUploadError('');
    try {
      await api.renameFile(workspace.id, moving.path, result.path);
      setMoving(undefined);
      await load();
    } catch (cause) {
      // The runner refuses a collision rather than overwriting, which is the answer worth showing.
      setUploadError(describeFailure(cause, `${moving.name} could not be moved`));
    }
  };
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
            const failed: string[] = [];
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
              /*
               * One failure must not take the rest of the selection with it.
               *
               * This loop had no catch: a write that threw on the second of five files abandoned
               * the other three, and skipped the reload below - so the list did not even show what
               * had landed. The error was cleared when the upload started and nothing set it
               * again, so the owner was left with a folder that had quietly half-changed.
               */
              try {
                await api.writeFile(
                  workspace.id,
                  `${path}/${file.name}`,
                  new Uint8Array(await file.arrayBuffer())
                );
              } catch {
                failed.push(file.name);
              }
            }
            if (failed.length)
              setUploadError(
                failed.length === 1
                  ? `${failed[0]} could not be uploaded. Everything else was.`
                  : `${failed.length} files could not be uploaded: ${failed.join(', ')}. Everything else was.`
              );
            // Always, so the list reflects whatever actually landed rather than the selection.
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
              if (event.key !== 'Escape') return;
              // Consumed, or the same keystroke also reaches the window shortcut that stops the
              // running agent - backing out of naming a folder would quietly cancel the work.
              event.stopPropagation();
              setNaming(undefined);
            }}
          />
          <button type="submit">{naming.entry ? 'Rename' : 'Create'}</button>
          <button type="button" className="secondary" onClick={() => setNaming(undefined)}>
            Cancel
          </button>
        </form>
      )}
      {(uploadError || missingFile) && (
        <div className="form-error" role="alert">
          {uploadError || missingFile}
        </div>
      )}
      {/*
        A banner rather than a branch of the chain below.

        The failed-listing state was only rendered as one arm of the ternary that also decides
        between a preview, the loading state and the list - and the preview is tested first. So
        Refresh, or Up one folder, while a file was open did nothing at all, at every path: the
        request failed, the message was set, and nothing on screen could show it.
      */}
      {listingError && preview && (
        <div className="form-error" role="alert">
          {listingError}
          <button className="link-button" onClick={() => void load()}>
            Try again
          </button>
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
      {/*
        Three orders, and no control at all until there is something to reorder.

        Name is the listing; Size answers the storage banner that sends the owner here and has no
        other way to say what is eating the disk; Recent answers what the agent has just done. They
        are three buttons rather than a select because there are three of them and the current one
        has to be readable without opening anything.
      */}
      {!preview && !loading && !listingError && entries.length > 1 && (
        <div className="file-sort" role="group" aria-label="Order">
          {(
            [
              ['name', 'Name'],
              ['size', 'Size'],
              ['recent', 'Recent']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={order === id ? 'active' : ''}
              aria-pressed={order === id}
              onClick={() => setChosenOrder(id)}
            >
              {label}
            </button>
          ))}
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
            {/*
              The same verb, the same icon and the same place in the row as the card in the
              conversation: show it, open it full size, take a copy. The pane bounds a picture or a
              clip to the space it has, exactly as the transcript does, and until now it was the one
              of the two with no way out of that bound.
            */}
            {preview.url && (
              <a
                className="icon-btn"
                href={preview.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${preview.name} at full size`}
                title="Open at full size"
              >
                <ExternalLink />
              </a>
            )}
            <button
              className="icon-btn"
              aria-label={`Download ${preview.name}`}
              title="Download to this device"
              onClick={() => {
                // Always the bytes that arrived, never a rebuild from what is on screen.
                const anchor = document.createElement('a');
                anchor.href = preview.downloadUrl ?? preview.url ?? '';
                anchor.download = preview.name;
                anchor.click();
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
          {/* Both facts are known where the decision is made, and neither was ever said. */}
          {preview.reason && (
            <p className="preview-disclosure">
              {preview.reason === 'binary'
                ? `This file is not text — ${formatBytes(preview.sizeBytes ?? 0)}. Download it to open it on this device.`
                : preview.reason === 'truncated'
                  ? `Showing the first 2 MB of ${formatBytes(preview.sizeBytes ?? 0)}. Download it for the whole file.`
                  : `Too large to edit here — ${formatBytes(preview.sizeBytes ?? 0)}. Use the terminal, or download it.`}
            </p>
          )}
          {/*
            Which lines these are, and the way to the next of them. The pane used to say only that
            it had been cut short, which told the owner they had lost something and nothing about
            how to reach it.
          */}
          {fileWindow && windowEntry && (
            <div className="file-window">
              <span>
                Lines {fileWindow.startLine.toLocaleString()}–{fileWindow.endLine.toLocaleString()}
                {fileWindow.totalLines === null
                  ? ''
                  : ` of ${fileWindow.totalLines.toLocaleString()}`}
              </span>
              {fileWindow.startLine > 1 && (
                <button onClick={() => void open(windowEntry, entries, 1)}>
                  Back to the start
                </button>
              )}
              {fileWindow.nextStartLine !== null && (
                <button
                  onClick={() => void open(windowEntry, entries, fileWindow.nextStartLine ?? 1)}
                >
                  Next lines
                </button>
              )}
            </div>
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
          {moving && (
            <div className="file-window" role="group" aria-label={`Move ${moving.name}`}>
              <span>Move “{moving.name}” to</span>
              <select
                aria-label="Destination folder"
                value={moveTo}
                onChange={(event) => setMoveTo(event.target.value)}
              >
                {moveTargets.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder.replace(/^workspace\/?/, '') || 'Files'}
                  </option>
                ))}
              </select>
              <button onClick={() => void submitMove()}>Move</button>
              <button onClick={() => setMoving(undefined)}>Cancel</button>
            </div>
          )}
          {sortEntries(entries, order).map((entry) => (
            <div className="file-row" key={entry.path}>
              <button className="file-open" onClick={() => void open(entry)}>
                {entry.type === 'directory' ? <Folder /> : <File />}
                <span>
                  <strong>{entry.name}</strong>
                  {/* This used to read "Folder" beside a folder icon, or a size with nothing to
                      say whether the file was written a minute ago or last March. */}
                  <small>{fileLine(entry, nowMs)}</small>
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
              {/*
                Moving, which the route has always done and the client always refused.

                `renameWorkspaceEntry` resolves an arbitrary destination and mkdirs its parent - a
                full move - and `renamedPath` replaces the last segment and rejects any slash,
                which is right for renaming in place and was the whole of what the owner had. So
                twenty files the agent dropped in the wrong folder could only be tidied through the
                terminal. A folder is named rather than a path, so nothing here addresses a file by
                hand.
              */}
              {moveTargets.length > 0 && (
                <button
                  className="icon-btn"
                  title="Move to another folder"
                  aria-label={`Move ${entry.name}`}
                  onClick={() => {
                    setUploadError('');
                    setNaming(undefined);
                    setMoving(entry);
                  }}
                >
                  <FolderOpen />
                </button>
              )}
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
          {artifactsUnavailable && (
            <div className="deliverable-library">
              <div>
                <p className="eyebrow">Saved results</p>
                <small>
                  This device could not read them just now. Nothing was deleted — they are on the
                  agent computer.
                </small>
              </div>
            </div>
          )}
          {artifacts.length > 0 && (
            <div className="deliverable-library">
              <div>
                <p className="eyebrow">Saved results</p>
                <small>Fixed copies of finished work. The editable originals are above.</small>
              </div>
              {listedArtifacts.map((artifact) => (
                <div
                  className={`deliverable-row${artifact.id === markedArtifact ? ' marked' : ''}`}
                  id={`artifact-row-${artifact.id}`}
                  key={artifact.id}
                >
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
  visible,
  wall
}: {
  workspace: Workspace;
  /**
   * Whether this pane is the one on screen.
   *
   * The panes are all mounted at once now, so that switching tab stops killing what is running in
   * the one being left. Mounted is not the same as watched: a video stream nobody can see is a
   * decoder, a socket and a few hundred kilobytes a second of somebody's connection spent painting
   * a canvas inside `display: none`. This is what stops that.
   */
  visible: boolean;
  /** The challenge the browser is sitting behind, from the conversation that hit it. */
  wall?: BotWall | undefined;
}) {
  const [desktop, setDesktop] = useState<DesktopSnapshot>();
  const [probe, setProbe] = useState<{ done: boolean; error: string }>({ done: false, error: '' });
  const [address, setAddress] = useState('');
  /** The name of a program to start, resolved against the session's PATH by the runner. */
  const [program, setProgram] = useState('');
  const [privateText, setPrivateText] = useState('');
  /** The wall the owner has already dealt with, so the banner goes when they say it is done. */
  const [handled, setHandled] = useState('');
  /** Whether this pane has taken the browser, and so has one to hand back. */
  const [browserHeld, setBrowserHeld] = useState(false);
  /*
   * Which view this is, decided once by the box rather than offered as a choice. `available` is
   * false only when the host has no GUI at all — the session itself starts on demand — and that is
   * the one case where the browser is headless and its own page stream is all there is to watch.
   *
   * `undefined` is `useRemoteSurface`'s "do not connect": its effect returns before opening
   * anything, and the cleanup that runs on the way to it closes the socket and the decoder. So
   * dropping to `undefined` while the pane is off screen is the whole of the teardown, and coming
   * back re-runs the effect and re-opens the stream.
   */
  const kind: SurfaceKind | undefined = !visible
    ? undefined
    : !probe.done || probe.error
      ? undefined
      : desktop?.available
        ? 'display'
        : 'page';
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

  /*
   * Asks; it does not blank first.
   *
   * `probe.done` is one of the things `kind` is computed from, and `kind` is what holds the stream
   * open. Clearing it at the top of every ask meant coming back to this tab opened a socket from
   * the answer already in hand, closed it one render later when the refresh cleared that answer,
   * and opened a third when the same answer came back - three connections and two teardowns for a
   * tab switch. What is on screen stays until there is something truer to put there.
   */
  const look = () => {
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
  // A different computer is a different question, so everything this pane was part-way through
  // goes, including the answer about whether there is a screen at all.
  useEffect(() => {
    setHandled('');
    setAddress('');
    setBrowserHeld(false);
    setProbe({ done: false, error: '' });
  }, [workspace.id]);
  // Asked when the pane is actually being looked at, and again each time it is come back to: the
  // snapshot decides whether there is a screen, and it goes stale the moment the agent opens or
  // closes a window, which is most of what happens while this pane is not the one on top.
  useEffect(() => {
    if (!visible) return;
    look();
  }, [workspace.id, visible]);

  /*
   * The stream's own answer first, on both surfaces.
   *
   * The page surface used to map clicks against `PAGE_VIEWPORT` unconditionally - a hard-coded
   * fourth copy of the runner's `BROWSER_VIEWPORT`, and the one `scripts/check-repository.mjs`
   * did not police. The two numbers agree today, so nothing was wrong; the day anyone changed the
   * runner's viewport every human click would have landed proportionally off with nothing failing.
   * The browser publishes its width and height on every state frame, so the constant is now only
   * the answer before the first frame arrives - and the copy is held against the runner's
   * declaration by `check-repository.mjs`, so the two can no longer part company quietly.
   *
   * `||` and not `??`: a host with no desktop answers the snapshot with a width of zero, and zero
   * is a number, so `??` would have kept it and divided every click by nothing.
   */
  const frameSize = {
    width: surface.state?.width || desktop?.width || PAGE_VIEWPORT.width,
    height: surface.state?.height || desktop?.height || PAGE_VIEWPORT.height
  };
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  /**
   * Expanding is ours; real full screen is a bonus on top of it.
   *
   * `requestFullscreen` is refused in more places than it is documented to be - an embedded view, a
   * policy, a browser that wants a different kind of gesture - and it was measured being refused
   * here on a genuine click. Depending on it would mean the owner presses the button and nothing
   * happens, silently, which is the failure this pane has already had enough of. So the pane
   * maximises itself over the window first, which cannot fail, and the native call is attempted
   * afterwards for the people whose browser allows it.
   */
  useEffect(() => {
    if (!expanded) return;
    /*
     * Taken in the capture phase, and consumed.
     *
     * `windowShortcut` maps Escape to stop-agent while the agent is working (shortcuts.ts), and it
     * listens on the window in the bubble phase. A bubble listener of our own would fire alongside
     * it, so leaving full screen also stopped the running task - one keystroke, two meanings, the
     * destructive one silent. Capture on the document runs before the window's bubble listener, so
     * stopping propagation here means Escape closes the overlay and does nothing else.
     */
    // `KeyboardEvent` is React's in this file; this listener is on the document, so it wants the DOM one.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setExpanded(false);
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    // Nothing behind the expanded view is reachable while it is up - the same containment `Dialog`
    // has always had, which this pane was drawn over the whole window without.
    const releaseInert = paneRef.current ? inertOutside(paneRef.current) : undefined;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      releaseInert?.();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [expanded]);
  const toggleExpanded = async (): Promise<void> => {
    const next = !expanded;
    setExpanded(next);
    try {
      if (next) await paneRef.current?.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Refused. The pane is already maximised over the window, so there is nothing to report and
      // nothing for the owner to do differently.
    }
  };

  const frameRef = useRef<HTMLButtonElement | null>(null);
  /*
   * The wheel, and the size of the hole the screen is being watched through.
   *
   * Both are attached by hand rather than through React's props. `onWheel` is registered on the
   * root as a passive listener, so `preventDefault` inside it does nothing and the panel scrolls
   * under the pointer while the agent's screen sits still - the gesture would have gone to the
   * wrong screen, silently. And the size has to be published on the socket rather than rendered:
   * `DesktopManager.resize` has existed as long as the display has and had exactly one caller,
   * a subscriber field no route ever set, so every agent computer has been 1280x800 whatever it
   * was being watched on. A person taking over to read something was reading an upscale.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !kind) return;
    const onWheel = (event: globalThis.WheelEvent) => void scrollFrame(event);
    frame.addEventListener('wheel', onWheel, { passive: false });
    const publish = () => {
      const box = frame.getBoundingClientRect();
      const message = viewportMessage(box, window.devicePixelRatio);
      if (message) surface.sendMessage(message);
    };
    // Held on the hook's ref so the socket can ask for it the moment it opens: the observer below
    // fires on mount, which is usually before the handshake has finished.
    if (kind === 'display') surface.viewportRef.current = publish;
    const observer =
      kind === 'display'
        ? new ResizeObserver(() => {
            if (frame.clientWidth > 0 && frame.clientHeight > 0) publish();
          })
        : undefined;
    observer?.observe(frame);
    return () => {
      frame.removeEventListener('wheel', onWheel);
      observer?.disconnect();
      surface.viewportRef.current = undefined;
    };
    // `surface.painting` and the frame URL are in here because the button they attach to does not
    // exist until there is something to draw in it: without them the listeners were installed
    // against a null ref on the render before the first frame and never again.
  }, [kind, holder, expanded, surface.painting, surface.frameUrl]);
  const clickFrame = async (event: MouseEvent<HTMLButtonElement>) => {
    /*
     * The picture does something whichever way control is held.
     *
     * While the agent has it this was the largest element on screen and pressing it did nothing at
     * all - a screen-sized dead spot, marked `aria-disabled` and given a default cursor so that the
     * interface was telling the truth about being inert rather than fixing it. Clicking now does
     * the one thing that is always safe to do to somebody else's session: makes it bigger. Taking
     * control is still a deliberate press on the button that says so, because taking the computer
     * off the agent mid-step is not something a stray click should be able to do.
     */
    if (holder !== 'user') {
      await toggleExpanded();
      return;
    }
    if (event.detail === 0) return;
    // A press that turned into a drag has already been sent as one; the click that follows it is
    // the browser telling us about the same gesture a second time.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    // The second click of a double is left to `onDoubleClick`, which sends it as the one action the
    // contract has for it: two clicks close enough together that the remote toolkit sees a double,
    // which a pair of separate round trips over a home connection never would.
    if (event.detail > 1) return;
    await sendAt(event, { clicks: 1 });
  };
  /**
   * Where this pointer event lands on the agent's screen.
   *
   * Measured against the picture, not the button around it. The button is a layout box and can be
   * a different shape from what is drawn inside it - it is, in full screen - and mapping a click
   * through the wrong box lands it somewhere the owner did not point.
   */
  const pointAt = (event: MouseEvent<HTMLButtonElement>): FramePoint => {
    const painted = event.currentTarget.querySelector('canvas:not([hidden]), img');
    return framePoint(event, (painted ?? event.currentTarget).getBoundingClientRect(), frameSize);
  };
  /**
   * A press of a button at a position, or an honest refusal.
   *
   * `pointerAction` returns nothing when the surface cannot express what was asked - a right-click
   * or a double-click on the page stream, which has neither field - and this says so rather than
   * sending a plain left click that would be reported as having worked.
   */
  const sendAt = async (
    event: MouseEvent<HTMLButtonElement>,
    press: { button?: 'left' | 'middle' | 'right'; clicks?: number }
  ) => {
    if (!kind) return;
    const action = pointerAction(kind, pointAt(event), press);
    if (!action) {
      surface.setError(
        'This host has no desktop, so the browser stream takes ordinary clicks only. Right-click and double-click need a screen.'
      );
      return;
    }
    await surface.send(action);
  };
  /*
   * A drag, tracked across the picture rather than assembled from a press and a hope.
   *
   * No slider moves and no puzzle challenge is solvable without this, and a challenge is very
   * often exactly what a person has been called in to clear. The threshold keeps an ordinary
   * click - which wobbles a pixel or two under a real hand - a click.
   */
  const dragFromRef = useRef<FramePoint | undefined>(undefined);
  const draggedRef = useRef(false);
  const beginDrag = (event: MouseEvent<HTMLButtonElement>) => {
    if (holder !== 'user') return;
    dragFromRef.current = pointAt(event);
    draggedRef.current = false;
  };
  const endDrag = async (event: MouseEvent<HTMLButtonElement>) => {
    const from = dragFromRef.current;
    dragFromRef.current = undefined;
    if (!from || !kind || holder !== 'user') return;
    const to = pointAt(event);
    if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_THRESHOLD_PX) return;
    const action = dragAction(kind, from, to);
    draggedRef.current = true;
    if (!action) {
      surface.setError(
        'Dragging needs a screen. This host has no desktop, so the browser stream cannot hold a button down across a movement.'
      );
      return;
    }
    await surface.send(action);
  };
  const scrollFrame = async (event: globalThis.WheelEvent) => {
    if (holder !== 'user' || !kind) return;
    // Otherwise the panel scrolls under the pointer instead, which is the one thing the owner did
    // not mean by turning the wheel over somebody else's screen.
    event.preventDefault();
    const action = wheelAction(kind, event);
    if (action) await surface.send(action);
  };
  /**
   * Every key, as the person pressed it.
   *
   * This was an allowlist of two - Enter and space - and everything else was dropped in silence.
   * A person invited to clear a challenge could not press Backspace to fix a typo, could not use
   * an arrow key, and could not reach anything below the fold. `keyChord` composes the modifiers
   * into the one spelling both surfaces understand; `framePassesThrough` keeps Tab for the page,
   * so focus that lands on the picture can still leave it.
   */
  const keyFrame = async (event: KeyboardEvent<HTMLButtonElement>) => {
    if (holder !== 'user' || framePassesThrough(event)) return;
    const key = keyChord(event);
    if (!key) return;
    event.preventDefault();
    await surface.send({ type: 'press', key });
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
  /*
   * Open an application, on a computer whose pane exists to be worked on directly.
   *
   * The route has been there all along with the owner's own role and scope on it, and there was no
   * door: changing "Nothing open yet" meant asking the agent in prose and waiting a whole turn.
   *
   * The holder dance is the runner's rule, not a preference. `desktop.launch` refuses while the
   * desktop is held by anyone but the agent (services/workspace-runner/src/desktop.ts), so the
   * route as it stands is usable only in the state a person is not in. Rather than leave the
   * control dead exactly when it is wanted, the screen goes back for the length of the launch and
   * is taken again straight after, and the owner ends holding what they were holding.
   */
  const launch = async () => {
    const executable = program.trim();
    if (!executable) return;
    const held = holder;
    try {
      if (held !== 'agent') await surface.setHolder('agent');
      await desktopLaunch(workspace.id, { executable });
      setProgram('');
      // The window list is part of what the toolbar says, and it is stale the moment this returns.
      look();
    } catch (cause) {
      surface.setError(describeFailure(cause, `${executable} did not start`));
    } finally {
      if (held !== 'agent') await surface.setHolder(held);
    }
  };
  /*
   * The browser's own history, beside the address bar that drives it.
   *
   * Offered only where a browser is known to be running and ours - the page surface, or a screen
   * where the address bar or a challenge has already put one there. Elsewhere pressing Back would
   * start a Chromium nobody asked for, which is the same mistake handing the screen back used to
   * make.
   */
  const browserIsOurs = kind === 'page' || browserHeld || Boolean(openWall);
  const browserStep = async (action: 'back' | 'reload') => {
    try {
      await api.browserPrivateAction(workspace.id, { type: action });
    } catch (cause) {
      surface.setError(describeFailure(cause, 'That did not reach the browser'));
    }
  };
  /*
   * The tabs, on the one surface where they are invisible.
   *
   * With a desktop the browser is a real window inside the stream and its tab strip is in the
   * picture. Without one the pane shows Chromium's screencast of page content only - no window
   * chrome, no strip - so four open tabs, and the one an agent left on a checkout page, were
   * unreachable and unseeable. This also gives `POST /v1/workspaces/:id/browser/snapshot` its
   * first caller.
   */
  const [tabs, setTabs] = useState<BrowserTabRow[]>([]);
  /*
   * A clock, only while there is a surface to count for.
   *
   * The holder line counts up from `holderSince`, and a number that has stopped is worse than no
   * number - so it ticks while a stream is open and nowhere else, on the same rule the Running
   * pane's elapsed column follows.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!kind) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [kind]);
  const readTabs = () => {
    if (kind !== 'page') return;
    void browserSnapshot(workspace.id)
      .then((snapshot) => setTabs(snapshot.tabs))
      .catch(() => setTabs([]));
  };
  useEffect(() => {
    setTabs([]);
    readTabs();
  }, [workspace.id, kind, holder]);
  const tabAction = async (action: 'select_tab' | 'close_tab', tabId: string) => {
    try {
      await api.browserPrivateAction(workspace.id, { type: action, tabId });
      readTabs();
    } catch (cause) {
      surface.setError(describeFailure(cause, 'That tab did not answer'));
    }
  };
  /*
   * The dialog holding the page, and the two buttons that are the only way out of it.
   *
   * It rides the stream the way `botWall` does. Until it did, an owner who took the browser over
   * and clicked something raising `confirm()` watched the page stop responding with nothing to
   * explain it: Playwright had intercepted the dialog, so the native one never drew, and parking
   * the handle suppressed the auto-dismiss - so the page stayed blocked, and reloading the app did
   * not clear it because the block is on the runner's side.
   */
  const pendingDialog = dialogBanner(surface.state?.pendingDialog);
  const answerDialog = async (response: 'accept' | 'dismiss') => {
    try {
      await surface.send({ type: 'dialog', response });
    } catch (cause) {
      surface.setError(describeFailure(cause, 'That answer did not reach the page'));
    }
  };

  return (
    <div
      className={`inspector-content browser-pane computer-pane${expanded ? ' expanded' : ''}`}
      ref={paneRef}
    >
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
        {/*
          A screen the size of a sidebar is not a screen you can work on. Full screen is the whole
          pane rather than the picture alone, so taking over and typing stay reachable without
          dropping out again - and Escape leaves, because the browser already means that here.
        */}
        <button
          className="icon-btn"
          aria-label={expanded ? 'Leave full screen' : 'Show this computer full screen'}
          title={expanded ? 'Leave full screen' : 'Full screen'}
          onClick={() => void toggleExpanded()}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </button>
      </div>
      {/*
        Why the screen is not working, when it is not. A box whose accessibility bridge has failed
        looks identical to a healthy one while every agent action silently degrades to pixels, and
        the runner has been sending the reason - "This Linux host does not have the Athanor GUI
        dependencies configured", and the like - in the same response this pane already fetched.
      */}
      {surfaceNotice(desktop) && (
        <div className="computer-message" role="status">
          <ShieldAlert />
          <span>{surfaceNotice(desktop)}</span>
        </div>
      )}
      <div className="browser-controls">
        {browserIsOurs && (
          <>
            <button
              className="icon-btn"
              aria-label="Back"
              title="Back"
              onClick={() => void browserStep('back')}
            >
              <ArrowLeft />
            </button>
            <button
              className="icon-btn"
              aria-label="Reload this page"
              title="Reload"
              onClick={() => void browserStep('reload')}
            >
              <RotateCcw />
            </button>
          </>
        )}
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
        {kind === 'display' && (
          <span className="computer-launch">
            <input
              aria-label="Open a program on this computer"
              placeholder="Program"
              value={program}
              onChange={(event) => setProgram(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void launch();
              }}
            />
            <button
              className="icon-btn"
              aria-label="Open this program"
              title="Open a program on the agent computer"
              disabled={!program.trim()}
              onClick={() => void launch()}
            >
              <Monitor />
            </button>
          </span>
        )}
      </div>
      {/* The tabs, where the picture cannot show them. Titles, so a row is worth reading. */}
      {kind === 'page' && tabs.length > 1 && (
        <div className="surface-strip" aria-label="Browser tabs">
          {tabs.map((entry) => (
            <span key={entry.tabId} className={`strip-tab${entry.active ? ' active' : ''}`}>
              <button title={entry.url} onClick={() => void tabAction('select_tab', entry.tabId)}>
                {entry.title || hostOf(entry.url)}
              </button>
              <button
                className="strip-close"
                aria-label={`Close ${entry.title || hostOf(entry.url)}`}
                onClick={() => void tabAction('close_tab', entry.tabId)}
              >
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Which windows are open, rather than how many. The toolbar could only ever count them. */}
      {kind === 'display' && desktop && desktop.windows.length > 0 && (
        <div className="surface-strip" aria-label="Open windows">
          {desktop.windows.map((entry) => (
            <button key={entry.id} title={entry.role}>
              {entry.name || entry.role}
            </button>
          ))}
        </div>
      )}
      {pendingDialog && (
        <div className="wall-banner" role="alert">
          <ShieldAlert />
          <div>
            <strong>This page is waiting for an answer</strong>
            <span>{pendingDialog.kind}</span>
            <small>{pendingDialog.detail}</small>
          </div>
          <div className="wall-actions">
            <button onClick={() => void answerDialog('dismiss')}>Dismiss</button>
            <button className="primary" onClick={() => void answerDialog('accept')}>
              Accept
            </button>
          </div>
        </div>
      )}
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
      <div className={`browser-viewport ${surface.frameUrl || surface.painting ? '' : 'loading'}`}>
        {surface.painting ||
        surface.frameUrl ||
        (kind === 'display' && desktop?.screenshotBase64) ? (
          <button
            type="button"
            className={`remote-frame-button ${holder === 'user' ? 'interactive' : 'zoomable'}`}
            // Clicks are mapped proportionally against this element's box, so the box has to be the
            // same shape as the screen inside it. Given here rather than in the stylesheet because
            // only the running stream knows its shape, and it can change mid-session.
            style={
              frameSize.width && frameSize.height
                ? { aspectRatio: `${frameSize.width} / ${frameSize.height}` }
                : undefined
            }
            /*
              Named for what pressing it does right now. It used to say "Take over below to
              interact" while carrying `aria-disabled`, which described a control that did nothing
              instead of giving it something to do.
            */
            aria-label={
              holder === 'user'
                ? 'Interactive agent computer. Click a position, or press Enter or Space to activate the focused control.'
                : expanded
                  ? 'Live view of the agent computer. Activate to leave full screen. Take over below to interact.'
                  : 'Live view of the agent computer. Activate to show it full screen. Take over below to interact.'
            }
            ref={frameRef}
            onClick={(event) => void clickFrame(event)}
            onKeyDown={(event) => void keyFrame(event)}
            onDoubleClick={(event) => void sendAt(event, { clicks: 2 })}
            /*
              The menu the agent's own applications draw, which used to be unreachable: the
              browser's context menu is over the picture rather than in it, so it was the only
              thing a right-click could ever produce here.
            */
            onContextMenu={(event) => {
              if (holder !== 'user') return;
              event.preventDefault();
              void sendAt(event, { button: 'right' });
            }}
            onPointerDown={beginDrag}
            onPointerUp={(event) => void endDrag(event)}
          >
            {/*
              Decoded video paints here. The canvas is mounted for the computer surface whether or
              not a frame has arrived, because the decoder needs somewhere to draw the very first
              one - and it is hidden until it has, so the still underneath stays visible instead of
              a black rectangle. That black rectangle was the bug.
            */}
            {kind === 'display' && (
              <canvas
                ref={surface.canvasRef}
                className="remote-frame-canvas"
                hidden={!surface.painting}
              />
            )}
            {!surface.painting && (
              <img
                draggable={false}
                src={
                  surface.frameUrl || `data:image/jpeg;base64,${desktop?.screenshotBase64 ?? ''}`
                }
                alt=""
              />
            )}
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
            {/* Blanked here rather than inside `look`, which is also the quiet refresh that runs
                every time this pane comes back. A press has to be answered on the spot. */}
            <button
              onClick={() => {
                setProbe({ done: false, error: '' });
                look();
              }}
            >
              Try again
            </button>
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
        {/*
          Shown when there is an error OR when reconnecting has given up.

          It used to be gated on the error alone, and the reconnect budget sets `stalled` without
          setting one - so the moment the pane stopped trying was the moment its only recovery
          control disappeared, leaving a dead view with nothing to press.
        */}
        {(surface.error || surface.stalled) && !probe.error && (
          <div className="browser-error">
            <strong>The computer needs attention</strong>
            <span>
              {surface.error ||
                'This device stopped trying to reach the agent computer after several attempts.'}
            </span>
            {surface.stalled && <button onClick={surface.reconnect}>Try again</button>}
          </div>
        )}
        {kind && !probe.error && (
          <div className="browser-status">
            <span className={holder}>
              {holder === 'agent' ? <Bot /> : <UserRound />}
              <span>
                {holder === 'agent'
                  ? 'Agent has control'
                  : holder === 'secure_input'
                    ? 'Secure input mode'
                    : 'You have control'}
                {surface.state?.holderSince ? ` · ${heldFor(surface.state.holderSince, now)}` : ''}
                {/*
                  What moved the pixels, in the same sentence the approval card would have used.
                  It is on every state frame and was read by nobody, so the only answer to "what is
                  it doing right now" was the transcript, after the fact, once the result landed.
                */}
                {holder === 'agent' && surface.state?.lastAction && (
                  <small className="status-detail">{surface.state.lastAction}</small>
                )}
              </span>
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
          {/*
            The screen as something other than pixels.

            Two things at once. It is the semantic layer the agent has had all along and the person
            did not: `invoke` and `focus` name a control rather than a position, which is the only
            way to press a twelve-pixel checkbox in a stream that has been scaled to fit a sidebar.
            And it is the only representation of this pane that is not a photograph - without it,
            for a screen-reader user the whole Computer tab is a canvas and an empty alt attribute,
            while the tree that would fix it sits in the response the pane already fetched.
          */}
          {kind === 'display' && desktop && desktop.nodes.length > 0 && (
            <details className="computer-nodes">
              <summary>What is on the screen ({desktop.nodes.length})</summary>
              <ul>
                {desktop.nodes
                  .filter((node) => node.name && !node.sensitive)
                  .slice(0, 120)
                  .map((node) => (
                    <li key={node.id}>
                      <span>{node.role}</span>
                      <strong>{node.name}</strong>
                      <button onClick={() => void surface.send({ type: 'focus', nodeId: node.id })}>
                        Focus
                      </button>
                      {node.actions.length > 0 && (
                        <button
                          onClick={() =>
                            void surface.send({ type: 'invoke', nodeId: node.id, actionIndex: 0 })
                          }
                        >
                          {node.actions[0] ?? 'Press'}
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </details>
          )}
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
  /** Writes into the same channel the keyboard does, for the on-screen key helpers below. */
  const send = useRef<((data: string) => void) | undefined>(undefined);
  /*
   * How this session ended, and the count that starts another.
   *
   * Both live outside the effect because the effect is what has to be re-run: bumping `attempt`
   * tears down the dead socket and its terminal and builds a fresh pair, which is exactly what a
   * new session is. `undefined` means the session is live.
   */
  const [closed, setClosed] = useState<SessionClose | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!host.current) return;
    setClosed(undefined);
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
    /*
     * F6 is the one key the shell does not get to keep.
     *
     * xterm turns every function key into an escape sequence and then cancels the event -
     * `evaluateKeyboardEvent` maps keyCode 117 to ESC[17~ and `_keyDown` finishes with
     * `preventDefault` and `stopPropagation` - so the keydown never bubbled to the window handler
     * and the pane walk did nothing in here. It takes Tab and Shift+Tab the same way (keyCode 9
     * sends HT with `cancel` set), which is correct for a terminal and is also the whole problem:
     * between them, this pane was the one place in the workbench a keyboard could get into and not
     * get back out of, and the browser's own ⌘1-4 escape is exactly the chord Chrome and Safari
     * keep for tab switching. Returning false hands the event back untouched before xterm reads
     * it, so it reaches the window and the shell never sees an F6. Nothing else is intercepted.
     */
    term.attachCustomKeyEventHandler((event) => event.key !== 'F6');
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    terminal.current = term;
    let socket: WebSocket | undefined;
    let renewal: number | undefined;
    let onShown: (() => void) | undefined;
    /*
     * Closing this socket ourselves - on unmount, or on the way to a new session - fires `onclose`
     * too. Without this the teardown of the old session would report itself as the new session
     * having ended, and the bar would be up over a terminal that had just connected.
     */
    let live = true;
    void api
      .terminalToken(workspace.id)
      .then(({ runnerUrl, token }) => {
        socket = new WebSocket(`${runnerUrl}/v1/workspaces/${workspace.id}/terminal`, [
          'athanor-capability',
          token
        ]);
        /*
         * Kept alive before its capability runs out, without trusting one long timer.
         *
         * The runner closes this socket when the capability expires, deliberately, so a shell on
         * the box stays revocable, and capabilities are capped at fifteen minutes. A single
         * `setTimeout` most of the way to expiry would be one chance: browsers throttle timers in a
         * hidden tab, and on a phone this app is backgrounded constantly, so that chance can be
         * missed and the session dies mid-command. A short interval that throttling cannot push
         * past the deadline gives several, and the deadline is checked again the moment the page is
         * shown.
         *
         * (An earlier version of this comment claimed a measured failure at 902s. That measurement
         * was an artifact of the instrumentation used to take it - a WebSocket stub without the
         * static `OPEN`, which made the app's own send guard false. The throttling risk above is
         * real; that particular evidence for it was not.)
         */
        let deadline = capabilityDeadline(token);
        let renewing = false;
        const renewSoon = (): void => {
          // The decision lives in `session-renewal.ts` and is tested there. It was a condition
          // inside this closure, which is how it went wrong twice with every test still passing.
          if (!shouldRenew({ deadline, now: Date.now(), inFlight: renewing })) return;
          renewing = true;
          void api
            .terminalToken(workspace.id)
            .then((next) => {
              if (socket?.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: 'renew', token: next.token }));
              deadline = capabilityDeadline(next.token) || deadline;
            })
            // Nothing to say: the session keeps the deadline it has and closes on it.
            .catch(() => undefined)
            .finally(() => {
              renewing = false;
            });
        };
        renewal = window.setInterval(renewSoon, 60_000);
        onShown = () => {
          if (document.visibilityState === 'visible') renewSoon();
        };
        document.addEventListener('visibilitychange', onShown);
        socket.onopen = () => {
          term.writeln('\x1b[32mConnected to private agent computer\x1b[0m');
          /*
           * Tell it how big the window actually is.
           *
           * The runner spawns the pty at a fixed 120x32, and `term.onResize` is registered below -
           * after this socket exists - so the fit that happened at mount fired into nothing and was
           * lost. The shell then believed it had 120 columns inside a pane about half that, which
           * is why anything that draws a full screen, an editor or a pager, came out wrapped and
           * misaligned. Sent once here, and after that the resize handler keeps it honest.
           */
          socket?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: string;
            data?: string;
            exp?: number;
          };
          if (message.type === 'data') term.write(message.data ?? '');
          else if (message.type === 'renewed' && message.exp) deadline = message.exp * 1000;
        };
        /*
         * The end of a session is a state, not a line of scrollback.
         *
         * It used to write one yellow line and stop: no reconnect, no button, and the key helpers
         * below still lit and still doing nothing, because a dead socket swallows them silently.
         * The scrollback line stays - it belongs with the output it follows - and the bar carries
         * the reason and the way back.
         */
        socket.onclose = (event) => {
          // Nothing left to keep alive. A session that closed on its deadline has one in the past,
          // so the renewal check would say yes on every tick and mint a capability a minute, for
          // as long as the pane stayed open, for a socket that is gone. The visibility hook is the
          // same check by another route - it is what asks again the moment a backgrounded phone is
          // picked up - so both go together or the leak simply moves.
          if (renewal !== undefined) window.clearInterval(renewal);
          if (onShown) document.removeEventListener('visibilitychange', onShown);
          if (!live) return;
          term.writeln('\r\n\x1b[33mSession closed\x1b[0m');
          setClosed({ kind: 'socket', code: event.code, reason: event.reason });
        };
        const write = (data: string): void => {
          if (socket?.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: 'input', data }));
        };
        send.current = write;
        term.onData(write);
        term.onResize(
          ({ cols, rows }) =>
            socket?.readyState === WebSocket.OPEN &&
            socket.send(JSON.stringify({ type: 'resize', cols, rows }))
        );
      })
      .catch((cause: unknown) => {
        if (!live) return;
        // No socket was ever opened, so there is no close code to read: the same bar, with what the
        // failed request said. Written into the scrollback too, so the reason survives the reload.
        term.writeln(`\x1b[31m${describeFailure(cause, 'Could not reach this computer')}\x1b[0m`);
        setClosed({ kind: 'token', cause });
      });
    /*
     * A pane with no size is not a pane to fit to.
     *
     * This became load-bearing the moment the panes stopped being destroyed on a tab change: the
     * one behind is `display: none`, ResizeObserver reports that as 0x0, and FitAddon's floor is
     * two columns by one row - so it resized the terminal to 2x1 and `term.onResize` sent that
     * straight down the socket as a SIGWINCH. A glance at Files reflowed the owner's running build
     * or pager to two columns wide and it never came back looking right. Fitting only when there is
     * something to fit to leaves the pty at the size it had while the tab was away.
     */
    const box = host.current;
    const observer = new ResizeObserver(() => {
      if (box.clientWidth > 0 && box.clientHeight > 0) fit.fit();
    });
    observer.observe(box);
    return () => {
      live = false;
      observer.disconnect();
      if (renewal !== undefined) window.clearInterval(renewal);
      if (onShown) document.removeEventListener('visibilitychange', onShown);
      send.current = undefined;
      socket?.close();
      term.dispose();
    };
    // `attempt` is the New session button: re-running this effect is what starts one.
  }, [workspace.id, attempt]);
  /*
   * The keys a phone keyboard does not have.
   *
   * The terminal is reachable from any device, and on a touch keyboard there is no Tab, no Escape
   * and no Control - so a path cannot be completed, an editor cannot be left, and a running command
   * cannot be interrupted. The computer pane next door has carried exactly these helpers all along;
   * the terminal, which needs them more, had none.
   *
   * Written straight into the same channel `term.onData` feeds, so they are the keystrokes rather
   * than a special case: ESC, TAB, Ctrl-C, Ctrl-D, and the arrows for shell history.
   */
  const keys: Array<[string, string, string]> = [
    ['Esc', '\x1b', 'Escape'],
    ['Tab', '\t', 'Tab'],
    ['Ctrl-C', '\x03', 'Interrupt what is running'],
    ['Ctrl-D', '\x04', 'End of input'],
    ['↑', '\x1b[A', 'Previous command'],
    ['↓', '\x1b[B', 'Next command']
  ];
  const ended = closed && sessionEnd(closed);
  return (
    <div className="terminal-pane-wrap">
      <div className="terminal-pane" ref={host} />
      {ended && (
        <div className={`terminal-closed ${ended.clean ? '' : 'faulted'}`} role="status">
          <div>
            <strong>{ended.message}</strong>
            {/*
              Said plainly because it is what happens: reconnecting spawns a fresh shell in the
              workspace folder, so a `cd`, an environment and anything that was running are gone.
              A button labelled "Reconnect" over a new shell would be the pane lying about the
              state of the computer.
            */}
            <span>A new shell, starting in workspace.</span>
          </div>
          <button
            type="button"
            className="terminal-new-session"
            onClick={() => setAttempt((count) => count + 1)}
          >
            New session
          </button>
        </div>
      )}
      <div className="terminal-keys">
        {keys.map(([label, sequence, title]) => (
          <button
            key={label}
            type="button"
            title={title}
            aria-label={title}
            // Lit and dead was the old behaviour: with the socket gone these still looked pressable
            // and every press went nowhere.
            disabled={Boolean(closed)}
            // The terminal keeps focus, so the on-screen keyboard does not close between presses.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              send.current?.(sequence);
              terminal.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * How often the pane re-reads what the computer is running.
 *
 * The clock moves every second so a live row counts up rather than jumping; the machine is asked
 * every fifth of those, which is often enough that a server started in the conversation appears
 * while the owner is still looking at it, and rare enough that watching this pane is not itself a
 * load on the box. Both stop dead when the pane is behind another tab.
 */
const RUNNING_TICK_MS = 1_000;
const RUNNING_TICKS_PER_POLL = 5;

function RunningPane({ workspace, visible }: { workspace: Workspace; visible: boolean }) {
  const [processes, setProcesses] = useState<BackgroundProcess[]>([]);
  const [processFailure, setProcessFailure] = useState('');
  /*
   * Whether the machine has been asked yet.
   *
   * Without this the pane opened on "Nothing is running in the background." — stated before the
   * first request had been made, and therefore stated on every box including the ones with three
   * servers up. An empty list is only news once it is an answer.
   */
  const [asked, setAsked] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [previews, setPreviews] = useState<WorkspacePreview[]>([]);
  const undo = useUndo();
  const [port, setPort] = useState(3000);
  const [label, setLabel] = useState('App preview');
  /** Where inside the served port the link lands. Empty means the root, which is what it was. */
  const [entryPath, setEntryPath] = useState('');
  const [activeUrl, setActiveUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Which row's output is open, and what it said. One at a time: this is a tail, not a console. */
  const [openLog, setOpenLog] = useState('');
  const [logText, setLogText] = useState('');
  const showLog = async (sessionId: string) => {
    if (openLog === sessionId) {
      setOpenLog('');
      return;
    }
    setOpenLog(sessionId);
    setLogText('');
    try {
      const answer = await processLog(workspace.id, sessionId);
      // stderr last, because on a failure it is the part being looked for and the pane scrolls.
      setLogText([answer.stdout ?? '', answer.stderr ?? ''].filter(Boolean).join('\n').trimEnd());
    } catch (cause) {
      setLogText(describeFailure(cause, 'That output could not be read'));
    }
  };
  const load = () =>
    void api
      .previews(workspace.id)
      .then(setPreviews)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Could not load previews')
      );
  const loadProcesses = () =>
    void api
      .workspaceProcesses(workspace.id)
      .then((current) => {
        setProcesses(current);
        setProcessFailure('');
      })
      // Said once, in the row's own place, rather than in the alert the form below uses: a computer
      // that has stopped answering is a fact about the machine, not a failed thing the owner did.
      .catch(() => setProcessFailure('The computer is not saying what it is running.'))
      .finally(() => setAsked(true));
  useEffect(() => {
    setActiveUrl('');
    load();
  }, [workspace.id]);
  /*
   * The clock is only read by a row that is counting up, so it is only advanced while one exists.
   * A machine with nothing running - the ordinary state - otherwise re-rendered this pane once a
   * second for a number that had already stopped, for as long as the tab was on screen.
   */
  const counting = processes.some(isLive);
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    loadProcesses();
    let ticks = 0;
    const timer = window.setInterval(() => {
      // Behind another window as well as behind another tab: everything else that polls this box
      // checks `visibilityState` first (App.tsx), and a browser left open overnight on this pane
      // would otherwise ask the machine what it is running twelve times a minute until morning.
      if (document.visibilityState !== 'visible') return;
      if (counting) setNow(Date.now());
      ticks += 1;
      if (ticks % RUNNING_TICKS_PER_POLL === 0) loadProcesses();
    }, RUNNING_TICK_MS);
    return () => window.clearInterval(timer);
  }, [visible, workspace.id, counting]);
  const rows = runningOrder(processes);
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
  /*
   * The order of this pane is the answer to one question: what is this computer doing right now.
   *
   * It used to open on a form asking the owner to name a port, defaulted to 3000, which answered a
   * wrong guess with "Nothing is listening on port N" - the machine knew exactly what it was
   * running and made the person guess anyway. So the background processes lead, the addresses that
   * are already published come next, and the form sinks to the bottom where it belongs: the case
   * where the owner knows something is listening that athanor did not start.
   */
  return (
    <div className="inspector-content preview-pane">
      <div className="running-list">
        {rows.length === 0 ? (
          // One line. An empty computer is the ordinary state and does not deserve an illustration.
          <p className="running-idle">
            {!asked
              ? 'Asking the computer what it is running…'
              : processFailure || 'Nothing is running in the background.'}
          </p>
        ) : (
          rows.map((row) => {
            const live = isLive(row);
            return (
              <div className={`running-row${live ? ' live' : ''}`} key={row.sessionId}>
                {/* The ember mark, and the only thing on this pane that gets it: it is on exactly
                    the rows where the machine is working this second. A finished row is grey. */}
                <span className="running-mark" aria-hidden="true" />
                <div>
                  <strong>{processCommand(row.command)}</strong>
                  <small>{processState(row)}</small>
                </div>
                <span className="running-elapsed">{processElapsed(row, now)}</span>
                {/*
                  Why it died, or what it is saying while it lives.

                  The runner buffers a session's stdout and stderr and has answered `log` all
                  along; the API hard-coded `kill`, so the only thing an owner could do with a
                  crash-looping service was stop it. A dev server that lost a port, a build that
                  failed: the reason was in the runner's memory with no door, and the Terminal pane
                  does not have that process's pipes.
                */}
                <button
                  className="running-stop"
                  title="Show what this has written"
                  aria-label={`Show the output of ${processCommand(row.command)}`}
                  aria-expanded={openLog === row.sessionId}
                  onClick={() => void showLog(row.sessionId)}
                >
                  <FileCode2 />
                </button>
                {/* The half the panel was missing. A service outlives the conversation that started
                    it and comes back after every restart, so seeing one with no way to stop it was
                    the owner watching their own machine through glass. */}
                {live && (
                  <button
                    className="running-stop"
                    title="Stop this"
                    aria-label={`Stop ${processCommand(row.command)}`}
                    onClick={() =>
                      void api
                        .stopWorkspaceProcess(workspace.id, row.sessionId)
                        .then(loadProcesses)
                        .catch(() => setProcessFailure('That could not be stopped.'))
                    }
                  >
                    <CircleStop />
                  </button>
                )}
                {openLog === row.sessionId && (
                  <pre className={`process-log${logText ? '' : ' empty'}`}>
                    {logText || 'This has written nothing since anyone last looked.'}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
      {/* Every other pane offers the way back; this one printed the failure and stopped. */}
      {processFailure && (
        <p className="running-idle">
          {rows.length > 0 ? `${processFailure} ` : ''}
          <button onClick={loadProcesses}>Try again</button>
        </p>
      )}
      {/* Only where there is something for it to be true of. Said over an empty list it was the
          software describing itself, which is the one thing this pane is not for. */}
      {previews.length > 0 && (
        <div className="preview-boundary">
          <LockKeyhole />
          <span>A preview cannot read your athanor session, even if its code tries.</span>
        </div>
      )}
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
      ) : null}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {/*
        The bottom of the pane, because it is the uncommon case: the owner knows something is
        listening that athanor did not start, and wants an address for it. Anything athanor started
        is already a row at the top of this pane, which is why this is no longer the first thing
        anyone sees.
      */}
      <div className="running-publish">
        <span>Publish a port athanor did not start</span>
        <div className="preview-create">
          <label>
            Name
            <input
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
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
          {/*
            Where the link opens.

            The contract has taken an entry path since previews existed, the address builder folds
            it into every URL, and the agent's own tool sets it — so the agent's link for an app
            landed on `/dashboard` and the owner's link for the same app landed on a 404 or a
            directory index. Absolute and relative to the port, never to a host: the server refuses
            a value carrying a scheme or a `..` rather than cleaning it up.
          */}
          <label className="preview-entry">
            Path
            <input
              value={entryPath}
              maxLength={300}
              placeholder="/"
              onChange={(event) => setEntryPath(event.target.value)}
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
                // says it does, and the row above reports whatever that turns out to be.
                const created = await api.createPreview(workspace.id, {
                  label,
                  port,
                  // Omitted rather than sent empty: the server's own default is the root, and an
                  // empty string is a value the schema would have to decide about.
                  ...(entryPath.trim() ? { entryPath: entryPath.trim() } : {})
                });
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
      </div>
    </div>
  );
}

export function Inspector({
  workspace,
  initialTab,
  wall,
  hidden: away = false,
  onTab,
  taskIsActive = false,
  openFile
}: {
  workspace: Workspace | undefined;
  initialTab: Tab;
  /** The challenge the open conversation stopped at, so the screen can offer the way out of it. */
  wall?: BotWall | undefined;
  /**
   * Put away rather than taken down.
   *
   * The panes stopped being destroyed on a tab change, which fixed the terminal for a laptop and
   * left the phone exactly as it was: there "Work" is the primary destination and reaching it closed
   * the whole panel, so the shell died on the way to reading the answer. The window hides the panel
   * with this instead of unmounting it, on the same principle and with the same `hidden`.
   */
  hidden?: boolean;
  onTab?: (tab: Tab) => void;
  /** Whether the agent is working right now, which is what makes Files open on Recent. */
  taskIsActive?: boolean;
  /**
   * A file the conversation asked to be shown here.
   *
   * The window chooses the Files tab in the same click, so this never has to reach a pane that has
   * not been built: the tab change is what builds it.
   */
  openFile?: FileTarget;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  /*
   * Which panes exist, as opposed to which one is on top.
   *
   * A pane is built the first time it is looked at and is never taken down again. Both halves of
   * that matter. Taking it down was the bug: the panel rendered one pane through a ternary, so
   * glancing at Files unmounted the terminal, its cleanup closed the socket, and the runner kills
   * the pty when that socket closes (services/workspace-runner/src/server.ts) — the owner's build
   * died and the pane said "Session closed" as though their shell had exited. Not building it until
   * it is asked for matters too: a shell on the box, a directory listing and a preview poll are all
   * things nobody should be paying for on a tab they have never opened.
   *
   * A Set on a ref rather than state: adding a member that is already there changes nothing, and
   * the render that reads it is the one the tab change already caused.
   */
  const opened = useRef(new Set<Tab>());
  opened.current.add(tab);
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
    // A named region with `tabIndex={-1}`, so ⌘4, ⌘⌥1–4 and F6 have somewhere to land. Without it
    // the panel was only reachable by tabbing past every conversation in the sidebar and the whole
    // transcript, which on a well-used athanor is dozens of stops.
    <aside
      className="inspector"
      id={paneId('tools')}
      tabIndex={-1}
      aria-label="Computer tools"
      hidden={away}
    >
      <div className="inspector-tabs" role="tablist" aria-label="Computer tools">
        {inspectorTabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`inspector-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`inspector-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onKeyDown={moveTab}
            onClick={() => select(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {!workspace ? (
        // Nothing to hold four panes open around: the one panel carries the id of the tab that is
        // selected, so the tab pointing at it still points at something real.
        <div
          id={`inspector-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`inspector-tab-${tab}`}
          className="inspector-panel"
        >
          <div className="empty-pane grow">
            <HardDrive />
            <strong>The agent computer is not answering</strong>
            <span>
              Run <code>sudo athanor doctor</code> on the server. It says which service is down.
            </span>
          </div>
        </div>
      ) : (
        // One panel per tab, all present, the ones behind hidden rather than destroyed. `hidden`
        // needs help here: `.inspector-panel` carries `display: contents` so the pane inside it
        // lays out as the inspector's own flex child, and that beats the browser's `[hidden]`.
        inspectorTabs.map(([id]) => (
          <div
            key={id}
            id={`inspector-panel-${id}`}
            role="tabpanel"
            aria-labelledby={`inspector-tab-${id}`}
            className="inspector-panel"
            hidden={tab !== id}
          >
            {!opened.current.has(id) ? null : id === 'files' ? (
              <Files
                workspace={workspace}
                taskIsActive={taskIsActive}
                {...(openFile ? { target: openFile } : {})}
              />
            ) : id === 'computer' ? (
              <Computer
                workspace={workspace}
                visible={!away && tab === 'computer'}
                {...(wall ? { wall } : {})}
              />
            ) : id === 'terminal' ? (
              <TerminalPane workspace={workspace} />
            ) : (
              // `visible` because this pane polls the machine: a pane that stays mounted behind
              // another tab - or behind the whole panel being put away - must not keep asking what
              // is running where nobody is looking.
              <RunningPane workspace={workspace} visible={!away && tab === 'preview'} />
            )}
          </div>
        ))
      )}
    </aside>
  );
}
