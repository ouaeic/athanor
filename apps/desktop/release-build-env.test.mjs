import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkNativeBinaries } from './check-native-binary.mjs';
import { releasePathMappings, withReleaseRustFlags } from './release-build-env.mjs';

test('release Rust flags remap the user, Cargo, and workspace paths', () => {
  const environment = {
    HOME: '/Users/builder',
    CARGO_HOME: '/Users/builder/custom-cargo',
    GITHUB_WORKSPACE: '/Users/builder/work/athanor'
  };
  const mappings = releasePathMappings(environment);
  assert.deepEqual(mappings, [
    { source: '/Users/builder', destination: '/build-user' },
    { source: '/Users/builder/custom-cargo', destination: '/cargo' },
    { source: '/Users/builder/work/athanor', destination: '/workspace' }
  ]);
  const configured = withReleaseRustFlags(environment);
  assert.match(configured.CARGO_ENCODED_RUSTFLAGS, /--remap-path-prefix/);
  assert.match(configured.CARGO_ENCODED_RUSTFLAGS, /\/Users\/builder=\/build-user/);
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, undefined);
});

test('release Rust flags never silently discard caller flags', () => {
  assert.throws(
    () => withReleaseRustFlags({ HOME: '/home/builder', RUSTFLAGS: '-C target-cpu=native' }),
    /Move those arguments/
  );
  const configured = withReleaseRustFlags({
    HOME: '/home/builder',
    CARGO_ENCODED_RUSTFLAGS: '-C\u001ftarget-cpu=native'
  });
  assert.ok(configured.CARGO_ENCODED_RUSTFLAGS.startsWith('-C\u001ftarget-cpu=native\u001f'));
});

test('native artifact audit rejects a build home and accepts remapped output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-native-audit-'));
  const release = join(directory, 'release');
  const executable = join(release, 'athanor-desktop');
  const environment = {
    HOME: '/Users/builder',
    CARGO_HOME: '/Users/builder/.cargo',
    GITHUB_WORKSPACE: '/Users/builder/work/athanor'
  };
  try {
    await mkdir(release);
    await writeFile(executable, 'safe /cargo/registry dependency path');
    await checkNativeBinaries(directory, environment, 'desktop');
    await writeFile(executable, 'leaked /Users/builder/.cargo/registry source path');
    await assert.rejects(
      () => checkNativeBinaries(directory, environment, 'desktop'),
      /build-machine path/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
