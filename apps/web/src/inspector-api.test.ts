/**
 * What the Computer panel sends, and when it says it cannot.
 *
 * The panel's handlers were the least checkable code in the client: a `MouseEvent` and a socket,
 * with the whole question — *did the thing the person did reach the agent's computer* — hidden
 * inside a component this package has no DOM to render. Every mapping below is a value now, so a
 * right-click that quietly became a left click, or a wheel that quietly became nothing, fails here
 * instead of on somebody's screen.
 */
import { describe, expect, it } from 'vitest';
import { BrowserAction, DesktopAction, DesktopLaunchRequest } from '@athanor/contracts';
import {
  dialogBanner,
  dragAction,
  framePassesThrough,
  framePoint,
  heldFor,
  keyChord,
  movedPath,
  pointerAction,
  streamStalled,
  STALL_AFTER_MS,
  surfaceNotice,
  viewportMessage,
  wheelAction
} from './inspector-api.js';

/** A picture drawn at half the size of the screen inside it, which is the ordinary case. */
const box = { left: 100, top: 50, width: 720, height: 450 };
const screen = { width: 1440, height: 900 };

describe('where a click lands on the agent’s screen', () => {
  it('maps a position through the picture rather than the element around it', () => {
    expect(framePoint({ clientX: 460, clientY: 275 }, box, screen)).toEqual({ x: 720, y: 450 });
    expect(framePoint({ clientX: 100, clientY: 50 }, box, screen)).toEqual({ x: 0, y: 0 });
  });

  /* The contract bounds a coordinate to the screen, so a click on the edge must not be refused. */
  it('clamps a pointer that left the picture instead of sending a refused number', () => {
    expect(framePoint({ clientX: 5_000, clientY: 5_000 }, box, screen)).toEqual({
      x: 1440,
      y: 900
    });
    expect(framePoint({ clientX: -400, clientY: -400 }, box, screen)).toEqual({ x: 0, y: 0 });
  });

  it('answers zero for a box with no size rather than dividing by it', () => {
    expect(
      framePoint({ clientX: 10, clientY: 10 }, { ...box, width: 0, height: 0 }, screen)
    ).toEqual({ x: 0, y: 0 });
  });
});

describe('the buttons a person can press on somebody else’s screen', () => {
  const at = { x: 400, y: 300 };

  it('sends a right-click as a right-click', () => {
    expect(pointerAction('display', at, { button: 'right' })).toEqual({
      type: 'click_at',
      x: 400,
      y: 300,
      button: 'right',
      clicks: 1
    });
  });

  it('sends a double-click as one action rather than two round trips', () => {
    expect(pointerAction('display', at, { clicks: 2 })).toMatchObject({ clicks: 2 });
  });

  /*
   * The page stream's `click_at` carries an x and a y and nothing else, and zod's discriminated
   * union drops an undeclared key without a word - so a `button: 'right'` sent there would be
   * accepted, silently downgraded to an ordinary left click, and reported as having worked. Saying
   * it cannot be done is the only honest answer available.
   */
  it('refuses a right-click on the page stream instead of sending a left one', () => {
    expect(pointerAction('page', at, { button: 'right' })).toBeUndefined();
    expect(pointerAction('page', at, { clicks: 2 })).toBeUndefined();
    expect(pointerAction('page', at, {})).toEqual({ type: 'click_at', x: 400, y: 300 });
  });
});

describe('the wheel', () => {
  it('sends a scroll on the screen as a direction and a count of wheel ticks', () => {
    expect(wheelAction('display', { deltaX: 0, deltaY: 120 })).toEqual({
      type: 'scroll',
      direction: 'down',
      amount: 3
    });
    expect(wheelAction('display', { deltaX: 0, deltaY: -120 })).toMatchObject({ direction: 'up' });
  });

  /* There is no diagonal in a wheel button, so one axis has to win and it is the larger one. */
  it('picks the axis the person actually moved', () => {
    expect(wheelAction('display', { deltaX: -300, deltaY: 20 })).toMatchObject({
      direction: 'left'
    });
  });

  it('still moves for the smallest flick a trackpad can report', () => {
    expect(wheelAction('display', { deltaX: 0, deltaY: 4 })).toMatchObject({ amount: 1 });
    expect(wheelAction('display', { deltaX: 0, deltaY: 0 })).toBeUndefined();
  });

  /*
   * No x or y goes with it: `DesktopAction`'s scroll declares a direction and an amount, the union
   * would drop coordinates in silence, and the runner scrolls at wherever the last click left the
   * pointer. Sending numbers that are discarded is how a control starts lying.
   */
  it('sends no position with a screen scroll, because none would survive the contract', () => {
    expect(Object.keys(wheelAction('display', { deltaX: 0, deltaY: 120 }) ?? {}).sort()).toEqual([
      'amount',
      'direction',
      'type'
    ]);
  });

  it('sends a scroll on the page stream in the pixels that stream speaks', () => {
    expect(wheelAction('page', { deltaX: 0, deltaY: 240 })).toEqual({
      type: 'scroll',
      deltaX: 0,
      deltaY: 240
    });
  });
});

describe('dragging, which is what a slider and a puzzle challenge need', () => {
  it('sends the whole gesture, not the two ends of it', () => {
    expect(dragAction('display', { x: 10, y: 20 }, { x: 300, y: 25 })).toEqual({
      type: 'drag',
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 25,
      durationMs: 500
    });
  });

  /* Twenty browser primitives and not one holds a button down across a movement. */
  it('says the page stream cannot do it rather than approximating a click', () => {
    expect(dragAction('page', { x: 10, y: 20 }, { x: 300, y: 25 })).toBeUndefined();
  });
});

describe('the keys', () => {
  /*
   * This replaced an allowlist of two - Enter and space. A person invited to clear a challenge
   * could not press Backspace to fix a typo and could not use an arrow key, on a pane whose whole
   * purpose is doing by hand what the agent could not.
   */
  it('forwards the keys the old allowlist dropped', () => {
    expect(keyChord({ key: 'Backspace' })).toBe('Backspace');
    expect(keyChord({ key: 'ArrowLeft' })).toBe('ArrowLeft');
    expect(keyChord({ key: 'Delete' })).toBe('Delete');
    expect(keyChord({ key: 'a' })).toBe('a');
  });

  /*
   * One spelling for both surfaces by construction: the desktop's `toX11Keysym` splits on `+` and
   * lowercases each part, so `Control` becomes `ctrl` and `Meta` becomes `super`; Playwright's
   * `keyboard.press` splits on the same `+` and wants exactly these names.
   */
  it('composes modifiers into the one chord both surfaces understand', () => {
    expect(keyChord({ key: 'a', ctrlKey: true })).toBe('Control+a');
    expect(keyChord({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab');
    expect(keyChord({ key: 'ArrowRight', altKey: true, metaKey: true })).toBe(
      'Alt+Meta+ArrowRight'
    );
  });

  /* The space bar is the one key the DOM spells differently from either runner. */
  it('sends the space bar under the name both ends know it by', () => {
    expect(keyChord({ key: ' ' })).toBe('Space');
  });

  /*
   * Shift is already folded into a printable character by the keyboard: telling the remote
   * shift-then-A would produce nothing on a layout where A is already the shifted key.
   */
  it('does not shift a character the keyboard has already shifted', () => {
    expect(keyChord({ key: 'A', shiftKey: true })).toBe('A');
  });

  it('sends nothing for a modifier held on its own', () => {
    expect(keyChord({ key: 'Shift', shiftKey: true })).toBeUndefined();
    expect(keyChord({ key: 'Control', ctrlKey: true })).toBeUndefined();
  });

  /* Swallow Tab and focus that lands on the picture can never leave it. The toolbar sends one. */
  it('leaves Tab to the page, so a keyboard can get back out of the picture', () => {
    expect(framePassesThrough({ key: 'Tab' })).toBe(true);
    expect(framePassesThrough({ key: 'Enter' })).toBe(false);
  });
});

describe('noticing that the picture has stopped being live', () => {
  const at = 1_000_000;

  /*
   * The freeze this exists for: one lost delta leaves the decoder waiting for a keyframe an
   * infinite GOP never sends, so access units keep arriving and none of them paints. A healthy
   * socket, no error, no spinner - the owner watching a photograph of the agent's screen.
   */
  it('calls it stalled when bytes keep arriving and nothing reaches the screen', () => {
    expect(streamStalled({ lastPaintAt: at, lastSignalAt: at + 1_000 }, at + STALL_AFTER_MS)).toBe(
      true
    );
  });

  /*
   * And the false alarm it must not raise. The encoder runs behind `mpdecimate`, so an idle
   * desktop sends nothing at all on purpose: a plain "no bytes for four seconds" watchdog would
   * put "the computer needs attention" on the pane every time the agent paused to think.
   */
  it('says nothing about a screen that is merely idle', () => {
    expect(streamStalled({ lastPaintAt: at, lastSignalAt: at }, at + 60_000)).toBe(false);
  });

  it('waits the whole four seconds before saying so', () => {
    expect(
      streamStalled({ lastPaintAt: at, lastSignalAt: at + 500 }, at + STALL_AFTER_MS - 1)
    ).toBe(false);
  });

  /* Before the first frame the pane already says "Waking the screen", which is the truer answer. */
  it('does not accuse a stream that has never painted at all', () => {
    expect(streamStalled({ lastPaintAt: undefined, lastSignalAt: at }, at + 60_000)).toBe(false);
  });
});

describe('what the pane says about a screen that is not working', () => {
  it('says nothing at all when the screen is working', () => {
    expect(surfaceNotice({ mode: 'semantic_and_visual', message: 'ignored' })).toBe('');
    expect(surfaceNotice(undefined)).toBe('');
  });

  /*
   * A box whose accessibility bridge has failed looks identical to a healthy one while every agent
   * action silently degrades to pixels. The runner has been sending the reason all along.
   */
  it('repeats the runner’s own sentence when there is one', () => {
    expect(
      surfaceNotice({
        mode: 'visual_fallback',
        message: 'accessibility bridge failed: at-spi bus not running'
      })
    ).toContain('at-spi bus not running');
  });

  it('still says which way it is broken when the runner sent no sentence', () => {
    expect(surfaceNotice({ mode: 'visual_fallback' })).toContain('picture alone');
    expect(surfaceNotice({ mode: 'unavailable' })).toContain('no screen running');
  });
});

describe('the dialog holding a page', () => {
  /*
   * Parking a Playwright dialog suppresses its auto-dismiss, so the page is blocked until
   * something answers - and the native dialog never draws, because Playwright intercepted it. An
   * owner who took the browser over and clicked something raising `confirm()` watched the page
   * stop with nothing on screen to explain it and no way out but hibernating the browser.
   */
  it('turns a parked dialog into the two lines a person needs to answer it', () => {
    expect(dialogBanner({ type: 'confirm', message: 'Delete this draft?' })).toEqual({
      kind: 'confirm',
      detail: 'Delete this draft?'
    });
  });

  it('still explains a dialog that carries no text of its own', () => {
    expect(dialogBanner({ type: 'beforeunload', message: '' })?.detail).toContain(
      'until this is answered'
    );
  });

  it('is nothing at all when no dialog is holding the page', () => {
    expect(dialogBanner(null)).toBeUndefined();
    expect(dialogBanner(undefined)).toBeUndefined();
  });
});

describe('how long control has been where it is', () => {
  const now = Date.parse('2026-08-10T09:00:14.000Z');

  /* The runner's own doc-comment names the string: "Agent has control · 0:14". */
  it('reads back as the clock the runner asked for', () => {
    expect(heldFor('2026-08-10T09:00:00.000Z', now)).toBe('0:14');
    expect(heldFor('2026-08-10T08:57:00.000Z', now)).toBe('3:14');
  });

  it('changes units rather than printing a four-figure minute count', () => {
    expect(heldFor('2026-08-10T06:30:00.000Z', now)).toBe('2h 30m');
  });

  /* A clock counting backwards is worse than no clock, and so is one made of a bad stamp. */
  it('says nothing rather than counting backwards', () => {
    expect(heldFor('2026-08-10T10:00:00.000Z', now)).toBe('');
    expect(heldFor('not a date', now)).toBe('');
  });
});

describe('the size of the hole the screen is being watched through', () => {
  it('publishes the pane’s own measurements, rounded for an X server', () => {
    expect(viewportMessage({ width: 1919.4, height: 1079.6 }, 2)).toEqual({
      type: 'viewport',
      viewport: { cssWidth: 1919, cssHeight: 1080, devicePixelRatio: 2, mode: 'css' }
    });
  });

  /*
   * A pane behind another tab measures 0x0. Resizing the agent's screen to nothing because the
   * owner glanced at Files is the mistake the terminal's FitAddon already made once.
   */
  it('sends nothing for a pane that is not on screen', () => {
    expect(viewportMessage({ width: 0, height: 0 })).toBeUndefined();
  });

  it('keeps the ratio inside what the runner will accept', () => {
    expect(viewportMessage({ width: 800, height: 600 }, 40)?.viewport.devicePixelRatio).toBe(8);
  });
});

describe('moving a file into another folder', () => {
  const entry = { name: 'notes.md', path: 'workspace/drafts/notes.md' };

  /*
   * `renameWorkspaceEntry` has resolved an arbitrary destination and mkdir'd its parent since it
   * was written - a full move - and the client's only caller replaced the last path segment and
   * rejected any slash. So twenty files the agent dropped in the wrong folder could be tidied
   * only through the terminal.
   */
  it('builds the destination out of a folder and the name the file already has', () => {
    expect(movedPath(entry, 'workspace')).toEqual({ ok: true, path: 'workspace/notes.md' });
    expect(movedPath(entry, 'workspace/archive/')).toEqual({
      ok: true,
      path: 'workspace/archive/notes.md'
    });
  });

  it('refuses the folder the file is already in rather than asking the box about it', () => {
    expect(movedPath(entry, 'workspace/drafts')).toEqual({
      ok: false,
      message: 'notes.md is already in that folder.'
    });
  });
});

/*
 * The round trip, against the schemas that actually stand at the other end.
 *
 * Everything above says what this client sends. This says the far end takes it — and, more to the
 * point, that nothing is quietly dropped on the way. `zod`'s `discriminatedUnion` strips a key it
 * has not declared without an error and without a word, so a field that looks right in a request
 * body can arrive meaning nothing, be accepted, and be reported as having worked. That is the exact
 * shape of the nineteen controls this wave exists to stop lying, and the only way to hold it to
 * account from this side is to parse what is sent with the parser that will receive it.
 */
describe('what the runner will actually accept', () => {
  const at = { x: 400.4, y: 300.6 };

  it('takes every press the screen offers, with the button and the count intact', () => {
    for (const button of ['left', 'middle', 'right'] as const)
      expect(
        DesktopAction.parse(pointerAction('display', at, { button, clicks: 2 }))
      ).toMatchObject({ type: 'click_at', button, clicks: 2 });
  });

  it('takes a click on the page stream, which is the one press that stream has', () => {
    expect(BrowserAction.parse(pointerAction('page', at, {}))).toMatchObject({
      type: 'click_at',
      x: 400.4
    });
  });

  it('takes a wheel turn on either surface and keeps every field of it', () => {
    const screen = wheelAction('display', { deltaX: 0, deltaY: 120 });
    expect(DesktopAction.parse(screen)).toEqual(screen);
    const page = wheelAction('page', { deltaX: 0, deltaY: 240 });
    expect(BrowserAction.parse(page)).toMatchObject(page as Record<string, unknown>);
  });

  it('takes a drag with both ends of it still on the body', () => {
    const drag = dragAction('display', { x: 10, y: 20 }, { x: 300, y: 25 });
    expect(DesktopAction.parse(drag)).toEqual(drag);
  });

  it('takes a chord as a key, on both surfaces, up to the length the schema allows', () => {
    const key = keyChord({ key: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(DesktopAction.parse({ type: 'press', key })).toEqual({ type: 'press', key });
    expect(BrowserAction.parse({ type: 'press', key })).toMatchObject({ key });
  });

  /* The two answers that unblock a page nothing else can unblock. */
  it('takes both answers to a parked dialog', () => {
    for (const response of ['accept', 'dismiss'] as const)
      expect(BrowserAction.parse({ type: 'dialog', response })).toMatchObject({ response });
  });

  it('takes the semantic actions a person could not reach before', () => {
    expect(DesktopAction.parse({ type: 'focus', nodeId: 'node-1' })).toMatchObject({
      nodeId: 'node-1'
    });
    expect(DesktopAction.parse({ type: 'invoke', nodeId: 'node-1', actionIndex: 0 })).toMatchObject(
      { actionIndex: 0 }
    );
  });

  it('takes a program to open, and the tab actions the strip sends', () => {
    expect(DesktopLaunchRequest.parse({ executable: 'gedit', args: [] })).toMatchObject({
      executable: 'gedit'
    });
    for (const type of ['select_tab', 'close_tab'] as const)
      expect(BrowserAction.parse({ type, tabId: 'tab-1' })).toMatchObject({ type });
    expect(BrowserAction.parse({ type: 'back' })).toMatchObject({ type: 'back' });
    expect(BrowserAction.parse({ type: 'reload' })).toMatchObject({ type: 'reload' });
  });
});
