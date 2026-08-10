import { describe, expect, it } from 'vitest';
import { inertOutside } from './inert-outside.js';

/**
 * A minimal stand-in for an element tree, because this package renders with `renderToStaticMarkup`
 * and has no DOM. Only what the function touches: children, parents, and the three attribute calls.
 */
class FakeElement {
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  constructor(readonly name: string) {}
  append(...kids: FakeElement[]): this {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
    }
    return this;
  }
  hasAttribute(key: string): boolean {
    return this.attributes.has(key);
  }
  getAttribute(key: string): string | null {
    return this.attributes.get(key) ?? null;
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key);
  }
}

const tree = () => {
  const sidebar = new FakeElement('sidebar');
  const conversation = new FakeElement('conversation');
  const pane = new FakeElement('pane');
  const toolbar = new FakeElement('toolbar');
  const inspector = new FakeElement('inspector').append(conversation, pane);
  const undo = new FakeElement('undo');
  undo.setAttribute('data-layer', 'undo');
  const shell = new FakeElement('shell').append(sidebar, inspector);
  const body = new FakeElement('body').append(shell, undo);
  pane.append(toolbar);
  return { body, shell, sidebar, inspector, conversation, pane, toolbar, undo };
};

const inert = (element: FakeElement): boolean => element.hasAttribute('inert');

describe('making everything except one subtree unreachable', () => {
  it('reaches past the immediate parent, which is where a nested overlay lives', () => {
    const t = tree();
    inertOutside(t.pane as unknown as Element);

    // Its sibling, and the sibling of its container - one level of sweeping would miss the latter,
    // which is the whole reason this exists rather than reusing Dialog's version.
    expect(inert(t.conversation)).toBe(true);
    expect(inert(t.sidebar)).toBe(true);
  });

  it('leaves the overlay, its ancestors and its contents alone', () => {
    const t = tree();
    inertOutside(t.pane as unknown as Element);
    expect(inert(t.pane)).toBe(false);
    expect(inert(t.toolbar)).toBe(false);
    expect(inert(t.inspector)).toBe(false);
    expect(inert(t.shell)).toBe(false);
  });

  it('exempts the undo layer, so a delete stays undoable while a pane is open', () => {
    const t = tree();
    inertOutside(t.pane as unknown as Element);
    expect(inert(t.undo)).toBe(false);
  });

  it('puts everything back, and only what it took', () => {
    const t = tree();
    // Something already inert for its own reasons must stay that way afterwards.
    t.sidebar.setAttribute('inert', '');
    const release = inertOutside(t.pane as unknown as Element);
    release();
    expect(inert(t.conversation)).toBe(false);
    expect(inert(t.sidebar)).toBe(true);
  });
});
