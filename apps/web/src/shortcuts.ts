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

export interface ShortcutRow {
  /** The keys as the owner reads them. */
  keys: string;
  meaning: string;
  /** Absent for the two the message box answers itself rather than the window. */
  id?: Shortcut;
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
