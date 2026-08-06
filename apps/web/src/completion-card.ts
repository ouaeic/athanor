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
import type { TaskEvent } from './types.js';

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
   * The harness writes its caveat into two places at once: beside the checks it ran, and among the
   * risks the turn is leaving behind. It is the harness's sentence about its own tick rather than
   * something the agent noticed, so it is lifted out of the agent's list and shown once, where the
   * tick is. Matching on the whole line is what keeps a failed check out of this: a failure appears
   * in both fields too, but with the check's id in front of it in one and not the other.
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
