/**
 * How long the machine has been in the state it is in, when that has become the news.
 *
 * Measured on the owner's box: a turn ran fourteen minutes and billed twelve model calls, eleven of
 * those minutes falling between two of them. The screen showed a spinner, the word "running" and a
 * cost that did not move, and the owner read the frozen cost correctly - "it keeps going but the
 * cost isn't going up" - because that was the only honest signal on screen. The transcript already
 * held the answer: which tool started, whether its result had come back, and when the last model
 * call settled. None of it was being printed.
 *
 * The whole of what this adds is a clock, and only once the clock is worth reading. Under
 * `QUIET_AFTER_MS` it says nothing at all, which leaves every ordinary turn exactly as it was - the
 * work log's existing line already names the tool, and a duration on a four-second read is furniture.
 * Past it the line carries the elapsed time, so a stalled turn reads as a stalled turn instead of as
 * a busy one.
 *
 * Two shapes and no third: the tool that is in flight, or `Thinking` when none is. There is
 * deliberately no vocabulary here for the difference between reasoning and writing an answer - the
 * client cannot see it, and a word that guesses is worse than a number that does not.
 *
 * Drawn at the foot of the transcript by `Timeline.tsx`'s `LiveActivity`, beside the running cost.
 * That is where the owner went looking the first time - the cost that had stopped moving was what
 * they read the stall off - and it is the one place on the page that does not depend on the shape
 * of the newest node, which matters because a turn stalled between two model calls often has no
 * activity group at the bottom to hang a line on. `TaskActivity`'s `<small>`, which this was
 * written against, went with the work log's fold; there is no label left for the clock to replace,
 * so it is a line of its own or it is nothing. `now` comes from a 15-second interval that runs only
 * while the turn is generating, so the number ages and a finished conversation holds no timer.
 */
import { taskIsGenerating } from './task-status.js';
import { settledToolStarts, toolLabel } from './timeline-state.js';
import type { TaskEvent } from './types.js';

/**
 * How long one state has to last before its duration is worth a line.
 *
 * Every shell command, file read and search on a healthy box settles inside this, so the ordinary
 * turn never grows a clock. It is a floor on noise rather than a threshold on trouble: thirty
 * seconds of silence is not yet a problem, and the first minute of one always looks the same.
 */
export const QUIET_AFTER_MS = 30_000;

/**
 * Event kinds that mean something finished.
 *
 * A `cost` event is a settled model call, which is the one the owner was reconstructing by hand. A
 * `tool_result` is a returned tool, a `user_message` is the turn's own beginning, and a resolved
 * approval is the moment the machine stopped waiting on a person. Anything else in the log - a
 * delta, a reasoning frame, a status - is the same activity continuing, so counting from it would
 * reset the clock every 160 characters and report a fourteen-minute spiral as one second old.
 */
const COMPLETION_KINDS = new Set(['cost', 'tool_result', 'user_message', 'approval_resolved']);

/** Whole units only. A turn that has been going three minutes is not more legible to the second. */
const elapsedLabel = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

const startedAt = (event: TaskEvent): number => Date.parse(event.createdAt);

const eventPayload = (event: TaskEvent): Record<string, unknown> =>
  event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};

/**
 * The one line, or nothing.
 *
 * `now` is passed rather than read so the same second can be asserted against, the way the process
 * rows do it.
 */
export const liveActivity = (input: {
  events: TaskEvent[];
  taskStatus: string;
  now: number;
}): string => {
  // A conversation waiting on an approval, parked on a question or finished is not in a state whose
  // duration means anything - the screen already says whose turn it is, and a clock on a request
  // the owner has not answered yet would be counting them rather than the machine.
  if (!taskIsGenerating(input.taskStatus)) return '';
  const settled = settledToolStarts(input.events, input.taskStatus);
  let inFlight: TaskEvent | undefined;
  let lastCompletion: number = Number.NaN;
  // One backwards pass: the newest unsettled tool start, and the newest thing that finished. Both
  // are needed and the log is rebuilt on every streamed frame, so it is one walk rather than two.
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;
    if (!inFlight && event.kind === 'tool_started' && !settled(event)) inFlight = event;
    if (Number.isNaN(lastCompletion) && COMPLETION_KINDS.has(event.kind))
      lastCompletion = startedAt(event);
    if (inFlight && !Number.isNaN(lastCompletion)) break;
  }
  const since = inFlight ? startedAt(inFlight) : lastCompletion;
  if (Number.isNaN(since)) return '';
  const waited = input.now - since;
  if (waited < QUIET_AFTER_MS) return '';
  const rawTool = inFlight ? eventPayload(inFlight).tool : '';
  const label = inFlight
    ? toolLabel(typeof rawTool === 'string' ? rawTool : '', inFlight.summary)
    : 'Thinking';
  return `${label} · ${elapsedLabel(waited)}`;
};
