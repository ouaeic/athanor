/**
 * What the packaged shell is allowed to ring about.
 *
 * The deep-link cases that used to be here are gone with `nativeTarget`: the listener that fed it
 * read `window.__TAURI__.deepLink`, which this app does not bundle, so it could never fire — and
 * the shell now reports `deepLinkEvents: false` and navigates the window itself, validating the
 * link in Rust before it goes anywhere. What is left is the decision that actually reaches an
 * owner at three in the morning.
 */
import { describe, expect, it } from 'vitest';
import { insideQuietHours, ringsNatively } from './native.js';
import type { NotificationSettings } from './notification-settings.js';

const settings = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({
  kinds: {
    approvalRequired: true,
    taskFinished: true,
    spendPaused: true,
    agentMessage: true,
    takeoverNeeded: true
  },
  supported: ['approvalRequired', 'taskFinished', 'spendPaused', 'agentMessage', 'takeoverNeeded'],
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursAllowApprovals: true,
  timeZone: 'Europe/London',
  ...patch
});

/** 23:30 and 09:00 UTC, which are the same two clock times in Europe/London in January. */
const night = new Date('2026-01-15T23:30:00Z');
const morning = new Date('2026-01-15T09:00:00Z');

const overnight = { quietHoursStart: '22:00', quietHoursEnd: '07:00' };

describe('quiet hours, read in the zone the owner set them in', () => {
  it('is nothing at all when no window has been set', () => {
    expect(insideQuietHours(settings(), night)).toBe(false);
  });

  it('covers a window that wraps midnight, on both sides of it', () => {
    const overnightSettings = settings(overnight);
    expect(insideQuietHours(overnightSettings, night)).toBe(true);
    expect(insideQuietHours(overnightSettings, new Date('2026-01-15T03:00:00Z'))).toBe(true);
    expect(insideQuietHours(overnightSettings, morning)).toBe(false);
  });

  it('covers a window inside one day without wrapping', () => {
    const lunchtime = settings({ quietHoursStart: '12:00', quietHoursEnd: '14:00' });
    expect(insideQuietHours(lunchtime, new Date('2026-01-15T13:00:00Z'))).toBe(true);
    expect(insideQuietHours(lunchtime, morning)).toBe(false);
  });

  it('reads the clock where the owner is, not where the box is', () => {
    // 23:30 UTC is 18:30 in New York, which is outside the same 22:00-07:00 window.
    expect(insideQuietHours(settings({ ...overnight, timeZone: 'America/New_York' }), night)).toBe(
      false
    );
  });

  /*
   * The one thing this must never do is go quiet because of a typo in a text field, which is the
   * same reasoning `inQuietHours` in the notifications service records for its own catch.
   */
  it('treats a zone it cannot read as no quiet hours rather than as silence', () => {
    expect(insideQuietHours(settings({ ...overnight, timeZone: 'Mars/Olympus' }), night)).toBe(
      false
    );
  });

  it('is nothing when the window starts and ends at the same minute, which would never be quiet', () => {
    expect(
      insideQuietHours(settings({ quietHoursStart: '22:00', quietHoursEnd: '22:00' }), night)
    ).toBe(false);
  });
});

describe('whether the packaged shell may ring', () => {
  it('rings for every kind at any hour on a box that has never been told otherwise', () => {
    expect(ringsNatively({ kind: 'agentMessage', settings: null, at: night })).toBe(true);
  });

  it('stays silent for a kind the owner unticked', () => {
    const off = settings({
      kinds: { ...settings().kinds, agentMessage: false }
    });
    expect(ringsNatively({ kind: 'agentMessage', settings: off, at: morning })).toBe(false);
    expect(ringsNatively({ kind: 'taskFinished', settings: off, at: morning })).toBe(true);
  });

  it('stays silent inside quiet hours', () => {
    expect(ringsNatively({ kind: 'taskFinished', settings: settings(overnight), at: night })).toBe(
      false
    );
  });

  /* The exception the screen offers by name: the agent is stopped until somebody answers one. */
  it('lets an approval through quiet hours when the owner said it may', () => {
    expect(
      ringsNatively({ kind: 'approvalRequired', settings: settings(overnight), at: night })
    ).toBe(true);
    expect(
      ringsNatively({
        kind: 'approvalRequired',
        settings: settings({ ...overnight, quietHoursAllowApprovals: false }),
        at: night
      })
    ).toBe(false);
  });

  it('still refuses an approval the owner unticked, however the quiet hours read', () => {
    expect(
      ringsNatively({
        kind: 'approvalRequired',
        settings: settings({
          ...overnight,
          kinds: { ...settings().kinds, approvalRequired: false }
        }),
        at: morning
      })
    ).toBe(false);
  });
});
