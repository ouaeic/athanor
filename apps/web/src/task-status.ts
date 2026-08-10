/**
 * What a conversation's status means to the interface, in one place.
 *
 * The same three questions — is it finished, is the agent working, is it stopped and resumable —
 * were answered by inline arrays in five files, and they disagreed. `awaiting_resource` was absent
 * from the working set, so a conversation waiting for the computer could not be stopped with Escape
 * and offered no Stop button, while the header a few pixels away offered Resume for it. One table.
 */
import type { Task } from './types.js';

/** Nothing more will happen without a new message. */
export const terminalTaskStatuses = new Set(['completed', 'failed', 'cancelled']);

/**
 * The agent has this conversation: it is working, queued to work, waiting on the box, or stopped
 * part-way with its state intact. `draft` is deliberately absent — nothing is running.
 */
const liveTaskStatuses = new Set([
  'queued',
  'planning',
  'running',
  'awaiting_user',
  'awaiting_resource',
  'paused'
]);

/** Stopped part-way, so the control that acts on it is Resume rather than Pause. */
const pausedTaskStatuses = new Set(['paused', 'awaiting_resource']);

export const isTerminalTask = (task: Task | undefined): boolean =>
  Boolean(task && terminalTaskStatuses.has(task.status));

export const isLiveTask = (task: Task | undefined): boolean =>
  Boolean(task && liveTaskStatuses.has(task.status));

export const isPausedTask = (task: Task | undefined): boolean =>
  Boolean(task && pausedTaskStatuses.has(task.status));

/** Which way the one pause control points, so its icon, its word and its request never disagree. */
export const pauseAction = (task: Task | undefined): 'pause' | 'resume' =>
  isPausedTask(task) ? 'resume' : 'pause';

/**
 * Whether more text can still arrive on this conversation.
 *
 * Wider than terminal, and that is the point. The transcript decided "is this answer still being
 * written" from `terminal` alone, so a turn paused mid-sentence - the one case where the last event
 * on the timeline is half a reply - kept its typing indicator blinking under it forever, saying the
 * agent was still writing on a conversation the owner had just stopped. Nothing is being written
 * while a task waits for an approval or for the computer either.
 */
export const taskIsGenerating = (status: string): boolean =>
  !terminalTaskStatuses.has(status) &&
  status !== 'paused' &&
  status !== 'awaiting_user' &&
  status !== 'awaiting_resource';
