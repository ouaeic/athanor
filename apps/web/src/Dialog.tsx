import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dialogKeyAction, focusableSelector, nextFocusIndex } from './focus-trap.js';

/**
 * Everything modal in athanor goes through here: a portal to the document body, the background
 * marked `inert` so neither Tab nor a screen reader's virtual cursor can wander behind the scrim,
 * Tab wrapped inside the dialog, Escape to close, and focus returned to whatever opened it.
 */
export function Dialog({
  backdropClassName = 'modal-backdrop',
  className,
  label,
  labelledBy,
  onClose,
  closeOnBackdrop = false,
  children
}: {
  backdropClassName?: string;
  className: string;
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const scrim = backdrop.current;
    const dialog = panel.current;
    if (!scrim || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const madeInert: Element[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling === scrim || sibling.hasAttribute('inert')) continue;
      // The undo layer is deliberately exempt; it belongs to whatever is on top.
      if (sibling.getAttribute('data-layer') === 'undo') continue;
      sibling.setAttribute('inert', '');
      madeInert.push(sibling);
    }

    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement
      );
    const first = focusable()[0];
    (first ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const action = dialogKeyAction(event);
      if (action === 'ignore') return;
      // The keystroke stops here. It used to carry on to the window, where Escape is bound to
      // stopping the agent — so closing any modal while work was running also cancelled it.
      event.preventDefault();
      event.stopPropagation();
      if (action === 'close') {
        close.current();
        return;
      }
      const elements = focusable();
      if (elements.length === 0) {
        dialog.focus();
        return;
      }
      const index = nextFocusIndex(
        elements.length,
        elements.indexOf(document.activeElement as HTMLElement),
        action === 'focus-previous'
      );
      elements[index]?.focus();
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      for (const sibling of madeInert) sibling.removeAttribute('inert');
      opener?.focus();
    };
  }, []);

  return createPortal(
    <div
      className={backdropClassName}
      ref={backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={className}
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        {...(label ? { 'aria-label': label } : {})}
      >
        {children}
      </section>
    </div>,
    document.body
  );
}
