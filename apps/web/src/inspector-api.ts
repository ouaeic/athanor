/**
 * The panel's own edges: the three routes only the panel calls, and the pure mappings its
 * handlers are made of.
 *
 * Not in `api.ts`, deliberately. `api.ts` is reachable from the first paint — `App.tsx` imports it
 * — so a method added there is a method every device downloads before it has seen a conversation,
 * whether or not it ever opens the Computer panel. Everything here is reached only from
 * `Inspector.tsx`, which is behind `lazy()`, so it rides in that chunk and costs the eager graph
 * nothing. The failure shape is `ApiFailure` either way, because `describeFailure` is what reads it.
 *
 * The mappings below are pure and live here rather than inside the component for the reason every
 * other `*-rows.ts` in this client does: there is no DOM in this package's tests, so the only way
 * to hold "a right-click sends a right-click" to account is to make the answer a value.
 */
import { ApiFailure } from './api-failure.js';

/** The same deadline `api.ts` puts on everything, for the same reason: a stalled fetch is a hang. */
const REQUEST_TIMEOUT_MS = 45_000;

const call = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    throw new ApiFailure(
      failure.error?.code ?? 'request_failed',
      failure.error?.message ?? `Request failed (${response.status})`,
      response.status,
      failure.error?.requestId
    );
  }
  return (await response.json()) as T;
};

/**
 * What a background process has written since anyone last looked.
 *
 * The runner has answered `log` all along and the API hard-coded `kill`, so the only thing an
 * owner could do with a crash-looping service was stop it: the reason it was failing sat in the
 * runner's memory with no door. `poll` and `write` are deliberately not offered — `poll` is the
 * agent's own wait loop, and `write` puts bytes on the stdin of a process the owner is reading
 * rather than driving.
 */
export const processLog = (
  workspaceId: string,
  sessionId: string
): Promise<{ stdout?: string; stderr?: string; status?: string; exitCode?: number | null }> =>
  call(`/v1/workspaces/${workspaceId}/processes/${encodeURIComponent(sessionId)}`, {
    action: 'log'
  });

/**
 * Open an application on the owner's own computer.
 *
 * The runner resolves the executable against the session's PATH and refuses privilege escalation,
 * package managers and privileged helpers, so what is sent is a name rather than a command line.
 */
export const desktopLaunch = (
  workspaceId: string,
  request: { executable: string; args?: string[] }
): Promise<{ pid?: number; executable: string }> =>
  call(`/v1/workspaces/${workspaceId}/desktop/launch`, {
    executable: request.executable,
    args: request.args ?? []
  });

export interface BrowserTabRow {
  tabId: string;
  active: boolean;
  url: string;
  title: string;
}

/**
 * The browser's own account of itself, which is the only place its tabs are named.
 *
 * Asked for only on the page surface. On a box with a desktop the browser is a real window inside
 * the stream — its tab strip is in the picture — and asking here would start a Chromium nobody
 * wanted.
 */
export const browserSnapshot = (
  workspaceId: string
): Promise<{
  url: string;
  title: string;
  tabs: BrowserTabRow[];
  pendingDialog: { type: string; message: string } | null;
}> => call(`/v1/workspaces/${workspaceId}/browser/snapshot`, {});

/** Which of the two live surfaces an action is bound for. They do not accept the same vocabulary. */
export type SurfaceKind = 'display' | 'page';

export interface FramePoint {
  x: number;
  y: number;
}

interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a pointer landed, in the coordinate space the runner works in.
 *
 * Measured against the picture rather than the element around it: the button is a layout box and
 * can be a different shape from what is drawn inside it — it is, in full screen — and mapping a
 * click through the wrong box lands it somewhere the owner did not point.
 */
export const framePoint = (
  at: { clientX: number; clientY: number },
  box: FrameBox,
  size: { width: number; height: number }
): FramePoint => ({
  x: box.width
    ? Math.max(0, Math.min(size.width, ((at.clientX - box.left) / box.width) * size.width))
    : 0,
  y: box.height
    ? Math.max(0, Math.min(size.height, ((at.clientY - box.top) / box.height) * size.height))
    : 0
});

/**
 * A press of a mouse button at a position, or nothing.
 *
 * Nothing is the honest answer for a right-click or a double-click on the page surface:
 * `BrowserPrimitiveAction`'s `click_at` (packages/contracts) carries an x and a y and no button or
 * repeat count, and zod's `discriminatedUnion` drops an undeclared key without a word — so sending
 * `button: 'right'` there would be accepted, silently downgraded to an ordinary left click, and
 * report success. A control that does something quietly different from what it says is the exact
 * defect this pane is being repaired for, so the caller is told it cannot be expressed instead.
 */
export const pointerAction = (
  kind: SurfaceKind,
  at: FramePoint,
  press: { button?: 'left' | 'middle' | 'right'; clicks?: number } = {}
): Record<string, unknown> | undefined => {
  const button = press.button ?? 'left';
  const clicks = Math.max(1, Math.min(3, press.clicks ?? 1));
  if (kind === 'page')
    return button === 'left' && clicks === 1 ? { type: 'click_at', x: at.x, y: at.y } : undefined;
  return { type: 'click_at', x: at.x, y: at.y, button, clicks };
};

/**
 * A wheel turn, in each surface's own idea of what scrolling is.
 *
 * The desktop speaks direction and tick count, because xdotool sends wheel buttons; the browser
 * speaks pixel deltas, because Playwright sends a wheel event. The dominant axis wins on the
 * desktop, since there is no way to express a diagonal in wheel buttons and picking one is closer
 * to what the person did than sending two bursts.
 *
 * No position goes with the desktop arm, and none is invented: `DesktopAction`'s `scroll` member
 * declares a direction and an amount and nothing else, so an x and a y would be dropped by the
 * discriminated union without a word — and the runner scrolls at `session.pointer`, wherever the
 * last click put it. Sending coordinates that are silently discarded is how a control starts
 * lying. Clicking into the pane a person wants to scroll is what aims the wheel.
 */
export const wheelAction = (
  kind: SurfaceKind,
  delta: { deltaX: number; deltaY: number }
): Record<string, unknown> | undefined => {
  if (kind === 'page')
    return { type: 'scroll', deltaX: clampDelta(delta.deltaX), deltaY: clampDelta(delta.deltaY) };
  const horizontal = Math.abs(delta.deltaX) > Math.abs(delta.deltaY);
  const magnitude = Math.abs(horizontal ? delta.deltaX : delta.deltaY);
  if (!magnitude) return undefined;
  return {
    type: 'scroll',
    direction: horizontal
      ? delta.deltaX > 0
        ? 'right'
        : 'left'
      : delta.deltaY > 0
        ? 'down'
        : 'up',
    // A trackpad reports pixels and a mouse notch reports about a hundred of them; the contract
    // takes wheel ticks, bounded at 100 and floored at 1 so the smallest flick still moves.
    amount: Math.max(1, Math.min(100, Math.round(magnitude / 40)))
  };
};

const clampDelta = (value: number): number => Math.max(-5_000, Math.min(5_000, Math.round(value)));

/**
 * A drag, which only the desktop has.
 *
 * There is no drag primitive in `BrowserPrimitiveAction` — twenty of them and none holds a button
 * down across a motion — so on the page surface this is undefined rather than approximated. A
 * slider or a puzzle challenge on a box with no desktop stays out of reach, and saying so is
 * better than a click that lands on the handle and does nothing.
 */
export const dragAction = (
  kind: SurfaceKind,
  from: FramePoint,
  to: FramePoint
): Record<string, unknown> | undefined =>
  kind === 'page'
    ? undefined
    : {
        type: 'drag',
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        durationMs: 500
      };

/** How far a pointer must travel between press and release before it is a drag and not a click. */
export const DRAG_THRESHOLD_PX = 6;

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * A keystroke, as one chord string both surfaces understand.
 *
 * One spelling serves both by construction: the desktop's `toX11Keysym`
 * (services/workspace-runner/src/desktop.ts) splits on `+` and lowercases each part before looking
 * it up, so `Control` becomes `ctrl` and `Meta` becomes `super`; Playwright's `keyboard.press`
 * splits on the same `+` and wants exactly `Control`, `Alt`, `Shift`, `Meta`. The one key DOM
 * spells differently from both is the space bar, which arrives as `' '` and goes out as `Space`.
 *
 * This replaced an allowlist of two keys — Enter and space. Everything else a person pressed while
 * holding the agent's computer was dropped in silence: no Backspace, so a typo could not be fixed;
 * no arrows; no ⌘A. Modifier keys on their own return nothing, because a chord is sent when the
 * key it modifies arrives and `press('shift')` on its own is a keystroke nobody made.
 */
export const keyChord = (event: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): string | undefined => {
  if (!event.key || MODIFIER_KEYS.has(event.key)) return undefined;
  const key = event.key === ' ' ? 'Space' : event.key;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  // Shift is folded into a printable character by the keyboard itself: `Shift+A` would be told to
  // the remote as shift-then-A and produce nothing on a layout where A is already shifted.
  if (event.shiftKey && key.length > 1) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  return [...parts, key].join('+');
};

/**
 * Keys the frame does not take, so a keyboard user can leave it.
 *
 * Everything else is forwarded, including the browser's own shortcuts — that is what holding
 * somebody else's computer means. Tab is the exception: with it swallowed, focus that lands on the
 * picture can never leave, and the toolbar under the frame already carries a Tab button that sends
 * one to the remote screen. So Tab moves focus here and is sent from there.
 */
export const framePassesThrough = (event: { key: string; metaKey?: boolean }): boolean =>
  event.key === 'Tab' && !event.metaKey;

/**
 * How long a picture may go unrefreshed while the socket is still talking before it is a freeze.
 *
 * Four seconds is long enough that an ordinary hiccup on a home connection passes unremarked and
 * short enough that nobody makes a decision from a stale screen.
 */
export const STALL_AFTER_MS = 4_000;

/**
 * Whether the pane is showing a photograph.
 *
 * Read it as a sentence: *the computer is still talking to us, and nothing it has said in the last
 * four seconds has reached the picture.* Both halves are load-bearing.
 *
 * The obvious rule — no bytes for four seconds — is wrong here and would have been a new lying
 * control of its own. The encoder runs behind `mpdecimate` (services/workspace-runner/src/
 * desktop-stream.ts), so an idle desktop sends nothing at all, on purpose: a plain silence
 * watchdog would raise "the computer needs attention" every time the agent paused to think. What
 * actually froze the pane was the opposite of silence — access units kept arriving and the decoder
 * dropped every one of them, because one lost delta left it waiting for a keyframe that an
 * infinite GOP never produces. Bytes in, no pixels out, a healthy socket, and no error: exactly
 * the case the pane had no way to notice.
 */
export const streamStalled = (
  marks: { lastPaintAt: number | undefined; lastSignalAt: number | undefined },
  now: number
): boolean =>
  marks.lastPaintAt !== undefined &&
  marks.lastSignalAt !== undefined &&
  marks.lastSignalAt > marks.lastPaintAt &&
  now - marks.lastPaintAt >= STALL_AFTER_MS;

/**
 * Why the screen is not working, when it is not.
 *
 * The snapshot has carried a `mode` and a `message` since the desktop was written and this pane
 * read neither, so a box whose accessibility bridge had failed looked identical to a healthy one
 * while every agent action silently degraded to pixels. The runner's own sentence wins where there
 * is one — it names the thing that broke — and each mode has a fallback, because a mode with no
 * message is still a mode the owner needs told about.
 */
export const surfaceNotice = (snapshot?: { mode: string; message?: string }): string => {
  if (!snapshot || snapshot.mode === 'semantic_and_visual') return '';
  if (snapshot.message) return snapshot.message;
  return snapshot.mode === 'visual_fallback'
    ? 'This computer’s accessibility bridge is not answering, so the agent is working from the picture alone.'
    : 'This computer has no screen running.';
};

/**
 * The dialog holding a page, as the two lines a person needs to answer it.
 *
 * A value rather than a branch in the markup, because the pane has no DOM in its tests and a
 * banner that appears or does not appear is exactly the kind of thing that quietly stops.
 */
export const dialogBanner = (
  dialog?: { type: string; message: string } | null
): { kind: string; detail: string } | undefined =>
  dialog
    ? {
        kind: dialog.type || 'dialog',
        detail:
          dialog.message ||
          'The page opened a dialog. Nothing on it can be clicked until this is answered.'
      }
    : undefined;

/**
 * How long control has been where it is, in the shape the runner's own comment asked for.
 *
 * `holderSince` has sat beside `lastAction` on every state frame since the display was written,
 * with a doc-comment naming the exact string a client should render — "Agent has control · 0:14" —
 * and no client ever read it. Empty for a stamp that is not a date, or one in the future: a clock
 * counting backwards is worse than no clock.
 */
export const heldFor = (since: string, now: number): string => {
  const started = Date.parse(since);
  if (Number.isNaN(started) || started > now) return '';
  const seconds = Math.floor((now - started) / 1_000);
  if (seconds >= 3_600)
    return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * What the viewer says about the size of the hole it is showing the screen through.
 *
 * `DesktopManager.resize` has existed since the display did and had exactly one caller — a
 * subscriber field no route ever set — so every agent computer has been 1280x800 whatever it was
 * being watched on. Rounded because the runner hands these to an X server, and bounded by the
 * schema at the other end (1 to 20,000 CSS pixels, a device ratio between 0.5 and 8).
 */
export const viewportMessage = (
  box: { width: number; height: number },
  devicePixelRatio = 1
): { type: 'viewport'; viewport: Record<string, unknown> } | undefined => {
  const cssWidth = Math.round(box.width);
  const cssHeight = Math.round(box.height);
  // A pane behind another tab measures 0x0. Resizing the agent's screen to nothing because the
  // owner glanced at Files is the same mistake the terminal's FitAddon made and is guarded here
  // for the same reason.
  if (cssWidth < 1 || cssHeight < 1) return undefined;
  return {
    type: 'viewport',
    viewport: {
      cssWidth: Math.min(20_000, cssWidth),
      cssHeight: Math.min(20_000, cssHeight),
      devicePixelRatio: Math.max(0.5, Math.min(8, devicePixelRatio)),
      mode: 'css'
    }
  };
};

/**
 * Where a file lands when it is moved into another folder, or why it cannot go there.
 *
 * The rename route has always been a move — the runner resolves an arbitrary destination and
 * mkdirs its parent — and the only thing standing between the owner and that was the client, whose
 * one caller replaced the last path segment and rejected anything with a slash in it. `renamedPath`
 * (file-actions.ts) keeps that rule, because renaming in place is what it is for; this is the other
 * half, and it names a folder rather than a path so nothing here can address a file by hand.
 */
export const movedPath = (
  entry: { name: string; path: string },
  folder: string
): { ok: true; path: string } | { ok: false; message: string } => {
  const destination = `${folder.replace(/\/+$/, '')}/${entry.name}`;
  if (destination === entry.path)
    return { ok: false, message: `${entry.name} is already in that folder.` };
  return { ok: true, path: destination };
};
