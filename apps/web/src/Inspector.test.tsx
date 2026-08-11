/**
 * The panel, as it is put together.
 *
 * The bug this pins was structural rather than behavioural: the panel rendered one pane through a
 * ternary, so switching tab unmounted the pane being left, its cleanup closed its socket, and the
 * runner kills the pty when the terminal's socket closes - the owner's build died and the pane said
 * "Session closed" as though their shell had exited. There is no DOM in these tests, so what can be
 * checked is the shape that makes the unmount impossible: a panel per tab, present together, with
 * the ones behind marked hidden rather than absent.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Inspector } from './Inspector.js';
import { paneId, windowShortcut } from './shortcuts.js';
import { UndoProvider } from './Undo.js';
import { createUndoQueue } from './undo-queue.js';
import type { InspectorTab } from './client-state.js';
import type { Workspace } from './types.js';

const workspace = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Workspace',
  status: 'running',
  storageBytes: 0,
  storageLimitBytes: 1_000_000,
  imageRevision: '1',
  region: 'local',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z'
} as unknown as Workspace;

// Files reaches for the undo queue every destructive action in the client runs through.
const render = (open: Workspace | undefined, initialTab: InspectorTab): string =>
  renderToStaticMarkup(
    <UndoProvider value={createUndoQueue({ onChange: () => undefined, onError: () => undefined })}>
      <Inspector workspace={open} initialTab={initialTab} />
    </UndoProvider>
  );

const markup = render(workspace, 'files');

describe('the panel behind the tabs', () => {
  it('gives every tab a panel of its own, all four present at once', () => {
    for (const id of ['files', 'computer', 'terminal', 'preview'])
      expect(markup).toContain(`id="inspector-panel-${id}"`);
  });

  it('hides the three that are not selected instead of leaving them out', () => {
    const panel = (id: string): string =>
      `<div id="inspector-panel-${id}" role="tabpanel" aria-labelledby="inspector-tab-${id}" class="inspector-panel"`;
    for (const id of ['computer', 'terminal', 'preview'])
      expect(markup).toContain(`${panel(id)} hidden=""`);
    expect(markup).toContain(`${panel('files')}>`);
  });

  it('points each tab at its own panel, so the tablist wiring survives the split', () => {
    for (const id of ['files', 'computer', 'terminal', 'preview'])
      expect(markup).toContain(`aria-controls="inspector-panel-${id}"`);
  });

  /*
   * Mounted is earned, not automatic. A terminal is a shell on the box and a preview is a poll, so
   * a tab the owner has never opened builds nothing - only the pane on screen has any content on
   * the first paint.
   */
  it('builds only the pane that is being looked at', () => {
    expect(markup).toContain('files-pane');
    expect(markup).not.toContain('terminal-pane');
    expect(markup).not.toContain('computer-pane');
  });

  /*
   * A place the keyboard can land.
   *
   * The panel used to be reachable only by tabbing past every conversation in the sidebar and the
   * whole transcript. It is a named region with `tabIndex={-1}` so ⌘4, ⌘⌥1–4 and F6 have somewhere
   * to put focus, and the id is the one `shortcuts.ts` aims at rather than a second spelling.
   */
  it('is a region the keyboard can be sent to', () => {
    expect(markup).toContain(`id="${paneId('tools')}"`);
    expect(markup).toContain('aria-label="Computer tools"');
    expect(markup).toContain('tabindex="-1"');
  });

  /*
   * ⌘⌥1–4 choose these tabs by position, so the order of this strip is part of what those keys
   * mean. A tab inserted here without a thought for that would silently rebind two of them.
   */
  it('keeps the strip in the order the ⌘⌥ digits name', () => {
    const strip = ['files', 'computer', 'terminal', 'preview'];
    const at = strip.map((id) => markup.indexOf(`id="inspector-tab-${id}"`));
    expect(at.every((index) => index > -1)).toBe(true);
    expect(at).toEqual([...at].sort((left, right) => left - right));
    for (const [index, id] of strip.entries())
      expect(
        windowShortcut(
          {
            key: String(index + 1),
            code: `Digit${index + 1}`,
            metaKey: true,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
            inField: false
          },
          { agentWorking: false }
        )
      ).toBe(`tool-${id}`);
  });
});

/*
 * The fourth place answers "what is this computer doing", and it used to open on a form asking the
 * owner to guess which port their own machine was listening on. The order of the pane is the whole
 * of that change, so it is the thing worth pinning: processes first, the port form last.
 */
describe('the fourth pane', () => {
  const running = render(workspace, 'preview');

  it('is called Running', () => {
    expect(markup).toContain('>Running</button>');
    expect(markup).not.toContain('>Preview</button>');
  });

  /*
   * The rename is a fact about the product, not about this component, and the one control it missed
   * was the one this file cannot see: the artifact card in the transcript still said "Preview". A
   * guard narrower than the thing it guards is how that survived.
   */
  it('is called Running everywhere a control names it', () => {
    for (const file of ['App.tsx', 'Timeline.tsx', 'Inspector.tsx'])
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain(
        '>Preview</button>'
      );
  });

  it('leads with what is running and demotes the port form to the bottom', () => {
    expect(running.indexOf('running-list')).toBeGreaterThan(-1);
    expect(running.indexOf('running-list')).toBeLessThan(running.indexOf('preview-create'));
  });

  /*
   * Quiet either way: one line, no illustration. Which line it is matters — the pane used to state
   * "Nothing is running" on first paint, before it had asked, so a box with three servers up opened
   * on a falsehood. An empty list is only news once it is an answer.
   */
  it('does not claim the computer is idle before it has asked', () => {
    expect(running).toContain('Asking the computer what it is running');
    expect(running).not.toContain('Nothing is running in the background.');
    expect(running).not.toContain('empty-pane');
  });
});

describe('the panel with no workspace to show', () => {
  const offline = render(undefined, 'terminal');

  // One panel, carrying the selected tab's id, so the tab pointing at it points at something real.
  it('keeps the selected tab pointing at a panel that exists', () => {
    expect(offline).toContain('id="inspector-panel-terminal"');
    expect(offline).toContain('The agent computer is not answering');
  });
});
