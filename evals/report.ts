/**
 * What the run is worth reading for: what passed, what regressed, and what each shape of request
 * costs in steps and prompt tokens.
 *
 * The cost half is the point of the exercise. Every consequential decision in the loop is currently
 * defended by one remembered incident, and none of them can be argued about because nobody can say
 * what removing one would cost. A number per fixture, held against a committed baseline, turns that
 * into an ordinary engineering question: delete the hold, run this, read the difference.
 */
import type { Expectation, Fixture, HoldName, RunOutcome } from './harness.js';

export interface Baseline {
  readonly [id: string]: { readonly modelCalls: number; readonly promptTokens: number };
}

export interface Result {
  readonly fixture: Fixture;
  readonly outcome: RunOutcome;
  /** Every expectation that did not hold, already phrased as expected-versus-actual. */
  readonly failures: readonly string[];
}

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const check = (expect: Expectation, outcome: RunOutcome): string[] => {
  const failures: string[] = [];
  const compare = <T>(label: string, wanted: T | undefined, got: T): void => {
    if (wanted !== undefined && wanted !== got)
      failures.push(`${label}: expected ${String(wanted)}, got ${String(got)}`);
  };
  if (outcome.error) failures.push(`the run threw: ${outcome.error}`);
  compare('model calls', expect.modelCalls, outcome.modelCalls);
  compare('status', expect.status, outcome.status);
  compare('verification', expect.verification, outcome.verification);
  compare('asked the owner', expect.askedOwner, outcome.askedOwner);
  compare('fallback plan written', expect.fallbackPlan, outcome.fallbackPlan);
  compare('untrusted content recorded', expect.untrusted, outcome.untrusted);
  compare('replies to the owner', expect.replies, outcome.replies);
  compare('commands run in the workspace', expect.commandsRun, outcome.commandsRun);
  if (expect.tools && !same(expect.tools, outcome.tools))
    failures.push(
      `tools: expected [${expect.tools.join(', ')}], got [${outcome.tools.join(', ')}]`
    );
  if (expect.proposed && !same(expect.proposed, outcome.proposed))
    failures.push(
      `tools asked for: expected [${expect.proposed.join(', ')}], got [${outcome.proposed.join(', ')}]`
    );
  if (expect.finalCatalogue && !same(expect.finalCatalogue, outcome.finalCatalogue))
    failures.push(
      `catalogue on the last request: expected [${expect.finalCatalogue.join(', ')}], got [${outcome.finalCatalogue.join(', ')}]`
    );
  if (expect.holds && !same(expect.holds, outcome.holds))
    failures.push(
      `holds: expected [${expect.holds.join(', ')}], got [${outcome.holds.join(', ')}]`
    );
  for (const tool of expect.toolsInclude ?? [])
    if (!outcome.tools.includes(tool))
      failures.push(`${tool} never ran; the run used [${outcome.tools.join(', ')}]`);
  for (const tool of expect.toolsExclude ?? [])
    if (outcome.tools.includes(tool)) failures.push(`${tool} ran, and nothing should have let it`);
  return failures;
};

const pad = (value: string, width: number): string => value.padEnd(width, ' ');
const padStart = (value: string, width: number): string => value.padStart(width, ' ');

const drift = (now: number, before: number | undefined): string => {
  if (before === undefined) return 'new';
  const change = now - before;
  return change === 0 ? '' : `${change > 0 ? '+' : ''}${change}`;
};

/** The one line an owner reads per fixture. */
const row = (result: Result, baseline: Baseline, width: number): string => {
  const before = baseline[result.fixture.id];
  const steps = drift(result.outcome.modelCalls, before?.modelCalls);
  const tokens = drift(result.outcome.promptTokens, before?.promptTokens);
  return [
    result.failures.length ? 'FAIL' : ' ok ',
    pad(result.fixture.id, width),
    pad(result.fixture.shape, 10),
    padStart(String(result.outcome.modelCalls), 5),
    padStart(steps, 5),
    padStart(String(result.outcome.promptTokens), 8),
    padStart(tokens, 8),
    result.outcome.holds.join(' ')
  ].join(' ');
};

const HOLD_ORDER: readonly HoldName[] = [
  'finish_rejected',
  'plan_hold',
  'acceptance_hold',
  'silence_hold',
  'acceptance_failed',
  'completion_nag',
  'baseline_refused',
  'repetition_stopped',
  'output_limit_continued',
  'step_budget'
];

export const render = (results: readonly Result[], baseline: Baseline): string => {
  const lines: string[] = [];
  const failed = results.filter((result) => result.failures.length);
  const steps = results.reduce((total, result) => total + result.outcome.modelCalls, 0);
  const tokens = results.reduce((total, result) => total + result.outcome.promptTokens, 0);
  const beforeSteps = results.reduce(
    (total, result) => total + (baseline[result.fixture.id]?.modelCalls ?? 0),
    0
  );
  const peak = results.reduce((most, result) => Math.max(most, result.outcome.peakPromptTokens), 0);
  // Sized to the longest id rather than to a guess: a column that a fixture name overflows shifts
  // every number on that row and makes the table unreadable exactly when something has gone wrong.
  const width = results.reduce((widest, result) => Math.max(widest, result.fixture.id.length), 7);

  lines.push('');
  lines.push(
    `     ${pad('fixture', width)} ${pad('shape', 10)} ${padStart('steps', 5)} ${padStart('Δ', 5)} ${padStart('tokens', 8)} ${padStart('Δ', 8)} holds`
  );
  lines.push(
    `     ${'-'.repeat(width)} ${'-'.repeat(10)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(8)} ${'-'.repeat(8)} -----`
  );
  for (const result of results) lines.push(row(result, baseline, width));

  if (failed.length) {
    lines.push('');
    lines.push('WHAT FAILED');
    for (const result of failed) {
      lines.push(`  ${result.fixture.id}`);
      lines.push(`    protects: ${result.fixture.why}`);
      for (const failure of result.failures) lines.push(`    - ${failure}`);
    }
  }

  // What each hold actually costs, across the whole suite. A hold that fires on three fixtures and
  // adds three steps is a different proposition from one that fires once and adds five.
  const cost = new Map<HoldName, { fixtures: number; steps: number }>();
  for (const result of results)
    for (const hold of new Set(result.outcome.holds)) {
      const entry = cost.get(hold) ?? { fixtures: 0, steps: 0 };
      cost.set(hold, {
        fixtures: entry.fixtures + 1,
        steps: entry.steps + result.outcome.holds.filter((each) => each === hold).length
      });
    }
  lines.push('');
  lines.push('WHAT THE HOLDS COST');
  for (const hold of HOLD_ORDER) {
    const entry = cost.get(hold);
    lines.push(
      `  ${pad(hold, 24)} ${
        entry
          ? `fired on ${entry.fixtures} fixture${entry.fixtures === 1 ? '' : 's'}, ${entry.steps} extra model call${entry.steps === 1 ? '' : 's'}`
          : 'never fired - no fixture covers it, or nothing triggers it any more'
      }`
    );
  }

  lines.push('');
  lines.push(
    `${results.length - failed.length}/${results.length} fixtures pass. ${steps} model calls in total${
      beforeSteps ? ` (baseline ${beforeSteps})` : ''
    }, ${tokens} estimated prompt tokens, the largest single prompt ${peak}.`
  );
  if (failed.length)
    lines.push(`${failed.length} fixture${failed.length === 1 ? '' : 's'} failed.`);
  lines.push('');
  return lines.join('\n');
};

export const baselineFrom = (results: readonly Result[]): Baseline =>
  Object.fromEntries(
    [...results]
      .sort((left, right) => left.fixture.id.localeCompare(right.fixture.id))
      .map((result) => [
        result.fixture.id,
        { modelCalls: result.outcome.modelCalls, promptTokens: result.outcome.promptTokens }
      ])
  );
