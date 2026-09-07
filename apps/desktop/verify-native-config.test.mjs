import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test(
  'the generated iOS phase dispatches the installed CLI from the Xcode working directory',
  {
    skip: process.platform !== 'darwin'
  },
  async () => {
    const { iosBuildPhaseScript } = await import('./verify-native-config.mjs');
    const sourceRoot = fileURLToPath(new URL('./src-tauri/gen/apple/', import.meta.url));
    const output = execFileSync('/bin/sh', ['-c', iosBuildPhaseScript], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        SRCROOT: sourceRoot,
        PLATFORM_DISPLAY_NAME: 'iOS Simulator',
        SDKROOT: '/unused SDK/iPhoneSimulator.sdk',
        FRAMEWORK_SEARCH_PATHS: 'framework path with spaces',
        HEADER_SEARCH_PATHS: 'header path with spaces',
        GCC_PREPROCESSOR_DEFINITIONS: '',
        CONFIGURATION: 'Release',
        FORCE_COLOR: '',
        ARCHS: '--help'
      },
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.match(output, /Usage:.*ios xcode-script/s);
    assert.match(output, /--sdk-root/);

    const directory = mkdtempSync(join(tmpdir(), 'garden-ios-phase-'));
    try {
      const capture = join(directory, 'capture.cjs');
      writeFileSync(
        capture,
        'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(0);'
      );
      const args = JSON.parse(
        execFileSync('/bin/sh', ['-c', iosBuildPhaseScript], {
          cwd: sourceRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${JSON.stringify(capture)}`,
            SRCROOT: sourceRoot,
            PLATFORM_DISPLAY_NAME: 'iOS Simulator',
            SDKROOT: '/unused SDK/iPhoneSimulator.sdk',
            FRAMEWORK_SEARCH_PATHS: 'framework path with spaces',
            HEADER_SEARCH_PATHS: 'header path with spaces',
            GCC_PREPROCESSOR_DEFINITIONS: 'FEATURE=1 DEBUG=0',
            CONFIGURATION: 'Custom Release',
            FORCE_COLOR: '',
            ARCHS: 'arm64 x86_64'
          },
          encoding: 'utf8',
          timeout: 30_000
        })
      );
      assert.deepEqual(args, [
        fileURLToPath(new URL('./node_modules/@tauri-apps/cli/tauri.js', import.meta.url)),
        'ios',
        'xcode-script',
        '-v',
        '--platform',
        'iOS Simulator',
        '--sdk-root',
        '/unused SDK/iPhoneSimulator.sdk',
        '--framework-search-paths',
        'framework path with spaces',
        '--header-search-paths',
        'header path with spaces',
        '--gcc-preprocessor-definitions',
        'FEATURE=1 DEBUG=0',
        '--configuration',
        'Custom Release',
        'arm64',
        'x86_64'
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
