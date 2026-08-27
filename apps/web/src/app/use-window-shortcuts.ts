import { useEffect, useRef } from 'react';
import { windowShortcut } from '../shortcuts.js';
import type { InspectorTab } from '../client-state.js';

/**
 * Everything a window-level key can reach, re-read on every press.
 *
 * `stop`, `editLast` and `openTool` change with the conversation and with what the agent is doing;
 * `active` is what decides whether Escape means "stop the agent" at all.
 */
export interface ShortcutTargets {
  stop: () => void;
  editLast: () => void;
  openTool: (tab: InspectorTab) => void;
  active: boolean;
  togglePalette: () => void;
  newConversation: () => void;
  toggleTools: () => void;
  focusComposer: () => void;
  focusPane: (pane: 'conversations' | 'conversation' | 'tools') => void;
  stepFocus: (step: 1 | -1) => void;
  showShortcuts: () => void;
}

/**
 * The one keyboard listener on the window.
 *
 * Registered once — a listener re-attached on every render is a listener that misses the press
 * that happens between the two — and every target is read out of a ref that this render has just
 * refreshed, so nothing it calls is a closure over the first render. That ref used to hold four of
 * the eleven targets and the other seven were captured, which was safe only for as long as they
 * happened to be state setters; putting all eleven behind the same rule removes the question.
 */
export const useWindowShortcuts = (targets: ShortcutTargets) => {
  const live = useRef(targets);
  useEffect(() => {
    live.current = targets;
  });
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const action = windowShortcut(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          inField:
            event.target instanceof HTMLElement &&
            ['INPUT', 'TEXTAREA'].includes(event.target.tagName)
        },
        { agentWorking: live.current.active }
      );
      if (!action) return;
      event.preventDefault();
      if (action === 'palette') live.current.togglePalette();
      else if (action === 'new-conversation') live.current.newConversation();
      else if (action === 'toggle-tools') live.current.toggleTools();
      else if (action === 'focus-composer') live.current.focusComposer();
      // The editor's own reflex for "that came out wrong": reopen the last thing you sent.
      else if (action === 'edit-last') live.current.editLast();
      else if (action === 'stop-agent') live.current.stop();
      else if (action === 'pane-next' || action === 'pane-back')
        live.current.stepFocus(action === 'pane-next' ? 1 : -1);
      else if (action === 'go-conversations') live.current.focusPane('conversations');
      else if (action === 'go-conversation') live.current.focusPane('conversation');
      else if (action === 'go-tools') live.current.focusPane('tools');
      // The tool shortcuts are named after the tab they choose, so the tail of the id is the tab.
      // Going through the panel's own selection is what keeps this one route rather than a second
      // idea of which tab is showing; focus then follows, or the key would only move the picture.
      else if (action.startsWith('tool-')) {
        live.current.openTool(action.slice(5) as InspectorTab);
        live.current.focusPane('tools');
      } else live.current.showShortcuts();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
};
