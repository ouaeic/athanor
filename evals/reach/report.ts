/**
 * The table, the baseline, and the gates on the rig itself.
 *
 * Three kinds of failure live here and they are independent, because a committed baseline can only
 * ever say "this is what it did last time" - which is exactly the check that cannot tell a working
 * instrument from one that has stopped reading its input.
 *
 * 1. **The corpus gates.** The mined corpus has to look like the owner's corpus: enough turns,
 *    enough projects, enough probes, and no probe whose gold is answerable from the tier that is
 *    supposed not to hold it. A rig that mined four probes out of one conversation would satisfy a
 *    baseline perfectly and be measuring nothing.
 * 2. **The separation gate.** `shipped` must beat `no-citation` by a stated margin. This is the
 *    one that catches an instrument that has gone flat: a reach that returned the whole
 *    conversation regardless of what was cited would score well on both rows and fail here.
 * 3. **The baseline**, under `--ci` only, one-sidedly on the headline: reaching FEWER probes than
 *    last time fails, reaching more passes, because more is the work.
 */
import type { CorpusBasis, Probe } from './corpus.js';
import type { Rollup } from './measure.js';

/** One arrangement's committed numbers. Aggregates only - see `baselineFrom`. */
export interface BaselineRow {
  readonly n: number;
  readonly reachedAt1: number;
  readonly reachedAt2: number;
  readonly reachedViaSearch: number;
  readonly verbatimAt1: number;
}

export interface Baseline {
  readonly $stamp?: {
    readonly acceptedAt: string;
    readonly corpus: CorpusBasis;
    readonly digest: string;
    readonly probes: number;
  };
  readonly [row: string]: BaselineRow | Baseline['$stamp'] | undefined;
}

export interface Run {
  readonly basis: CorpusBasis;
  readonly digest: string;
  readonly rows: readonly { name: string; note: string; rollup: Rollup }[];
  readonly probes: readonly Probe[];
}

/* ------------------------------------------------------------------------------ the rig's gates */

/** Floors the corpus has to clear before any number measured over it means anything. */
export const MIN_TURNS = 500;
export const MIN_PROJECTS = 8;
export const MIN_PROBES = 60;
/** `shipped` must reach at least this many times what the red baseline reaches. */
export const MIN_SEPARATION = 10;

/**
 * How far a row may move before the baseline calls it a regression, measured rather than picked.
 *
 * Nine runs of the same arrangement over the SAME frozen 146 probes, with the workspace key and the
 * ranking clock both fixed, still spread: `reach@1` over 54.1-56.2 (three probes), `reach@2*` over
 * 84.2-87.0 (four), `verbatim@1` over 46.6-50.0 (five). `reach@2`, `packed`, `ranked` and `located`
 * were identical on all nine.
 *
 * The spread is not this rig's. It is three production `ORDER BY`s whose last term is a random
 * UUID - `MEMORY_SOURCE_SEARCH_SQL`'s `ORDER BY s DESC, sc.id`, `listMemoryEvidence`'s
 * `ORDER BY s.occurred_at, s.chunk_ix, e.source_id`, and the pack's `(kind, id)` - resolving ties
 * differently every time the store is stood up again. On a running box those ids are minted once
 * and the order is then fixed, so this is a rig cost rather than a product one; a rig that re-seeds
 * pays it on every run.
 *
 * The gate below compares `reach@1` and nothing else, so `SLACK_SHIPPED` is three points - the
 * observed 2.1 plus one probe. `SLACK_FAULT` is one point, because the fault rows measured exactly
 * 0.0% on nine runs out of nine and have no spread to allow for. A gate tighter than the
 * instrument's own noise is a gate that fires on nothing.
 */
export const SLACK_SHIPPED = 0.03;
export const SLACK_FAULT = 0.01;

/**
 * What must hold for this run to have measured anything, whatever the numbers are.
 *
 * `probes` is checked for the property the whole corpus rests on - that no gold is also in the
 * question - because that is the one way this rig could report a high number while measuring
 * nothing at all, and it costs a substring test per probe to refuse.
 */
export const rigFailures = (
  rows: readonly { name: string; note: string; rollup: Rollup }[],
  probes: readonly Probe[]
): string[] => {
  const problems: string[] = [];
  if (probes.length < MIN_PROBES)
    problems.push(`mined ${probes.length} probes, which is under the floor of ${MIN_PROBES}`);
  const selfAnswering = probes.filter((probe) => probe.question.includes(probe.gold));
  if (selfAnswering.length)
    problems.push(
      `${selfAnswering.length} probe(s) put the gold in their own question, so they answer themselves`
    );
  const conversations = new Set(probes.map((probe) => probe.conversation)).size;
  if (probes.length > 0 && conversations < 5)
    problems.push(
      `every probe came from ${conversations} conversation(s); the corpus is too narrow`
    );
  const shipped = rows.find((row) => row.name === 'shipped')?.rollup;
  const red = rows.find((row) => row.name === 'no-citation')?.rollup;
  if (shipped && red) {
    if (red.reachedAt1 !== 0 || red.reachedAt2 !== 0)
      problems.push(
        `the red baseline reached ${red.reachedAt1}/${red.n} at 1 and ${red.reachedAt2}/${red.n} at 2; with no citation stored it must reach nothing, so something else is answering these probes`
      );
    if (shipped.reachedAt2 < MIN_SEPARATION * Math.max(1, red.reachedAt2))
      problems.push(
        `shipped reached ${shipped.reachedAt2} at 2 against the red baseline's ${red.reachedAt2}, under the ${MIN_SEPARATION}x separation this rig needs to be reading its input`
      );
  }
  return problems;
};

/* --------------------------------------------------------------------------------- the baseline */

export const baselineFrom = (
  rows: readonly { name: string; rollup: Rollup }[],
  basis: CorpusBasis,
  digest: string
): Baseline => {
  const out: Record<string, BaselineRow | Baseline['$stamp']> = {
    $stamp: {
      acceptedAt: new Date().toISOString(),
      corpus: basis,
      digest,
      probes: rows[0]?.rollup.n ?? 0
    }
  };
  for (const row of rows)
    out[row.name] = {
      n: row.rollup.n,
      reachedAt1: row.rollup.reachedAt1,
      reachedAt2: row.rollup.reachedAt2,
      reachedViaSearch: row.rollup.reachedViaSearch,
      verbatimAt1: row.rollup.verbatimAt1
    };
  return out as Baseline;
};

/**
 * The baseline gate, and it is one-sided in one direction only.
 *
 * On `shipped` a fall is a regression and a rise is the work, so only a fall fails. On the fault
 * rows it is the other way round: those numbers are meant to be on the floor, and a fault row that
 * has started answering probes means the fault has stopped biting - which is a broken instrument,
 * not an improvement. Rates rather than counts, because the corpus grows as the owner works and a
 * run with eleven more probes in it is not a run that got better.
 */
export const check = (
  rows: readonly { name: string; rollup: Rollup }[],
  baseline: Baseline | undefined
): string[] => {
  if (!baseline) return [];
  const problems: string[] = [];
  for (const row of rows) {
    const held = baseline[row.name];
    if (!held || !('reachedAt1' in held)) continue;
    const was = held.n > 0 ? held.reachedAt1 / held.n : 0;
    const now = row.rollup.n > 0 ? row.rollup.reachedAt1 / row.rollup.n : 0;
    const isFault = row.name !== 'shipped' && row.name !== 'span-exact' && row.name !== 'cite-all';
    if (!isFault && now < was - SLACK_SHIPPED)
      problems.push(
        `${row.name}: reach@1 fell from ${(was * 100).toFixed(1)}% to ${(now * 100).toFixed(1)}%`
      );
    if (isFault && now > was + SLACK_FAULT)
      problems.push(
        `${row.name}: this fault used to hold the number to ${(was * 100).toFixed(1)}% and now lets ${(now * 100).toFixed(1)}% through, so it has stopped biting`
      );
  }
  return problems;
};

/* ------------------------------------------------------------------------------------- the table */

const rate = (count: number, total: number): string =>
  total === 0 ? '   -  ' : `${((count / total) * 100).toFixed(1).padStart(5)}%`;

export const render = (run: Run, baseline: Baseline | undefined): string => {
  const lines: string[] = [];
  lines.push('EVIDENCE REACH', '==============', '');
  lines.push(
    `Corpus  ${run.basis.turns} owner turns / ${run.basis.characters.toLocaleString('en-GB')} characters / ` +
      `${run.basis.projects} projects / ${run.basis.days} active days / ${run.basis.conversations} conversations`
  );
  lines.push(`Probes  n = ${run.probes.length}  digest ${run.digest}`);
  const beyond = run.rows[0]?.rollup.beyondBound ?? 0;
  lines.push(
    `        ${beyond} of them have their gold past the reach's own character bound, so nothing can return it`
  );
  const stamp = baseline?.$stamp;
  if (stamp)
    lines.push(
      `Baseline accepted ${stamp.acceptedAt} over ${stamp.probes} probes, digest ${stamp.digest}` +
        (stamp.digest === run.digest ? '' : ' - a different corpus, so the rows below are a note')
    );
  lines.push('');
  lines.push(
    'arrangement        n   reach@1   reach@2   reach@2*  verbatim@1    packed    ranked   located'
  );
  lines.push(
    '-------------------------------------------------------------------------------------------'
  );
  for (const row of run.rows) {
    const r = row.rollup;
    lines.push(
      [
        row.name.padEnd(16),
        String(r.n).padStart(4),
        rate(r.reachedAt1, r.n),
        rate(r.reachedAt2, r.n),
        rate(r.reachedViaSearch, r.n),
        rate(r.verbatimAt1, r.n),
        rate(r.packed, r.n),
        rate(r.ranked, r.n),
        rate(r.located, r.n)
      ].join('   ')
    );
  }
  lines.push('');
  lines.push(
    '  reach@2* is a COUNTERFACTUAL, not a path the model has: the same search, reaching for the'
  );
  lines.push(
    '  episode of its own top hit. `MemorySourceHit.episodeId` exists and `MemorySessionTurn` drops'
  );
  lines.push('  it, so this is what one field on that return type would be worth.');
  lines.push('');
  for (const row of run.rows) if (row.note) lines.push(`  ${row.name.padEnd(14)} ${row.note}`);
  const refused = run.rows.reduce((total, row) => total + row.rollup.refused, 0);
  if (refused > 0) lines.push('', `  ${refused} call(s) across the table were refused or threw.`);
  lines.push('');
  const problems = check(run.rows, baseline);
  if (problems.length) {
    lines.push('AGAINST THE BASELINE', '--------------------');
    for (const problem of problems) lines.push(`  ! ${problem}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};
