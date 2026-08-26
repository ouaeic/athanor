# The context-quality gate

`evals/harness.ts` asserts `modelCalls`, `delegatedCalls`, `tools`, `proposed`, `finalCatalogue`,
`status`, `verification`, `askedOwner`, `commandsRun`, `minCachePrefix`, `compactions`,
`minBriefSections`, `ownerMessageIntact`, `minToolResultFloor`, `holds`, `untrusted` and `replies`.
Every one of those is a count. None of them is an answer, and structurally none of them can be —
the model in that rig is a function of what athanor just said, so a change that cuts the model's
recent window by 75% produces the identical scripted reply and reports 49/49.

That makes every change to `apps/worker/src/context.ts` unfalsifiable by the suite that guards it.
"49/49 still pass" measures step counts and token counts, not whether the agent can still find the
thing it needed four tool results ago.

This directory measures the other axis. It takes a long-running trajectory, compresses its earlier
portion through athanor's own production path — `compactContext`, the squeeze, the floor,
`prepareModelContext`, `markCacheBreakpoints` — at a named configuration, and then asks questions
that can only be answered from the part that was compressed.

## Running it

```
pnpm eval:context                 # the whole matrix, deterministic, no key
pnpm eval:context -- --ci         # and check the committed baseline; exit 1 on a regression
```

| flag                | effect                                                      |
| ------------------- | ----------------------------------------------------------- |
| `--config a,b`      | only these configurations (see `configurations.ts`)         |
| `--trajectory 131k` | only trajectories whose id contains this                    |
| `--ci`              | check the committed baseline; exit non-zero on a regression |
| `--judge`           | also run the graded half; needs `OPENROUTER_API_KEY`        |
| `--yes`             | confirm the judged half's estimated spend                   |
| `--accept`          | rewrite `baseline.json` from this run                       |
| `--json out.json`   | also write the raw measurements                             |

The whole matrix is three trajectories against ten configurations and takes a few seconds. It needs
no key, no network and no model: the half of this that can gate is the half that always runs. Three
consecutive `--ci` runs produce byte-identical output, which is the property the baseline check
depends on and is worth re-establishing after any change here.

Typechecking is wired: `evals/tsconfig.json` includes `context-quality/*.ts`, so `pnpm check`
compiles this directory. The run itself is deliberately not part of `pnpm check`, for the reason
`evals/run.ts` gives about itself. The self-checks for the judged half run separately:

```
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/context-quality/selftest.ts
```

## The four probe kinds

| kind         | what it asks                                             |
| ------------ | -------------------------------------------------------- |
| recall       | one specific fact stated once, early, and never repeated |
| artifact     | which files did we modify, and how                       |
| continuation | can the agent correctly resume the next step             |
| decision     | a choice made early, with the reason it was made for     |

The published work this design follows grades those 0–5 with a judge blinded to which method
produced the answer, and reports artifact tracking as the worst of the four — 2.45/5 even for the
winning method, with the stated conclusion that it "may need dedicated state tracking beyond
summarization". Athanor scores 3.00/5 there on a compacted run and 5.00/5 on an uncompacted one,
so the whole of the loss is the compaction's and no context configuration moves it. That is the
expected result and it is reported rather than tuned away — see "where the artifact loss actually
is" below for what does move it.

## What the deterministic score is, and what it is not

Each probe declares the literal spans that must survive into the prepared window for the question
to be answerable **at all**. The deterministic run checks those with `String.includes` and reports
the share retained, scaled onto the judge's 0–5 scale so both halves print in one column.

**That number is an upper bound on the judged score, not a quality score.** If the bytes are gone
the model cannot answer and the judged score is 0. If the bytes are present the model still has to
find them among a hundred thousand tokens, and may not. Availability is necessary and not
sufficient, and calling it quality would repeat the exact error this directory exists to correct.

What it is genuinely good for: availability is the axis a context configuration _moves_. Changing
`RECENT_DETAIL_MESSAGES` cannot make a model better at finding a fact; it can only decide whether
the fact is in the request at all. So the deterministic run measures the whole of the effect a
context change has, and the judge measures how much of it the model converts.

## Tokens per task, not tokens per request

A configuration that saves 20% per request and forces three more round trips is a loss. The
`tokens/task` column is every request's prompt summed, plus a stated model of what re-obtaining a
lost fact costs: one extra round trip at that step's whole prompt, plus the re-read result.

It is charged **only** for losses a tool call can repair. A decision the model reasoned its way to
and no longer has is not a re-read at any price; those are counted in the `unrec` column and no
token figure is allowed to imply they were paid for.

## The judged half

`--judge` asks a real model each probe from each compressed window, then has a second model grade
the answers under opaque labels in a seeded shuffle. The judge is never told which configuration
produced which answer, how many configurations exist, or that a comparison is happening.

The key is `OPENROUTER_API_KEY`, from the environment, exactly as `scripts/live-drill.mjs` takes
it. Nothing here invents a second credential path and nothing is committed. Missing on a
developer's machine, it explains and continues; missing on a CI runner where `--judge` was asked
for, it fails — the `GITHUB_ACTIONS` arm from `scripts/check-repository.mjs:115-120`, for the same
reason it exists there. An optional check that skips silently is a check that has stopped running
and nobody has noticed.

## The arithmetic this found, which is the reason the rig exists

`RECENT_DETAIL_MESSAGES` is counted in messages from the tail, and at request time the tail is not
the assistant turn. `refreshRuntimeContext` (agent.ts:9144, called at agent.ts:9798) re-pushes the
runtime block last on every step; `refreshActivePlan` pushes the plan block whenever its version
changed; `#noteStepBudget` pushes a notice twice a turn. So the assistant turn from `k` steps ago
survives only while `N >= 3 + 2k`, one more on a plan step and one more again on a budget-notice
step:

| `RECENT_DETAIL_MESSAGES` | ordinary step      | plan step          | budget-notice step |
| ------------------------ | ------------------ | ------------------ | ------------------ |
| 8 (shipped)              | 2 turns back       | 2 turns back       | 1 turn back        |
| 6                        | 1                  | 1                  | 1                  |
| 5                        | 1                  | 0 (this turn only) | 0                  |
| 4                        | 0 (this turn only) | 0                  | gone               |
| 2                        | gone               | gone               | gone               |

At 2 the model takes its next step having had the thoughts that produced the last one deleted from
the request, on every step. Nothing breaks — `openai-compatible.ts:781-793` already carries a
fallback for the inverse case — and no counter anywhere else in this repository moves.

## Four things that keep the rig honest

Each of these fails the run loudly and separately from the baseline check, and each exists because
the corresponding defect produces a plausible number rather than an error.

`configuration-fidelity` is the shipped constants written back explicitly, so it goes through the
whole patch-and-reimport path in `configurations.ts` and must land on identical numbers to
`shipped`, which imports the module directly. If a rename upstream made the substitution stop
matching, every configuration would secretly become the shipped one and every row would agree with
every other row — which reads like a finding.

`recall-owner-constraint` asks for the owner's own goal message, which every pass in
`prepareModelContext` protects by name. A configuration that loses it means the driver is broken,
not that a design decision was made. It survives even `starved`, which is what makes it worth
reading on the rows in between.

`degenerateConfigurations` refuses a control that has become a copy of `shipped`. This is not
hypothetical: the noise control was `stride-4` while the tree shipped stride 8, step 3.1 landed
stride 4, and for a whole wave the control was byte-identical to shipped on all 27 rows and printed
a reassuring `+0.00` that was an identity rather than a measurement. It is `stride-8` now, and the
next time the tree moves onto a control's value the run says so instead of reporting agreement.

The **frozen-column check** refuses a probe kind that scores the same in every configuration of
every trajectory. A column nothing can move is indistinguishable from a probe that has stopped
reading the window. `starved` — every character bound at its destructive end, never a candidate —
is what gives each kind something that genuinely takes its material away. Run without it, the
artifact column fails this check, which is how it was calibrated.

## Where the artifact loss actually is

The artifact probe asks for the five paths this task wrote. Three survive a compacted run and two
do not, in every configuration, on both shipped windows — which looked like a tuning question until
`starved` was calibrated against it, and is not one.

A written path enters the window twice: in the head of the `file_write` call's arguments, and in
the head of the tool result (`{"ok":true,"path":…`). `truncateMiddle` keeps 62% of the remaining
budget as head. So every ordinary cut in this codebase — the recency bound, the descending
older-output floor, the compacted-argument bound — keeps the path, and the artifact column cannot
be moved by the squeeze at any value anyone would ship. It moves only when a bound is set low
enough that the head is shorter than the path itself (200/120/40, which is `starved`), or when a
**compaction replaces the message outright**. The two missing paths are the two written before the
compaction point; the three that survive are the ones written after it.

That is the same conclusion the published work reached from the other direction, and it says what a
fix would have to be. Not a better summariser: a durable record. An `ARTIFACTS WRITTEN` block
maintained the way `refreshActivePlan` maintains the plan block would have to carry, per path, the
path itself, whether it was created or modified, the byte count last written, and the step it last
changed on — enough to answer "which files did we modify and how" without the message that did it.
The evidence that this works is already in the fixture: `continuation-plan-order`, the same plan
narrated in the agent's prose, scores 0.0 in every compacted configuration, and
`continuation-plan-block`, the identical fact carried by the re-rendered plan block, scores 5.0 in
every configuration including `starved`. The mechanism exists; it has one user.
