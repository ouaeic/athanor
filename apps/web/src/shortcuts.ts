/**
 * Every keystroke the workbench answers, and the list the owner is shown.
 *
 * One table for both. The sheet was written by hand beside the handler, so it could claim a
 * binding that did not exist — and the only place any of these are discoverable is that sheet and
 * the command palette.
 */
export type Shortcut =
  | 'palette'
  | 'new-conversation'
  | 'toggle-tools'
  | 'focus-composer'
  | 'edit-last'
  | 'stop-agent'
  | 'shortcut-sheet';

/** The two answers a pending request takes, and only from inside the card that asks. */
export type Decision = 'approve' | 'deny';

export interface ShortcutRow {
  /** The keys as the owner reads them. */
  keys: string;
  meaning: string;
  /** Absent for the keys a control answers itself rather than the window. */
  id?: Shortcut;
  /** Answered by the pending request while the owner's focus is inside it. */
  decision?: Decision;
}

export const shortcutRows: ShortcutRow[] = [
  { keys: '⌘K', meaning: 'Search and run anything', id: 'palette' },
  { keys: '⌘⇧O', meaning: 'New conversation', id: 'new-conversation' },
  { keys: '⌘B', meaning: 'Show or hide the computer tools', id: 'toggle-tools' },
  { keys: '⌘/', meaning: 'Jump to the message box', id: 'focus-composer' },
  { keys: '⌘↑', meaning: 'Edit your last message', id: 'edit-last' },
  { keys: 'Enter', meaning: 'Send' },
  { keys: '⇧Enter', meaning: 'New line' },
  { keys: 'Esc', meaning: 'Stop the agent', id: 'stop-agent' },
  // The safety floor, which until now was the only control in athanor with no keys at all. Both
  // are deliberately live only inside the card; the way to the card is the palette, for the reason
  // in `windowShortcut`.
  { keys: '⌘↩', meaning: 'Approve it, from inside the request', decision: 'approve' },
  { keys: '⌘⌫', meaning: 'Deny it, from inside the request', decision: 'deny' },
  { keys: '?', meaning: 'This list', id: 'shortcut-sheet' }
];

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** Whether the keystroke landed in a text field, where a bare character is being typed. */
  inField: boolean;
}

/**
 * What a keystroke means to the window, or nothing.
 *
 * Escape is answered only while the agent is working — it is the one action that must be reachable
 * without aiming at a control — and an open dialog answers it first and keeps it.
 *
 * There is deliberately no chord for "go to the request waiting for you". ⌘⇧↩ was tried and had to
 * come out: `sendsOnKey` (composer-state.ts) treats every Enter with a modifier as a send, on
 * purpose and with a test on it, so from the message box — the one place the owner would press it —
 * the chord sent their half-written message and jumped focus at the same time. The card takes focus
 * itself when it arrives, and the palette carries the labelled way back to it; a second, silently
 * destructive route was not worth a row in the sheet.
 */
export const windowShortcut = (
  event: ShortcutEvent,
  context: { agentWorking: boolean }
): Shortcut | undefined => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (meta && key === 'k') return 'palette';
  if (meta && event.shiftKey && key === 'o') return 'new-conversation';
  if (meta && key === 'b') return 'toggle-tools';
  if (meta && event.key === '/') return 'focus-composer';
  if (meta && event.key === 'ArrowUp') return 'edit-last';
  if (event.key === 'Escape') return context.agentWorking ? 'stop-agent' : undefined;
  if (event.key === '?' && !event.inField) return 'shortcut-sheet';
  return undefined;
};

/**
 * What a keystroke means to the request waiting on an answer — and it is asked only for keystrokes
 * that landed inside the card, which is why these two can be short.
 *
 * Escape is not here, and must not be. The card takes focus the moment it appears, so the owner is
 * frequently inside it without having gone there; Escape is the reflex for "get this off my screen"
 * and mapping the safe-looking dismissal onto an answer is how a decision gets made by accident. It
 * carries on to the window, where it still stops the agent. Bare Enter is not here for the same
 * reason: focus arriving unbidden must not put an answer one keystroke away.
 *
 * Shift is excluded because ⌘⇧↩ is a send in the message box (`sendsOnKey`); a chord the owner's
 * fingers already own elsewhere must not become an approval the moment focus moves here.
 */
export const decisionKey = (event: Omit<ShortcutEvent, 'inField'>): Decision | undefined => {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return undefined;
  if (event.key === 'Enter') return 'approve';
  if (event.key === 'Backspace') return 'deny';
  return undefined;
};
