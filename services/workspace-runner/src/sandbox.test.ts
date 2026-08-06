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

const sandbox = { elevate: '/usr/bin/sudo', helper: '/usr/local/lib/athanor/athanor-sandbox' };

describe('agent sandbox invocation', () => {
  it('hands the command, and its environment, to the privileged helper', () => {
    const invocation = sandboxedInvocation(
      { executable: '/usr/bin/python3', args: ['build.py', '--fast'] },
      { PATH: '/usr/bin', HOME: '/home/athanor/ws', LANG: 'C.UTF-8' },
      sandbox,
      false
    );
    expect(invocation.executable).toBe('/usr/bin/sudo');
    expect(invocation.args).toEqual([
      '-n',
      '/usr/local/lib/athanor/athanor-sandbox',
      'run',
      'network',
      'PATH=/usr/bin',
      'HOME=/home/athanor/ws',
      'LANG=C.UTF-8',
      '/usr/bin/python3',
      'build.py',
      '--fast'
    ]);
  });

  it('asks for a network namespace when the command was not granted the network', () => {
    const invocation = sandboxedInvocation(
      { executable: '/bin/sh', args: ['-c', 'curl example.invalid'] },
      {},
      sandbox,
      true
    );
    expect(invocation.args.slice(0, 4)).toEqual([
      '-n',
      '/usr/local/lib/athanor/athanor-sandbox',
      'run',
      'isolated'
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
      '/usr/local/lib/athanor/athanor-sandbox',
      'shell',
      'TERM=xterm-256color',
      '/bin/bash'
    ]);
  });

  it('refuses an executable that would be read as an environment assignment', () => {
    // `env -i` takes leading NAME=VALUE arguments as assignments, so a path with an equals sign
    // would be swallowed and the command silently replaced by the one after it.
    expect(() =>
      sandboxedInvocation({ executable: '/home/athanor/a=b/tool', args: [] }, {}, sandbox, false)
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
      helper
    });
  });
});
