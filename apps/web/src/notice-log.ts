/**
 * Everything athanor has told the owner, across every conversation.
 *
 * A notice already appears in the conversation it was decided in and on whatever device was awake
 * at the time. Neither of those is a place to look something up: the conversation has to be found
 * first, and a push that was not tapped is gone. This is the list that answers "what did it tell me
 * while I was out".
 */
export type AgentNotificationKind = 'agent_message' | 'takeover_needed';

export interface AgentNotification {
  id: string;
  taskId: string;
  /** Decrypted by the box, which holds the workspace key. Empty when it could not be read. */
  taskTitle: string;
  kind: AgentNotificationKind;
  /** The sentence the agent wrote, decrypted by the box; there is nothing to add to it. */
  message: string;
  createdAt: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Reads the list out of whatever the box sent.
 *
 * A bare array and an envelope around one are both plausible from a route this client is served by
 * boxes either side of, and a row with no message is a row with nothing to read - it is dropped
 * rather than rendered as an empty line.
 */
export const readNotices = (payload: unknown): AgentNotification[] => {
  const envelope = record(payload);
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope?.items)
      ? envelope.items
      : [];
  const notices: AgentNotification[] = [];
  for (const row of rows) {
    const entry = record(row);
    if (!entry) continue;
    const message = text(entry.message) || text(entry.headline);
    const id = text(entry.id);
    if (!message || !id) continue;
    notices.push({
      id,
      taskId: text(entry.taskId),
      // The box decrypts the conversation's name, so a notice from a conversation this device has
      // never paged in still says where it came from.
      taskTitle: text(entry.taskTitle),
      kind: entry.kind === 'takeover_needed' ? 'takeover_needed' : 'agent_message',
      message,
      createdAt: text(entry.createdAt)
    });
  }
  return notices.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

/**
 * When it was said, at the resolution a person remembers it by: the clock for today, the day name
 * for this week, the date for anything older.
 */
export const noticeWhen = (iso: string, now = Date.now()): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return time;
  const days = (now - at.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return `${at.toLocaleDateString([], { weekday: 'long' })} · ${time}`;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
};
