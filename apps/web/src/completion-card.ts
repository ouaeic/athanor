/**
 * What the card at the end of a turn is allowed to say.
 *
 * A turn ends in one of two ways and the card used to render both identically, headed "Result".
 * When the harness stops a turn at its step limit the box says so in as many words — the event is
 * labelled "Stopped at the step limit with work outstanding", it carries `interrupted: true`, it
 * carries the plan steps still open, and its verification status is `not_applicable`, which is the
 * agent asserting the opposite of a verified completion. The card read the outstanding work as
 * "caveats", printed the heading "Verified result" over them, and threw the label away.
 *
 * Nothing here invents a claim: `verified` is only ever the agent's own word for it, and the
 * harness run below is only ever what the harness itself observed.
 */
import { taskIsGenerating } from './task-status.js';
import type { TaskEvent, TaskRewindPreview } from './types.js';

/**
 * One acceptance check as the harness ran it.
 *
 * This is the only evidence on the card that the agent did not write. `detail` is the harness's own
 * observation — an exit code and the first of whatever the command printed, a file size against the
 * size that was required, or the reason the check could not run at all — and it is shown verbatim
 * rather than summarised, because "exit 1: 3 tests failed" is the sentence that decides what to do
 * next and any paraphrase of it is athanor speaking for a tool it should be quoting.
 */
export interface HarnessCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface CompletionCard {
  /** What kind of ending this was, in the box's own words where it gave them. */
  headline: string;
  /** Whether the turn ran out of room rather than finishing, which changes what to do next. */
  interrupted: boolean;
  summary: string;
  /** Plan steps the turn never reached, for the reply that continues it. */
  outstanding: string[];
  /** Claims the agent checked, each already phrased as a sentence. */
  evidence: string[];
  /** What the agent says it could not rule out. Empty on an interrupted turn: see below. */
  caveats: string[];
  /** True only when the agent claimed the outcome was verified and showed something for it. */
  verified: boolean;
  /** The checks the harness executed for this completion, in the order it declared them. */
  harness: HarnessCheck[];
  /** Why this tick means less than the last one, in the harness's words. Shown, never folded. */
  harnessCaveats: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown, limit: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, limit)
    : [];

const INTERRUPTED_HEADLINE = 'Stopped with work outstanding';

/**
 * The acceptance run behind a status event, or nothing when that event is not one.
 *
 * The harness publishes each run as it happens, with the result of every check, and the completion
 * that follows carries only a flattened line per check. This reads the run itself, so the card can
 * mark a check that failed rather than inferring it from prose.
 *
 * The baseline run is deliberately not one of these. It happens before the work, to refuse an
 * acceptance record that already passes, and a card carrying both would show two ticks where only
 * one of them is about the job.
 */
export const harnessRun = (event: TaskEvent): HarnessCheck[] | undefined => {
  const data = record(event.payload);
  if (!data || data.baseline === true || !Array.isArray(data.acceptance)) return undefined;
  const checks = data.acceptance
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .filter((entry) => typeof entry.label === 'string' && typeof entry.detail === 'string')
    .map(
      (entry): HarnessCheck => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        label: entry.label as string,
        passed: entry.passed === true,
        detail: entry.detail as string
      })
    );
  return checks.length ? checks : undefined;
};

export const completionCard = (
  event: TaskEvent,
  harness: readonly HarnessCheck[] = []
): CompletionCard => {
  const data = record(event.payload) ?? {};
  const verification = record(data.verification);
  const interrupted = data.interrupted === true;
  const outstanding = strings(data.outstanding, 20);
  const remainingRisks = strings(verification?.remainingRisks, 20);
  /*
   * Two fields decide where a caveat about the checks is shown, and that is the whole protocol.
   *
   * A line written into both the acceptance list and the risks is athanor's own sentence about the
   * worth of its own tick, and it is shown once, beside the tick. A line written only into the
   * risks is detail, and it stays behind the disclosure with everything else the agent could not
   * rule out. Only one caveat is ever sent both ways - the checks that were already passing before
   * the job started, where "all passed" on its own would tell a reader the opposite of what
   * happened. The rest qualify the evidence rather than contradicting it, and a reader who is not
   * opening the receipt is not the reader they were written for.
   *
   * Matching on the whole line is what keeps a failed check out of this: a failure appears in both
   * fields too, but with the check's id in front of it in one and not the other.
   */
  const harnessCaveats = strings(data.acceptance, 20).filter((line) =>
    remainingRisks.includes(line)
  );
  const evidence = Array.isArray(verification?.evidence)
    ? verification.evidence
        .map((item) => record(item)?.claim)
        .filter((claim): claim is string => typeof claim === 'string' && claim.trim() !== '')
        .slice(0, 20)
    : [];
  return {
    headline: interrupted ? event.summary.trim() || INTERRUPTED_HEADLINE : 'Result',
    interrupted,
    summary:
      typeof data.summary === 'string' && data.summary.trim()
        ? data.summary
        : 'All requested work is ready.',
    /*
     * An interrupted turn writes the same list into both fields, because the steps it did not reach
     * are literally the risks it is leaving behind. Listing them twice under two headings would be
     * the card arguing with itself, so the outstanding work wins and the caveat list stands down.
     */
    outstanding: interrupted ? (outstanding.length ? outstanding : remainingRisks) : outstanding,
    evidence,
    caveats: interrupted ? [] : remainingRisks.filter((risk) => !harnessCaveats.includes(risk)),
    verified: verification?.status === 'verified' && evidence.length > 0,
    harness: [...harness],
    harnessCaveats
  };
};

const count = (total: number, noun: string): string =>
  `${total} ${total === 1 ? noun : `${noun}s`}`;

/**
 * The one line above the disclosure, or nothing to open at all.
 *
 * Where the harness ran, it leads: "the harness ran these and this is what happened" is a different
 * class of statement from "the agent says it checked", and a reader who only ever sees the summary
 * line should be told which of the two they are looking at. A failure is named in the summary
 * rather than left inside, because a completion whose own checks failed is the one case where not
 * opening the disclosure would leave the owner with the wrong impression.
 */
export const verificationReceiptLabel = (card: CompletionCard): string => {
  if (!card.evidence.length && !card.caveats.length && !card.harness.length) return '';
  const failed = card.harness.filter((check) => !check.passed).length;
  const heading = card.harness.length
    ? failed
      ? `The harness ran ${count(card.harness.length, 'check')} · ${failed} failed`
      : `The harness ran ${count(card.harness.length, 'check')} · all passed`
    : card.verified
      ? 'Verified result'
      : 'What the agent checked';
  return card.caveats.length ? `${heading} · ${count(card.caveats.length, 'caveat')}` : heading;
};

/**
 * Which finished turn, if any, can honestly be asked what it did to the computer.
 *
 * The box takes a restore point in front of a turn's first call that could change anything, and it
 * will describe the difference between that point and the tree as it stands. That difference is
 * this turn's work only while two things hold: the restore point belongs to this turn, and nothing
 * has touched the tree since the turn ended. So the newest completion is the only one worth
 * asking about, and only once the conversation has stopped moving.
 */
export interface TurnComputerQuery {
  /** The completion to ask about, which is the point the restore point is resolved from. */
  eventId: string;
  /** Where the turn began, so a restore point taken for an earlier one can be recognised. */
  fromSequence: number;
}

export const turnComputerQuery = (
  events: readonly TaskEvent[],
  taskStatus: string
): TurnComputerQuery | undefined => {
  if (taskIsGenerating(taskStatus)) return undefined;
  let completed = -1;
  for (let index = events.length - 1; index >= 0; index -= 1)
    if (events[index]!.kind === 'completed') {
      completed = index;
      break;
    }
  if (completed < 0) return undefined;
  // A call made after this turn ended moved the tree again, and the difference would be charged to
  // the wrong turn. It happens on a conversation whose next turn failed after doing some work.
  for (let index = completed + 1; index < events.length; index += 1)
    if (events[index]!.kind === 'tool_started') return undefined;
  let start = -1;
  let acted = false;
  for (let index = completed - 1; index >= 0; index -= 1) {
    const kind = events[index]!.kind;
    if (kind === 'user_message' || kind === 'task_created') {
      start = index;
      break;
    }
    if (kind === 'tool_started') acted = true;
  }
  /*
   * A turn that made no call took no restore point, and the box would answer with the previous
   * turn's - so a conversational reply would be handed the file changes of the turn before it.
   * `start` is missing when the turn's opening message is older than the page this device holds,
   * which is the same thing: there is no way to tell whose restore point came back.
   */
  if (!acted || start < 0) return undefined;
  return { eventId: events[completed]!.id, fromSequence: events[start]!.sequence };
};

/**
 * What the turn did to the computer, in one line, or nothing at all.
 *
 * Silence is most of this function's job. A line reading "no files changed" under every reply is
 * the interface talking about itself, and the counts are worth a line precisely because they are
 * not usually there.
 */
export const computerChangeLine = (
  preview: TaskRewindPreview | undefined,
  fromSequence: number
): string => {
  const computer = preview?.computer;
  const sequence = preview?.checkpoint?.eventSequence;
  if (!computer || sequence === undefined || sequence === null) return '';
  // A restore point anchors to the message that opened the turn it was taken for. One older than
  // this turn's opening message is an earlier turn's, and the difference it measures is not this
  // turn's work.
  if (sequence < fromSequence) return '';
  const said = (
    [
      [computer.addedCount, 'added'],
      [computer.modifiedCount, 'changed'],
      [computer.deletedCount, 'deleted']
    ] as const
  )
    .filter(([total]) => total > 0)
    // The noun goes on the first clause only: "2 files added, 1 deleted" says everything
    // "2 files added, 1 file deleted" does, in a line the eye crosses once.
    .map(([total, verb], index) =>
      index === 0 ? `${count(total, 'file')} ${verb}` : `${total} ${verb}`
    );
  return said.length ? `On the computer — ${said.join(', ')}` : '';
};
