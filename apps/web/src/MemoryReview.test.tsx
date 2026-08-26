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
  memoryReviewContradictions,
  memoryReviewFacts,
  memoryReviewFailure,
  MemoryReviewLists,
  memoryReviewReason,
  withoutMemoryItem
} from './MemoryReview.js';
import type { MemoryReview, MemoryReviewItem } from './api.js';

const item = (over: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  id: 'item-1',
  kind: 'procedure',
  status: 'active',
  excerpt: 'Deploy by running `athanor update` on the box, never from the laptop.',
  observedAt: '2026-02-01T09:00:00.000Z',
  taskId: 'task-9',
  trust: 'derived',
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
        disputed: []
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
    expect(render({ procedures: [], disputed: [] })).toBe('');
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
    disputed: [
      {
        ...item({
          id: 'fact-a',
          kind: 'fact',
          status: 'disputed',
          trust: 'stated',
          excerpt: 'Invoices go to accounts@example.test'
        }),
        contradicts: ['fact-b']
      },
      {
        ...item({
          id: 'fact-b',
          kind: 'fact',
          status: 'disputed',
          trust: 'stated',
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
    expect(markup).toContain('The box worked this out for itself.');
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
      disputed: []
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
        disputed: [{ ...item({ id: 'other' }), contradicts: [] }]
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
