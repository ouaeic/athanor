# The edit-format conformance rig

```
pnpm eval:edit
pnpm eval:edit -- --ci        # on pnpm eval:rigs, and therefore on pnpm check
pnpm eval:edit -- --accept    # rewrite the committed baseline from this run
```

Offline, no key, no network, about a second.

## What it answers

`file_patch` addresses edits by line number. That format was bought on a measured saving in output
characters, and the objection that held it for two waves was that the saving is an upper bound
available only to a model that emits the dialect perfectly. This rig answers the objection by
pricing the imperfection.

**Sixty-four ways a model can get the format wrong** are driven through the real applier and the
real snapshot store, and each one is scored in the currency the ship decision is priced in:

| cost     | meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `0`      | landed, byte-identical to what the model asked for. Nothing extra.    |
| `1`      | refused, and the model's very next call can be the corrected patch.   |
| `2`      | refused, and the model has to read the file again first.              |
| `X`      | the tool reported success and the bytes on disk are wrong.            |
| `X-echo` | the same, but the result displays the damaged lines on the same turn. |

**The same malformed intents go through the editor this format replaced**, priced with the same
function, so the comparison is not the character count everyone has already argued about. If the
retired format's failures are more expensive, the case for the new one does not depend on the model
being perfect at all — and that is what the second table says.

## Why it is allowed to be believed

- **"Self-sufficient" is decided by a program.** A refusal about the file has to quote the file back
  under its real line numbers, three consecutive rows of it, each matching the file as it really
  reads. A refusal about spelling has to name a legal spelling. Both tests are in `conformance.ts`,
  both are applied to both formats, and `selftest.ts` exercises them on inputs whose answers are
  known — including a window that is subtly wrong, which they must reject.
- **Every case declares what a forgiving harness must do before it is run.** A refusal of an
  emission the harness had the evidence to recover is `over-refused`, and is counted even though it
  costs only one trip: it is a trip nobody had to pay. Those rows are the findings.
- **The baseline fails in both directions.** A row that gets worse is a regression; a row that gets
  better is a fix that has to be accepted on purpose, so it shows up in the diff rather than
  quietly erasing a defect nobody wrote down.
- **The comparison is pinned to the repository.** `assertIncumbentRetired` reads
  `apps/worker/src/tools/workspace.ts` and throws if the quoted editor's two load-bearing lines come
  back, because then every sentence here about "the editor this replaced" would be false. Its
  explainer, `apps/worker/src/patch-failure.ts`, is imported rather than copied, so the refusals
  priced in the second table are the real ones.
- **The rig was attacked.** Twelve bounds were broken one at a time, each watched go red, each
  restored SHA-256-identically. Two of the twelve found nothing, and both are reported rather than
  counted. `docs/design/edit/ATTACK.md` has the table.

## What it cannot tell you

It runs no model. Every emission in the corpus is one a model plausibly produces, but **the rate at
which models produce each one is not measured anywhere in athanor and is not measured here.** This
bounds the cost of each failure; it does not weight them. A defect that never happens costs nothing
and a cheap refusal that happens on every third edit costs a great deal, and nothing in this
directory can tell those apart.

## The files

| file             | what it holds                                                                 |
| ---------------- | ----------------------------------------------------------------------------- |
| `conformance.ts` | the sixty-four malformed emissions, the cost model, and the two message tests |
| `incumbent.ts`   | the retired editor, its batch rule, the paired intents, and the pin           |
| `corpus.ts`      | the three files the cases are edited against                                  |
| `encode.ts`      | `minimalUnique`, which prices the retired format's own recovery               |
| `selftest.ts`    | the checks aimed at this rig rather than at the applier                       |
| `report.ts`      | the questions, the tables, and the baseline gate                              |
| `run.ts`         | the entry point                                                               |
