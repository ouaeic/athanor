/**
 * The entry point.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/cards/run.ts
 *
 * Usage:
 *   (no flags)              every scenario in every mode, clean and tainted. No key, no network.
 *   --detail                also print each card by name, which is what an argument needs
 *   --scenario C            only scenarios whose id contains this
 *   --mode balanced         only this security mode
 *   --ci                    check the committed baseline and exit non-zero on a move
 *   --accept                rewrite the committed baseline from this run
 *   --json out.json         also write the raw rows, cards and all
 *
 * Deterministic, free, and five milliseconds of measurement, so unlike the other three rigs this one is on
 * the every-change gate rather than the nightly one. It measures a security floor, and a floor that
 * quietly stops firing is not a drift to argue with in the morning.
 *
 * The guards run on every invocation, with or without `--ci`, and are the only thing here that can
 * fail without a baseline. See `guards.ts`: a card count has two directions and only one of them is
 * obviously good.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { guardFailures, measureAll, provenanceFailures } from './measure.js';
import { baselineFrom, check, render, type Baseline } from './report.js';
import { MODES, SCENARIOS, type Mode } from './scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const scenarioFilter = argument('scenario');
const scenarios = scenarioFilter
  ? SCENARIOS.filter((scenario) => scenario.id.includes(scenarioFilter))
  : SCENARIOS;
const modeFilter = argument('mode');
const modes = modeFilter ? MODES.filter((mode) => mode === (modeFilter as Mode)) : MODES;

if (!scenarios.length || !modes.length) {
  process.stderr.write('Nothing selected: check --scenario and --mode.\n');
  process.exit(2);
}

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or one after the baseline was deliberately removed. Every row reads as new.
}

const measurements = measureAll(scenarios, modes);
process.stdout.write(render(measurements, baseline, flag('detail')));

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(measurements, null, 2)}\n`);

if (flag('accept')) {
  if (scenarioFilter || modeFilter) {
    process.stderr.write('--accept needs the whole matrix; drop --scenario and --mode.\n');
    process.exit(2);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(measurements), null, 2)}\n`);
  process.stdout.write(`Baseline rewritten: ${baselinePath}\n`);
}

/*
 * Three failure classes, deliberately not one.
 *
 * A guard failure means the floor changed shape: a genuine write went quiet, an inert read started
 * charging, or the provenance half stopped raising anything. None of those is a number to accept.
 *
 * A provenance failure means reading untrusted content has started costing the owner clicks on a
 * call nobody declared a sink - or that a declared sink has stopped being one. It is the headline
 * claim of this rig and it is checked on every run for the same reason: it is not a measurement
 * that drifts, it is a design property that either holds or has been given up.
 *
 * A baseline regression is the one that IS a decision, and it is the only one gated on `--ci`.
 */
const guards = guardFailures();
for (const failure of guards)
  process.stderr.write(`GUARD ${failure.table}: ${failure.id} ${failure.detail}\n`);

const provenance = provenanceFailures(scenarios, modes);
for (const failure of provenance)
  process.stderr.write(`PROVENANCE: ${failure.key} ${failure.detail}\n`);

const regressions = flag('ci') ? check(measurements, baseline) : [];
for (const failure of regressions) process.stderr.write(`BASELINE: ${failure}\n`);

process.exit(guards.length + provenance.length + regressions.length ? 1 : 0);
