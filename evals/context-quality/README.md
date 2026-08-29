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

Every run opens with two provenance lines: which athanor and which rig are running, and which
accepted the committed numbers. `--accept` writes that pair into `baseline.json` under `$stamp` —
the version and short revision from `buildIdentity()`, the same pair the box reports to its owner,
plus a digest of the six source files here that decide every number printed. The digest moves on any
edit to a probe, a trajectory, a configuration or the measurement, which is the point: a baseline
accepted under a different digest was accepted by a different instrument. That prints as a note and
never as a failure — adding a probe legitimately moves it, and the answer is `--accept` in the same
commit with the new figure quoted in the message.

Typechecking is wired: `evals/tsconfig.json` includes `context-quality/*.ts`, so `pnpm check`
compiles this directory. The run itself is deliberately not part of `pnpm check`, for the reason
`evals/run.ts` gives about itself. The self-checks for the judged half run separately:

```
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/context-quality/selftest.ts
```

## The fourth trajectory, and the counter it exists to move

Three of the four trajectories carry exactly one mid-task owner message, of 600 characters, at step 13. That is the right fixture for the axis they were written for, and it is precisely why they
could not see the largest thing wrong with compaction on real work.

`planCompaction` may never condense a `user` message — the owner's corrections are the only
steering channel a running task has, and the text least able to correct a model is that model's own
account of it. So what the owner types accumulates for the life of the task, and once
`owner tokens > targetTailTokens − head tokens − OWNER_WINDOW_RESERVE_TOKENS` the region compaction
may touch holds nothing else and it returns `null` with **zero** candidates. A window that has been
compacted once is `[goal][brief][the owner's accumulated turns][recent work]`, because everything
else above the tail was condensed away last time — which is why the state is absorbing rather than
transient, and why a bound applied at the refusal cannot get out of it.

Replayed through this repository's own production path on a real 8,159-step Claude Code session
recorded on this checkout, with the owner's own text on it scaled ×2 to 171,196 characters:
**888 attempts, 237 successes, 651 refusals**, every refusal with no candidate at all. At ×3 it is
2,194 refusals of 2,667, the soft pass fires on 690 steps and the window sits over its own budget
on 11 of them. Unscaled — 95,192 characters, the most this owner has typed into one session — the
same replay makes 75 compactions and refuses none, which is the honest statement of where the
cliff is rather than where it was assumed to be.

Two additive changes make that visible here:

- **`compactionRefusals`** — the count of `compactContext` returning `null`. The loop used to write
  `if (outcome) { … }` and count only successes, so a run in which compaction was attempted 6,621
  times and worked 1,214 was indistinguishable from one in which it worked perfectly. It prints as
  the `refuse` column, `refused/attempted`, and `check` treats it as an exact ceiling: a refusal is
  never progress.
- **`pool-migration-131k-owner`** — thirteen pasted corrections of 14,000 characters, 182,000
  characters of owner text over sixty steps, which crosses that line around step 40. The phase is
  never declared, so every compaction is the budget trigger.

`owner-unbounded` is the bound on that accumulation switched off — its floor raised past any
window, which is the same thing. On the new trajectory it reads **5/10 refused against 0/2**, and
3,655,632 tokens per task against 3,471,774. On the other three it is byte-identical to `shipped`,
because there are only two owner messages there and both are reserved — which is the honest way
round: the row costs nothing where the mechanism is not exercised.

It also reads **4.41 availability against 4.12**, and that direction is not a defect in the bound.
`owner-earliest-middle` is the probe the bound removes by design; the unbounded row keeps it and
pays with 5 refusals in 10 attempts, which is the trade this rig exists to show rather than to
hide.

Three probes price what the bound costs and what it keeps, at the three positions a middle-out cut
distinguishes:

| probe                    | bound on | bound off | what it says                                          |
| ------------------------ | -------- | --------- | ----------------------------------------------------- |
| `owner-earliest-opening` | 5.0      | 5.0       | a cut keeps the head, so the opening survives         |
| `owner-earliest-middle`  | **0.0**  | 5.0       | the middle is what the bound removes — its whole cost |
| `owner-newest`           | 5.0      | 5.0       | the newest correction is never a candidate            |

`recall-owner-constraint` — the goal — stays at 5.0 in every configuration of every trajectory,
including this one, which is what makes it the control it is described as below.

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
summarization". That is the conclusion athanor took: the `ARTIFACTS WRITTEN` block is dedicated
state tracking, it is fed from where a write lands rather than from a summary, and the artifact
column reads 5.00 on every trajectory with it and 2.50 without — see "where the artifact loss
actually is" below for both numbers and what each mechanism is doing.

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

## Five things that keep the rig honest

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

`compactionRefusals` refuses a run in which compaction was attempted and freed nothing more often
than the accepted numbers allow. It is the counter above, and it is here because it is the one
failure this rig structurally could not report: a window held up entirely by the deterministic
passes in `prepareModelContext` still produces a plausible availability score and a plausible token
count, and reads as a configuration choice rather than as a mechanism that has stopped.

The **frozen-column check** refuses a probe kind that scores the same in every configuration of
every trajectory. A column nothing can move is indistinguishable from a probe that has stopped
reading the window. `starved` — every character bound at its destructive end, never a candidate —
is what gives each kind something that genuinely takes its material away. Run without it, the
artifact column fails this check, which is how it was calibrated — and it is why `starved` gained
`ANCHOR_INDEX_CHARS: 0` when the anchor index landed, `ARTIFACT_LEDGER_ROWS: 0` when the ledger
did, and `OWNER_WINDOW_RESERVE_TOKENS: 1_000_000` when the bound on the owner's accumulated text
did. Each
was a new mechanism the row did not reach, and each saturated the column at 5.00 the day it
shipped.

## Where the artifact loss actually is, and what now holds it

The artifact probes ask for the five paths this task wrote, and for one fact about one of them that
exists in exactly one place.

A written path enters the window twice: in the head of the `file_write` call's arguments, and in the
head of the tool result (`{"ok":true,"path":…`). `truncateMiddle` keeps 62% of the remaining budget
as head. So every ordinary cut in this codebase — the recency bound, the descending older-output
floor, the compacted-argument bound — keeps the path, and the artifact column cannot be moved by the
squeeze at any value anyone would ship. It moves only when a bound is set low enough that the head
is shorter than the path itself (200/120/40, which is `starved`), or when a **compaction replaces
the message outright**.

Two mechanisms now carry a path across that compaction, and they are not the same kind of thing.

The **anchor index** harvests exact identifiers out of the span a compaction is about to drop and
appends them to the brief section after its own bound. It is opportunistic: it carries whatever
happens to look like an identifier, it carries nothing about what was done to the file, and it is
switched off by `ANCHOR_INDEX_CHARS: 0`. On this fixture it holds all five paths on its own, which
is why `artifact-files-touched` reads 5.00 everywhere except `starved` — and why the `anchorless`
row exists, since without it no shipped row can say anything about the second mechanism.

The **artifact ledger** is state. `ARTIFACTS WRITTEN` is re-rendered at the tail of the window on
every step from a durable per-turn record, and each row is written where the write lands — after
`runner.writeFile` has answered, with the byte count the workspace itself reported. It carries, per
path, the path, whether the whole file was replaced or named lines were edited, the bytes it last
weighed, and the step it last changed on. It is bounded at twelve paths and ninety-six characters of
path, and at the bound the oldest row is evicted and counted rather than the newest dropped.

Measured on this rig, at the commit that wired the block in, shipped configuration:

| trajectory                        | artifact column | tokens/task | prefix | own-think |
| --------------------------------- | --------------- | ----------- | ------ | --------- |
| `pool-migration-131k`, no block   | 2.50            | 2,981,016   | 75.6%  | 59/60     |
| `pool-migration-131k`, with block | **5.00**        | 2,978,862   | 76.8%  | 59/60     |
| `pool-migration-1m`, no block     | 2.50            | 3,687,561   | 78.9%  | 59/60     |
| `pool-migration-1m`, with block   | **5.00**        | 3,685,407   | 80.1%  | 59/60     |

And on `anchorless`, where the block is the only thing left carrying the set:
`artifact-files-touched` 3.00 → 5.00 (three of the five paths, then five), the artifact column
1.50 → 5.00, and 57,513 rework tokens → 0 on the small window, 84,806 → 0 on the large one.

It costs one message at the tail on every step after the turn's first write. That is nil at the
shipped `RECENT_DETAIL_MESSAGES = 8` and nil at 5 and 6, and it is 59/60 → 54/60 at `detail-4`,
which is a fact about a four-message reasoning window rather than about the block: the boundary is
counted from the tail, and the tail is now one longer. The table above under "the arithmetic this
found" should be read as `N >= 4 + 2k` once a turn has written anything.

The evidence that a re-rendered block is the right shape for this was already in the fixture before
the block existed: `continuation-plan-order`, a plan narrated in the agent's prose, scores 0.0 in
every compacted configuration, and `continuation-plan-block`, the identical fact carried by the
re-rendered plan block, scores 5.0 in every configuration including `starved`. `artifact-ledger-row`
is the third member of that family — 5.00 everywhere, 0.00 exactly where the block is switched off.

The design and the attacks are in `docs/design/ranked/LEDGER.md`.
