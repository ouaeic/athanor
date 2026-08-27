/**
 * The record of what the agent asked, and what a returning owner actually reads on it.
 *
 * Two halves, because the defect has two halves. A list that asks the box for the wrong thing is a
 * history of everything wearing the word "lapsed"; a list that asks correctly and then renders a
 * row nobody can act on is the same absence with more pixels. So: what leaves this file, asserted
 * against a stubbed `fetch`; and what the row says, asserted against the markup.
 *
 * The two are joined at the end by one test that feeds the route's real answer shape — a bare array
 * whose rows carry their own cursor — through the loader and into the list, which is the seam where
 * a client half quietly disagrees with a server half that is already tested where it lives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DECISIONS_PAGE,
  DecisionRow,
  DecisionsList,
  decisionOutcome,
  decisionStatuses,
  loadDecisions,
  nextDecisionCursor
} from './DecisionsLog.js';
import type { Approval } from './types.js';

const urls: string[] = [];

/** Answers every request with `body`, and records the address it was asked for. */
const answer = (body: unknown): void => {
  vi.stubGlobal('fetch', (input: string | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    );
  });
};

afterEach(() => {
  urls.length = 0;
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-08-26T09:00:00.000Z');

const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-0000000000aa',
  action: 'Clear the cache directory so the build starts clean',
  sideEffect: 'workspace_write',
  status: 'expired',
  createdAt: '2026-08-25T22:14:00.000Z',
  expiresAt: '2026-08-26T04:14:00.000Z',
  cursor: 'MjAyNi0wOC0yNQ==',
  preview: {
    tool: 'shell',
    preview: 'I need to remove the stale cache before rebuilding.',
    arguments: { executable: 'rm', args: ['-rf', 'build/cache'], cwd: 'workspace' }
  },
  ...patch
});

const render = (patch: Partial<Approval> = {}, status: Approval['status'] = 'expired'): string =>
  renderToStaticMarkup(
    <DecisionRow
      approval={approval(patch)}
      status={status ?? 'expired'}
      now={NOW}
      onOpenTask={() => undefined}
    />
  );

describe('what the decisions log asks the box for', () => {
  it('names the status it is filtering on, and asks for a page rather than the table', async () => {
    answer([]);
    await loadDecisions('expired');
    expect(urls[0]).toContain('status=expired');
    expect(urls[0]).toBe(`/v1/approvals?status=expired&limit=${DECISIONS_PAGE}`);
  });

  /* The route answers a bare array with no `nextCursor`, so the position is a row and not a count. */
  it('asks for the next page from the last row of the previous one', async () => {
    answer([]);
    await loadDecisions('approved', 'MjAyNi0wOC0yNQ==');
    expect(urls[0]).toBe(
      `/v1/approvals?status=approved&limit=${DECISIONS_PAGE}&cursor=MjAyNi0wOC0yNQ%3D%3D`
    );
  });

  it('offers no next page after a short one, and none at all from a box with no cursors', () => {
    const full = Array.from({ length: DECISIONS_PAGE }, (_unused, index) =>
      approval({ id: `row-${index}`, cursor: `cursor-${index}` })
    );
    expect(nextDecisionCursor(full)).toBe(`cursor-${DECISIONS_PAGE - 1}`);
    expect(nextDecisionCursor(full.slice(0, 3))).toBeUndefined();
    // A box older than the cursor field returns a full page of rows without one. "Show older" then
    // has nothing to ask for, and a button that re-fetched the same page for ever is worse than no
    // button at all.
    const uncursored = full.map(({ cursor: _cursor, ...row }) => row);
    expect(nextDecisionCursor(uncursored)).toBeUndefined();
  });
});

describe('what one decision says once it is on screen', () => {
  /*
   * The whole reason this screen exists. The worker treats an unanswered request as expired, skips
   * the action and carries the turn on, so the owner's symptom is work that quietly did less than
   * it was asked to - and until this list the only trace was one line in one transcript.
   */
  it('says a lapse was a skip rather than a refusal, and what it skipped', () => {
    const markup = render();
    expect(markup).toContain('lapsed with no answer');
    expect(markup).toContain('carried on without it');
    // The harness's own record of the call, which is the only account of the thing that did not
    // happen. Not the model's sentence about it, which is directly above and attributed.
    expect(markup).toContain('rm -rf build/cache');
    expect(markup).toContain('Runs a command on your computer');
  });

  /*
   * Nothing lapses on its own: the sweep that writes `expired` runs with the rest of maintenance,
   * so a row can sit in the waiting list with its deadline already behind it. A countdown that read
   * "expires in 0 min" there would be the interface promising an answer is still possible.
   */
  it('tells the truth about a waiting request whose deadline has already passed', () => {
    const markup = render({ status: 'pending' }, 'pending');
    expect(markup).toContain('Expired');
    expect(markup).toContain('it was not run');
    expect(
      decisionOutcome(approval({ expiresAt: '2026-08-26T12:00:00.000Z' }), 'pending', NOW)
    ).toContain('Expires in 3 hours');
  });

  it('says which way a decision that was made went', () => {
    expect(render({ status: 'approved' }, 'approved')).toContain('You approved it, and it ran.');
    expect(render({ status: 'denied' }, 'denied')).toContain('Refused, so it was not run.');
  });

  /*
   * A repeat origin across conversations is the residual attack the whole taint separation exists
   * to make visible, and it is only visible if every row that has one says so. The origin is
   * recorded on the approval itself, which is the only answer available for a request raised in a
   * conversation nobody is looking at - which is every row on this screen.
   */
  it('says when the turn that asked had been reading somebody else’s text', () => {
    const markup = render({ origin: 'news.example.com' });
    expect(markup).toContain('news.example.com');
    expect(markup).toContain('Whoever wrote that could be the one asking for this');
    // The ordinary case is no taint at all, and it is not an unknown origin. A row that said
    // something reassuring here would teach the sentence's absence to mean danger.
    expect(render({ origin: null })).not.toContain('could be the one asking');
  });

  /* The route substitutes this string for a preview it cannot decrypt; it is not the agent's word. */
  it('does not quote the server’s own placeholder as though the model had written it', () => {
    const markup = render({ preview: '[unavailable]' });
    expect(markup).not.toContain('[unavailable]');
    expect(markup).toContain('cannot decrypt what was asked');
  });

  it('offers the way back to the conversation the request was raised in', () => {
    expect(render()).toContain('Open the conversation');
    expect(
      renderToStaticMarkup(<DecisionRow approval={approval()} status="expired" now={NOW} />)
    ).not.toContain('Open the conversation');
  });
});

describe('the four lists', () => {
  /*
   * An empty list has to be able to say which empty it is. A screen that draws nothing for `expired`
   * cannot be told apart from one that was never wired up, which is the defect this file removes.
   */
  it('says what an empty list means, in each list’s own words', () => {
    // The count is the assertion the empty case has to answer: a filter list that lost its rows
    // would leave every expectation below unreached and this test green in no time at all.
    expect(decisionStatuses.length).toBeGreaterThan(0);
    for (const status of decisionStatuses) {
      const markup = renderToStaticMarkup(<DecisionsList rows={[]} status={status.id} />);
      expect(markup).toContain(status.empty);
    }
  });

  /*
   * The seam itself: the route's real answer shape - a bare array, every row carrying its own
   * cursor, `status` and `createdAt` on it - taken through the loader this screen actually calls
   * and rendered by the list this screen actually draws. A method that dropped the filter, or a row
   * shape this client disagreed with, is invisible from either side alone.
   */
  it('carries the route’s own answer all the way onto the screen', async () => {
    answer([
      {
        id: '00000000-0000-4000-8000-000000000009',
        taskId: '00000000-0000-4000-8000-0000000000aa',
        action: 'Send the summary to the mailing list',
        origin: 'mail.example.com',
        sideEffect: 'external_consequential',
        status: 'expired',
        expiresAt: '2026-08-26T04:14:00.000Z',
        createdAt: '2026-08-25T22:14:00.000Z',
        cursor: 'MjAyNi0wOC0yNQ==',
        preview: {
          tool: 'connector_action',
          preview: 'Sending the digest.',
          arguments: { action: 'mail:send', to: ['list@example.com'], subject: 'Weekly digest' }
        }
      }
    ]);
    const rows = await loadDecisions('expired');
    expect(urls[0]).toContain('status=expired');
    const markup = renderToStaticMarkup(
      <DecisionsList rows={rows} status="expired" now={NOW} onOpenTask={() => undefined} />
    );
    expect(markup).toContain('reaches outside your computer, and may not be undoable');
    expect(markup).toContain('list@example.com');
    expect(markup).toContain('Weekly digest');
    expect(markup).toContain('lapsed with no answer');
    expect(markup).toContain('mail.example.com');
    expect(nextDecisionCursor(rows)).toBeUndefined();
  });
});
