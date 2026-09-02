/**
 * The entry point: `pnpm eval:bench`.
 *
 * Usage:
 *   pnpm eval:bench                    self-test the shim, check it covers the committed routes
 *   pnpm eval:bench --observe          re-sweep the fixtures and rewrite routes.json
 *   pnpm eval:bench --observe --filter research   sweep a selection (a FLOOR of a floor; say so)
 *   pnpm eval:bench --routes           print the committed observation and the shim's coverage
 *
 * Everything here runs offline, with no key, no network and no provider. Nothing in this rig can
 * spend money; the paid step is a command in README.md that the owner runs, not a flag on this.
 *
 * Not part of `pnpm check`, like every other rig in `evals/`. It exits non-zero on a self-test
 * failure or on a route athanor asks for that the shim does not implement, so it is usable in CI
 * on its own schedule.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { benchmarkBoxCatalogueBytes, catalogueWeights } from './catalogue.js';
import { allFixtures, observe } from './observe.js';
import { COLUMNS, renderCsv } from './parity.js';
import { coverageOf, IMPLEMENTED_ROUTES, type RouteObservation } from './routes.js';
import { selfTest } from './selftest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const routesPath = path.join(here, 'routes.json');
const csvPath = path.join(here, 'parity.csv');

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};

const committed = (): RouteObservation | null => {
  try {
    return JSON.parse(readFileSync(routesPath, 'utf8')) as RouteObservation;
  } catch {
    return null;
  }
};

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Written through Prettier, using this repository's own configuration.
 *
 * `JSON.stringify(value, null, 2)` and Prettier disagree about a short array - Prettier puts one
 * on a single line - and `pnpm format:check` is a gate in `pnpm check`. A rig that rewrites a
 * committed artefact on every run therefore has to write it in the shape the gate wants, or the
 * first `--observe` after a commit breaks the build for whoever runs it next. Formatting here
 * rather than asking a human to remember `prettier --write` afterwards is the difference between a
 * rule and a trap.
 */
const writeArtefact = async (target: string, contents: string): Promise<void> => {
  const config = await resolveConfig(target);
  writeFileSync(target, await format(contents, { ...config, filepath: target }));
};

if (flag('observe')) {
  const filter = argument('filter');
  const selection = filter
    ? allFixtures().filter(
        (fixture) => fixture.id.includes(filter) || String(fixture.shape).includes(filter)
      )
    : allFixtures();
  if (selection.length === 0) {
    process.stderr.write(`No fixture matches "${filter ?? ''}".\n`);
    process.exit(2);
  }
  out(`Sweeping ${selection.length} fixture(s) for the routes athanor asks a workspace for.`);
  let done = 0;
  const observation = await observe(selection, () => {
    done += 1;
    // A sweep of the whole suite takes minutes and a silent minute reads as a hang.
    if (done % 10 === 0) process.stderr.write(`  ${done}/${selection.length}\n`);
  });
  /*
   * A sweep that reached NO route is a broken recording seam, not a quiet loop, and it must not
   * be written or reported as coverage.
   *
   * Measured on 2026-09-02: delete the `state.observed.push(...)` line from `evals/harness.ts` and this
   * command ran all 73 fixtures, wrote `"observed": []` over the committed artefact, printed "The
   * shim implements every observed route it must" and exited 0. Every route was missing and the
   * coverage check said nothing was, because `coverageOf` compares the shim against an empty set
   * and an empty set has no gaps. That is this rig's own subject matter - a green that means
   * nothing was measured rather than that everything passed - happening to the rig.
   *
   * ZERO is the floor rather than some fraction of 15, deliberately. A smaller observation is a
   * legitimate outcome: the observed set is a FLOOR of what these fixtures happen to drive, and a
   * fixture retired or a tool that stops calling a route moves it down honestly. Nothing about
   * athanor moves it to zero while the loop still reaches a workspace, so zero is the only count
   * that can only mean the instrument.
   */
  if (observation.observed.length === 0) {
    process.stderr.write(
      `The sweep ran ${observation.fixtures.length} fixture(s) and recorded no route at all. That is the recording seam in evals/harness.ts, not a quiet loop: routes.json is left as it was.\n`
    );
    process.exit(2);
  }
  if (filter)
    // A filtered sweep is a floor of a floor and must never overwrite the whole-suite artefact:
    // routes.json would then claim a coverage nobody measured.
    process.stderr.write(
      'A filtered sweep is not written to routes.json - it would drop every route the unrun fixtures reach.\n'
    );
  else await writeArtefact(routesPath, `${JSON.stringify(observation, null, 2)}\n`);
  out('');
  out(
    `${observation.observed.length} distinct routes, over ${observation.fixtures.length} fixtures:`
  );
  for (const row of observation.observed)
    out(`  ${String(row.fixtures).padStart(4)}  ${row.route}`);
  if (observation.unstubbed.length) {
    out('');
    out('Routes the fixture stub itself does not model (a defect in evals/harness.ts, not here):');
    for (const route of observation.unstubbed) out(`  ${route}`);
  }
  if (observation.declaredButUnobserved.length) {
    out('');
    out('Advisory - paths apps/worker/src can build that no fixture in this sweep reached:');
    for (const route of observation.declaredButUnobserved) out(`  ${route}`);
  }
  const coverage = coverageOf(observation);
  out('');
  if (coverage.absent.length)
    out(
      `Declared absent, answered as a named refusal the model reads: ${coverage.absent.join(', ')}`
    );
  if (coverage.gatedOut.length)
    out(
      `Reached only because this sweep's box has a browser and a screen; the catalogue gate withdraws their tools on the benchmark box: ${coverage.gatedOut.join(', ')}`
    );
  out(
    coverage.missing.length === 0
      ? 'The shim implements every observed route it must.'
      : `THE SHIM IS MISSING ${coverage.missing.length}: ${coverage.missing.join(', ')}`
  );
  process.exit(coverage.missing.length === 0 ? 0 : 1);
}

if (flag('routes')) {
  const observation = committed();
  if (!observation) {
    process.stderr.write('No committed observation. Run --observe first.\n');
    process.exit(2);
  }
  const coverage = coverageOf(observation);
  out(`Observed ${observation.recordedAt} on ${observation.athanor}`);
  out(`${observation.fixtures.length} fixtures, ${observation.observed.length} distinct routes.`);
  out('');
  for (const row of observation.observed)
    out(`  ${String(row.fixtures).padStart(4)}  ${row.route}`);
  out('');
  out(`Shim implements ${IMPLEMENTED_ROUTES.length}.`);
  if (coverage.missing.length) out(`  MISSING: ${coverage.missing.join(', ')}`);
  if (coverage.absent.length)
    out(`  declared absent (named 503, counted): ${coverage.absent.join(', ')}`);
  if (coverage.gatedOut.length)
    out(`  gated out by the catalogue on a bare box: ${coverage.gatedOut.join(', ')}`);
  // Not a failure. A route implemented ahead of any fixture driving it is exactly what a benchmark
  // needs - a task will start a build in the background where no fixture does - but it has never
  // run, and a handler nobody drives is this programme's computed-and-unwired shape. Named so it
  // is a known gap rather than a believed capability.
  if (coverage.unexercised.length)
    out(
      `  implemented but unobserved (proved only by selftest.ts): ${coverage.unexercised.join(', ')}`
    );
  process.exit(coverage.missing.length === 0 ? 0 : 1);
}

const observation = committed();
const problems = await selfTest(observation);
out(`evals/bench self-test: ${problems.length === 0 ? 'clean' : `${problems.length} problem(s)`}`);
for (const problem of problems) out(`  - ${problem}`);

// The empty artefact, written every run so the columns and the header are exercised rather than
// asserted. A row needs a scored run, and a scored run costs money this lane may not spend; what
// is committed is the shape, the aggregator and the refusals, all of which are testable at zero
// cost. See README.md for the command that fills it in.
// Not through Prettier: it has no CSV parser, so the file is its own format and the gate ignores
// it. The header row is the whole of its shape and `COLUMNS` is the one place that shape lives.
writeFileSync(csvPath, renderCsv([]));
out('');
// The counter-argument, answered with a measurement rather than an assertion. See catalogue.ts.
out('What the catalogue weighs, measured through agentToolsFor on this checkout:');
for (const row of catalogueWeights())
  out(
    `  ${String(row.bytes).padStart(7)} B  ~${String(row.approxTokens).padStart(6)} tok  ${row.box}`
  );
out(
  `  The benchmark box carries ${benchmarkBoxCatalogueBytes()} bytes, which is the figure a parity row declares.`
);

out('');
out(`Parity CSV shape: ${COLUMNS.length} columns, 0 rows, written to ${csvPath}`);
out(
  `  aggregator is "${'mean'}" and is a column; a missing result scores 0; a run that reached an unimplemented route emits no row.`
);
if (observation) {
  const coverage = coverageOf(observation);
  out(
    `  routes: ${observation.observed.length} observed, ${IMPLEMENTED_ROUTES.length} implemented, ${coverage.missing.length} missing, ${coverage.unexercised.length} implemented-but-unobserved.`
  );
  out(
    `  observation digest ${createHash('sha256').update(JSON.stringify(observation.observed)).digest('hex').slice(0, 12)}`
  );
}

process.exit(problems.length === 0 ? 0 : 1);
