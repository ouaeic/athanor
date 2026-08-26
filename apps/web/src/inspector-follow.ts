/**
 * Which pane is showing the work right now, if any is.
 *
 * On a 1600px window the Inspector is 38% of the display, and its default is a file listing that
 * has not changed since it loaded — so while the agent drove the screen or ran a build, the largest
 * thing on screen was furniture. This answers "is there a pane where that would be visible", and
 * nothing more: it is a suggestion, the owner's own choice outranks it, and App decides when to
 * listen. Kept out of the component because the interesting part is which events count, which is
 * exactly the part a component cannot be asked about.
 */
import type { InspectorTab } from './client-state.js';
import { isLiveTask } from './task-status.js';
import type { Task, TaskEvent } from './types.js';

/*
 * Only tools whose work leaves something on a pane to watch.
 *
 * `file_read` and `file_patch` are deliberately absent even though Files exists: a read or a patch
 * leaves nothing moving in a directory listing, and a pane that flicked to Files on every one of
 * them would be following the transcript rather than the work. The browser tools point at Computer
 * because the agent's browser is launched onto the workspace display that pane already streams —
 * see the note above `inspectorTabs` in Inspector.tsx.
 *
 * `shell` is absent, and Terminal is not a destination here at all, because it never was one. The
 * agent's commands run through `POST …/exec`; the Terminal pane opens `GET …/terminal`, which
 * spawns a fresh pty with its own pipes. So a turn that ran a build put the owner in front of their
 * own idle `$` — the work they had just been told about running somewhere the pane could not show —
 * and, because a pane is built the first time it is looked at, it also started a real second shell
 * on their server and renewed a capability token to keep it alive. That is precisely the cost
 * Inspector.tsx says "nobody should be paying for on a tab they have never opened". A foreground
 * command needs no pane in any case: its output is written into the transcript already on screen.
 *
 * `process` points at Running instead. That is the tool the agent inspects background sessions
 * with, and the Running pane is the one surface that lists them.
 */
const toolPanes: Record<string, InspectorTab> = {
  browser_action: 'computer',
  browser_snapshot: 'computer',
  desktop_action: 'computer',
  desktop_launch: 'computer',
  desktop_observe: 'computer',
  read_elements: 'computer',
  process: 'preview'
};

const toolOf = (event: TaskEvent): string => {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  return typeof payload.tool === 'string' ? payload.tool : '';
};

/**
 * The pane the running conversation would be visible on, or nothing.
 *
 * Two boundaries, both measured against how a turn actually arrives. It answers nothing at all
 * unless the conversation is live, because a finished transcript is not work anyone is watching.
 * And it looks no further back than the last message the owner sent: a conversation resumed an hour
 * after a shell command would otherwise snap to the Terminal the instant it went live, on the
 * strength of a command that finished before lunch.
 *
 * Within the turn it holds the newest pane rather than requiring a call to still be in flight. The
 * gaps between tool calls are where the model is thinking, and following only in-flight calls meant
 * the pane bounced back to the file list every few seconds.
 */
export const followedPane = (
  task: Task | undefined,
  events: TaskEvent[]
): InspectorTab | undefined => {
  if (!isLiveTask(task)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === 'user_message') return undefined;
    if (event.kind !== 'tool_started') continue;
    const pane = toolPanes[toolOf(event)];
    if (pane) return pane;
  }
  return undefined;
};
