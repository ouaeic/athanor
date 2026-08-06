/**
 * The owner's notification preferences, as a form and as a request.
 *
 * Kept apart from the settings screen for the same reason the spending caps are: an empty field
 * and an impossible window should produce a sentence the owner can act on, not a 400 they cannot
 * read, and that is worth testing without rendering anything.
 */
export type NotificationKind =
  | 'approvalRequired'
  | 'taskFinished'
  | 'spendPaused'
  | 'agentMessage'
  | 'takeoverNeeded';

/**
 * Every switch this screen knows how to draw, in the order it draws them: the three the box raises
 * from its own state first, then the two the agent decides for itself.
 */
export const notificationKinds: NotificationKind[] = [
  'approvalRequired',
  'taskFinished',
  'spendPaused',
  'agentMessage',
  'takeoverNeeded'
];

export interface NotificationSettings {
  kinds: Record<NotificationKind, boolean>;
  /**
   * The kinds this box actually stores. A switch for a kind the box will strip from the request
   * would save, come back unchanged, and quietly do nothing - so it is not drawn at all.
   */
  supported: NotificationKind[];
  /** Local wall-clock "HH:MM" in the owner's own zone, or null for no quiet hours. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursAllowApprovals: boolean;
  /**
   * Echoed by the server from the spending caps. Read-only here: there is one answer to "when does
   * my day roll over" on this box, and it is edited in one place.
   */
  timeZone: string;
}

export interface NotificationSettingsDraft {
  kinds: Record<NotificationKind, boolean>;
  supported: NotificationKind[];
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursAllowApprovals: boolean;
}

export interface UpdateNotificationSettingsRequest {
  kinds: Partial<Record<NotificationKind, boolean>>;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursAllowApprovals: boolean;
}

const allKindsOn = (): Record<NotificationKind, boolean> => ({
  approvalRequired: true,
  taskFinished: true,
  spendPaused: true,
  agentMessage: true,
  takeoverNeeded: true
});

/** Every kind on, no quiet hours: what a box that has never been configured must behave like. */
export const defaultNotificationSettings = (timeZone = 'UTC'): NotificationSettings => ({
  kinds: allKindsOn(),
  supported: [...notificationKinds],
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursAllowApprovals: true,
  timeZone
});

/**
 * Reads the settings the box actually sent.
 *
 * `supported` comes from the response rather than from this file, because the switches and the
 * route ship separately: a box that names three kinds gets three switches and a request carrying
 * exactly those three, and gains the other two the day it starts naming them.
 */
export const notificationSettingsFromResponse = (payload: unknown): NotificationSettings => {
  const body = (payload ?? {}) as Record<string, unknown>;
  const kinds = (body.kinds ?? {}) as Record<string, unknown>;
  const supported = notificationKinds.filter((kind) => typeof kinds[kind] === 'boolean');
  const timeZone = typeof body.timeZone === 'string' ? body.timeZone : 'UTC';
  const clock = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    kinds: Object.fromEntries(
      notificationKinds.map((kind) => [kind, kinds[kind] !== false])
    ) as Record<NotificationKind, boolean>,
    supported: supported.length ? supported : [...notificationKinds],
    quietHoursStart: clock(body.quietHoursStart),
    quietHoursEnd: clock(body.quietHoursEnd),
    quietHoursAllowApprovals: body.quietHoursAllowApprovals !== false,
    timeZone
  };
};

export const notificationSettingsDraft = (
  settings: NotificationSettings
): NotificationSettingsDraft => ({
  kinds: { ...settings.kinds },
  supported: [...settings.supported],
  quietHoursEnabled: Boolean(settings.quietHoursStart && settings.quietHoursEnd),
  quietHoursStart: settings.quietHoursStart ?? '22:00',
  quietHoursEnd: settings.quietHoursEnd ?? '07:00',
  quietHoursAllowApprovals: settings.quietHoursAllowApprovals
});

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const requestedKinds = (
  draft: NotificationSettingsDraft
): Partial<Record<NotificationKind, boolean>> =>
  Object.fromEntries(draft.supported.map((kind) => [kind, draft.kinds[kind]]));

export const notificationSettingsPatch = (
  draft: NotificationSettingsDraft
): { ok: true; body: UpdateNotificationSettingsRequest } | { ok: false; message: string } => {
  if (!draft.quietHoursEnabled)
    return {
      ok: true,
      body: {
        kinds: requestedKinds(draft),
        quietHoursStart: null,
        quietHoursEnd: null,
        quietHoursAllowApprovals: draft.quietHoursAllowApprovals
      }
    };
  if (!CLOCK.test(draft.quietHoursStart) || !CLOCK.test(draft.quietHoursEnd))
    return {
      ok: false,
      message: 'Quiet hours need a start and an end time, like 22:00 and 07:00.'
    };
  if (draft.quietHoursStart === draft.quietHoursEnd)
    return {
      ok: false,
      message: 'Quiet hours that start and end at the same minute would never be quiet.'
    };
  return {
    ok: true,
    body: {
      kinds: requestedKinds(draft),
      quietHoursStart: draft.quietHoursStart,
      quietHoursEnd: draft.quietHoursEnd,
      quietHoursAllowApprovals: draft.quietHoursAllowApprovals
    }
  };
};

/** What each switch is, in the words of what arrives on the phone when it is on. */
export const notificationKindCopy: Record<
  NotificationKind,
  { label: string; detail: string; short: string }
> = {
  approvalRequired: {
    label: 'Approvals',
    detail:
      'athanor is stopped until you answer. You can approve or deny straight from the notification.',
    short: 'approvals'
  },
  taskFinished: {
    label: 'Finished work',
    detail: 'Whether it worked, and what it cost. Scheduled runs stay quiet unless they speak up.',
    short: 'finished work'
  },
  spendPaused: {
    label: 'Spending limits',
    detail: 'When work stops at a dollar ceiling only you can raise.',
    short: 'spending limits'
  },
  agentMessage: {
    label: 'What athanor decides to tell you',
    detail:
      'The agent writes these itself, in its own words, when something it was watching for happened. This is what a watcher is for.',
    short: 'its own messages'
  },
  takeoverNeeded: {
    label: 'When it needs you at the computer',
    detail:
      'A page has asked for a person and athanor will not answer that on your behalf. The work waits until you clear it.',
    short: 'handovers'
  }
};

/**
 * One sentence saying what the current form will actually do, because "quiet hours" plus a column
 * of switches is exactly the kind of setting people get wrong and only discover months later.
 */
export const notificationSettingsSummary = (
  draft: NotificationSettingsDraft,
  timeZone: string
): string => {
  const on = draft.supported
    .filter((kind) => draft.kinds[kind])
    .map((kind) => notificationKindCopy[kind].short);
  if (!on.length) return 'Nothing will be sent to your devices.';
  const list =
    on.length === 1 ? on[0] : `${on.slice(0, -1).join(', ')} and ${on[on.length - 1] ?? ''}`;
  const base = `Sends ${list}`;
  if (!draft.quietHoursEnabled) return `${base}, at any hour.`;
  const window = `${draft.quietHoursStart}–${draft.quietHoursEnd} ${timeZone}`;
  if (!draft.kinds.approvalRequired || !draft.quietHoursAllowApprovals)
    return `${base}, silent between ${window}.`;
  return `${base}. Between ${window} only approvals come through, because athanor is stopped until you answer one.`;
};
