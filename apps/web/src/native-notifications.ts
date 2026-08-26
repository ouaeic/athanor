/**
 * Whether the packaged app may interrupt this device, held on the device it is about.
 *
 * The browser's notification switch is a subscription on the server: it is a row the box can look
 * up before it sends anything, and turning it off anywhere turns it off everywhere. A packaged
 * shell has no subscription and never will — it raises the notification itself, from a poll it is
 * already running — so there is nothing on the server that could be switched. The preference has to
 * live here, next to the only code that would raise one.
 *
 * This is deliberately not a mirror of the server's notification settings. Quiet hours and the
 * per-kind switches are still the owner's answer to *what* is worth interrupting them for and are
 * still stored on the box; this is the coarser question of whether this particular installation may
 * interrupt them at all, which is the question the OS asks and which nothing was answering.
 */

const STORAGE_KEY = 'athanor.native-notifications';

/**
 * Off until it is asked for.
 *
 * The old path requested OS permission from a background poll with no user gesture, so the first an
 * owner knew about it was an unexplained system prompt at a moment they did not choose. Defaulting
 * to off means the prompt can only ever follow a press.
 */
export const nativeNotificationsEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    // A shell with storage partitioned or disabled: nothing rings, which is the safe way to be
    // wrong about whether somebody agreed to be woken up.
    return false;
  }
};

export const setNativeNotificationsEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Nothing to do and nothing worth saying: the press still took effect for this window, and the
    // screen reads the same value back through the state it just set.
  }
};
