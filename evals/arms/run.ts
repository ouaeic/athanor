/**
 * The entry point: `pnpm eval:arms`.
 *
 * Usage:
 *   pnpm eval:arms                          the offline half; no key, no network, no model
 *   pnpm eval:arms -- --ci                  also check the committed baseline; non-zero on a change
 *   pnpm eval:arms -- --accept              rewrite the committed baseline from this run
 *   pnpm eval:arms -- --json out.json       also write the raw rows
 *   pnpm eval:arms -- --arm no-method,core  only these arms (shipped is always included)
 *   pnpm eval:arms -- --contract-section f  measure this text as the method axis, not the section
 *   pnpm eval:arms -- --live                the judged half; needs OPENROUTER_API_KEY
 *   pnpm eval:arms -- --live --yes          confirm the spend the live half estimates
 *   pnpm eval:arms -- --live --sample 12    a shape-balanced subset, for a run somebody pays for
 *   pnpm eval:arms -- --live --strong <id>  add the installation's own model as a second tier
 *   pnpm eval:arms -- --edit                the edit axis: its sample, its offline bound, its price
 *   pnpm eval:arms -- --edit --live --yes   and the only half that can settle it, which costs money
 *
 * Deliberately not part of `pnpm check`, for the reason `evals/run.ts` gives about itself: a
 * behavioural suite that blocks every commit is one somebody deletes the first week it is wrong
 * about something. `--ci` exits non-zero, so it gates on its own schedule.
 *
 * Read the offline table first and the pre-registration before either. The offline half is exact
 * and free and it is where the residency argument is actually settled; the live half is the only
 * thing that can say whether a saving costs anything, and it costs money to ask.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARMS, EDIT_ARM, ROOT_ARM } from './arms.js';
import { EDIT_TASKS, runEditLive } from './edit-arm.js';
import { estimateCalls, resolveKey, runLive, WEAK_TIER } from './live.js';
import { measureAll } from './measure.js';
import {
  baselineFrom,
  check,
  renderEditBound,
  renderEditCost,
  renderEditLive,
  renderEditSample,
  renderLive,
  renderQuestions,
  renderResident,
  scoreArms,
  scoreEditArms,
  type Baseline
} from './report.js';
import { TASKS, sampleOf } from './tasks.js';
import { cutSizes, readCut } from './wire.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const wanted = argument('arm')?.split(',');
// The root arm is always in, whatever was asked for: every delta in either table is measured
// against it, and a table of candidates with nothing to compare them to is a list of numbers.
const armIds = [
  ROOT_ARM,
  ...ARMS.map((arm) => arm.id).filter((id) => id !== ROOT_ARM && (!wanted || wanted.includes(id)))
];

const cutFile = argument('contract-section');
const cut = cutFile ? { replacement: readCut(cutFile) } : {};

process.stdout.write(renderQuestions());

const sizes = cutSizes(cut.replacement);
process.stdout.write(
  `  The method axis is ${sizes.method} bytes, read from ${sizes.source}, and this run measures it\n` +
    `  by ${sizes.direction === 'cut' ? 'REMOVING it from the shipped contract: the cut has not landed yet' : 'RESTORING it to the shipped contract: the cut has already landed, so the arm measures it from the other side'}.\n` +
    `  The skills bullet that points at the index is ${sizes.skillBullet} bytes.\n`
);

const resident = measureAll(armIds, cut);
process.stdout.write(renderResident(resident));

const jsonOut = argument('json');
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ resident }, null, 2)}\n`);

let baseline: Baseline | undefined;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
} catch {
  // A first run, or one after the baseline was deliberately removed. Every arm reads as new.
}

if (flag('accept')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(resident), null, 2)}\n`);
  process.stdout.write(`Baseline accepted: ${baselinePath}\n`);
}

/**
 * The edit axis, on its own sample and its own table.
 *
 * Separate from the general run because a task that does not edit a file cannot tell `file_patch`
 * from the candidate, and a rig that ran the edit arm over the general sample would print a tie
 * for the same reason the offline half prints one: the instrument is blind there. A tie that means
 * "blind" and a tie that means "free" look identical on the page, and this programme has already
 * shipped one decision made on the second reading of the first kind of tie.
 *
 * The offline part runs unconditionally under `--edit` and costs nothing: the sample, the bound
 * `evals/edit` already measured over these rows, and what the live half would cost before anybody
 * spends it. The live part needs the key and the same `--yes` the general half needs.
 */
if (flag('edit')) {
  const editArms = [ROOT_ARM, EDIT_ARM];
  const strong = argument('strong');
  const tiers = [WEAK_TIER, ...(strong ? [strong] : [])];
  const seeds = Number(argument('seeds') ?? 1);
  process.stdout.write(renderEditSample());
  process.stdout.write(renderEditBound());
  process.stdout.write(renderEditCost(measureAll(editArms, cut), editArms, tiers.length, seeds));
  const key = resolveKey(flag('live'), process.env);
  process.stdout.write(`  ${key.note}\n`);
  if (flag('live') && key.apiKey) {
    if (!flag('yes'))
      process.stdout.write(
        '  Re-run with --yes to spend it. Nothing above cost anything; everything below does.\n'
      );
    else {
      const rows = await runEditLive(key.apiKey, editArms, EDIT_TASKS, tiers, seeds);
      process.stdout.write(renderEditLive(scoreEditArms(rows)));
      const editJson = argument('edit-json');
      if (editJson) writeFileSync(editJson, `${JSON.stringify(rows, null, 2)}\n`);
    }
  } else if (key.fatal) {
    process.exit(1);
  }
}

if (flag('live') && !flag('edit')) {
  const key = resolveKey(true, process.env);
  process.stdout.write(`\n${key.note}\n`);
  if (key.apiKey) {
    const size = Number(argument('sample') ?? TASKS.length);
    const tasks = sampleOf(Number.isFinite(size) ? size : TASKS.length);
    // The edit arm is not run here, and paying for it here would be worse than not running it: the
    // general sample does not edit files, so every row would tie, and a tie printed beside a real
    // difference reads as evidence that the dialect is free. `--edit` is where it is readable.
    const liveArms = armIds.filter((id) => id !== EDIT_ARM);
    if (liveArms.length !== armIds.length)
      process.stdout.write(
        `  ${EDIT_ARM} is not in this run. Its axis is only readable on a sample that edits files; pass --edit.\n`
      );
    const strong = argument('strong');
    const tiers = [WEAK_TIER, ...(strong ? [strong] : [])];
    const seeds = Number(argument('seeds') ?? 1);
    if (!strong)
      process.stdout.write(
        '  One tier only. The difference between what a weak model pays for a harness decision and\n' +
          '  what a strong one pays is the finding; pass --strong <model id> to get it. There is no\n' +
          '  default here on purpose - the shipped model is whatever AI_DEFAULT_MODEL is set to.\n'
      );
    if (!flag('yes')) {
      process.stdout.write(
        `The live half is at most ${estimateCalls(liveArms, tasks, tiers, seeds)} model calls ` +
          `(${liveArms.length} arms x ${tasks.length} tasks x ${tiers.length} tier(s) x ${seeds} seed(s), ` +
          `bounded by the step ceiling). Re-run with --yes to spend them.\n`
      );
    } else {
      const rows = await runLive(key.apiKey, liveArms, tasks, tiers, seeds, cut);
      process.stdout.write(renderLive(scoreArms(rows)));
      const liveJson = argument('live-json');
      if (liveJson) writeFileSync(liveJson, `${JSON.stringify(rows, null, 2)}\n`);
    }
  } else if (key.fatal) {
    process.exit(1);
  }
}

if (flag('ci')) {
  const failures = check(resident, baseline);
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
