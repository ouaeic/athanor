import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
): Promise<{
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}> => {
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
            processes: 512,
            openFiles: 2048
          }
        }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      expect(finished.stdout).toContain(`--data=${1024 ** 3}`);
      expect(finished.stdout).not.toContain('--fsize');
      expect(finished.stdout).toContain('--nproc=512');
      expect(finished.stdout).toContain('|done');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'runs a background command through the agent sandbox, as a foreground one is',
    async () => {
      /*
       * The one guard on this path that had no test of its own.
       *
       * The limiter above was covered and the sandbox was not, and the sandbox is the guard that
       * decides which Unix account a command runs as - so a background session and a service, the
       * two things on this box that outlive the turn that asked for them, could have been running
       * as the runner's own account with nothing saying so. Written here because both routes now
       * compute their invocation in one place: a unification that quietly dropped the sandbox from
       * this side would otherwise have passed every test in the package.
       */
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      // Stands in for sudo: records what it was asked to run, then runs it.
      const record = path.join(root, 'elevated');
      const elevate = path.join(root, 'elevate');
      await writeFile(elevate, `#!/bin/sh\nprintf '%s\\n' "$*" >"${record}"\nshift\nexec "$@"\n`);
      await chmod(elevate, 0o700);
      // Stands in for athanor-sandbox: drops its own two leading arguments the way the real helper
      // consumes `run <network mode>`, then applies the environment and execs, as `env -i` does.
      const helper = path.join(root, 'sandbox');
      await writeFile(helper, '#!/bin/sh\nshift 2\nexec /usr/bin/env -i "$@"\n');
      await chmod(helper, 0o700);
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'], timeoutSeconds: 5 },
        5,
        true,
        { sandbox: { elevate, helper } }
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.status).toBe('completed');
      // The environment reached the process, which is only true if the helper was handed it as
      // arguments - the spawn itself passes an empty one, because sudo resets it anyway.
      expect(finished.stdout).toBe(root);
      const elevated = await readFile(record, 'utf8');
      expect(elevated).toContain(`-n ${helper} run isolated`);
      expect(elevated).toContain(`HOME=${root}`);
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

  /*
   * The list the owner's panel reads, as opposed to the list a turn reads.
   *
   * Every background session is started by an agent, whose capability subject is the task it is
   * running - never the person. So the owner-scoped list, asked on the owner's behalf, matched
   * nothing at all: a computer with two servers on it reported an empty table, which is why the
   * panel could never say what the machine was doing. The workspace filter still holds.
   */
  it('shows the whole workspace to the person who owns it, whichever task started it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const args = ['-e', 'setTimeout(() => undefined, 400)'];
    const first = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    const second = await manager.start(
      root,
      'workspace-1',
      'task-2',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    const elsewhere = await manager.start(
      root,
      'workspace-2',
      'task-3',
      { executable: process.execPath, args, timeoutSeconds: 5 },
      5,
      false
    );
    expect(manager.list('workspace-1', 'task-1').map((view) => view.sessionId)).toEqual([
      first.sessionId
    ]);
    expect(manager.listWorkspace('workspace-1').map((view) => view.sessionId)).toEqual([
      first.sessionId,
      second.sessionId
    ]);
    expect(manager.listWorkspace('workspace-2').map((view) => view.sessionId)).toEqual([
      elsewhere.sessionId
    ]);
    // What the row is drawn from: the command as started, when it started, and how it is going.
    expect(manager.listWorkspace('workspace-1')[0]).toMatchObject({
      status: 'running',
      command: [process.execPath, ...args]
    });
    expect(manager.listWorkspace('workspace-1')[0]?.startedAt).toEqual(expect.any(String));
    manager.close();
  });

  /*
   * What the Stop button reaches.
   *
   * Cancelling a task aborted whatever runner request was in flight, which is the whole of the
   * foreground story and none of the background one: `processes/start` returns in milliseconds, so
   * by the time the owner presses Stop there is no request left to abort and the scraper the model
   * started runs on for the rest of its hour, writing into the workspace and making outbound
   * requests attributed to this box. A service is the deliberate exception - it was declared to
   * outlive the turn - and the two must be told apart here, because a confirmation that says
   * "stopped" about a service nobody stopped is the failure this route was added to end.
   */
  it(
    "a cancelled task's background sessions are stopped and its declared services are not",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      await mkdir(path.join(root, '.athanor'), { recursive: true });
      const manager = new ProcessManager();
      const sleeping = { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 };
      const scraper = await manager.start(root, 'workspace-1', 'task-1', sleeping, 30, false);
      const dashboard = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { ...sleeping, service: 'invoice dashboard' },
        30,
        false
      );
      const otherTask = await manager.start(root, 'workspace-1', 'task-2', sleeping, 30, false);

      const outcome = manager.stopOwner('workspace-1', 'task-1', {});
      expect(outcome.stopped).toEqual([scraper.sessionId]);
      expect(outcome.services).toEqual(['invoice dashboard']);
      // The sentence the cancel confirmation carries: naming the service is the whole point, since
      // the owner is being told the task ended while something it declared is still serving.
      expect(outcome.note).toContain('invoice dashboard');

      expect(await settledStatus(manager, scraper.sessionId)).toMatchObject({ status: 'stopped' });
      // Declared to outlive the turn, so it does.
      expect(
        manager.action('workspace-1', 'task-1', dashboard.sessionId, { action: 'poll' })
      ).toMatchObject({ status: 'running', service: { name: 'invoice dashboard' } });
      // Another turn's session is not this cancellation's business.
      expect(
        manager.action('workspace-1', 'task-2', otherTask.sessionId, { action: 'poll' }).status
      ).toBe('running');

      // Nothing to stop is not an error: cancel runs on every task, and most have no background
      // work at all.
      expect(manager.stopOwner('workspace-1', 'task-3', {})).toMatchObject({
        stopped: [],
        services: []
      });
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * A capability subject cannot name somebody else's.
   *
   * `list` and `action` narrow an agent to the sessions its own task started, and this route would
   * be the way round that if the owner in the body were believed: one turn could stop another
   * turn's work by asking. The person driving the box passes `null` and names the task, which is
   * the same split those two make.
   */
  it('refuses to let one task stop the background work of another', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const sleeping = { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 };
    const victim = await manager.start(root, 'workspace-1', 'task-2', sleeping, 30, false);
    expect(() => manager.stopOwner('workspace-1', 'task-1', { owner: 'task-2' })).toThrow(
      'only stop the background processes it started'
    );
    expect(
      manager.action('workspace-1', 'task-2', victim.sessionId, { action: 'poll' }).status
    ).toBe('running');
    // The owner of the computer is not subject to a task, and says which one they mean.
    expect(manager.stopOwner('workspace-1', null, { owner: 'task-2' }).stopped).toEqual([
      victim.sessionId
    ]);
    expect(() => manager.stopOwner('workspace-1', null, {})).toThrow('which task');
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

  it('refuses a background command that names a privileged helper directly', async () => {
    /*
     * The background counterpart of execution.test.ts's "refuses a command that names a privileged
     * helper directly", which had no counterpart here for as long as the helper has existed.
     *
     * The refusal is one check reading one list, and the list is built from the two root-owned
     * helpers this computer has: the system-package helper and the sandbox's elevator. Only the
     * foreground path ever knew where the package helper was, so on this path the list held the
     * sandbox helper alone - and with AGENT_SANDBOX_HELPER unset, which config.ts documents as the
     * supported shape of a host with no second account to drop to, it held nothing at all and the
     * check had nothing to match against. The package helper reaches root through NOPASSWD sudo,
     * so a background start naming it got there with no capability scope and no approval, which is
     * precisely what the foreground refusal exists to prevent.
     *
     * Both spellings, because a wrapper hides the executable in its arguments; and the service
     * spelling too, because a service is the one background job that never stops on its own.
     */
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nexit 0\n');
    await chmod(packageHelper, 0o755);
    const manager = new ProcessManager();
    const attempts = [
      { executable: packageHelper, args: ['install', 'openssh-server'] },
      { executable: 'sh', args: ['-c', `${packageHelper} install openssh-server`] },
      { executable: packageHelper, args: ['install', 'openssh-server'], service: 'installer' }
    ];
    for (const attempt of attempts)
      await expect(
        // No sandbox: the laptop-shaped configuration, and the one this was reachable on.
        manager.start(root, 'workspace-1', 'task-1', attempt, 30, false, {
          systemPackageHelper: packageHelper
        })
      ).rejects.toThrow('cannot run as background processes');
    manager.close();
  });
});

/*
 * The one execution path that had no disk guard was the one defined as running unattended.
 *
 * `execute()` has polled free space while a foreground command ran ever since a `dd` took the box
 * down; the background path got the pre-flight check and nothing else, and the pre-flight check
 * only proves the disk was healthy at the moment the command started. A background `dd`, a service
 * that logs to a file, an `npm ci` in a service wrapper: each runs for up to an hour - and a
 * service has no deadline at all - with nothing watching. The last free byte stops PostgreSQL,
 * which stops the interface and every other task on the computer.
 */
describe('the host disk floor on the background path', () => {
  const failingDisk = (healthyPolls: number) => {
    let reads = 0;
    return async () => ({
      hostStorageTotalBytes: 100 * 1024 ** 3,
      hostStorageAvailableBytes: ++reads > healthyPolls ? 64 * 1024 ** 2 : 50 * 1024 ** 3
    });
  };

  it(
    'stops a background session that is consuming the last of the host disk',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false,
        { hostStoragePollMs: 25, hostStorage: failingDisk(2) }
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('stopped');
      // Said on the session's own stderr, because `poll` is the only place the agent ever finds
      // out why a background job it started is no longer running.
      expect(settled.stderr).toContain('last of the host disk');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  /*
   * The same fifth stop as on the foreground path, and it matters more here: a background session
   * is the one that runs long enough and large enough to be the thing the cgroup picks. Guarded on
   * the status rather than on a flag, because the timeout, the disk floor and the owner's stop all
   * move it away from 'running' before they kill, and all three of them kill with SIGKILL.
   */
  it('says so when a background session is killed outright', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const started = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: '/bin/sh', args: ['-c', 'kill -9 $$'], timeoutSeconds: 30 },
      30,
      false,
      {}
    );
    const settled = await settledStatus(manager, started.sessionId);
    expect(settled.status).toBe('failed');
    expect(settled.signal).toBe('SIGKILL');
    expect(settled.stderr).toContain('killed outright by the computer');
    manager.close();
  });

  it('leaves a background session on a healthy disk alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    const manager = new ProcessManager();
    const started = await manager.start(
      root,
      'workspace-1',
      'task-1',
      { executable: process.execPath, args: ['-e', "process.stdout.write('fine')"] },
      30,
      false,
      {
        hostStoragePollMs: 25,
        hostStorage: async () => ({
          hostStorageTotalBytes: 100 * 1024 ** 3,
          hostStorageAvailableBytes: 60 * 1024 ** 3
        })
      }
    );
    expect(await settledStatus(manager, started.sessionId)).toMatchObject({
      status: 'completed',
      stdout: 'fine'
    });
    manager.close();
  });

  it(
    'does not put a service straight back into the disk it just filled',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'athanor-process-'));
      roots.push(root);
      await mkdir(path.join(root, 'workspace'));
      await mkdir(path.join(root, '.athanor'), { recursive: true });
      const manager = new ProcessManager(undefined, {
        baseDelayMs: 10,
        ceilingDelayMs: 40,
        healthyAfterMs: 2_000,
        maxRapidFailures: 3
      });
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: 'log writer' },
        30,
        false,
        { hostStoragePollMs: 25, hostStorage: failingDisk(2) }
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('stopped');
      const view = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      expect(view.service).toMatchObject({
        name: 'log writer',
        state: 'crash_looped',
        restarts: 0
      });
      // The backoff is the thing under test: it must not count, and the record must not gain a
      // restart while the disk is still full.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' }).service
      ).toMatchObject({ state: 'crash_looped', restarts: 0 });
      manager.close();
    },
    TEST_TIMEOUT_MS
  );
});

/**
 * What an agent can find out about a job it started, which is the difference between supervising
 * six hours of work and starting it again.
 */
describe('watching a long background job', () => {
  const managerRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-longwork-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'));
    return root;
  };

  it(
    'says which bound stopped it, in its own log',
    async () => {
      // `status: "timed_out"` beside an empty stderr was the whole report. This is the sentence the
      // disk floor and the owner's stop have always written, for the stop that had none.
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 1 },
        1,
        false
      );
      const settled = await settledStatus(manager, started.sessionId);
      expect(settled.status).toBe('timed_out');
      expect(settled.stderr).toContain('1s timeout');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'refuses a deadline this path could never honour rather than killing it part-way',
    async () => {
      const root = await managerRoot();
      const manager = new ProcessManager();
      await expect(
        manager.start(
          root,
          'workspace-1',
          'task-1',
          { executable: process.execPath, args: ['-e', ''], timeoutSeconds: 200 },
          30,
          false
        )
      ).rejects.toThrow(/200s/);
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'answers a poll with something that has moved since the last one',
    async () => {
      /*
       * Every other field a poll returns is fixed for the life of the session, so polling a job
       * that is quietly working - an alignment, a build, anything writing to a file rather than to
       * a terminal - used to return a byte-identical answer every time. The turn guard reads
       * repeated identical results as a model going in circles: measured against the production
       * expression, pushback at the fourth poll and the turn stopped at the eighth. The agent was
       * stopped for supervising a long job correctly, which is the one thing this primitive is for.
       */
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
        30,
        false
      );
      const first = manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' });
      await expect
        .poll(
          () =>
            manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' }).ranForMs,
          { interval: 10, timeout: 5_000 }
        )
        .toBeGreaterThan(first.ranForMs);
      manager.action('workspace-1', 'task-1', started.sessionId, { action: 'kill' });
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'keeps the beginning of a long log as well as its end, and says what it dropped',
    async () => {
      /*
       * This path kept the last N bytes and said nothing. The beginning of a six-hour run's log is
       * where it states what it is about to do - the command line, the version banner, the first
       * warning - so a single poll of a chatty job silently returned a log whose head the runner
       * had already discarded, with no marker to say any of it was ever there. The foreground path
       * has kept head, tail and a byte count since it was written; this is the same collector.
       */
      const root = await managerRoot();
      const manager = new ProcessManager();
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: process.execPath,
          args: ['-e', "process.stdout.write('BEGIN' + 'x'.repeat(12000) + 'END')"],
          maxOutputBytes: 4096,
          timeoutSeconds: 5
        },
        5,
        false
      );
      const finished = await settledStatus(manager, started.sessionId);
      expect(finished.stdout?.startsWith('BEGIN')).toBe(true);
      expect(finished.stdout?.endsWith('END')).toBe(true);
      expect(finished.stdout).toContain('bytes omitted from stdout');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );
});
