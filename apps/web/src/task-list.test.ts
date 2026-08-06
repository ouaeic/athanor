import { describe, expect, it } from 'vitest';
import {
  conversationMatches,
  groupConversations,
  removeTask,
  renameCommit,
  upsertTask
} from './task-list.js';
import type { Task } from './types.js';

const task = (id: string, createdAt: string, title = id, updatedAt = createdAt): Task =>
  ({
    id,
    workspaceId: 'workspace-1',
    userId: 'user-1',
    title,
    status: 'completed',
    modelId: 'openai/gpt-5',
    createdAt,
    updatedAt
  }) as unknown as Task;

describe('groupConversations', () => {
  const now = Date.parse('2026-07-31T15:00:00.000Z');

  it('orders by last activity, not by when the conversation was created', () => {
    const old = task('old', '2026-07-01T09:00:00.000Z', 'old', '2026-07-31T14:55:00.000Z');
    const fresh = task('fresh', '2026-07-31T08:00:00.000Z');
    const buckets = groupConversations([fresh, old], now);
    expect(buckets[0]?.label).toBe('Today');
    expect(buckets[0]?.tasks.map((item) => item.id)).toEqual(['old', 'fresh']);
  });

  it('buckets by how recently each was touched and drops empty buckets', () => {
    const buckets = groupConversations(
      [
        task('today', '2026-07-31T09:00:00.000Z'),
        task('yesterday', '2026-07-30T09:00:00.000Z'),
        task('ancient', '2026-01-02T09:00:00.000Z')
      ],
      now
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(buckets.map((bucket) => bucket.tasks.map((item) => item.id))).toEqual([
      ['today'],
      ['yesterday'],
      ['ancient']
    ]);
  });

  it('does not mutate the list it was given', () => {
    const tasks = [task('a', '2026-07-01T09:00:00.000Z'), task('b', '2026-07-31T09:00:00.000Z')];
    groupConversations(tasks, now);
    expect(tasks.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('returns nothing at all for an empty list', () => {
    expect(groupConversations([], now)).toEqual([]);
  });

  /*
   * The server has always ordered pinned conversations first and the contract says they sit above
   * the dates. The client sorted by recency alone, so the one control that promises to hold a
   * conversation where it can be found moved nothing on the screen that shows the list.
   */
  it('holds pinned conversations above the dates, newest first among themselves', () => {
    const buckets = groupConversations(
      [
        task('today', '2026-07-31T09:00:00.000Z'),
        { ...task('kept', '2026-01-02T09:00:00.000Z'), pinned: true },
        { ...task('kept-later', '2026-02-02T09:00:00.000Z'), pinned: true }
      ],
      now
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Pinned', 'Today']);
    expect(buckets[0]?.tasks.map((item) => item.id)).toEqual(['kept-later', 'kept']);
  });

  it('takes a filed conversation out of the list without touching the rest', () => {
    const buckets = groupConversations(
      [
        task('today', '2026-07-31T09:00:00.000Z'),
        { ...task('filed', '2026-07-31T10:00:00.000Z'), archivedAt: '2026-07-31T11:00:00.000Z' }
      ],
      now
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Today']);
    expect(buckets[0]?.tasks.map((item) => item.id)).toEqual(['today']);
  });
});

describe('upsertTask', () => {
  it('replaces a task that is already in the list', () => {
    const tasks = [task('b', '2026-02-01T00:00:00.000Z'), task('a', '2026-01-01T00:00:00.000Z')];
    const next = upsertTask(tasks, task('a', '2026-01-01T00:00:00.000Z', 'renamed'));
    expect(next.map((item) => item.title)).toEqual(['b', 'renamed']);
    expect(next).toHaveLength(2);
  });

  it('inserts a conversation older than everything the bootstrap returned', () => {
    const tasks = [task('b', '2026-02-01T00:00:00.000Z'), task('a', '2026-01-01T00:00:00.000Z')];
    const next = upsertTask(tasks, task('ancient', '2025-03-01T00:00:00.000Z'));
    expect(next.map((item) => item.id)).toEqual(['b', 'a', 'ancient']);
  });

  it('inserts by creation date so the newest stays first', () => {
    const tasks = [task('b', '2026-02-01T00:00:00.000Z'), task('a', '2026-01-01T00:00:00.000Z')];
    expect(upsertTask(tasks, task('c', '2026-03-01T00:00:00.000Z')).map((item) => item.id)).toEqual(
      ['c', 'b', 'a']
    );
    expect(
      upsertTask(tasks, task('middle', '2026-01-15T00:00:00.000Z')).map((item) => item.id)
    ).toEqual(['b', 'middle', 'a']);
  });

  it('does not mutate the list it was given', () => {
    const tasks = [task('a', '2026-01-01T00:00:00.000Z')];
    upsertTask(tasks, task('b', '2026-02-01T00:00:00.000Z'));
    expect(tasks).toHaveLength(1);
  });
});

describe('removeTask', () => {
  it('drops only the requested conversation', () => {
    const tasks = [task('a', '2026-01-01T00:00:00.000Z'), task('b', '2026-02-01T00:00:00.000Z')];
    expect(removeTask(tasks, 'a').map((item) => item.id)).toEqual(['b']);
  });
});

describe('renameCommit', () => {
  it('saves a trimmed new title', () => {
    expect(renameCommit('  Quarterly report  ', 'Old')).toBe('Quarterly report');
  });

  it('saves nothing when the edit is empty or unchanged', () => {
    expect(renameCommit('   ', 'Old')).toBeUndefined();
    expect(renameCommit('Old', 'Old')).toBeUndefined();
  });

  it('treats clicking away the same as pressing Enter', () => {
    // The two call sites share this function precisely so they cannot drift apart again.
    const draft = 'Renamed while focus moved';
    expect(renameCommit(draft, 'Old')).toBe(renameCommit(draft, 'Old'));
  });
});

describe('what the search field lists', () => {
  const here = task('here', '2026-07-01T00:00:00.000Z', 'Quarterly board deck');
  const match = (taskId: string, title: string, excerpt = 'a line that matched') => ({
    taskId,
    workspaceId: 'workspace-2',
    title,
    excerpt,
    updatedAt: '2026-07-02T00:00:00.000Z'
  });

  it('waits for a second character before searching at all', () => {
    expect(
      conversationMatches({ query: 'q', tasks: [here], matches: [], searching: true })
    ).toEqual([]);
    expect(
      conversationMatches({ query: '  ', tasks: [here], matches: [], searching: false })
    ).toEqual([]);
  });

  /*
   * The two lists are never intersected. A conversation on another computer, or older than the page
   * the bootstrap carried, is not in `tasks` at all — intersecting dropped exactly the one the
   * search had just found.
   */
  it('keeps a result this device has never loaded', () => {
    const results = conversationMatches({
      query: 'invoice',
      tasks: [here],
      matches: [match('elsewhere', 'Invoices from March')],
      searching: false
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      taskId: 'elsewhere',
      title: 'Invoices from March',
      task: undefined
    });
  });

  it('prefers the name this device knows, which may have been renamed since it was indexed', () => {
    const results = conversationMatches({
      query: 'deck',
      tasks: [here],
      matches: [match('here', 'Old indexed name')],
      searching: false
    });
    expect(results[0]?.title).toBe('Quarterly board deck');
    expect(results[0]?.task).toBe(here);
  });

  /* Typing has to produce something on the same keystroke; the box answers a fifth of a second
     later and replaces this. */
  it('stands in with local titles while the box is still answering', () => {
    const results = conversationMatches({
      query: 'board',
      tasks: [here, task('other', '2026-07-01T00:00:00.000Z', 'Unrelated')],
      matches: [],
      searching: true
    });
    expect(results.map((result) => result.taskId)).toEqual(['here']);
    expect(results[0]?.excerpt).toBe('');
  });

  it('matches a title regardless of case', () => {
    const results = conversationMatches({
      query: 'QUARTERLY',
      tasks: [here],
      matches: [],
      searching: true
    });
    expect(results).toHaveLength(1);
  });

  it('shows nothing rather than every conversation once the box has answered with nothing', () => {
    expect(
      conversationMatches({ query: 'board', tasks: [here], matches: [], searching: false })
    ).toEqual([]);
  });
});
