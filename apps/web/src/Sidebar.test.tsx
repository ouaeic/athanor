/**
 * The conversation list, rendered.
 *
 * Only the collapsed shape is exercised here: the runs of a schedule are behind a control the owner
 * opens, and this renders without a DOM, so what is asserted is exactly what greets someone who has
 * been away — the schedule's name, how its last run ended, and how many runs there have been.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from './Sidebar.js';
import type { Task, User, Workspace } from './types.js';

const user: User = { id: 'user-1', username: 'owner', displayName: 'Owner' };

const workspace = {
  id: 'workspace-1',
  name: 'My computer',
  status: 'running',
  storageBytes: 0,
  storageLimitBytes: 1,
  region: 'self-hosted'
} as unknown as Workspace;

const run = (id: string, at: string): Task =>
  ({
    id,
    workspaceId: workspace.id,
    title: 'Rent watcher',
    status: 'completed',
    scheduleId: 'rent-watcher',
    spentUsd: 0,
    pinned: false,
    archivedAt: null,
    createdAt: at,
    updatedAt: at
  }) as unknown as Task;

const render = (tasks: Task[], scheduleRunCounts?: Record<string, number>): string =>
  renderToStaticMarkup(
    <Sidebar
      user={user}
      fire="banked"
      workspaces={[workspace]}
      tasks={tasks}
      scheduleRunCounts={scheduleRunCounts}
      schedules={[]}
      selectedWorkspaceId={workspace.id}
      selectedTaskId={undefined}
      onTask={() => undefined}
      onNewTask={() => undefined}
      onComputerSettings={() => undefined}
      onSettings={() => undefined}
      onSchedules={() => undefined}
      noticeCount={0}
      onNotices={() => undefined}
      onSearch={async () => []}
    />
  );

describe('the folded line a schedule costs', () => {
  const runs = [
    run('run-1', '2026-07-31T04:00:00.000Z'),
    run('run-2', '2026-07-31T03:00:00.000Z'),
    run('run-3', '2026-07-31T02:00:00.000Z')
  ];

  /*
   * The list holds at most a handful of any one schedule's runs, so that a watcher firing every
   * fifteen minutes cannot bury the owner's own work. The count beside the fold was read off that
   * handful, so a watcher that had fired four hundred times said three.
   */
  it('says how many runs the schedule has, not how many of them the list is holding', () => {
    const markup = render(runs, { 'rent-watcher': 412 });
    expect(markup).toContain('412 runs');
    expect(markup).toContain('412 scheduled runs');
    expect(markup).not.toContain('3 runs');
  });

  /* A box that has not been updated sends no counts, and what it is holding is all it can claim. */
  it('falls back to the runs in hand when the box did not send a count', () => {
    expect(render(runs)).toContain('3 runs');
  });
});
