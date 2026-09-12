import { clearDeviceDrafts, forgetDraftKey } from '../draft-storage.js';
import { signOut } from '../auth.js';
import { del } from '../client.js';
import { sensitive } from '../management.js';

export async function signOutThisDevice(): Promise<void> {
  const result = await signOut();
  if (!result.ok) throw new Error('This device could not be signed out. Try again.');
  await clearDeviceDrafts().catch(() => undefined);
  forgetDraftKey();
  window.location.reload();
}

export async function revokeDeviceSession(id: string, refresh: () => void): Promise<void> {
  const result = await sensitive(() => del<{ current: boolean }>(`/v1/sessions/${id}`));
  if (result.current) {
    await clearDeviceDrafts().catch(() => undefined);
    forgetDraftKey();
    window.location.reload();
  } else refresh();
}
