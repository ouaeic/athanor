/**
 * The checks the table cannot perform, run on every invocation rather than behind a flag.
 *
 * Two kinds. The first re-derives the property the whole corpus rests on - that a probe's answer is
 * NOT in the tier `mem.source` indexes - from the turns themselves rather than from the miner that
 * built the probes, so a bug in the miner cannot vouch for its own output. The second reads the
 * fall table and asserts that each fault actually bit; a defect that has stopped failing is a rig
 * that has stopped measuring, and it looks identical to a green run from the outside.
 *
 * Every loop over a collection asserts the collection is non-empty first. This repository has
 * shipped a proof that ran zero times and reported a guarantee it was not making more than twenty
 * times, including a command-injection guard.
 */
import { MIN_PROJECTS, MIN_TURNS } from './report.js';
import { REACH_BOUND } from './measure.js';
import type { OwnerTurn, Probe } from './corpus.js';
import type { Rollup } from './measure.js';

interface Row {
  readonly name: string;
  readonly rollup: Rollup;
}

const rateOf = (row: Row | undefined, pick: (rollup: Rollup) => number): number | null =>
  row && row.rollup.n > 0 ? pick(row.rollup) / row.rollup.n : null;

export const selfTest = (
  probes: readonly Probe[],
  turns: readonly OwnerTurn[],
  rows: readonly Row[]
): string[] => {
  const problems: string[] = [];

  if (turns.length < MIN_TURNS)
    problems.push(`${turns.length} owner turns, under the floor of ${MIN_TURNS}`);
  const projects = new Set(turns.map((turn) => turn.project)).size;
  if (projects < MIN_PROJECTS)
    problems.push(`${projects} projects, under the floor of ${MIN_PROJECTS}`);
  if (probes.length === 0) {
    problems.push('no probes were mined, so nothing below ran');
    return problems;
  }

  /*
   * The exclusion, re-derived.
   *
   * `recordTurnEpisode` stores exactly two strings per turn - the request and the summary - so
   * those two, over every turn in the corpus, ARE the tier a search can reach. Checking the gold
   * against them here is checking it against the thing the store will actually hold, rather than
   * against the miner's own idea of it.
   */
  const indexedTier = turns.map((turn) => `${turn.request}\n${turn.summary}`).join('\n');
  let checkedExclusion = 0;
  for (const probe of probes) {
    checkedExclusion += 1;
    if (indexedTier.includes(probe.gold))
      problems.push(
        `${probe.id}: its gold is in the tier mem.source indexes, so the verbatim search answers it and the reach is not what is being measured`
      );
    if (probe.question.includes(probe.gold))
      problems.push(`${probe.id}: the question contains its own answer`);
    if (probe.terms.length === 0) problems.push(`${probe.id}: no question terms, so nothing ranks`);
  }
  if (checkedExclusion === 0) problems.push('the exclusion check ran over no probes');

  /*
   * The probe against the turn it was mined from: the cited call has to exist, and its result has
   * to be the only one in that turn holding the gold. Both are the miner's own promises, checked
   * against the transcript rather than against the miner.
   */
  const turnOf = new Map(turns.map((turn) => [turn.uuid, turn]));
  let checkedCitations = 0;
  for (const probe of probes) {
    const turn = turnOf.get(probe.turnUuid);
    if (!turn) {
      problems.push(`${probe.id}: its turn is not in the corpus`);
      continue;
    }
    checkedCitations += 1;
    const holders = turn.calls.filter((call) => call.resultText.includes(probe.gold));
    if (holders.length !== 1)
      problems.push(
        `${probe.id}: ${holders.length} of the turn's results hold the gold, so the citation does not have to be right`
      );
    if (holders[0] && holders[0].id !== probe.citedCallId)
      problems.push(`${probe.id}: the cited call is not the one whose result holds the gold`);
  }
  if (checkedCitations === 0) problems.push('the citation check ran over no probes');

  /*
   * Both sides of the reach's own character bound have to be exercised, or the rig is silently
   * measuring one regime and reporting it as the number.
   */
  const beyond = probes.filter((probe) => probe.goldOffset >= REACH_BOUND).length;
  if (beyond === 0)
    problems.push('no probe has its gold past the reach bound, so that ceiling is untested');
  if (beyond === probes.length)
    problems.push(
      'every probe has its gold past the reach bound, so nothing could ever be reached'
    );

  /* ---- The fall table: each fault has to have bitten. ---- */
  if (rows.length > 1) {
    const shipped = rows.find((row) => row.name === 'shipped');
    const red = rows.find((row) => row.name === 'no-citation');
    const pointer = rows.find((row) => row.name === 'pointer-only');
    const exact = rows.find((row) => row.name === 'span-exact');
    const shifted = rows.find((row) => row.name === 'span-shifted');
    const shippedAt2 = rateOf(shipped, (rollup) => rollup.reachedAt2);
    if (shippedAt2 !== null && shippedAt2 <= 0)
      problems.push('the shipped reach answered nothing, so no fault below can be seen to bite');
    for (const [name, row] of [
      ['no-citation', red],
      ['pointer-only', pointer]
    ] as const) {
      const rate = rateOf(row, (rollup) => rollup.reachedAt2);
      if (rate === null) continue;
      if (shippedAt2 !== null && rate >= shippedAt2)
        problems.push(
          `${name} scored ${(rate * 100).toFixed(1)}% against shipped's ${(shippedAt2 * 100).toFixed(1)}%, so that defect no longer changes the answer`
        );
    }
    const exactVerbatim = rateOf(exact, (rollup) => rollup.verbatimAt1);
    const shiftedVerbatim = rateOf(shifted, (rollup) => rollup.verbatimAt1);
    if (exactVerbatim !== null && shiftedVerbatim !== null && shiftedVerbatim >= exactVerbatim)
      problems.push(
        `the shifted span returned the same verbatim text as the exact one (${(shiftedVerbatim * 100).toFixed(1)}% vs ${(exactVerbatim * 100).toFixed(1)}%), so the span arithmetic is not being read`
      );
  }

  return problems;
};
