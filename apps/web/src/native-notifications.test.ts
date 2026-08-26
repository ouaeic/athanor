/**
 * Whether the packaged app may interrupt this device.
 *
 * The default matters more than the storage: the old path asked the operating system for permission
 * from a background poll with no press behind it, so the owner met a system prompt at a moment they
 * had not chosen, from a screen that had just told them it was impossible. Off until asked for is
 * what makes the prompt follow a gesture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeNotificationsEnabled,
  setNativeNotificationsEnabled
} from './native-notifications.js';

const store = new Map<string, string>();

const withStorage = (): void => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    }
  });
};

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe('whether the packaged app may interrupt this device', () => {
  it('is off until somebody presses the button', () => {
    withStorage();
    expect(nativeNotificationsEnabled()).toBe(false);
  });

  it('remembers both answers, so turning it off is as durable as turning it on', () => {
    withStorage();
    setNativeNotificationsEnabled(true);
    expect(nativeNotificationsEnabled()).toBe(true);
    setNativeNotificationsEnabled(false);
    expect(nativeNotificationsEnabled()).toBe(false);
  });

  /*
   * A shell with storage partitioned or refused reads as off rather than throwing, because being
   * wrong in the silent direction costs a missed notice and being wrong the other way wakes
   * somebody who never agreed to it.
   */
  it('stays silent rather than throwing when the device has no storage to answer from', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      }
    });
    expect(nativeNotificationsEnabled()).toBe(false);
    expect(() => setNativeNotificationsEnabled(true)).not.toThrow();
  });
});
