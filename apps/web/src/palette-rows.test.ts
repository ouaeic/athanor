import { describe, expect, it } from 'vitest';
import { MAX_PALETTE_ROWS, paletteRows, score } from './palette-rows.js';
import type { Command } from './CommandPalette.js';
import type { Task } from './types.js';

const command = (id: string, label: string, group = 'Actions'): Command => ({
  id,
  label,
  group,
  run: () => undefined
});

const task = (id: string, title: string, status = 'completed'): Task =>
  ({ id, workspaceId: 'workspace-1', title, status }) as Task;

const rows = (patch: Partial<Parameters<typeof paletteRows>[0]> = {}) =>
  paletteRows({ query: '', commands: [], tasks: [], matches: [], ...patch });

describe('ranking a palette match', () => {
  it('prefers a match at the start, then at a word start, then anywhere', () => {
    expect(score('Terminal', 'term')).toBe(0);
    expect(score('Open Terminal', 'term')).toBe(1);
    expect(score('Determine the cost', 'term')).toBe(2);
    expect(score('Nothing here', 'term')).toBe(-1);
  });

  it('does not care how either side was cased', () => {
    expect(score('Open Settings', 'settings')).toBe(1);
  });

  it('treats a dash or a slash as a word start, the way a title uses them', () => {
    expect(score('re-open the tab', 'open')).toBe(1);
    expect(score('files/reports', 'reports')).toBe(1);
  });
});

describe('what the palette lists', () => {
  it('lists every command when nothing has been typed', () => {
    const listed = rows({ commands: [command('a', 'New conversation'), command('b', 'Settings')] });
    expect(listed.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('puts the command that starts with what was typed above one that merely contains it', () => {
    const listed = rows({
      query: 'term',
      commands: [command('a', 'Determine the cost'), command('b', 'Terminal')]
    });
    expect(listed.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('draws each group once, however the commands were assembled', () => {
    // The palette listed "Actions" above the computer surfaces and again below them: the commands
    // are built in two passes with the surfaces made in between, and the list draws a heading
    // whenever the group changes from one row to the next. Two identical headings around one group
    // of four, in the one list that exists to make everything findable.
    const listed = rows({
      commands: [
        command('new', 'New conversation', 'Actions'),
        command('files', 'Open Files', 'Computer'),
        command('terminal', 'Open Terminal', 'Computer'),
        command('settings', 'Open Settings', 'Actions')
      ]
    });
    const groups = listed.map((row) => (row.kind === 'command' ? row.command.group : ''));
    expect(groups).toEqual(['Actions', 'Actions', 'Computer', 'Computer']);
    // One run per group, which is what the heading rule requires.
    expect(new Set(groups).size).toBe(2);
  });

  it('floats the group that answers the query, keeping that group together', () => {
    const listed = rows({
      query: 'termin',
      commands: [
        command('new', 'New conversation', 'Actions'),
        command('settings', 'Open Settings', 'Actions'),
        command('terminal', 'Open Terminal', 'Computer'),
        command('files', 'Open Files', 'Computer')
      ]
    });
    // Only Computer matches, so only Computer is listed - and it is still one run.
    expect(listed.map((row) => row.id)).toEqual(['terminal']);
  });

  it('drops a command nothing about the query matches', () => {
    expect(rows({ query: 'zzz', commands: [command('a', 'Terminal')] })).toEqual([]);
  });

  it('answers from the conversations on this device before the box replies', () => {
    const listed = rows({ query: 'board', tasks: [task('t1', 'Quarterly board deck')] });
    expect(listed[0]).toMatchObject({ kind: 'conversation', taskId: 't1', hint: 'completed' });
  });

  /* The box's results arrive a moment later and overlap with what is already listed. */
  it('lists a conversation once, keeping the name this device knows it by', () => {
    const listed = rows({
      query: 'board',
      tasks: [task('t1', 'Quarterly board deck')],
      matches: [
        {
          taskId: 't1',
          workspaceId: 'workspace-1',
          title: 'Old indexed name',
          excerpt: 'a line',
          updatedAt: '2026-07-01T00:00:00.000Z'
        }
      ]
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ label: 'Quarterly board deck' });
  });

  it('keeps a conversation the box found that this device does not have', () => {
    const listed = rows({
      query: 'invoice',
      matches: [
        {
          taskId: 'elsewhere',
          workspaceId: 'workspace-2',
          title: 'Invoices',
          excerpt: 'the line that matched',
          updatedAt: '2026-07-01T00:00:00.000Z'
        }
      ]
    });
    expect(listed[0]).toMatchObject({
      kind: 'conversation',
      taskId: 'elsewhere',
      workspaceId: 'workspace-2',
      hint: 'the line that matched'
    });
  });

  it('leaves out a conversation with no name to show', () => {
    expect(rows({ tasks: [task('t1', '   ')] })).toEqual([]);
  });

  it('puts the commands first: they are what the palette is for', () => {
    const listed = rows({
      query: 'stop',
      commands: [command('stop', 'Stop the agent')],
      tasks: [task('t1', 'Stop the presses')]
    });
    expect(listed.map((row) => row.kind)).toEqual(['command', 'conversation']);
  });

  it('caps the list rather than drawing a wall', () => {
    const many = Array.from({ length: MAX_PALETTE_ROWS + 10 }, (_, index) =>
      task(`t${index}`, `Conversation ${index}`)
    );
    expect(rows({ tasks: many })).toHaveLength(MAX_PALETTE_ROWS);
    expect(rows({ tasks: many, limit: 3 })).toHaveLength(3);
  });
});
