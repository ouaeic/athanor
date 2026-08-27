/**
 * Where the middle of an over-long tool result goes, so that cutting it stops destroying it.
 *
 * `truncateMiddle` has always said how many characters it removed and never where they went. The
 * marker it replaced named the encrypted task event as the recovery, and that comment records why
 * it was retired: no tool reads a task event, so the omitted span was in practice unrecoverable,
 * and a 200 kB `shell` result reached the model as 24,000 characters with 176,000 gone for good.
 * This is the recovery that is real - the whole serialised result is written once, named by its
 * own sha256, and the marker interpolates that path and the point at which the cut began.
 *
 * **Trust decides the directory, and nothing else does.** A result that came from outside goes
 * under `workspace/downloads/`, which `DOWNLOAD_QUARANTINE_PREFIXES` in `command-classification.ts`
 * already declares to be bytes somebody else wrote sitting in the owner's own workspace - so a
 * later `file_read` of a spilled page is classified untrusted, sanitised and fenced exactly as the
 * original read was. Parking it anywhere else would be a laundering channel and would undo the
 * repair wave 1 made: the fence is put on the string in the WINDOW, and the same bytes read back
 * off a clean path arrive with no fence at all, in the harness's own voice.
 *
 * The sha256 name is free deduplication. A poll loop that reads the same 200 kB log on ten
 * consecutive steps writes one file, and the second through tenth cuts point at the file the first
 * one left; within a turn the repeat does not even reach the runner.
 *
 * The runner client is registered per turn rather than threaded through `ToolRecordingDeps`,
 * which is a closed interface five call sites share and of which this is the only member that
 * needs to write a file. It is held in a `WeakMap` keyed by the turn's own `AgentState`, so two
 * tasks running in one worker cannot see each other's writer, nothing is a module-level copy of
 * the worker's own state, and the entry dies with the state it belongs to.
 */
import { createHash } from 'node:crypto';
import type { TaskRecord } from '@athanor/data';
import type { AgentState } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';

/**
 * Where a result the owner's own computer produced parks its overflow.
 *
 * Under `workspace/` rather than beside it: the runner owns the sibling `.athanor` at a mode the
 * agent cannot traverse, and a path the agent cannot read is the same useless recovery as the task
 * event. `publishing.ts` writes `workspace/.athanor/renders/` for the same reason.
 */
export const SPILL_DIRECTORY = 'workspace/.athanor/output';

/**
 * And where a result from outside parks its overflow: inside the download quarantine, so that the
 * existing prefix list is what taints a read of it and there is no second list to keep in step.
 */
export const UNTRUSTED_SPILL_DIRECTORY = 'workspace/downloads/athanor-output';

/**
 * The largest result this will park, and the point past which it says nothing at all.
 *
 * A tool result is already bounded by the runner's own output ceilings, so this is the floor under
 * a route that stops honouring them rather than an expected case. Silence is the right failure:
 * the alternative is a marker naming a path holding a fraction of what it claims, which is the
 * exact fault - a recovery that cannot be performed - this file exists to close.
 */
export const MAX_SPILL_CHARS = 8_000_000;

/** The one runner client this turn writes through, keyed by the turn's own state. */
const writers = new WeakMap<AgentState, AgentRunnerClient>();
/** Paths this turn has already put on the disk, so identical bytes cost one round trip. */
const written = new WeakMap<AgentState, Set<string>>();

/**
 * Names the runner this turn's overflow is written through. Called once per turn from
 * `assemblePreamble`, which is the one place that holds both the worker's runner client and the
 * state object every later step mutates.
 */
export const useOutputSpill = (state: AgentState, runner: AgentRunnerClient): void => {
  writers.set(state, runner);
};

/** The path a given body would be parked at. Pure, so a test can name it without writing it. */
export const spillPathFor = (text: string, untrusted: boolean): string =>
  `${untrusted ? UNTRUSTED_SPILL_DIRECTORY : SPILL_DIRECTORY}/${createHash('sha256')
    .update(text)
    .digest('hex')}.txt`;

/**
 * Parks the whole of an over-long result and answers with the path, or with null when no claim can
 * honestly be made about it.
 *
 * Null on three counts, and all three are the same rule: nothing may be named that is not there.
 * No writer registered (a delegated specialist's window, which never runs a preamble), a body past
 * the ceiling, or a runner that refused the write - a full disk, a wedged service, a workspace
 * being deleted underneath the turn. A failed spill costs the model the pointer it never had
 * before this file existed; a spill claimed and not made would cost it a step reading a file that
 * is not there, and cost the harness the only thing its markers have ever been good for.
 */
export const spillOverflow = async (
  task: TaskRecord,
  state: AgentState,
  text: string,
  untrusted: boolean
): Promise<string | null> => {
  const runner = writers.get(state);
  if (!runner || text.length > MAX_SPILL_CHARS) return null;
  const path = spillPathFor(text, untrusted);
  const already = written.get(state) ?? new Set<string>();
  written.set(state, already);
  if (already.has(path)) return path;
  try {
    await runner.writeFile(task.workspaceId, task.id, path, text);
  } catch {
    return null;
  }
  already.add(path);
  return path;
};

/**
 * What the model is told in place of the bytes that were cut.
 *
 * Two clauses doing two jobs. The first is the pointer, and it leads on the CHARACTER rather than
 * the line because of what a spilled tool result actually is: `JSON.stringify` writes a newline as
 * `\n`, so the file is one enormous line and a line number is a true fact that addresses nothing.
 * `cut -c` is named because it is the one ordinary command that takes a span out of a single line,
 * and a recovery that cannot be performed is the precise fault this whole file exists to close.
 * The line is still given when the body genuinely has more than one, since the same marker serves
 * anything `truncateMiddle` is asked to park.
 *
 * The second clause is the one that changes the NEXT call rather than this one: a model that has
 * just lost 176,000 characters is about to ask for them again exactly the same way, and telling it
 * to bound the output where the output is made costs nothing and saves a round trip. It is
 * deliberately not an apology for the cut - the cut is correct, and what was wrong was asking a
 * command to print a hundred times more than any window can hold.
 */
export const spillRecovery =
  (path: string) =>
  (cut: { character: number; line: number }): string =>
    `the whole result is at ${path} and the cut begins at character ${cut.character}${
      cut.line > 1 ? ` (line ${cut.line})` : ''
    } - read that span back with \`cut -c\` or a bounded file_read instead of running this again, and next time bound long output where it is made, with head, tail or grep, or send it to a file and read the file in pieces`;
