/**
 * Which conversation has the computer.
 *
 * These cases are the queueing rule the box actually runs, read from this side: one computer goes
 * to one conversation at a time, a computer of its own runs at once, and parking a turn hands the
 * computer over rather than holding it until something expires. If the two ever disagree the screen
 * is telling the owner to wait for a computer that is free, or saying nothing while they wait.
 */
import { describe, expect, it } from 'vitest';
import { computerHeldBy } from './App.js';
import type { Task } from './types.js';

const conversation = (id: string, status: Task['status'], workspaceId = 'desk'): Task =>
  ({ id, workspaceId, status, title: `Conversation ${id}` }) as Task;

const waiting = conversation('second', 'queued');

describe('the conversation holding the computer', () => {
  it('is the neighbour working on the same computer', () => {
    const working = conversation('first', 'running');
    expect(computerHeldBy(waiting, [working, waiting])).toBe(working);
  });

  it('counts a neighbour that has only just been handed the computer', () => {
    // `planning` is written by the hand-over itself, so it is a holder from its first millisecond.
    const handed = conversation('first', 'planning');
    expect(computerHeldBy(waiting, [handed, waiting])).toBe(handed);
  });

  it('is nobody when the work is on another computer', () => {
    const elsewhere = conversation('first', 'running', 'spare');
    expect(computerHeldBy(waiting, [elsewhere, waiting])).toBeUndefined();
  });

  it('is nobody once the turn holding it has parked to ask the owner something', () => {
    const parked = conversation('first', 'awaiting_user');
    expect(computerHeldBy(waiting, [parked, waiting])).toBeUndefined();
  });

  it('is nobody when the neighbour is queued too, because neither has been handed anything', () => {
    const alsoWaiting = conversation('first', 'queued');
    expect(computerHeldBy(waiting, [alsoWaiting, waiting])).toBeUndefined();
  });

  it('is nobody for a conversation that is itself working', () => {
    const working = conversation('second', 'running');
    expect(computerHeldBy(working, [conversation('first', 'running'), working])).toBeUndefined();
  });
});
