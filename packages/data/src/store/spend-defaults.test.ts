import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';
import { DEFAULT_MONTHLY_CAP_USD } from './billing.js';

/**
 * The money bound, on a box whose owner has never opened the settings.
 *
 * Every cap under `spend_limits` shipped as `null` while the machinery above it - the pre-flight
 * guard, the per-step halt, the per-window alert, the pane - was complete and tested. So the whole
 * apparatus refused nothing on a fresh install, and the punchlist line "the box has no spending
 * ceiling" was true of the finished feature.
 *
 * These are not tests that the number is 100. They are tests that a number is enforced, that the
 * surface the owner reads and the brake that stops the work quote the same one, and that the three
 * ways an owner can say "not that" are all honoured. The number itself is argued in the comment on
 * `DEFAULT_MONTHLY_CAP_USD` and is read from there rather than restated, so moving it is one edit.
 */
describe('the ceiling a box has before anyone sets one', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    userId = (await store.createUser({ username: 'owner', displayName: 'Owner' })).id;
  });

  afterEach(async () => database.close());

  /** Settled provider spend, which is the only state any of these windows count. */
  const bill = async (key: string, costUsd: number): Promise<void> => {
    await store.recordUsage({
      userId,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1_000,
      unit: 'tokens',
      credits: 0,
      state: 'settled',
      idempotencyKey: key,
      costUsd
    });
  };

  const monthlyWindow = async (estimateUsd: number) => {
    const decision = await store.spendGuard({ userId, estimateUsd, includeOpenCommitments: true });
    return {
      decision,
      monthly: decision.windows.find((window) => window.name === 'monthly')
    };
  };

  it('refuses work that would pass the ceiling nobody set', async () => {
    await expect(store.getSpendLimits(userId)).resolves.toBeNull();
    await bill('most-of-the-month', DEFAULT_MONTHLY_CAP_USD - 1);
    const { decision } = await monthlyWindow(5);
    expect(decision.outcome).toBe('deny');
    expect(decision.blockedBy).toBe('monthly');
  });

  /**
   * The defect this file exists for, stated as a bound rather than as a value.
   *
   * A default filled in at `effectiveSpendLimits` alone would draw a ceiling in the pane while
   * `spendGuardIn` - which reads `spend_limits` for itself, a hundred lines away - carried on with
   * `null`. That box shows its owner a brake it does not have. Both readers go through
   * `cappedMonthlyUsd` for exactly this, and the two numbers are compared here rather than each
   * being compared to a literal, so a change that moves one and not the other fails.
   */
  it('quotes the same ceiling to the pane and to the brake', async () => {
    const limits = await store.effectiveSpendLimits(userId);
    const { monthly } = await monthlyWindow(0);
    expect(limits.monthlyCapUsd).toBe(DEFAULT_MONTHLY_CAP_USD);
    expect(monthly?.capUsd).toBe(limits.monthlyCapUsd);
  });

  /**
   * The two caps that stay unset, and the reason is not symmetry.
   *
   * `defaultTaskCapUsd` is enforced by reserving its whole value the moment work is queued, so a
   * guessed number there refuses the third conversation of the morning over money nobody has spent.
   * The day cannot tell a runaway from a heavy afternoon. Both are the owner's to set, and the
   * absence of a `task` window in the decision is what proves nothing was reserved.
   */
  it('leaves the day and the conversation to their owner', async () => {
    const limits = await store.effectiveSpendLimits(userId);
    expect(limits.dailyCapUsd).toBeNull();
    expect(limits.defaultTaskCapUsd).toBeNull();
    const { decision } = await monthlyWindow(1);
    expect(decision.windows.map((window) => window.name)).toEqual(['daily', 'monthly']);
    expect(decision.windows.find((window) => window.name === 'daily')?.capUsd).toBeNull();
  });

  it('lets an owner who declines a ceiling be done with the question', async () => {
    await store.setSpendLimits({ userId, monthlyCapUsd: null });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      monthlyCapUsd: null
    });
    const { decision } = await monthlyWindow(10_000);
    expect(decision.outcome).toBe('allow');
    expect(decision.windows.find((window) => window.name === 'monthly')?.capUsd).toBeNull();
  });

  /**
   * The boundary of what the default speaks for, pinned because it was briefly moved and moved back.
   *
   * Seeding the caps on the INSERT arm of `setSpendLimits` was tried, so that creating the row -
   * which is what stops the default applying - could not quietly delete a ceiling. It bought
   * nothing: the caps pane sends all three caps on every save whether the owner touched them or
   * not, so the only calls it changed were the deliberate partial ones, which it answered by
   * inventing a monthly ceiling nobody asked for. Saving one cap sets one cap.
   */
  it('sets the cap that was sent and no others', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 2 });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: 2,
      monthlyCapUsd: null
    });
  });

  it('takes the owner’s own ceiling over its own, in both directions', async () => {
    await store.setSpendLimits({ userId, monthlyCapUsd: 5 });
    await bill('under-their-ceiling', 4);
    await expect(monthlyWindow(2)).resolves.toMatchObject({
      decision: { outcome: 'deny', blockedBy: 'monthly' }
    });
    // And a later edit about something else does not hand it back to the default either.
    await store.setSpendLimits({ userId, warnAtPercent: 50 });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      monthlyCapUsd: 5,
      warnAtPercent: 50
    });
  });

  /**
   * The warning is the half of the brake the owner is meant to meet first, and it has to be reached
   * by the default rather than only by a cap somebody typed.
   */
  it('warns before it stops, on the ceiling nobody set', async () => {
    await bill('four-fifths', DEFAULT_MONTHLY_CAP_USD * 0.85);
    const { decision } = await monthlyWindow(0.01);
    expect(decision.outcome).toBe('warn');
    expect(decision.warnedBy).toContain('monthly');
  });
});
