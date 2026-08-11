# Behavioural evaluation

## Why it exists

Every consequential decision in the agent loop is defended by a comment citing one remembered
incident. That is how the loop came to hold six independent gates on `finish` — a verification
rejection, a plan hold, an acceptance hold, a silence hold, an acceptance-check refusal and a
completion nag — plus a fallback plan, a baseline refusal, a repetition watch and a truncation
continuer. Each of them was right about the failure it saw. None of them can be removed, because
nobody could say what removing one would cost.

`evals/` answers that. Forty-two owner-shaped requests run against the real agent loop with a
stubbed model, a stubbed workspace runner and a stubbed media provider, and every one reports what
it cost: how many model calls, how many prompt tokens, how much of each request repeated the one
before it byte for byte, how many commands the workspace ran, how many generations the provider was
charged for and on which route, and which gates fired. Delete a gate, run the suite, read the
difference. That is the whole point.

## Running it

```
pnpm eval                     # the whole suite and the report
pnpm eval --filter research   # only fixtures whose id or shape matches
pnpm eval --trace             # also print what the loop said back to the model
pnpm eval --json out.json     # write the raw results as well
pnpm eval --update            # rewrite evals/baseline.json from this run
```

It is offline and deterministic: no provider key, no network, no workspace runner, nothing to set
up. A run takes a few seconds.

`pnpm eval` exits non-zero when a fixture's expectations fail. It is **not** part of `pnpm check`,
and it should not become part of it. A behavioural suite that blocks every commit is a suite
somebody deletes the first week it disagrees with them, and these fixtures are meant to be argued
with — a change to a step count is a decision to make, not a build to fix. Run it before and after
any change to `apps/worker/src/agent.ts`, `context.ts` or `tools.ts`, and in CI on its own schedule.

The types are checked by `pnpm typecheck`, and the code is linted by `pnpm lint`, both of which do
gate commits. Only the behaviour is kept out.

## What the report says

Each row is one fixture: its shape, the model calls it cost, the estimated prompt tokens athanor
built across those calls, how much of each request was a byte-for-byte repeat of the one before it,
and the drift of all three against `evals/baseline.json`. Under the table, `WHAT FAILED` names the
fixtures whose expectations broke, each with the prose statement of what it was protecting;
`WHAT THE HOLDS COST` totals how many fixtures each gate fired on and how many extra model calls it
bought.

Token drift of a few tokens with no step change is the runtime block's clock, which carries the
current time and is rebuilt on every step. Anything larger is a real change in what athanor sends.

The `cached` column is the other half of what a long task costs, and the half nothing here could
previously see. Every provider that bills a cached prefix bills it as a prefix — the read stops at
the first byte that differs from what it already holds — so the leading run one request shares with
the last is the ceiling on what could be handed back cheaply. A turn that only appends to its window
measures about 97%. A turn that rewrites bytes near the front of it, for any reason, falls into the
sixties, and the step count does not move at all. Measured on the long fixture, which condenses
nothing on a million-token window: with its tool results small enough that the older-output floor
never has to move, the same thirty-two steps read 95%; with them large enough that the floor walks
down to its hard limit, 65%. Thirty points of a long job's bill, and not one other number in the
report changes. A single-call turn has no previous request and reports `-`.

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
condensed and how many sections the running brief ended up carrying; whether the owner's own words
survived in the last window byte for byte; and the shortest a squeezed tool result may be left.

The one place the suite is coupled to text is recognising _which_ gate fired, because the loop
pushes its holds back as prose and exports no enum for them. The markers live in one table in
`evals/harness.ts`. A fixture never asserts on a sentence — only on which gate and what it cost — so
a reworded hold fails loudly at the marker rather than silently reporting a green run.

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

`long-finished-phases-condense-rather-than-shred` is the exception and fails on purpose. Thirty-two
batches of log output on a million-token release — the window both shipped defaults declare — with
the agent saying a phase is finished three times, as the contract asks it to. Every one of those is
answered with a refusal to condense anything, because the verbatim tail the compaction target asks
to keep is larger than the whole conversation; so the window is held down by cutting older tool
results to the two-thousand-character floor instead, and the owner pays the write price on the
prompt again on every step it moves. Run against a window where the same target does fit, the same
job costs 2,670,814 prompt tokens instead of 3,683,938, and its largest single prompt 108,160
instead of 173,241. The fixture goes green when compaction can run on the shipped defaults; until
then `pnpm eval` exits non-zero on this one row, and that is the number it is reporting.

## What it does not do

The model is scripted, so nothing here measures model judgement. It measures the harness: what the
loop does with a given trajectory. A fixture where the scripted model behaves well and one where it
behaves badly are both statements about athanor's response, not about any model's quality.
