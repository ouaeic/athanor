import { describe, expect, it } from 'vitest';
import { KEYBOARD_OPEN_PX, keyboardInset, type ViewportMetrics } from './keyboard-inset.js';

/** A desktop window, or any phone with the keyboard down: the two viewports agree. */
const settled: ViewportMetrics = {
  innerHeight: 852,
  visualHeight: 852,
  offsetTop: 0,
  scale: 1
};

const measure = (patch: Partial<ViewportMetrics> = {}) => keyboardInset({ ...settled, ...patch });

describe('keyboardInset', () => {
  it('reports nothing when the viewports agree', () => {
    expect(measure()).toEqual({ pixels: 0, open: false });
  });

  it('measures the iPhone case that motivated this: 852px layout, 516px visible', () => {
    expect(measure({ visualHeight: 516 })).toEqual({ pixels: 336, open: true });
  });

  it('subtracts the offset, because the strip is measured in the layout viewport', () => {
    // The same 336px keyboard, with WebKit having shifted the visible box 40px down the layout
    // viewport to keep the caret above it. `dvh` and every fixed element are laid out against the
    // layout viewport, so what they must clear is the 296px still hidden below its bottom edge -
    // the other 40px of the keyboard now overlaps ground that has already scrolled past the top.
    // Ignoring `offsetTop` would over-report by exactly that 40px and open a gap under the composer.
    expect(measure({ visualHeight: 516, offsetTop: 40 })).toEqual({ pixels: 296, open: true });
  });

  it('stays at zero where the browser already shrank the layout viewport', () => {
    // Chromium honouring `interactive-widget=resizes-content`: both numbers fall together, so the
    // CSS must not subtract a second keyboard on top of the one `dvh` has already accounted for.
    expect(measure({ innerHeight: 516, visualHeight: 516 })).toEqual({ pixels: 0, open: false });
  });

  it('leaves the accessory bar of a paired hardware keyboard below the floor', () => {
    const bar = measure({ visualHeight: 852 - 55 });
    expect(bar.pixels).toBe(55);
    expect(bar.open).toBe(false);
  });

  it('opens exactly at the floor', () => {
    expect(measure({ visualHeight: 852 - KEYBOARD_OPEN_PX }).open).toBe(true);
    expect(measure({ visualHeight: 852 - (KEYBOARD_OPEN_PX - 1) }).open).toBe(false);
  });

  it('declines to measure while the page is pinch-zoomed', () => {
    // Zoomed to 2x the visible box is half the page and offset arbitrarily; that is not a keyboard,
    // and treating it as one would fold the shell to nothing under the owner's fingers.
    expect(measure({ visualHeight: 426, offsetTop: 120, scale: 2 })).toEqual({
      pixels: 0,
      open: false
    });
  });

  it('still measures through the rounding error a zoom reset leaves behind', () => {
    expect(measure({ visualHeight: 516, scale: 1.004 }).pixels).toBe(336);
  });

  it('clamps the rubber band, which drives the offset past the end of the page', () => {
    expect(measure({ offsetTop: 90 })).toEqual({ pixels: 0, open: false });
  });

  it('clamps to the window, so no reading can be taller than the screen', () => {
    expect(measure({ visualHeight: -400 }).pixels).toBe(852);
  });

  it('rounds, because the result is written into a stylesheet every frame', () => {
    expect(measure({ visualHeight: 515.5, offsetTop: 0.2 }).pixels).toBe(336);
  });

  it('answers zero rather than NaN when a reading is missing', () => {
    expect(measure({ visualHeight: Number.NaN })).toEqual({ pixels: 0, open: false });
    expect(measure({ innerHeight: 0, visualHeight: 0 })).toEqual({ pixels: 0, open: false });
  });
});
