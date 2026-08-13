import { describe, expect, it } from 'vitest';
import { describeAcceptanceCheck, parseAcceptanceChecks } from './acceptance.js';
import { agentTools } from './tools.js';

const parse = (check: Record<string, unknown>) => parseAcceptanceChecks([check]);

const artifact = {
  kind: 'artifact',
  label: 'The deck is twelve slides and none of them is cut off',
  path: 'workspace/board/deck.pptx',
  minBytes: 20_000
};

describe('an artifact check that is about the pages rather than the bytes', () => {
  it('keeps what the job asked for and defaults the margin to the page edge itself', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({
      kind: 'artifact',
      path: 'workspace/board/deck.pptx',
      minBytes: 20_000,
      render: { expectPages: 12, marginPoints: 0 }
    });
  });

  it('leaves a check that did not ask for a render exactly as it was', () => {
    const parsed = parse(artifact);
    // Named rather than inferred from a matcher: a size check that quietly grew a render clause
    // would be a measurement the model never declared and the owner was never shown.
    expect(parsed.ok && 'render' in parsed.checks[0]!).toBe(false);
  });

  it('refuses a render clause on a file that has no rendered page', () => {
    for (const path of ['workspace/notes.md', 'workspace/report', 'workspace/data.csv']) {
      const parsed = parse({ ...artifact, path, render: {} });
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('has no rendered page');
    }
  });

  it('accepts a clause that names nothing, because it still says the pages are intact', () => {
    const parsed = parse({ ...artifact, path: 'workspace/cv.pdf', render: {} });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({ render: { marginPoints: 0 } });
  });

  it('refuses a page count that is not a number of pages', () => {
    for (const expectPages of [0, -3, 1.5, 'one']) {
      const parsed = parse({ ...artifact, render: { expectPages } });
      expect(!parsed.ok && parsed.reason).toContain('whole number of pages');
    }
  });

  /**
   * The half that decides whether any of the above is reachable at all.
   *
   * `set_acceptance` declares `additionalProperties: false`, so a clause this file parses but the
   * catalogue does not offer is a measurement no model can ask for - the whole thing inert, with
   * the parser and the description reading exactly as though it worked. Held against the schema
   * the model is actually sent, and against the fields the parser actually reads.
   */
  it('is a clause the model is offered, not only one this file can read', () => {
    const declared = agentTools.find((tool) => tool.name === 'set_acceptance');
    const properties = (
      declared?.parameters as {
        properties: { checks: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.checks.items.properties;
    expect(Object.keys(properties)).toContain('render');
    expect(Object.keys((properties.render as { properties: object }).properties)).toEqual([
      'expectPages',
      'marginPoints'
    ]);
  });
});

describe('what the owner is shown before the work starts', () => {
  it('says what will be measured, in pages and words rather than in tools', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The deck is twelve slides and none of them is cut off): workspace/board/deck.pptx exists and is at least 20000 bytes, and renders as exactly 12 pages with no text cut off at a page edge and no page blank'
    );
  });

  it('names the margin when the job was given one', () => {
    const parsed = parse({
      ...artifact,
      path: 'workspace/cv.pdf',
      render: { expectPages: 1, marginPoints: 36 }
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toContain(
      'renders as exactly 1 page with every word inside a 36pt margin and no page blank'
    );
  });

  it('describes a plain size check the way it always did', () => {
    const parsed = parse({
      kind: 'artifact',
      label: 'The report exists',
      path: 'workspace/out.txt'
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The report exists): workspace/out.txt exists and is at least 1 bytes'
    );
  });
});
