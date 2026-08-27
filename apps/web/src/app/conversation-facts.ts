/**
 * Facts about a conversation and about this tab, answered without React.
 *
 * Lifted out of `App.tsx` whole. Each of these is a question with one right answer given the same
 * inputs — who holds the computer, what a packaged shell should ring about, whether an offer can be
 * made without costing the owner something — and none of them needs a component to be asked. They
 * were the only testable part of a 3,203-line function, which is why `App.test.tsx` already tests
 * exactly these three and nothing else.
 */
import { ringsNatively } from '../native.js';
import type { NotificationKind, NotificationSettings } from '../notification-settings.js';
import type { Task } from '../types.js';

/**
 * The conversation that has this one's computer, or undefined when nothing has it.
 *
 * A computer is one filesystem, one browser and one desktop, so it is handed to one conversation at
 * a time: a second one asked while the first is working waits, and `planning` is written by the
 * hand-over itself. A queued conversation with a `planning` or `running` neighbour on the same
 * computer is therefore not slow to start — it is behind that neighbour, which is the difference
 * the screen had no way of showing.
 *
 * How long the holder may keep the computer is not on the wire, so there is one case this reads
 * wrong: a turn whose worker died keeps a working-looking status until its hold runs out, and this
 * names it while the computer is in fact free. It rights itself as soon as this conversation is
 * picked up, which is the same few seconds either way.
 */
export const computerHeldBy = (task: Task | undefined, tasks: Task[]): Task | undefined =>
  task?.status === 'queued'
    ? tasks.find(
        (other) =>
          other.id !== task.id &&
          other.workspaceId === task.workspaceId &&
          (other.status === 'planning' || other.status === 'running')
      )
    : undefined;

/** One thing the packaged shell could raise with the operating system. */
export interface NativeNotice {
  /** Stable for the thing being reported, so it is announced once and never again. */
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
}

/**
 * What a packaged shell should ring about, out of everything a poll has just seen.
 *
 * Two defects meet here. The native path served two of the five kinds — `agent_message` and
 * `takeover_needed` — and not `approval_required`, which is the agent stopped waiting on a person
 * and which the store itself ranks priority 0; and the quiet hours and per-kind switches the owner
 * sets were stored and then applied only on the Web Push delivery path, which is the one path a
 * packaged shell has no subscription on. So the installed application could not be told the one
 * thing that matters, and rang anyway at 3 a.m. for the things it could.
 *
 * Seen is seen, whether or not it rang. A notice suppressed by quiet hours is still on the screen
 * and still in the notice log; holding it here to ring the moment the window ends would make this a
 * delivery queue, which it is not — the box's own push path is the thing that holds and re-delivers,
 * and the alternative is a burst of eight notifications at 07:01.
 */
export const nativeNoticesToRaise = (input: {
  candidates: NativeNotice[];
  /** Mutated: the ids this poll has now accounted for. */
  seen: Set<string>;
  settings: NotificationSettings | null;
  at?: Date;
}): NativeNotice[] => {
  const raise: NativeNotice[] = [];
  for (const candidate of input.candidates) {
    if (input.seen.has(candidate.id)) continue;
    input.seen.add(candidate.id);
    const decision = {
      kind: candidate.kind,
      settings: input.settings,
      ...(input.at ? { at: input.at } : {})
    };
    if (ringsNatively(decision)) raise.push(candidate);
  }
  return raise;
};

/**
 * Whether the offer to reload can be made without asking the owner to lose something for it.
 *
 * A reload throws away whatever exists only in this tab. The sentence in the composer does not: it
 * is banked on the way out and read back on the way in. A voice note being recorded is bytes that
 * have never left the microphone, and the attachment tray is a set of files this browser is the
 * only record of until the message is sent — the box is told about them alongside the next
 * keystroke, not when they land, so a reload can strip a tray the box has never heard of.
 *
 * Neither is a reason to interrupt anyone, so the offer simply waits. It is not urgent, nothing
 * expires, and it appears the moment this tab is holding nothing of its own.
 */
export const mayOfferReload = (state: {
  superseded: boolean;
  recording: boolean;
  attachmentCount: number;
}): boolean => state.superseded && !state.recording && state.attachmentCount === 0;
