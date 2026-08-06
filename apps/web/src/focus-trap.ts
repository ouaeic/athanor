export const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Where an arrow key should move inside a tab strip, or -1 for a key it does not own.
 *
 * A tablist takes one stop in the tab order and moves between its tabs with the arrows, which is
 * what a screen-reader user expects of one. Home and End go to the ends; the arrows wrap.
 */
export const nextTabIndex = (key: string, current: number, count: number): number => {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return -1;
  const from = current < 0 ? 0 : current;
  return (from + (key === 'ArrowRight' ? 1 : -1) + count) % count;
};

/**
 * Which keystrokes an open dialog owns.
 *
 * It owns Escape as well as Tab, and that has to be said out loud because the workbench binds
 * Escape to stopping the agent. The dialog's own handler ran first and only called
 * `preventDefault`, so the keystroke carried on to the window: dismissing Settings, Schedules or
 * the shortcut sheet while the agent was working also cancelled the work.
 */
export const dialogKeyAction = (event: {
  key: string;
  shiftKey: boolean;
}): 'close' | 'focus-next' | 'focus-previous' | 'ignore' => {
  if (event.key === 'Escape') return 'close';
  if (event.key !== 'Tab') return 'ignore';
  return event.shiftKey ? 'focus-previous' : 'focus-next';
};

/**
 * Where Tab should land next inside a dialog, wrapping at both ends.
 *
 * `current` is -1 when focus is somewhere the dialog does not own (the body, or an element that
 * has since been removed), in which case Tab enters at the appropriate edge instead of escaping.
 */
export const nextFocusIndex = (count: number, current: number, backwards: boolean): number => {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
};
