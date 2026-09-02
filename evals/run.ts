/**
 * The entry point: `pnpm eval`.
 *
 * ── WHY THERE ARE TWO EXIT RULES ──────────────────────────────────────────────────────────────
 *
 * This file used to open by saying the suite was deliberately not part of `pnpm check`, because
 * "a behavioural suite that blocks every commit is a suite somebody deletes the first week it is
 * wrong about something", and the fixtures are meant to be argued with: the point of committing a
 * step count is that changing it is a decision rather than a failure.
 *
 * Half of that is still true and the other half was measured false. What is true is about the
 * BASELINE: a token count that drifts past its band is a conversation, and a gate that refuses
 * every commit until somebody re-accepts a row is the gate that gets bypassed. What was false is
 * the conclusion drawn from it. Kept out of `check` entirely, this suite went red at 71 of 72
 * fixtures and stayed there for a whole wave - twice, the second time after the first was written
 * down in `harness.ts` as a comment nobody re-read - because `check` runs `eval:rigs` and has
 * never run this. Six specialised rigs were green beside a dead suite.
 *
 * So the two reasons this suite exits non-zero are now separated, because they were never the same
 * kind of thing:
 *
 *   A STATED CLAIM FAILED, or a fixture never really ran - a 404 on an unmodelled route, a warning
 *   the loop had to survive, a tool that threw, a status that is not what the row says. None of
 *   these is a decision. Every one of them means the row's numbers were produced by a failure
 *   branch, so every number in the report beside it is about something other than what it claims.
 *
 *   A COMMITTED NUMBER MOVED. That is the decision, and it stays out of the gate.
 *
 * `--gate` exits on the first kind only. `pnpm eval` unchanged exits on both, which is what the
 * suite is for when a person runs it.
 *
 * ── WHY THIS AND NOT A CHEAPER CHECK ──────────────────────────────────────────────────────────
 *
 * The obvious cheaper repair is a unit-speed check that the harness stub answers every route the
 * production loop can request, which is what refused all 71 fixtures this time. It was rejected on
 * evidence rather than on taste. The same incident ALSO had two unmodelled store methods -
 * `readOwnerBlock` on all 72 fixtures and `attachMemoryCitedCalls` on 49 - which no route check
 * can see, and which the loop swallows into a warning by design because it is written to survive a
 * store it cannot reach. And a static route census can only ever under-approximate what a loop
 * asks for, so the day it misses a route it reports green: a check that cannot see it is not
 * running is the exact defect shape this repository keeps shipping, and putting a second one in
 * front of the suite that DOES see it would be building the disease.
 *
 * Measured, on the machine this was written on: `pnpm eval` is 9.3 seconds. `pnpm check` already
 * spends 59 seconds on `eval:rigs` and six minutes on `pnpm test`. There was no affordability
 * question to answer.
 *
 * Usage:
 *   pnpm eval                    run everything and print the report
 *   pnpm eval --gate             the same run, failing only on claims - what `pnpm check` runs
 *   pnpm eval --filter research  run the fixtures whose id or shape contains this
 *   pnpm eval --accept           accept this run's numbers as the committed baseline
 *   pnpm eval --json out.json    also write the raw results
 *
 * `EVAL_DUMP_WINDOW=<directory>` additionally writes each fixture's last assembled window there,
 * which is how a row that moved is read rather than guessed at.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtures } from './fixtures.js';
import { runFixture } from './harness.js';
import {
  baselineFrom,
  brokenPromise,
  check,
  pendingHeld,
  render,
  type Baseline,
  type Result
} from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const filter = argument('filter');
const selected = filter
  ? fixtures.filter(
      (fixture) => fixture.id.includes(filter) || String(fixture.shape).includes(filter)
    )
  : fixtures;

if (!selected.length) {
  process.stderr.write(`No fixture matches "${filter ?? ''}".\n`);
  process.exit(2);
}

const duplicates = selected
  .map((fixture) => fixture.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicates.length) {
  // Two fixtures under one id would silently share a baseline row and hide each other's drift.
  process.stderr.write(`Duplicate fixture ids: ${[...new Set(duplicates)].join(', ')}\n`);
  process.exit(2);
}

let baseline: Baseline = {};
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or a run after the baseline was deliberately removed. Every row reads as new.
}

const results: Result[] = [];
/**
 * The same rows with the committed baseline withheld, which leaves only what each fixture claims
 * about itself. See the header: this is the list `--gate` exits on, and the difference between the
 * two lists is exactly the set of numbers a wave is allowed to move by saying so.
 *
 * Recomputed rather than filtered out of `failures` by matching on the message text. A gate that
 * decided what to ignore by string-matching "against the committed baseline" would let a future
 * rewording of that sentence silently turn a claim into drift, which is a gate quietly switching
 * itself off.
 */
const claims: Result[] = [];
for (const fixture of selected) {
  // Sequentially, and never in parallel: the loop is being measured, and a shared event loop under
  // twenty concurrent runs measures the machine instead.
  const outcome = await runFixture(fixture);
  results.push({
    fixture,
    outcome,
    // The committed row is handed in, so the baseline is a gate rather than a column to read past.
    failures: check(fixture.expect, outcome, baseline[fixture.id])
  });
  claims.push({ fixture, outcome, failures: check(fixture.expect, outcome) });
}

process.stdout.write(render(results, baseline));

if (flag('trace'))
  for (const result of results) {
    // What the loop actually said back, which is the only way to tell a hold that fired for the
    // reason a fixture expects from one that fired for another.
    process.stdout.write(`\n${result.fixture.id}\n`);
    process.stdout.write(`  tools    ${result.outcome.tools.join(', ') || '-'}\n`);
    process.stdout.write(`  asked for ${result.outcome.proposed.join(', ') || '-'}\n`);
    for (const message of result.outcome.pushback)
      process.stdout.write(`  > ${message.replace(/\n/g, '\n    ').slice(0, 600)}\n`);
  }

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);

// Named loudly rather than left to do nothing. `--update` used to be this flag, and a rename that
// leaves the old spelling unrecognised means the one command whose whole purpose is to write a file
// silently writes nothing - which reads exactly like a run that had nothing to accept.
if (flag('update')) {
  process.stderr.write('--update is now --accept: the baseline is a gate, not a report.\n');
  process.exit(2);
}

if (flag('accept')) {
  // Only ever a whole-suite baseline: writing one from a filtered run would drop every row it did
  // not execute and report the rest of the suite as new on the next pass.
  if (filter) {
    process.stderr.write('--accept needs the whole suite; drop --filter.\n');
    process.exit(2);
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(results), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

// A pending row's failures are what it was written to measure, so they do not fail the run; a
// pending row with nothing left to measure does, because the marker is now a lie about the loop.
//
// Under `--gate` the pending marker is judged on the claims too, and it has to be: a pending row
// whose stated target is met is a stale marker whatever its token count did, and one held up only
// by baseline drift is not being held up by the thing it is waiting for.
const judged = flag('gate') ? claims : results;
const failed = judged.some(
  (result) => (result.failures.length > 0 && !pendingHeld(result)) || brokenPromise(result)
);
if (flag('gate') && !failed)
  process.stdout.write(
    'Gate: every fixture ran and every stated claim holds. Committed numbers are not gated here; run `pnpm eval`.\n'
  );
process.exit(failed ? 1 : 0);
