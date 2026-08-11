# Behavioural evaluation

## Why it exists

Every consequential decision in the agent loop is defended by a comment citing one remembered
incident. That is how the loop came to hold six independent gates on `finish` — a verification
rejection, a plan hold, an acceptance hold, a silence hold, an acceptance-check refusal and a
completion nag — plus a fallback plan, a baseline refusal, a repetition watch and a truncation
continuer. Each of them was right about the failure it saw. None of them can be removed, because
nobody could say what removing one would cost.

`evals/` answers that. Thirty-three owner-shaped requests run against the real agent loop with a
stubbed model and a stubbed workspace runner, and every one reports what it cost: how many model
calls, how many prompt tokens, how many commands the workspace ran, and which gates fired. Delete a
gate, run the suite, read the difference. That is the whole point.

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
built across those calls, and the drift of both against `evals/baseline.json`. Under the table,
`WHAT FAILED` names the fixtures whose expectations broke, each with the prose statement of what it
was protecting; `WHAT THE HOLDS COST` totals how many fixtures each gate fired on and how many extra
model calls it bought.

Token drift of a few tokens with no step change is the runtime block's clock, which carries the
current time and is rebuilt on every step. Anything larger is a real change in what athanor sends.

The baseline is committed. Update it deliberately, in the same commit as the change that moved it,
so the diff records what a change to the loop cost.

## What a fixture can assert

Behaviour, never wording. A fixture may expect any of: the number of model calls; the tools that
actually ran, in order; the tools the model asked for; the catalogue offered on the final request;
the number of commands the workspace ran; where the task ended up (`completed`, `awaiting_user`);
the verification status the completion carried; whether the owner was asked to approve something;
whether untrusted content was recorded as entering the turn; whether a plan nobody asked for was
written; how many separate replies the owner sees; and which gates fired, in order.

The one place the suite is coupled to text is recognising _which_ gate fired, because the loop
pushes its holds back as prose and exports no enum for them. The markers live in one table in
`evals/harness.ts`. A fixture never asserts on a sentence — only on which gate and what it cost — so
a reworded hold fails loudly at the marker rather than silently reporting a green run.

## Coverage

The fixtures cover the shapes the product is actually for: reading a document and answering about
it, working on files, running and verifying something, researching across pages, a request that is
genuinely ambiguous, a request that should be refused, and a small request that has to stay small.
They come in deliberate pairs — the same work done two ways — so the cost of a gate is the
difference between two rows rather than an absolute number nobody can interpret.

## What it does not do

The model is scripted, so nothing here measures model judgement. It measures the harness: what the
loop does with a given trajectory. A fixture where the scripted model behaves well and one where it
behaves badly are both statements about athanor's response, not about any model's quality.
