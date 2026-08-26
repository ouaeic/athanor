import { describe, expect, it } from 'vitest';
import { followedPane } from './inspector-follow.js';
import type { Task, TaskEvent } from './types.js';

const event = (sequence: number, kind: TaskEvent['kind'], tool?: string): TaskEvent =>
  ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    taskId: '00000000-0000-4000-8000-000000000099',
    sequence,
    kind,
    summary: tool ? `Running ${tool}` : kind,
    ...(tool === undefined ? {} : { payload: { tool, toolCallId: `call-${sequence}` } }),
    createdAt: '2026-08-10T00:00:00.000Z'
  }) as TaskEvent;

const task = (status: string): Task => ({ id: 't', status }) as unknown as Task;

describe('the pane that is showing the work', () => {
  it('names the Computer while the agent is on the screen', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'desktop_action')
      ])
    ).toBe('computer');
  });

  // The Terminal pane opens `GET .../terminal`, which spawns a *fresh* pty with its own pipes; the
  // agent's shell runs through `POST .../exec` (agent.ts). Following a shell call to the Terminal
  // therefore showed the owner their own idle `$` while the build they were told about ran
  // somewhere they could not see - and started a second shell on the box to do it, renewing a
  // capability token for a pane they had never opened.
  it('does not send the owner to a terminal that is not the one the agent is using', () => {
    expect(
      followedPane(task('running'), [event(1, 'user_message'), event(2, 'tool_started', 'shell')])
    ).not.toBe('terminal');
  });

  // `process` is how the agent inspects what it left running in the background, and the Running
  // pane is the one surface that lists those sessions.
  it('names the Running pane while the agent is inspecting a background session', () => {
    expect(
      followedPane(task('running'), [event(1, 'user_message'), event(2, 'tool_started', 'process')])
    ).toBe('preview');
  });

  // The whole of a foreground command's output is written into the transcript the owner is already
  // reading, so there is no second surface for this to point at.
  it('says nothing at all for a foreground command, whose output is already on screen', () => {
    expect(
      followedPane(task('running'), [event(1, 'user_message'), event(2, 'tool_started', 'shell')])
    ).toBeUndefined();
  });

  it('treats the agent browser as the computer, because it is the same screen', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'browser_action')
      ])
    ).toBe('computer');
  });

  it('follows the newest surface when the turn has used two', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'process'),
        event(3, 'tool_started', 'desktop_observe')
      ])
    ).toBe('computer');
  });

  // The gaps between tool calls are the model thinking. Requiring a call to still be in flight made
  // the pane bounce back to the file list every few seconds for the length of a turn.
  it('holds the pane through the thinking between tool calls', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'process'),
        event(3, 'tool_result', 'process'),
        event(4, 'assistant_delta')
      ])
    ).toBe('preview');
  });

  it('says nothing for work that leaves no pane to watch', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'file_read'),
        event(3, 'tool_started', 'web_search')
      ])
    ).toBeUndefined();
  });

  it('says nothing once the conversation has finished', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'draft'])
      expect(
        followedPane(task(status), [
          event(1, 'user_message'),
          event(2, 'tool_started', 'desktop_action')
        ])
      ).toBeUndefined();
  });

  it('keeps following while the conversation waits on the owner or the box', () => {
    for (const status of ['queued', 'planning', 'awaiting_user', 'awaiting_resource', 'paused'])
      expect(
        followedPane(task(status), [event(1, 'user_message'), event(2, 'tool_started', 'process')])
      ).toBe('preview');
  });

  // A conversation resumed an hour after a shell command would otherwise snap to the Terminal the
  // instant it went live, on the strength of a command that finished before lunch.
  it('looks no further back than the message the owner last sent', () => {
    expect(
      followedPane(task('running'), [
        event(1, 'user_message'),
        event(2, 'tool_started', 'process'),
        event(3, 'completed'),
        event(4, 'user_message')
      ])
    ).toBeUndefined();
  });

  it('says nothing with no conversation open and nothing to read', () => {
    expect(followedPane(undefined, [])).toBeUndefined();
    expect(followedPane(task('running'), [])).toBeUndefined();
  });
});
