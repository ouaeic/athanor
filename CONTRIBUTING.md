# Contributing

Contributions are welcome when they preserve athanor’s core boundary: self-hosted software, one
persistent agent computer, user-owned model access, no local model weights, and no mandatory hosted
athanor service.

## Before coding

Open an issue or design note for schema changes, new external services, new native capabilities,
approval-policy changes, or anything that exposes a new network surface. Include:

- the user problem;
- the smallest interface change;
- credential and content flow;
- failure and rollback behavior;
- license and upstream terms;
- tests that prove the security boundary.

## Local checks

```bash
pnpm install --frozen-lockfile
CI=true pnpm check
```

`pnpm check` is nine gates in a fixed order, cheapest first, so the one that fails is usually the one
that costs least to run:

1. `pnpm license:check` and `pnpm release:check` — dependency licences, and the release manifest.
2. `node scripts/check-repository.mjs` — it parses every shell, Python and Node program that ships to
   a server, lints the skill library, holds `.env.example` to the defaults the code declares, and
   holds the constants this repository deliberately copies between packages against each other. It
   also runs `shellcheck` when it is installed, and requires it in CI.
3. `node scripts/test-document.mjs` — it builds and measures real documents through the installed
   toolchain, so a document route that has stopped producing bytes fails here rather than in front of
   an owner.
4. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

`pnpm eval` is deliberately **not** part of `pnpm check`: it spends money at a model provider. Run it
before changing anything that touches the turn loop, and read `docs/EVALUATION.md` first.

The server's shell is not covered by the TypeScript suites, so five drills run it against fixtures.
They need no root, no network and no server, and they finish in seconds:

```bash
sh scripts/test-sandbox.sh          # which account an agent command really lands on
sh scripts/test-certificate.sh      # renewal, reissue and the recorded failure alarm
sh scripts/test-relay-endpoint.sh   # what the connection manifest advertises, relay on and off
sh scripts/test-update.sh           # transactional update and its rollback
sh scripts/test-system-packages.sh  # which package manager an approved install actually reaches
```

Three of them — `test-sandbox.sh`, `test-certificate.sh` and `test-relay-endpoint.sh` — also run in
CI's `native-units` job, and `test-system-packages.sh` already runs inside `pnpm check` by way of
`scripts/check-repository.mjs`. They are listed here because running one directly is how you read its
output; only `test-update.sh` has nothing but this list standing behind it.

For the Tauri shell:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

## Required tests

- Migrations and PGlite/PostgreSQL store behavior.
- Authentication, origin, ownership, idempotency, and recent-authentication checks.
- Runner capability scope, secure-input blackout, bounded output, cancellation, and SSRF regressions.
- Model tool-call conformance, specialist handoff, and hostile untrusted-content fixtures.
- Content canaries that must never appear in application logs.
- Keyboard access, mobile layout, reconnect, task completion, and approval states.
- Install, update, backup checksum, restore, and uninstall-preserves-data paths.

## Code rules

- Strict TypeScript and Zod at every trust boundary.
- No `any` or non-null assertion at a security boundary.
- No user content or credentials in logs, metrics, notifications, audit labels, or URLs.
- No model server, weight downloader, inference GPU deployment, or silent local fallback.
- External side effects must pass the common approval policy.
- Dynamic tools must be discoverable, bounded, scoped, and attributable.
- Prefer conflict-checked patches and idempotent mutations.
- Pin dependencies and GitHub Actions; update license notices and the lockfile together.
- Do not commit `.env`, generated builds, browser profiles, workspace volumes, or publisher OAuth
  state.

Contributions are accepted under the license of the component changed. By submitting a change, you
certify that you have the right to do so.
