/**
 * The order the batch loop asks its two questions in, which is a bound and not a detail.
 *
 * The approval floor's destructive rule frees a delete strictly inside `CHECKPOINT_CONTENT` because
 * a rewind puts it back, and it learns whether this turn HAS a rewind from `ApprovalContext.undoPoint`
 * - fed from `AgentState.checkpoint`, written by `#ensureTurnUndoPoint`. The undo point used to be
 * taken one gate later, inside `turn/execute-call.ts`, so on the first non-exempt call of a turn the
 * floor was answering a question about a fact nobody had established yet. The cost was one card for a
 * turn whose opening act was itself a recoverable delete, while the identical delete two calls later
 * was free: a verdict decided by position in the batch.
 *
 * Asserted here rather than on `approvalRequirement`, because the rule was never the thing in doubt.
 * What is in doubt is the sequencing, and the sequencing lives in `dispatchToolCalls`.
 *
 * The floor stub throws once it has recorded what it was shown. That is deliberate: everything past
 * the floor is the execution path, which needs a store, a lease, a cancellation watch and a runner,
 * and none of it can change what the floor was already handed. The throw stops the batch exactly
 * where the question has been answered.
 */
import { describe, expect, it } from 'vitest';
import type { ModelRelease, WebToolPlan } from '@athanor/contracts';
import type { TaskRecord } from '@athanor/data';
import type { ModelResponse, ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import { approvalRequirement } from '../tools.js';
import { dispatchToolCalls, type TurnDispatchDeps } from './dispatch.js';
import type { TurnRun } from './claim.js';

const task = { id: 'task-1', workspaceId: 'ws-1', securityMode: 'autonomous' } as TaskRecord;
const key = new Uint8Array(32);

const toolCall = (name: string, args: Record<string, unknown>): ModelToolCall =>
  ({ id: `call-${name}`, name, arguments: args }) as ModelToolCall;

/** Stopped at the floor, which is where the only question this file asks has been answered. */
class AskedTheFloor extends Error {}

interface Seen {
  /** The turn's undo point as the floor was shown it, or undefined if it had not been taken. */
  checkpoint: AgentState['checkpoint'];
  order: string[];
}

/**
 * One batch through the real `dispatchToolCalls`, with the two deps this file is about recorded.
 *
 * `ensureTurnUndoPoint` is the worker's own, spelled the way `AgentWorker` spells it: exempt tools
 * are refused outright, and a runner that refuses the checkpoint still writes `{ turn, id: null }`
 * so the turn does not retry it before every later call.
 */
const dispatch = async (
  calls: readonly ModelToolCall[],
  checkpointResult: 'taken' | 'refused'
): Promise<Seen> => {
  const seen: Seen = { checkpoint: undefined, order: [] };
  const state = { messages: [], turn: 3, toolsStarted: 0 } as unknown as AgentState;
  const exempt = new Set(['files_list', 'file_read', 'finish', 'notify']);
  const deps = {
    store: {} as TurnDispatchDeps['store'],
    config: {} as TurnDispatchDeps['config'],
    finish: {} as TurnDispatchDeps['finish'],
    acceptance: {} as TurnDispatchDeps['acceptance'],
    resume: {
      ensureTurnUndoPoint: async (
        _task: TaskRecord,
        _key: Uint8Array,
        agentState: AgentState,
        tool: string
      ) => {
        if (exempt.has(tool) || agentState.checkpoint?.turn === (agentState.turn ?? 0)) return;
        seen.order.push(`undo:${tool}`);
        agentState.checkpoint =
          checkpointResult === 'taken'
            ? { turn: agentState.turn ?? 0, id: 'checkpoint-3', uncovered: [] }
            : { turn: agentState.turn ?? 0, id: null };
      }
    } as unknown as TurnDispatchDeps['resume'],
    approvalForCallOnce: async (
      _memo: unknown,
      _task: TaskRecord,
      call: ModelToolCall,
      agentState?: AgentState
    ) => {
      seen.order.push(`floor:${call.name}`);
      seen.checkpoint = agentState?.checkpoint;
      throw new AskedTheFloor(call.name);
    },
    runToolCallsTogether: async () => undefined,
    recordToolResult: async () => undefined,
    compactContext: (async () => undefined) as unknown as TurnDispatchDeps['compactContext'],
    sendNotice: async () => undefined,
    askUser: async () => false
  } as unknown as TurnDispatchDeps;

  await dispatchToolCalls(
    deps,
    task,
    key,
    state,
    { toolCalls: calls } as ModelResponse,
    '',
    { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan } as unknown as TurnRun,
    { maxOutputTokens: 1024, turn: 3 },
    { honorUserControl: async () => false, refreshActivePlan: async () => false }
  ).catch((error: unknown) => {
    if (!(error instanceof AskedTheFloor)) throw error;
  });
  return seen;
};

describe('the undo point and the floor, in that order', () => {
  const remove = toolCall('shell', { executable: 'rm', args: ['-rf', 'dist'] });

  it('takes the turn’s undo point before it asks the floor about the first call', async () => {
    const seen = await dispatch([remove], 'taken');

    expect(seen.order).toEqual(['undo:shell', 'floor:shell']);
    expect(seen.checkpoint).toEqual({ turn: 3, id: 'checkpoint-3', uncovered: [] });
    /*
     * And that the fact is the one the rule spends. This is the whole saving: `rm -rf dist` is
     * strictly inside `CHECKPOINT_CONTENT`, carded in balanced before the location rule existed,
     * and free after it - but only on a turn that has a rewind. Asked of the context the floor was
     * actually handed rather than of one written here.
     */
    expect(
      approvalRequirement('shell', remove.arguments, 'autonomous', {
        undoPoint: {
          id: seen.checkpoint?.id ?? null,
          ...(seen.checkpoint?.uncovered ? { uncovered: seen.checkpoint.uncovered } : {})
        }
      })
    ).toBeNull();
  });

  /*
   * The fail-closed direction, which the move must not trade away. `#ensureTurnUndoPoint` catches
   * `CheckpointRefusedError` - a workspace over `CHECKPOINT_MAX_FILES`, a full host disk - tells
   * the owner this turn has no undo point and lets the work carry on. Taking the checkpoint earlier
   * makes that case sharper rather than weaker: the floor now sees a refusal where it used to see
   * the same absence it saw before anybody had tried.
   */
  it('shows the floor a refusal when the checkpoint could not be taken', async () => {
    const seen = await dispatch([remove], 'refused');

    expect(seen.order).toEqual(['undo:shell', 'floor:shell']);
    expect(seen.checkpoint).toEqual({ turn: 3, id: null });
    expect(
      approvalRequirement('shell', remove.arguments, 'autonomous', {
        undoPoint: {
          id: seen.checkpoint?.id ?? null,
          ...(seen.checkpoint?.uncovered ? { uncovered: seen.checkpoint.uncovered } : {})
        }
      })
    ).toMatchObject({ sideEffect: 'external_consequential' });
  });

  /*
   * And a turn that only reads still costs nothing, which is the reason the undo point was lazy in
   * the first place. The exemption lives inside `#ensureTurnUndoPoint`, so moving the call earlier
   * moves the exemption with it.
   */
  it('costs a read nothing', async () => {
    const seen = await dispatch([toolCall('files_list', { path: 'workspace' })], 'taken');

    expect(seen.order).toEqual(['floor:files_list']);
    expect(seen.checkpoint).toBeUndefined();
  });
});
