import { describe, expect, it } from 'vitest';
import {
  decisionKey,
  keyNotation,
  paneId,
  panes,
  shortcutRows,
  stepPane,
  windowShortcut,
  type ShortcutEvent
} from './shortcuts.js';

const press = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: 'a',
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  inField: false,
  ...patch
});

/** A digit chord as a real keyboard sends it: the physical key, whatever character it produced. */
const digit = (number: number, patch: Partial<ShortcutEvent> = {}): ShortcutEvent =>
  press({ key: String(number), code: `Digit${number}`, metaKey: true, ...patch });

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
        windowShortcut(press({ key: 'F6' }), working),
        windowShortcut(digit(1), working),
        windowShortcut(digit(1, { altKey: true }), working),
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
    expect(keyNotation('MacIntel')).toMatchObject({ cmd: '⌘', alt: '⌥', shift: '⇧', del: '⌫' });
    expect(keyNotation('Win32')).toMatchObject({
      cmd: 'Ctrl+',
      alt: 'Alt+',
      shift: 'Shift+',
      del: 'Backspace'
    });
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

/*
 * The workbench had per-element accessibility and nothing above the element: no way to move focus
 * between the three panes at all. With twenty conversations listed, the tools panel was something
 * like sixty-seven Tab presses from the sidebar, and every one of these keys exists to make that a
 * single keystroke.
 */
describe('the keys that move between panes', () => {
  it('jumps to each of the four with ⌘1 to ⌘4', () => {
    expect(windowShortcut(digit(1), idle)).toBe('go-conversations');
    expect(windowShortcut(digit(2), idle)).toBe('go-conversation');
    // ⌘3 is the message box, which is the binding ⌘/ already had rather than a second one.
    expect(windowShortcut(digit(3), idle)).toBe('focus-composer');
    expect(windowShortcut(digit(4), idle)).toBe('go-tools');
    expect(windowShortcut(digit(5), idle)).toBeUndefined();
  });

  it('chooses a computer tool with ⌘⌥1 to ⌘⌥4, in the order of the strip', () => {
    expect(windowShortcut(digit(1, { altKey: true }), idle)).toBe('tool-files');
    expect(windowShortcut(digit(2, { altKey: true }), idle)).toBe('tool-computer');
    expect(windowShortcut(digit(3, { altKey: true }), idle)).toBe('tool-terminal');
    expect(windowShortcut(digit(4, { altKey: true }), idle)).toBe('tool-preview');
  });

  /*
   * The one this pair exists for. ⌥1 on a Mac produces "¡" and a French keyboard produces "&" for
   * the unshifted 1 key, so a chord matched on the character would have worked for some owners of
   * a self-installed server and silently not for others. The physical key is the same everywhere.
   */
  it('reads the physical digit rather than the character it produced', () => {
    expect(
      windowShortcut(press({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), idle)
    ).toBe('tool-files');
    expect(windowShortcut(press({ key: '&', code: 'Digit1', metaKey: true }), idle)).toBe(
      'go-conversations'
    );
    // And falls back to the character where there is no physical key to read, as on a soft keyboard.
    expect(windowShortcut(press({ key: '2', code: '', metaKey: true }), idle)).toBe(
      'go-conversation'
    );
  });

  it('walks the panes with F6, both ways, with or without a text field under it', () => {
    expect(windowShortcut(press({ key: 'F6' }), idle)).toBe('pane-next');
    expect(windowShortcut(press({ key: 'F6', shiftKey: true }), idle)).toBe('pane-back');
    expect(windowShortcut(press({ key: 'F6', inField: true }), working)).toBe('pane-next');
  });

  it('walks in a ring, and enters at whichever end it was asked from', () => {
    expect(stepPane('conversations', 1)).toBe('conversation');
    expect(stepPane('tools', 1)).toBe('conversations');
    expect(stepPane('conversations', -1)).toBe('tools');
    expect(stepPane(undefined, 1)).toBe('conversations');
    expect(stepPane(undefined, -1)).toBe('tools');
  });

  /* One spelling of each id, because the markup and the keystroke have to name the same element. */
  it('gives every pane one id', () => {
    expect(panes.map(paneId)).toEqual([
      'pane-conversations',
      'pane-conversation',
      'pane-composer',
      'pane-tools'
    ]);
  });

  /* ⌘⇧1 is not a pane. The sheet claims no shifted digit and the window must not answer one. */
  it('does not answer a shifted digit', () => {
    expect(windowShortcut(digit(1, { shiftKey: true }), idle)).toBeUndefined();
    expect(windowShortcut(press({ key: '1', code: 'Digit1' }), idle)).toBeUndefined();
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
