import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandLimitArguments,
  commandLimits,
  defaultMemoryLimitBytes,
  limitedInvocation,
  resolveCommandLimiter
} from './limits.js';

const limits = {
  memoryBytes: 2 * 1024 ** 3,
  fileBytes: 4 * 1024 ** 3,
  processes: 1024,
  openFiles: 4096
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('command resource limits', () => {
  it('caps committed memory, file size, processes and descriptors', () => {
    expect(commandLimitArguments(limits)).toEqual([
      '--core=0',
      `--data=${2 * 1024 ** 3}`,
      `--fsize=${4 * 1024 ** 3}`,
      '--nproc=1024',
      '--nofile=4096'
    ]);
  });

  it('never uses an address-space limit, which would kill every runtime that reserves', () => {
    expect(commandLimitArguments(limits).join(' ')).not.toContain('--as');
  });

  it('wraps the command so the limits are inherited by everything it execs', () => {
    expect(
      limitedInvocation(
        { executable: '/bin/sh', args: ['-c', 'echo hi'] },
        limits,
        '/usr/bin/prlimit'
      )
    ).toEqual({
      executable: '/usr/bin/prlimit',
      args: [...commandLimitArguments(limits), '--', '/bin/sh', '-c', 'echo hi']
    });
  });

  it('wraps outside the network namespace wrapper rather than inside it', () => {
    const isolated = limitedInvocation(
      { executable: '/usr/bin/unshare', args: ['--net', '--', 'curl', 'https://example.invalid'] },
      limits,
      '/usr/bin/prlimit'
    );
    expect(isolated.executable).toBe('/usr/bin/prlimit');
    expect(isolated.args.indexOf('/usr/bin/unshare')).toBeGreaterThan(
      isolated.args.indexOf('--nproc=1024')
    );
  });

  it('runs the command unchanged when the host has no limiter', () => {
    const plain = { executable: '/bin/sh', args: ['-c', 'echo hi'] };
    expect(limitedInvocation(plain, limits, undefined)).toEqual(plain);
    expect(limitedInvocation(plain, undefined, '/usr/bin/prlimit')).toEqual(plain);
  });

  it('derives a memory ceiling from the host rather than a fixed number', () => {
    expect(defaultMemoryLimitBytes(32 * 1024 ** 3)).toBe(16 * 1024 ** 3);
    // A small server still gets a usable floor instead of a limit no build could run under.
    expect(defaultMemoryLimitBytes(1024 ** 3)).toBe(1024 ** 3);
  });

  it('prefers an explicitly configured memory ceiling', () => {
    const configured = commandLimits(
      {
        COMMAND_MEMORY_LIMIT_BYTES: 512 * 1024 ** 2,
        COMMAND_FILE_LIMIT_BYTES: 1024 ** 3,
        COMMAND_PROCESS_LIMIT: 64,
        COMMAND_OPEN_FILE_LIMIT: 256
      },
      8 * 1024 ** 3
    );
    expect(configured.memoryBytes).toBe(512 * 1024 ** 2);
    expect(configured.processes).toBe(64);
  });

  it('reports a missing limiter instead of throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-limiter-'));
    temporaryRoots.push(root);
    expect(await resolveCommandLimiter(path.join(root, 'prlimit'))).toBeUndefined();

    const present = path.join(root, 'prlimit');
    await writeFile(present, '#!/bin/sh\nexit 0\n');
    await chmod(present, 0o755);
    expect(await resolveCommandLimiter(present)).toBe(present);
  });
});
