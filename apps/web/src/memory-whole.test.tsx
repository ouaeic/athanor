/**
 * Reading the whole of a remembered row, from the client's side of it.
 *
 * The review queue showed two hundred characters and said on screen that two hundred characters
 * was all it had. Honest, and not the promise: the rest was on the owner's own disk behind no
 * route. Now there is one, and what this suite holds is the three things a screen can get wrong
 * about it — asking at the wrong moment, asking twice, and saying the wrong sentence while the
 * answer is on its way.
 *
 * `renderToStaticMarkup` runs no effects and there is no DOM here, so the expander cannot be
 * clicked. That is why the decision is a value: `shouldReadWhole` is the whole of the handler, and
 * it can be asked every question a mouse could.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiFailure } from './api-failure.js';
import { memoryItemBody } from './memory-api.js';
import { MemoryReviewLists, shouldReadWhole, type MemoryReviewVerb } from './MemoryReview.js';
import type { MemoryReview as MemoryReviewQueue, MemoryReviewItem } from './api.js';

const item = (patch: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'procedure',
  status: 'active',
  excerpt: 'Goal: reconcile the quarterly numbers against the bank export and write down the…',
  observedAt: '2026-02-01T09:00:00.000Z',
  taskId: null,
  trust: 'derived',
  validFrom: '2026-02-01T09:00:00.000Z',
  validTo: null,
  lastVerified: null,
  okCount: 1,
  failCount: 3,
  useCount: 4,
  pin: false,
  ...patch
});

const queue = (patch: Partial<MemoryReviewItem> = {}): MemoryReviewQueue => ({
  procedures: [{ ...item(patch), reason: 'failing', recentOkCount: 1, recentGradedCount: 4 }],
  disputed: []
});

/** The three verbs are asserted in `MemoryReview.test.tsx`; nothing here presses one. */
const noAct: (verb: MemoryReviewVerb, row: MemoryReviewItem) => void = () => undefined;

describe('when opening a row should ask the box for the rest of it', () => {
  const base = { open: true, excerpt: 'an opening…', alreadyRead: false, hasReader: true };

  it('asks on the open of a row the server said it had cut', () => {
    expect(shouldReadWhole(base)).toBe(true);
  });

  /* `<details>` fires toggle on the way shut as loudly as on the way open, and a fetch there would
     put a request on the wire for a row the owner has just finished with. */
  it('asks nothing on the way shut', () => {
    expect(shouldReadWhole({ ...base, open: false })).toBe(false);
  });

  /* Read once and kept. Reopening a row is not new information about it. */
  it('asks nothing for a row it is already holding', () => {
    expect(shouldReadWhole({ ...base, alreadyRead: true })).toBe(false);
  });

  /* No ellipsis means the server had nothing left over, so the excerpt already is the whole of it
     and a round trip would be paid to be told exactly what is on screen. */
  it('asks nothing where the server did not cut anything', () => {
    expect(shouldReadWhole({ ...base, excerpt: 'the whole of a short one' })).toBe(false);
  });

  it('asks nothing where no reader was handed in', () => {
    expect(shouldReadWhole({ ...base, hasReader: false })).toBe(false);
  });
});

describe('what the row says about the part it is not showing', () => {
  /*
   * The sentence the screen carried for as long as there was no route, kept for exactly the case
   * that is still true of: a list rendered by something with no way to ask. Drawing an expander
   * there would be a control that lies, which is the defect this whole programme is about.
   */
  it('keeps the old apology when nothing was handed in to read with', () => {
    const markup = renderToStaticMarkup(<MemoryReviewLists queue={queue()} onAct={noAct} />);
    expect(markup).toContain('no screen reaches it yet');
  });

  it('promises the rest instead, once there is something to read it with', () => {
    const markup = renderToStaticMarkup(
      <MemoryReviewLists queue={queue()} onAct={noAct} onReadWhole={() => Promise.resolve('x')} />
    );
    expect(markup).toContain('the rest is being read from your box');
    expect(markup).not.toContain('no screen reaches it yet');
  });

  /* A row the server did not cut says nothing at all about a remainder, either way round. */
  it('says nothing about a remainder on a row that has none', () => {
    const whole = queue({ excerpt: 'Goal: reconcile the numbers. Outcome: ok.' });
    const markup = renderToStaticMarkup(
      <MemoryReviewLists queue={whole} onAct={noAct} onReadWhole={() => Promise.resolve('x')} />
    );
    expect(markup).not.toContain('the rest is being read from your box');
    expect(markup).not.toContain('no screen reaches it yet');
  });
});

describe('the route only this screen calls', () => {
  it('asks for one row, with both identifiers escaped', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push([input, init]);
        return new Response(
          JSON.stringify({ id: 'a b', title: null, body: 'the whole of it', readable: true }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
    const answer = await memoryItemBody('work space', 'a b');
    expect(answer.body).toBe('the whole of it');
    expect(calls[0]![0]).toBe('/v1/workspaces/work%20space/memory-items/a%20b');
    // The session travels on the cookie, as everything else in this client does.
    expect(calls[0]![1]?.credentials).toBe('include');
    vi.unstubAllGlobals();
  });

  /*
   * The failure shape matters as much as the answer: `memoryReviewFailure` pulls the request id off
   * an `ApiFailure` and quotes it, which on a self-hosted box is the whole of the support channel.
   * A bare `Error` here would silently drop that.
   */
  it('raises an ApiFailure carrying the code and the request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'memory_item_not_found',
                message: 'Memory item not found',
                requestId: 'req-7'
              }
            }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const failure = await memoryItemBody('w', 'i').catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure as ApiFailure).toMatchObject({
      code: 'memory_item_not_found',
      status: 404,
      requestId: 'req-7'
    });
    vi.unstubAllGlobals();
  });
});
