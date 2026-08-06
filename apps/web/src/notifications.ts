import { api } from './api.js';

export type NotificationState =
  | 'checking'
  | 'unsupported'
  | 'unavailable'
  | 'denied'
  | 'disabled'
  | 'enabled';

const applicationServerKey = (value: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

const supported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const notificationState = async (): Promise<NotificationState> => {
  if (!supported()) return 'unsupported';
  const config = await api.notificationConfig();
  if (!config.enabled || !config.publicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return 'disabled';
  await api.subscribeNotifications(subscription.toJSON());
  return 'enabled';
};

export const enableNotifications = async (): Promise<NotificationState> => {
  if (!supported()) return 'unsupported';
  const config = await api.notificationConfig();
  if (!config.enabled || !config.publicKey) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';
  const registration = await navigator.serviceWorker.ready;
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
  if (!supported()) return 'unsupported';
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await api.unsubscribeNotifications(subscription.endpoint);
    await subscription.unsubscribe();
  }
  return 'disabled';
};
