/**
 * The one sentence an iPhone owner gets in their first five minutes.
 *
 * An iOS Safari tab has no `PushManager`, so `notificationState()` answered `unsupported` and the
 * settings screen said "This browser cannot receive push notifications" over a dead button. Web
 * Push has worked on iOS since 16.4 for a web app opened from the Home Screen, so the browser was
 * being blamed for something the owner fixes with two taps - and an installed athanor is the best
 * notification experience this product has on a phone.
 *
 * These cases pin the discrimination, not the wording: which devices earn the instruction, and
 * which must not be given it. The globals are stubbed rather than mocked because that is exactly
 * what the function reads, and a stub that is wrong about the shape of `navigator` would be a test
 * that passes about a browser nobody has.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsHomeScreenInstall, notificationState } from './notifications.js';

/** Real strings, taken from the shells they name, because the test is a user-agent test. */
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPADOS_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const browser = (input: {
  agent: string;
  maxTouchPoints?: number;
  /** WebKit's own answer, `undefined` anywhere that is not an iOS Safari or Home Screen shell. */
  standalone?: boolean;
  displayMode?: boolean;
}): void => {
  vi.stubGlobal('navigator', {
    userAgent: input.agent,
    maxTouchPoints: input.maxTouchPoints ?? 0,
    ...(input.standalone === undefined ? {} : { standalone: input.standalone })
  });
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query.includes('standalone') && input.displayMode })
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('needsHomeScreenInstall', () => {
  it('claims an iPhone in a Safari tab, which is the whole point', () => {
    browser({ agent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: false });
    expect(needsHomeScreenInstall()).toBe(true);
  });

  it('claims an iPad, which reports itself as a Macintosh with fingers', () => {
    browser({ agent: IPADOS_SAFARI, maxTouchPoints: 5, standalone: false });
    expect(needsHomeScreenInstall()).toBe(true);
  });

  it('leaves a Mac alone, because the same string with no touch points is a desktop', () => {
    browser({ agent: MAC_SAFARI, maxTouchPoints: 0 });
    expect(needsHomeScreenInstall()).toBe(false);
  });

  it('leaves Android alone, where a missing PushManager means something else entirely', () => {
    browser({ agent: ANDROID_CHROME, maxTouchPoints: 5 });
    expect(needsHomeScreenInstall()).toBe(false);
  });

  /*
   * The reason the standalone half exists. On iOS 16.3 and earlier a Home Screen web app has no
   * PushManager either, so without this check the owner who already did the thing would be told to
   * go and do it - which reads as a broken app rather than as an old phone.
   */
  it('does not tell an owner who already installed it to install it', () => {
    browser({ agent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: true });
    expect(needsHomeScreenInstall()).toBe(false);
  });

  it('accepts the standard display-mode answer where WebKit does not give its own', () => {
    browser({ agent: IPHONE_SAFARI, maxTouchPoints: 5, displayMode: true });
    expect(needsHomeScreenInstall()).toBe(false);
  });

  /*
   * A packaged shell and a service-worker probe both run this before anything has painted, and
   * neither is obliged to have a `window` yet. Throwing here would take out `notificationState()`
   * itself, which is the function that decides whether the section can say anything at all.
   */
  it('answers rather than throwing where there is no window at all', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_SAFARI, maxTouchPoints: 5 });
    vi.stubGlobal('window', undefined);
    expect(needsHomeScreenInstall()).toBe(true);
  });

  it('answers rather than throwing where there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('window', undefined);
    expect(needsHomeScreenInstall()).toBe(false);
  });
});

/**
 * The helper above decides nothing on its own. This is the function the settings screen awaits,
 * and the only place the answer can actually reach an owner - a discriminator wired to nothing
 * looks exactly like one that works.
 */
describe('notificationState on a device with no PushManager', () => {
  it('sends an iPhone in a tab to the state that carries the instruction', async () => {
    vi.stubGlobal('navigator', {
      userAgent: IPHONE_SAFARI,
      maxTouchPoints: 5,
      standalone: false
    });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    await expect(notificationState()).resolves.toBe('needs_install');
  });

  it('leaves every other browser on the answer it already had', async () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID_CHROME, maxTouchPoints: 5 });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    await expect(notificationState()).resolves.toBe('unsupported');
  });
});
