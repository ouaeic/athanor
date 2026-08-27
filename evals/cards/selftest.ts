/**
 * The checks for the half of this rig that running it cannot exercise.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/cards/selftest.ts
 *
 * The run proves a good deal about itself every time: it drives the shipped classifier and prints
 * what it said, and a baseline catches the counts moving. What it cannot prove is that the table is
 * a measurement at all, and every failure in that class produces a plausible table rather than an
 * error:
 *
 *   - a tool name with a typo in it is a call the floor has no rule for, so the scenario quietly
 *     gets cheaper and the row still reads like a task;
 *   - the guard tables are assertions that pass by doing nothing on a good day, so a table that had
 *     stopped being consulted would be silent in exactly the same way as a table that held;
 *   - the sink declaration is the one piece of this rig that can be used to silence the rig, and
 *     both halves of the rule that stops that live in a branch nobody reaches on a good day;
 *   - `check` is the whole point of the committed baseline and it runs only under `--ci`, so a
 *     comparison that had stopped comparing would be discovered by a regression getting through;
 *   - a column where every row reads the same number is furniture: it would keep printing whatever
 *     it printed last if it had stopped looking at the classifier altogether.
 *
 * A plain script rather than a vitest file, for the reason `evals/arms/selftest.ts` gives: `evals/`
 * is not a workspace package, so nothing here is collected by `pnpm -r test`. It exits non-zero on
 * the first run that finds anything, and it is on the every-change gate in verify.yml beside the
 * other three.
 */
import { agentToolsFor } from '../../apps/worker/src/tool-catalogue.js';
import { READS, SINKS, WRITES } from './guards.js';
import { guardFailures, measureAll, provenanceFailures } from './measure.js';
import { baselineFrom, check, rigIdentity, totals } from './report.js';
import { MODES, SCENARIOS, type Scenario } from './scenarios.js';

const failures: string[] = [];
const expect = (condition: boolean, what: string): void => {
  if (!condition) failures.push(what);
};

/* ----------------------------------------------- every call names a tool athanor actually sends */

/*
 * The cheapest way for this rig to be wrong. `approvalRequirement` answers null for a name it has
 * no rule for, which is correct - the floor is not a spell-checker - so `file_wrote` or
 * `connector_action{mail_repy}` costs a scenario a card and reads exactly like a saving. Checked
 * against the catalogue the worker actually sends rather than a list kept here, because a list kept
 * here is one rename away from agreeing with nothing.
 */
const shipped = new Set(agentToolsFor().map((tool) => tool.name));
for (const scenario of SCENARIOS)
  for (const call of scenario.calls)
    expect(
      shipped.has(call.name),
      `${scenario.id} calls "${call.name}", which athanor does not send: a name with a typo in it is a call the floor has no rule for, and the scenario silently gets cheaper`
    );
for (const entry of [...WRITES, ...READS])
  expect(
    shipped.has(entry.call.name),
    `the guard "${entry.id}" calls "${entry.call.name}", which athanor does not send`
  );
for (const entry of SINKS)
  expect(
    shipped.has(entry.call.name),
    `the sink guard "${entry.id}" calls "${entry.call.name}", which athanor does not send`
  );

/* ------------------------------------------------------- the guard tables are consulted at all */

/*
 * A planted entry of each kind, pushed through the real `guardFailures`. This is the mutation
 * discipline applied to the rig rather than to the product: a guard table that had been dropped
 * from the walk, or a comparison written the wrong way round, is silent on the shipped tables and
 * caught here in about a microsecond.
 */
const inertWrite = {
  id: 'planted: a call that writes nothing',
  call: { name: 'file_read', arguments: { path: 'workspace/notes.md' }, step: 'planted' }
};
expect(
  guardFailures([inertWrite], [], []).length === MODES.length,
  'the writes guard does not report a call that raises no card, so a genuine write going quiet would be silent'
);
const cardingRead = {
  id: 'planted: a read that is really a write',
  call: {
    name: 'file_write',
    arguments: { path: '.bashrc', content: 'x' },
    step: 'planted'
  },
  modes: ['balanced'] as const
};
expect(
  guardFailures([], [cardingRead], []).length === 1,
  'the reads guard does not report a call that cards, so the deferred-execution rule widening back over every read would be silent'
);
expect(
  guardFailures(
    [],
    [],
    [
      {
        id: 'planted: not a sink at all',
        call: { name: 'file_read', arguments: { path: 'a.md' }, step: 'planted' },
        mode: 'balanced' as const
      }
    ]
  ).length === 1,
  'the sinks guard does not report a call the provenance floor never stops, so provenance switching off would be silent'
);
expect(
  guardFailures(
    [],
    [],
    [
      {
        id: 'planted: cards whether or not anything was read',
        call: { name: 'publish_site', arguments: { label: 'x', port: 1 }, step: 'planted' },
        mode: 'balanced' as const
      }
    ]
  ).length === 1,
  'the sinks guard does not report a call that cards on a clean turn, so it would accept provenance being paid for unconditionally'
);

/* ---------------------------------------------------- the sink declaration cannot silence itself */

const taintOnly: Scenario = {
  id: 'planted-undeclared',
  ask: 'have a look at this',
  origins: [],
  selfOrigins: [],
  taintedBy: 'a page',
  // Free on a clean turn, a card on a tainted one, and deliberately NOT marked.
  calls: [
    {
      name: 'memory',
      arguments: {
        action: 'add',
        target: 'workspace',
        content: 'x',
        validUntil: '2027-01-31'
      },
      step: 'planted'
    }
  ]
};
expect(
  provenanceFailures([taintOnly], MODES).length === MODES.length,
  'an undeclared call that only cards once the turn is tainted is not reported, so provenance could start charging for ordinary work and nothing would say so'
);

const deadDeclaration: Scenario = {
  ...taintOnly,
  id: 'planted-dead-declaration',
  calls: [{ name: 'file_read', arguments: { path: 'workspace/a.md' }, step: 'planted', sink: true }]
};
expect(
  provenanceFailures([deadDeclaration], MODES).length === 1,
  'a `sink: true` on a call the floor never stops is not reported, so the declaration could be sprinkled over the file until the forward rule had nothing left to catch'
);

/*
 * And the shipped file itself passes both halves. Stated here as well as in `run.ts` because the
 * two planted cases above prove the rule works on something invented; this proves it is being asked
 * about the ten scenarios anybody actually reads.
 */
expect(
  provenanceFailures().length === 0,
  'the shipped scenarios do not satisfy the provenance rule'
);

/* ------------------------------------------------------------ the baseline comparison compares */

const measurements = measureAll();
const good = baselineFrom(measurements);
expect(
  check(measurements, good).length === 0,
  'a run does not agree with its own accepted baseline'
);
expect(
  check(measurements, undefined).length === 1,
  'a missing baseline is not reported, so a rig with no baseline would gate on nothing'
);
const key = `${SCENARIOS[0]?.id}/balanced`;
const nudged = { ...good, [key]: { ...good[key]!, clean: (good[key]?.clean ?? 0) + 1 } };
expect(
  check(measurements, nudged).some((failure) => failure.startsWith(key)),
  'a moved card count is not reported by `check`, so the committed baseline gates on nothing'
);
const dropped = Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
expect(
  check(measurements, dropped).some((failure) => failure.includes('new row')),
  'a row absent from the baseline is not reported, so a scenario could be added without anybody accepting its number'
);
expect(
  check(measurements.slice(1), good).some((failure) => failure.includes('has gone')),
  'a row that has left the table is not reported, so a scenario could be quietly deleted'
);

/* ------------------------------------------------------------------ no column is furniture */

/*
 * Three statements about the table's shape, and each of them would still be true of a rig that had
 * stopped consulting the classifier and started printing a constant.
 */
expect(
  MODES.every((mode) => totals(measurements, mode).clean > 0),
  'some security mode raises no card at all across ten owner-shaped tasks, which is a floor that is not there'
);
expect(
  totals(measurements, 'review').clean > totals(measurements, 'balanced').clean &&
    totals(measurements, 'balanced').clean >= totals(measurements, 'autonomous').clean,
  'the three modes do not order review > balanced >= autonomous, so the mode argument is reaching nothing'
);
expect(
  SCENARIOS.some((scenario) =>
    measurements.some(
      (row) => row.scenarioId === scenario.id && row.mode === 'balanced' && row.clean.length === 0
    )
  ) &&
    SCENARIOS.some((scenario) =>
      measurements.some(
        (row) => row.scenarioId === scenario.id && row.mode === 'balanced' && row.clean.length > 0
      )
    ),
  'every scenario reads the same in balanced mode, so the column is measuring nothing a change could move'
);
expect(
  rigIdentity().rig !== 'unreadable',
  'the rig digest cannot be computed, so a committed baseline cannot say which rig produced it'
);

/* --------------------------------------------------------------------------------------------- */

for (const failure of failures) process.stderr.write(`SELFTEST: ${failure}\n`);
process.stdout.write(
  failures.length
    ? `${failures.length} check(s) failed.\n`
    : 'The cards rig measures something: every scenario names a shipped tool, both guard tables report a planted failure, the sink declaration cannot silence itself, the baseline comparison compares, and no column is a constant.\n'
);
process.exit(failures.length ? 1 : 0);
