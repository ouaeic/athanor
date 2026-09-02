import { api } from './api.js';

export type NotificationState =
  | 'checking'
  | 'unsupported'
  | 'unavailable'
  | 'denied'
  | 'disabled'
  | 'enabled'
  /** The browser has no service worker for this origin, which on a default install means the
      certificate was refused. Distinct from `unsupported`, which is about the browser. */
  | 'unregistered'
  /** An iPhone or iPad in a Safari tab, where the owner is one gesture away from the best
      notification experience athanor offers. Distinct from `unsupported`, which is the same
      missing `PushManager` with nothing the owner can do about it. */
  | 'needs_install';

/**
 * The registration, or an answer.
 *
 * `navigator.serviceWorker.ready` never settles when registration failed - it does not reject, it
 * simply waits - and on the certificate this installer ships by default registration always fails.
 * So the section sat on 'checking' for ever: a disabled button with no reason on it, under a
 * sentence inviting the owner to turn on something that could not be turned on. Bounded, so the
 * screen reaches a state it can explain.
 */
const REGISTRATION_WAIT_MS = 5_000;

const readyRegistration = async (): Promise<ServiceWorkerRegistration | null> =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), REGISTRATION_WAIT_MS))
  ]);

const applicationServerKey = (value: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

const supported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * An iPhone or iPad whose owner has not put athanor on the Home Screen yet.
 *
 * Safari on iOS has had Web Push since 16.4, but only for a web app launched from the Home
 * Screen: in a tab there is no `PushManager` at all, so `supported()` is false and this screen
 * said "This browser cannot receive push notifications" - blaming the browser for the one thing
 * in this whole state machine the owner can fix themselves, in a single gesture, and arriving at
 * an installed PWA which is the best notification experience athanor has on a phone.
 *
 * Two signals, ANDed, and each is here for its own reason.
 *
 * The device shape is a user-agent test because there is no feature to ask for: what is being
 * detected is "Add to Home Screen exists on this menu", which is a property of the shell rather
 * than of the page. iPadOS reports itself as Macintosh and is told apart by having touch points,
 * which is the same pair every other library uses for the same reason. It over-matches an
 * in-app browser (a link opened inside a messaging app), where the repair is really "open this
 * in Safari first" - the sentence still points at the right end state, and there is no signal
 * that separates the two that does not rot faster than this one.
 *
 * Standalone is checked because on iOS 16.3 and earlier a Home Screen web app has no PushManager
 * either, and telling an owner who has already installed it to install it is worse than saying
 * nothing. `navigator.standalone` is WebKit's own answer and is the only one an iOS Home Screen
 * app sets reliably; the display-mode query is the standard one and covers the rest.
 *
 * This does NOT promise that installing will work: iOS below 16.4 will still have no PushManager
 * afterwards, and this returns `unsupported` for that owner only once they are standalone.
 */
export const needsHomeScreenInstall = (): boolean => {
  const agent = globalThis.navigator?.userAgent ?? '';
  const touchPoints = globalThis.navigator?.maxTouchPoints ?? 0;
  const appleTouchDevice =
    /iPad|iPhone|iPod/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1);
  if (!appleTouchDevice) return false;
  const webkitStandalone = (globalThis.navigator as { standalone?: boolean } | undefined)
    ?.standalone;
  const displayMode = globalThis.window?.matchMedia?.('(display-mode: standalone)').matches;
  return webkitStandalone !== true && displayMode !== true;
};

/** Which of the two "there is no PushManager here" answers this device has earned. */
const unsupportedState = (): NotificationState =>
  needsHomeScreenInstall() ? 'needs_install' : 'unsupported';

export const notificationState = async (): Promise<NotificationState> => {
  if (!supported()) return unsupportedState();
  const config = await api.notificationConfig();
  if (!config.enabled || !config.publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await readyRegistration();
  if (!registration) return 'unregistered';
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return 'disabled';
  await api.subscribeNotifications(subscription.toJSON());
  return 'enabled';
};

export const enableNotifications = async (): Promise<NotificationState> => {
  if (!supported()) return unsupportedState();
  const config = await api.notificationConfig();
  if (!config.enabled || !config.publicKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';
  const registration = await readyRegistration();
  if (!registration) return 'unregistered';
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(config.publicKey)
    }));
  await api.subscribeNotifications(subscription.toJSON());
  return 'enabled';
};

export const disableNotifications = async (): Promise<NotificationState> => {
  if (!supported()) return unsupportedState();
  const registration = await readyRegistration();
  if (!registration) return 'unregistered';
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribeNotifications(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return 'disabled';
};
