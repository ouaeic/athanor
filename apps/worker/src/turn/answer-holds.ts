/**
 * What the harness does about a step that produced words and no calls, and about one that stopped
 * mid-word.
 *
 * Three holds, in the order the model can reach them, all on the same question: this step did not
 * ask for anything, so is the answer finished, cut off, or simply never going to call `finish`?
 *
 *   1. **cut off** - the generation was ended by this side rather than by the model. The owner is
 *      reading half an answer either way; without this they are reading half an answer that
 *      presents itself as a whole one, and the only clue is that it ends mid-sentence.
 *   2. **output limit** - the model stopped at its own ceiling and carrying on could finish the
 *      answer, so it is continued. Bounded, and past the bound it falls through to the third hold
 *      rather than being asked again - which is the repair that mattered: both branches used to
 *      continue, and a model that hit the limit on every reply reached 41 model calls against a
 *      ceiling of 40. It bounded nothing.
 *   3. **no finish** - the answer stands, only the paperwork is missing. Past the bound the turn
 *      completes as interrupted rather than failing: five correct answers were once thrown away
 *      and reported to the owner as a failure because each continuation was another answer without
 *      a `finish`.
 *
 * Lifted out of `AgentWorker.run()` unchanged. It reads the same three worker operations the
 * end-of-step bounds read, so it asks for the same interface rather than a second one.
 */
import type { ModelResponse } from '@athanor/model-gateway';
import type { TaskRecord } from '@athanor/data';
import type { AgentState } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { MAX_COMPLETION_NAGS, MAX_TRUNCATED_CONTINUATIONS } from '../turn-bounds.js';
import type { StepBoundsDeps } from './step-bounds.js';

/**
 * `continue` sends the model round again, `completed` ends the turn, `proceed` means the step has
 * tool calls to run.
 */
export type AnswerHold = 'continue' | 'completed' | 'proceed';

export const resolveAnswerHolds = async (
  deps: StepBoundsDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  step: { response: ModelResponse; assistantText: string }
): Promise<AnswerHold> => {
  const { response, assistantText } = step;
  /*
   * Why the answer stops where it does, when it was this side that stopped it.
   *
   * A generation that went quiet, ran past its deadline or wrote past its ceiling is ended
   * here rather than by the model, and what had arrived is kept. The owner is reading half an
   * answer either way; without this they are reading half an answer that presents itself as a
   * whole one, and the only clue is that it ends mid-sentence.
   *
   * It deliberately does not continue. The gateway has already asked whether carrying on could
   * finish this answer - it watched the rate the words arrived at - and written the verdict
   * into the finish reason: worth continuing arrives as `length` and is continued by the branch
   * below, and everything else arrives as `stop` and falls through to the completion check,
   * which is bounded and ends the turn by completing it. Asking again from here would buy back
   * the ten-minutes-at-a-time this was all built to stop.
   *
   * Only where the step ended in prose. A cut-off step that still assembled a tool call has to
   * be followed immediately by that call's result, so a system message wedged in between would
   * make the next request malformed; that shape is answered by the truncated-arguments path.
   */
  if (response.truncated && response.finishReason !== 'length' && !response.toolCalls.length) {
    await event(deps.store, task, key, 'warning', 'The answer was cut off before it finished', {
      owner: true,
      reason: response.truncated.reason,
      detail: response.truncated.detail,
      characters: assistantText.length
    });
    state.messages.push({
      role: 'system',
      content: `YOUR REPLY WAS CUT OFF: ${response.truncated.detail}. The user has already read what you wrote, so do not repeat or summarise it. Either do one concrete thing that moves the work on, or close in a sentence and call finish.`
    });
  }

  // A reply that stopped at the provider's output ceiling is half a sentence, and it used to be
  // committed as if it were the whole answer: the task completed, the Result card said the work
  // was ready, and the owner's only recourse was to type "continue" and pay for the whole
  // window again. The gateway has always distinguished this from a real stop; the loop simply
  // never read it. Continuing here costs one step and keeps the answer one answer.
  if (response.finishReason === 'length' && !response.toolCalls.length) {
    const truncations = (state.truncatedReplies ?? 0) + 1;
    state.truncatedReplies = truncations;
    const capped = truncations > MAX_TRUNCATED_CONTINUATIONS;
    await event(
      deps.store,
      task,
      key,
      'warning',
      capped
        ? 'The reply reached the model’s output limit again, so it was not continued automatically'
        : 'The reply reached the model’s output limit and is being continued',
      {
        // Only the cap. A reply being continued is the harness doing its job and the owner
        // sees the finished answer either way; a reply that will not be continued any further
        // is an answer they have been handed incomplete.
        ...(capped ? { owner: true } : {}),
        truncated: true,
        characters: assistantText.length,
        continuation: truncations,
        continued: !capped
      }
    );
    state.messages.push({
      role: 'system',
      content: capped
        ? `OUTPUT LIMIT REACHED ${truncations} times in a row. Stop expanding the answer in chat: write what remains to a workspace file, publish it, and reply with a short complete closing message that points at it.`
        : `CONTINUE THE ANSWER (${truncations} of ${MAX_TRUNCATED_CONTINUATIONS}): your previous reply stopped at the model's output limit, mid-sentence, and the user is looking at it. Carry straight on from where it stopped - do not repeat, restart or summarise what you already wrote. Call finish once the answer is complete.`
    });
    /*
     * Past the cap this deliberately does not continue, and the counter deliberately does not
     * reset.
     *
     * The cap used to change only the wording. Both branches continued, and the reset below was
     * skipped by that continue, so a model that hit the output limit on every reply was told to
     * stop expanding the answer and then asked again, and again, until the step budget ran out:
     * measured at 41 model calls against a ceiling of 40. It bounded nothing.
     *
     * Falling through instead puts the step under the completion nag, which is bounded and ends
     * the turn by *completing* rather than by exhausting it - so the answer the owner has
     * already read stands, with the closing instruction in front of the model. That matters
     * more than it used to: a generation this computer cut short now reports the same finish
     * reason whenever carrying on could still finish it, and each of those costs up to the full
     * generation deadline.
     */
    if (!capped) return 'continue';
  } else state.truncatedReplies = 0;

  if (!response.toolCalls.length) {
    /*
     * The idle count is deliberately not touched here, in either direction.
     *
     * A step that asked for nothing is this branch's, and this branch already bounds it: the
     * nag ends the turn at MAX_COMPLETION_NAGS, and it ends it by *completing* - the answer
     * stands, which is the better of the two outcomes whenever the model has actually answered.
     * Raising the idle count here as well put the same step under two bounds, and the second
     * one ends the turn by stopping it. That is the difference that matters: it made
     * "reasoning, reasoning, then a read I already had" - an ordinary shape in a long debugging
     * turn - the third of the three steps that trigger a break, so a turn was told it had
     * stopped moving on the strength of two steps that never asked for anything.
     *
     * It is not reset either. Prose is not evidence that anything ran, and a turn that alternates
     * a paragraph with a call it already has is exactly what the guard below is for; it simply
     * has to reach its number on the steps that asked and got nothing, which is the only claim
     * that guard makes about itself.
     */
    // Same failure shape as a finish that will not ground itself, and it needs the same bound:
    // a model that answers in prose and never calls the tool used to absorb the entire step
    // budget one nag at a time, then fail with a step-limit error that named nothing.
    const nags = (state.completionNags ?? 0) + 1;
    state.completionNags = nags;
    state.repairStep = true;
    if (nags >= MAX_COMPLETION_NAGS) {
      /*
       * The answer stands; only the paperwork is missing.
       *
       * This used to raise, which marks the task FAILED. Observed: asked what the top story on
       * a news site was, the agent searched, opened the page, and wrote the correct headline
       * with its address and its source - five times, because a reply cut off at the output
       * limit is continued and each continuation is another answer without a finish. Five
       * correct answers, thrown away, reported to the owner as a failure.
       *
       * Not calling the tool is a real thing to record, and it is recorded: the turn completes
       * as interrupted, with what is missing written into the caveats the completion card
       * already shows. The bound stays - it is what stops the step budget going on nagging.
       */
      await event(deps.store, task, key, 'warning', 'Answered without calling finish', {
        attempts: nags
      });
      const stillOpen = await deps.outstandingPlanSteps(task, key).catch(() => []);
      await deps.completeTurn(task, key, state, {
        summary:
          assistantText.slice(0, 400) ||
          `Answered after ${state.step} steps without calling finish.`,
        interrupted: true,
        ...(stillOpen.length ? { outstanding: stillOpen } : {}),
        verification: {
          status: 'not_applicable',
          evidence: [],
          remainingRisks: [
            `The agent answered ${nags} times without calling finish, so athanor never checked this against the request. Read the answer before relying on it, or reply to carry on.`
          ]
        }
      });
      return 'completed';
    }
    state.messages.push({
      role: 'system',
      content: `COMPLETION CHECK (${nags} of ${MAX_COMPLETION_NAGS}): A response without the finish tool does not complete the task. Verify the outcome, update any work that is still incomplete, then call finish with evidence. If this was only a conversational answer and no tools were used, use verification status not_applicable.`
    });
    await event(deps.store, task, key, 'status', 'Checking the result before completion', {
      attempt: nags
    });
    return 'continue';
  }
  state.completionNags = 0;
  return 'proceed';
};
