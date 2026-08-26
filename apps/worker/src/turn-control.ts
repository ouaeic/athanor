/**
 * The two questions a turn asks between steps: has the owner said something, and is this run still
 * the one in charge?
 *
 * Lifted out of `AgentWorker.run` in Wave 7.2 carrying #140 (rel F10). `honorUserControl` read
 * status alone, so it could see a Stop and could not see a task that had been resumed out from
 * under this worker - and it is called at every step boundary and inside the per-tool-call loop,
 * which is exactly where the gap between two model calls lives. A worker that had lost its lease
 * went on executing the whole tool batch against a workspace another worker was now running; its
 * lease-guarded writes matched no rows, its timeline events are not lease-guarded and did, and the
 * conversation gained a second copy of the batch.
 */
import { decryptJson, encryptJson } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import type { Logger } from './log.js';
import type { AgentRunnerClient } from './runner-client.js';
import { event } from './tool-recording.js';
import { cancelConfirmation } from './turn-bounds.js';
import { haltReason, sealUnansweredToolCalls } from './turn-lifecycle.js';

/** What the between-steps questions need from the worker that owns the turn. */
export interface TurnControlDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly runner: AgentRunnerClient;
  readonly logger: Logger;
  checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void>;
}

/**
 * Takes a correction the owner sent while this turn was running, at a step boundary.
 *
 * Until this existed a message sent to a working task could only wait for it to stop: if the
 * agent had misread the request or was heading somewhere visibly wrong, the choice was to watch
 * it finish or cancel and lose the work. The turn is kept deliberately - everything already
 * done stays in the window, which is the whole point of steering rather than restarting.
 *
 * Only messages the owner marked as a correction are taken this way. An ordinary follow-up
 * still waits, because "do this next" and "no, not that" are different intentions and reading
 * one as the other from timing alone would be wrong half the time.
 */
export const drainCorrection = async (
  deps: TurnControlDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  const queued = await deps.store.getNextQueuedTaskMessage(task.id).catch(() => null);
  if (!queued?.interrupt) return false;
  const correction = decryptJson<{ prompt: string }>(queued.promptCiphertext, key).prompt;
  if (!correction.trim()) return false;
  const consumed = await deps.store.consumeQueuedTaskMessageInTurn({
    taskId: task.id,
    messageId: queued.id,
    workerId: deps.config.WORKER_ID,
    // Without this the loop trips its own ceiling on the next iteration: the message reserved
    // credits of its own, and the turn it is joining was budgeted before they existed.
    additionalComputeCredits: queued.maxComputeCredits,
    ...(queued.maxSpendUsd === null ? {} : { additionalSpendUsd: queued.maxSpendUsd }),
    userMessageCiphertext: encryptJson({ markdown: correction }, key, `task-event:${task.id}`)
  });
  if (!consumed) return false;
  // The same primitive pause, cancel and a worker restart use: a tool call with no result is a
  // malformed window, and the correction arrives between a call and its answer.
  sealUnansweredToolCalls(state.messages, 'the user redirected the task before this call ran');
  // A genuine user message, so it is owner speech everywhere that matters - the taint model,
  // the compaction rule that never paraphrases what the user said, and the transcript.
  state.messages.push({ role: 'user', content: correction });
  // Written immediately: a crash between the store transaction and the next state write would
  // otherwise lose the correction, or replay it.
  await deps.checkpoint(task, key, state);
  await event(deps.store, task, key, 'status', 'Applying your correction to the running task');
  return true;
};

export const honorUserControl = async (
  deps: TurnControlDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  /*
   * Two columns, read three or four times a step, against the whole encrypted trajectory.
   *
   * `status` and `leaseOwner` are precisely and only what `taskClaim` returns, and one of these
   * calls sits inside the per-tool-call loop - so a sixty-step turn made about 210 of them and
   * read roughly 200 MB to answer a question about two strings.
   *
   * The narrow read stayed narrow when the cost was fixed, and the wider question `haltReason`
   * asks was deferred to the work that could change when a turn ends rather than only what it
   * costs to ask. That work is this one, and the arm is directly below.
   */
  const claim = await deps.store.taskClaim(task.id);
  /*
   * The other half, closed.
   *
   * `haltReason` answers the wider question - is this run still the one in charge? - and it was
   * reached only through `startStopWatch`, which is to say only while a model call was in flight.
   * Between the end of one model call and the next, a worker that had lost the task went on
   * executing the whole tool batch against a workspace another worker was now also running: this
   * function returned `false` for it, because status alone cannot see a task that was resumed out
   * from under this run. The pre-condition is cheap - `withPeriodicRenewal` swallows every renewal
   * error, so a few minutes of database trouble during a long `shell` call silently drops a
   * two-minute lease.
   *
   * `disowned` stands the run down in silence, exactly as `stopWatch.halt === 'disowned'` does
   * mid-call: no event, no state write, no lease clear. Every one of those would be this worker
   * writing over the trajectory whoever holds the task is writing now - and timeline events carry
   * no lease guard at all, so the conversation would gain a second copy of the batch.
   */
  if (haltReason(claim, deps.config.WORKER_ID) === 'disowned') return true;
  if (!claim || !['paused', 'cancelled'].includes(claim.status)) return false;
  /*
   * Stopped, but not by this worker's owner-facing run any more.
   *
   * Checked before the notice and before the write, not folded into the guard above, because
   * everything below this line assumes the trajectory in hand is the one on disk. A worker that
   * has lost the task to another claimant would otherwise announce a pause on a conversation
   * somebody else is actively running, save its own stale state over theirs, and - because the
   * write below is deliberately unguarded - clear their lease on the way out, leaving them
   * generating into a task every later write of theirs silently misses.
   */
  if (claim.leaseOwner !== null && claim.leaseOwner !== deps.config.WORKER_ID) return true;
  const latest = claim;
  /*
   * The Stop button reaching the background, which is the other half of ATH-052.
   *
   * Cancelling aborts the runner request in flight. `processes/start` has none - it answered in
   * milliseconds and left its child running for the rest of its hour - so a cancelled task went
   * on writing into the workspace and making requests attributed to this computer while the
   * interface said it had stopped. Nothing in the worker, the API or the runner ended them.
   *
   * Four things about this call are load-bearing:
   *
   * - **The body is `{}` and not omitted.** `AgentRunnerClient.call` picks GET when there is no
   *   body, and this route is a POST.
   * - **It is outside `withRunnerAbort`.** That scope's signal is the one cancellation has just
   *   aborted, and a request made inside it would be killed before it left. Every
   *   `honorUserControl` call site is at a step or tool-batch boundary, outside the scope
   *   `#withCancellationWatch` opens, which is what makes this true - so this must stay here
   *   rather than move inside a watched operation.
   * - **Only on `cancelled`.** A paused task resumes and polls its own sessions; killing them
   *   would turn a pause into a silent loss of the work that was running.
   * - **It cannot fail the cancellation.** A runner that is down is one of the reasons an owner
   *   presses Stop, so the failure is swallowed and the confirmation says only what it knows.
   *
   * The note is the runner's own sentence, used verbatim. A declared service deliberately
   * outlives the task that started it, and the runner writes that exemption out precisely so
   * this side cannot phrase it wrongly - an owner told only "cancelled" reads it as everything
   * having stopped, then wonders why a port they thought they had freed is still busy.
   */
  const stopped =
    latest.status === 'cancelled'
      ? await deps.runner
          .call<{
            stopped: string[];
            services: string[];
            note: string;
          }>(
            task.workspaceId,
            task.id,
            'exec',
            `/v1/workspaces/${task.workspaceId}/processes/stop-owner`,
            {}
          )
          .catch((error: unknown) => {
            deps.logger.warn('task.cancel_background_stop_failed', {
              taskId: task.id,
              class: error instanceof Error ? error.name : 'unknown'
            });
            return null;
          })
      : null;
  await event(
    deps.store,
    task,
    key,
    'status',
    latest.status === 'paused' ? 'Task paused by user' : cancelConfirmation(stopped?.note),
    stopped ? { stoppedProcesses: stopped.stopped.length, services: stopped.services } : undefined
  );
  sealUnansweredToolCalls(
    state.messages,
    latest.status === 'paused'
      ? 'the user paused the task before this call ran'
      : 'the user cancelled the task before this call ran'
  );
  /*
   * Deliberately without `workerId`.
   *
   * Every other write from this worker is guarded by `lease_owner = workerId`, which is right:
   * it stops a worker that lost its lease from writing over whoever holds it now. This one is
   * different. Pausing and cancelling already cleared the lease in the same statement that set
   * the status (`setTaskStatusForUser`, `cancelTaskAndReleaseReservations`), so by the time we
   * get here the guard can never match - and this write is the one that saves the agent state.
   * It matched zero rows every single time, so a paused task quietly lost the work it had done
   * and resumed from the beginning, and nothing said so because `updateTask` returns void.
   *
   * Unguarded is correct here rather than merely convenient: we are reconciling to a status the
   * owner has already set, not competing for the task.
   */
  await deps.store.updateTask({
    id: task.id,
    status: latest.status,
    actualComputeCredits: state.credits,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`),
    clearLease: true
  });
  return true;
};
