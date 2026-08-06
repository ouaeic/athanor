import { describe, expect, it } from 'vitest';
import type { Task } from './types.js';
import {
  isLiveTask,
  isPausedTask,
  isTerminalTask,
  pauseAction,
  terminalTaskStatuses
} from './task-status.js';

const task = (status: string): Task => ({ id: 'task-1', status }) as Task;

/** Every status the contract declares, so a new one cannot be added without a decision here. */
const allStatuses = [
  'draft',
  'queued',
  'planning',
  'running',
  'awaiting_user',
  'awaiting_resource',
  'paused',
  'completed',
  'failed',
  'cancelled'
];

describe('what a conversation status means', () => {
  it('treats exactly the three finished statuses as finished', () => {
    expect(allStatuses.filter((status) => isTerminalTask(task(status)))).toEqual([
      'completed',
      'failed',
      'cancelled'
    ]);
    expect([...terminalTaskStatuses].sort()).toEqual(['cancelled', 'completed', 'failed']);
  });

  /*
   * `awaiting_resource` used to be missing from this set while the header a few pixels away offered
   * Resume for it: a conversation waiting for the computer could not be stopped with Escape, showed
   * no Stop button, and told the composer it was idle.
   */
  it('counts a conversation waiting on the computer as one the agent still has', () => {
    expect(isLiveTask(task('awaiting_resource'))).toBe(true);
    expect(isLiveTask(task('paused'))).toBe(true);
    expect(isLiveTask(task('running'))).toBe(true);
    expect(isLiveTask(task('completed'))).toBe(false);
  });

  it('leaves a draft out: nothing is running to stop or resume', () => {
    expect(isLiveTask(task('draft'))).toBe(false);
    expect(isTerminalTask(task('draft'))).toBe(false);
  });

  it('has no opinion about a conversation that is not there', () => {
    expect(isLiveTask(undefined)).toBe(false);
    expect(isTerminalTask(undefined)).toBe(false);
    expect(isPausedTask(undefined)).toBe(false);
    expect(pauseAction(undefined)).toBe('pause');
  });

  it('never calls a status both finished and live', () => {
    for (const status of allStatuses)
      expect(isTerminalTask(task(status)) && isLiveTask(task(status))).toBe(false);
  });

  it('points the one pause control the way the conversation needs', () => {
    expect(pauseAction(task('running'))).toBe('pause');
    expect(pauseAction(task('paused'))).toBe('resume');
    expect(pauseAction(task('awaiting_resource'))).toBe('resume');
  });

  it('only offers resume for a conversation the agent still has', () => {
    for (const status of allStatuses)
      if (isPausedTask(task(status))) expect(isLiveTask(task(status))).toBe(true);
  });
});
