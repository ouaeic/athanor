import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CREDIT_HEADROOM,
  mayRenewStepBudget,
  stepBudgetRenewedNote,
  turnWriteCount,
  type AcceptanceResult,
  type ContinuationInput
} from './acceptance.js';

/**
 * The decision to keep going, tested from the refusals inwards.
 *
 * An agent that will not stop is far worse than one that stops early, so the happy path here is one
 * test and every way of not taking it is its own. The whole function is a list of reasons to stop
 * with a `return { ok: true }` at the bottom, and these are what hold that shape: a condition
 * accidentally inverted or dropped shows up as a turn that renews itself when it should not, which
 * is the only failure of this mechanism that costs the owner anything.
 */

/** A turn that has every reason to be allowed to carry on, for the tests to take one away from. */
const working = (over: Partial<ContinuationInput> = {}): ContinuationInput => ({
  hasAcceptance: true,
  acceptanceIsThisTurn: true,
  continuationsUsed: 0,
  continuationCeiling: 2,
  writes: 4,
  credits: 10,
  maxCredits: 100,
  refusalsExhausted: false,
  awaitingApproval: false,
  ...over
});

const result = (id: string, passed: boolean): AcceptanceResult => ({
  id,
  label: id === 'check-1' ? 'the importer test passes' : 'the schema still validates',
  passed,
  detail: passed ? 'exit 0' : 'exit 1 (expected 0): AssertionError: expected 3 rows, found 0'
});

describe('whether a turn may hand itself another step budget', () => {
  it('continues a job that is unfinished, moving, and inside every ceiling', () => {
    expect(mayRenewStepBudget(working())).toEqual({ ok: true });
  });

  it('refuses when the operator has switched continuing off', () => {
    // Zero has to be the old behaviour exactly, not "one more, quietly".
    expect(mayRenewStepBudget(working({ continuationCeiling: 0 }))).toMatchObject({ ok: false });
  });

  it('refuses past the fixed number of continuations, whatever else is true', () => {
    const verdict = mayRenewStepBudget(
      working({ continuationsUsed: 2, continuationCeiling: 2, writes: 9_999 })
    );
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('already renewed');
  });

  it('refuses a turn that never said what would prove the job done', () => {
    /*
     * The load-bearing one. Without an acceptance record the only thing that could call the job
     * unfinished is the model's own opinion of itself in its own context, which is exactly the
     * signal this whole mechanism exists to refuse - so a turn without one stops at its ceiling
     * however much work it looks like it is doing.
     */
    const verdict = mayRenewStepBudget(working({ hasAcceptance: false }));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('never declared');
  });

  it('refuses a turn holding only the checks an earlier turn declared', () => {
    /*
     * The same refusal the finish gate makes, and for a sharper reason. An inherited record was
     * passing before this turn started, so it says nothing about what this turn did - and this
     * decision fires on a check *failing*, which for an inherited one means the turn has broken
     * something an earlier turn guaranteed. That is the case for stopping and telling the owner,
     * not the case for another hundred and twenty steps.
     */
    const verdict = mayRenewStepBudget(working({ acceptanceIsThisTurn: false }));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('earlier turn');
  });

  it('refuses a turn that is waiting on the user', () => {
    const verdict = mayRenewStepBudget(working({ awaitingApproval: true }));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('only the user can make');
  });

  it('refuses a turn the harness has already given up refusing', () => {
    // A model that cannot ground a finish, or cannot pass its own checks, as many times as the
    // harness allows is stuck rather than one budget short.
    expect(mayRenewStepBudget(working({ refusalsExhausted: true }))).toMatchObject({ ok: false });
  });

  it('refuses a first budget that changed nothing at all', () => {
    const verdict = mayRenewStepBudget(working({ writes: 0 }));
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('has not changed anything');
  });

  it('refuses a second budget that changed nothing since the first', () => {
    // The bar moves with the turn: four writes earned the first renewal, and the same four are not
    // evidence that the second budget did anything.
    const verdict = mayRenewStepBudget(
      working({ continuationsUsed: 1, writes: 4, mark: { atStep: 120, writes: 4 } })
    );
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.reason).toContain('since step 120');
  });

  it('continues a second budget that changed something since the first', () => {
    expect(
      mayRenewStepBudget(
        working({ continuationsUsed: 1, writes: 5, mark: { atStep: 120, writes: 4 } })
      )
    ).toEqual({ ok: true });
  });

  it('refuses when too little of the compute allowance is left to be worth it', () => {
    // A renewal announced and then abandoned two steps later on the credit ceiling reads worse to
    // the owner than a turn that stopped cleanly, and costs them a model call to say so.
    const barely = 100 * (1 - CONTINUATION_CREDIT_HEADROOM);
    expect(mayRenewStepBudget(working({ credits: barely, maxCredits: 100 }))).toMatchObject({
      ok: false
    });
    expect(mayRenewStepBudget(working({ credits: barely - 1, maxCredits: 100 }))).toEqual({
      ok: true
    });
  });

  it('refuses a turn whose allowance is already spent', () => {
    expect(mayRenewStepBudget(working({ credits: 100, maxCredits: 100 }))).toMatchObject({
      ok: false
    });
  });
});

describe('what counts as this turn changing something', () => {
  it('counts only the successful calls that changed the computer', () => {
    // Shaped exactly as the turn records them, name and all, so this reads against the real thing
    // rather than the narrower slice the counter happens to need.
    const recorded = {
      'call-1': { name: 'file_read', success: true },
      'call-2': { name: 'file_write', success: true, mutating: true },
      // A write that threw is the turn trying, not the turn progressing.
      'call-3': { name: 'file_write', success: false, mutating: true },
      'call-4': { name: 'shell', success: true, mutating: true }
    };

    expect(turnWriteCount(recorded)).toBe(2);
  });

  it('counts nothing at all when the turn has done nothing yet', () => {
    expect(turnWriteCount(undefined)).toBe(0);
  });
});

describe('what a renewed turn is told', () => {
  const results = [result('check-1', false), result('check-2', true)];

  it('carries the harness’s own observation of what is still not done', () => {
    const note = stepBudgetRenewedNote({ results, continuation: 1, ceiling: 2, steps: 120 });

    expect(note).toContain('BUDGET RENEWED (1 of 2) after 120 steps');
    expect(note).toContain('1 of 2 still fails');
    // The detail, not a verdict: an exit code and the assertion are what turn "not done" into a
    // next step, and they are the same words a refused finish gets.
    expect(note).toContain('AssertionError: expected 3 rows, found 0');
    expect(note).toContain('Do not restart finished work');
    // Nothing about the user, because nobody has been asked anything.
    expect(note).not.toContain('reply');
  });

  it('says plainly when there will not be another one', () => {
    expect(
      stepBudgetRenewedNote({ results, continuation: 1, ceiling: 2, steps: 120 })
    ).not.toContain('last renewal');
    expect(stepBudgetRenewedNote({ results, continuation: 2, ceiling: 2, steps: 240 })).toContain(
      'This is the last renewal there is'
    );
  });
});
