import { describe, expect, it, vi } from 'vitest';
import { decryptJson, generateDataKey } from '@athanor/core';
import type { TaskRecord } from '@athanor/data';
import type { AgentState } from './agent-state.js';
import {
  renewStepBudget,
  TURN_WALL_CLOCK_MS,
  turnWallClockReached,
  type HandoffDeps
} from './handoff.js';
import { MODEL_REQUEST_TIMEOUT_MS } from './turn-lifecycle.js';

/**
 * There was no clock ceiling anywhere in the product.
 *
 * `TASK_MAX_STEPS`, `TASK_MAX_SELF_CONTINUATIONS`, `maxComputeCredits` and the owner's spend caps
 * were the whole of what bounded a turn, and the per-unit ceilings compose rather than cap: six
 * idle steps at ten minutes of generation each is an hour of billed deliberation, five completion
 * nags is fifty minutes, and a hundred and twenty steps of tool time is days in principle. The
 * credit ceiling is what bites first on a frontier model, and it is a proxy for time rather than a
 * bound on it - on a cheap local route credits accumulate slowly and the clock does not.
 */
describe('the turn wall clock', () => {
  it('holds a turn that is inside the allowance', () => {
    const startedAt = Date.now();
    expect(turnWallClockReached(startedAt, startedAt)).toBe(false);
    expect(turnWallClockReached(startedAt, startedAt + TURN_WALL_CLOCK_MS - 1)).toBe(false);
  });

  it('ends a turn that reaches it', () => {
    const startedAt = Date.now();
    expect(turnWallClockReached(startedAt, startedAt + TURN_WALL_CLOCK_MS)).toBe(true);
  });

  /*
   * The composition the bound exists for, in the product's own figures: the step ceiling is 120
   * and every one of those steps may spend a whole `MODEL_REQUEST_TIMEOUT_MS` generating, before a
   * second of tool time is counted. Thirty hours of model time was inside every bound the loop had.
   */
  it('is shorter than the ceilings that compose underneath it', () => {
    const stepsTimesTheRequestDeadline = 120 * MODEL_REQUEST_TIMEOUT_MS;
    expect(stepsTimesTheRequestDeadline).toBeGreaterThan(TURN_WALL_CLOCK_MS);
    // And it is not so tight that a healthy turn could reach it: the measured record in this file
    // is that a frontier model reaches the credit ceiling around step 22 to 39.
    expect(TURN_WALL_CLOCK_MS).toBeGreaterThan(39 * MODEL_REQUEST_TIMEOUT_MS * 0.1);
  });

  it('reads the clock rather than a monotonic counter, so a paused process still ages', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      vi.setSystemTime(startedAt + TURN_WALL_CLOCK_MS);
      expect(turnWallClockReached(startedAt)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The ownership refusal inside the renewal, at the only level that can still reach it.
 *
 * Wave 7.2 gave `honorUserControl` an arm for #140, and that arm stands a disowned run down at the
 * step boundary in silence. It runs first, so the whole-loop case in `agent-run.test.ts` - a turn
 * whose lease was foreign before it ever started - no longer arrives at the step ceiling, and the
 * refusal this describes stopped being reachable from there.
 *
 * It is not dead. `renewStepBudget` is evaluated at the top of the loop condition, and the last
 * `honorUserControl` before it is a whole model call and a whole tool batch earlier: a lease lost
 * inside that window reaches here and nowhere else. That is the narrower race this guards, and it
 * is worth guarding for the reason the arm above it exists - a renewal announces a continuation on
 * a conversation another worker is running, then saves this run's stale trajectory over theirs.
 */
describe('the renewal asks who holds the task', () => {
  const taskId = '33333333-3333-4333-8333-333333333333';
  const key = generateDataKey();

  const renewableState = (): AgentState =>
    ({
      step: 12,
      turn: 0,
      credits: 10,
      messages: [],
      selfContinuations: 0,
      acceptanceTurn: 0,
      // One successful mutating call, which is the progress bar `mayRenewStepBudget` measures.
      turnToolResults: { 'call-0': { name: 'file_write', success: true, mutating: true } },
      acceptance: {
        checks: [
          {
            id: 'check-1',
            kind: 'command',
            label: 'the suite passes',
            executable: 'pytest',
            args: ['-q'],
            cwd: 'workspace',
            expectExit: 0,
            timeoutSeconds: 900
          }
        ],
        revisions: 1,
        declaredAtStep: 0
      }
    }) as unknown as AgentState;

  it('refuses a renewal when the lease moved since the last step boundary, and runs no checks', async () => {
    const summaries: string[] = [];
    const task = {
      id: taskId,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      maxComputeCredits: 1_000
    } as unknown as TaskRecord;
    const deps = {
      config: { TASK_MAX_SELF_CONTINUATIONS: 2, WORKER_ID: 'worker-self' },
      store: {
        // The fresh read the renewal makes immediately before deciding: still running, but held by
        // somebody else now.
        getTask: async () => ({ ...task, status: 'running', leaseOwner: 'worker-other' }),
        // Allowed deliberately: the spend caps are asked *after* the ownership question, so leaving
        // this permissive is what makes the check below a statement about the lease rather than
        // about a budget that would have stopped the renewal anyway.
        spendGuard: async () => ({ outcome: 'allow' }),
        appendTaskEvent: async (input: {
          payloadCiphertext: Parameters<typeof decryptJson>[0];
        }) => {
          summaries.push(decryptJson<{ summary: string }>(input.payloadCiphertext, key).summary);
          return { id: 'event', sequence: summaries.length };
        }
      },
      // The checks are a full build and a full test run on the owner's computer. Who holds the task
      // is a free read and it comes first, so this must never be reached.
      runAcceptanceChecks: async () => {
        throw new Error('the acceptance suite must not run for a task this worker does not hold');
      }
    } as unknown as HandoffDeps;

    const renewed = await renewStepBudget(deps, task, key, renewableState());

    expect(renewed).toBe(false);
    expect(summaries).toContain('Stopping at the step limit: another worker holds the task');
  });

  it('does not refuse on ownership when this worker still holds the lease', async () => {
    // The same state one field apart, so the case above is about the lease and not about a state
    // that could never have renewed anyway.
    const summaries: string[] = [];
    const task = {
      id: taskId,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      maxComputeCredits: 1_000
    } as unknown as TaskRecord;
    const deps = {
      config: { TASK_MAX_SELF_CONTINUATIONS: 2, WORKER_ID: 'worker-self' },
      store: {
        getTask: async () => ({ ...task, status: 'running', leaseOwner: 'worker-self' }),
        spendGuard: async () => ({ outcome: 'allow' }),
        appendTaskEvent: async (input: {
          payloadCiphertext: Parameters<typeof decryptJson>[0];
        }) => {
          summaries.push(decryptJson<{ summary: string }>(input.payloadCiphertext, key).summary);
          return { id: 'event', sequence: summaries.length };
        }
      },
      // Reached this time, and every check still fails - so the renewal is granted rather than
      // refused, which is what makes the ownership arm above the thing that stopped it.
      runAcceptanceChecks: async () => [
        { id: 'check-1', label: 'the suite passes', passed: false, detail: 'one test still fails' }
      ],
      withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
      checkpoint: async () => undefined
    } as unknown as HandoffDeps;

    const renewed = await renewStepBudget(deps, task, key, renewableState());

    expect(renewed).toBe(true);
    expect(summaries).not.toContain('Stopping at the step limit: another worker holds the task');
  });
});
