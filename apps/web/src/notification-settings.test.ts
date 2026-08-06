import { describe, expect, it } from 'vitest';
import {
  defaultNotificationSettings,
  notificationSettingsDraft,
  notificationSettingsFromResponse,
  notificationSettingsPatch,
  notificationSettingsSummary,
  type NotificationSettingsDraft
} from './notification-settings.js';

const draft = (overrides: Partial<NotificationSettingsDraft> = {}): NotificationSettingsDraft => ({
  ...notificationSettingsDraft(defaultNotificationSettings('Europe/London')),
  ...overrides
});

/** The three kinds a box that predates the agent-raised ones reports. */
const olderBox = {
  kinds: { approvalRequired: true, taskFinished: true, spendPaused: true },
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursAllowApprovals: true,
  timeZone: 'Europe/London'
};

describe('notificationSettingsDraft', () => {
  it('offers a sensible night when the owner has never set one', () => {
    const form = notificationSettingsDraft(defaultNotificationSettings('Europe/London'));
    expect(form.quietHoursEnabled).toBe(false);
    expect(form.quietHoursStart).toBe('22:00');
    expect(form.quietHoursEnd).toBe('07:00');
  });

  it('reads back a stored window as enabled', () => {
    const form = notificationSettingsDraft({
      ...defaultNotificationSettings('Europe/London'),
      quietHoursStart: '23:30',
      quietHoursEnd: '06:15'
    });
    expect(form).toMatchObject({
      quietHoursEnabled: true,
      quietHoursStart: '23:30',
      quietHoursEnd: '06:15'
    });
  });
});

describe('notificationSettingsFromResponse', () => {
  it('carries the five kinds a current box reports', () => {
    const settings = notificationSettingsFromResponse({
      ...olderBox,
      kinds: { ...olderBox.kinds, agentMessage: false, takeoverNeeded: true }
    });
    expect(settings.supported).toEqual([
      'approvalRequired',
      'taskFinished',
      'spendPaused',
      'agentMessage',
      'takeoverNeeded'
    ]);
    expect(settings.kinds.agentMessage).toBe(false);
  });

  it('offers no switch for a kind the box would silently drop', () => {
    const settings = notificationSettingsFromResponse(olderBox);
    expect(settings.supported).toEqual(['approvalRequired', 'taskFinished', 'spendPaused']);
    // Absent from the response is not "off": the box sends those kinds, it just cannot store a
    // preference about them, and a switch drawn as off would be a lie in the other direction.
    expect(settings.kinds.takeoverNeeded).toBe(true);
  });
});

describe('notificationSettingsPatch', () => {
  it('clears the window explicitly rather than omitting it, so quiet hours can be removed', () => {
    const patch = notificationSettingsPatch(draft({ quietHoursEnabled: false }));
    expect(patch).toEqual({
      ok: true,
      body: {
        kinds: {
          approvalRequired: true,
          taskFinished: true,
          spendPaused: true,
          agentMessage: true,
          takeoverNeeded: true
        },
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursAllowApprovals: true
      }
    });
  });

  it('sends only the kinds the box knows about', () => {
    const patch = notificationSettingsPatch(
      notificationSettingsDraft(notificationSettingsFromResponse(olderBox))
    );
    expect(patch.ok && patch.body.kinds).toEqual({
      approvalRequired: true,
      taskFinished: true,
      spendPaused: true
    });
  });

  it('accepts a window that wraps midnight, which is the one people actually want', () => {
    const patch = notificationSettingsPatch(
      draft({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' })
    );
    expect(patch.ok).toBe(true);
  });

  it('turns a malformed or empty time into a sentence instead of a 400', () => {
    expect(
      notificationSettingsPatch(draft({ quietHoursEnabled: true, quietHoursStart: '' }))
    ).toEqual({
      ok: false,
      message: 'Quiet hours need a start and an end time, like 22:00 and 07:00.'
    });
    expect(
      notificationSettingsPatch(draft({ quietHoursEnabled: true, quietHoursStart: '25:00' }))
    ).toMatchObject({ ok: false });
  });

  it('refuses a window with no width', () => {
    expect(
      notificationSettingsPatch(
        draft({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '22:00' })
      )
    ).toEqual({
      ok: false,
      message: 'Quiet hours that start and end at the same minute would never be quiet.'
    });
  });

  it('carries the per-kind switches through untouched', () => {
    const patch = notificationSettingsPatch(
      draft({
        kinds: {
          approvalRequired: true,
          taskFinished: false,
          spendPaused: true,
          agentMessage: false,
          takeoverNeeded: true
        }
      })
    );
    expect(patch.ok && patch.body.kinds).toMatchObject({
      taskFinished: false,
      agentMessage: false,
      takeoverNeeded: true
    });
  });
});

describe('notificationSettingsSummary', () => {
  it('says plainly when the owner has switched everything off', () => {
    expect(
      notificationSettingsSummary(
        draft({
          kinds: {
            approvalRequired: false,
            taskFinished: false,
            spendPaused: false,
            agentMessage: false,
            takeoverNeeded: false
          }
        }),
        'Europe/London'
      )
    ).toBe('Nothing will be sent to your devices.');
  });

  it('lists what is on and says there is no quiet window', () => {
    expect(notificationSettingsSummary(draft(), 'Europe/London')).toBe(
      'Sends approvals, finished work, spending limits, its own messages and handovers, at any hour.'
    );
  });

  it('lists only what an older box can actually act on', () => {
    expect(
      notificationSettingsSummary(
        notificationSettingsDraft(notificationSettingsFromResponse(olderBox)),
        'Europe/London'
      )
    ).toBe('Sends approvals, finished work and spending limits, at any hour.');
  });

  it('explains why approvals still come through at night', () => {
    expect(
      notificationSettingsSummary(draft({ quietHoursEnabled: true }), 'Europe/London')
    ).toContain('Between 22:00–07:00 Europe/London only approvals come through');
  });

  it('does not promise approvals at night when the owner asked for silence', () => {
    expect(
      notificationSettingsSummary(
        draft({ quietHoursEnabled: true, quietHoursAllowApprovals: false }),
        'Europe/London'
      )
    ).toContain('silent between 22:00–07:00 Europe/London.');
  });

  it('reads correctly with a single kind left on', () => {
    expect(
      notificationSettingsSummary(
        draft({
          kinds: {
            approvalRequired: true,
            taskFinished: false,
            spendPaused: false,
            agentMessage: false,
            takeoverNeeded: false
          }
        }),
        'UTC'
      )
    ).toBe('Sends approvals, at any hour.');
  });
});
