/**
 * The entry point: `pnpm exec tsx evals/read/run.ts`, or `pnpm eval:read` once it is wired.
 *
 * Offline, no key, no network, no model. Deterministic to the byte, which is the property the
 * baseline check depends on: three consecutive `--ci` runs produce byte-identical output apart from
 * the stamp's own date, and that is worth re-establishing after any change here.
 *
 *   --ci             check the committed baseline; exit non-zero on a regression. Implies
 *                    --trajectories, because the baseline is the trajectories - see below
 *   --accept         rewrite baseline.json from this run
 *   --trajectories   the declared rows only, skipping the corpus (about a second rather than nine)
 *   --json out.json  also write the raw measurements
 *
 * ── Two modes, and the reason they differ ─────────────────────────────────────────────────────
 *
 * Without `--ci` this is an INSTRUMENT: it runs the trajectories and the whole fixture corpus,
 * prints displayed lines per landed edit for both, and does not care what the numbers are. That is
 * the mode to run before and after a change to `apps/worker/src/tools/workspace.ts` or `edit/`.
 *
 * With `--ci` it is a FLOOR, and a narrow one on purpose: the declared trajectories only, held
 * one-sidedly to a committed baseline. The corpus is left out because those rows belong to
 * `pnpm eval`, which CONTRIBUTING keeps out of `pnpm check` deliberately - gating them here would
 * move that decision without anybody making it. It is also what makes this cheap enough to sit in
 * `pnpm eval:rigs`: a second rather than nine.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureCorpus, measureTrajectory, type Measurement } from './measure.js';
import { selfTest } from './selftest.js';
import { TRAJECTORIES } from './trajectories.js';
import { baselineFrom, check, render, rigFailures, type Baseline } from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or a run after the baseline was deliberately removed. Every row reads as new.
}

const measurements: Measurement[] = [];
for (const trajectory of TRAJECTORIES) measurements.push(await measureTrajectory(trajectory));
if (!flag('trajectories') && !flag('ci')) measurements.push(...(await measureCorpus()));

process.stdout.write(render(measurements, baseline));

/*
 * Run last and printed last, but never optional.
 *
 * It re-measures the trajectories in reverse to find out whether any row depends on what ran before
 * it, which is the one question this rig cannot answer from a single pass - and which is live here,
 * because the snapshot store is process-global and every fixture in this harness shares one task id.
 */
const problems = await selfTest();
if (problems.length) {
  process.stdout.write('\nTHE RIG, CHECKED AGAINST ITSELF\n===============================\n');
  for (const problem of problems) process.stdout.write(`  ! ${problem}\n`);
} else process.stdout.write('\nSelf-checks: all pass.\n');

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(measurements, null, 2)}\n`);

if (flag('accept')) {
  /*
   * Every trajectory or none. The baseline holds the declared rows and nothing else - see
   * `baselineFrom` - and every mode above runs all of them, so a partial baseline is no longer a
   * shape this can produce. What it can still produce is a baseline accepted from a run that FAILED
   * its own gates, so refuse that: `--accept` is for re-accepting a number that moved on purpose,
   * not for silencing a rig that has stopped reading its input.
   */
  const blocking = [
    ...rigFailures(measurements),
    ...measurements.flatMap((row) => check(row, undefined)),
    ...problems
  ];
  if (blocking.length) {
    process.stderr.write(
      `--accept refused: this run failed ${blocking.length} of the rig's own checks, so its numbers are not a baseline.\n`
    );
    process.exit(2);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(measurements), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

/*
 * The rig's own gates fail the run whether or not `--ci` was asked for, and the baseline gate only
 * under `--ci`.
 *
 * They are different kinds of statement. A baseline says "this is what it did last time" and is a
 * tripwire somebody is meant to argue with. The separation gate and the declaration checks say
 * "this instrument is reading its input", and a run where that is false has produced no measurement
 * at all - so letting it exit zero because nobody passed a flag would be publishing a number the
 * rig itself knows is meaningless.
 */
const rigBroken = rigFailures(measurements);
const declarationsBroken = measurements.some((row) => check(row, undefined).length > 0);
const baselineBroken = flag('ci') && measurements.some((row) => check(row, baseline).length > 0);
process.exit(rigBroken.length || declarationsBroken || baselineBroken || problems.length ? 1 : 0);
