/**
 * The usage term, attacked from both sides of every property it claims.
 *
 * Three things the owner asked of this score, and one they said was already missing:
 *
 *   1. nothing becomes unretrievable however old it is;
 *   2. fifty uses massed into a week rank below fifty spread over a year;
 *   3. a memory heavily used in one project fades rather than holding its weight;
 *   4. "positive as well as negative reinforcement" - a use that failed has to cost something.
 *
 * Every case below scores the SAME rows a second way, under the rule that shipped before it, and
 * asserts that the other rule gets the property wrong. That is what stops these being assertions
 * about arithmetic: the 90-day count and the un-decayed count are computed here over the real
 * `mem.item_use` rows the production writer left, so if the new score ever degenerates into either
 * of them the comparison collapses and the case fails.
 *
 * Everything runs through `recordMemoryUse` and `consolidateMemory` - the two methods
 * `apps/worker/src/memory-capture.ts` calls - against a real PGlite database with the shipped SQL.
 * Nothing here reimplements the score; the numbers come back off `mem.item.salience` and out of
 * `mem.prior` itself.
 */
import { randomUUID } from 'node:crypto';
import {
  MEMORY_SALIENCE_CITE_WEIGHT,
  MEMORY_SALIENCE_FAIL_WEIGHT,
  MEMORY_SALIENCE_USE_WEIGHT,
  MEMORY_USE_AGE_FLOOR_DAYS,
  MEMORY_USE_DECAY_EXPONENT,
  buildMemoryItemIndex,
  memoryIndexKey,
  planMemoryQuery
} from '@athanor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { DataStore } from './store.js';

const key = memoryIndexKey(Buffer.alloc(32, 11));
const NOW = new Date('2026-08-31T12:00:00.000Z');
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * 86_400_000);
/** Longer than any history a case here builds, so a pass folds nothing. */
const NEVER_FOLD = 100_000;

describe('the usage term', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace({
      userId,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  const add = async (subject: string, body: string): Promise<string> =>
    (
      await store.createMemoryItem({
        id: randomUUID(),
        userId,
        workspaceId,
        kind: 'fact',
        trust: 'stated',
        documentCiphertext: { v: 1, iv: 'x', tag: 'x', ciphertext: body },
        index: buildMemoryItemIndex(
          { title: subject, tags: [], body, subject, object: 'value' },
          key
        ),
        predicate: 'related_to',
        // Every row in every case shares one observation date, so the decay term in `mem.prior`
        // that is NOT under test here is identical across the rows being compared.
        observedAt: at(400),
        validFrom: at(400),
        pin: false
      })
    ).id;

  const use = (
    id: string,
    daysAgo: number,
    options: { cited?: boolean; failed?: boolean } = {}
  ): Promise<number> =>
    store.recordMemoryUse({
      workspaceId,
      itemIds: [id],
      usedAt: at(daysAgo),
      cited: options.cited ?? false,
      outcome: options.failed ? 'fail' : 'ok'
    });

  /** Salience and the prior it produces, off the rows, after the real nightly pass. */
  const scores = async (): Promise<Map<string, { salience: number; prior: number }>> => {
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const rows = await database.query<{ id: string; salience: number; prior: number }>(
      `SELECT id, salience,
              mem.prior(kind,trust,valid_to,observed_at,salience,pin,$2::timestamptz,FALSE) AS prior
       FROM mem.item WHERE workspace_id=$1`,
      [workspaceId, NOW]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { salience: Number(row.salience), prior: Number(row.prior) }])
    );
  };

  /**
   * The two rules this replaces, computed over the same rows.
   *
   * `windowed` is the shipped statement's `count(*) FILTER (WHERE used_at > now - INTERVAL '90
   * days')` verbatim; `total` is the same count with no window at all, which is what "sum over
   * every prior use" degenerates to if the decay is dropped. Each property below has to be wrong
   * under at least one of them, or the property is not doing any work.
   */
  const counts = async (): Promise<Map<string, { windowed: number; total: number }>> => {
    const rows = await database.query<{ id: string; windowed: string; total: string }>(
      `SELECT i.id,
              count(u.id) FILTER (
                WHERE u.used_at > $2::timestamptz - INTERVAL '90 days') AS windowed,
              count(u.id) AS total
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { windowed: Number(row.windowed), total: Number(row.total) }])
    );
  };

  it('leaves nothing at zero however old it is, where the 90-day window left everything there', async () => {
    const never = await add('alpha', 'never used at all');
    const decade = await add('bravo', 'used once ten years ago');
    const justOut = await add('charlie', 'used once ninety-one days ago');
    const justIn = await add('delta', 'used once eighty-nine days ago');

    await use(decade, 3650);
    await use(justOut, 91);
    await use(justIn, 89);

    const score = await scores();
    const salience = (id: string): number => score.get(id)!.salience;
    const prior = (id: string): number => score.get(id)!.prior;

    // Property 1, in the order it has to hold: more recent beats less recent, and the oldest use
    // in the workspace still beats no use at all. Every one of these is strict.
    expect(salience(justIn)).toBeGreaterThan(salience(justOut));
    expect(salience(justOut)).toBeGreaterThan(salience(decade));
    expect(salience(decade)).toBeGreaterThan(salience(never));
    expect(prior(decade)).toBeGreaterThan(prior(never));

    // The step across the old boundary is now two days of a power law rather than all of it.
    // 89d^-0.5 = 0.10600, 91d^-0.5 = 0.10483: a 1.1% difference in the activation, against the
    // 100% the window produced. Asserted as a bound rather than an equality so the number can be
    // read: if the decay were ever re-cliffed here this ratio would go to zero or to one.
    const activation = await database.query<{ id: string; s: number }>(
      `SELECT i.id, COALESCE(SUM(power(GREATEST(
                EXTRACT(EPOCH FROM $2::timestamptz - u.used_at)::float8/86400.0, $3::float8),
                -$4::float8)) FILTER (WHERE u.id IS NOT NULL), 0) AS s
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW, MEMORY_USE_AGE_FLOOR_DAYS, MEMORY_USE_DECAY_EXPONENT]
    );
    const raw = new Map(activation.rows.map((row) => [row.id, Number(row.s)]));
    expect(raw.get(justOut)! / raw.get(justIn)!).toBeGreaterThan(0.98);
    expect(raw.get(justOut)! / raw.get(justIn)!).toBeLessThan(1);
    // A single use ten years old is small and is not absent: 3650^-0.5.
    expect(raw.get(decade)).toBeCloseTo(0.016552, 6);
    expect(raw.get(never)).toBe(0);

    // AND THE RULE THIS REPLACES GETS IT WRONG. Under the 90-day count the ten-year-old use, the
    // ninety-one-day-old use and the row that was never used once are the same number, so no
    // ranking downstream of it could tell them apart.
    const count = await counts();
    expect(count.get(decade)!.windowed).toBe(0);
    expect(count.get(justOut)!.windowed).toBe(0);
    expect(count.get(never)!.windowed).toBe(0);
    expect(count.get(justIn)!.windowed).toBe(1);
  });

  it('ranks fifty uses spread over a year above fifty massed into a week of it', async () => {
    const massed = await add('echo', 'fifty uses inside one week, a year ago');
    const spread = await add('foxtrot', 'fifty uses spread across the same year');

    // Both histories hold fifty uses and both begin 365 days ago. The only difference is how they
    // are distributed, which is exactly the difference a count inside a window cannot see.
    for (let i = 0; i < 50; i += 1) await use(massed, 365 - (i * 7) / 49);
    for (let i = 0; i < 50; i += 1) await use(spread, 365 - (i * 365) / 49);

    const score = await scores();
    expect(score.get(spread)!.salience).toBeGreaterThan(score.get(massed)!.salience);
    expect(score.get(spread)!.prior).toBeGreaterThan(score.get(massed)!.prior);

    // AND THE RULE THIS REPLACES GETS IT WRONG. An un-decayed sum over every prior use - what is
    // left of ACT-R if the exponent goes to zero - scores the two histories identically at fifty,
    // and the 90-day window scores the massed history at zero, which is right for the wrong
    // reason: it is not ranking it lower, it is discarding it.
    const count = await counts();
    expect(count.get(massed)!.total).toBe(count.get(spread)!.total);
    expect(count.get(massed)!.total).toBe(50);
    expect(count.get(massed)!.windowed).toBe(0);
  });

  it('lets a burst from a finished project fade below a thinner history that is still running', async () => {
    // The owner's own words: "a particular memory may be very useful short term for a particular
    // project or two, but long term may be useless, and shouldn't have such high weight long term
    // just because it was used a lot short term."
    const burst = await add('golf', 'twenty-six uses in a project that ended seven months ago');
    const trickle = await add('hotel', 'five uses, one every two months, most recent today');

    for (let i = 0; i < 26; i += 1) await use(burst, 300 - (i * 87) / 25);
    for (let i = 0; i < 5; i += 1) await use(trickle, 240 - i * 60);

    const score = await scores();
    expect(score.get(trickle)!.salience).toBeGreaterThan(score.get(burst)!.salience);
    expect(score.get(trickle)!.prior).toBeGreaterThan(score.get(burst)!.prior);

    // AND THE RULE THIS REPLACES GETS IT WRONG, in both directions. A flat count over all history
    // puts the finished project five times ahead; the 90-day count throws away twenty-six of the
    // thirty-one uses in this workspace to reach the same ordering by deleting the evidence.
    const count = await counts();
    expect(count.get(burst)!.total).toBe(26);
    expect(count.get(trickle)!.total).toBe(5);
    expect(count.get(burst)!.windowed).toBe(0);
    expect(count.get(trickle)!.windowed).toBe(2);
  });

  it('charges a use that failed, which the retracted-only negative term never could', async () => {
    const never = await add('india', 'never used at all');
    const clean = await add('juliett', 'ten uses, every one cited, none failed');
    const failing = await add('kilo', 'ten uses, every one cited, every one failed');

    for (let i = 0; i < 10; i += 1) await use(clean, 10 - i, { cited: true });
    for (let i = 0; i < 10; i += 1) await use(failing, 10 - i, { cited: true, failed: true });

    const score = await scores();
    // The two histories are identical in every respect except the grade the harness watched, so
    // the whole distance between them is the negative term.
    expect(score.get(clean)!.salience).toBeGreaterThan(score.get(failing)!.salience);
    // And it is a real charge rather than a discount: a row that failed every time it was used
    // ranks BELOW a row that has never been used at all, which is what makes it reinforcement.
    // `use` and `fail` partition the uses, so ten failures leave the positive sum as empty as a
    // row with no history AND carry the whole of the negative one.
    expect(score.get(failing)!.salience).toBeLessThan(score.get(never)!.salience);
    expect(score.get(failing)!.prior).toBeLessThan(score.get(never)!.prior);
    // The old formula had this exactly inverted: +0.70 for the row that failed every time, the
    // highest in its workspace, and -0.70 for the row that never failed.
    expect(score.get(clean)!.salience).toBeGreaterThan(0);
    expect(score.get(failing)!.salience).toBeLessThan(0);

    // AND THE TERM THIS REPLACES COULD NOT HAVE FIRED. `neg_count` has one writer,
    // `retractMemoryItem`, which sets `status='retracted'` in the same statement - and no
    // admission predicate admits a retracted row. So the failing row here, ten failures out of
    // ten recorded through the production writer, carries neg_count = 0 and the old
    // `- 0.30 * (neg_count / use_count)` contributed exactly nothing to it.
    const counters = await database.query<{
      neg_count: number;
      fail_count: number;
      use_count: number;
      status: string;
    }>('SELECT neg_count, fail_count, use_count, status FROM mem.item WHERE id=$1', [failing]);
    expect(counters.rows[0]).toMatchObject({
      neg_count: 0,
      fail_count: 10,
      use_count: 10,
      status: 'active'
    });
    // The evidence the new term reads is on the use rows, where the writer actually put it.
    const graded = await database.query<{ n: string }>(
      "SELECT count(*) AS n FROM mem.item_use WHERE item_id=$1 AND outcome='fail'",
      [failing]
    );
    expect(Number(graded.rows[0]!.n)).toBe(10);
  });

  it('lets a negative salience reach the prior, which greatest(salience,0) clipped away', async () => {
    // `mem.prior` read `1.0 + 0.15 * ln(1 + greatest(salience, 0))`. Every negative salience -
    // which is what negative reinforcement produces - mapped onto the factor of a never-used row,
    // so fixing the term above without this would have changed nothing the ranking can see.
    const factor = await database.query<{
      neg: number;
      zero: number;
      pos: number;
      far: number;
      small: number;
    }>(
      `SELECT mem.prior('fact','stated',NULL,$1::timestamptz,(-1.0)::real,FALSE,$1::timestamptz,FALSE) AS neg,
              mem.prior('fact','stated',NULL,$1::timestamptz,(0.0)::real,FALSE,$1::timestamptz,FALSE) AS zero,
              mem.prior('fact','stated',NULL,$1::timestamptz,(1.0)::real,FALSE,$1::timestamptz,FALSE) AS pos,
              mem.prior('fact','stated',NULL,$1::timestamptz,(-1000.0)::real,FALSE,$1::timestamptz,FALSE) AS far,
              mem.prior('fact','stated',NULL,$1::timestamptz,(0.01)::real,FALSE,$1::timestamptz,FALSE) AS small`,
      [NOW]
    );
    const { neg, zero, pos, far, small } = factor.rows[0]!;
    expect(Number(neg)).toBeLessThan(Number(zero));
    expect(Number(zero)).toBeLessThan(Number(pos));
    // Strictly positive at every finite salience. A prior that crossed zero would invert the
    // ranking it multiplies, and salience is an unbounded weighted sum of z-scores: with a
    // workspace large enough, one row's z can reach sqrt(n-1) and drag another's far negative.
    expect(Number(far)).toBeGreaterThan(0);
    // Unchanged to first order at the origin, which is what makes this a repair rather than a
    // retune: exp(0.15*asinh(s)) and the 1 + 0.15*ln(1+s) it replaces agree to within 1e-5 at
    // s = 0.01, and diverge only where the old shape was clipping or flattening anyway.
    expect(Number(small) / Number(zero)).toBeCloseTo(1.0 + 0.15 * Math.log(1.01), 4);
  });

  it('keeps the activation across the retention horizon, where a bare delete lost it', async () => {
    // `consolidateMemory` used to DELETE `mem.item_use` past `useRetentionDays`. A sum over every
    // prior use cannot be taken against a table that forgets, so the rows are folded into
    // `mem.item_use_fold` and their contribution recovered from the span in closed form.
    const long = await add('lima', 'a hundred uses across two years');
    const short = await add('mike', 'ten recent uses');
    for (let i = 0; i < 100; i += 1) await use(long, 730 - i * 7, { cited: i % 3 === 0 });
    for (let i = 0; i < 10; i += 1) await use(short, 10 - i);

    const before = await scores();
    const liveBefore = await database.query<{ n: string }>(
      'SELECT count(*) AS n FROM mem.item_use WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(liveBefore.rows[0]!.n)).toBe(110);

    // The real retention pass, at the shipped horizon, twice - a second fold must widen the span
    // rather than count the same block again.
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: 180 });
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: 180 });

    const folds = await database.query<{
      item_id: string;
      uses: number;
      cites: number;
      fails: number;
    }>('SELECT item_id,uses,cites,fails FROM mem.item_use_fold');
    expect(folds.rows).toHaveLength(1);
    expect(folds.rows[0]!.item_id).toBe(long);
    expect(folds.rows[0]!.uses).toBe(79);
    expect(folds.rows[0]!.cites).toBe(27);
    const liveAfter = await database.query<{ n: string }>(
      'SELECT count(*) AS n FROM mem.item_use WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(liveAfter.rows[0]!.n)).toBe(31);

    // Same instant, same history, 79 of its 110 rows now living as one aggregate: the score has
    // to be the same score. The bound is three decimal places of salience, and the measured worst
    // case across every row in this workspace is an order of magnitude inside it.
    const after = await scores();
    for (const [id, row] of after)
      expect(Math.abs(row.salience - before.get(id)!.salience)).toBeLessThan(1e-3);

    // AND WITHOUT THE FOLD IT IS LOST. Deleting the aggregate is exactly what the old DELETE did
    // to those seventy-nine uses, and it takes two years of history down to the last six months.
    const withFold = (await scores()).get(long)!.salience;
    await database.query('DELETE FROM mem.item_use_fold WHERE item_id=$1', [long]);
    const withoutFold = (await scores()).get(long)!.salience;
    expect(withoutFold).toBeLessThan(withFold);
  });

  it('returns the difference through the recall query the worker actually calls', async () => {
    // Everything above reads `mem.item.salience` off the row. This reads the pack: two rows that
    // answer the same question, distinguished only by a use history the 90-day window scored as a
    // tie, ranked by the shipped fusion SQL through the shipped public method.
    const stale = await add('november', 'the relay listens on port 8443 in the amber deployment');
    const livelier = await add('oscar', 'the relay listens on port 8443 in the beryl deployment');
    for (let i = 0; i < 12; i += 1) await use(stale, 400 - i * 5);
    for (let i = 0; i < 12; i += 1) await use(livelier, 300 - i * 15);

    const count = await counts();
    expect(count.get(stale)!.windowed).toBe(0);
    expect(count.get(livelier)!.windowed).toBe(0);
    expect(count.get(stale)!.total).toBe(count.get(livelier)!.total);

    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const plan = planMemoryQuery('which port does the relay listen on', key);
    const pack = await store.recallMemoryCandidates({ workspaceId, plan, now: NOW });
    const scored = new Map(pack.map((row) => [row.id, row.score]));
    expect(scored.has(stale)).toBe(true);
    expect(scored.has(livelier)).toBe(true);
    // `score` is `rrf * mem.prior(...)` out of the shipped statement. Both rows match the question
    // identically and were observed on the same day, so the whole difference is the use history.
    expect(scored.get(livelier)!).toBeGreaterThan(scored.get(stale)!);

    // And it survives the cut. A pack with room for one row keeps the livelier history; under the
    // 90-day count both rows scored zero uses and the tie was broken by row id.
    const one = await store.recallMemoryCandidates({
      workspaceId,
      plan,
      now: NOW,
      maxItems: 1,
      order: 'relevance'
    });
    expect(one.map((row) => row.id)).toEqual([livelier]);
  });

  it('states the two shapes the weights and the exponent have to keep', async () => {
    // The fold's closed form divides by (1 - d) and the sum diverges at t = 0, so the exponent has
    // to sit strictly inside the unit interval and the age floor strictly above zero. Neither is a
    // range anybody would choose from, and both are what the SQL silently assumes.
    expect(MEMORY_USE_DECAY_EXPONENT).toBeGreaterThan(0);
    expect(MEMORY_USE_DECAY_EXPONENT).toBeLessThan(1);
    expect(MEMORY_USE_AGE_FLOOR_DAYS).toBeGreaterThan(0);

    // "I agree with positive as well as negative reinforcement", and negative has to carry more
    // per unit than citation - which is a comparison that can only be made because all three are
    // now z-scores of the same construction rather than two z-scores and a rate.
    expect(MEMORY_SALIENCE_FAIL_WEIGHT).toBeGreaterThan(MEMORY_SALIENCE_CITE_WEIGHT);
    // And the same event graded the other way moves the score by the same magnitude, because
    // `use` and `fail` partition the uses and nothing measures a success as bigger than a failure.
    expect(MEMORY_SALIENCE_FAIL_WEIGHT).toBe(MEMORY_SALIENCE_USE_WEIGHT);
  });
});
