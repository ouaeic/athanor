/**
 * The entry point.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/edit/run.ts
 *   ... --ci        also check the committed baseline; non-zero on any change
 *   ... --accept    rewrite the committed baseline from this run
 *   ... --json out  also write the raw rows
 *
 * Deliberately not wired into `pnpm check` and deliberately not a `pnpm` script: this measures a
 * format that is not shipped, and a gate on unshipped code is a gate somebody deletes. `--ci` exits
 * non-zero on its own, so whoever rules on the format can pin the numbers the ruling was made on.
 *
 * It runs no model and costs nothing. Read `renderQuestions()` before the tables.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { measureAll } from './measure.js';
import {
  baselineFrom,
  check,
  renderQuestions,
  renderReadSide,
  renderResidency,
  renderTable,
  type Baseline
} from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

const measurement = measureAll();

process.stdout.write(renderQuestions());
process.stdout.write(renderTable(measurement));
process.stdout.write(renderReadSide(measurement));
process.stdout.write(renderResidency(measurement));

const jsonOut = argument('json');
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(measurement, null, 2)}\n`);

if (flag('accept')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(measurement), null, 2)}\n`);
  process.stdout.write(`  baseline written to ${baselinePath}\n\n`);
  process.exit(0);
}

if (flag('ci')) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  const problems = check(measurement, baseline);
  if (problems.length) {
    process.stdout.write(
      `  BASELINE CHANGED\n${problems.map((line) => `    ${line}\n`).join('')}\n`
    );
    process.exit(1);
  }
  process.stdout.write('  baseline unchanged\n\n');
}
