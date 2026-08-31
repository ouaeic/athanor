# The evidence-reach rig

```
pnpm exec tsx evals/reach/run.ts                       # one arrangement, ~1m40s
pnpm exec tsx evals/reach/run.ts --fall                 # the whole fall table, ~15m
pnpm exec tsx evals/reach/run.ts --freeze /tmp/p.json    # keep this corpus for a later run
pnpm exec tsx evals/reach/run.ts --probes /tmp/p.json    # ask the identical questions again
```

Offline, no key, no network, no model. **Not in `pnpm check`, and it cannot be** — see
_Why this is not a gate_ at the bottom, which is the argument rather than the assertion.

## The number

**Evidence reach @1.** Of `n` probes whose gold answer appears **only** in a tool result — in no
owner turn, no assistant message, no reasoning block and no tool call's arguments, anywhere in the
owner's whole corpus — the fraction where the bytes returned by **one dispatched retrieval call**
contain that answer.

It is the right number because it cannot be flattered. Before the reach existed there was no value
of `n`, no ranking, no `maxResults` and no model that could move it off zero: a `session_search`
carrying an id and no query was rejected by `boundedKnowledge` — _"Knowledge content cannot be
empty"_ — before it reached any retrieval code at all. That run is recorded in
`docs/design/reach/RIG.md`: the same rig, the same 146 probes, `apps/` and `packages/` at
`00a2168`, **0/146**, with the memory itself perfectly findable underneath it.

## The corpus, and why it is not in the repository

Mined on every run from `~/.claude/projects`, on the corrected owner-turn filter: `type: user`,
`userType: external`, not a sidechain, not a tool result, not `isMeta` with a `sourceToolUseID`, no
slash-command or compaction-continuation block, deduped by uuid, `origin.kind: "task-notification"`
stripped. That filter reproduces `docs/design/sota/RULING.md` §2.1 to the character on this disk,
which is the check that it is the same filter and not a near one.

Nothing mined is committed. These are the owner's private transcripts and the checkout lands on
every owner's machine, so what `baseline.json` holds is aggregates and a digest of the probe keys —
`sha256` over `turnUuid + toolCallId + gold`, twelve hex characters, out of which no sentence
anybody typed can be recovered. `--freeze` writes the full mined set to a path the caller names,
which must be outside the repository; it exists so that the fall table asks every arrangement the
identical questions, because the corpus grows under the rig while it runs — the owner is working.

**A probe** is one owner turn plus one gold token from one of its tool results, subject to all of:

| condition                                                    | what it stops                                      |
| ------------------------------------------------------------ | -------------------------------------------------- |
| in exactly one result of that turn                           | the citation not having to be the right one        |
| in no owner turn and no assistant message, corpus-wide       | the verbatim tier answering it — that scores 93.8% |
| in no reasoning block and no call's arguments                | a detail the agent wrote rather than observed      |
| at most 3 appearances across every tool result in the corpus | the answer being a word rather than a detail       |
| 8–48 characters, at least one digit and one letter           | a substring test that means nothing                |

The question is built from the request's own rarest words — document frequency 1 to 8 across the
676 owner requests — and never contains the gold. Locating the turn is therefore about as easy as
it can be, on purpose: this rig measures reach, and a question that also stressed retrieval would
report one number for two mechanisms. `located` is printed beside the headline for that reason.

## The columns

| column       | what it is                                                                      |
| ------------ | ------------------------------------------------------------------------------- |
| `reach@1`    | the pack is in the window (free, it is prompt); **one** `session_search({id})`  |
| `reach@2`    | `memory_recall(question)`, then `session_search({id})` on the first episode     |
| `reach@2*`   | **a counterfactual, not a path the model has** — see below                      |
| `verbatim@1` | the owner's own request came back from that same call, whole and from its start |
| `packed`     | the gold episode was in the pack at all: the ceiling `reach@1` works under      |
| `ranked`     | `memory_recall` put the gold episode first: the ceiling `reach@2` works under   |
| `located`    | `session_search({query})` found the turn's own verbatim row                     |

`reach@1` needs an id in the window before it spends its one call, which is what
`idReturnedInWindow` requires, and it gets one the way a real turn gets one: `renderMemoryPack`
prints `- id=<uuid>` for every entry. **Choosing which id is the one judgement a model makes and
this rig cannot**, so it is made by a stated policy over text already in the window — the Episodes
entry sharing the most of the question's rare words. The policy cannot see the gold: the gold is in
no pack entry by construction. It is restricted to Episodes because only an episode carries
`mem.cited_call` rows, `recordTurnEpisode` being their only writer, and the section headings are in
the window — so it is a choice the model can make, not a hint about the answer.

`reach@2*` runs the same search through the store rather than the tool, and reaches for the
`episodeId` of the hit it already found. `MemorySourceHit` carries that column and
`MemorySessionTurn` — what the tool returns — drops it. So `reach@2*` is what one field on that
return type would be worth, measured. It is never the product's number.

## The gates, and which of them a baseline cannot replace

1. **The corpus gates.** 500 owner turns, 8 projects, 60 probes, 5 conversations, and no probe
   whose question contains its own answer. A rig that mined four probes out of one conversation
   would satisfy any baseline perfectly and be measuring nothing.
2. **The separation gate.** `shipped` must reach at least ten times what `no-citation` reaches, and
   `no-citation` must reach **exactly zero** — with no citation stored there is nothing to follow,
   so a single hit there means something other than the reach is answering these probes.
3. **The self-checks** (`selftest.ts`, every run, not behind a flag). They re-derive the exclusion
   from the turns rather than from the miner that built the probes, check each probe against the
   transcript it came from, require both sides of the reach's character bound to be exercised, and
   read the fall table to confirm every fault actually bit.
4. **The baseline**, under `--ci`, as rates rather than counts because the corpus grows. On
   `shipped` a fall fails and a rise passes. On the fault rows it is the other way round: those
   numbers are meant to be on the floor, and a fault that has started letting probes through is a
   broken instrument rather than an improvement.

`--accept` refuses a limited run, a run that is not the whole fall table, and any run that failed
its own checks. It does not refuse a frozen one: a baseline accepted over the frozen set is the
baseline whose numbers a recorded table can be checked against, and the stamp carries that set's
digest, so a later live run prints the difference rather than hiding it.

## Attacked

`docs/design/reach/RIG.md` has the table: the reach as the tree has it, then each defect put back —
the `toolCallId` dropped at `memory-capture.ts:92`, `listMemoryEvidence` returning the pointer
without the body, and the half-open evidence span read as though it were closed — with what each
one does to the number, and the exit codes.

Two of the three are seeded: the store is stood up as the defective writer would have left it and
the shipped reader reads it. The third is a decorator over the store, because that defect was in a
`SELECT` and there is no way to write a row that arrives without its body. None of them edits a
file outside `evals/`.

## Why this is not a gate, and why that is not a dodge

`CONTRIBUTING.md` keeps `pnpm eval` out of `pnpm check` deliberately: "a behavioural suite that
blocks every commit is a suite somebody deletes the first week it disagrees with them". It also
classifies the eval cost report as an **instrument** — something that "reports a number nobody
could otherwise see, and does not care what the number is" — and instruments are required and never
deleted, not gates.

This is an instrument by that definition, and gating it would convert it into a ratchet: the moment
`reach@1` is a build failure, the cheapest way to keep the build green is to make the probes
easier, and the corpus is mined by code in this directory. That is the failure mode, and it is not
hypothetical here — this repository's own history includes a fixture that re-observed with an
episode the row already held so that a count could not climb.

There is a second reason, and it is the one that settles it without needing the first: **the rig is
machine-bound.** Its corpus is the owner's own transcripts on the owner's own disk. On any other
machine, and in CI, `~/.claude/projects` does not exist and the rig exits 2 saying so. A gate that
cannot run where the build runs is not a gate; it is an instrument with a baseline, which is what
this is.

So: run it before and after any change to `apps/worker/src/memory-runtime.ts`'s reach,
`memory-capture.ts`'s citation write, `packages/data/src/store/memory.ts`'s provenance readers, or
`mem.cited_call`'s migration. Nothing will run it for you, which is the same arrangement
`pnpm eval` is under and for the same reason.

## The files

| file          | what it holds                                            |
| ------------- | -------------------------------------------------------- |
| `corpus.ts`   | the owner-turn filter, the probe miner, and the digest   |
| `seed.ts`     | PGlite, real migrations, and the production write path   |
| `measure.ts`  | one probe through `executeToolCall`, and the roll-up     |
| `faults.ts`   | the three defects, put back, and the fall table          |
| `report.ts`   | the table, the baseline, and the gates on the rig itself |
| `selftest.ts` | the checks the table cannot perform                      |
| `run.ts`      | the entry point                                          |
