import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { checkNativeBinaries } from './check-native-binary.mjs';
import { releasePathMappings, withReleaseRustFlags } from './release-build-env.mjs';
import { withReleaseSwiftTools } from './release-swift-env.mjs';

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

test(
  'Swift package remapping preserves compiler arguments and removes its temporary tools',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "garden-swift's-tools-"));
    const compiler = join(directory, 'swift');
    const receipt = join(directory, 'arguments.json');
    const capture = join(directory, 'capture.mjs');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(
      capture,
      "import {writeFileSync} from 'node:fs';writeFileSync(process.env.SWIFT_RECEIPT,JSON.stringify(process.argv.slice(2)));\n"
    );
    await writeFile(
      compiler,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)} "$@"\n`,
      { mode: 0o700 }
    );
    const environment = {
      ...process.env,
      HOME: "/build host/owner's home",
      CARGO_HOME: '/build host/cargo',
      GITHUB_WORKSPACE: '/build host/workspace',
      SWIFT_RECEIPT: receipt
    };
    let prepared;
    try {
      prepared = await withReleaseSwiftTools(environment, compiler);
      const wrapper = join(prepared.environment.PATH.split(delimiter)[0], 'swift');
      const original = ['build', '--sdk', '/SDK with spaces', '-Xswiftc', '-existing-option'];
      execFileSync(wrapper, original, { env: prepared.environment });
      const forwarded = JSON.parse(await readFile(receipt, 'utf8'));
      assert.deepEqual(forwarded.slice(0, original.length), original);
      const mappings = releasePathMappings(environment);
      assert.ok(mappings.length > 0);
      for (const { source, destination } of mappings) {
        const map = `${source}=${destination}`;
        assert.ok(forwarded.includes(map));
        assert.ok(forwarded.includes(`-ffile-prefix-map=${map}`));
        assert.ok(forwarded.includes(`-fdebug-prefix-map=${map}`));
      }
      assert.ok(forwarded.includes('-file-prefix-map'));
      assert.ok(forwarded.includes('-debug-prefix-map'));
      execFileSync(wrapper, ['-target', 'arm64-apple-ios15.0', '-print-target-info'], {
        env: prepared.environment
      });
      assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), [
        '-target',
        'arm64-apple-ios15.0',
        '-print-target-info'
      ]);
      await prepared.dispose();
      await prepared.dispose();
      await assert.rejects(access(wrapper), { code: 'ENOENT' });
      assert.equal(environment.PATH, process.env.PATH);
    } finally {
      await prepared?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'real Swift release archives pass the unchanged privacy audit only with native path maps',
  {
    skip: process.platform !== 'darwin',
    timeout: 240_000
  },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'garden-swift-archive-')));
    const project = join(directory, 'package with spaces');
    await mkdir(join(project, 'Sources'), { recursive: true });
    await writeFile(
      join(project, 'Package.swift'),
      '// swift-tools-version:5.3\nimport PackageDescription\nlet package = Package(name: "PathProbe", products: [.library(name: "PathProbe", type: .static, targets: ["PathProbe"])], targets: [.target(name: "PathProbe", path: "Sources")])\n'
    );
    await writeFile(
      join(project, 'Sources', 'Probe.swift'),
      'public func resultValue() -> String { return "garden release probe" }\n'
    );
    const environment = withReleaseRustFlags({ ...process.env, GITHUB_WORKSPACE: project });
    const prepared = await withReleaseSwiftTools(environment);
    const build = async (name, env) => {
      const scratch = join(directory, name);
      execFileSync(
        'swift',
        ['build', '-c', 'release', '--package-path', project, '--scratch-path', scratch],
        { env, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' }
      );
      const names = (await readdir(scratch, { recursive: true })).filter((path) =>
        path.endsWith('/libPathProbe.a')
      );
      const archives = [
        ...new Set(await Promise.all(names.map((name) => realpath(join(scratch, name)))))
      ];
      assert.equal(archives.length, 1);
      const audited = join(directory, `${name}-audit`, 'release');
      await mkdir(audited, { recursive: true });
      const artifact = join(audited, 'libathanor_desktop_lib.a');
      await copyFile(archives[0], artifact);
      return { root: join(directory, `${name}-audit`), bytes: await readFile(artifact) };
    };
    try {
      const before = await build('before', environment);
      assert.ok(
        before.bytes.includes(Buffer.from(project)),
        'The native fixture must reproduce an actual source path'
      );
      await assert.rejects(
        checkNativeBinaries(before.root, environment, 'ios'),
        /build-machine path/
      );
      const after = await build('after', prepared.environment);
      await assert.doesNotReject(
        checkNativeBinaries(after.root, environment, 'ios'),
        'Native maps must remove compiler source paths from the real archive'
      );
      assert.ok(
        after.bytes.includes(Buffer.from('/workspace')),
        'Mapped archive must retain stable source information'
      );
    } finally {
      await prepared.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
