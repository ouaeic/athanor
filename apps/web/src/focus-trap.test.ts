import { describe, expect, it } from 'vitest';
import { dialogKeyAction, focusableSelector, nextFocusIndex, nextTabIndex } from './focus-trap.js';

describe('nextFocusIndex', () => {
  it('wraps forward at the end and backward at the start', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it('moves one step in either direction', () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, true)).toBe(1);
  });

  it('enters at the matching edge when focus is outside the dialog', () => {
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it('reports nothing to focus for an empty dialog', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});

describe('focusableSelector', () => {
  it('excludes disabled controls and programmatic-only tab stops', () => {
    expect(focusableSelector).toContain('button:not([disabled])');
    expect(focusableSelector).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe('the keys an open dialog owns', () => {
  it('takes Escape, and does not let it reach the workbench behind it', () => {
    expect(dialogKeyAction({ key: 'Escape', shiftKey: false })).toBe('close');
  });

  it('moves focus on Tab, both ways', () => {
    expect(dialogKeyAction({ key: 'Tab', shiftKey: false })).toBe('focus-next');
    expect(dialogKeyAction({ key: 'Tab', shiftKey: true })).toBe('focus-previous');
  });

  it('leaves every other keystroke to whatever is focused inside it', () => {
    expect(dialogKeyAction({ key: 'a', shiftKey: false })).toBe('ignore');
    expect(dialogKeyAction({ key: 'Enter', shiftKey: false })).toBe('ignore');
    expect(dialogKeyAction({ key: 'ArrowDown', shiftKey: false })).toBe('ignore');
  });
});

describe('moving through a tab strip', () => {
  it('wraps at both ends, so the arrows never dead-end', () => {
    expect(nextTabIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextTabIndex('ArrowRight', 3, 4)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(nextTabIndex('ArrowLeft', 2, 4)).toBe(1);
  });

  it('takes Home and End to the ends', () => {
    expect(nextTabIndex('Home', 2, 4)).toBe(0);
    expect(nextTabIndex('End', 2, 4)).toBe(3);
  });

  it('leaves every other key to the tab that has focus', () => {
    expect(nextTabIndex('Enter', 1, 4)).toBe(-1);
    expect(nextTabIndex('ArrowDown', 1, 4)).toBe(-1);
    expect(nextTabIndex('a', 1, 4)).toBe(-1);
  });

  it('enters at the first tab when focus is somewhere the strip does not own', () => {
    expect(nextTabIndex('ArrowRight', -1, 4)).toBe(1);
    expect(nextTabIndex('ArrowLeft', -1, 4)).toBe(3);
    expect(nextTabIndex('ArrowRight', 0, 0)).toBe(-1);
  });
});
