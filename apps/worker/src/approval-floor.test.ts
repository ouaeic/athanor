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

/*
 * The lookup this floor used to do before every diagnostic, and no longer does.
 *
 * A `code_diagnostics` call carries `language: 'auto'` and settles nothing, so the removed approval
 * card could not tell `tsc --noEmit` from `make -s` on the arguments. It bought the answer with a
 * directory listing taken here, from the runner, before every call. The card is gone and so is the
 * round trip - which is the second saving, and the one nobody would have noticed: the dispatch arm
 * takes the same listing a moment later and acts on it, so this one was a runner call per
 * diagnostic spent entirely on the wording of a question.
 *
 * Both halves are asserted, because "the card is gone" and "the lookup is gone" fail differently.
 * A floor that still asks costs the owner a click; a floor that still looks costs a round trip on
 * every diagnostic and shows up as nothing at all.
 */
describe('what the floor no longer has to look up before a diagnostic runs', () => {
  const listing = (entries: string[], seen: string[] = [], fail = false): ApprovalFloorDeps => ({
    store: {} as DataStore,
    masterKey: Buffer.alloc(32, 1),
    runner: {
      call: async (_workspaceId: string, _taskId: string, scope: string) => {
        seen.push(scope);
        if (fail) throw new Error('the runner is not answering');
        return { entries: entries.map((name) => ({ name })) };
      }
    } as unknown as AgentRunnerClient,
    inferenceCredential: async () => {
      throw new Error('no credential is needed to judge a diagnostic');
    },
    destinationContext: (): DestinationContext => ({
      knownOrigins: [],
      knownAddresses: [],
      ownerText: '',
      selfOrigins: [],
      spentNoveltyBytes: 0
    })
  });

  const judge = async (
    entries: string[],
    args: Record<string, unknown> = {},
    seen: string[] = [],
    fail = false
  ) =>
    approvalForCallOnce(
      listing(entries, seen, fail),
      createApprovalFloorMemo(),
      task,
      call('call-1', 'code_diagnostics', { path: 'workspace/cloned', ...args }),
      { messages: [], toolsStarted: 0 } as unknown as AgentState
    );

  /*
   * The owner's own Rust project against the owner's own TypeScript project, driven through the
   * real listing so the two calls genuinely differ - identical arguments, one marker file apart,
   * which is the only place in the product where that difference was ever visible. The Rust one
   * used to cost a card and the TypeScript one did not, and the difference is measured here rather
   * than argued: `evals/cards` counts the same pair over a whole trajectory.
   */
  it('charges a Cargo.toml exactly what it charges a package.json, which is nothing', async () => {
    expect(await judge(['Cargo.toml', 'src'])).toBeNull();
    expect(await judge(['package.json', 'tsconfig.json'])).toBeNull();
    expect(await judge(['go.mod', 'main.go'])).toBeNull();
    expect(await judge(['Makefile', 'main.c'])).toBeNull();
    expect(await judge(['notes.md'])).toBeNull();
  });

  /*
   * The saving, asserted as an absence of a runner call rather than as a comment claiming one.
   * `files.read` here was the listing; nothing else in this floor reaches the runner for a
   * diagnostic, so an empty scope list is the whole statement.
   */
  it('reaches the runner not at all, where it used to take a listing before every call', async () => {
    const seen: string[] = [];
    expect(await judge(['Cargo.toml', 'src'], {}, seen)).toBeNull();
    expect(seen).toEqual([]);
  });

  /*
   * The old branch failed closed: a listing it could not take became a card, on the reasoning that
   * unknown must not read as safe. With nothing to be unknown about, a runner that is not answering
   * costs the diagnostic nothing here - it is the dispatch arm's error to report, once, in its own
   * words.
   */
  it('does not invent a card out of a runner that is not answering', async () => {
    expect(await judge([], {}, [], true)).toBeNull();
  });

  /*
   * `language` is the one argument the model chooses freely, and it used to be the one worth asking
   * about twice: it could neither walk past the card nor invent one. Now it decides only which
   * command the dispatch arm runs, and this floor has no opinion about any of them.
   */
  it('has no opinion about the language the call names, whichever it names', async () => {
    expect(await judge(['package.json', 'tsconfig.json'], { language: 'go' })).toBeNull();
    expect(await judge(['Makefile', 'main.c'], { language: 'ruby' })).toBeNull();
  });
});
