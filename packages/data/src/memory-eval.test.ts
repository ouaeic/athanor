import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY_KINDS, MEMORY_PACK_QUOTAS, memoryIndexKey, planMemoryQuery } from '@athanor/core';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { DataStore } from './store.js';
import {
  ALWAYS_ON_REFS,
  MEMORY_EVAL_ITEMS,
  MEMORY_EVAL_PACK_CAPACITY,
  MEMORY_EVAL_PROBES,
  MEMORY_EVAL_SESSION_PROBES,
  MEMORY_EVAL_SESSION_SEARCH_K,
  MEMORY_EVAL_SOURCES,
  MEMORY_EVAL_UNBOUNDED_QUOTAS,
  formatMemoryEvalReport,
  formatMemoryEvalSearchReport,
  runMemoryRecallEval,
  runMemorySessionSearchEval,
  runSubstringSessionSearchEval,
  seedMemoryEvalCorpus,
  type MemoryEvalReport,
  type MemoryEvalSearchReport,
  type MemoryEvalSeed
} from './memory-eval.js';

/**
 * The committed numbers.
 *
 * These are measurements, not aspirations - what this corpus scores today, so that a change which
 * lowers any of them fails here rather than being argued about. That is the whole reason this file
 * exists: every claim the memory code made about its own retrieval was unfalsifiable before it.
 *
 * Recall alone is not enough to hold, because recall is buyable. A pack that returns everything
 * scores one, so it is committed alongside two numbers that a bigger pack cannot move in its
 * favour: the rank of the answer, which a wider net leaves exactly where it was, and the tokens
 * spent getting there. All three move together or the change is a trade someone has to justify.
 *
 * A drop is a regression to investigate, not a number to lower - and a probe the store genuinely
 * cannot answer yet is not a reason to move one either. That probe is marked `expectedMiss` and
 * scored out, so these stay at exactly what answerable retrieval achieves; lowering a floor for it
 * would leave room underneath for a real regression on a different probe to net out and pass.
 */
const MIN_PACK_RECALL = 1;
const MIN_CANDIDATE_RECALL = 1;
/** Today's 0.445: the answer is around second or third of everything the pack came back with. */
const MIN_MRR = 0.43;
/** Today's 410, against a 6,000 token budget. The budget is not what is keeping this small. */
const MAX_PACK_TOKENS = 450;

/**
 * The controls, which are what make every number above a measurement rather than a statistic.
 *
 * Today: ranked scores 100.0% at MRR 0.445; the same budget filled from the same reachable rows in
 * a seeded arbitrary order scores 16.3% at 0.030; an empty pack scores 7.0%, which is exactly the
 * abstention probes whose correct answer is no pack at all.
 *
 * Committed as ceilings. A control drifting upward means it has stopped controlling - the corpus
 * has grown guessable, or a probe has - and the headline number above it stops meaning what it
 * says long before it visibly falls.
 */
const MAX_RANDOM_RECALL = 0.25;

/**
 * Measured, so it is not argued about again: the `entity` and `procedure` quotas reserve 8% and 15%
 * of the pack budget for kinds nothing currently writes, and removing them moves recall not at all,
 * MRR not at all, and the pack by six tokens. Shares only bind when the corpus presses on the
 * budget, and a 410-token pack against 6,000 does not. The quotas are not the reason to write those
 * kinds, and they are not worth deleting either.
 */
const MAX_RANDOM_MRR = 0.08;
const MAX_EMPTY_RECALL = 0.12;

describe('memory retrieval eval', () => {
  let database: Database;
  let store: DataStore;
  let seed: MemoryEvalSeed;
  let workspaceId: string;
  let packRun: MemoryEvalReport;

  const key = memoryIndexKey(Buffer.alloc(32, 11));
  const now = new Date('2026-07-31T08:00:00.000Z');

  const run = async (
    options: {
      budgetTokens?: number;
      maxItems?: number;
      quotas?: typeof MEMORY_PACK_QUOTAS;
      pack?: 'ranked' | 'empty' | 'random';
    } = {}
  ): Promise<MemoryEvalReport> =>
    runMemoryRecallEval({ store, workspaceId, key, now, seed, ...options });

  // Seeded once rather than per test: every probe here reads, none writes, and standing the corpus
  // up eleven times was most of this file's runtime.
  beforeAll(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'eval-owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
    seed = await seedMemoryEvalCorpus({
      store,
      userId: user.id,
      workspaceId,
      key,
      now
    });
    packRun = await run();
  }, 120_000);

  afterAll(async () => database.close());

  it('beats an empty pack and a pack nobody ranked, which is what makes the rest a measurement', async () => {
    /**
     * The denominator. Every other number in this file is an absolute - recall 1.0 at 410 tokens -
     * and an absolute is unreadable without knowing two things: whether the questions answer
     * themselves, and what the same 410 tokens of the same corpus would have scored if nobody had
     * ranked them.
     *
     * The empty arm answers the first. It sends no pack at all, so anything it scores is a probe
     * measuring its own question rather than the store, and the number is committed as a ceiling.
     *
     * The random arm answers the second. It fills the identical budget from the identical
     * reachable rows in a seeded arbitrary order, so the only difference from the ranked arm is
     * the ordering. It is committed as a ceiling too: if the ranked arm ever fails to clear it,
     * the ranking is decoration and this test says so rather than the numbers merely looking
     * respectable on their own.
     */
    const empty = await run({ pack: 'empty' });
    const random = await run({ pack: 'random' });

    // An empty pack can still "hit" the abstention probes, whose correct answer is nothing at all -
    // so this is bounded rather than zero, and the answerable probes are what it must not reach.
    const answerable = MEMORY_EVAL_PROBES.filter((probe) => probe.gold.length > 0).map(
      (probe) => probe.id
    );
    const emptyAnswered = empty.probes.filter(
      (result) => result.hit && answerable.includes(result.id)
    );
    expect(emptyAnswered, 'a probe that scores with no pack is measuring its own question').toEqual(
      []
    );

    // The ranking has to be worth its place against arbitrary rows at the same price.
    expect(random.recall).toBeLessThan(packRun.recall);
    expect(random.mrr).toBeLessThan(packRun.mrr);
    // And the gap has to be large rather than incidental.
    expect(packRun.recall - random.recall).toBeGreaterThan(0.3);

    // Today's measurements, committed as ceilings rather than floors. A control that drifts upward
    // is a control that has stopped controlling: if the random arm starts scoring well, either the
    // corpus has become small enough that any rows answer anything, or a probe has become
    // guessable - and either way the ranked number above it has stopped meaning what it says.
    expect(random.recall).toBeLessThan(MAX_RANDOM_RECALL);
    expect(random.mrr).toBeLessThan(MAX_RANDOM_MRR);
    expect(empty.recall).toBeLessThan(MAX_EMPTY_RECALL);
  }, 120_000);

  it('holds more rows than the pack can carry, so every number below is a choice', () => {
    // Without this the eval measures nothing. Twenty-eight rows against a pack that holds
    // fifty-two let every channel admit everything it matched, and quotas, fusion weights, the
    // prior and the per-subject cap were all scored by a corpus that never made them decide.
    expect(MEMORY_EVAL_ITEMS.length + MEMORY_EVAL_SOURCES.length).toBeGreaterThan(
      MEMORY_EVAL_PACK_CAPACITY
    );
    expect(packRun.pressure).toBeGreaterThan(1);
  });

  it('retrieves the gold row into the emitted pack for the committed share of probes', () => {
    expect(packRun.recall, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(MIN_PACK_RECALL);
    // A retired value coming back for a present-tense question is worse than retrieving nothing.
    expect(packRun.leaks).toEqual([]);
  });

  it('holds the paraphrase gap open in both directions rather than tolerating it', () => {
    // A probe scored out of every number above is only honest while it really does miss. Asserting
    // that is the half worth having: if some later change reaches it, this fails and says to
    // promote the probe, instead of the gap closing and the eval still describing it as open.
    const known = MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss);
    expect(known.length).toBeGreaterThan(0);
    expect(packRun.expectedMisses).toEqual(known.map((probe) => probe.id));
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    for (const probe of known)
      expect(
        byId.get(probe.id)?.hit,
        `${probe.id} now hits - drop its expectedMiss and let it be scored`
      ).toBe(false);
  });

  it('ranks the answer near the top, which membership in a large pack does not show', () => {
    // The metric for a recall the agent asks for mid-task: it reads from the top and stops. A
    // change that widens the net lifts recall and leaves this untouched, which is the point.
    expect(packRun.mrr, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(MIN_MRR);
    for (const probe of packRun.probes)
      if (probe.hit && probe.rank !== null)
        expect(probe.rank, `${probe.id} answered at rank ${probe.rank}`).toBeLessThanOrEqual(12);
  });

  it('pays for that recall in tokens the owner would not begrudge', () => {
    expect(packRun.packTokens, formatMemoryEvalReport(packRun)).toBeLessThanOrEqual(
      MAX_PACK_TOKENS
    );
  });

  it('admits the gold row into some channel at all, which is the ceiling every k sits under', async () => {
    // Budget, item cap and every quota lifted: what is left is purely the tokenizer, the planner
    // and the admission predicates. A row that misses here is unreachable at any k, not merely
    // outranked. Lifting the budget alone was not enough - the per-kind and per-subject caps are
    // separate limits, so that run scored the same rows as the pack and agreed with itself.
    const result = await run({
      budgetTokens: 1_000_000,
      maxItems: 200,
      quotas: MEMORY_EVAL_UNBOUNDED_QUOTAS
    });
    expect(result.recall, formatMemoryEvalReport(result)).toBeGreaterThanOrEqual(
      MIN_CANDIDATE_RECALL
    );
    // The known gap is read off the same run, because this is where it means something: the probe
    // is unreachable rather than outranked, which is what makes it a missing channel and not a
    // tuning loss the next weight change could fix.
    const admitted = new Map(result.probes.map((probe) => [probe.id, probe]));
    for (const probe of MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss))
      expect(admitted.get(probe.id)?.found, formatMemoryEvalReport(result)).toEqual([]);
    // The ceiling must be a different measurement from the pack, or one of them is redundant.
    expect(result.packTokens).toBeGreaterThan(packRun.packTokens);
  });

  it('returns the same rows in stable order as in relevance order', async () => {
    // The eval reads in relevance order because that is the surface an agent-initiated recall uses
    // and the only one that yields a rank. That is sound only while `order` reaches the final
    // ORDER BY and nothing else - if it ever starts selecting rows, every number here shifts
    // underneath the pack the agent is actually given, which is built in stable order.
    const plan = planMemoryQuery('what port does the relay listen on', key);
    const [stable, relevance] = await Promise.all([
      store.recallMemoryCandidates({ workspaceId, plan, now }),
      store.recallMemoryCandidates({ workspaceId, plan, now, order: 'relevance' })
    ]);
    expect([...stable].map((row) => row.id).sort()).toEqual(
      [...relevance].map((row) => row.id).sort()
    );
    // (kind, id), where kind sorts in the order mem.kind declares rather than alphabetically -
    // which is also the order the rendered pack lays its sections out in.
    const stably = (row: { kind: (typeof MEMORY_KINDS)[number]; id: string }): string =>
      `${MEMORY_KINDS.indexOf(row.kind)}:${row.id}`;
    expect(stable.map(stably)).toEqual([...stable].map(stably).sort());
    expect(relevance.map((row) => row.score)).toEqual(
      [...relevance.map((row) => row.score)].sort((left, right) => right - left)
    );
  });

  it('ranks a fact by the words of the question, not by which fact is newest', () => {
    // The regression this corpus caught: the structural channel admitted every fact about a
    // matched subject, ranked them by recency and fused them at the heaviest weight of any
    // channel, so for `owner` - the subject of every stated preference - the nine facts came back
    // in date order and the per-subject cap kept the newest four. The row titled "working
    // languages" was eighth, and unreachable at any k.
    const probe = packRun.probes.find((entry) => entry.id === 'owner-language');
    expect(probe?.missed).toEqual([]);
    expect(probe?.rank ?? Infinity).toBeLessThanOrEqual(4);
  });

  it('finds a fact about a named service from the words a person asks it by', () => {
    // Subject 'athanor-relay' shares no lexeme with 'relay', so before the alias surface this
    // question reached no channel at all.
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    expect(byId.get('relay-port-plain')?.missed).toEqual([]);
    expect(byId.get('relay-down-after-reboot')?.found.length).toBeGreaterThan(0);
    expect(byId.get('idle-setting-by-words')?.found.length).toBeGreaterThan(0);
  });

  it('keeps a question with no answer in the store from filling the pack with near misses', () => {
    const abstentions = packRun.probes.filter((probe) => probe.type === 'abstention');
    expect(abstentions.length).toBeGreaterThan(0);
    // Only what the owner pinned, which is a standing instruction rather than an answer.
    for (const probe of abstentions) {
      expect(probe.hit, `${probe.id} returned ${probe.returned} rows`).toBe(true);
      expect(probe.returned).toBeLessThanOrEqual(ALWAYS_ON_REFS.size);
    }
  });

  it('answers a present-tense and a past-tense question about the same fact differently', () => {
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    expect(byId.get('shell-now')?.hit).toBe(true);
    expect(byId.get('shell-now')?.leaked).toEqual([]);
    expect(byId.get('shell-before')?.hit).toBe(true);
  });

  it('searches the verbatim layer and reads the turns around a hit', async () => {
    const hits = await store.searchMemorySources({
      workspaceId,
      // Stemming is the whole point: the transcript says "restart", the question says "restarted".
      plan: planMemoryQuery('relay restarted and did not come back', key),
      limit: 10
    });
    const refOf = new Map([...seed.sourceIds].map(([ref, id]) => [id, ref]));
    const found = hits.map((hit) => refOf.get(hit.id)).filter(Boolean);
    expect(found).toContain('relay-turn-user');
    expect(hits.every((hit) => hit.score > 0)).toBe(true);

    const anchorId = seed.sourceIds.get('relay-turn-agent')!;
    const window = await store.listMemorySourceWindow(workspaceId, anchorId, {
      before: 1,
      after: 1
    });
    const windowRefs = window.map((row) => refOf.get(row.id));
    expect(windowRefs).toEqual(['relay-turn-user', 'relay-turn-agent', 'relay-turn-tool']);
  });

  it('restricts a verbatim search to one past conversation when asked to', async () => {
    const conversation = seed.conversations.get('mail-morning')!;
    const hits = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('how often does the connector poll', key),
      taskId: conversation,
      limit: 10
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.taskId === conversation)).toBe(true);
  });

  it('reports write cost beside accuracy so a slower write path cannot hide behind recall', () => {
    expect(packRun.writeCost.items).toBe(MEMORY_EVAL_ITEMS.length);
    expect(packRun.writeCost.sources).toBe(MEMORY_EVAL_SOURCES.length);
    expect(packRun.writeCost.indexedBytes).toBeGreaterThan(0);
    expect(formatMemoryEvalReport(packRun)).toContain('recall ');
  });

  it('covers every question type and gives every probe a resolvable gold set', () => {
    const types = new Set(MEMORY_EVAL_PROBES.map((probe) => probe.type));
    expect([...types].sort()).toEqual([
      'abstention',
      'knowledge_update',
      'multi_session',
      'preference',
      'single_session_fact',
      'temporal_reasoning'
    ]);
    const refs = new Set([
      ...MEMORY_EVAL_ITEMS.map((item) => item.ref),
      ...MEMORY_EVAL_SOURCES.map((source) => source.ref)
    ]);
    for (const probe of MEMORY_EVAL_PROBES)
      for (const ref of [...probe.gold, ...(probe.forbidden ?? [])])
        expect(refs.has(ref), `${probe.id} references unknown ${ref}`).toBe(true);
  });

  it('gives every declared memory kind a quota, so none can be ranked and then dropped', () => {
    const quota = new Set(MEMORY_PACK_QUOTAS.map((entry) => entry.kind));
    for (const kind of MEMORY_KINDS) expect(quota.has(kind), `no quota for ${kind}`).toBe(true);
  });

  /* --- searching past conversations --------------------------------------- *
   *
   * The committed numbers, measured on this corpus at k=5, against the substring scan they
   * replaced:
   *
   *   recall@5   83.3% -> 100%    (10/12 -> 12/12)
   *   mrr        0.556 -> 0.642
   *   opened     23.0  -> 2.8     bodies decrypted per question
   *
   * Both misses the scan had are ranking, not admission: "where did the database dump get written"
   * and "can the runner be reached from outside the box" both share words with their answer, and
   * both lost the top five to turns that shared more common words. That is what a score with no
   * document frequency in it does.
   *
   * The accuracy delta is the smaller half of this, and saying otherwise on twenty-three turns
   * would be dishonest - almost anything finds an answer in a corpus that small. The number that
   * does not flatter the corpus is the last one: the scan opens every stored body in the workspace
   * to score it, because its score is computed over plaintext, and that grows with the owner's
   * whole history for every question they ever ask. The index opens what it returns. */
  const MIN_SESSION_RECALL = 1;
  /** Today's 0.642: the answer is first or second of what came back. */
  const MIN_SESSION_MRR = 0.62;
  /** Today's 2.8, against a k of 5. Nothing is opened that was not returned. */
  const MAX_SESSION_DECRYPTED = 3;

  let sessionRun: MemoryEvalSearchReport;
  const baseline = runSubstringSessionSearchEval();

  beforeAll(async () => {
    sessionRun = await runMemorySessionSearchEval({ store, workspaceId, key, seed });
  }, 120_000);

  it('finds the turn that answers a question worded months later', async () => {
    expect(
      sessionRun.recall,
      formatMemoryEvalSearchReport('index', sessionRun)
    ).toBeGreaterThanOrEqual(MIN_SESSION_RECALL);
    expect(
      sessionRun.mrr,
      formatMemoryEvalSearchReport('index', sessionRun)
    ).toBeGreaterThanOrEqual(MIN_SESSION_MRR);
    for (const probe of sessionRun.probes)
      expect(probe.returned).toBeLessThanOrEqual(MEMORY_EVAL_SESSION_SEARCH_K);
  });

  it('beats the substring scan it replaced, and opens a fraction of the store to do it', () => {
    const report = [
      formatMemoryEvalSearchReport('substring', baseline),
      formatMemoryEvalSearchReport('index', sessionRun)
    ].join('\n');
    expect(sessionRun.recall, report).toBeGreaterThan(baseline.recall);
    expect(sessionRun.mrr, report).toBeGreaterThan(baseline.mrr);
    // The structural difference, and the only one that does not depend on the corpus being small.
    expect(sessionRun.decryptedPerProbe, report).toBeLessThanOrEqual(MAX_SESSION_DECRYPTED);
    expect(baseline.decryptedPerProbe).toBe(MEMORY_EVAL_SOURCES.length);
  });

  it('asks every session probe in words the transcript does not use', () => {
    // The probe set only measures ranking if the questions are paraphrases. A probe whose wording
    // is lifted from its own gold turn passes on any retrieval at all and reports nothing.
    const bodyOf = new Map(MEMORY_EVAL_SOURCES.map((source) => [source.ref, source.body]));
    for (const probe of MEMORY_EVAL_SESSION_PROBES) {
      expect(probe.gold.length, `${probe.id} has no gold turn`).toBeGreaterThan(0);
      for (const ref of probe.gold) {
        const body = bodyOf.get(ref);
        expect(body, `${probe.id} references unknown source ${ref}`).toBeDefined();
        expect(
          body?.toLowerCase().includes(probe.question.toLowerCase()),
          `${probe.id} is quoted from its own answer`
        ).toBe(false);
      }
    }
  });
});
