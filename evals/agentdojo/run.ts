/**
 * The entry point: `pnpm eval:injection`.
 *
 * Usage:
 *   pnpm eval:injection                 the deterministic run; no key, no network, no model
 *   pnpm eval:injection -- --ci         also check the committed baseline; non-zero on a change
 *   pnpm eval:injection -- --accept     rewrite the committed baseline from this run
 *   pnpm eval:injection -- --json out   also write the raw case outcomes
 *   pnpm eval:injection -- --cases      print every case, not the summary
 *   pnpm eval:injection -- --live       the model-driven half; needs OPENROUTER_API_KEY
 *   pnpm eval:injection -- --live --yes confirm the spend the live half estimates
 *
 * Deliberately not part of `pnpm check`, for the reason `evals/run.ts` gives about itself: a
 * behavioural suite that blocks every commit is one somebody deletes the first week it is wrong
 * about something. `--ci` exits non-zero, so it gates on its own schedule.
 *
 * The deterministic half needs nothing. That is the point, and it is the same design the
 * context-quality rig settled on: the half of this that can gate is the half that always runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveKey, runLive, estimateCalls } from './judged.js';
import { MODES, runDeterministic } from './monitor.js';
import { baselineFrom, check, render, runAll, type Baseline } from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const run = runAll();
process.stdout.write(render(run));

if (flag('cases')) {
  // Every row, for reading a number that moved rather than guessing at it. Same purpose as
  // `pnpm eval --trace`.
  for (const mode of MODES)
    for (const outcome of runDeterministic(mode))
      process.stdout.write(
        `${outcome.mode}\t${outcome.userTaskId}\t${outcome.injectionTaskId}\t${outcome.attackId}\torigin=${outcome.origin ?? '-'}\tfenced=${outcome.fenced}\tcontained=${outcome.contained}\tstoppedAt=${outcome.stoppedAt ?? '-'}\tuserCards=${outcome.userCardsTainted}/${outcome.userCalls}\n`
      );
}

const json = argument('json');
if (json) writeFileSync(json, `${JSON.stringify(run, null, 2)}\n`);

/**
 * A failed control stops the run before anything else is decided.
 *
 * Every number above is computed from the same two functions the controls exercise, so a control
 * that has fallen over means the table is a confident wrong report rather than a finding - and a
 * confident wrong report about a safety floor is worse than no report.
 */
const brokenControls = run.controls.filter((control) => !control.held);
if (brokenControls.length) {
  for (const control of brokenControls)
    process.stderr.write(`CONTROL FAILED ${control.id}: ${control.what}\n`);
  process.exit(1);
}

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or one after the baseline was deliberately removed. Everything reads as new.
}

if (flag('accept')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(run), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

if (flag('live')) {
  const key = resolveKey(true, process.env);
  process.stdout.write(`\n${key.note}\n`);
  if (key.apiKey) {
    if (!flag('yes')) {
      process.stdout.write(
        `The live half is about ${estimateCalls()} model calls. Re-run with --yes to spend them.\n`
      );
    } else {
      const live = await runLive(key.apiKey, argument('model'));
      process.stdout.write(live.render);
      if (argument('live-json'))
        writeFileSync(argument('live-json') as string, `${JSON.stringify(live.rows, null, 2)}\n`);
    }
  } else if (key.fatal) {
    process.exit(1);
  }
}

if (flag('ci')) {
  const failures = check(run, baseline);
  if (failures.length) {
    process.stderr.write('\nThe committed baseline disagrees with this run:\n');
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stderr.write(
      '\nA number that moved is a decision, not a failure - but it has to be an accepted one. Re-run with --accept once you have read why.\n'
    );
    process.exit(1);
  }
  process.stdout.write('Baseline holds.\n');
}
