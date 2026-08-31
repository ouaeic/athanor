/**
 * The entry point: `pnpm exec tsx evals/reach/run.ts`.
 *
 * Offline, no key, no network, no model. **Machine-bound**: it reads this owner's own transcripts
 * from `~/.claude/projects`, which are not in the repository and must never be, so it cannot run in
 * CI and is not in `pnpm check`. `README.md` argues that out rather than asserting it.
 *
 *   --ci                check the committed baseline; exit non-zero on a regression
 *   --accept            rewrite baseline.json from this run
 *   --limit <n>         mine at most n probes (for iterating; a run so limited never accepts)
 *   --freeze <path>     write the mined probe set outside the repository, so a later run can be
 *                       asked the identical questions
 *   --probes <path>     read a frozen probe set instead of mining. This is what makes the fall
 *                       table honest: every row of it is the same n questions against a differently
 *                       broken store, and the corpus grows under the rig while it runs
 *   --seed <shape>      one of the seeded shapes: `production`, `no-citation`, `span-exact`,
 *                       `span-shifted`, `cite-all`
 *   --break <name>      one of the store faults: `none`, `pointer-only`
 *   --fall              run the whole fall table - the shipped reach and each way of breaking it -
 *                       and print what each one does to the number
 *   --json <path>       also write the raw per-probe results
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  corpusDigest,
  mineProbes,
  ownerCorpus,
  readOwnerTurns,
  TRAJECTORY_ROOT,
  type OwnerTurn,
  type Probe
} from './corpus.js';
import { measureProbe, rollUp, type ProbeResult, type Rollup } from './measure.js';
import { breakStore, FALL_TABLE, seedShapeOf, type Fault } from './faults.js';
import { render, check, rigFailures, baselineFrom, type Baseline } from './report.js';
import { selfTest } from './selftest.js';
import { seedStore, type SeedShape } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

/** One row of the run: a named arrangement of the store, and what the probes scored against it. */
export interface Row {
  readonly name: string;
  readonly note: string;
  readonly rollup: Rollup;
  readonly results: readonly ProbeResult[];
}

const measureAll = async (
  turns: readonly OwnerTurn[],
  probes: readonly Probe[],
  shape: SeedShape,
  fault: Fault
): Promise<readonly ProbeResult[]> => {
  const seeded = await seedStore(turns, probes, shape);
  const store = breakStore(seeded, fault);
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const minted = seeded.episodeOf.get(probe.turnUuid);
    if (!minted) continue;
    const turn = turns.find((candidate) => candidate.uuid === probe.turnUuid);
    results.push(
      await measureProbe(
        store,
        probe,
        minted.episodeId,
        new Set(minted.sourceIds),
        turn?.request ?? ''
      )
    );
  }
  await seeded.database.close();
  return results;
};

/* ------------------------------------------------------------------------------------ the run */

const frozen = argument('probes');
const limit = Number(argument('limit') ?? 0);

let turns: OwnerTurn[];
let probes: Probe[];
if (frozen) {
  const held = JSON.parse(readFileSync(frozen, 'utf8')) as { turns: OwnerTurn[]; probes: Probe[] };
  turns = held.turns;
  probes = held.probes;
} else {
  try {
    turns = readOwnerTurns();
  } catch (error) {
    process.stderr.write(
      `evals/reach needs this machine's own trajectories at ${TRAJECTORY_ROOT}, and could not read them: ${
        error instanceof Error ? error.message : String(error)
      }\nThis rig is machine-bound on purpose - see evals/reach/README.md.\n`
    );
    process.exit(2);
  }
  probes = mineProbes(turns);
}
if (limit > 0) probes = probes.slice(0, limit);

const basis = ownerCorpus(turns);
const digest = corpusDigest(probes);

const freeze = argument('freeze');
if (freeze) {
  /*
   * Written outside the repository, by a path the caller names, and never inside it.
   *
   * EVERY turn goes, not only the ones carrying a probe: the seed writes all of them so that
   * `mem.lexeme_df` is computed over the owner's whole corpus, and a frozen set that carried only
   * the probe turns would hand each question a corpus in which its own answer is the only
   * document. What is dropped is what only the miner needed - the assistant's other messages, the
   * reasoning, and the tool results of turns that carry no probe, which is the two gigabytes.
   */
  const carried = new Set(probes.map((probe) => probe.turnUuid));
  writeFileSync(
    freeze,
    `${JSON.stringify({
      turns: turns.map((turn) => ({
        ...turn,
        said: [],
        reasoning: [],
        calls: carried.has(turn.uuid) ? turn.calls : []
      })),
      probes
    })}\n`
  );
}

const rows: Row[] = [];
if (flag('fall')) {
  for (const entry of FALL_TABLE)
    rows.push({
      name: entry.name,
      note: entry.note,
      rollup: rollUp(await measureAll(turns, probes, entry.shape, entry.fault)),
      results: []
    });
} else {
  const shape = seedShapeOf(argument('seed') ?? 'production');
  const fault = (argument('break') ?? 'none') as Fault;
  const results = await measureAll(turns, probes, shape, fault);
  rows.push({ name: argument('seed') ?? 'production', note: '', rollup: rollUp(results), results });
}

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or a run after the baseline was deliberately removed. Every row reads as new.
}

process.stdout.write(render({ basis, digest, rows, probes }, baseline));

const problems = selfTest(probes, turns, rows);
if (problems.length) {
  process.stdout.write('\nTHE RIG, CHECKED AGAINST ITSELF\n===============================\n');
  for (const problem of problems) process.stdout.write(`  ! ${problem}\n`);
} else process.stdout.write('\nSelf-checks: all pass.\n');

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(rows, null, 2)}\n`);

const broken = rigFailures(rows, probes);

if (flag('accept')) {
  if (limit > 0) {
    process.stderr.write('--accept refused: a limited run is not the corpus.\n');
    process.exit(2);
  }
  if (!flag('fall')) {
    process.stderr.write(
      '--accept refused: the baseline is the whole fall table, so run --fall.\n'
    );
    process.exit(2);
  }
  if (broken.length || problems.length) {
    process.stderr.write(
      `--accept refused: this run failed ${broken.length + problems.length} of the rig's own checks, so its numbers are not a baseline.\n`
    );
    process.exit(2);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(rows, basis, digest), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

/*
 * The rig's own checks fail the run whether or not `--ci` was asked for, and the baseline only
 * under `--ci` - the same split `evals/read/run.ts` makes, for the same reason. A baseline says
 * what it did last time and is a tripwire somebody argues with; the separation gates say the
 * instrument is reading its input, and a run where that is false has measured nothing at all.
 */
const baselineBroken = flag('ci') && check(rows, baseline).length > 0;
process.exit(broken.length || problems.length || baselineBroken ? 1 : 0);
