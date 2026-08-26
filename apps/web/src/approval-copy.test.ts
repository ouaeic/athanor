import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approvalAnnouncement,
  approvalDiffState,
  approvalProvenance,
  approvalReach,
  approvalToolPhrases,
  expiryNote,
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

  it('says what the tool touches and how far the effect reaches, never only one of them', () => {
    expect(approvalReach(approval({ preview: { tool: 'publish_site' } }))).toBe(
      'Puts something on the public internet · reaches outside your computer, and may not be undoable'
    );
    expect(approvalReach(approval({ preview: { tool: 'connector_action' } }))).toBe(
      'Uses a connected account · reaches outside your computer, and may not be undoable'
    );
    // Same reach, different tools: the sentence is about the request, not about its class.
    expect(approvalReach(approval({ preview: { tool: 'publish_site' } }))).not.toBe(
      approvalReach(approval({ preview: { tool: 'shell' } }))
    );
  });

  /*
   * The defect this composition exists to remove. `approvalReach` returned the tool phrase when it
   * had one and only fell back to the reach, so `sideEffect` — the single fact the box records
   * about every approval — was discarded for sixteen of the eighteen tools that can raise one. A
   * coordinate click that may not be undoable and a scroll that can be read as the same six words.
   */
  it('tells one desktop_action from another when only the reversibility differs', () => {
    const consequential = approvalReach(
      approval({ sideEffect: 'external_consequential', preview: { tool: 'desktop_action' } })
    );
    const reversible = approvalReach(
      approval({ sideEffect: 'external_reversible', preview: { tool: 'desktop_action' } })
    );
    expect(consequential).not.toBe(reversible);
    expect(consequential).toContain('may not be undoable');
    expect(reversible).not.toContain('may not be undoable');
    // Both still name the tool: composing did not cost the specific answer.
    expect(consequential).toContain('Uses an application on your computer');
    expect(reversible).toContain('Uses an application on your computer');
  });

  /*
   * The comment above `approvalToolPhrases` claims the table covers every tool that can raise an
   * approval. It claimed that while missing two of them — `audio_read`, whose entire subject is
   * provider spend, and `parallel_web_read`, whose entire subject is addresses data leaves by — so
   * both degraded to a bare reach phrase over a JSON dump of the call.
   *
   * Read out of the worker's own floor rather than from a list kept beside the table, because a
   * list kept beside the table is what drifted. Step 5 promotes this to a repository check, so a
   * new branch in the worker fails the build rather than one client's test suite.
   */
  it('has a phrase for every tool the worker can raise an approval for', () => {
    const floor = readFileSync(
      new URL('../../worker/src/approval-policy.ts', import.meta.url),
      'utf8'
    );
    const raised = new Set(
      [...floor.matchAll(/\bname === '([a-z_]+)'/g)].flatMap((match) => match[1] ?? [])
    );
    // A regex that stopped matching would otherwise pass this test by covering nothing.
    expect(raised.size).toBeGreaterThanOrEqual(18);
    expect([...raised].filter((tool) => !(tool in approvalToolPhrases))).toEqual([]);
    expect([...raised]).toContain('audio_read');
    expect([...raised]).toContain('parallel_web_read');
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

/*
 * A lapse is not a block and not a denial: the worker records the request as expired, skips the
 * action and carries the turn on. The countdown never said which way it failed, so twenty-three
 * hours of "expires in 23 hours" read as a request that would wait.
 */
describe('what the countdown says happens if nobody answers', () => {
  const now = Date.parse('2026-08-02T01:00:00.000Z');

  it('names the consequence of doing nothing beside the time left', () => {
    const note = expiryNote('2026-08-03T00:00:00.000Z', now);
    expect(note).toContain('expires in 23 hours');
    expect(note).toContain('if it lapses it is not run');
    expect(note).toContain('athanor carries on without it');
  });

  it('says a lapsed request was skipped rather than refused', () => {
    const note = expiryNote('2026-08-02T00:59:00.000Z', now);
    expect(note).toContain('expired');
    expect(note).toContain('it was not run');
    expect(note).not.toContain('if it lapses');
    expect(note).not.toMatch(/denied|refused|blocked/);
  });

  it('promises nothing about a window it cannot read', () => {
    expect(expiryNote('not a date', now)).toBe('no time limit');
  });
});

/*
 * `origin` is written onto the approval by the turn that raised it. The card had no reader for it
 * at all, and the provenance line it did draw was computed from the open conversation's trajectory
 * — so it was silent for a request raised somewhere else, which `nextApproval` makes the ordinary
 * case.
 */
describe('where the card says the instruction came from', () => {
  const derived = { exposed: true, text: 'This conversation has read content from example.com.' };

  it('prefers the origin recorded on the request over the one derived from the timeline', () => {
    const note = approvalProvenance(approval({ origin: 'mail.example.com' }), derived);
    expect(note?.exposed).toBe(true);
    expect(note?.text).toContain('mail.example.com');
    expect(note?.text).toContain('could be the one asking for this');
  });

  it('falls back to the timeline when the turn carried no taint', () => {
    expect(approvalProvenance(approval({ origin: null }), derived)).toBe(derived);
    expect(approvalProvenance(approval(), derived)).toBe(derived);
  });

  /* An older box has no column to send, and a card that invented a line would be inventing a fact. */
  it('says nothing at all when neither answer is available', () => {
    expect(approvalProvenance(approval(), undefined)).toBeUndefined();
    expect(approvalProvenance(approval({ origin: '   ' }), undefined)).toBeUndefined();
  });

  /*
   * The origin is derived from content that came from outside. A right-to-left override inside it
   * renders as a different host, which is the one trick this card cannot afford to fall for.
   */
  it('strips the characters that would let an origin render as another host', () => {
    const note = approvalProvenance(approval({ origin: 'bank\u202Eelpmaxe.evil' }), undefined);
    expect(note?.text).not.toMatch(/[\u202a-\u202e]/);
    expect(note?.text).toContain('bankelpmaxe.evil');
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

describe('what the card is allowed to say out loud', () => {
  /*
   * The card was `aria-live="assertive"` over a countdown that re-renders every twenty seconds, so
   * a screen reader read "expires in 43s", then "expires in 23s", over whatever the owner was
   * reading — loudest in the last minute, when what they are reading is the command itself.
   */
  it('says what arrived, once, and never says how long is left', () => {
    const first = approvalAnnouncement({
      approval: approval(),
      waiting: 1,
      announcedId: undefined
    });
    expect(first?.id).toBe('ap-1');
    expect(first?.message).toContain('Your confirmation is required');
    expect(first?.message).toContain('Runs a command on your computer');
    expect(first?.message).not.toMatch(/expires|\ds\b|minute/);
  });

  it('says nothing at all on the next tick of the same request', () => {
    expect(
      approvalAnnouncement({ approval: approval(), waiting: 1, announcedId: 'ap-1' })
    ).toBeUndefined();
    // Nor when the queue behind it changes: only a different request in front is news.
    expect(
      approvalAnnouncement({ approval: approval(), waiting: 3, announcedId: 'ap-1' })
    ).toBeUndefined();
  });

  /* The buttons are reused across requests, so the owner has to hear that this is a new one. */
  it('speaks again when a different request takes its place', () => {
    const next = approvalAnnouncement({
      approval: approval({ id: 'ap-2', preview: { tool: 'publish_site' } }),
      waiting: 1,
      announcedId: 'ap-1'
    });
    expect(next?.id).toBe('ap-2');
    expect(next?.message).toContain('Puts something on the public internet');
  });

  it('counts the queue only when there is one', () => {
    expect(
      approvalAnnouncement({ approval: approval(), waiting: 1, announcedId: undefined })?.message
    ).not.toContain('waiting');
    expect(
      approvalAnnouncement({ approval: approval(), waiting: 3, announcedId: undefined })?.message
    ).toContain('3 waiting');
  });

  it('has nothing to say when nothing is waiting', () => {
    expect(
      approvalAnnouncement({ approval: undefined, waiting: 0, announcedId: undefined })
    ).toBeUndefined();
  });
});
