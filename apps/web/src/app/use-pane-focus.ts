import { useCallback, type RefObject } from 'react';
import { paneId, panes, stepPane, type Pane } from '../shortcuts.js';

/**
 * Where the four region shortcuts put the cursor.
 *
 * The message box answers to the ref the shell already holds; the other three carry the ids in
 * `shortcuts.ts` and `tabIndex={-1}`, so focus can be put on the region itself rather than on the
 * first control inside it. `openTools` is passed in because reaching the tools pane means opening
 * it first, and that is the panel's state rather than this one's.
 */
export const usePaneFocus = (input: {
  composer: RefObject<HTMLTextAreaElement | null>;
  openTools: () => void;
}) => {
  const { composer, openTools } = input;
  const paneNode = useCallback(
    (pane: Pane): HTMLElement | null =>
      pane === 'composer' ? composer.current : document.getElementById(paneId(pane)),
    [composer]
  );
  /*
   * Reaching a whole pane, including one that is not on screen yet.
   *
   * The tools panel is code-split and each of its panes is built the first time it is looked at, so
   * the element ⌘4 asks for does not exist for a frame or two after a cold panel is opened.
   * Retrying across a handful of frames costs nothing when the element is already there, and is the
   * difference between the key working and appearing to do nothing the first time it is pressed.
   */
  const focusPane = useCallback(
    (pane: Pane) => {
      if (pane === 'tools') openTools();
      const attempt = (left: number) => {
        const node = paneNode(pane);
        if (node) node.focus();
        else if (left > 0) window.requestAnimationFrame(() => attempt(left - 1));
      };
      attempt(10);
    },
    [paneNode, openTools]
  );
  /*
   * F6 steps over a region this layout is not showing.
   *
   * On a phone the wide sidebar is `display: none` and the copy in the drawer is inert, so putting
   * focus on it would move the cursor nowhere and leave the walk pressing the same key for ever.
   * `offsetParent` is the cheap read for that; the tools panel is exempt because it is `position:
   * fixed` on a phone — and because F6 opens it on the way in, so "not on screen" is not "not a
   * destination".
   */
  const stepFocus = useCallback(
    (step: 1 | -1) => {
      const active = document.activeElement;
      const here = panes.find((pane) => paneNode(pane)?.contains(active) ?? false);
      let next = stepPane(here, step);
      for (let hop = 1; hop < panes.length; hop += 1) {
        if (next === 'tools' || paneNode(next)?.offsetParent) break;
        next = stepPane(next, step);
      }
      focusPane(next);
    },
    [focusPane, paneNode]
  );
  return { paneNode, focusPane, stepFocus };
};
