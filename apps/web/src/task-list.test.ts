import { describe, expect, it } from 'vitest';
import {
  arrivalLine,
  conversationMatches,
  groupConversations,
  removeTask,
  renameCommit,
  upsertTask
} from './task-list.js';
import type { ConversationBucket, ConversationEntry } from './task-list.js';
import type { Task } from './types.js';

const task = (id: string, createdAt: string, title = id, updatedAt = createdAt): Task =>
  ({
    id,
    workspaceId: 'workspace-1',
    userId: 'user-1',
    title,
    status: 'completed',
    modelId: 'openai/gpt-5',
    scheduleId: null,
    createdAt,
    updatedAt
  }) as unknown as Task;

/** What a bucket used to hold, so the assertions about ordering read the way they always did. */
const ids = (bucket: ConversationBucket | undefined): string[] =>
  (bucket?.entries ?? []).map((entry: ConversationEntry) =>
    entry.kind === 'conversation' ? entry.task.id : `schedule:${entry.group.scheduleId}`
  );

describe('groupConversations', () => {
  const now = Date.parse('2026-07-31T15:00:00.000Z');

  it('orders by last activity, not by when the conversation was created', () => {
    const old = task('old', '2026-07-01T09:00:00.000Z', 'old', '2026-07-31T14:55:00.000Z');
    const fresh = task('fresh', '2026-07-31T08:00:00.000Z');
    const buckets = groupConversations([fresh, old], now);
    expect(buckets[0]?.label).toBe('Today');
    expect(ids(buckets[0])).toEqual(['old', 'fresh']);
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
    expect(buckets.map(ids)).toEqual([['today'], ['yesterday'], ['ancient']]);
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
    expect(ids(buckets[0])).toEqual(['kept-later', 'kept']);
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
    expect(ids(buckets[0])).toEqual(['today']);
  });
});

/*
 * A schedule mints a fresh conversation every time it fires. A watcher on a fifteen-minute interval
 * is ninety-six of them a day, in the same recency order as the owner's own work, which is what put
 * their work off the bottom of the list by mid-morning.
 */
describe('runs of one schedule', () => {
  const now = Date.parse('2026-07-31T15:00:00.000Z');
  const run = (id: string, at: string, scheduleId = 'rent-watcher', status = 'completed'): Task =>
    ({ ...task(id, at, 'Rent watcher'), scheduleId, status }) as Task;

  it('collapses every run into one entry, filed and named by the newest', () => {
    const buckets = groupConversations(
      [
        run('run-1', '2026-07-31T09:00:00.000Z'),
        run('run-2', '2026-07-30T09:00:00.000Z'),
        run('run-3', '2026-05-30T09:00:00.000Z'),
        task('mine', '2026-07-31T10:00:00.000Z')
      ],
      now
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Today']);
    expect(ids(buckets[0])).toEqual(['mine', 'schedule:rent-watcher']);
    const entry = buckets[0]?.entries[1];
    expect(entry?.kind).toBe('schedule');
    if (entry?.kind !== 'schedule') throw new Error('expected the collapsed schedule');
    expect(entry.group.runs.map((item) => item.id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(entry.group.latest.id).toBe('run-1');
    expect(entry.group.title).toBe('Rent watcher');
  });

  it('keeps two different schedules apart', () => {
    const buckets = groupConversations(
      [
        run('a-1', '2026-07-31T09:00:00.000Z', 'watcher-a'),
        run('a-2', '2026-07-31T08:00:00.000Z', 'watcher-a'),
        run('b-1', '2026-07-31T07:00:00.000Z', 'watcher-b'),
        run('b-2', '2026-07-31T06:00:00.000Z', 'watcher-b')
      ],
      now
    );
    expect(ids(buckets[0])).toEqual(['schedule:watcher-a', 'schedule:watcher-b']);
  });

  /* A group of one is a control that hides nothing, so a schedule that has fired once is a row. */
  it('leaves a schedule that has only run once as an ordinary conversation', () => {
    const buckets = groupConversations([run('only', '2026-07-31T09:00:00.000Z')], now);
    expect(ids(buckets[0])).toEqual(['only']);
  });

  /* Pinning is the owner singling out one conversation, and it still wins over the collapse. */
  it('holds a pinned run above the dates and leaves it out of the count', () => {
    const buckets = groupConversations(
      [
        { ...run('run-1', '2026-07-31T09:00:00.000Z'), pinned: true },
        run('run-2', '2026-07-31T08:00:00.000Z'),
        run('run-3', '2026-07-31T07:00:00.000Z')
      ],
      now
    );
    expect(buckets.map((bucket) => bucket.label)).toEqual(['Pinned', 'Today']);
    expect(ids(buckets[0])).toEqual(['run-1']);
    const entry = buckets[1]?.entries[0];
    if (entry?.kind !== 'schedule') throw new Error('expected the collapsed schedule');
    expect(entry.group.runs.map((item) => item.id)).toEqual(['run-2', 'run-3']);
  });

  it('does not count a filed run, and collapses nothing once only one is left', () => {
    const buckets = groupConversations(
      [
        run('run-1', '2026-07-31T09:00:00.000Z'),
        { ...run('run-2', '2026-07-31T08:00:00.000Z'), archivedAt: '2026-07-31T09:30:00.000Z' }
      ],
      now
    );
    expect(ids(buckets[0])).toEqual(['run-1']);
  });
});

/*
 * The owner arrives to a machine that has been working all night. The screen that greets them should
 * carry the evidence of that rather than ask them what to do — but only when there is evidence.
 */
describe('what happened while the owner was away', () => {
  const now = Date.parse('2026-07-31T09:00:00.000Z');
  const run = (id: string, at: string, status = 'completed'): Task =>
    ({ ...task(id, at, 'Rent watcher'), scheduleId: 'rent-watcher', status }) as Task;

  it('says nothing when nothing ran', () => {
    expect(arrivalLine([], now)).toBeUndefined();
    expect(arrivalLine([task('mine', '2026-07-31T09:00:00.000Z')], now)).toBeUndefined();
  });

  it('counts only the runs since the owner last touched their own work', () => {
    expect(
      arrivalLine(
        [
          task('mine', '2026-07-30T22:00:00.000Z'),
          run('before', '2026-07-30T21:00:00.000Z'),
          run('after-1', '2026-07-31T02:00:00.000Z'),
          run('after-2', '2026-07-31T03:00:00.000Z')
        ],
        now
      )
    ).toBe('2 scheduled runs finished while you were away.');
  });

  it('reads as one run rather than as 1 runs', () => {
    expect(arrivalLine([run('one', '2026-07-31T02:00:00.000Z')], now)).toBe(
      '1 scheduled run finished while you were away.'
    );
  });

  /*
   * With no conversation of the owner's own to measure from - every one archived, or a box that has
   * only ever run schedules - "since they last looked" reduced to the beginning of time, so a
   * schedule that has been running for a year reported the whole year as having happened overnight.
   */
  it('reaches back a day and no further when there is nothing of the owner’s to measure from', () => {
    expect(
      arrivalLine(
        [
          run('a-year-ago', '2025-08-01T02:00:00.000Z'),
          run('last-week', '2026-07-24T02:00:00.000Z'),
          run('overnight', '2026-07-31T02:00:00.000Z')
        ],
        now
      )
    ).toBe('1 scheduled run finished while you were away.');
  });

  /* A run holding an approval is the owner's move, so it is the thing worth saying. */
  it('leads with the runs waiting on the owner, ahead of the ones that failed', () => {
    expect(
      arrivalLine(
        [
          run('waiting', '2026-07-31T02:00:00.000Z', 'awaiting_user'),
          run('broken', '2026-07-31T03:00:00.000Z', 'failed'),
          run('fine', '2026-07-31T04:00:00.000Z')
        ],
        now
      )
    ).toBe('1 scheduled run needs you.');
  });

  it('says a run failed when none is waiting on the owner', () => {
    expect(
      arrivalLine(
        [
          run('broken', '2026-07-31T03:00:00.000Z', 'failed'),
          run('fine', '2026-07-31T04:00:00.000Z')
        ],
        now
      )
    ).toBe('1 scheduled run failed while you were away.');
  });

  /*
   * The list holds only the newest few runs of any one schedule, so the number of them on this
   * device is the number that fitted rather than the number that ran. Ninety failed runs behind
   * five good ones read as "5 scheduled runs finished while you were away", on the one screen this
   * product exists for, saying the opposite of what the night had been.
   */
  it('does not report the runs it happens to be holding as the runs that happened', () => {
    const held = [
      run('newest-1', '2026-07-31T04:00:00.000Z'),
      run('newest-2', '2026-07-31T03:00:00.000Z'),
      run('newest-3', '2026-07-31T02:00:00.000Z')
    ];
    expect(arrivalLine(held, now, { 'rent-watcher': 95 })).toBe(
      'Scheduled work ran while you were away.'
    );
    // The count agreeing with what is held is the whole list, so the number is the truth again.
    expect(arrivalLine(held, now, { 'rent-watcher': 3 })).toBe(
      '3 scheduled runs finished while you were away.'
    );
  });

  /*
   * The outcome the owner has to act on survives the cap, because one run they can see holding an
   * approval is enough to know that something is waiting. It is the arithmetic that is dropped,
   * not the news.
   */
  it('still leads with what needs the owner when the runs behind the cap are unknown', () => {
    const held = [
      run('waiting', '2026-07-31T02:00:00.000Z', 'awaiting_user'),
      run('fine', '2026-07-31T04:00:00.000Z')
    ];
    expect(arrivalLine(held, now, { 'rent-watcher': 40 })).toBe('Scheduled work needs you.');
    expect(
      arrivalLine(
        [
          run('broken', '2026-07-31T03:00:00.000Z', 'failed'),
          run('fine', '2026-07-31T04:00:00.000Z')
        ],
        now,
        { 'rent-watcher': 40 }
      )
    ).toBe('Scheduled work failed while you were away.');
  });

  /* A pinned run is the owner's, and the count the box sends leaves it out, so this side must too. */
  it('does not read a pinned run as evidence that the whole history is here', () => {
    expect(
      arrivalLine(
        [
          { ...run('pinned', '2026-07-31T04:00:00.000Z'), pinned: true },
          run('newest', '2026-07-31T03:00:00.000Z')
        ],
        now,
        { 'rent-watcher': 2 }
      )
    ).toBe('Scheduled work ran while you were away.');
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
