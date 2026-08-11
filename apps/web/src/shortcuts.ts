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
  | 'shortcut-sheet'
  | 'pane-next'
  | 'pane-back'
  | 'go-conversations'
  | 'go-conversation'
  | 'go-tools'
  | 'tool-files'
  | 'tool-computer'
  | 'tool-terminal'
  | 'tool-preview';

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

/**
 * The modifier this keyboard actually has.
 *
 * `windowShortcut` has always taken Ctrl as well as Command, and every one of these was written in
 * Mac notation anyway - so an owner who installed their own server on Windows or Linux was shown
 * seven bindings in glyphs their keyboard does not carry, for keys it had all along. Read once, at
 * module load, because the keyboard does not change under the owner mid-session.
 */
export const keyNotation = (
  identity: string
): { cmd: string; alt: string; shift: string; enter: string; del: string } =>
  /mac|iphone|ipad|ipod/i.test(identity)
    ? { cmd: '⌘', alt: '⌥', shift: '⇧', enter: '↩', del: '⌫' }
    : { cmd: 'Ctrl+', alt: 'Alt+', shift: 'Shift+', enter: 'Enter', del: 'Backspace' };

const { cmd, alt, shift, enter, del } = keyNotation(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || ''
);

/**
 * The four places focus lives, in the order F6 walks them.
 *
 * Every control in the workbench was reachable and none of the regions were: there was no way to
 * move between the three panes at all, so with twenty conversations listed the tools panel was
 * something like sixty-seven Tab presses from the sidebar. The regions carry these ids and take
 * `tabIndex={-1}` so focus can be put on them; the message box is in the walk because it is where
 * the owner is going most of the time, and it answers to the ref the shell already holds rather
 * than to an id.
 */
export const panes = ['conversations', 'conversation', 'composer', 'tools'] as const;
export type Pane = (typeof panes)[number];

/** One spelling of each region's id, so the sheet, the walk and the markup cannot drift apart. */
export const paneId = (pane: Pane): string => `pane-${pane}`;

/** Where F6 goes from here. With focus nowhere in particular it enters at whichever end. */
export const stepPane = (from: Pane | undefined, step: 1 | -1): Pane => {
  const index = from === undefined ? (step === 1 ? -1 : 0) : panes.indexOf(from);
  return panes[(index + step + panes.length) % panes.length] as Pane;
};

/** ⌘1–4, in the order the panes are read on screen. ⌘3 is the binding ⌘/ already had. */
const paneShortcuts: Shortcut[] = [
  'go-conversations',
  'go-conversation',
  'focus-composer',
  'go-tools'
];

/** ⌘⌥1–4, in the order of the Inspector's own strip (Inspector.tsx) — pinned by its test. */
const toolShortcuts: Shortcut[] = ['tool-files', 'tool-computer', 'tool-terminal', 'tool-preview'];

export const shortcutRows: ShortcutRow[] = [
  { keys: `${cmd}K`, meaning: 'Search and run anything', id: 'palette' },
  { keys: `${cmd}${shift}O`, meaning: 'New conversation', id: 'new-conversation' },
  { keys: `${cmd}B`, meaning: 'Show or hide the computer tools', id: 'toggle-tools' },
  { keys: `${cmd}/`, meaning: 'Jump to the message box', id: 'focus-composer' },
  // The three rows that made the whole workbench keyboard-drivable. Each names its four
  // destinations in order rather than taking four rows: the sheet is the only place these are
  // discoverable, and a sheet nobody finishes reading discovers nothing.
  {
    keys: `${cmd}1–4`,
    meaning: 'Conversations, conversation, message box, tools',
    id: 'go-conversations'
  },
  { keys: `F6 / ${shift}F6`, meaning: 'Next or previous pane', id: 'pane-next' },
  { keys: `${cmd}${alt}1–4`, meaning: 'Files, Computer, Terminal, Running', id: 'tool-files' },
  { keys: `${cmd}↑`, meaning: 'Edit your last message', id: 'edit-last' },
  { keys: 'Enter', meaning: 'Send' },
  { keys: `${shift}Enter`, meaning: 'New line' },
  { keys: 'Esc', meaning: 'Stop the agent', id: 'stop-agent' },
  // The safety floor, which until now was the only control in athanor with no keys at all. Both
  // are deliberately live only inside the card; the way to the card is the palette, for the reason
  // in `windowShortcut`.
  { keys: `${cmd}${enter}`, meaning: 'Approve it, from inside the request', decision: 'approve' },
  { keys: `${cmd}${del}`, meaning: 'Deny it, from inside the request', decision: 'deny' },
  { keys: '?', meaning: 'This list', id: 'shortcut-sheet' }
];

/** The one row the sidebar repeats on its own button, read from the table rather than retyped. */
export const shortcutKeys = (id: Shortcut): string =>
  shortcutRows.find((row) => row.id === id)?.keys ?? '';

export interface ShortcutEvent {
  key: string;
  /**
   * The physical key, where the browser reports one.
   *
   * `key` cannot be read for the digit chords: on a Mac ⌥1 arrives as `¡`, and on any layout that
   * is not US the digit row carries other characters, so a chord matched on `key` would work for
   * some owners and silently not for others. `code` is empty on some on-screen keyboards, which is
   * why `key` is still consulted as a fallback.
   */
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Whether the keystroke landed in a text field, where a bare character is being typed. */
  inField: boolean;
}

/** 1, 2, 3 or 4 off the digit row, or nothing. */
const paneDigit = (event: ShortcutEvent): number | undefined => {
  const digit =
    /^Digit([1-4])$/.exec(event.code)?.[1] ?? (/^[1-4]$/.test(event.key) ? event.key : undefined);
  return digit ? Number(digit) : undefined;
};

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
 *
 * F6 is first because it is the one binding here no browser can take: ⌘1–⌘4 are reserved for tab
 * switching in some browsers and never reach the page there, so the walk has to work on its own.
 */
export const windowShortcut = (
  event: ShortcutEvent,
  context: { agentWorking: boolean }
): Shortcut | undefined => {
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.key === 'F6') return event.shiftKey ? 'pane-back' : 'pane-next';
  if (meta && !event.shiftKey) {
    const digit = paneDigit(event);
    if (digit) return (event.altKey ? toolShortcuts : paneShortcuts)[digit - 1];
  }
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
