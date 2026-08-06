import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './processes.js';

const roots: string[] = [];

/**
 * Long enough that a loaded machine cannot fail it, short enough to still fail.
 *
 * A session reaches a terminal status the moment its process ends and its pipes drain, so these
 * polls normally return in a few milliseconds. The ceiling exists only so a hang reports as one.
 */
const SETTLE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;

/**
 * A flush grace the drain test cannot reach: it outlives the test's own timeout, so the only way
 * to reach the assertion is the pipe actually closing, and the only way to fail is a hang, which
 * the timeout reports as one.
 *
 * This test used to run against the shipped 1s bound with a fixture that slept 200ms, which made
 * it a race between the machine's fork latency and a production constant rather than a statement
 * about the manager. It lost that race under a full parallel run, and reported it as an empty log
 * rather than as the timing accident it was.
 */
const UNREACHABLE_FLUSH_GRACE_MS = TEST_TIMEOUT_MS * 10;

const settledStatus = async (
  manager: ProcessManager,
  sessionId: string
): Promise<{ status: string; exitCode?: number | null; stdout?: string; stderr?: string }> => {
  await expect
    .poll(() => manager.action('workspace-1', 'task-1', sessionId, { action: 'poll' }).status, {
      interval: 10,
      timeout: SETTLE_TIMEOUT_MS
    })
    .not.toBe('running');
  return manager.action('workspace-1', 'task-1', sessionId, { action: 'poll' });
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('background process manager', () => {
  it(
    'keeps a long command observable without blocking the agent turn',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "setTimeout(() => process.stdout.write('finished'), 25)"],
          timeoutSeconds: 5
        },
        5,
        false
      );
      expect(started.status).toBe('running');
      expect(manager.list('workspace-1', 'another-task')).toEqual([]);
      expect(await settledStatus(manager, started.sessionId)).toMatchObject({
        status: 'completed',
        exitCode: 0,
        stdout: 'finished'
      });
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'reports completed only once the log is complete',
    async () => {
      // The direct child exits immediately and a grandchild writes to the inherited pipe afterwards.
      // A session that flipped to `completed` on the child's exit would hand the agent an empty log
      // and call it the whole output, which is the one thing a background job's result is read from.
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager(UNREACHABLE_FLUSH_GRACE_MS);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', '{ sleep 0.2; echo LATE; } & exit 0'],
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toContain('LATE');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'settles a session whose grandchild never releases the pipe',
    async () => {
      // The other half of the same rule. A grandchild that outlives its parent holds the inherited
      // pipes open, so the drain signal never arrives at all; without a bound on the wait, the
      // session would stay `running` for as long as that process lived and the agent would poll a
      // job that had already finished. Truncating the log is the price of that bound, and this is
      // where it is stated: the grandchild's write lands far outside a grace it cannot reach.
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager(50);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', '{ sleep 1; echo LATE; } & exit 0'],
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).not.toContain('LATE');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'settles a command that never starts instead of leaving it running',
    async () => {
      // No 'exit' is ever emitted for a spawn that failed, so a session waiting for one sat at
      // `running` until its own timeout killed a process that had never existed.
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: path.join(root, 'workspace', 'not-an-executable'), timeoutSeconds: 5 },
        5,
        false
      );
      expect(await settledStatus(manager, started.sessionId)).toMatchObject({ status: 'failed' });
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'runs a background command under the same resource limits as a foreground one',
    async () => {
      // A long-running background session is the easier way to exhaust the box, not the harder one:
      // nothing is waiting on it, so it has hours rather than minutes to do the damage.
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const limiter = path.join(root, 'limiter');
      await writeFile(
        limiter,
        '#!/bin/sh\nargs=""\nwhile [ "$1" != "--" ]; do args="$args $1"; shift; done\nshift\nprintf \'%s\' "$args"\nexec "$@"\n'
      );
      await chmod(limiter, 0o700);
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('|done')"],
          timeoutSeconds: 5
        },
        5,
        false,
        {
          limiter,
          limits: {
            memoryBytes: 1024 ** 3,
            fileBytes: 2 * 1024 ** 3,
            processes: 512,
            openFiles: 2048
          }
        }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toContain(`--data=${1024 ** 3}`);
      expect(finished.stdout).toContain('--nproc=512');
      expect(finished.stdout).toContain('|done');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'carries the coding CLI permission policy into the background process',
    async () => {
      // The deny-list and the auto-share opt-out only exist as environment variables, and the
      // coding agent is a background session rather than a foreground command - so an allow-list
      // that dropped them here left the owner believing a policy was in force that the process
      // never saw.
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const permission = JSON.stringify({ bash: { 'sudo *': 'deny' } });
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: [
            '-e',
            'process.stdout.write(`${process.env.OPENCODE_AUTO_SHARE}|${process.env.OPENCODE_PERMISSION}`)'
          ],
          env: { OPENCODE_AUTO_SHARE: 'false', OPENCODE_PERMISSION: permission },
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toBe(`false|${permission}`);
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it('refuses an environment variable it will not pass on rather than dropping it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    await expect(
      manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: process.execPath, args: ['-e', ''], env: { PATH: '/tmp', SECRET: 'x' } },
        5,
        false
      )
    ).rejects.toThrow('does not accept PATH, SECRET');
    manager.close();
  });

  it('does not allow background privilege or package operations in host-native mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    await expect(
      manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: 'apt-get', args: ['install', '-y', 'inkscape'] },
        30,
        false
      )
    ).rejects.toThrow('cannot run as background processes');
    manager.close();
  });
});
