import { useEffect, useRef, useState } from 'react';

/**
 * The navigation drawer a phone opens over the workbench, and the way back out of it.
 *
 * One flag and one element, kept together because the element only exists to answer the flag: the
 * control that opened the drawer is where focus has to land when it closes, and nothing else in the
 * shell needs to know either.
 */
export const useMobileNav = () => {
  const [open, setOpen] = useState(false);
  // Escape closes the navigation drawer, and the control that opened it gets the focus back. Every
  // other overlay gets both from Dialog; this one covers the screen on a phone and had neither, so
  // a keyboard was left inside a drawer with no way out but the pointer.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    /*
     * Capture, and consumed. Escape is also mapped to stop-agent while the agent is working, on a
     * window listener in the bubble phase - so closing this drawer stopped the running task too,
     * silently. Capture on the document runs first, and stopping propagation there means Escape
     * closes the drawer and does nothing else.
     */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      opener.current?.focus();
    };
  }, [open]);
  return { open, setOpen, opener };
};
