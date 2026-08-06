import { decryptJson, encryptJson, unwrapDataKey } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import { errorFields, type Logger } from './log.js';

/**
 * Naming a conversation after it has said something.
 *
 * A new conversation is filed under the first ten words of the request, because that is all there
 * is at the moment it is created. It is a placeholder and it reads like one: three conversations
 * that begin "Have a look at the build and tell me" are three identical lines in the sidebar. Once
 * the first answer has landed there is enough to name it properly, and this is what does that.
 *
 * Three rules hold it in place, and all three are about not taking something from the owner:
 *
 * - The name is written only while it is still the placeholder. `setGeneratedTaskTitle` is
 *   conditional on that in SQL, so an owner who renames the conversation while the model is
 *   thinking keeps their name and the late answer is dropped.
 * - The conversation is named by the model it already ran on. A cheaper model would be a second
 *   disclosure of the same request to a route the owner did not choose for it; this one has
 *   already seen every word of it.
 * - It is spending, so it goes through the same ceilings everything else does and is recorded in
 *   the same ledger. A box that has reached its cap keeps its placeholders.
 */

/** What a sidebar line can show before it is cut off anyway. */
export const MAX_GENERATED_TITLE_LENGTH = 60;

/**
 * What one title is assumed to cost when it is weighed against the spending caps.
 *
 * A guess, and deliberately a generous one: the real cost arrives with the answer and is what gets
 * recorded. It only has to be large enough that a box sitting exactly on its ceiling stops naming
 * conversations instead of stepping over it.
 */
const TITLE_ESTIMATE_USD = 0.005;

/** How many conversations one sweep names, so a backlog is worked through rather than swallowed. */
const TITLES_PER_SWEEP = 5;

/**
 * How far down the backlog one sweep is willing to look.
 *
 * Wider than it names, because a conversation can be unnameable for a reason that never changes -
 * its own spending ceiling was reached, so paying for a title would step over it - and the backlog
 * is read oldest first. Reading exactly as many as are named would let a handful of those sit at
 * the front forever and starve every conversation behind them.
 */
const BACKLOG_WINDOW = 25;

/**
 * How many times one conversation is asked about before it is left alone.
 *
 * A request the model refuses to name, or one whose answer never parses into a title, would
 * otherwise be paid for on every wake for the life of the process. The placeholder stays, which is
 * exactly what was there before. Only a call that actually reached the provider counts: a
 * conversation passed over because the box was at its ceiling has not been tried, and tomorrow it
 * is nameable again.
 */
const MAX_ATTEMPTS_PER_TASK = 3;

/** Bounds the memory of failed attempts on a box that has been up for months. */
const MAX_TRACKED_ATTEMPTS = 500;

/** How long the titler waits out a provider that just failed, rather than asking it per answer. */
const PROVIDER_COOLDOWN_MS = 5 * 60_000;

/**
 * How long a shutdown gives a naming call that is already in flight.
 *
 * The call is aborted first, and an HTTP client that honours its signal is gone immediately. This
 * bounds the case where it does not: a restart is a restart, and a conversation keeping its
 * placeholder for one more turn is not worth holding the process open for.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/** How much of the request the namer is shown. A title comes from the opening, never the tail. */
const PROMPT_EXCERPT_CHARACTERS = 2_000;

export const TITLE_SYSTEM_PROMPT =
  'You name conversations. Reply with nothing but a title of at most six words saying what the request is about, in the language the request is written in. No quotation marks, no final full stop, no preamble.';

/**
 * Turns whatever the model said into a name, or nothing.
 *
 * Models answer this question with a bare title most of the time and with "Title: …", a quoted
 * string, or a sentence the rest of the time. What cannot be reduced to a plausible line is
 * refused: the placeholder is a poor name, and a paragraph in the sidebar is a worse one.
 */
export const cleanGeneratedTitle = (raw: string): string | null => {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const stripped = firstLine
    .replace(/^(?:title|name)\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  if (stripped.length <= MAX_GENERATED_TITLE_LENGTH) return stripped;
  // Cut at a word boundary when there is one to cut at, so a long name ends on a word rather than
  // mid-syllable. Scripts that do not space their words fall back to the hard limit.
  const cut = stripped.slice(0, MAX_GENERATED_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > MAX_GENERATED_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trim();
};

/** What the provider call has to give back for a title to be written and paid for. */
export interface TitleCompletion {
  readonly text: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly providerRef: string;
  readonly resourceClass: string;
}

export interface TaskTitlerDeps {
  readonly store: DataStore;
  readonly masterKey: Buffer;
  readonly log: Logger;
  /**
   * One naming call on the conversation's own model. Null means this box cannot make it right now
   * - no provider configured, or the model the conversation ran on is no longer in the catalogue -
   * which is a reason to leave the placeholder alone rather than an error to report.
   */
  readonly complete: (input: {
    userId: string;
    modelId: string;
    privacyRoute: string;
    prompt: string;
    /** Aborted when the process is shutting down, so a restart never waits out a provider call. */
    signal?: AbortSignal;
  }) => Promise<TitleCompletion | null>;
}

const recordAttempt = (attempts: Map<string, number>, taskId: string): void => {
  if (attempts.size >= MAX_TRACKED_ATTEMPTS) attempts.clear();
  attempts.set(taskId, (attempts.get(taskId) ?? 0) + 1);
};

/**
 * Names one conversation, and answers whether it was named.
 *
 * Every failure is contained here: a workspace whose key will not unwrap, a prompt sealed under a
 * context that does not match, a provider that refuses. None of them is worth failing a sweep
 * over, and none of them costs the owner anything except a name they can still write themselves.
 */
const titleOneTask = async (
  deps: TaskTitlerDeps,
  task: TaskRecord,
  signal?: AbortSignal
): Promise<'named' | 'not_now' | 'unusable' | 'provider_failed'> => {
  const workspace = await deps.store.getWorkspaceById(task.workspaceId);
  if (!workspace?.wrappedKey) return 'not_now';
  const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
  if (task.promptCiphertext.aad !== `task-prompt:${workspace.id}`) return 'unusable';
  const prompt = decryptJson<{ prompt: string }>(task.promptCiphertext, key).prompt;
  if (!prompt.trim()) return 'unusable';

  const decision = await deps.store.spendGuard({
    userId: task.userId,
    taskId: task.id,
    estimateUsd: TITLE_ESTIMATE_USD
  });
  if (decision.outcome === 'deny') return 'not_now';

  const completion = await deps.complete({
    userId: task.userId,
    modelId: task.modelId,
    privacyRoute: task.privacyRoute,
    prompt: prompt.slice(0, PROMPT_EXCERPT_CHARACTERS),
    ...(signal ? { signal } : {})
  });
  if (!completion) return 'provider_failed';

  // Recorded before the title is written, and keyed on the task, so a crash in between leaves a
  // charge the owner can see rather than a name they were billed for invisibly. The key also makes
  // a second attempt at the same conversation free of a second ledger row.
  await deps.store.recordUsage({
    userId: task.userId,
    workspaceId: workspace.id,
    taskId: task.id,
    kind: 'model_inference',
    resourceClass: completion.resourceClass,
    quantity: completion.inputTokens + completion.outputTokens,
    unit: 'tokens',
    credits: 0,
    state: 'settled',
    idempotencyKey: `task:${task.id}:title`,
    providerRef: completion.providerRef,
    costUsd: completion.costUsd
  });

  const title = cleanGeneratedTitle(completion.text);
  if (!title) return 'unusable';
  const written = await deps.store.setGeneratedTaskTitle(
    task.id,
    encryptJson({ title }, key, `task-title:${workspace.id}`)
  );
  // Not written means the owner renamed it while this call was in flight, and their name stands.
  return written ? 'named' : 'unusable';
};

/**
 * One pass over the conversations still wearing a placeholder. Returns how many were named.
 *
 * `attempts` and `providerReadyAt` are the caller's, so they survive between sweeps: the first
 * bounds how often one stubborn conversation is retried, the second stops a provider outage from
 * being asked about once per answer for as long as it lasts.
 */
export const titleTasksOnce = async (
  deps: TaskTitlerDeps,
  state: { attempts: Map<string, number>; providerReadyAt: number },
  now: number = Date.now(),
  signal?: AbortSignal
): Promise<number> => {
  if (now < state.providerReadyAt) return 0;
  const pending = await deps.store.listTasksNeedingTitle(BACKLOG_WINDOW);
  let named = 0;
  for (const task of pending) {
    if (signal?.aborted) break;
    if (named >= TITLES_PER_SWEEP) break;
    if ((state.attempts.get(task.id) ?? 0) >= MAX_ATTEMPTS_PER_TASK) continue;
    try {
      const outcome = await titleOneTask(deps, task, signal);
      if (outcome === 'named') {
        named += 1;
        deps.log.debug('task.titled', { taskId: task.id, modelId: task.modelId });
      } else if (outcome === 'unusable') {
        recordAttempt(state.attempts, task.id);
      } else if (outcome === 'provider_failed') {
        state.providerReadyAt = now + PROVIDER_COOLDOWN_MS;
        return named;
      }
    } catch (error) {
      // A call cut short by shutdown is the shutdown working, not a failure to report.
      if (signal?.aborted) break;
      recordAttempt(state.attempts, task.id);
      deps.log.warn('task.title_failed', { taskId: task.id, ...errorFields(error) });
    }
  }
  return named;
};

export interface TaskTitler {
  /** Resolves once the loop has left the wait it is in. */
  readonly stop: () => Promise<void>;
}

/**
 * Runs the titler until it is stopped.
 *
 * It wakes on the answer itself - the same LISTEN/NOTIFY signal the activity stream uses, so a
 * conversation is named seconds after it replies rather than on the next tick of a clock - and
 * falls back to `pollMs` for the case that signal is what failed: a listener dropped mid-stream,
 * or a name left behind by a restart that happened between the answer and the sweep.
 */
export const startTaskTitler = (deps: TaskTitlerDeps, pollMs: number): TaskTitler => {
  const state = { attempts: new Map<string, number>(), providerReadyAt: 0 };
  const shutdown = new AbortController();
  let wake = (): void => undefined;
  const stopping = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const loop = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        await titleTasksOnce(deps, state, Date.now(), shutdown.signal);
      } catch (error) {
        // A database blip must not end the loop: an unhandled rejection here would take the whole
        // API process with it, over a name.
        deps.log.error('task.title_sweep_failed', errorFields(error));
      }
      if (shutdown.signal.aborted) break;
      await Promise.race([deps.store.waitForAnsweredTask(pollMs), stopping]);
    }
  })();
  return {
    stop: async () => {
      // Aborting first is what makes this quick: a naming call already in flight is cut off rather
      // than held onto, so a restart costs a name rather than twenty seconds.
      shutdown.abort();
      wake();
      await Promise.race([
        loop,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref())
      ]);
    }
  };
};
