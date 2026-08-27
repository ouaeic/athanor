# Contributing

Contributions are welcome when they preserve athanor’s core boundary: self-hosted software, one
persistent agent computer, user-owned model access, no local model weights, and no mandatory hosted
athanor service.

`AGENTS.md` in this directory carries the same rules in the shape a coding agent reads them, and is
the shorter document. Everything below is the reasoning behind it.

## Before coding

Open an issue or design note for schema changes, new external services, new native capabilities,
approval-policy changes, or anything that exposes a new network surface. Include:

- the user problem;
- the smallest interface change;
- credential and content flow;
- failure and rollback behavior;
- license and upstream terms;
- which bound proves the security boundary holds, and what happens when it is switched off.

## Local checks

```bash
pnpm install --frozen-lockfile
CI=true pnpm check
```

`pnpm check` runs these gates in a fixed order, cheapest first, so the one that fails is usually the
one that costs least to run:

1. `pnpm license:check` and `pnpm release:check` — dependency licences, and the release manifest.
2. `node scripts/check-repository.mjs` — it parses every shell, Python and Node program that ships to
   a server, lints the skill library, holds `.env.example` to the defaults the code declares, holds
   the constants this repository deliberately copies between packages against each other, and holds
   several published sentences against the code they describe. It also runs `shellcheck` when it is
   installed, and requires it in CI.
3. `node scripts/test-document.mjs` — it builds and measures real documents through the installed
   toolchain, so a document route that has stopped producing bytes fails here rather than in front of
   an owner.
4. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
5. `pnpm eval:rigs` — the four rigs that hold a committed baseline: context quality, prompt
   injection, the arm comparison, and approval cards. They are offline, need no key, and finish in
   about seven seconds between them. They are here rather than nightly because each one answers
   "did this change cross a floor", and a floor that quietly stops firing is not a drift to argue
   with in the morning — the cards rig in particular pins that reading untrusted content still
   costs the owner no approvals at all.
6. `pnpm build`.

That list is checked against `package.json` by `scripts/check-repository.mjs`, in both directions and
in order, so a gate added to the script and not to this page fails the build rather than going
unmentioned.

`pnpm eval` is deliberately **not** part of `pnpm check`, and the reason is not cost. It is offline
and deterministic — a scripted model, a stubbed workspace runner, a stubbed media provider, no
provider key and no network — and it takes seconds. It is kept out because a behavioural suite that
blocks every commit is a suite somebody deletes the first week it disagrees with them, and these
fixtures are meant to be argued with: a change to a step count is a decision to make, not a build to
fix. Run it before and after any change to `apps/worker/src/agent.ts`, `context.ts` or `tools.ts`,
and read `docs/EVALUATION.md` first.

The server's shell is not covered by the TypeScript suites, so a set of drills runs it against
fixtures. They need no root, no network and no server, and they finish in seconds:

```bash
sh scripts/test-sandbox.sh          # which account an agent command really lands on
sh scripts/test-certificate.sh      # renewal, reissue and the recorded failure alarm
sh scripts/test-relay-endpoint.sh   # what the connection manifest advertises, relay on and off
sh scripts/test-update.sh           # transactional update and its rollback
sh scripts/test-native-provisioning.sh  # the browser revision, the update record, the spending cap
sh scripts/test-system-packages.sh  # which package manager an approved install actually reaches
```

Three of them — `test-sandbox.sh`, `test-certificate.sh` and `test-relay-endpoint.sh` — also run in
CI's `native-units` job, and `test-system-packages.sh` already runs inside `pnpm check` by way of
`scripts/check-repository.mjs`. They are listed here because running one directly is how you read its
output; `test-update.sh` and `test-native-provisioning.sh` have nothing but this list standing
behind them. A new drill that this
page does not name fails `scripts/check-repository.mjs`, for the same reason as the gate list above.

For the Tauri shell:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

## Tests

athanor's suites are not one kind of thing, and the difference decides both whether a test is worth
writing and when it is safe to delete. Every test in this repository is one of four kinds, and you
should be able to say which before you write it.

**An instrument** reports a number nobody could otherwise see, and does not care what the number is.
`pnpm eval`'s cost report, `context.test.ts`'s sixty-step cache harness, `evals/context-quality`'s
matrix and `evals/agentdojo` are instruments. They are how a change is priced before it is argued
about, and they are the only reason any figure in `docs/` exists. **Required, and never deleted.**

**A bound** asserts that a limit actually fires: a step budget, a spend ceiling, a byte cap, a
refusal, an approval card, a taint mark. Its title names the limit. `turn-bounds.test.ts` is almost
entirely bounds. **Required for every limit you add, and never deleted while the limit exists.**

**A contract** asserts that two things which cannot import each other still agree — a value copied
across a bundle gate, a table in one process against a branch in another, a published sentence
against the code it describes. Required, but read the next section first: a test is usually the
_worst_ available home for a contract.

**A ratchet** pins current behaviour so that changing it costs work. It asserts what the code does
rather than what it must never do. Not required, and the only kind that may be deleted along with
the code it pins.

### Bounds a change has to leave standing

Stated as the properties, not as a list of files to add tests to. If your change touches one of
these, the bound that proves it must still fire afterwards, and you should have watched it go red:

- a migration runs forward and the PGlite and PostgreSQL stores answer the same;
- authentication, origin, ownership, idempotency and recent-authentication checks each refuse;
- the runner refuses out-of-scope capability, blacks out secure input, truncates unbounded output,
  honours cancellation, and refuses an SSRF target;
- a malformed tool call is tombstoned, a specialist handoff stays read-only, and hostile untrusted
  content neither grants authority nor replaces the goal;
- no content canary reaches an application log;
- the interface stays reachable by keyboard, lays out on a phone, reconnects, and can show a task
  completing and an approval waiting;
- install, update, backup checksum, restore, and uninstall each do what they say, and uninstall
  preserves data.

### A pinning test is a placeholder for a contract that has not found its home yet

That is the rule, and it is the reason ratchets are allowed at all. A behaviour pin is what you write
when you know two things must agree and you have nowhere better to say so. It is a note in the margin
that happens to run in CI.

So: **a pinning test must name, in its own comment, the contract it stands in for.** Not the incident
— the contract. "This asserts that the card's wording and the floor's branch list stay the same set"
is a contract. "This asserts `approvalReach` returns this string" is not, and should not be written.

And **when the contract moves to a better home, delete the test in the same change and say so in the
message.** Leaving it behind is not caution. It is a second copy of a rule, and this repository's
worst recurring defect is a second copy of a rule outliving the first.

Homes for a contract, best first. The tiers are the residency tiers the runtime uses, applied to
verification:

1. **Enforced in code.** A type, a discriminated union, one exported constant both sides import. No
   test can fail because no disagreement can be written. Always try this first, and note that the
   commonest reason it is impossible here is a bundle gate or a process boundary — say which.
2. **A repository check** in `scripts/check-repository.mjs`. This is the right home for anything
   static: two files that must agree, a list that must be complete, a published sentence that must
   match the code, a constant copied across a boundary. It runs in `pnpm check`, it reads the tree
   rather than a driven scenario, it fails on the day the drift lands, and it belongs to the whole
   repository rather than to one package's suite. Several checks in that file exist precisely because
   the same assertion was previously a unit test in a client that had no business reading the
   worker's source.
3. **A runtime probe** — `doctor`, a startup assertion, an eval fixture's stated target. Right when
   the fact is only true of a running box.
4. **A prose rule** in `AGENTS.md`, when the property is real but nothing can check it mechanically.
   A rule nobody enforces is weaker than a test; a rule nobody _can_ enforce is stronger than
   pretending otherwise with a test that pins one example of it.

A test is what is left when none of the four fit.

### Every assertion must be capable of failing

The cheapest way to write a test that can never fail is to put every assertion inside a loop over a
production collection and assert nothing about the collection. Empty the collection and the body
never runs; the test passes in zero milliseconds and reports a guarantee it is not making. This
repository has shipped that shape more than twenty times, including a command-injection guard and an
AGPL compliance claim.

So every loop over a production collection asserts the collection is non-empty first, with a floor
rather than a bare presence test where the size is known:

```ts
// A regex that stopped matching would pass this silently, which is the failure the check
// exists to prevent wearing the costume of a pass.
expect(checked).toBeGreaterThan(0);
```

The same rule applies to a regex that scrapes a source file, a `git ls-files` glob, and a directory
walk. If the thing being read can come back empty, say what empty means.

### Before you delete a test

Delete freely, and say what you did. A behaviour pin goes with the code it pins; a contract's pin
goes when the contract lands somewhere better; a bound goes only with its limit; an instrument does
not go. What is not acceptable is deleting a test because it failed. If a bound goes red, either the
limit moved on purpose — change the bound and say why in the message — or you have found the thing
it was written for.

## Code rules

- Strict TypeScript and Zod at every trust boundary.
- No `any` or non-null assertion at a security boundary.
- No user content or credentials in logs, metrics, notifications, audit labels, or URLs.
- No model server, weight downloader, inference GPU deployment, or silent local fallback.
- External side effects must pass the common approval policy.
- Dynamic tools must be discoverable, bounded, scoped, and attributable.
- Prefer conflict-checked patches and idempotent mutations.
- Pin dependencies and GitHub Actions; update license notices and the lockfile together.
- A comment may say why the code is not the obvious thing. It may not say what the code used to be,
  or which wave changed it: that decays faster than the code and reads as fact long after it stops
  being one.
- No tracked file weighs another product against anything. The rule covers comments as surely as
  prose — the whole checkout lands on every owner's machine — and `scripts/check-repository.mjs`
  enforces it.
- Do not commit `.env`, generated builds, browser profiles, workspace volumes, or publisher OAuth
  state.

Contributions are accepted under the license of the component changed. By submitting a change, you
certify that you have the right to do so.
