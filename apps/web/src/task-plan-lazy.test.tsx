/**
 * That the plan editor still arrives after it was moved behind `lazy`.
 *
 * The move was made for the eager bundle - `TaskPlanPanel` is rendered on the one group that is
 * live, so every conversation the owner is only reading paid for a component it never showed. What
 * the move introduces is a failure mode with no symptom: the boundary's fallback is `null`, so a
 * dynamic import that never resolves - a renamed file, a chunk the service worker did not precache
 * - takes the plan editor off the screen and puts nothing in its place. Silence is exactly what a
 * turn without a plan looks like, which is why this is asserted rather than assumed.
 *
 * `prerender` is used instead of `renderToStaticMarkup` because it is the only renderer here that
 * waits for a Suspense boundary to settle; the synchronous one is what the first assertion checks.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { Timeline } from './Timeline.js';
import type { Task, TaskEvent } from './types.js';

const task = {
  id: '00000000-0000-4000-8000-000000000010',
  workspaceId: '00000000-0000-4000-8000-000000000011',
  title: 'Quarterly report',
  status: 'running',
  modelId: 'openrouter/z-ai/glm-5.2',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 5,
  actualComputeCredits: 1,
  spentUsd: 0.12,
  queuedMessageCount: 0,
  securityMode: 'balanced',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:10:00.000Z'
} as Task;

const event = (sequence: number, kind: TaskEvent['kind'], summary: string, payload?: unknown) =>
  ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: task.id,
    sequence,
    kind,
    summary,
    ...(payload === undefined ? {} : { payload }),
    createdAt: '2026-08-01T09:05:00.000Z'
  }) as TaskEvent;

/** A turn with tool traffic, which is what opens the work log the panel sits above. */
const liveTurn = [
  event(1, 'user_message', 'Summarise the file', { markdown: 'Summarise the file' }),
  event(2, 'tool_started', 'Running file_read', { tool: 'file_read', toolCallId: 'c1' }),
  event(3, 'tool_result', 'file_read finished', { toolCallId: 'c1', result: { ok: true } })
];

const transcript = (
  <Timeline task={task} tasks={[task]} events={liveTurn} modelName={(id: string) => id} />
);

describe('the plan editor behind a dynamic import', () => {
  it('holds the space empty while the chunk is still in flight', () => {
    const markup = renderToStaticMarkup(transcript);
    expect(markup).not.toContain('Live task plan');
    // The rest of the turn does not wait on it: the fallback is scoped to the panel alone.
    expect(markup).toContain('<ol class="ledger"');
  });

  it('puts the live plan on screen once the chunk has resolved', async () => {
    const { prelude } = await prerender(transcript);
    const markup = await new Response(prelude).text();
    expect(markup).toContain('aria-label="Live task plan"');
    expect(markup).toContain('Live plan');
    expect(markup).toContain('<ol class="ledger"');
  });
});
