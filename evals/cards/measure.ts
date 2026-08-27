/**
 * Driving the shipped floor over a scenario, twice per mode.
 *
 * `approvalRequirement` is imported from `apps/worker/src/tools.js` rather than from
 * `approval-policy.js` deliberately: `tools.ts` is the module agent.ts imports, so a re-export that
 * stopped re-exporting - or started re-exporting something else - is a change this rig would feel
 * rather than one it would step around. The rig is measuring the seam the product actually uses.
 *
 * Nothing here is stateful and nothing here is asynchronous. That is the whole reason this rig can
 * report a number the eval suite structurally cannot: a card parks the turn, so a run can observe
 * one of them, while the function that decides them can be asked about all seven calls in a row.
 */
import { approvalRequirement } from '../../apps/worker/src/tools.js';
import { READS, SINKS, WRITES, type Guard, type Sink } from './guards.js';
import { MODES, SCENARIOS, contextFor, type Call, type Mode, type Scenario } from './scenarios.js';

export interface CardRow {
  readonly step: string;
  readonly tool: string;
  readonly sideEffect: string;
  readonly action: string;
}

const cardsFor = (
  calls: readonly Call[],
  mode: Mode,
  context: Parameters<typeof approvalRequirement>[3]
): CardRow[] =>
  calls.flatMap((call) => {
    const requirement = approvalRequirement(call.name, call.arguments, mode, context);
    return requirement
      ? [
          {
            step: call.step,
            tool: call.name,
            sideEffect: requirement.sideEffect,
            action: requirement.action
          }
        ]
      : [];
  });

export interface ScenarioMeasurement {
  readonly scenarioId: string;
  readonly mode: Mode;
  readonly calls: number;
  readonly clean: readonly CardRow[];
  readonly tainted: readonly CardRow[];
}

export const measure = (scenario: Scenario, mode: Mode): ScenarioMeasurement => ({
  scenarioId: scenario.id,
  mode,
  calls: scenario.calls.length,
  clean: cardsFor(scenario.calls, mode, contextFor(scenario, false)),
  tainted: cardsFor(scenario.calls, mode, contextFor(scenario, true))
});

export const measureAll = (
  scenarios: readonly Scenario[] = SCENARIOS,
  modes: readonly Mode[] = MODES
): ScenarioMeasurement[] =>
  scenarios.flatMap((scenario) => modes.map((mode) => measure(scenario, mode)));

/* --------------------------------------------------------------- what provenance actually costs */

export interface ProvenanceFailure {
  readonly key: string;
  readonly detail: string;
}

/**
 * The rule behind this rig's headline claim, in both directions.
 *
 * Forward: a call that raises no card on a clean turn and raises one after the turn has read
 * untrusted content is provenance charging the owner a click. That is legitimate for a sink and
 * for nothing else, so every such call must be declared `sink: true` where it is written down. An
 * undeclared one is the regression this rig exists to catch - a change that starts making an
 * ordinary day more expensive because a page was read.
 *
 * Backward: a declared sink that the floor stops in no mode is a declaration silencing a check with
 * nothing behind it. Without this half, the forward rule could be satisfied for ever by marking
 * every call in the file. Only checked over the full matrix, because it is a statement about the
 * set of modes and `--mode` has deliberately taken most of them away.
 */
export const provenanceFailures = (
  scenarios: readonly Scenario[] = SCENARIOS,
  modes: readonly Mode[] = MODES
): ProvenanceFailure[] => {
  const failures: ProvenanceFailure[] = [];
  const declared = new Map<string, boolean>();
  for (const scenario of scenarios)
    for (const entry of scenario.calls)
      if (entry.sink) declared.set(`${scenario.id}/${entry.step}`, false);
  for (const scenario of scenarios)
    for (const mode of modes)
      for (const entry of scenario.calls) {
        const clean = approvalRequirement(
          entry.name,
          entry.arguments,
          mode,
          contextFor(scenario, false)
        );
        const tainted = approvalRequirement(
          entry.name,
          entry.arguments,
          mode,
          contextFor(scenario, true)
        );
        if (clean !== null || tainted === null) continue;
        declared.set(`${scenario.id}/${entry.step}`, true);
        if (!entry.sink)
          failures.push({
            key: `${scenario.id}/${mode}`,
            detail: `"${entry.step}" is free on a clean turn and costs a card ("${tainted.action}") once the turn has read untrusted content, and nothing in scenarios.ts declares it a sink`
          });
      }
  if (modes.length === MODES.length)
    for (const [key, stopped] of declared)
      if (!stopped)
        failures.push({
          key,
          detail:
            'is declared a provenance sink and the floor stops it in no mode, so either the rule has gone or the declaration is silencing a check with nothing behind it'
        });
  return failures;
};

/* ------------------------------------------------------------------------------- the guards */

export interface GuardFailure {
  readonly table: 'writes' | 'reads' | 'sinks';
  readonly id: string;
  readonly detail: string;
}

const modesOf = (entry: Guard): readonly Mode[] => entry.modes ?? MODES;

/**
 * The two directions, checked on every run rather than under a flag.
 *
 * A baseline regression is a decision somebody can accept in a commit. A write that stopped
 * carding is not a decision, and neither is a read that started: both mean the table above is
 * reporting a number about a floor that is no longer the floor.
 */
export const guardFailures = (
  writes: readonly Guard[] = WRITES,
  reads: readonly Guard[] = READS,
  sinks: readonly Sink[] = SINKS
): GuardFailure[] => {
  const failures: GuardFailure[] = [];
  for (const entry of writes)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (!requirement)
        failures.push({
          table: 'writes',
          id: entry.id,
          detail: `raises no card in ${mode} mode, so this computer would run text nobody was shown`
        });
    }
  for (const entry of reads)
    for (const mode of modesOf(entry)) {
      const requirement = approvalRequirement(entry.call.name, entry.call.arguments, mode, {});
      if (requirement)
        failures.push({
          table: 'reads',
          id: entry.id,
          detail: `cards in ${mode} mode as "${requirement.action}", and it changes nothing`
        });
    }
  for (const entry of sinks) {
    const context = {
      knownOrigins: entry.knownOrigins ?? [],
      knownAddresses: [],
      ownerText: 'have a look at this and deal with it',
      selfOrigins: ['box.athanor.invalid'],
      spentNoveltyBytes: 0
    };
    const clean = approvalRequirement(entry.call.name, entry.call.arguments, entry.mode, {
      ...context,
      taintSources: []
    });
    const tainted = approvalRequirement(entry.call.name, entry.call.arguments, entry.mode, {
      ...context,
      taintSources: ['a page this turn read']
    });
    if (clean)
      failures.push({
        table: 'sinks',
        id: entry.id,
        detail: `cards on a CLEAN turn in ${entry.mode} mode ("${clean.action}"), so provenance is being paid for whether or not anything hostile was read`
      });
    if (!tainted)
      failures.push({
        table: 'sinks',
        id: entry.id,
        detail: `raises no card in ${entry.mode} mode after the turn read untrusted content, so the provenance floor is not there`
      });
  }
  return failures;
};
