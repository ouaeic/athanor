import test from 'node:test';

/**
 * The operating-system floors, checked where a person will actually see it.
 *
 * `verify-native-config.mjs` throws on the first thing that disagrees, which makes it a gate rather
 * than a report - but it was only ever reached from `native:build` and `native:configure`, and
 * neither runs under `pnpm check`. `apps/desktop` has no `build` script, so `pnpm -r build` skips
 * the package entirely. The four floors were therefore enforced only in CI, on a machine with the
 * whole native toolchain, which is the last place you want to discover that a number moved.
 *
 * `targetSdk` is the one that made this worth wiring: it has an external deadline rather than an
 * internal one, and a submission refused by a store months from now is not a failure that points
 * back at the commit that caused it.
 *
 * Importing is the whole test. Every path it reads is tracked - `build.gradle.kts`, `project.yml`,
 * both `Info.plist`s, the capability files and `tauri.conf.json` - so this needs no build, no
 * generated tree and no Xcode, and it says the same thing on a fresh clone as it does here.
 */
test('the declared operating-system floors still hold', async () => {
  await import('./verify-native-config.mjs');
});
