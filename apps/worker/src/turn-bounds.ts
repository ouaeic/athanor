/**
 * Every ceiling a turn runs into, and the sentence the owner reads when it does.
 *
 * A turn ends because it finished or because it hit one of these. Each constant here is a number
 * somebody chose after watching a turn fail without one, and each is paired in the same file with
 * the wording that explains the stop - because a bound whose message lives elsewhere is a bound
 * that gets raised without anyone rereading what it says.
 *
 * They are together rather than beside their call sites because they are read against each other:
 * `IDLE_STEPS_BEFORE_STOP` is twice `MAX_IDLE_STEPS` and `REPEATED_FAILURES_BEFORE_STOP` is twice
 * `MAX_REPEATED_FAILURES`, and that relation is only legible when both halves are on screen.
 *
 * Lifted out of `agent.ts` unchanged by Wave 7.1.
 */
import type { SpendDecision } from '@athanor/contracts';
import { AthanorError, sha256 } from '@athanor/core';
import type { ModelMessage, ModelToolCall } from '@athanor/model-gateway';
import type { AcceptanceResult } from './acceptance.js';
import type { AgentState } from './agent-state.js';
import { canonicalJson } from './values.js';

/**
 * Tools whose second run cannot surprise anyone: they only read, so repeating one after a restart
 * costs nothing and tells the owner nothing new. Everything else is assumed to have reached the
 * workspace, the outside world, or the owner's provider bill by the time it was interrupted, and is
 * never replayed on its own. `set_plan` is here because a repeated publish of the same steps is
 * version-guarded and idempotent in effect.
 */
export const REPEATABLE_TOOLS = new Set([
  'browser_snapshot',
  'code_diagnostics',
  'code_search',
  'connector_list',
  'desktop_observe',
  'document_read',
  'document_search',
  'file_read',
  'files_list',
  'image_read',
  'memory_recall',
  'parallel_web_read',
  'repo_overview',
  'session_search',
  'set_acceptance',
  'set_plan',
  'web_search'
]);

/**
 * Tools where the same call twice in one turn cannot say anything the first did not.
 *
 * A loop is the failure mode a step budget contains rather than prevents: an agent that cannot find
 * something re-runs the identical search, gets the identical answer, and spends forty steps and the
 * owner's money learning nothing. The budget stops it eventually, but the run ends at a ceiling
 * with the work undone rather than at the point the agent should have tried something else.
 *
 * Narrow on purpose. These are the tools whose answer is a pure function of the workspace and the
 * arguments within one turn, so a byte-identical repeat is byte-identically uninformative. Polling
 * and re-observation are deliberately absent - `process` is how the model is told to watch a build,
 * `browser_snapshot` and `desktop_observe` take no arguments at all so every call looks identical,
 * and `shell` may legitimately be run twice to see whether anything changed. Repeating those is the
 * documented way to use them, not a symptom.
 */
export const IDEMPOTENT_WITHIN_TURN = new Set([
  // The only member that costs money to repeat. Transcription is billed by the minute, so a second
  // identical reading of the same window of the same recording buys the same text twice.
  'audio_read',
  'code_search',
  'document_read',
  'document_search',
  'file_read',
  'memory_recall',
  'repo_overview',
  'session_search'
]);

/** How a repeat is recognised: the tool and the exact arguments, which is what makes it a repeat. */
export const idempotentCallKey = (call: ModelToolCall): string =>
  `${call.name}:${JSON.stringify(call.arguments)}`;

/**
 * Tools whose calls may be in flight at the same time as each other.
 *
 * `REPEATABLE_TOOLS` minus its two writers is the obvious basis and it is very nearly right, but it
 * is not the property being asked for, and it should not be inherited without saying so: its own
 * comment defines it as a replay-safety set - a tool whose second run after a restart cannot
 * surprise anyone - and surviving a replay says nothing about two calls overlapping. Three things
 * have to hold, and the third costs the set a third member:
 *
 * - The call cannot change the computer, so no order between it and a sibling is observable at all.
 *   `set_plan` and `set_acceptance` are the two members that write, and both are out: a plan
 *   published while the read that decides its next step is still running is a plan nobody chose.
 * - Its answer does not depend on when a sibling's answer lands. Everything left reads the
 *   workspace, the memory store, or a search index.
 * - The approval floor's verdict on it cannot move while the run is in flight. This is what puts
 *   `parallel_web_read` out, and it is not a technicality. While the turn is tainted, a web read is
 *   judged against `turnNoveltyBytes` - a per-turn budget of bytes that appear nowhere in the
 *   owner's request - and that budget is only charged when a result is recorded. Two reads judged
 *   concurrently are both judged against the same spent total, so a pair that run one after the
 *   other would card on the second can both go out with no card at all. That is the exfiltration
 *   floor, and it is not being traded for a round trip. `parallel_web_read` is also the member that
 *   wants this least: it already fetches up to twelve pages at once inside itself.
 */
export const PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set(
  [...REPEATABLE_TOOLS].filter(
    (name) => !['set_plan', 'set_acceptance', 'parallel_web_read'].includes(name)
  )
);

/**
 * How many of them run together.
 *
 * Four. It is the shape the batches actually have - a task opens with three or four `file_read`s,
 * or a `code_search` beside a `repo_overview` - so a higher cap would buy almost nothing real, and
 * every one of these calls crosses to a single workspace runner serving one container and holds a
 * whole file body in this process while it does. Four whole files is the most of the owner's memory
 * this loop is willing to hold to save a round trip. A longer batch is not refused: it runs as
 * consecutive runs of four, which is still four times fewer waits than before.
 */
export const MAX_PARALLEL_TOOL_CALLS = 4;

/**
 * How many calls from `from` may run as one concurrent run: the maximal run of consecutive
 * parallel-safe calls, capped, and stopped in front of anything the loop answers instead of running.
 *
 * A run of one is not a run - the caller reads anything below two as "take the ordinary path" - so
 * the guards that end a run early cost nothing but the parallelism they were going to save. A call
 * whose arguments were cut off mid-JSON is one of those, and so is an exact repeat of a read this
 * turn has already answered: both are answered with a message rather than executed, and that
 * message has to keep its place in the declared order, so the run ends in front of it.
 */
export const parallelToolRun = (
  calls: readonly ModelToolCall[],
  from: number,
  seenCalls: Readonly<Record<string, string>> = {}
): number => {
  const seen = new Set(Object.keys(seenCalls));
  let length = 0;
  while (from + length < calls.length && length < MAX_PARALLEL_TOOL_CALLS) {
    const call = calls[from + length];
    if (!call || !PARALLEL_SAFE_TOOLS.has(call.name) || call.parseFailed) break;
    if (IDEMPOTENT_WITHIN_TURN.has(call.name)) {
      const repeat = idempotentCallKey(call);
      if (seen.has(repeat)) break;
      seen.add(repeat);
    }
    length += 1;
  }
  return length;
};

/**
 * Tools that cannot change the computer, so a turn made only of these needs no undo point.
 *
 * The read-only set above is exactly the right basis: a tool that is safe to run twice after a
 * restart is a tool that left nothing behind to undo. `finish` and `compact_context` are added
 * because they are harness bookkeeping and never touch the workspace, and `notify` because the only
 * thing it reaches is the owner's own lock screen - it is not repeatable, since a second send is a
 * second buzz, but there is nothing on the computer for a checkpoint to hold. Everything else counts
 * as mutating, deliberately - a checkpoint taken before a call that turns out to change nothing
 * costs a walk of the tree and no bytes at all, and missing one costs the owner their undo.
 */
export const CHECKPOINT_EXEMPT_TOOLS = new Set([
  ...REPEATABLE_TOOLS,
  'finish',
  'compact_context',
  'notify'
]);

/**
 * Whether a turn that lost its undo point lost it for a reason the owner can do something about.
 *
 * Measured: writing a two-line haiku produced a transcript whose loudest card was "This turn has no
 * undo point for the computer", raised because the runner could not take a checkpoint - a fact
 * about the machine, not about the verse. There is exactly one cause of it the owner can clear, and
 * the runner says so in as many words when it refuses: the host disk is too full. That one reaches
 * the conversation; every other cause stays in the work log, where the record still exists for
 * anyone who goes looking for why a rewind is not on offer.
 */
/**
 * Where an approval was raised from, for the row the owner can look back through.
 *
 * `approvals.origin` has been a column since the table was created, `createApproval` has taken it
 * as an optional parameter, `listApprovals` has projected it and `GET /v1/approvals` has served it
 * - and nothing has ever passed one, so every row on every box carries NULL. The reason to write it
 * is the one stated beside `#raiseTaint` below: a repeat origin across tasks is the strongest
 * residual attack in this design, buying the ranking for a query the owner will plausibly run, and
 * a repeat is only visible if each occurrence is on a row somebody can go back to. The warning
 * event records the transition; this records which card the owner was standing in front of.
 *
 * The newest source rather than the first, for the same reason the taint keeps the newest eight: it
 * is the arrival that raised the floor this card is standing on, not the eight ordinary pages read
 * before it.
 *
 * Deliberately absent rather than a placeholder on a clean turn. "Raised while untrusted content
 * was in the room" and "raised on the owner's own work" are different facts, and a column where
 * every row says something makes them indistinguishable.
 */
export const approvalOrigin = (state?: Pick<AgentState, 'taint'>): string | undefined =>
  state?.taint?.sources.at(-1);

/**
 * What the owner is told when they stop a conversation, and what became of its background work.
 *
 * The second sentence is the runner's, used exactly as it was given. A declared service is meant to
 * outlive the task that started it, so cancelling deliberately leaves it serving - and the runner
 * writes that exemption out itself precisely so this side cannot phrase it wrongly. An owner told
 * only "cancelled" reads it as everything having stopped, closes the tab on a dashboard that is
 * still up, and wonders why a port they thought they had freed is busy.
 *
 * Nothing is added when the runner did not answer: a computer that is not talking is one of the
 * reasons somebody presses Stop, and a guess about what is still running is worse than silence.
 */
export const cancelConfirmation = (note?: string): string =>
  `Task cancelled by user${note ? `. ${note}` : ''}`;

export const HOST_DISK_FULL_CHECKPOINT_CODE = 'checkpoint_host_disk_full';

/**
 * The workspace the runner will not checkpoint automatically because it holds too many files.
 *
 * The second of the two, and the one the prose fallback below never matched: an owner with two
 * `node_modules` trees crossed the runner's file ceiling, lost every automatic undo point from then
 * on, and was told by the rewind dialog that the turn "changed nothing on the computer" about turns
 * that changed a great deal. It is owner-fixable in the plainest way - delete something, or take a
 * named recovery point - which is exactly why it has to reach them.
 */
export const WORKSPACE_TOO_LARGE_CHECKPOINT_CODE = 'checkpoint_workspace_too_large';

/**
 * The refusal codes above that name something the owner can clear.
 *
 * A set rather than a comparison because the runner has more than one such refusal, and will have
 * more again. `runner_request_failed` is deliberately not here - it is the code every refusal that
 * is not specially named carries, so treating it as owner-fixable would put the loudest card in the
 * transcript in front of somebody who can do nothing about it.
 */
const OWNER_FIXABLE_CHECKPOINT_CODES = new Set([
  HOST_DISK_FULL_CHECKPOINT_CODE,
  WORKSPACE_TOO_LARGE_CHECKPOINT_CODE
]);

/**
 * The runner's code, dug out of the sentence it was flattened into.
 *
 * `AgentRunnerClient.checkpoint` used to be the one runner call in this package that did not build
 * its error through `runnerFailure` - it threw `Checkpoint failed (<status>): <body>` with the
 * runner's own `{error:{code,message,…}}` envelope flattened into the sentence, so the code was
 * present on the wire and thrown away by the client rather than by the runner. That half is now
 * fixed and the code arrives as an `AthanorError` field.
 *
 * This stays as the fallback, for the same reason the prose regex below does: a worker is routinely
 * a release ahead of the box it talks to, and a runner that still flattens is still readable.
 */
const checkpointRefusalCode = (message: string): string | undefined => {
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  try {
    const envelope = JSON.parse(message.slice(start)) as { error?: { code?: unknown } };
    const code = envelope.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

export const ownerFixableCheckpointFailure = (
  message: string,
  failure?: { code?: string }
): boolean =>
  OWNER_FIXABLE_CHECKPOINT_CODES.has(failure?.code ?? checkpointRefusalCode(message) ?? '') ||
  // The fallback, and it stays. The code only exists in the runner from this release on, a worker
  // is routinely a version ahead of the box it talks to, and reading a sentence is the wrong way
  // round only while there is a better way round available.
  /disk is too full|no space left|ENOSPC|storage is full|quota exceeded/i.test(message);

/**
 * A rejected finish is worth retrying: models usually cite the wrong id or omit `source`, and the
 * corrected call lands on the next attempt. Retrying without bound is not - each attempt is a
 * billed model call against a full context, so an ungroundable completion used to burn the entire
 * step budget and then fail with a generic step-limit error that told the user nothing.
 */
export const MAX_FINISH_REJECTIONS = 3;

/**
 * How many times the harness refuses a finish because the model's own acceptance checks failed.
 *
 * Bounded for the same reason the rejection above is: each attempt is a billed model call against a
 * full window, and a task that cannot pass its own definition of done four times running is not one
 * step from passing it. Past the ceiling the turn ends and the failing checks are carried out as
 * remaining risks, in the completion the owner reads - which is a truthful unfinished job rather
 * than an endless loop or a false success.
 */
export const MAX_ACCEPTANCE_FAILURES = 4;

/**
 * How many all-passing declarations a turn may make before the harness stops arguing: at two, the
 * first is sent back and the second is taken with a caveat.
 *
 * The harness runs the checks the moment they are declared, against the job as it stands. A record
 * whose every check passes at that point says nothing about the work: `echo done`, `ls`, a file that
 * is already there - each of them is the model asserting its own success in a form the harness can
 * execute, which is the one thing this whole mechanism exists to refuse. Sent back with what the
 * harness saw, so the correction is a check that can fail rather than a rewording.
 *
 * Bounded like every other refusal in this loop. Past the ceiling the record is taken anyway and
 * the completion the owner reads says the checks never failed - a caveat they can act on, rather
 * than a turn that spends its budget arguing about its own test.
 */
export const MAX_ACCEPTANCE_BASELINE_REFUSALS = 2;

/**
 * The ceiling on one check while the harness is only asking whether it already passes.
 *
 * The finish-time run gets the full fifteen minutes because a real suite takes that long and its
 * answer decides whether the turn completes. The baseline is asking a much smaller question, before
 * any work exists to be proven, and a check still running after two minutes has not answered it
 * "yes" - so it counts as failing now, which is the permissive reading and the honest one.
 *
 * It is also what bounds the price of asking: eight checks at this ceiling is the worst a single
 * declaration can cost, and in practice the check that proves new work fails in the first second
 * because the thing it names does not exist yet.
 */
export const ACCEPTANCE_BASELINE_TIMEOUT_SECONDS = 120;

/** What the window is told when the harness ran the checks first and they cannot fail. */
export const acceptanceBaselineRefusal = (
  results: readonly AcceptanceResult[],
  attempt: number,
  ceiling: number
): string =>
  [
    `Acceptance record refused (${attempt} of ${ceiling}): the harness ran all ${results.length} of these against the job as it stands right now, before the work, and every one of them already passes.`,
    ...results.map((result) => `- ${result.id} (${result.label}): ${result.detail}`),
    'A check that passes on the unfinished job cannot tell it apart from the finished one. Name at least one that fails right now and will pass when the work is right: the test that does not exist yet, the file that is not there, the figure that does not reconcile. Keep an already-passing check alongside it when it guards against breaking something that works.'
  ].join('\n');

/** What the window is told when the baseline did its job, so the model knows which check is the proof. */
export const acceptanceBaselineNote = (results: readonly AcceptanceResult[]): string => {
  const failing = results.filter((result) => !result.passed);
  const passing = results.filter((result) => result.passed);
  return [
    `Baseline, run by the harness before the work: ${failing.map((result) => result.id).join(', ')} ${failing.length === 1 ? 'fails' : 'fail'} now, which is what will make passing at finish mean something.`,
    passing.length
      ? `${passing.map((result) => result.id).join(', ')} already ${passing.length === 1 ? 'passes' : 'pass'}, so ${passing.length === 1 ? 'it guards' : 'they guard'} what already works rather than proving the new work.`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
};

/**
 * Why passing the checks proves less than it looks, in the two cases where it does.
 *
 * Both of these are facts about the checks: they were green before anybody started, or they belong
 * to work an earlier turn did. The owner can act on either one by reading the tick differently.
 *
 * A third line stood here saying the checks had been written after the work rather than before it,
 * and it went. It was not a fact about the checks but a description of the order this box runs its
 * own steps in - the hold on finish is the only thing that ever asks for a record, and that hold
 * fires because something has already changed, so the sentence was printed on very nearly every
 * completed task. The owner read it at the end of a finished job and asked what it meant, which is
 * the answer: it was the machinery talking about itself in the one place that should say only what
 * was done.
 */
export const ACCEPTANCE_ALREADY_PASSED_CAVEAT =
  'These checks were already passing before this job started, so passing them says nothing about it.';
export const ACCEPTANCE_EARLIER_TURN_CAVEAT =
  'These checks come from earlier work: they show nothing broke, not that this is right.';

/**
 * The one caveat that belongs beside the tick rather than behind the disclosure.
 *
 * Everything else about how the checks were made is detail for the owner who opens the receipt.
 * This one is different in kind: "all passed" over checks that were passing before anybody started
 * is a sentence that says the opposite of what happened, and a reader who never opens the
 * disclosure has been told something untrue. The rest qualify the evidence; this one corrects it.
 */
export const CAVEAT_BESIDE_THE_TICK: ReadonlySet<string> = new Set([
  ACCEPTANCE_ALREADY_PASSED_CAVEAT
]);

/**
 * How many prose-only replies to accept before giving up on the model calling finish. Slightly more
 * generous than the rejection bound because a model that has genuinely more work to do sometimes
 * narrates a step before acting, and cutting that off at three would end real work early.
 */
export const MAX_COMPLETION_NAGS = 5;

/**
 * Tools the loop answers out of its own state, ahead of the line that records a tool as started.
 *
 * None of these reaches the workspace, the network or the model provider, so none of them is
 * evidence that a step did anything - and every one of them already carries its own bound:
 * `finish` has `MAX_FINISH_REJECTIONS`, `notify` has `MAX_NOTICES_PER_TURN`, `ask` parks the turn,
 * `set_acceptance` has `acceptanceBaselineRefusals`, `compact_context` rewrites the window it is
 * called from. A step whose whole output is one of these is therefore left alone by the guard
 * below rather than counted twice by two bounds that would then race each other.
 */
const LOOP_ANSWERED_TOOLS: ReadonlySet<string> = new Set([
  'finish',
  'compact_context',
  'notify',
  'ask',
  'set_acceptance'
]);

/**
 * How many steps in a row may start no tool before the loop says so in as many words.
 *
 * The completion nag above is the same failure seen from one side only: it counts replies that
 * carried *no tool call at all*, and it is reset by any call in the response - including the ones
 * the loop answers instead of running. That reset is the hole. Measured on the owner's box: a
 * fourteen-minute, twelve-call turn on a cheap route that produced a thousand streamed frames, five
 * consolidated replies and no progress, re-deciding one question in fresh words each time. The
 * repetition watch could not see it, because nothing was repeated verbatim; the nag could not see
 * it, because every second step proposed something and zeroed the counter.
 *
 * So the count here is of steps that *started* something, which is the only fact in the loop that
 * cannot be produced by talking. Three. Two consecutive steps with nothing running is an ordinary
 * correction - a read answered from an earlier one, a call re-issued after its arguments were cut
 * off - and the third is the point at which the turn is no longer converging on anything.
 *
 * What it must never do is interrupt a turn that is thinking hard and still moving. It cannot: a
 * single tool starting anywhere in a step resets it to zero, so the length of the reasoning, the
 * effort level, the size of the window and the number of steps are all irrelevant to it. Nor does a
 * step that asked for nothing move it - that is the nag's, and counting it here as well made two
 * steps of ordinary reasoning into two thirds of a break. See the branch that used to.
 */
export const MAX_IDLE_STEPS = 3;

/**
 * How many before the turn is ended rather than pushed back on. Twice the first number, deliberately:
 * the model is told, told again with the count risen, and told a third time before anything stops -
 * so a turn only ends here having been given the two exits three times and taken neither.
 */
export const IDLE_STEPS_BEFORE_STOP = MAX_IDLE_STEPS * 2;

/**
 * What this step did, in the only two terms the guard reads, and what the count becomes.
 *
 * `undefined` means leave the count where it is: the step asked for nothing the loop could have
 * started, so it is the nag's business or a bookkeeping tool's own bound, not this one's.
 */
export const idleStepsAfter = (
  previous: number,
  step: { proposed: readonly string[]; started: number }
): number | undefined => {
  if (!step.proposed.some((name) => !LOOP_ANSWERED_TOOLS.has(name))) return undefined;
  return step.started > 0 ? 0 : previous + 1;
};

/**
 * What the model is told when the count runs out. Not a scolding and not a stop: it names the
 * number, says which of the two exits to take, and rules out the third thing it has been doing.
 */
export const idleStepBreak = (steps: number): string =>
  `NOTHING HAS RUN FOR ${steps} STEPS. Every tool you asked for in that time was answered from what this turn already has - a repeat of a call already made, or a call that could not be run - so the work has not moved since. Deciding again in different words will not move it either. Do one of two things now: take the next concrete action, with arguments that differ from anything already tried, or call finish and say plainly what you are stuck on and what you would need to get past it.`;

/**
 * How many times one call may fail in exactly the same way before the loop says so.
 *
 * The last shape in this file that nothing counted. A tool that fails is written to the timeline,
 * answered into the window and charged for its addresses, and then forgotten: nothing accumulates,
 * so a tool failing the same way twenty times running is twenty separate surprises, each one
 * answered, paid for and dropped. Neither of the two watches that exist can see it. The repetition
 * watch reads the model's own text, and the text around a retry is different every time - often
 * better every time, which is what a model does when it is sure the next attempt will work. The
 * idle guard reads whether a tool started, and a call that starts, runs and throws has started one,
 * which is precisely what resets it.
 *
 * Three, matching the idle guard, and for the same reason. Two identical failures is an ordinary
 * correction - a command re-run after the service it needs was started, a patch re-sent after the
 * file was re-read - and the third is the point at which the retry has stopped being a correction
 * and become the plan. Every attempt past it costs a full step and a full model call, which is what
 * makes this the most expensive failure shape there is.
 *
 * What it would not have caught, said plainly, because it was the turn that prompted it: the
 * seventy-two-call turn on the owner's box that spent $3.78 while ignoring an instruction to stop
 * was making progress by every measure the loop has. Its calls succeeded. Nothing below would have
 * touched it, and a bound that claimed otherwise would be athanor asserting something it cannot
 * see. That turn needs a different bound; this one is for the retry that cannot work.
 */
export const MAX_REPEATED_FAILURES = 3;

/**
 * How many before the turn is ended rather than pushed back on. Twice the first number, exactly as
 * the idle guard does it: told, told again with the count risen, told a third time, and only then
 * stopped - so nothing ends here without the model having been given both exits three times.
 */
export const REPEATED_FAILURES_BEFORE_STOP = MAX_REPEATED_FAILURES * 2;

/**
 * How many separate failing calls one turn keeps a count for.
 *
 * The counts live in the encrypted task state, which is written on every step, so this is a size
 * bound on that write rather than a judgement: sixteen distinct calls each failing in their own way
 * is already a turn in trouble, and the ones dropped are the ones the turn has stopped returning
 * to.
 */
const TRACKED_FAILING_CALLS = 16;

/**
 * The failure as its kind rather than its wording, for deciding whether two of them are one.
 *
 * The wording carries the parts that legitimately move between two attempts at the same thing - a
 * duration, a byte count, a request id - and two attempts differing only in those are the same
 * attempt. `AthanorError` already publishes the kind as its code, which is the runner's own reason
 * for refusing; everything else is reduced to its shape.
 *
 * Not `failureClass` in failure-record.ts, which answers a different question for the journal: that
 * one is about what may be written to an unencrypted line on the owner's box, and it deliberately
 * drops the message entirely. This one needs the message, because on a plain `Error` the message is
 * the only thing that distinguishes one failure from another - and it never leaves the encrypted
 * state.
 */
export const failureSignature = (error: unknown): string =>
  error instanceof AthanorError
    ? error.code
    : (error instanceof Error ? error.message : 'tool failed')
        .toLowerCase()
        .replace(/[0-9a-f]{8,}/g, '#')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

/**
 * The call a repeat is counted against: the tool and its exact arguments.
 *
 * Hashed, and this is the reason. The arguments to a `file_write` are a whole file of the owner's
 * writing and the arguments to a `shell` are their command line, and the count outlives the call by
 * design - so what is kept is sixteen bytes that prove two calls were identical and say nothing
 * whatever about what they were.
 */
export const failingCallKey = (call: {
  name: string;
  arguments: Record<string, unknown>;
}): string => `${call.name}:${sha256(canonicalJson(call.arguments)).slice(0, 16)}`;

/**
 * That call failing that way, which is the thing counted, and the whole decision of this guard.
 *
 * The arguments are in the key and the error is not enough on its own, which is the opposite of the
 * obvious reading, so here is the case against it. Same error across *different* arguments is what
 * a search looks like from outside: four candidate paths for a config file, three mirrors of a
 * package index, a walk down a list of ports. Every one of those misses rules something out, so a
 * guard keyed on the error alone interrupts work that is converging - and being wrong in that
 * direction costs the owner a turn that was going to succeed. Same arguments *and* same error is
 * the opposite kind of fact: the call produced the identical bytes it produced last time, so
 * whatever happened in between - a read, a fix, an install, a whole step of reasoning - provably
 * did not touch the thing that is failing. It is the one statement here that a model cannot talk
 * its way out of, and it is why the reset needs no cleverness at all: an attempt that succeeds, or
 * that fails differently, clears the count by being different.
 *
 * It also settles the case the owner's own work is made of. A test that fails, is fixed and passes
 * is never seen by any of this: a command with a non-zero exit is a tool *result*, the call ran and
 * returned what the runner said, and only a call that threw reaches the counter at all.
 */
export const repeatedFailureKey = (
  call: { name: string; arguments: Record<string, unknown> },
  error: unknown
): string => `${failingCallKey(call)}:${sha256(failureSignature(error)).slice(0, 16)}`;

/**
 * The counts after one call was answered: `failure` is its key when it threw, and null when it
 * returned anything at all.
 *
 * Everything already counted for this call is dropped whichever way it went, so a success clears
 * it and a different error replaces it rather than adding to it.
 */
export const repeatedFailuresAfter = (
  previous: Readonly<Record<string, number>> | undefined,
  outcome: { call: string; failure: string | null }
): Record<string, number> => {
  const others = Object.entries(previous ?? {}).filter(
    ([key]) => !key.startsWith(`${outcome.call}:`)
  );
  if (!outcome.failure) return Object.fromEntries(others);
  // Appended rather than left in place, so the cap drops the calls the turn stopped retrying
  // longest ago rather than whichever happened to be inserted first.
  return Object.fromEntries(
    [...others, [outcome.failure, (previous?.[outcome.failure] ?? 0) + 1] as const].slice(
      -TRACKED_FAILING_CALLS
    )
  );
};

/**
 * The worst count this step actually moved, and which tool it belongs to.
 *
 * Read as a difference across the step rather than as the highest count standing, because a call
 * that failed three times and was then left alone still has its three: judged on the standing
 * maximum the loop would push the same sentence back on every step afterwards, about something the
 * model has already stopped doing.
 */
export const repeatedFailureRise = (
  before: Readonly<Record<string, number>> | undefined,
  after: Readonly<Record<string, number>> | undefined
): { tool: string; count: number } | null => {
  let worst: { tool: string; count: number } | null = null;
  for (const [key, count] of Object.entries(after ?? {})) {
    if (count <= (before?.[key] ?? 0) || count <= (worst?.count ?? 0)) continue;
    worst = { tool: key.split(':')[0] ?? 'that call', count };
  }
  return worst;
};

/**
 * What the model is told when the count runs out. The idle guard's shape: the number it has
 * reached, the fact underneath it, and the two ways out named before anything ends.
 */
export const repeatedFailureBreak = (count: number, tool: string): string =>
  `THE SAME CALL HAS FAILED ${count} TIMES RUNNING. Each of those was ${tool} with byte-identical arguments, and each came back with the same error, so nothing that happened in between changed what is failing - asking again will cost another step and return that error again. Do one of two things now: take a different action - different arguments, a look at why it is failing, or starting whatever it depends on first - or call finish and say plainly what is broken and what you would need to get past it.`;

/**
 * How many cut-off tool calls one turn answers before it tells the model to stop trying.
 *
 * A truncated call is the model asking for more output than the cap allows, so the same call
 * re-proposed is the same length: without a bound the turn burns its whole step budget on one
 * oversized write. Three is enough to let a model that shortens its payload succeed.
 */
export const MAX_ARGUMENT_TRUNCATIONS = 3;

/**
 * How many times one turn may interrupt the owner.
 *
 * A notice is an interruption on a device the owner is not looking at, so the bound is on the
 * harness rather than on the model's judgement: three is enough for the honest case - the thing
 * happened, and then it turned out to be worse than it looked - and past that it is a stream, which
 * belongs in the conversation the owner opens rather than on their lock screen.
 */
export const MAX_NOTICES_PER_TURN = 3;

/**
 * How many times one turn may stop and ask the owner something.
 *
 * The bound is on the harness rather than on the model's judgement, for the same reason the notice
 * bound is: a question parks the conversation and rings a device, and the failure mode this tool
 * creates is an agent that asks instead of working. Two, not one, because the answer to a question
 * is consumed back into the *same* turn - so a single budget covers the whole exchange, and one
 * genuine second blocker uncovered by the first answer is a real thing that happens. Past that it is
 * a dialogue, and a dialogue belongs in the reply the owner reads when they open the conversation.
 * A reply from the owner that ends the turn starts the count again from zero, like every other
 * per-turn ceiling in this file.
 */
export const MAX_QUESTIONS_PER_TURN = 2;

/**
 * How many times a reply cut off at the output limit is continued before the answer has to change
 * shape instead.
 *
 * A long answer legitimately needs a second or third pass - the limit is a per-response ceiling,
 * not a judgement about the work. But a model that hits it four times running is producing prose
 * the chat window was never the right container for, and every further continuation is another
 * billed call against a full window. At that point the remainder belongs in a file.
 */
export const MAX_TRUNCATED_CONTINUATIONS = 3;

/**
 * How many times a turn may condense itself because the route refused its window as too large.
 *
 * Two, because the first repair is aimed at a number this side had never been told before - the
 * ceiling the endpoint that answered actually enforces, which is not the one the catalogue
 * published for the model - and one further attempt covers a window that was so far over that a
 * single condensation still left it too big. A third would be condensing away the owner's
 * transcript to make room for a request that is failing for some other reason, and the honest
 * answer at that point is to say so and stop rather than to keep spending.
 */
export const MAX_CONTEXT_OVERFLOW_REPAIRS = 2;

/**
 * The smallest window a vision specialist may have.
 *
 * One system line, one instruction and one image: the ask is tiny, and the ranker needs a number
 * rather than a zero because `minContextTokens` is also what the price tiers are evaluated at.
 * Small enough that it excludes nothing a provider still serves.
 */
export const VISION_SPECIALIST_MIN_CONTEXT_TOKENS = 8_000;

/**
 * How many vision specialists an image is offered to before the model is told to work from the
 * text. Two: the second covers a route that has gone bad without spending a third billed call on a
 * catalogue that is evidently not describing this box any more.
 */
export const VISION_SPECIALIST_ATTEMPTS = 2;

/**
 * The host package managers athanor's privileged helper can carry out an operation for.
 *
 * `PACKAGE_MANAGERS` in `services/workspace-runner/src/command-policy.ts` is the full list - what
 * counts as installing software on the host, for the approval card and for the desktop refusal -
 * and `PACKAGE_OPERATIONS` in `execution.ts` is the subset the helper has a spelling for. This is
 * exactly that subset's keys. It read "that subset, plus pacman" while pacman's parse lived in a
 * branch of its own and it had no row; it has a row now, so membership is one fact rather than a
 * table and an exception. It is a copy because the worker cannot import the runner, and
 * `scripts/check-repository.mjs` holds the two lists against each other.
 */
export const HELPER_PACKAGE_MANAGERS = new Set([
  'apk',
  'apt',
  'apt-get',
  'aptitude',
  'dnf',
  'dnf5',
  'microdnf',
  'pacman',
  'yum',
  'zypper'
]);

/**
 * Every verb any of those managers spells an update or an install with, in one set.
 *
 * A union rather than a per-manager table, and deliberately: this gate only has to be no narrower
 * than the runner's parse, and a fourteen-way table copied across a package boundary is a fourteen-
 * way opportunity for the two to disagree in the direction that silently withholds a capability.
 */
export const PACKAGE_VERBS = new Set([
  'add',
  'in',
  'install',
  'makecache',
  'ref',
  'refresh',
  'update'
]);

/**
 * When a turn starts being told how much of its step budget is left.
 *
 * A turn that works for hours is bounded by steps long before it is bounded by credits, and until
 * now nothing in the window said so: the model planned as though the budget were endless, then the
 * turn died at the limit with "Task reached the maximum number of agent steps". Two notices fix
 * that - one while there is still time to change course, one when only a handoff still fits.
 *
 * They are appended to the tail rather than inserted into the preamble, so they cost a cached prefix
 * nothing, and they are keyed on the exact step that crosses each line so a step is never billed for
 * a notice it already carries. A compaction that condenses one away is the case where re-emitting it
 * is right, which is why this asks the window rather than a counter.
 */
export const STEP_BUDGET_NOTICE_SHARE = 0.7;
export const STEP_BUDGET_HANDOFF_STEPS = 4;
export const STEP_BUDGET_MARKER = 'STEP BUDGET';
export const STEP_HANDOFF_MARKER = 'FINAL STEPS';

/**
 * The header of the workspace brief block, named because two places have to agree on it: the splice
 * that installs it, and anything measuring where the preamble's one volatile block sits.
 */
export const WORKSPACE_BRIEF_MARKER = 'WORKSPACE BRIEF (user-visible persistent project context)';

/** Every message this loop pushes back for the model to act on, by name. */
export type PushbackName =
  | 'finish_rejected'
  | 'plan_hold'
  | 'acceptance_hold'
  | 'silence_hold'
  | 'acceptance_failed'
  | 'completion_nag'
  | 'baseline_refused'
  | 'repetition_stopped'
  | 'output_limit_continued'
  | 'output_limit_capped'
  | 'reply_cut_off'
  | 'step_budget'
  | 'compute_budget'
  | 'idle_break'
  | 'vision_routed'
  | 'resumed_turn';

/**
 * The string each pushback is recognised by, published from the file that writes them.
 *
 * The eval harness had its own copy of this table, with the comment that it was "the one place this
 * harness is coupled to wording" - so every one of these sentences was a string literal in two
 * files that nothing made agree, and the failure mode of a disagreement is a fixture asserting a
 * hold that silently stopped being observed. Published here so the wording and the watch cannot
 * drift: change a sentence below and the row that matches it is the same edit.
 *
 * Five of them were never watched at all, and they are the five outside the finish and step-budget
 * families: the compute ceiling (which on the measured formula is the ceiling a frontier model
 * actually reaches, far short of the step one), both halves of the output limit, the vision
 * specialist's handoff, and the note a turn resuming a step-limited one opens with.
 *
 * Two entries share an opening - `plan_hold` is a prefix of `acceptance_hold` and `silence_hold` -
 * so a matcher must try the longest marker first. `holdsIn` in the harness sorts by length for
 * exactly this reason; anything else reading this table has to do the same.
 */
export const PUSHBACK_MARKERS: ReadonlyArray<readonly [PushbackName, string]> = [
  // The completion contract, in `#runTurn`'s finish branch.
  ['finish_rejected', 'Finish rejected (attempt'],
  ['plan_hold', 'Finish held: '],
  ['acceptance_hold', 'Finish held: this turn changed'],
  ['silence_hold', 'Finish held: this turn has not said'],
  // `acceptanceFailureMessage` and `acceptanceBaselineRefusal`, in acceptance.ts.
  ['acceptance_failed', 'Finish refused (acceptance '],
  ['baseline_refused', 'every one of them already passes'],
  ['completion_nag', 'COMPLETION CHECK ('],
  // The two generation watches: repetition abort, and the output-limit continuation and its cap.
  ['repetition_stopped', 'began repeating'],
  ['output_limit_continued', 'CONTINUE THE ANSWER ('],
  ['output_limit_capped', 'OUTPUT LIMIT REACHED'],
  ['reply_cut_off', 'YOUR REPLY WAS CUT OFF'],
  // The two ceilings, from the same template in `#runHandoffCall`, and `stepLimitCarryOver`.
  ['step_budget', 'STEP BUDGET EXHAUSTED'],
  ['compute_budget', 'COMPUTE BUDGET EXHAUSTED'],
  ['resumed_turn', 'PREVIOUS TURN STOPPED AT ITS STEP LIMIT'],
  ['idle_break', 'NOTHING HAS RUN FOR'],
  // The lead's window being handed an observation it could not make itself. The failure notice
  // beside it ("VISION ROUTING NOTICE") is deliberately not here: it says routing was attempted and
  // did not happen, which is the opposite of what a fixture asserting this would mean by it.
  ['vision_routed', 'VISION SPECIALIST HANDOFF']
];

/**
 * What the turn that resumes a step-limited one is told, written into the saved window because that
 * is the one place the next turn is guaranteed to read. Without it the next turn arrived knowing
 * only that there was a conversation, so it re-read - and sometimes re-did - work already finished.
 */
export const stepLimitCarryOver = (steps: number, stillOpen: readonly string[]): string =>
  `PREVIOUS TURN STOPPED AT ITS STEP LIMIT after ${steps} steps, with work still outstanding. Nothing it produced was rolled back. Before acting, read the newest plan and the running brief, establish what is already done, and continue from the first step that is not complete - do not restart finished work.${
    stillOpen.length ? `\nStill open: ${stillOpen.slice(0, 10).join('; ')}` : ''
  }`;

export const stepBudgetNotice = (step: number, maxSteps: number): string | null => {
  const remaining = maxSteps - step;
  // A budget too small for two distinct notices gets the one that matters.
  if (remaining <= STEP_BUDGET_HANDOFF_STEPS)
    return `${STEP_HANDOFF_MARKER}: ${remaining} of this turn's ${maxSteps} steps remain, and a step is one model call however many tools it uses. Stop starting new work. Save anything unfinished to a workspace file, publish what is finished, mark the plan honestly, and call finish describing what is done and what is not. Work left after that is not lost - the user can reply and you continue on this same computer with a fresh budget.`;
  if (remaining === maxSteps - Math.floor(maxSteps * STEP_BUDGET_NOTICE_SHARE))
    return `${STEP_BUDGET_MARKER}: ${step} of this turn's ${maxSteps} steps are used and ${remaining} remain. Judge whether the rest of the job fits. If it does not, finish the most valuable part properly rather than leaving several things half-done, keep the plan's statuses true, and say plainly in your reply what remains.`;
  return null;
};

/**
 * Past this step of a turn, the work is integration rather than orientation.
 *
 * Per-step accuracy falls with step count on long tasks, and the measured cause is self-conditioning
 * on the model's own earlier errors; raising the thinking budget is the intervention that mitigates
 * it. Twenty is where a turn stops being "look at the request and start" and becomes "hold what has
 * already happened in mind and decide what to change".
 */
export const LATE_STEP_EFFORT_FLOOR = 20;
/** The share of the input budget past which no step is a cheap one, whatever it just did. */
export const CONTEXT_EFFORT_FLOOR_SHARE = 0.5;

/**
 * How hard the model should think about this particular step.
 *
 * This used to key off `REPEATABLE_TOOLS`, and that set is documented in its own comment as a
 * replay-safety set: tools whose second run after a restart cannot surprise anyone. Replay safety
 * and cognitive difficulty are unrelated, and for the read tools they are close to inverted. The
 * set contains file_read, document_read, image_read, parallel_web_read, web_search, code_search
 * and repo_overview - every one of which returns material the model then has to reason hard about,
 * and every one of which dropped the next step to 'low'. The step after an 18,000-character CSV
 * landed in the window was the cheapest step in the task.
 *
 * It now ratchets in one direction only. A turn opens at 'high' because that is where the request
 * is read and the approach chosen, settles to 'medium' for ordinary progress, and rises back to
 * 'high' - permanently, for the rest of the turn - on any evidence that this turn has become hard:
 * something failed, a finish was refused, the window was just compacted, the trajectory is long, or
 * the context is over half the input budget. Two consequences, both wanted. The model thinks most
 * where the measured failures are. And `reasoning` becomes a nearly byte-stable request field
 * instead of flipping ten times in twenty-three steps, each flip discarding the provider's cached
 * trajectory below the system prefix.
 */
interface EffortState {
  step: number;
  messages: ModelMessage[];
  planVersion?: number;
  finishRejections?: number;
  completionNags?: number;
  acceptanceFailures?: number;
  reasoningFloor?: 'medium' | 'high';
  compactedAtStep?: number;
  estimatedInputTokens?: number;
  inputBudgetTokens?: number;
}

/**
 * Whether this step's `high` is evidence about the *work* rather than about one call going wrong.
 *
 * Only these conditions may pin the floor for the rest of the turn. The distinction was missing and
 * it is expensive: `Tool failed:` is written when a tool *threw* - the runner briefly unreachable,
 * a socket closed - and on a measured run one such shell call on step 4 pinned every one of the
 * sixteen remaining steps to maximum reasoning on a task whose entire output was two lines of
 * verse. That is a fact about the network. The step after it is still worth thinking about, and it
 * still gets `high` below; what it no longer does is decide that the turn is hard for ever.
 *
 * The conditions kept here are all statements about the turn itself: the harness refused a finish,
 * an acceptance check failed, the window was just compacted and the model is working from a summary
 * of its own work, the turn has run long, or the context is over half the input budget.
 */
export const effortFloorEarned = (state: EffortState): boolean =>
  Boolean(state.finishRejections || state.completionNags || state.acceptanceFailures) ||
  state.step >= LATE_STEP_EFFORT_FLOOR ||
  // The step immediately after a compaction is the one most likely to make a wrong call: the model
  // has just lost the detail it was working from and is holding a summary of its own work instead.
  (state.compactedAtStep !== undefined && state.step - state.compactedAtStep <= 1) ||
  (state.estimatedInputTokens !== undefined &&
    state.inputBudgetTokens !== undefined &&
    state.estimatedInputTokens > state.inputBudgetTokens * CONTEXT_EFFORT_FLOOR_SHARE);

export const reasoningEffortForStep = (state: EffortState): 'medium' | 'high' => {
  if (state.step === 0) return 'high';
  if (state.reasoningFloor === 'high') return 'high';
  if (effortFloorEarned(state)) return 'high';
  let lastAssistant = -1;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]?.role === 'assistant') {
      lastAssistant = index;
      break;
    }
  }
  const results = state.messages
    .slice(lastAssistant + 1)
    .filter((message) => message.role === 'tool');
  if (
    results.some((result) =>
      /^(Tool failed|Refused|Interrupted|Finish rejected|Skipped)/.test(result.content)
    )
  )
    return 'high';
  return 'medium';
};

const money = (value: number): string =>
  value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

const windowLabel = (name: string): string =>
  ({ task: 'this task', daily: 'today', monthly: 'this month' })[name] ?? name;

/**
 * Says what was spent, against what, and in which window. A ceiling the owner cannot see themselves
 * approaching reads as a random interruption, so the number and the limit both belong in the line
 * the interface shows.
 */
export const spendHalt = (decision: SpendDecision): string => {
  const blocked = decision.windows.find((window) => window.name === decision.blockedBy);
  if (!blocked?.capUsd)
    return `Paused: this task would go over its spending limit. ${decision.reason ?? ''}`.trim();
  return `Paused at ${money(blocked.spentUsd)} of the ${money(blocked.capUsd)} limit for ${windowLabel(blocked.name)}. Raise the limit to carry on, or leave it here.`;
};

export const spendWarning = (decision: SpendDecision): string => {
  const near = decision.windows.find((window) => decision.warnedBy.includes(window.name));
  if (!near?.capUsd) return 'Approaching a spending limit.';
  return `${money(near.spentUsd)} of the ${money(near.capUsd)} limit for ${windowLabel(near.name)} has been spent.`;
};

/**
 * How many steps an isolated specialist gets.
 *
 * Six is a lookup, not a research pass: a specialist that has to search, read four primary sources
 * and reconcile them spends its whole budget on the search. Sixteen is what "read these fifteen
 * sources and tell me where they disagree" actually costs, and it is still bounded by the credit
 * share above, which is the bound that matters to the owner's bill.
 */
export const DELEGATE_MAX_STEPS = 16;
