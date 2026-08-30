/**
 * What a finished turn deposits in the tiered store: the episode, and the cautions the harness
 * earned by watching an acceptance command fail.
 *
 * Lifted out of `AgentWorker` in Wave 7.2 unchanged. Both halves are write paths with their own
 * failure discipline - one reports, one swallows, and the comments say why they differ - and both
 * were reachable only through a completed turn.
 */
import {
  deadEndFromCheck,
  encryptJson,
  memoryDeadEndTagKey,
  memoryIndexKey,
  memorySubjectKey,
  redactText,
  type MemoryDeadEndCheck
} from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { AcceptanceCommandCheck } from './acceptance.js';
import type { AgentState } from './agent-state.js';
import type { CompletionVerification } from './completion.js';
import {
  extractTurn,
  finishedAnswerText,
  MEMORY_MAX_SOURCE_CHUNKS,
  memoryItemAad,
  memoryProposalSummary,
  memoryProposalWasRefused,
  proposeMemoryFacts,
  recordMemoryPackOutcome,
  recordTurnEpisode,
  shouldConsolidateMemory,
  type MemoryProposalDeps
} from './memory-runtime.js';
import { event } from './tool-recording.js';

/** What the memory write path needs from the worker that owns the turn. */
export interface MemoryCaptureDeps {
  readonly store: DataStore;
  /**
   * When each workspace's memory was last consolidated, held by the worker rather than the store
   * because the cadence is an optimisation rather than a guarantee. Passed in so the claim before
   * the await still stops a second turn finishing concurrently from running it twice.
   */
  readonly memoryConsolidatedAt: Map<string, number>;
  /**
   * What the nightly pass needs to make its one model call, or nothing at all.
   *
   * Optional because the proposer is the only thing in this file that needs a provider, and every
   * other line here works without one. A worker assembled without it consolidates exactly as
   * before: the rest of memory does not depend on a model being reachable, and it must not start
   * to.
   */
  readonly proposals?: MemoryProposalDeps;
}

/**
 * The tiered store's write path, run once per verified turn.
 *
 * Episodes are captured automatically because they are mechanical: goal, outcome and the
 * artifacts touched, all of which the turn already produced. Durable facts are held back one
 * step further: anything the owner said that looks like a lasting truth is only ever *observed*
 * into `mem.fact_candidate`, and becomes memory on a second independent sighting on a later day,
 * from untainted input. What makes this the owner's rather than the harness's is that it is
 * reversible - deleting the conversation deletes the episode and the verbatim sources it cites,
 * and deleting the workspace removes everything. There is no approval step, deliberately:
 * automatic memory that asks permission for every line is a review queue, not memory.
 */
export const captureMemory = async (
  deps: MemoryCaptureDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  completion: {
    summary: string;
    verification: CompletionVerification;
    /** Present, and true, only on a turn the harness stopped rather than the model. */
    interrupted?: boolean;
    /** Acceptance checks the harness ran and watched pass on the finishing turn. */
    verifiedCommands?: readonly AcceptanceCommandCheck[];
  },
  /** The commands it watched fail on that same run, which is the other half of the same lesson. */
  deadEnds: readonly MemoryDeadEndCheck[] = []
): Promise<void> => {
  const occurredAt = new Date();
  try {
    const { request, artifacts } = extractTurn(state.messages);
    // What this turn touched, including the steps a compaction removed from the window. Carried
    // first so the earliest work is named first, which is the order it happened in.
    const touched = [...new Set([...(state.carriedArtifacts ?? []), ...artifacts])];
    const written = await recordTurnEpisode({
      store: deps.store,
      userId: task.userId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      dataKey: key,
      request,
      summary: completion.summary,
      // Every turn that reaches #completeTurn is recorded here, the verified finish and the
      // step-limit handoff alike, so the label has to say which one this was. Keyed off
      // `interrupted` and never off verification.status: `not_applicable` is the correct status
      // for an answer that needed no tools, so keying off it would file most chat turns as
      // failures.
      outcome: completion.interrupted ? 'interrupted' : 'ok',
      verifiedClaims: completion.verification.evidence.map((item) => item.claim),
      remainingRisks: completion.verification.remainingRisks,
      artifacts: touched,
      // What the harness itself verified about this workspace, which is the half of memory that
      // does not come from anything the owner typed.
      ...(completion.verifiedCommands?.length
        ? {
            verifiedCommands: completion.verifiedCommands.map((check) => ({
              label: check.label,
              executable: check.executable,
              args: check.args,
              cwd: check.cwd
            }))
          }
        : {}),
      // A turn that read somebody else's words records what happened but settles nothing.
      tainted: Boolean(state.taint),
      occurredAt
    });
    /*
     * What the source cap refused, said out loud.
     *
     * The cap itself is right and is unchanged: eight rows of six kilobytes per part, keeping the
     * head. What was wrong is that a 400 KB brief was stored as its first 48 KB with no event of
     * any kind, so the owner could later search memory for a constraint they had definitely
     * written and be told, truthfully and uselessly, that nothing matched. Over 3,950 real turns
     * this fires on 197 of them (5.0%) and accounts for 57.7% of everything the owner typed.
     *
     * A status rather than a warning: the turn WAS recorded, and the sentence above it - "this
     * turn was not recorded in memory" - is the one that must stay reserved for when it was not.
     * Never fatal, like every other line in this function after the episode is written.
     */
    if (written && written.sourceChunksDropped > 0)
      await event(
        deps.store,
        task,
        key,
        'status',
        `Stored the first ${MEMORY_MAX_SOURCE_CHUNKS} parts of this turn verbatim; ${written.sourceChunksDropped} further ${written.sourceChunksDropped === 1 ? 'part is' : 'parts are'} searchable in the conversation but not in memory`,
        { droppedChunks: written.sourceChunksDropped, keptChunks: written.sourceIds.length }
      ).catch(() => undefined);
    await recordDeadEnds(deps, task, key, {
      tainted: Boolean(state.taint),
      passed: completion.verifiedCommands ?? [],
      failed: deadEnds,
      observedAt: occurredAt
    });
    // A turn that never finished has graded nothing. The injection-time row already counted the
    // use as `unknown`, so the items keep their salience and simply stay ungraded, which is the
    // truth. Not `fail` either: the pack is not what ran out of steps, and marking it down would
    // punish the items that did help.
    if (!completion.interrupted)
      await recordMemoryPackOutcome({
        store: deps.store,
        workspaceId: task.workspaceId,
        taskId: task.id,
        outcome: 'ok',
        // The one place in the product that knows both what was recalled and what was done with
        // it, which is why the citation is written here and not at injection time.
        //
        // `cited_count` is a fifth of the salience score that decides which memories survive
        // consolidation, and its only writer takes a `cited` flag that no production caller had
        // ever passed - so the column was zero in every workspace that had ever run and the term
        // was a constant for every row in the pool. What was missing was never the column: it was
        // an answer to "which of these entries did the turn use", and the only moment that answer
        // exists is here, with the finished work in hand.
        dataKey: key,
        used: [
          finishedAnswerText(state.messages),
          completion.summary,
          ...completion.verification.evidence.map((item) => item.claim),
          // The commands the harness itself watched pass. Without them a procedure that was
          // followed to the letter grades identically to one that was ignored, because nobody
          // writes a shell command out to the owner in prose.
          ...(completion.verifiedCommands ?? []).map((check) =>
            [check.executable, ...check.args].join(' ')
          )
        ],
        // Excluded from attribution rather than added to it: the block was retrieved *with* this
        // request, so an entry and the request overlap by construction.
        request
      });
    const now = Date.now();
    if (shouldConsolidateMemory(deps.memoryConsolidatedAt.get(task.workspaceId), now)) {
      // Claimed before the await so a second turn finishing concurrently does not run it twice.
      deps.memoryConsolidatedAt.set(task.workspaceId, now);
      if (deps.memoryConsolidatedAt.size > 256) {
        deps.memoryConsolidatedAt.clear();
        deps.memoryConsolidatedAt.set(task.workspaceId, now);
      }
      await deps.store.consolidateMemory(task.workspaceId);
      await proposeFromTheDay(deps, task, key);
    }
  } catch (cause) {
    // The user already has their verified result; a memory write must never turn that into a
    // failed task. It is reported rather than swallowed so a store that stops recording is
    // visible instead of silently degrading recall for months.
    await event(
      deps.store,
      task,
      key,
      'warning',
      'This turn was not recorded in memory, so it will not be recalled later',
      { message: cause instanceof Error ? cause.message : 'memory capture failed' }
    ).catch(() => undefined);
  }
};

/**
 * The one model call a day, hung off the cadence that already exists.
 *
 * It runs inside the same 24-hour claim as `consolidateMemory` and after it, which is deliberate on
 * both counts. Inside, because the claim is what stops two turns finishing concurrently from
 * running it twice, and a proposer with no such claim would be a call per turn wearing a nightly
 * name. After, because consolidation prunes the candidate table, and proposing into a queue that is
 * about to be pruned would count rows the next statement removes.
 *
 * Isolated from the block above it, and that is the whole reason this is a function rather than
 * three lines inline. `captureMemory`'s catch reports "This turn was not recorded in memory", which
 * would be FALSE here: the episode, the sources, the observations and the promotions are all
 * already written by the time this runs. A provider that is unreachable, out of quota or slow must
 * cost the owner nothing but the proposals, so it is caught here and says so in its own words.
 *
 * The line is written only when a bound actually fired. A nightly status saying nothing was refused
 * is how an owner learns to stop reading the timeline.
 */
const proposeFromTheDay = async (
  deps: MemoryCaptureDeps,
  task: TaskRecord,
  key: Uint8Array
): Promise<void> => {
  if (!deps.proposals) return;
  try {
    const report = await proposeMemoryFacts(deps.proposals, task, key);
    if (!memoryProposalWasRefused(report)) return;
    await event(deps.store, task, key, 'status', memoryProposalSummary(report), {
      memoryProposals: {
        episodesOffered: report.episodesOffered,
        allowance: report.allowance,
        proposed: report.proposed,
        refused: report.refused
      }
    }).catch(() => undefined);
  } catch (cause) {
    await event(
      deps.store,
      task,
      key,
      'status',
      'Could not look over the day for rules worth remembering; everything this turn did is still recorded',
      { message: cause instanceof Error ? cause.message : 'memory proposal failed' }
    ).catch(() => undefined);
  }
};

/**
 * What the harness watched an acceptance command fail to do, and what a later pass does to it.
 *
 * The write half carries the same gate as a fact and a procedure: a turn that read somebody
 * else's words settles nothing durable. It matters more here than there. The commands are the
 * model's, and a page that can steer the model into declaring a check against the wrong directory
 * gets a standing "this does not work" out of the machine's own observation - which is the one
 * way something outside could plant a belief that survives the conversation it arrived in.
 *
 * The retirement half deliberately runs anyway. Nothing anyone reads can make a command exit
 * zero, and forgetting a caution costs a re-run where keeping a wrong one costs the approach.
 *
 * Failures here are swallowed rather than reported. The turn's own record is already written by
 * the time this runs, and the warning above says the turn was not recorded at all - which would
 * be false, and the owner would go looking for a conversation that is in fact there.
 */
export const recordDeadEnds = async (
  deps: MemoryCaptureDeps,
  task: TaskRecord,
  key: Uint8Array,
  input: {
    tainted: boolean;
    passed: readonly AcceptanceCommandCheck[];
    failed: readonly MemoryDeadEndCheck[];
    observedAt: Date;
  }
): Promise<void> => {
  const indexKey = memoryIndexKey(key);
  // Sliced exactly as a passing run keys its subject, so the two sides of one command meet.
  const passed = input.passed.map((check) =>
    memorySubjectKey([check.executable, ...check.args].join(' ').slice(0, 400), indexKey)
  );
  const failed = input.tainted
    ? []
    : input.failed.map((observation) => {
        const { content, index, validTo } = deadEndFromCheck(
          // Redacted at the door, like everything else that lands in memory: this is up to two
          // kilobytes of stderr, which is where an inline token in a failing request shows up.
          { ...observation, detail: redactText(observation.detail) },
          input.observedAt,
          indexKey
        );
        return {
          userId: task.userId,
          workspaceId: task.workspaceId,
          // Derived like the passing half, and for the same reason: the harness ran it and
          // watched the result. Nothing here is the model's account of its own work.
          trust: 'derived' as const,
          documentCiphertext: encryptJson(content, key, memoryItemAad(task.workspaceId)),
          index,
          observedAt: input.observedAt,
          validFrom: input.observedAt,
          validTo,
          taskId: task.id
        };
      });
  if (passed.length === 0 && failed.length === 0) return;
  await deps.store
    .recordMemoryDeadEnds({
      workspaceId: task.workspaceId,
      markerTag: memoryDeadEndTagKey(indexKey),
      passed,
      failed,
      at: input.observedAt
    })
    .catch(() => undefined);
};
