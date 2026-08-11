import type { TaskEvent } from './types.js';

/**
 * How much of a conversation this device holds, and whether the box holds more before it.
 *
 * The client used to open every transcript at sequence zero, so opening an hour-long conversation
 * meant the box decrypting and streaming every frame it had ever written and this device folding
 * all of it in before the newest message could appear. Measured on a 2,000-event conversation:
 * 43.2 ms of server-side decrypt and re-serialise and 1.09 MB over the wire, against 3.7 ms and
 * 110 kB for the newest page alone; on this side, 24.6 ms of parse-and-build against 5.2 ms.
 *
 * The window is what makes that safe to do: it remembers where the loaded stretch begins so the
 * reader can walk backwards from it, one page at a time, to the start of the conversation.
 */
export interface EventWindow {
  /** The oldest sequence held here. Zero when nothing is loaded. */
  oldest: number;
  /** Whether anything older than `oldest` may still be on the box. */
  more: boolean;
  /** A page is in flight, so the button that asked for it must not ask twice. */
  loading: boolean;
}

/** One page of transcript. The route caps at 1,000; this is what a screen can plausibly need. */
export const EVENT_PAGE_SIZE = 200;

export const EMPTY_EVENT_WINDOW: EventWindow = { oldest: 0, more: false, loading: false };

/**
 * The window after a page lands, whether it is the newest page of a fresh open or an older one
 * folded in ahead of it.
 *
 * The route answers with a bare array and no "has more" flag, so two facts stand in for one. A
 * page shorter than the one asked for is the whole of what was left - which is what the route
 * documents - and a page that reaches sequence 1 has reached the first thing that ever happened in
 * this conversation. A full page that happens to end exactly at the beginning costs one empty
 * request when the reader asks again, and then the offer goes away for good.
 *
 * `previous` supplies the floor for a page that came back empty, so a request that raced a task
 * switch or found nothing cannot rewind the window to zero and re-fetch what is already here.
 */
export const windowAfterPage = (
  page: TaskEvent[],
  previous: EventWindow = EMPTY_EVENT_WINDOW,
  limit: number = EVENT_PAGE_SIZE
): EventWindow => {
  const oldest = page[0]?.sequence ?? previous.oldest;
  return { oldest, more: page.length >= limit && oldest > 1, loading: false };
};
