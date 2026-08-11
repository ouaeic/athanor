/**
 * How much of the window the software keyboard is currently covering.
 *
 * The viewport meta asks for `interactive-widget=resizes-content`, which is Chromium-only. WebKit
 * ignores it: on an iPhone 15 the layout viewport stays 852px tall while the keyboard covers about
 * 336px of it, so `100dvh` describes a box a third of which is behind glass the owner cannot see.
 * Everything the phone layout anchors to the bottom edge - the five-tab bar, the composer above it,
 * the inspector's bottom inset - is then anchored to the wrong edge, and the header is pushed off
 * the top of the screen as WebKit scrolls the visual viewport to keep the caret in view.
 *
 * The only thing that knows the real number is `visualViewport`, and turning its three readings
 * into one is the whole decision, so it lives here rather than inside a resize handler that cannot
 * be run without a browser.
 */

export interface ViewportMetrics {
  /** `window.innerHeight`: the layout viewport, which WebKit does not shrink for the keyboard. */
  innerHeight: number;
  /** `visualViewport.height`: what is actually visible. */
  visualHeight: number;
  /** `visualViewport.offsetTop`: how far the visible box has been scrolled down within the page. */
  offsetTop: number;
  /** `visualViewport.scale`: 1 unless the owner has pinched. */
  scale: number;
}

export interface KeyboardInset {
  /** Whole CSS pixels hidden at the bottom edge. Whole, because this is written to a style. */
  pixels: number;
  /** Past the floor below, so the interface may stand down for the duration. */
  open: boolean;
}

/**
 * The floor that separates a keyboard from the furniture around one.
 *
 * iOS reports its own bars through the same measurement: the form accessory bar is roughly 44px,
 * and about 55px with a hardware keyboard paired. A software keyboard is never below 250px on any
 * shipping iPhone. 120px sits in the empty band between the two, so a paired keyboard's bar never
 * folds the tab bar away and a real keyboard always does.
 */
export const KEYBOARD_OPEN_PX = 120;

const CLOSED: KeyboardInset = { pixels: 0, open: false };

/**
 * Zero is the answer whenever the reading cannot be trusted, because zero is what the interface
 * did before this existed. A wrong positive here would shrink the shell around nothing.
 *
 * Pinch-zoom is the case worth naming: while zoomed, the visual viewport is a small window onto a
 * large layout viewport, and the arithmetic below would read hundreds of pixels of "keyboard" and
 * collapse the workbench. `scale` is the only signal that separates that from a keyboard, so above
 * 1 the measurement is declined rather than guessed at.
 */
export const keyboardInset = ({
  innerHeight,
  visualHeight,
  offsetTop,
  scale
}: ViewportMetrics): KeyboardInset => {
  if (!Number.isFinite(innerHeight) || innerHeight <= 0) return CLOSED;
  if (!Number.isFinite(visualHeight) || !Number.isFinite(offsetTop)) return CLOSED;
  if (Number.isFinite(scale) && scale > 1.01) return CLOSED;

  const covered = innerHeight - visualHeight - offsetTop;
  // Clamped at both ends: rubber-band scrolling drives `offsetTop` past the bottom of the page for
  // a frame or two and makes this negative, and no keyboard can be taller than the window.
  const pixels = Math.round(Math.min(Math.max(covered, 0), innerHeight));
  return { pixels, open: pixels >= KEYBOARD_OPEN_PX };
};
