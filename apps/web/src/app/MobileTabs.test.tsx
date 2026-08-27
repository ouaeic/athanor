/**
 * The phone's one pane switcher.
 *
 * Its whole judgement is a single sentence — the tab that is showing is not always the tab that was
 * chosen — and while it lived inside `App()` there was no way to state it except by opening the app
 * on a phone. The panel follows the running work, so a bar that pointed at the owner's stored choice
 * would say they were looking at Files while a terminal filled the window.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileTabs, activeMobileTab } from './MobileTabs.js';

describe('which pane the phone bar points at', () => {
  it('is Work whenever the panel is closed, whatever tab it would show', () => {
    expect(activeMobileTab({ id: 'work', inspectorOpen: false, shownTab: 'terminal' })).toBe(true);
    expect(activeMobileTab({ id: 'terminal', inspectorOpen: false, shownTab: 'terminal' })).toBe(
      false
    );
  });

  it('is the pane actually on screen, not the one the owner last named', () => {
    // `shownTab` is the panel's answer after following the work; the bar reads that and nothing else.
    expect(activeMobileTab({ id: 'terminal', inspectorOpen: true, shownTab: 'terminal' })).toBe(
      true
    );
    expect(activeMobileTab({ id: 'files', inspectorOpen: true, shownTab: 'terminal' })).toBe(false);
  });

  it('never points at Work while the panel is open', () => {
    expect(activeMobileTab({ id: 'work', inspectorOpen: true, shownTab: 'files' })).toBe(false);
  });

  it('reaches all five surfaces, so nothing needs an overflow menu', () => {
    const markup = renderToStaticMarkup(
      <MobileTabs
        inspectorOpen={false}
        shownTab="files"
        onWork={() => undefined}
        onTab={() => undefined}
      />
    );
    for (const label of ['Work', 'Files', 'Computer', 'Terminal', 'Running'])
      expect(markup).toContain(label);
  });

  it('marks exactly one destination as the current page', () => {
    const markup = renderToStaticMarkup(
      <MobileTabs
        inspectorOpen
        shownTab="computer"
        onWork={() => undefined}
        onTab={() => undefined}
      />
    );
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
