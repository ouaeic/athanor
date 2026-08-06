import { describe, expect, it } from 'vitest';
import {
  approvalDiffState,
  approvalReach,
  expiryPhrase,
  needsComputer,
  nextApproval
} from './approval-copy.js';
import type { FileChange } from './diff.js';
import type { Approval } from './types.js';

const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: 'ap-1',
  taskId: 'task-1',
  action: 'Run rm',
  sideEffect: 'external_consequential',
  expiresAt: '2026-08-03T01:00:00.000Z',
  preview: { preview: 'Run rm -rf build in the workspace.', tool: 'shell', arguments: {} },
  ...patch
});

describe('approval wording', () => {
  /*
   * The box stores three side-effect values and only three. The table this replaced was keyed on
   * nine names none of which are among them, so every card in the product read "External
   * consequential" — the stored enum, on the one control where a stored enum is least acceptable.
   */
  it('says something the owner can act on for every value the box actually stores', () => {
    for (const sideEffect of ['workspace_write', 'external_reversible', 'external_consequential']) {
      const phrase = approvalReach({ sideEffect, preview: '[unavailable]' });
      expect(phrase).not.toMatch(/_/);
      expect(phrase).not.toMatch(/^External consequential$/);
      expect(phrase[0]).toBe(phrase[0]?.toUpperCase());
    }
  });

  it('prefers what the tool touches over how far the effect reaches', () => {
    expect(approvalReach(approval({ preview: { tool: 'publish_site' } }))).toBe(
      'Puts something on the public internet'
    );
    expect(approvalReach(approval({ preview: { tool: 'connector_action' } }))).toBe(
      'Uses a connected account'
    );
    // Same reach, different tools: the sentence is about the request, not about its class.
    expect(approvalReach(approval({ preview: { tool: 'publish_site' } }))).not.toBe(
      approvalReach(approval({ preview: { tool: 'shell' } }))
    );
  });

  it('falls back to the reach when the tool is one this client has never heard of', () => {
    expect(approvalReach(approval({ preview: { tool: 'quantum_entangle' } }))).toBe(
      'Reaches outside your computer, and may not be undoable'
    );
  });

  it('still reads as English for an effect this client has never heard of', () => {
    expect(approvalReach({ sideEffect: 'quantum_entangle', preview: '[unavailable]' })).toBe(
      'Quantum entangle'
    );
  });

  it('counts down rather than printing a timestamp', () => {
    const now = Date.parse('2026-08-02T01:00:00.000Z');
    expect(expiryPhrase('2026-08-02T01:04:00.000Z', now)).toBe('expires in 4 min');
    expect(expiryPhrase('2026-08-02T01:00:30.000Z', now)).toBe('expires in 30s');
    expect(expiryPhrase('2026-08-02T03:00:00.000Z', now)).toBe('expires in 2 hours');
    expect(expiryPhrase('2026-08-02T02:00:00.000Z', now)).toBe('expires in 1 hour');
  });

  it('says expired rather than a negative countdown', () => {
    const now = Date.parse('2026-08-02T01:00:00.000Z');
    expect(expiryPhrase('2026-08-02T00:59:00.000Z', now)).toBe('expired');
    expect(expiryPhrase('not a date', now)).toBe('no time limit');
  });
});

describe('which request the card shows', () => {
  it('puts the open conversation first, wherever it is in the queue', () => {
    const queue = [
      approval({ id: 'a', taskId: 'other' }),
      approval({ id: 'b', taskId: 'watching' })
    ];
    expect(nextApproval(queue, 'watching')?.id).toBe('b');
  });

  it('shows the oldest waiting request when none belongs to the open conversation', () => {
    const queue = [
      approval({ id: 'a', taskId: 'other' }),
      approval({ id: 'b', taskId: 'another' })
    ];
    expect(nextApproval(queue, 'watching')?.id).toBe('a');
    expect(nextApproval(queue, undefined)?.id).toBe('a');
    expect(nextApproval([], 'watching')).toBeUndefined();
  });
});

describe('when the card offers the computer', () => {
  /*
   * This used to be seven phrases matched against the preview prose. A secure-input handoff cannot
   * be answered from the card at all, and the sentence that said so lived in the worker.
   */
  it('offers it for the tools whose request is about a screen', () => {
    expect(needsComputer(approval({ preview: { tool: 'browser_action' } }))).toBe(true);
    expect(needsComputer(approval({ preview: { tool: 'desktop_action' } }))).toBe(true);
    expect(needsComputer(approval({ preview: { tool: 'desktop_launch' } }))).toBe(true);
  });

  it('does not offer it for a request that has nothing to look at', () => {
    expect(needsComputer(approval({ preview: { tool: 'shell' } }))).toBe(false);
    expect(needsComputer(approval({ preview: { tool: 'connector_action' } }))).toBe(false);
    expect(needsComputer(approval({ preview: '[unavailable]' }))).toBe(false);
  });

  it('survives a box that sends no tool at all', () => {
    expect(needsComputer(approval({ preview: { preview: 'Something happened' } }))).toBe(false);
  });
});

describe('the diff the card shows before a write is allowed', () => {
  const write: FileChange = { path: 'workspace/report.md', after: 'new contents' };
  const patch: FileChange = { path: 'workspace/notes.md', before: 'old', after: 'new' };

  it('shows the written preview until every side of the change is known', () => {
    expect(approvalDiffState([write], {}).ready).toBe(false);
    expect(approvalDiffState([write], { 'workspace/report.md': 'old contents' }).ready).toBe(true);
  });

  it('is ready at once when nothing has to be read back', () => {
    expect(approvalDiffState([patch], {})).toEqual({ ready: true, changes: [patch] });
    expect(approvalDiffState([], {}).ready).toBe(true);
  });

  /* A file that does not exist yet is a new file, not an empty one, and the diff must say so. */
  it('treats a path that came back missing as a file being created', () => {
    const state = approvalDiffState([write], { 'workspace/report.md': null });
    expect(state.ready).toBe(true);
    expect(state.changes[0]?.before).toBeUndefined();
  });

  it('waits for the slowest of several files rather than drawing half a change', () => {
    const second: FileChange = { path: 'workspace/other.md', after: 'x' };
    expect(approvalDiffState([write, second], { 'workspace/report.md': 'old' }).ready).toBe(false);
    expect(
      approvalDiffState([write, second], {
        'workspace/report.md': 'old',
        'workspace/other.md': null
      }).ready
    ).toBe(true);
  });
});
