/**
 * Opening a conversation at its newest page, and walking backwards from there.
 *
 * The decision is in the pure module; the offer to walk back is a control in the transcript, and
 * `renderToStaticMarkup` is how the rest of this client checks markup - no DOM, no effects, so what
 * comes back is what a reader is offered on the first paint.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EMPTY_EVENT_WINDOW, EVENT_PAGE_SIZE, windowAfterPage } from './event-window.js';
import { Timeline } from './Timeline.js';
import type { Task, TaskEvent } from './types.js';

const task = {
  id: '00000000-0000-4000-8000-000000000010',
  workspaceId: '00000000-0000-4000-8000-000000000011',
  title: 'Quarterly report',
  status: 'completed',
  modelId: 'openrouter/z-ai/glm-5.2',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 5,
  actualComputeCredits: 1,
  spentUsd: 0,
  queuedMessageCount: 0,
  securityMode: 'balanced',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:10:00.000Z'
} as Task;

const message = (sequence: number): TaskEvent =>
  ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: task.id,
    sequence,
    kind: sequence % 2 === 0 ? 'assistant_message' : 'user_message',
    summary: `line ${sequence}`,
    createdAt: '2026-08-01T09:05:00.000Z'
  }) as TaskEvent;

const page = (from: number, count: number): TaskEvent[] =>
  Array.from({ length: count }, (_, index) => message(from + index));

describe('the window a transcript is opened at', () => {
  it('offers more when a full page came back and it did not reach the beginning', () => {
    const window = windowAfterPage(page(801, EVENT_PAGE_SIZE));
    expect(window).toEqual({ oldest: 801, more: true, loading: false });
  });

  it('is the whole conversation when the page is shorter than the one asked for', () => {
    const window = windowAfterPage(page(1, 12));
    expect(window).toEqual({ oldest: 1, more: false, loading: false });
  });

  /*
   * The route answers with a bare array and no "has more", so a full page that happens to end on
   * the first event of the conversation would otherwise offer a request that can only come back
   * empty. Reaching sequence 1 is the other proof that there is nothing before this.
   */
  it('stops offering more once the page reaches the first event', () => {
    expect(windowAfterPage(page(1, EVENT_PAGE_SIZE)).more).toBe(false);
  });

  it('keeps the floor it already had when a page comes back empty', () => {
    const opened = windowAfterPage(page(801, EVENT_PAGE_SIZE));
    const extended = windowAfterPage([], { ...opened, loading: true });
    expect(extended).toEqual({ oldest: 801, more: false, loading: false });
  });

  it('walks backwards a page at a time', () => {
    const opened = windowAfterPage(page(401, EVENT_PAGE_SIZE));
    const earlier = windowAfterPage(page(201, EVENT_PAGE_SIZE), opened);
    expect(earlier).toEqual({ oldest: 201, more: true, loading: false });
  });

  it('holds nothing before anything is loaded', () => {
    expect(EMPTY_EVENT_WINDOW).toEqual({ oldest: 0, more: false, loading: false });
  });
});

describe('the offer to read earlier in the conversation', () => {
  const render = (props: Partial<Parameters<typeof Timeline>[0]>): string =>
    renderToStaticMarkup(<Timeline task={task} tasks={[task]} events={page(1, 6)} {...props} />);

  it('is absent when this device holds the whole conversation', () => {
    expect(render({})).not.toContain('Earlier in this conversation');
  });

  /*
   * The case the button could not answer before: everything loaded is already on screen, so there
   * is nothing left to reveal, and the rest of the conversation is on the box.
   */
  it('is offered when the box holds more than was sent', () => {
    expect(render({ earlierAvailable: true })).toContain('Earlier in this conversation');
  });

  it('cannot be pressed twice while a page is in flight', () => {
    const markup = render({ earlierAvailable: true, earlierLoading: true });
    expect(markup).toContain('disabled');
    expect(markup).toContain('Earlier in this conversation');
  });

  /** Nodes held here but not mounted are still counted, because revealing them costs no request. */
  it('counts what is already held before it asks the box for anything', () => {
    const markup = renderToStaticMarkup(
      <Timeline task={task} tasks={[task]} events={page(1, 400)} earlierAvailable />
    );
    expect(markup).toMatch(/Earlier in this conversation · \d+ more/);
  });
});

/** The cost line describes the conversation, so a windowed transcript must not shrink it. */
describe('what a windowed transcript still says about the whole conversation', () => {
  const costEvent = {
    id: '00000000-0000-4000-8000-000000000999',
    taskId: task.id,
    sequence: 999,
    kind: 'cost',
    summary: 'Cost',
    payload: { costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 2 } },
    createdAt: '2026-08-01T09:06:00.000Z'
  } as TaskEvent;

  it('reports the task total when the pages holding the earlier cost events are not loaded', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        task={{ ...task, spentUsd: 1.24 }}
        tasks={[task]}
        events={[...page(1, 4), costEvent]}
      />
    );
    expect(markup).toContain('$1.24');
  });

  it('reports the window while it is ahead of the settled total mid-turn', () => {
    const markup = renderToStaticMarkup(
      <Timeline
        task={{ ...task, spentUsd: 0 }}
        tasks={[task]}
        events={[...page(1, 4), costEvent]}
      />
    );
    expect(markup).toContain('$0.01');
  });
});
