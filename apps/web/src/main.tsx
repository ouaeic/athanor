import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { keyboardInset } from './keyboard-inset.js';
import './styles/room.css';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

// Caught, not because there is anything to do about it, but because on the certificate this product
// ships by default registration always fails - and an uncaught rejection on the first line of the
// application is noise in the one console a new owner is most likely to have open.
if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);

/**
 * Publish the height of the software keyboard so the stylesheet can stop guessing at it.
 *
 * `--keyboard` is the measured strip at the bottom of the window that the owner cannot see, and
 * `data-keyboard="open"` on `<html>` is the state that the bottom tab bar stands down for - five
 * destinations are meaningless mid-sentence, and on a 375px screen they are the space the composer
 * needs. Both are absent until something measures them, so every rule reads through
 * `var(--keyboard, 0px)` and a browser without `visualViewport` behaves exactly as it did.
 *
 * Two details that are load-bearing rather than tidy. The listeners fire continuously through the
 * keyboard's own animation - dozens of events for one gesture - so the work is coalesced onto a
 * frame and an unchanged pixel count writes nothing at all; a style write per event would invalidate
 * layout on every one of them, on the device least able to afford it. And `scroll` is subscribed
 * alongside `resize` because WebKit reports the caret-following shift only as a scroll of the
 * visual viewport, with no resize behind it.
 */
const trackKeyboardInset = (): (() => void) => {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const root = document.documentElement;
  let frame = 0;
  let published = -1;

  const measure = (): void => {
    frame = 0;
    const { pixels, open } = keyboardInset({
      innerHeight: window.innerHeight,
      visualHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale
    });
    if (pixels === published) return;
    published = pixels;
    root.style.setProperty('--keyboard', `${pixels}px`);
    if (open) root.setAttribute('data-keyboard', 'open');
    else root.removeAttribute('data-keyboard');
  };

  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(measure);
  };

  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  // A tab restored from the back/forward cache can come back with the keyboard already raised, so
  // the first reading is taken now rather than waiting for a gesture that may never come.
  measure();

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    root.style.removeProperty('--keyboard');
    root.removeAttribute('data-keyboard');
  };
};

const stopTrackingKeyboardInset = trackKeyboardInset();
// This module is evaluated again on every hot update in dev; without this the listeners stack up
// and the same measurement is taken several times per frame.
import.meta.hot?.dispose(stopTrackingKeyboardInset);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
