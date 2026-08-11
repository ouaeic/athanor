import { describe, expect, it } from 'vitest';
import {
  decisionKey,
  keyNotation,
  shortcutRows,
  windowShortcut,
  type ShortcutEvent
} from './shortcuts.js';

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

  /*
   * The window claims no chord built on Enter, and this is the guard on that.
   *
   * ⌘⇧↩ was briefly the way to a waiting request. It cannot be: `sendsOnKey` treats every Enter
   * held with a modifier as a send, deliberately and with its own test, so from the message box —
   * the only place the owner would reach for it — that chord sent a half-written message and moved
   * focus away in the same keystroke. The two answers belong to the card; the way to the card is
   * the palette.
   */
  it('claims no chord the message box already sends on', () => {
    expect(
      windowShortcut(press({ key: 'Enter', metaKey: true, shiftKey: true }), idle)
    ).toBeUndefined();
    expect(windowShortcut(press({ key: 'Enter', metaKey: true }), idle)).toBeUndefined();
    expect(windowShortcut(press({ key: 'Enter' }), working)).toBeUndefined();
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
    // And nothing the card cannot do either: the sheet is the one place these are written down.
    for (const row of shortcutRows)
      if (row.decision)
        expect(
          decisionKey(
            press({ key: row.decision === 'approve' ? 'Enter' : 'Backspace', metaKey: true })
          )
        ).toBe(row.decision);
    expect(
      shortcutRows.filter((row) => !row.id && !row.decision).map((row) => row.meaning)
    ).toEqual(['Send', 'New line']);
  });

  /*
   * The sheet is written in the notation of the keyboard reading it. `windowShortcut` has always
   * taken Ctrl as well as Command, and the sheet was hard-coded to Mac glyphs — so the owner of a
   * server they installed themselves on Windows or Linux was shown seven bindings in symbols their
   * keyboard does not have, for keys it accepted all along.
   */
  it('writes the keys in the notation of the keyboard reading it', () => {
    expect(keyNotation('MacIntel')).toMatchObject({ cmd: '⌘', shift: '⇧', del: '⌫' });
    expect(keyNotation('Win32')).toMatchObject({ cmd: 'Ctrl+', shift: 'Shift+', del: 'Backspace' });
    expect(keyNotation('Linux x86_64').cmd).toBe('Ctrl+');
    expect(keyNotation('iPhone').cmd).toBe('⌘');
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

describe('the keys the pending request answers', () => {
  it('takes both decisions, and takes Ctrl for ⌘', () => {
    expect(decisionKey(press({ key: 'Enter', metaKey: true }))).toBe('approve');
    expect(decisionKey(press({ key: 'Backspace', metaKey: true }))).toBe('deny');
    expect(decisionKey(press({ key: 'Enter', ctrlKey: true }))).toBe('approve');
    expect(decisionKey(press({ key: 'Backspace', ctrlKey: true }))).toBe('deny');
  });

  /*
   * The one this file exists for. The card takes focus the moment it appears, so the owner is
   * inside it without having gone there, and Escape is the reflex for "get this off my screen".
   * Mapping that onto Deny would make a decision out of a dismissal — and Deny is a real answer,
   * not a way of closing something. Escape falls through to the window, where it stops the agent.
   */
  it('never reads Escape as an answer', () => {
    expect(decisionKey(press({ key: 'Escape' }))).toBeUndefined();
    expect(decisionKey(press({ key: 'Escape', metaKey: true }))).toBeUndefined();
    expect(decisionKey(press({ key: 'Escape', ctrlKey: true, shiftKey: true }))).toBeUndefined();
  });

  /* For the same reason: focus arriving unbidden must not put an answer one keystroke away. */
  it('does not answer a bare Enter, a bare Backspace or a space', () => {
    expect(decisionKey(press({ key: 'Enter' }))).toBeUndefined();
    expect(decisionKey(press({ key: 'Backspace' }))).toBeUndefined();
    expect(decisionKey(press({ key: ' ' }))).toBeUndefined();
  });

  /* ⌘⇧↩ is a send in the message box. A chord the owner's fingers already own somewhere else must
     not become an approval the moment focus lands here. */
  it('does not approve on a chord that means something else elsewhere', () => {
    expect(decisionKey(press({ key: 'Enter', metaKey: true, shiftKey: true }))).toBeUndefined();
    expect(decisionKey(press({ key: 'Backspace', metaKey: true, shiftKey: true }))).toBeUndefined();
  });
});
