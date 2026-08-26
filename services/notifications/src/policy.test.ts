import { describe, expect, it } from 'vitest';
import { defaultNotificationSettings, type OwnerNotificationSettings } from './model.js';
import { deliveryDecision, inQuietHours, MAX_HOLD_MS } from './policy.js';

const settings = (
  overrides: Partial<OwnerNotificationSettings> = {}
): OwnerNotificationSettings => ({ ...defaultNotificationSettings('Europe/London'), ...overrides });

const at = (iso: string) => new Date(iso);

describe('inQuietHours', () => {
  it('reads the clock in the owner’s zone, not the server’s', () => {
    const night = { startMinute: 22 * 60, endMinute: 7 * 60 };
    // 23:30 in London, 18:30 in New York: quiet for one owner and not the other, same instant.
    expect(inQuietHours(night, 'Europe/London', at('2026-07-31T22:30:00Z'))).toBe(true);
    expect(inQuietHours(night, 'America/New_York', at('2026-07-31T22:30:00Z'))).toBe(false);
  });

  it('handles a window that wraps midnight, which is the normal case', () => {
    const night = { startMinute: 22 * 60, endMinute: 7 * 60 };
    expect(inQuietHours(night, 'UTC', at('2026-07-31T23:59:00Z'))).toBe(true);
    expect(inQuietHours(night, 'UTC', at('2026-08-01T02:00:00Z'))).toBe(true);
    expect(inQuietHours(night, 'UTC', at('2026-08-01T07:00:00Z'))).toBe(false);
    expect(inQuietHours(night, 'UTC', at('2026-08-01T12:00:00Z'))).toBe(false);
  });

  it('handles a window inside one day', () => {
    const siesta = { startMinute: 13 * 60, endMinute: 15 * 60 };
    expect(inQuietHours(siesta, 'UTC', at('2026-07-31T14:00:00Z'))).toBe(true);
    expect(inQuietHours(siesta, 'UTC', at('2026-07-31T15:00:00Z'))).toBe(false);
    expect(inQuietHours(siesta, 'UTC', at('2026-07-31T23:00:00Z'))).toBe(false);
  });

  it('treats no window, an empty window and an unusable zone as "not quiet"', () => {
    expect(inQuietHours(null, 'UTC', at('2026-07-31T03:00:00Z'))).toBe(false);
    expect(
      inQuietHours({ startMinute: 60, endMinute: 60 }, 'UTC', at('2026-07-31T01:00:00Z'))
    ).toBe(false);
    // A typo in a text field must not be able to silence the whole service.
    expect(
      inQuietHours({ startMinute: 0, endMinute: 1439 }, 'Mars/Olympus', at('2026-07-31T03:00:00Z'))
    ).toBe(false);
  });
});

describe('deliveryDecision', () => {
  const now = at('2026-07-31T12:00:00Z');
  const eventAt = at('2026-07-31T11:59:00Z');

  it('sends when the owner is away and nothing is switched off', () => {
    expect(
      deliveryDecision({
        kind: 'task_finished',
        settings: settings(),
        ownerPresent: false,
        eventAt,
        now
      })
    ).toEqual({ action: 'send' });
  });

  it('drops a kind the owner switched off, so the server honours it rather than the device', () => {
    expect(
      deliveryDecision({
        kind: 'task_finished',
        settings: settings({
          kinds: {
            approval_required: true,
            task_finished: false,
            spend_paused: true,
            agent_message: true,
            takeover_needed: true
          }
        }),
        ownerPresent: false,
        eventAt,
        now
      })
    ).toEqual({ action: 'drop', reason: 'kind_disabled' });
  });

  it('does not wake a phone for something the owner is already watching', () => {
    expect(
      deliveryDecision({
        kind: 'task_finished',
        settings: settings(),
        ownerPresent: true,
        eventAt,
        now
      })
    ).toEqual({ action: 'drop', reason: 'foreground' });
  });

  it('holds a spend pause at a busy keyboard rather than writing it off', () => {
    // The one pause nobody chose. It is not a report that something finished - the box has stopped
    // and waits forever until a person raises the ceiling - so being at the screen is no reason to
    // decide the owner has already seen it. The data layer orders it on the same side: approval,
    // takeover, spend pause, "and the rest is news".
    expect(
      deliveryDecision({
        kind: 'spend_paused',
        settings: settings(),
        ownerPresent: true,
        eventAt,
        now
      })
    ).toEqual({ action: 'hold', reason: 'foreground' });
  });

  it('gives up on a foreground hold once it has stopped being news, as quiet hours already did', () => {
    // A hold writes nothing, so it is reconsidered on every pass for as long as the row is a
    // candidate - fourteen days. Only the quiet-hours arm had a horizon, so an owner who simply
    // keeps a tab open kept every held notice alive, and all of them would arrive at once.
    for (const kind of ['approval_required', 'takeover_needed', 'agent_message'] as const) {
      expect(
        deliveryDecision({
          kind,
          settings: settings(),
          ownerPresent: true,
          eventAt: new Date(now.getTime() - MAX_HOLD_MS),
          now
        })
      ).toEqual({ action: 'drop', reason: 'stale' });
    }
  });

  it('holds a foreground approval instead of writing it off, so it still arrives once they leave', () => {
    expect(
      deliveryDecision({
        kind: 'approval_required',
        settings: settings(),
        ownerPresent: true,
        eventAt,
        now
      })
    ).toEqual({ action: 'hold', reason: 'foreground' });
  });

  it('holds the two kinds the agent raises rather than dropping them at a busy keyboard', () => {
    // Being at the screen is not being in that conversation. A notice the owner asked for, and work
    // that has stopped until someone takes the browser, both still have to arrive.
    for (const kind of ['agent_message', 'takeover_needed'] as const) {
      expect(
        deliveryDecision({ kind, settings: settings(), ownerPresent: true, eventAt, now })
      ).toEqual({ action: 'hold', reason: 'foreground' });
    }
  });

  it('still lets the owner silence a kind the agent raises', () => {
    expect(
      deliveryDecision({
        kind: 'agent_message',
        settings: settings({
          kinds: {
            approval_required: true,
            task_finished: true,
            spend_paused: true,
            agent_message: false,
            takeover_needed: true
          }
        }),
        ownerPresent: false,
        eventAt,
        now
      })
    ).toEqual({ action: 'drop', reason: 'kind_disabled' });
  });

  it('does not give the agent’s kinds the approval carve-out through quiet hours', () => {
    const quiet = settings({ quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    const night = at('2026-08-01T01:00:00Z');
    for (const kind of ['agent_message', 'takeover_needed'] as const) {
      expect(
        deliveryDecision({ kind, settings: quiet, ownerPresent: false, eventAt: night, now: night })
      ).toEqual({ action: 'hold', reason: 'quiet_hours' });
    }
  });

  it('holds a status message during quiet hours', () => {
    const quiet = settings({ quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    const night = at('2026-08-01T01:00:00Z');
    expect(
      deliveryDecision({
        kind: 'task_finished',
        settings: quiet,
        ownerPresent: false,
        eventAt: night,
        now: night
      })
    ).toEqual({ action: 'hold', reason: 'quiet_hours' });
  });

  it('lets an approval through quiet hours by default, because the agent is stopped until it is answered', () => {
    const quiet = settings({ quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    const night = at('2026-08-01T01:00:00Z');
    expect(
      deliveryDecision({
        kind: 'approval_required',
        settings: quiet,
        ownerPresent: false,
        eventAt: night,
        now: night
      })
    ).toEqual({ action: 'send' });
    expect(
      deliveryDecision({
        kind: 'approval_required',
        settings: { ...quiet, quietHoursAllowApprovals: false },
        ownerPresent: false,
        eventAt: night,
        now: night
      })
    ).toEqual({ action: 'hold', reason: 'quiet_hours' });
  });

  it('gives up on a held message once it has stopped being news', () => {
    const quiet = settings({ quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    const night = at('2026-08-01T01:00:00Z');
    expect(
      deliveryDecision({
        kind: 'task_finished',
        settings: quiet,
        ownerPresent: false,
        eventAt: new Date(night.getTime() - MAX_HOLD_MS),
        now: night
      })
    ).toEqual({ action: 'drop', reason: 'stale' });
  });

  it('checks the switch before anything else, so an unwanted kind is never merely held', () => {
    const quiet = settings({
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
      kinds: {
        approval_required: true,
        task_finished: true,
        spend_paused: false,
        agent_message: true,
        takeover_needed: true
      }
    });
    const night = at('2026-08-01T01:00:00Z');
    expect(
      deliveryDecision({
        kind: 'spend_paused',
        settings: quiet,
        ownerPresent: true,
        eventAt: night,
        now: night
      })
    ).toEqual({ action: 'drop', reason: 'kind_disabled' });
  });
});
