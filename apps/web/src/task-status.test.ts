import { describe, expect, it } from 'vitest';
import type { Task } from './types.js';
import {
  isLiveTask,
  isPausedTask,
  isTerminalTask,
  pauseAction,
  queuedFollowUpLabel,
  queuedMessagesCanRun,
  terminalTaskStatuses
} from './task-status.js';

const task = (status: string): Task => ({ id: 'task-1', status }) as Task;

const withQueue = (status: string, queuedMessageCount: number): Task =>
  ({ id: 'task-1', status, queuedMessageCount }) as Task;

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

/*
 * Measured on the live box: a correction was accepted at event 1533, the provider stopped answering
 * at 1534, and the conversation was set to `failed` with the correction still in its queue. The
 * header went on reading "1 queued" — a delivery promise on a conversation nothing will lease
 * again, made about the one message the owner sent to stop that turn going wrong.
 *
 * The box now carries such a message onto the next attempt and empties the queue when the attempts
 * run out, so in the ordinary case there is nothing left to count by the time a task reads
 * `failed`. These cases are for when there is: the count and the status are written by different
 * statements, and the header may not promise anything the status does not support.
 */
describe('what the header says about a follow-up already sent', () => {
  it('promises delivery only where something is still going to read it', () => {
    expect(allStatuses.filter((status) => queuedMessagesCanRun(task(status)))).toEqual([
      'draft',
      'queued',
      'planning',
      'running',
      'awaiting_user',
      'awaiting_resource',
      'paused'
    ]);
  });

  it('keeps the promise for a conversation stopped part-way, which resuming does honour', () => {
    expect(queuedFollowUpLabel(withQueue('paused', 1))).toBe('1 queued');
    expect(queuedFollowUpLabel(withQueue('awaiting_resource', 2))).toBe('2 queued');
  });

  it('says what actually happened once the conversation is finished', () => {
    expect(queuedFollowUpLabel(withQueue('failed', 1))).toBe('1 never started');
    expect(queuedFollowUpLabel(withQueue('cancelled', 1))).toBe('1 never started');
    expect(queuedFollowUpLabel(withQueue('completed', 3))).toBe('3 never started');
  });

  it('says nothing at all when there is nothing waiting, on either side of the line', () => {
    expect(queuedFollowUpLabel(withQueue('running', 0))).toBe('');
    expect(queuedFollowUpLabel(withQueue('failed', 0))).toBe('');
    expect(queuedFollowUpLabel(undefined)).toBe('');
  });
});
