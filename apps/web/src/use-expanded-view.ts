import { useEffect, useRef, useState } from 'react';

/** CSS expansion keeps the same live surface on clients without the Fullscreen API. */
export function useExpandedView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [expanded, setExpanded] = useState(false);
  const fallback = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const changed = () => {
      if (!fallback.current) setExpanded(document.fullscreenElement === ref.current);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fallback.current) {
        fallback.current = false;
        setExpanded(false);
        returnFocus.current?.focus();
      }
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((item) => item.getClientRects().length > 0 && !item.closest('[inert]'));
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        focusable()[0]?.focus();
    };
    const tab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', tab);
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', tab);
    };
  }, [expanded]);
  async function close() {
    if (document.fullscreenElement === ref.current && document.exitFullscreen)
      await document.exitFullscreen();
    fallback.current = false;
    setExpanded(false);
    returnFocus.current?.focus();
  }
  async function toggle() {
    if (expanded) return close();
    if (!ref.current) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (ref.current.requestFullscreen) {
      try {
        await ref.current.requestFullscreen();
        setExpanded(true);
        return;
      } catch {
        // Embedded clients may expose the method without granting native fullscreen.
      }
    }
    fallback.current = true;
    setExpanded(true);
  }
  return { ref, expanded, toggle, close };
}
