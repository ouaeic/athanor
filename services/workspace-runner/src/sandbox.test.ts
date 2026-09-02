import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentSandbox, sandboxedInvocation, sandboxedShell } from './sandbox.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const helperPath = '/usr/local/lib/athanor/athanor-sandbox';
const sandbox = { elevate: '/usr/bin/sudo', helper: helperPath, confineFilesystem: false };
const confining = { ...sandbox, confineFilesystem: true };
const workspace = '/home/athanor/6f1c9f38-2a4d-4f2f-9a3e-5b7c1d0e8a24';

describe('agent sandbox invocation', () => {
  it('hands the command, and its environment, to the privileged helper', () => {
    const invocation = sandboxedInvocation(
      { executable: '/usr/bin/python3', args: ['build.py', '--fast'] },
      { PATH: '/usr/bin', HOME: '/home/athanor/ws', LANG: 'C.UTF-8' },
      sandbox,
      false,
      workspace
    );
    expect(invocation.executable).toBe('/usr/bin/sudo');
    expect(invocation.args).toEqual([
      '-n',
      helperPath,
      'run',
      'network',
      // A root was offered and this box cannot enforce one, so the helper is asked for nothing and
      // the root word is the placeholder rather than the workspace. The placeholder is there
      // because the grammar is positional: without it the first NAME=VALUE would land in its slot.
      'open',
      '-',
      'PATH=/usr/bin',
      'HOME=/home/athanor/ws',
      'LANG=C.UTF-8',
      '/usr/bin/python3',
      'build.py',
      '--fast'
    ]);
  });

  it('names the workspace the command may write in when the box can enforce it', () => {
    const invocation = sandboxedInvocation(
      { executable: '/usr/bin/python3', args: ['build.py'] },
      { HOME: `${workspace}/.home` },
      confining,
      false,
      workspace
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      '-n',
      helperPath,
      'run',
      'network',
      'confine',
      workspace
    ]);
  });

  it('leaves the workspace delete unconfined, because it is the thing that removes the tree', () => {
    // The one null in the runner. A ruleset admitting `workspace/` and nothing above it would let
    // this empty the tree and then refuse to remove it, which is a half-finished delete reported
    // as a failure with no cause the reader can see.
    const invocation = sandboxedInvocation(
      { executable: '/bin/rm', args: ['-rf', '--', workspace] },
      { PATH: '/usr/bin:/bin' },
      confining,
      false,
      null
    );
    expect(invocation.args.slice(0, 6)).toEqual(['-n', helperPath, 'run', 'network', 'open', '-']);
  });

  it('asks for a network namespace when the command was not granted the network', () => {
    const invocation = sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', 'curl example.invalid'] },
      {},
      confining,
      true,
      workspace
    );
    expect(invocation.args.slice(0, 6)).toEqual([
      '-n',
      helperPath,
      'run',
      'isolated',
      'confine',
      workspace
    ]);
  });

  it('asks for the terminal mode so the owner shell keeps a controlling terminal', () => {
    // The sudoers policy gives this mode a pseudo-terminal and the command mode none: a shell
    // without a controlling terminal loses job control, and a command with one has its standard
    // output and error merged into a single stream the model then cannot tell apart.
    const invocation = sandboxedShell(
      { executable: '/bin/bash', args: [] },
      { TERM: 'xterm-256color' },
      sandbox
    );
    expect(invocation.args).toEqual([
      '-n',
      helperPath,
      'shell',
      'TERM=xterm-256color',
      '/bin/bash'
    ]);
  });

  it('never confines the owner terminal, on a box that confines everything else', () => {
    // Not an omission. The owner is at their own computer, and a ruleset here would refuse them
    // their own files from their own terminal while the file browser hands over the same files.
    const invocation = sandboxedShell({ executable: '/bin/bash', args: [] }, {}, confining);
    expect(invocation.args).not.toContain('confine');
    expect(invocation.args).toEqual(['-n', helperPath, 'shell', '/bin/bash']);
  });

  it('refuses an executable that would be read as an environment assignment', () => {
    // `env -i` takes leading NAME=VALUE arguments as assignments, so a path with an equals sign
    // would be swallowed and the command silently replaced by the one after it.
    expect(() =>
      sandboxedInvocation(
        { executable: '/home/athanor/a=b/tool', args: [] },
        {},
        sandbox,
        false,
        workspace
      )
    ).toThrow('equals sign');
  });

  it('refuses to start rather than run agent commands as the runner when the helper is missing', () => {
    return expect(resolveAgentSandbox('/usr/local/lib/athanor/absent')).rejects.toThrow(
      'will not start'
    );
  });

  it('leaves the sandbox unconfigured where there is no second account to drop to', async () => {
    await expect(resolveAgentSandbox(undefined)).resolves.toBeUndefined();
  });

  it('accepts a helper the runner can execute', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-sandbox-'));
    temporaryRoots.push(root);
    const helper = path.join(root, 'athanor-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    await expect(resolveAgentSandbox(helper)).resolves.toEqual({
      elevate: '/usr/bin/sudo',
      helper,
      confineFilesystem: false
    });
  });

  it('carries the measured filesystem rung onto the sandbox every caller then reads', async () => {
    // `confineFilesystem` is optional on the interface, so the assertion that matters is not that
    // an object can lack it but that the one constructor production uses always sets it. Absence
    // means unconfined, and a resolver that forgot to pass this through would be unconfined
    // everywhere while runner.env said otherwise - a silence, not a failure.
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-sandbox-'));
    temporaryRoots.push(root);
    const helper = path.join(root, 'athanor-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    await expect(resolveAgentSandbox(helper, true)).resolves.toEqual({
      elevate: '/usr/bin/sudo',
      helper,
      confineFilesystem: true
    });
  });
});
