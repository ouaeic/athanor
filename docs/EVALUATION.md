# Behavioural evaluation

## Why it exists

Every consequential decision in the agent loop is defended by a comment citing one remembered
incident. That is how the loop came to hold six independent gates on `finish` — a verification
rejection, a plan hold, an acceptance hold, a silence hold, an acceptance-check refusal and a
completion nag — plus a fallback plan, a baseline refusal, a repetition watch and a truncation
continuer. Each of them was right about the failure it saw. None of them can be removed, because
nobody could say what removing one would cost.

`evals/` answers that. Owner-shaped requests — the count is in the table below — run against the real
agent loop with a stubbed model, a stubbed workspace runner and a stubbed media provider, and every
one reports what it cost: how many model calls, how many prompt tokens, how much of each request
repeated the one before it byte for byte, how many commands the workspace ran, how many generations
the provider was charged for and on which route, and which gates fired. Delete a gate, run the suite,
read the difference. That is the whole point.

One fixture states a target the loop does not meet yet. It is reported as pending rather than as a
failure, with the sentence saying what it is waiting on, so an open gap is visible in the report
instead of being absent from it.

Not every model call in a turn is a step of it. Two of them are somebody else's: the tool-free call
a compaction makes to write its brief, and every step a delegated specialist takes inside its own
window. Both are billed, so both are in the model-call count; neither is a link in the chain the
cached share is measured along, and neither is asked for by the model whose `proposed` list a
fixture asserts on. They are told apart structurally rather than by their wording - a compaction's
request carries no tool catalogue at all, and a specialist's carries one without `finish`, which is
the tool that ends a turn and the one thing no run withdraws from the lead. `delegatedCalls` splits
the specialists back out, because the same total is reached by a turn that thought for six steps and
by a turn that thought for two and sent two missions.

## Running it

```
pnpm eval                     # the whole suite and the report
pnpm eval --filter research   # only fixtures whose id or shape matches
pnpm eval --trace             # also print what the loop said back to the model
pnpm eval --json out.json     # write the raw results as well
pnpm eval --accept            # rewrite evals/baseline.json from this run
pnpm eval:context             # the context-quality matrix, deterministic half
pnpm eval:context --judge     # also the graded half; needs OPENROUTER_API_KEY
pnpm eval:injection           # the injection floor, against a published benchmark
pnpm eval:arms                # two configurations, the same work, one difference
```

Four rigs, and they answer four different questions. This one prices the loop. `eval:context` asks
whether narrowing the window cost the agent anything it needed. `eval:injection` replays a published
untrusted-content benchmark against the floor. `eval:arms` holds two configurations of athanor
against the same sample, which is the only honest way to settle an argument about what should be
resident. Each has a `--ci` or offline arm that needs no provider key.

The flag was called `--update` until the baseline became a gate rather than a printout. Rewriting a
committed baseline is an acceptance, so it is spelled like one; the old name exits 2 and names the
new one rather than silently writing nothing.

The division of labour between the first two is worth being precise about, because it decides which
one can catch what. This suite asserts counters — step counts, token counts, which holds fired — over
a scripted model, so it cannot tell whether narrowing the window cost the agent anything it needed.
`evals/context-quality/` can: it replays sixty steps of one task under each candidate context
configuration and scores whether the fact each probe needs was still in the window at the step that
needed it. Run it before changing any constant in `apps/worker/src/context.ts`, and before cutting
anything from the resident set. A cut that this suite reports as pure saving and that one reports as
a quality regression is damage, and the two together are the only way to tell the difference.

This suite is offline and deterministic: no provider key, no network, no workspace runner, nothing to
set up. A run takes a few seconds.

`pnpm eval` exits non-zero when a fixture's expectations fail. It is **not** part of `pnpm check`,
and it should not become part of it. A behavioural suite that blocks every commit is a suite
somebody deletes the first week it disagrees with them, and these fixtures are meant to be argued
with — a change to a step count is a decision to make, not a build to fix. Run it before and after
any change to `apps/worker/src/agent.ts`, `context.ts` or `tools.ts`, and in CI on its own schedule.

The types are checked by `pnpm typecheck`, and the code is linted by `pnpm lint`, both of which do
gate commits. Only the behaviour is kept out.

## Every number on this page, and where it comes from

This document used to quote its own figures in prose, with an instruction to re-derive them from the
baseline rather than copy them forward. They were copied forward anyway, three times, and ended up
saying three different things — which is worse than saying nothing, because a stale figure in prose
reads exactly like a measurement.

So the figures live here, once, and nowhere else on the page. Every line is a cell of
`evals/baseline.json` or arithmetic over two of them, and `scripts/check-repository.mjs` re-derives
the whole block on every `pnpm check`. Accept a new baseline and this page fails the build until it
is re-derived, naming the value it should now carry. The instruction is no longer advice.

```baseline
fixtures                                                                        70
long-a-finished-phase-is-never-declared.modelCalls                              38
long-a-finished-phase-is-never-declared.promptTokens                     1,446,134
long-a-finished-phase-is-never-declared.catalogueTokens                    470,440
long-a-finished-phase-is-never-declared.cachePrefix                             95
long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly.modelCalls      40
long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly.promptTokens 1,392,264
long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly.catalogueTokens 482,821
long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly.cachePrefix     94
long-finished-phases-condense-rather-than-shred.cachePrefix                     66
compaction.extraModelCalls                                                       2
compaction.tokensSaved                                                      53,870
compaction.cachePointsGivenUp                                                    1
floorWalk.cachePointsLost                                                       28
```

The last four are derived rather than stored, and the check does the subtraction itself:
`compaction.*` is the condensed arm against the control arm of the proof pair, and
`floorWalk.cachePointsLost` is the gap between the two long fixtures whose only material difference
is the size of what their tools returned.

## What the report says

Each row is one fixture: its shape, the model calls it cost, the prompt tokens the provider would
bill for across those calls, how many of those were the tool catalogue, the largest single window
athanor prepared, how much of each request was a byte-for-byte repeat of the one before it, and the
drift of each against `evals/baseline.json`. Under the table, `WHAT FAILED` names the fixtures whose
expectations broke, each with the prose statement of what it was protecting; `WHAT IS PENDING` names
the stated targets the loop does not meet yet, which are not regressions; `WHAT THE HOLDS COST`
totals how many fixtures each gate fired on and how many extra model calls it bought.

`tokens` and `cat` are the two halves of one correction, and it is worth stating plainly what it
changed. The column used to sum athanor's own window estimate, which is the number the compaction
trigger is compared against — and that number counts none of `body.tools`. So the largest fixed cost
the product pays was invisible to the one instrument built to price it: deleting the entire tool
catalogue would have moved the headline column by nothing at all. `tokens` is now what a provider
would charge for, catalogue included, and `cat` is how much of it the catalogue was. On a
question-answering turn `cat` is the overwhelming majority of the row.

`peak` is the largest single request the run prepared, beside the sum of them. The sum says what a
turn cost; `peak` says whether it fitted, and the two move in opposite directions on the same
change — condensing a long turn raises the total by a summarising call and lowers the peak by
whatever it condensed. A row whose peak approaches its window is a row about to start refusing
requests, and nothing in this table could previously see it.

Token drift of a few tokens with no step change is the runtime block's clock, which carries the
current time and is rebuilt on every step. Anything larger is a real change in what athanor sends.

The `cached` column is the other half of what a long task costs, and the half nothing here could
previously see. Every provider that bills a cached prefix bills it as a prefix — the read stops at
the first byte that differs from what it already holds — so the leading run one request shares with
the last is the ceiling on what could be handed back cheaply. A turn that only appends to its window
measures about 97%. A turn that rewrites bytes near the front of it, for any reason, falls into the
sixties, and the step count does not move at all. The two long fixtures make the point on the same
mechanism: `long-a-finished-phase-is-condensed-and-nothing-is-taken-quietly` keeps its tool results
small enough that the older-output floor never has to move, while
`long-finished-phases-condense-rather-than-shred` returns results far larger than that floor, so the
floor walks down and re-cuts every one of them each time it moves. The gap between the two is
`floorWalk.cachePointsLost` in the table above — that much of a long job's bill, decided by nothing
but the size of what the tools returned, and not one other number in the report changes. A
single-call turn has no previous request and reports `-`.

It is measured on the request as the provider reads it — the tool catalogue first, then the
conversation — rather than in the order the JSON body happens to be written, and the tool-free call
a compaction makes to write its brief is left out of the chain: it is a fresh prompt with no
predecessor, and its cost is already in the step count.

The baseline is committed. Update it deliberately, in the same commit as the change that moved it,
so the diff records what a change to the loop cost.

## What a fixture can assert

Behaviour, never wording. A fixture may expect any of: the number of model calls; the tools that
actually ran, in order; the tools the model asked for; the catalogue offered on the final request;
the number of commands the workspace ran; the number of media generations the provider was charged
for, and the model id each of them named on the wire; where the task ended up (`completed`,
`awaiting_user`); the verification status the completion carried; whether the owner was asked to
approve something; whether untrusted content was recorded as entering the turn; whether a plan
nobody asked for was written; how many separate replies the owner sees; which gates fired, in order;
the least share of a request that may repeat the one before it; how many times the window was
condensed — as a floor, or as an exact count for the arm of a pair that must condense nothing — and
how many sections the running brief ended up carrying, and how many of those briefs a model actually
wrote; which of the procedures the turn opened the brief names as no longer in the window; how many
of its model calls a delegated specialist spent; whether the owner's own words survived in the last
window byte for byte; and the shortest a squeezed tool result may be left.

The brief's authorship is asserted wherever a compaction is priced, and it is there because of how
this suite was once wrong about it. `compactContext` answers a summariser it cannot read with a
deterministic summary and reports the compaction as a success, so the difference between the two
shows up as a few per cent on every number and nowhere as a failure. Reading the source off the
compaction's own record is what makes a summariser that stops being answered a red fixture rather
than a quiet retune of the baseline.

The one place the suite is coupled to text is recognising _which_ gate fired, because the loop
pushes its holds back as prose and exports no enum for them. The markers live in one table in
`evals/harness.ts`. A fixture never asserts on a sentence — only on which gate and what it cost — so
a reworded hold fails loudly at the marker rather than silently reporting a green run.

Naming a condensed procedure is the one assertion that reads the brief's own text, and it reads an
identifier rather than a sentence: the skill's name, which is what the model needs in order to
reopen it, matched against the names the fixture's own script asked for. The fixture that makes the
claim gives its summariser nothing to say about which procedure was open, so the name can only be
there because the compaction put it there.

The media assertion is deliberately on the far side of the wire. The unit tests around generated
media hand a resolved route in and assert on the value they handed in, which stays green whether or
not anything carries it as far as `/images` or `/audio/speech`; the fixture reads the model id off
the request the stubbed provider answered, and pins the literal rather than importing the manifest
constant the dispatcher reads — a fixture that read the same constant would move with it and never
say anything.

## Coverage

The fixtures cover the shapes the product is actually for: reading a document and answering about
it, working on files, running and verifying something, researching across pages, making a picture or
a clip and then working on what was made, a request that is genuinely ambiguous, a request that
should be refused, a small request that has to stay small, and a job long enough that what it costs
is decided by how its window is held down rather than by which gate fired.
They come in deliberate pairs — the same work done two ways — so the cost of a gate is the
difference between two rows rather than an absolute number nobody can interpret.

The three mechanisms that decide a long job's bill are covered where they are decided, not where
they are described. Delegation, on `research-a-specialist-reads-and-the-turn-inherits-it`: a mission
is one step of the turn and an open-ended bill underneath it, and the two floors that hold it are
that a specialist's reading crosses back into the turn as untrusted content and that its reach for a
command runs nothing. Compaction, as a pair of proof jobs which differ only in whether the agent
says the first document is finished. Measured on a 128,000-token window, saying so costs
`compaction.extraModelCalls` — the step that asks and the tool-free call that writes the brief — and
saves `compaction.tokensSaved`, for `compaction.cachePointsGivenUp` of cached prefix given up. All
three are subtractions over committed cells, done by the check rather than by a sentence, so the
claim is arithmetic rather than recollection. Subtract the rows and what is left is a compaction,
because the control arm asserts zero compactions and its tool results are deliberately small enough
that the older-output floor never cuts one.

That saving is smaller than it used to look, and the reason is the correction described above. The
two extra calls a compaction costs each re-send the whole tool catalogue, so on the billed measure
part of what the condensed window gives back is spent again on the catalogue that pays no attention
to it. The `catalogueTokens` cells in the table are how much: the condensed arm carries _more_
catalogue than the control arm despite carrying a smaller window, because it makes two more requests.
A compaction is still worth it on this pair, and it is worth less than the window-estimate column
implied — which is what an instrument is for.

And skills, on the same pair: an opened procedure is an ordinary tool result, so a compaction
condenses it like anything else, and the brief has to name what it took or the agent works on to a
procedure it can no longer read with nothing saying so.

The mechanisms judged not worth a fixture, so that the next person does not read their absence as an
oversight. `memory_recall`, `schedule`, `connector_list`/`connector_action`, `desktop_*`,
`browser_action` and `coding_agent` are all single tool calls whose result the loop stores and hands
back; what is interesting about each of them is inside the tool, where its own tests are, and a
fixture would assert that a scripted call produced a scripted result. Two of them additionally
cannot say anything here: the connector tools are withdrawn from the catalogue when nothing is
connected, which is the state every fixture runs in, and `coding_agent` is a sub-agent whose whole
cost is on the other side of a seam this rig does not stub. The three above are different in kind
because none of them is one call: a delegation spends a model, a compaction rewrites the window, and
a skill puts thousands of characters into it that every later step then carries.

`long-finished-phases-condense-rather-than-shred` is the extreme of the same shape. Thirty-two
batches of log output on a million-token release — the window both shipped defaults declare — with
the agent saying a phase is finished three times, as the contract asks it to. It used to fail on
purpose: every one of those was answered with a refusal to condense anything, because the verbatim
tail the compaction target asked to keep was larger than the whole conversation, so the window was
held down by cutting older tool results to the two-thousand-character floor instead. Capping the
trigger in absolute tokens fixed that, and all three now condense. What the row still reports is the
other half of that story: its tool results are far larger than the older-output floor, so the floor
walks down anyway and re-cuts every one of them each time it moves, and its cached share falls below
the proof pair above by `floorWalk.cachePointsLost` — same mechanism, results small enough that the
floor never has to cut one. That much of a long job's bill, decided by the size of what its tools
return.

## What it does not do

The model is scripted, so nothing here measures model judgement. It measures the harness: what the
loop does with a given trajectory. A fixture where the scripted model behaves well and one where it
behaves badly are both statements about athanor's response, not about any model's quality.
