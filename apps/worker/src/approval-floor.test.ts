import { describe, expect, it } from 'vitest';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';
import type { DestinationContext } from './egress.js';
import {
  approvalForCallOnce,
  createApprovalFloorMemo,
  type ApprovalFloorDeps
} from './approval-floor.js';
import type { AgentRunnerClient } from './runner-client.js';

const task = {
  id: 'task-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  securityMode: 'balanced'
} as unknown as TaskRecord;

const call = (id: string, name: string, args: Record<string, unknown> = {}): ModelToolCall =>
  ({ id, name, arguments: args }) as unknown as ModelToolCall;

/**
 * A floor that counts what an evaluation costs.
 *
 * `destinationContext` is the right thing to count: every evaluation builds one, and building one
 * joins up to forty thousand characters of the owner's own words and copies two origin arrays. It
 * is also the dependency that made the duplicate worth fixing rather than merely noticing.
 */
const countingFloor = (): { deps: ApprovalFloorDeps; evaluations: () => number } => {
  let evaluations = 0;
  const deps: ApprovalFloorDeps = {
    store: {} as DataStore,
    masterKey: Buffer.alloc(32, 1),
    runner: {} as AgentRunnerClient,
    inferenceCredential: async () => {
      throw new Error('no credential is needed to evaluate a read');
    },
    destinationContext: (): DestinationContext => {
      evaluations += 1;
      return {
        knownOrigins: [],
        knownAddresses: [],
        ownerText: '',
        selfOrigins: [],
        spentNoveltyBytes: 0
      };
    }
  };
  return { deps, evaluations: () => evaluations };
};

describe('the approval floor is evaluated once per call', () => {
  /*
   * The loop asks twice about the first call of every candidate parallel run: once while choosing
   * the run, and again on the sequential path the run falls through to when it collapses to one
   * call. Both asks are reproduced here in the order the loop makes them, with nothing between,
   * because nothing between them in the loop starts a tool either.
   */
  it('answers the second ask about one call from the first evaluation', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;
    const read = call('call-1', 'file_read', { path: 'workspace/notes.md' });

    const chosen = await approvalForCallOnce(deps, memo, task, read, state);
    const sequential = await approvalForCallOnce(deps, memo, task, read, state);

    expect(chosen).toBeNull();
    expect(sequential).toBeNull();
    expect(evaluations()).toBe(1);
  });

  it('still answers each call of a run separately', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;

    await approvalForCallOnce(deps, memo, task, call('call-1', 'file_read', { path: 'a' }), state);
    await approvalForCallOnce(deps, memo, task, call('call-2', 'file_read', { path: 'b' }), state);
    await approvalForCallOnce(deps, memo, task, call('call-1', 'file_read', { path: 'a' }), state);

    // Two calls, two verdicts - and the third ask is the first call again, which is the collapse
    // this exists to make free. A memo that held one entry would have lost it when call-2 arrived,
    // which is the shape the first draft of this fix had.
    expect(evaluations()).toBe(2);
  });

  it('re-evaluates once a tool has run, because taint moves the answer', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;
    const read = call('call-1', 'file_read', { path: 'workspace/notes.md' });

    await approvalForCallOnce(deps, memo, task, read, state);
    // What the loop does immediately before every dispatch, on both the sequential and the
    // parallel path. A verdict taken before a tool ran says nothing about the turn after it.
    state.toolsStarted = 1;
    await approvalForCallOnce(deps, memo, task, read, state);

    expect(evaluations()).toBe(2);
  });
});
