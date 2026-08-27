# The arm-comparison rig

`pnpm eval:arms`

Two configurations of athanor, the same work, and one difference between them. It exists because
every argument about athanor's resident weight — the catalogue is too large, the skill index is
dead, the contract carries method it should not — has so far been settled by reading source and
forming a view. None of them has been measured, and none of them can be settled without an
instrument that can hold two configurations against the same sample honestly.

## What it does

Two halves, the same split `evals/context-quality` and `evals/agentdojo` settled on.

**Offline.** No key, no network, no model, deterministic to the byte. It prices what each arm
carries on every request: the catalogue as a provider receives it, the contract, the curated
knowledge block. It also prints a free diagnostic — the tools an arm's contract still names that
the arm no longer sends. It gates via `--ci` against `baseline.json`.

**Live.** A real model, one arm's wire, the fixtures' own requests, and a deterministic computer
behind every tool. Needs `OPENROUTER_API_KEY`. It reports success rate and mean output tokens on
the same row, always, and excludes ghost and unmetered rows from both.

The offline half cannot say whether an arm finishes the work, and it says so where it prints. A
scripted model is a function of what athanor just said, so a smaller catalogue produces a
byte-identical reply and every arm would tie. A tie in that table means the instrument is blind
there, not that the candidate is free.

## The property that makes it a comparison

An arm does not carry a configuration. It carries the id of a sibling it inherits from and exactly
one field it changes; everything else — the sample, the tier, the tool oracle, the other axes — is
inherited and cannot be edited for one arm without being edited for both. `settingsFor` enforces
the one-field rule and throws. That is deliberately not a test: a rig whose honesty depends on
somebody running its test suite reports a confident wrong difference on the machine where the suite
was skipped.

## Reading a result

The pre-registered decision rules are in `arms.ts` and are printed above every table, including the
one that says which arm to read first. Read them before the numbers, not after.

`floor` is a calibration point and never a proposal. If a five-tool arm is within one task of the
shipped arm on the weak tier, the sample cannot resolve the tool axis and nothing ships from that
run.

## The files

| file          | what it holds                                                     |
| ------------- | ----------------------------------------------------------------- |
| `arms.ts`     | the arms, the inheritance rule, the pre-registration              |
| `wire.ts`     | what each arm puts on the wire, sliced from athanor's own sources |
| `tasks.ts`    | the sample, taken from `evals/fixtures.ts`                        |
| `measure.ts`  | the offline half                                                  |
| `live.ts`     | the judged half, and the key's three arms                         |
| `world.ts`    | the deterministic computer every tool is a window onto            |
| `report.ts`   | the tables and the baseline check                                 |
| `selftest.ts` | the checks running it cannot perform                              |

`NODE_OPTIONS=--conditions=development pnpm exec tsx evals/arms/selftest.ts`
