/**
 * The review queue: what is on screen, and what each of the three verbs actually does to the box.
 *
 * The queue exists to stop a remembered procedure disappearing without the owner ever seeing it, so
 * the cases here are about the two halves of that promise. The markup cases assert that a row says
 * *why* it is here in the case's own words — the three reasons mean different things and one of
 * them is "this is fine, just quiet", so a screen that flattened them would be telling somebody to
 * delete a working procedure. The verb cases go through `fetch`, because a control that removes a
 * row from the screen without the box hearing about it is precisely the defect this queue is for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyMemoryReviewVerb,
  memoryExcerptIsClipped,
  memoryOriginFact,
  memoryOriginLabel,
  memoryReviewContradictions,
  memoryReviewFacts,
  memoryReviewFailure,
  memoryReviewIsEmpty,
  MemoryReviewLists,
  memoryProposalStanding,
  memoryReviewReason,
  refuseMemoryProposals,
  withoutMemoryItem,
  withoutMemoryProposal,
  withoutMemoryProposals
} from './MemoryReview.js';
import type { MemoryProposal, MemoryReview, MemoryReviewItem } from './api.js';

const item = (over: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  id: 'item-1',
  kind: 'procedure',
  status: 'active',
  excerpt: 'Deploy by running `athanor update` on the box, never from the laptop.',
  observedAt: '2026-02-01T09:00:00.000Z',
  taskId: 'task-9',
  trust: 'derived',
  origin: 'watched',
  validFrom: '2026-02-01T09:00:00.000Z',
  validTo: null,
  lastVerified: null,
  okCount: 2,
  failCount: 5,
  useCount: 7,
  pin: false,
  ...over
});

const queue = (over: Partial<MemoryReview> = {}): MemoryReview => ({
  procedures: [
    {
      ...item(),
      reason: 'failing',
      recentOkCount: 1,
      recentGradedCount: 5
    }
  ],
  disputed: [],
  proposals: [],
  ...over
});

const render = (value: MemoryReview): string =>
  renderToStaticMarkup(<MemoryReviewLists queue={value} onAct={() => undefined} />);

describe('a remembered procedure that may have stopped working', () => {
  /* The plan's own case: a row that has lost more than it has won is in the queue, and says so. */
  it('renders a procedure that fails more than it works, and says which of the three reasons it is', () => {
    const markup = render(queue());
    expect(markup).toContain('Deploy by running `athanor update` on the box');
    expect(markup).toContain('Failing now');
    expect(markup).toContain('It worked 1 of the last 5 times it was used');
  });

  /*
   * The store's comment is emphatic that these two cases mean opposite things to a reader: one is
   * "this is broken", the other is "nobody has needed this lately". Both offer a delete, so a
   * screen that said "stale" for both would be inviting the same press for opposite facts.
   */
  it('tells a procedure nobody has confirmed apart from one that is failing now', () => {
    const quiet = memoryReviewReason({
      ...item({ lastVerified: '2026-01-05T09:00:00.000Z' }),
      reason: 'unverified',
      recentOkCount: 3,
      recentGradedCount: 3
    });
    expect(quiet).toContain('It may still be right and merely unused');
    expect(quiet).not.toContain('failing now');

    const broken = memoryReviewReason({
      ...item(),
      reason: 'failing',
      recentOkCount: 1,
      recentGradedCount: 5
    });
    expect(broken).toContain('failing now rather than idle');
    expect(broken).not.toContain('merely unused');
  });

  /* The third case the store returns, which a two-way branch would have to round to one side. */
  it('says both things about a procedure that is failing and unconfirmed at once', () => {
    const both = memoryReviewReason({
      ...item({ lastVerified: '2026-01-05T09:00:00.000Z' }),
      reason: 'both',
      recentOkCount: 0,
      recentGradedCount: 4
    });
    expect(both).toContain('It worked 0 of the last 4 times');
    expect(both).toContain('Nobody has confirmed this since');
    expect(
      render({
        procedures: [{ ...item(), reason: 'both', recentOkCount: 0, recentGradedCount: 4 }],
        disputed: [],
        proposals: []
      })
    ).toContain('Failing, and unconfirmed');
  });

  it('offers all three answers on a procedure, with the delete unarmed', () => {
    const markup = render(queue());
    expect(markup).toContain('Still right');
    expect(markup).toContain('Stop believing it');
    expect(markup).toContain('aria-label="Delete what was remembered"');
    /* Armed by the first press, so the destructive word is not in the markup until it is. */
    expect(markup).not.toContain('Delete for good');
  });

  it('draws nothing at all when the box is sure of everything it holds', () => {
    expect(render({ procedures: [], disputed: [], proposals: [] })).toBe('');
  });
});

/*
 * The other half of the queue. `verifyMemoryProcedure` updates a row only where `kind='procedure'`,
 * so "still right" on a disputed fact would answer 404 every single time it was pressed - a new
 * lying control inside the screen built to remove them.
 */
describe('two things the box holds that disagree', () => {
  const pair = (): MemoryReview => ({
    procedures: [],
    proposals: [],
    disputed: [
      {
        ...item({
          id: 'fact-a',
          kind: 'fact',
          status: 'disputed',
          trust: 'stated',
          origin: 'stated',
          excerpt: 'Invoices go to accounts@example.test'
        }),
        contradicts: ['fact-b']
      },
      /*
       * The other side is a model's wording of something the owner said, which is the pair that
       * matters: `resolveMemoryContradiction` lets a stated fact retire a derived one outright, so
       * which of these two the owner keeps is decided by knowing which is which - and both used to
       * be drawn as "The box worked this out".
       */
      {
        ...item({
          id: 'fact-b',
          kind: 'fact',
          status: 'disputed',
          trust: 'derived',
          origin: 'proposed',
          excerpt: 'Invoices go to billing@example.test'
        }),
        contradicts: ['fact-a']
      }
    ]
  });

  it('shows the other side in its own words rather than as an identifier', () => {
    const markup = render(pair());
    expect(markup).toContain('It disagrees with: Invoices go to billing@example.test');
    expect(markup).not.toContain('fact-b');
  });

  it('says so when the other side is no longer in the list, rather than printing a bare id', () => {
    const lines = memoryReviewContradictions(
      { ...item({ status: 'disputed' }), contradicts: ['gone'] },
      []
    );
    expect(lines).toEqual([
      'The other side of this is not in the list; it may already have been retracted or deleted.'
    ]);
  });

  it('does not offer to confirm a disputed line, because the statement behind it only moves procedures', () => {
    const markup = render(pair());
    expect(markup).not.toContain('Still right');
    expect(markup).toContain('Stop believing it');
  });

  /*
   * The defect this whole vertical exists for, on the screen where the owner has to choose between
   * two lines. Both of these are facts about the same thing; one is the owner's own sentence and
   * one is a model's wording of what it read them say, and the store calls the second `derived` -
   * the same word it uses for a command the harness ran. A headline drawn off `trust` said "The box
   * worked this out" over the model's rule and nothing at all about where the words came from.
   */
  it('names which side of the computer wrote each of two lines that disagree', () => {
    const markup = render(pair());
    expect(markup).toContain('<strong>You said this</strong>');
    expect(markup).toContain('<strong>A model wrote this</strong>');
    // Both directions on one render: neither headline is applied to both rows.
    expect(markup.match(/<strong>A model wrote this<\/strong>/gu)).toHaveLength(1);
    expect(markup.match(/<strong>You said this<\/strong>/gu)).toHaveLength(1);
    expect(markup).not.toContain('The box worked this out');
  });
});

/*
 * Where a row came from, which `trust` cannot say and every screen used to read off it anyway.
 *
 * Two of the three things that write to `mem.item` set `trust: 'derived'`, and they are the two
 * furthest apart in the subsystem: a sentence a model wrote about the owner, pinned in front of
 * every later task in the workspace, and a note that the harness ran a command and watched it fail.
 * A two-way branch had to round one of them onto the other.
 */
describe('which side of the computer put a row there', () => {
  it('gives three answers where trust gives two, and does not use the same word twice', () => {
    expect(memoryOriginLabel('stated')).toBe('You said this');
    expect(memoryOriginLabel('proposed')).toBe('A model wrote this');
    expect(memoryOriginLabel('watched')).toBe('The box watched this');
    expect(new Set(['stated', 'proposed', 'watched'] as const).size).toBe(3);
  });

  /*
   * The long form, which is the claim rather than the heading. The middle one has to say that the
   * words are a machine's and that the row is acted on anyway, because a rule that is obeyed and
   * was never the owner's wording is the exact thing they are being asked to check.
   */
  it('says of a promoted proposal that the words are a model’s and that it is acted on', () => {
    const model = memoryOriginFact('proposed');
    expect(model).toContain('A model wrote this sentence out of your own messages');
    expect(model).toContain('acted on');
    // And neither of the other two claims a model wrote it, which is what makes the first one mean
    // something: a fact line saying it everywhere would pass a test that only looked here. The
    // harness line does say the word, in the sentence that denies it - "no model was asked for it"
    // is the whole point of telling these two apart.
    expect(memoryOriginFact('stated')).not.toContain('model');
    expect(memoryOriginFact('watched')).not.toContain('A model wrote this');
    expect(memoryOriginFact('watched')).toContain('no model was asked for it');
    expect(memoryOriginFact('stated')).toContain('You said this');
    expect(memoryOriginFact('watched')).toContain('as it watched the work');
  });

  /* And the row shows it, rather than the helper being right where nothing calls it. */
  it('puts it on the row a decision is made on', () => {
    expect(render(queue())).toContain('The box wrote this down as it watched the work');
    expect(
      render({
        procedures: [
          {
            ...item({ trust: 'stated', origin: 'stated' }),
            reason: 'unverified',
            recentOkCount: 0,
            recentGradedCount: 0
          }
        ],
        disputed: [],
        proposals: []
      })
    ).toContain('You said this; the box did not work it out.');
  });
});

/*
 * Item #59. The route serves the opening 200 characters of a stored row and marks the cut with an
 * ellipsis; there is no route that serves the rest. So the row expands onto everything the box
 * actually sent - and says that it is an opening - rather than offering a control that unfolds onto
 * the same clipped line while implying there is more behind it.
 */
describe('reading the whole of what was written down', () => {
  it('folds the stored text and what it rests on into the row, shut until it is asked for', () => {
    const markup = render(queue());
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('The box wrote this down as it watched the work');
    expect(markup).toContain('Never confirmed since.');
    expect(markup).toContain('Used 7 times: it worked 2 and failed 5.');
  });

  it('admits that a clipped excerpt is an opening, and claims nothing when it is whole', () => {
    expect(memoryExcerptIsClipped('Deploy from the box…')).toBe(true);
    expect(memoryExcerptIsClipped('Deploy from the box.')).toBe(false);
    const clipped = render({
      procedures: [
        {
          ...item({ excerpt: 'A long procedure…' }),
          reason: 'unverified',
          recentOkCount: 0,
          recentGradedCount: 0
        }
      ],
      disputed: [],
      proposals: []
    });
    expect(clipped).toContain('This is the opening of what is stored.');
    expect(render(queue())).not.toContain('This is the opening of what is stored.');
  });

  it('offers the conversation that wrote the row only when there is somewhere to send it', () => {
    expect(render(queue())).not.toContain('Open the conversation this came from');
    const withOpener = renderToStaticMarkup(
      <MemoryReviewLists queue={queue()} onAct={() => undefined} onOpenTask={() => undefined} />
    );
    expect(withOpener).toContain('Open the conversation this came from');
  });

  /* A pinned row and one with an expiry each carry a fact a decision would otherwise miss. */
  it('names an expiry and a pin, and leaves both out of a row that has neither', () => {
    const plain = memoryReviewFacts(item());
    expect(plain.join(' ')).not.toContain('Pinned');
    expect(plain.join(' ')).not.toContain('Was only meant to hold');
    const marked = memoryReviewFacts(item({ pin: true, validTo: '2026-03-01T00:00:00.000Z' }));
    expect(marked.join(' ')).toContain('Pinned');
    expect(marked.join(' ')).toContain('Was only meant to hold until');
  });
});

/*
 * The verbs, over a stubbed `fetch` — the seam where this program's worst defect class lives. What
 * is asserted is that the press reaches the box at the right method and URL, and that the row on
 * screen changes only because of what came back.
 */
interface Call {
  url: string;
  method: string | undefined;
}

const calls: Call[] = [];

const answer = (body: unknown, init: ResponseInit = {}): void => {
  vi.stubGlobal('fetch', (input: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), method: requestInit?.method });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers }
      })
    );
  });
};

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('what each answer does to the box and to the screen', () => {
  it('confirms a procedure at the route that moves the clock the queue reads, and drops the row', async () => {
    answer({ verified: true });
    const after = await applyMemoryReviewVerb('ws-1', 'item-1', 'verify', queue());
    expect(calls).toEqual([
      { url: '/v1/workspaces/ws-1/memory-items/item-1/verify', method: 'POST' }
    ]);
    expect(after.procedures).toEqual([]);
  });

  /*
   * Retracting is not the DELETE next door and must not become it: the row and its audit trail
   * survive, which is the whole reason this screen is a queue rather than a delete button.
   */
  it('retracts at its own sub-path rather than deleting the row', async () => {
    answer({ retracted: true });
    const after = await applyMemoryReviewVerb('ws-1', 'item-1', 'retract', queue());
    expect(calls).toEqual([
      { url: '/v1/workspaces/ws-1/memory-items/item-1/retract', method: 'POST' }
    ]);
    expect(after.procedures).toEqual([]);
  });

  it('deletes for good at the route that removes every trace', async () => {
    answer({ deleted: true });
    await applyMemoryReviewVerb('ws-1', 'item-1', 'forget', queue());
    expect(calls).toEqual([{ url: '/v1/workspaces/ws-1/memory-items/item-1', method: 'DELETE' }]);
  });

  /*
   * The routes answer 404 rather than `{verified:false}` on purpose, and what it means is that the
   * screen is holding a row the box does not have. Keeping it up would be the interface insisting
   * on something it has just been told is not there.
   */
  it('takes the row away when the box says there is no such row', async () => {
    answer(
      { error: { code: 'memory_item_not_found', message: 'Memory item not found' } },
      {
        status: 404
      }
    );
    const after = await applyMemoryReviewVerb('ws-1', 'item-1', 'verify', queue());
    expect(after.procedures).toEqual([]);
  });

  /* The opposite mistake: a row that vanishes on a blip is the same lie from the other side. */
  it('leaves the row alone when the box could not answer at all', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(applyMemoryReviewVerb('ws-1', 'item-1', 'verify', queue())).rejects.toThrow();
  });

  it('takes only the row it was asked about, out of whichever list it was in', () => {
    const both = withoutMemoryItem(
      {
        procedures: queue().procedures,
        disputed: [{ ...item({ id: 'other' }), contradicts: [] }],
        proposals: []
      },
      'other'
    );
    expect(both.procedures).toHaveLength(1);
    expect(both.disputed).toEqual([]);
  });
});

/*
 * A self-hosted owner's whole support channel is the request id the API writes onto the error body
 * and onto its own log line. It is absent, not empty, when the answer came from something that is
 * not this API, and "quote" with a blank after it is worse than saying nothing.
 */
describe('the sentence shown when something fails', () => {
  it('hands over the id the box logged, when the box is what answered', async () => {
    answer(
      { error: { code: 'internal_error', message: 'Something went wrong', requestId: 'req-77' } },
      { status: 500 }
    );
    const failure = await applyMemoryReviewVerb('ws-1', 'item-1', 'verify', queue()).catch(
      (cause: unknown) => memoryReviewFailure(cause, 'That did not work.')
    );
    expect(failure).toBe("Something went wrong Quote req-77 to find it in the box's own log.");
  });

  it('says the box is unreachable, and quotes nothing, when nothing answered', () => {
    expect(
      memoryReviewFailure(new TypeError('Failed to fetch'), 'That did not work.')
    ).not.toContain('Quote');
  });
});

/*
 * Rules a model has put forward, which are the one thing on this screen that is not a memory.
 *
 * The wording is the whole test. A list of imperative sentences under a heading about memory reads
 * as a list of things the computer has decided, and it has decided none of it: each row is one
 * sighting behind the same two-sightings-a-day-apart gate every observed candidate faces, and until
 * it clears that gate nothing recalls it, injects it or obeys it. A screen that let an owner think
 * otherwise would be asking them to refuse something they believe is already in force.
 */
describe('a rule that has been put forward and is not remembered', () => {
  const proposal = (over: Partial<MemoryProposal> = {}): MemoryProposal => ({
    id: 'a'.repeat(32),
    sentence: 'Work autonomously to the end without asking for confirmation.',
    sightings: 1,
    firstSeen: '2026-08-02T10:00:00.000Z',
    lastSeen: '2026-08-02T10:00:00.000Z',
    needsAnotherDay: true,
    ...over
  });

  it('says it is not remembered, and what it still has to do', () => {
    const markup = render({ procedures: [], disputed: [], proposals: [proposal()] });
    expect(markup).toContain('Put forward, not remembered');
    expect(markup).toContain('Work autonomously to the end without asking for confirmation.');
    expect(markup).toContain('None of them is remembered yet');
    expect(markup).toContain('Refusing one is permanent');
  });

  it('tells the truth about a rule that has met the bar and one that has not', () => {
    expect(memoryProposalStanding(proposal())).toContain('has to come up again on a later day');
    expect(
      memoryProposalStanding(
        proposal({ sightings: 2, lastSeen: '2026-08-04T10:00:00.000Z', needsAnotherDay: false })
      )
    ).toContain('has met the bar');
    // Two sightings inside one day is not two, and the row has to say so rather than counting.
    expect(
      memoryProposalStanding(
        proposal({ sightings: 2, lastSeen: '2026-08-02T18:00:00.000Z', needsAnotherDay: true })
      )
    ).toContain('has to come up again on a later day');
  });

  /*
   * A refuse button with nothing behind it is worse than no list at all, because the owner would
   * believe they had refused something. Both directions on one queue.
   */
  it('draws the refusal only when there is something behind it', () => {
    const queue = { procedures: [], disputed: [], proposals: [proposal()] };
    expect(render(queue)).not.toContain('remember this');
    expect(
      renderToStaticMarkup(
        <MemoryReviewLists queue={queue} onAct={() => undefined} onDismiss={() => undefined} />
      )
    ).toContain('remember this');
  });

  /*
   * One press for the whole group, because the group is the unit the owner judges in.
   *
   * These arrive three a night against a standing twenty and the proposer stops outright when the
   * list is full, so a screenful nobody can clear in one gesture is a mechanism that switches
   * itself off. Three directions, because two of them are ways of getting this wrong: a control
   * with nothing behind it, and a "refuse all 1" beside a row that already carries its own button.
   */
  it('offers one press for a group, none for a group of one, and none with nothing behind it', () => {
    const two = {
      procedures: [],
      disputed: [],
      proposals: [proposal(), proposal({ id: 'b'.repeat(32), sentence: 'Never push to main.' })]
    };
    const draw = (
      value: MemoryReview,
      onDismissAll?: (proposals: readonly MemoryProposal[]) => void
    ): string =>
      renderToStaticMarkup(
        <MemoryReviewLists
          queue={value}
          onAct={() => undefined}
          onDismiss={() => undefined}
          {...(onDismissAll ? { onDismissAll } : {})}
        />
      );
    expect(draw(two)).not.toContain('Refuse all');
    expect(
      draw({ procedures: [], disputed: [], proposals: [proposal()] }, () => undefined)
    ).not.toContain('Refuse all');
    const grouped = draw(two, () => undefined);
    expect(grouped).toContain('Refuse all 2');
    /* Armed by the first press, exactly as the delete inside a row is: the irreversible sentence
       is not in the markup until somebody has asked for it. */
    expect(grouped).not.toContain('Yes, refuse all');
  });

  /*
   * What leaves for the box, and what the screen does with the answer. A refusal is permanent, so
   * both halves are asserted: one row sends the handle the route has always taken, a group sends
   * the list, and neither sends "all of them" - a proposal written while the owner was reading is
   * one nobody has looked at, and a durable refusal must never take one of those.
   */
  it('sends one handle for one row and the named list for a group, and drops exactly those rows', async () => {
    const before: MemoryReview = {
      procedures: queue().procedures,
      disputed: [],
      proposals: [
        proposal(),
        proposal({ id: 'b'.repeat(32), sentence: 'Never push to main.' }),
        proposal({ id: 'c'.repeat(32), sentence: 'Ask before spending money.' })
      ]
    };
    answer({ dismissed: 1 });
    const afterOne = await refuseMemoryProposals('ws-1', [before.proposals[0]!], before);
    expect(calls).toEqual([
      { url: '/v1/workspaces/ws-1/memory-proposals/dismiss', method: 'POST' }
    ]);
    expect(afterOne.proposals.map((row) => row.id)).toEqual(['b'.repeat(32), 'c'.repeat(32)]);

    calls.length = 0;
    answer({ dismissed: 2 });
    const afterGroup = await refuseMemoryProposals(
      'ws-1',
      [before.proposals[0]!, before.proposals[1]!],
      before
    );
    expect(calls).toHaveLength(1);
    // The row it was not shown is still there, and the two lists it was not about are untouched.
    expect(afterGroup.proposals.map((row) => row.id)).toEqual(['c'.repeat(32)]);
    expect(afterGroup.procedures).toHaveLength(1);
  });

  /*
   * The two failure directions the single refusal already keeps, kept for the group as well. A 404
   * means every handle named was already gone, so the rows go; anything else is the box not having
   * heard, and rows that vanish on a blip would leave the owner believing they had refused
   * something they had not.
   */
  it('drops a group the box says it does not have, and keeps one it never heard about', async () => {
    const before: MemoryReview = {
      procedures: [],
      disputed: [],
      proposals: [proposal(), proposal({ id: 'b'.repeat(32), sentence: 'Never push to main.' })]
    };
    answer(
      { error: { code: 'memory_proposal_not_found', message: 'Proposal not found' } },
      { status: 404 }
    );
    expect((await refuseMemoryProposals('ws-1', before.proposals, before)).proposals).toEqual([]);

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(refuseMemoryProposals('ws-1', before.proposals, before)).rejects.toThrow();

    // And a refusal of nothing asks the box for nothing at all.
    calls.length = 0;
    expect(await refuseMemoryProposals('ws-1', [], before)).toBe(before);
    expect(calls).toEqual([]);
  });

  it('takes only the proposal it was asked about, and leaves the other lists alone', () => {
    const before = {
      procedures: queue().procedures,
      disputed: [],
      proposals: [proposal(), proposal({ id: 'b'.repeat(32), sentence: 'Never push to main.' })]
    };
    const after = withoutMemoryProposal(before, 'b'.repeat(32));
    expect(after.proposals.map((row) => row.id)).toEqual(['a'.repeat(32)]);
    expect(after.procedures).toHaveLength(1);
    // And a proposal is not an item: the item verb must not reach into this list by id.
    expect(withoutMemoryItem(before, 'a'.repeat(32)).proposals).toHaveLength(2);
    expect(memoryReviewIsEmpty({ procedures: [], disputed: [], proposals: [proposal()] })).toBe(
      false
    );
    expect(memoryReviewIsEmpty({ procedures: [], disputed: [], proposals: [] })).toBe(true);
    // The group helper the single one is built out of, named one handle at a time in both.
    expect(withoutMemoryProposals(before, ['a'.repeat(32), 'b'.repeat(32)]).proposals).toEqual([]);
    expect(withoutMemoryProposals(before, []).proposals).toHaveLength(2);
  });
});
