import type { NotificationKind, OwnerNotificationSettings, QuietHours } from './model.js';

/**
 * How long after the owner's last request counts as "they are looking at it right now".
 *
 * The web client polls the open conversation and the approval list every three seconds while a
 * task is running, and every one of those requests touches the session, so a minute and a half is
 * comfortably longer than the gap between two polls and far shorter than "they walked away".
 */
export const PRESENCE_WINDOW_MS = 90_000;

/**
 * How long a message held by quiet hours is still worth sending.
 *
 * Held items are not recorded as delivered, so they are re-examined on every pass and would fire
 * the instant quiet hours ended — including the six that finished overnight. Past this age the
 * event has stopped being news and the ledger row is written without a push, which is also what
 * stops a held backlog from crowding the batch.
 */
export const MAX_HOLD_MS = 12 * 60 * 60 * 1000;

/**
 * What to do with one pending notification.
 *
 * `hold` deliberately writes nothing: the item stays pending and is reconsidered on the next pass,
 * which is how an approval suppressed because the owner was watching still reaches their phone
 * once they walk away. `drop` writes the delivery ledger row, so it never fires — used when the
 * owner has already seen the thing, or asked not to be told about it at all.
 */
export type DeliveryDecision =
  | { action: 'send' }
  | { action: 'hold'; reason: 'foreground' | 'quiet_hours' }
  | { action: 'drop'; reason: 'kind_disabled' | 'foreground' | 'stale' };

/**
 * Kinds that are still worth sending after the moment has passed, so being at the keyboard when
 * they are raised holds them rather than writing them off.
 *
 * `task_finished` is the only one left out, because it reports that work is over: if the owner is
 * at the screen they have already read it, and a phone that buzzes for something they are looking
 * at is the thing owners switch off. These four are not reports. An approval and a takeover have
 * stopped the agent until a person acts, a spend pause is the box itself refusing to spend more
 * and waiting for a ceiling only the owner can raise, and a notice is the one push the owner asked
 * for by name - being at the keyboard is not the same as being in that conversation, and dropping
 * it settles the ledger row, which means it is never delivered at all.
 *
 * The data layer sorts the candidates on the same line: approval, takeover, spend pause, "and the
 * rest is news".
 */
const HELD_WHILE_PRESENT: readonly NotificationKind[] = [
  'approval_required',
  'takeover_needed',
  'spend_paused',
  'agent_message'
];

/**
 * How long a push service keeps trying to hand a receipt to a device that is not reachable.
 *
 * Ten minutes, unchanged, and only for `task_finished`. It is the one kind the decision above
 * drops rather than holds when the owner is at the keyboard, for the reason written there: it
 * reports that work is over. A receipt half a day late is not news, and the standing list in the
 * app is where it belongs by then.
 */
const RECEIPT_TTL_SECONDS = 600;

/** The two web-push fields this service sets per notification. Names are the wire's, not ours. */
export interface PushLifetime {
  TTL: number;
  urgency: 'high' | 'normal';
}

/**
 * What one push is worth to the transport, from the kind alone.
 *
 * Every send carried `TTL: 600`, an approval included. A phone that was off, in a tunnel or in a
 * meeting for eleven minutes never learned the agent was blocked: the push service dropped the
 * message, this service recorded the send as delivered, and the ledger row means it is never
 * offered again. The one notification whose whole purpose is that the work is stopped until a
 * person acts was the shortest-lived thing on the wire.
 *
 * Twelve hours - `MAX_HOLD_MS` - for the four kinds above, because that is the longest this
 * service ever holds one of them: `deliveryDecision` holds an item while the owner is at the
 * keyboard or inside quiet hours, and past `MAX_HOLD_MS` it stops holding and settles the item
 * without a push. An approval is written with a twenty-four hour deadline
 * (`apps/worker/src/turn/approval-park.ts`), so a push handed over at that last holdable moment
 * and living its full TTL expires at the hour `resolveApproval` stops accepting an answer.
 *
 * The horizon bounds holding and NOT sending, which is the case this number does not cover.
 * `deliveryDecision` tests staleness on its two hold arms only, so an owner who is away and
 * outside quiet hours is sent whatever the candidate query still offers - fourteen days of it,
 * after a stretch of downtime or a device that spent a day in backoff. An approval stays a
 * candidate while `expires_at > NOW()`, so a send at twenty-three hours carries a TTL that runs
 * eleven hours past its own deadline, and Approve and Deny on a push arriving then post to an
 * approval `resolveApproval` refuses. Moving the staleness test onto the send arm is what would
 * close that; shortening the TTL would only take twelve hours off every push that arrives on time.
 *
 * This does NOT make delivery reliable. A push service may discard sooner than the TTL asks, a
 * retired endpoint is not tried at all, and nothing here re-sends what the ledger has settled.
 * What it buys is a phone picked up within the working life of the approval.
 */
export const pushLifetime = (kind: NotificationKind): PushLifetime => ({
  // Stated once, from the held set, because it is the same property: a kind still worth sending
  // after the moment has passed is a kind still worth carrying on the wire after the moment has
  // passed. Two lists would be two answers the day somebody edited one.
  TTL: HELD_WHILE_PRESENT.includes(kind) ? MAX_HOLD_MS / 1000 : RECEIPT_TTL_SECONDS,
  // The transport's own hint, for the one kind that has stopped the agent dead.
  urgency: kind === 'approval_required' ? 'high' : 'normal'
});

const minuteOfLocalDay = (timeZone: string, instant: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(instant);
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value ?? 0);
  return value('hour') * 60 + value('minute');
};

/**
 * Whether `instant` falls inside the owner's quiet hours, in the owner's own zone.
 *
 * An unknown zone is treated as no quiet hours rather than as an error: the alternative is a
 * service that stops notifying at all because of a typo in a text field, and the one thing this
 * loop must never do is go quiet without saying so.
 */
export const inQuietHours = (
  quietHours: QuietHours | null,
  timeZone: string,
  instant: Date
): boolean => {
  if (!quietHours) return false;
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) return false;
  let minute: number;
  try {
    minute = minuteOfLocalDay(timeZone, instant);
  } catch {
    return false;
  }
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : // A window that wraps midnight is two ranges either side of it.
      minute >= startMinute || minute < endMinute;
};

export const deliveryDecision = (input: {
  kind: NotificationKind;
  settings: OwnerNotificationSettings;
  /** True when the owner made a request in the last `PRESENCE_WINDOW_MS`. */
  ownerPresent: boolean;
  /** When the thing being reported happened, for the staleness horizon. */
  eventAt: Date;
  now: Date;
}): DeliveryDecision => {
  const { kind, settings, ownerPresent, eventAt, now } = input;
  if (!settings.kinds[kind]) return { action: 'drop', reason: 'kind_disabled' };
  const stale = now.getTime() - eventAt.getTime() >= MAX_HOLD_MS;

  if (ownerPresent) {
    if (!HELD_WHILE_PRESENT.includes(kind)) return { action: 'drop', reason: 'foreground' };
    // The horizon belongs to holding, not to quiet hours, and it was only on the quiet arm. So an
    // owner who simply keeps a tab open kept every held item alive for the fourteen days it stays
    // a candidate, and the whole fortnight would have arrived at once the moment they walked away.
    return stale ? { action: 'drop', reason: 'stale' } : { action: 'hold', reason: 'foreground' };
  }

  const quiet =
    inQuietHours(settings.quietHours, settings.timeZone, now) &&
    !(kind === 'approval_required' && settings.quietHoursAllowApprovals);
  if (!quiet) return { action: 'send' };
  return stale ? { action: 'drop', reason: 'stale' } : { action: 'hold', reason: 'quiet_hours' };
};
