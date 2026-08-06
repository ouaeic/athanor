import { describe, expect, it } from 'vitest';
import { shortcutRows, windowShortcut, type ShortcutEvent } from './shortcuts.js';

const press = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  inField: false,
  ...patch
});

const working = { agentWorking: true };
const idle = { agentWorking: false };

describe('the keystrokes the workbench answers', () => {
  it('answers each one the shortcut sheet claims', () => {
    expect(windowShortcut(press({ key: 'k', metaKey: true }), idle)).toBe('palette');
    expect(windowShortcut(press({ key: 'o', metaKey: true, shiftKey: true }), idle)).toBe(
      'new-conversation'
    );
    expect(windowShortcut(press({ key: 'b', metaKey: true }), idle)).toBe('toggle-tools');
    expect(windowShortcut(press({ key: '/', metaKey: true }), idle)).toBe('focus-composer');
    expect(windowShortcut(press({ key: 'ArrowUp', metaKey: true }), idle)).toBe('edit-last');
    expect(windowShortcut(press({ key: 'Escape' }), working)).toBe('stop-agent');
    expect(windowShortcut(press({ key: '?' }), idle)).toBe('shortcut-sheet');
  });

  /* The sheet is the only place any of these are discoverable, so it must not name one that does
     not exist. Enter and Shift+Enter are answered by the message box rather than by the window. */
  it('leaves nothing in the sheet that the window cannot do', () => {
    const reachable = new Set(
      [
        windowShortcut(press({ key: 'k', metaKey: true }), working),
        windowShortcut(press({ key: 'o', metaKey: true, shiftKey: true }), working),
        windowShortcut(press({ key: 'b', metaKey: true }), working),
        windowShortcut(press({ key: '/', metaKey: true }), working),
        windowShortcut(press({ key: 'ArrowUp', metaKey: true }), working),
        windowShortcut(press({ key: 'Escape' }), working),
        windowShortcut(press({ key: '?' }), working)
      ].filter(Boolean)
    );
    for (const row of shortcutRows) if (row.id) expect(reachable.has(row.id)).toBe(true);
    expect(shortcutRows.filter((row) => !row.id).map((row) => row.keys)).toEqual([
      'Enter',
      '⇧Enter'
    ]);
  });

  it('takes Ctrl for ⌘, so the same keys work on a keyboard without one', () => {
    expect(windowShortcut(press({ key: 'K', ctrlKey: true }), idle)).toBe('palette');
    expect(windowShortcut(press({ key: 'B', ctrlKey: true }), idle)).toBe('toggle-tools');
  });

  /* Escape with nothing running would otherwise mean "cancel", and there is nothing to cancel. */
  it('only stops the agent when there is an agent working', () => {
    expect(windowShortcut(press({ key: 'Escape' }), idle)).toBeUndefined();
  });

  it('leaves a question mark alone when one is being typed', () => {
    expect(windowShortcut(press({ key: '?', inField: true }), idle)).toBeUndefined();
    expect(windowShortcut(press({ key: '?', inField: false }), idle)).toBe('shortcut-sheet');
  });

  it('does not claim an ordinary keystroke', () => {
    expect(windowShortcut(press({ key: 'k' }), working)).toBeUndefined();
    expect(windowShortcut(press({ key: 'Enter' }), working)).toBeUndefined();
    expect(windowShortcut(press({ key: 'o', metaKey: true }), working)).toBeUndefined();
    expect(windowShortcut(press({ key: 'ArrowUp' }), working)).toBeUndefined();
  });
});
