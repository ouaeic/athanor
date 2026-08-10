/**
 * Makes everything except one subtree unreachable, and gives back the undo.
 *
 * `Dialog` has done this since it was written, by marking the scrim's siblings `inert` so neither
 * Tab nor a screen reader's virtual cursor can wander behind it. Every overlay that is not a
 * `Dialog` was left out - the expanded computer view, the mobile navigation drawer - and those are
 * the ones drawn over the whole window, where wandering behind them is most confusing: the reader
 * is told about a conversation they cannot see and controls they cannot reach.
 *
 * Generalised from `Dialog`'s version because those overlays are nested rather than children of
 * the body, so sweeping one level does not reach them. Walking up and inerting each ancestor's
 * other children is the same idea applied at every level: everything is inert except this element,
 * what contains it, and what it contains.
 */
export const inertOutside = (element: Element): (() => void) => {
  const made: Element[] = [];
  let node: Element | null = element;
  while (node?.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      // The undo layer is deliberately exempt, exactly as in `Dialog`: it belongs to whatever is on
      // top, and a delete that cannot be undone because a pane is open is the worst of both.
      if (sibling.getAttribute('data-layer') === 'undo') continue;
      sibling.setAttribute('inert', '');
      made.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const sibling of made) sibling.removeAttribute('inert');
  };
};
