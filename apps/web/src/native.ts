import type { NotificationKind, NotificationSettings } from './notification-settings.js';

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const core = (): TauriCore | undefined => {
  const host = window as unknown as {
    __TAURI__?: { core?: TauriCore };
    __TAURI_INTERNALS__?: { invoke?: TauriCore['invoke'] };
  };
  return (
    host.__TAURI__?.core ??
    (host.__TAURI_INTERNALS__?.invoke ? { invoke: host.__TAURI_INTERNALS__.invoke } : undefined)
  );
};

/*
 * The dead deep-link path is gone rather than repaired, and the shell is what decided that.
 *
 * `onDeepLinks` read `window.__TAURI__.deepLink`, which does not exist: `withGlobalTauri` is false
 * and no `@tauri-apps/plugin-deep-link` is bundled into this app, so the listener could never fire
 * and the three code paths in `App.tsx` that fed it were unreachable. The shell now reports
 * `deepLinkEvents: false` from the build facts it can actually see, and the comment beside it says
 * why in the one place that knows: it navigates the window to `origin/?task=<id>` itself, which
 * `load()` already reads. The link works. What it costs is a document reload, and that is a fact
 * about the shell, not something this file can fix by listening harder.
 *
 * `nativeTarget` went with it. It validated the scheme, the host and the id before anything was
 * sent to the API as a conversation id, and that check has not been lost: `deep_link_destination`
 * in `apps/desktop/src-tauri/src/lib.rs` performs the same one in Rust, before the window is asked
 * to go anywhere at all.
 */

/**
 * What this shell can actually do, so the page stops guessing.
 *
 * Every field is a build fact the shell process knows and this page cannot. Before they existed,
 * each native surface was discovered by trying it and catching the rejection — `notify` learned it
 * was impossible from an exception, and a Download button was offered on a shell that registers
 * nothing to receive one. An older shell answers with `folderPicker` alone, so the rest default to
 * false: claiming a capability a shell never mentioned is how this went wrong the first time.
 */
export interface NativeCapabilities {
  folderPicker: boolean;
  notifications: boolean;
  downloads: boolean;
  deepLinkEvents: boolean;
}

const NO_CAPABILITIES: NativeCapabilities = {
  folderPicker: false,
  notifications: false,
  downloads: false,
  deepLinkEvents: false
};

/**
 * The last answer the shell gave, so a click does not have to wait for a round trip to find out
 * whether there is anywhere to put a file. Undefined until the app has asked once, which is what
 * `save` below treats as "no shell has said no".
 */
let lastCapabilities: NativeCapabilities | undefined;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minuteOfClock = (value: string): number | null => {
  const parts = CLOCK.exec(value);
  return parts ? Number(parts[1]) * 60 + Number(parts[2]) : null;
};

const minuteOfLocalDay = (timeZone: string, at: Date): number => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(at);
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value ?? 0);
  return value('hour') * 60 + value('minute');
};

/**
 * Whether a moment falls inside the owner's quiet hours, in the owner's own zone.
 *
 * The same reading as `inQuietHours` in `services/notifications/src/policy.ts`, deliberately: the
 * owner sets one window on one screen, and a phone that goes quiet at a different minute from the
 * push path would be a second, invisible setting. A window that wraps midnight is two ranges either
 * side of it, and an unknown zone is treated as no quiet hours rather than as an error — the one
 * thing this must never do is go silent because of a typo in a text field.
 */
export const insideQuietHours = (
  settings: Pick<NotificationSettings, 'quietHoursStart' | 'quietHoursEnd' | 'timeZone'>,
  at: Date
): boolean => {
  const start = settings.quietHoursStart ? minuteOfClock(settings.quietHoursStart) : null;
  const end = settings.quietHoursEnd ? minuteOfClock(settings.quietHoursEnd) : null;
  if (start === null || end === null || start === end) return false;
  let minute: number;
  try {
    minute = minuteOfLocalDay(settings.timeZone, at);
  } catch {
    return false;
  }
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
};

/**
 * Whether the packaged shell may ring about this, given what the owner asked for.
 *
 * This is the half of the notification settings screen that had no reader. Quiet hours and the
 * per-kind switches were stored, and applied on the Web Push delivery path — which is the one path
 * a packaged shell has no subscription on and never will. So an owner set 22:00–07:00, unticked a
 * kind, saved, and the installed application rang anyway, from a screen that said it would not.
 *
 * A box with no settings route at all answers `null`, and that means every kind at any hour: it has
 * never been told otherwise, and inventing a silence nobody asked for would be the same defect
 * pointing the other way.
 */
export const ringsNatively = (input: {
  kind: NotificationKind;
  settings: NotificationSettings | null;
  at?: Date;
}): boolean => {
  const settings = input.settings;
  if (!settings) return true;
  if (!settings.kinds[input.kind]) return false;
  if (!insideQuietHours(settings, input.at ?? new Date())) return true;
  // The one exception the owner is offered by name, and the reason it exists: the agent is stopped
  // until somebody answers, so a silent night is a night nothing got done.
  return input.kind === 'approvalRequired' && settings.quietHoursAllowApprovals;
};

/** The one click every "hand this file over" path ends in, so the five of them cannot drift. */
const clickAnchor = (name: string, href: string): void => {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
};

/**
 * Has a shell told us there is nowhere to put a file — asking it now if nobody has yet?
 *
 * `save` below reads `lastCapabilities` without waiting, and for App.tsx that is right: the
 * conversation menu is behind a running session and App probed on mount, so the answer is in hand
 * long before the press. It is wrong for the screen that matters most. The recovery code is handed
 * over by `Auth.tsx`, which is what the owner sees *instead of* the app shell — nothing has probed
 * yet, `lastCapabilities` is `undefined`, and the guard whose whole purpose is to stop a silent
 * no-op waves the click straight through into one. So the async callers ask first. It costs one
 * IPC round trip on the first press of a packaged client and nothing at all afterwards, because
 * `capabilities()` caches into the same variable.
 *
 * A browser reaches `core()` as undefined and is never blocked: this has always been an ordinary
 * anchor click there and still is.
 */
const downloadsRefused = async (): Promise<boolean> => {
  if (!core()) return false;
  if (!lastCapabilities) await nativeBridge.capabilities();
  return lastCapabilities?.downloads === false;
};

/**
 * The one sentence every refused download says, so that five screens cannot each invent their own.
 *
 * Callers append the way out that is true of their own screen — copy the code, use a browser — and
 * that second half is the part worth writing per site. This half is the fact: the shell registered
 * no download handler, and no amount of pressing will change that.
 */
export const DOWNLOAD_UNAVAILABLE = 'This app cannot save files on this device.';

/**
 * What the two recovery-code screens say when the file cannot be written.
 *
 * Shared between `Auth.tsx` and `SelfHostedSettings.tsx` deliberately: they are the same fact about
 * the same string, the string is shown exactly once, and it cannot be produced again from anywhere.
 * Two copies of this sentence would be two chances for one of them to stop naming the way out.
 */
export const DOWNLOAD_UNAVAILABLE_RECOVERY_CODE = `${DOWNLOAD_UNAVAILABLE} Copy the code above and keep it somewhere safe — it is not shown again.`;

/** A file the box will serve again if asked, so the way out is the browser rather than the clock. */
export const DOWNLOAD_UNAVAILABLE_FILE = `${DOWNLOAD_UNAVAILABLE} Open athanor in a browser to download it.`;

export const nativeBridge = {
  available: () => Boolean(core()),
  capabilities: async (): Promise<NativeCapabilities> => {
    const bridge = core();
    if (!bridge) return NO_CAPABILITIES;
    try {
      const answer = await bridge.invoke<Partial<NativeCapabilities>>('native_capabilities');
      lastCapabilities = { ...NO_CAPABILITIES, ...answer };
      return lastCapabilities;
    } catch {
      return NO_CAPABILITIES;
    }
  },
  chooseFolder: () => core()?.invoke<{ token: string; name: string } | null>('choose_folder'),
  revokeFolder: (token: string) => core()?.invoke('revoke_folder', { token }),
  listFolder: (token: string, relative = '') =>
    core()?.invoke<
      Array<{ name: string; relativePath: string; isDirectory: boolean; sizeBytes: number }>
    >('list_local_folder', { token, relative }),
  readFile: (token: string, relative: string) =>
    core()?.invoke<number[]>('read_local_file', { token, relative }),
  /**
   * Hand the owner a file, and say whether anything was there to receive it.
   *
   * Six flows in the product are an `<a download>` on a blob, and the recovery code is the one that
   * cannot be produced again afterwards. On the three desktop webviews the shell now accepts the
   * download and writes it to the platform Downloads directory; on Android and iOS it reports
   * `downloads: false`, because wry registers no download support there and iOS has no
   * user-visible Downloads directory to write into. `false` from here is a caller's cue to say so
   * rather than to draw a button that does nothing — which is what all six did.
   *
   * A browser is always true: this is the ordinary anchor click, which is what it has always been.
   */
  save: (name: string, blob: Blob): boolean => {
    if (core() && lastCapabilities?.downloads === false) return false;
    const url = URL.createObjectURL(blob);
    clickAnchor(name, url);
    URL.revokeObjectURL(url);
    return true;
  },
  /**
   * `save`, having asked the shell first rather than assuming nobody has said no.
   *
   * The four remaining blob downloads are on screens that can be reached before `App.tsx` has ever
   * mounted — the recovery code at first sign-in is the whole reason this exists — so the cached
   * answer `save` reads may not have been fetched yet. On a packaged client that has never been
   * asked, `save` would return `true`, click an anchor WKWebView and WebKitGTK ignore, and leave
   * the caller reporting success for a file that was never written. For the recovery code that is
   * the one mistake in this product with nothing behind it: the string is shown once and cannot be
   * produced again.
   */
  saveFile: async (name: string, blob: Blob): Promise<boolean> => {
    if (await downloadsRefused()) return false;
    const url = URL.createObjectURL(blob);
    clickAnchor(name, url);
    URL.revokeObjectURL(url);
    return true;
  },
  /**
   * The same promise for a file the box will serve from a URL rather than one already in the page.
   *
   * The artifact card and the sent-attachment strip point an `<a download>` at a route on this
   * origin; there is no blob to hand to `saveFile` and fetching one only to hand it back would
   * download every artifact twice. What they need is the same question answered — is there
   * anywhere for this to land — and the same anchor click when the answer is yes.
   */
  saveFromUrl: async (name: string, href: string): Promise<boolean> => {
    if (await downloadsRefused()) return false;
    clickAnchor(name, href);
    return true;
  },
  /**
   * Raise a notification through the operating system rather than through Web Push.
   *
   * A packaged shell has no push subscription and never will: delivery was Web Push only, so on
   * desktop and mobile the box could tell the owner nothing at all. It does not need a delivery
   * route of its own - it is already polling for approvals and notices - so it raises the
   * notification locally when something arrives and the window is not being looked at.
   *
   * It does ask the operating system for permission when it has not been granted, and that is safe
   * again because of who is allowed to reach it. The settings screen calls this from the press that
   * turns notifications on, which is the gesture the prompt belongs to. The poll behind the screen
   * will not reach it at all until `nativeNotificationsEnabled()` says that press happened — which
   * is the repair for a screen that told the owner notifications were impossible here and then
   * raised a system dialog from a timer at a moment nobody had chosen.
   */
  notify: async (title: string, body: string): Promise<boolean> => {
    const bridge = core();
    if (!bridge) return false;
    try {
      const granted = await bridge.invoke<boolean>('plugin:notification|is_permission_granted');
      if (!granted) {
        const outcome = await bridge.invoke<string>('plugin:notification|request_permission');
        if (outcome !== 'granted') return false;
      }
      await bridge.invoke('plugin:notification|notify', { options: { title, body } });
      return true;
    } catch {
      // A shell built without the plugin, or a platform that refused: the in-app notice is still
      // there, and there is nothing here worth interrupting anybody with.
      return false;
    }
  }
};
