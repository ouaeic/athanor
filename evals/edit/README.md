# The edit-format rig

```
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/edit/run.ts
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/edit/run.ts --ci
```

Two ways of writing the same edit, over the same files, priced in the characters the model has to
emit and scored on whether the file afterwards is the file the edit asked for.

- **quote** — `file_patch`, which ships: `oldText` must occur exactly once, so the model quotes
  enough of the file to be unique and then quotes it all back with the change in it.
- **by-line** — the candidate in `apps/worker/src/edit/`, which does not ship and is not on the
  catalogue: a line range, a whole-file tag proving which read the numbers came from, and a body of
  `+` rows that is only the final text.

```
NODE_OPTIONS=--conditions=development pnpm exec tsx evals/edit/selftest.ts
```

It runs no model, costs nothing, and is not on `pnpm check`. `--ci` exits non-zero on any change to
the committed baseline, so a ruling can pin the numbers it was made on.

## Why it is allowed to be believed

Neither dialect is hand-written anywhere. An edit is declared once, in `corpus.ts`, as a change to
lines; `encode.ts` derives both encodings from it. A rig where the author writes both sides is a
rig where the author picks the winner, and the argument this exists to settle has been made from
reading source and forming a view too many times already.

`selftest.ts` is where that is proved rather than asserted. It applies both encodings to a clean
copy of every file and demands the two results are byte-identical to each other and to the intended
text — which is computed a third way and read by neither encoder. A by-line patch that quietly did
less work would otherwise show up as a saving and look exactly like a real one.

The incumbent is given its best encoding, not a plausible one: `minimalUnique` searches every split
of the context between the two sides and returns the smallest `oldText` that is unique. If the
incumbent loses a row it loses it at its best.

`assertIncumbentSemantics()` reads `apps/worker/src/tools/workspace.ts` and throws unless the two
lines this rig reimplements — the exactly-once guard and the single replace — are still what ships.
A rig holding a private copy of what it measures eventually measures a program that no longer
exists, confidently.

`selftest.ts` also proves `minimalUnique` really is minimal, by trying every narrower quote that
still contains the lines being replaced and demanding that none of them is unique.

## What it cannot tell you

It runs no model, so it says nothing about whether a model can produce the dialect correctly, and
that is the single largest unknown about the format. Treat the tables as an upper bound on the
saving, available only to a model that gets the dialect right every time.

## The files

| file         | what it holds                                                      |
| ------------ | ------------------------------------------------------------------ |
| `corpus.ts`  | three files and the declared edits, including the refusal cases    |
| `encode.ts`  | both encoders, the incumbent's applier, and the intended result    |
| `measure.ts` | one run per task per format                                        |
| `report.ts`  | the pre-registration, the tables, the residency arithmetic, `--ci` |
| `run.ts`     | the entry point                                                    |
