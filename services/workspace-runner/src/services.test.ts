import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './processes.js';
import {
  DEFAULT_SERVICE_POLICY,
  givenUp,
  hostBootedAt,
  newServiceRecord,
  nextFailureCount,
  reclaimOrphan,
  restartDelayMs,
  ServiceRegistry,
  serviceView,
  workspaceDirectories,
  type ServicePolicy
} from './services.js';

const roots: string[] = [];

const TEST_TIMEOUT_MS = 20_000;

/**
 * The shipped backoff gives up after five deaths spread over about a minute, which is not something
 * a test can wait for. This is the same rule at a scale the test owns: still five failures, still
 * doubling, but in tens of milliseconds.
 */
const FAST_POLICY: ServicePolicy = {
  baseDelayMs: 10,
  ceilingDelayMs: 40,
  healthyAfterMs: 2_000,
  maxRapidFailures: 3
};

/**
 * The same rule with the healthy threshold below the fixture's own lifetime, so every run counts as
 * having worked and the streak never reaches the give-up. That is the ordinary case - a server that
 * runs for a week and falls over is not a crash loop - and it is the only way to watch a service
 * come back more than twice without waiting out the shipped minute.
 */
const HEALTHY_POLICY: ServicePolicy = { ...FAST_POLICY, healthyAfterMs: 20 };

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'athanor-service-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  await mkdir(path.join(root, '.athanor'), { recursive: true });
  return root;
};

const registryFile = (root: string): string => path.join(root, '.athanor', 'services.json');

const readRecords = async (root: string): Promise<Record<string, unknown>[]> => {
  const contents = await readFile(registryFile(root), 'utf8');
  return JSON.parse(contents) as Record<string, unknown>[];
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('service restart policy', () => {
  it('doubles the wait from the first death and stops doubling at the ceiling', () => {
    expect(restartDelayMs(1)).toBe(1_000);
    expect(restartDelayMs(2)).toBe(2_000);
    expect(restartDelayMs(3)).toBe(4_000);
    expect(restartDelayMs(5)).toBe(16_000);
    expect(restartDelayMs(9)).toBe(DEFAULT_SERVICE_POLICY.ceilingDelayMs);
    // Guards the shift: a very large streak must not overflow into a negative or infinite wait.
    expect(restartDelayMs(400)).toBe(DEFAULT_SERVICE_POLICY.ceilingDelayMs);
  });

  it('gives up only on consecutive deaths, and a run that worked clears the streak', () => {
    expect(givenUp(4)).toBe(false);
    expect(givenUp(5)).toBe(true);
    // Died after a fortnight of uptime: this is the first failure of a new streak, not the fifth.
    expect(nextFailureCount(14 * 24 * 3_600_000, 4)).toBe(1);
    // Died in a second: the streak continues, which is what a crash loop looks like.
    expect(nextFailureCount(1_000, 4)).toBe(5);
  });
});

describe('service registry', () => {
  it('survives a restart and refuses to hand back a file it cannot understand', async () => {
    const root = await workspace();
    const record = newServiceRecord({
      workspaceId: 'workspace-1',
      owner: 'task-1',
      name: 'invoice dashboard',
      launch: {
        executable: '/bin/sh',
        args: ['-c', 'sleep 1'],
        cwd: 'workspace',
        env: {},
        network: false,
        maxOutputBytes: 4_096
      }
    });
    await new ServiceRegistry(root).put(record);
    // A different process, reading the same box back: this is the whole point of the file.
    expect(await new ServiceRegistry(root).load()).toEqual([record]);

    // A truncated write or a hand-edit costs the owner their services, never their computer.
    await writeFile(registryFile(root), '[{"id":');
    expect(await new ServiceRegistry(root).load()).toEqual([]);
    await writeFile(registryFile(root), '[{"id":"svc_x"}]');
    expect(await new ServiceRegistry(root).load()).toEqual([]);
  });

  it('lists only real workspaces beside the snapshot and checkpoint directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-service-root-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace-1'));
    await mkdir(path.join(root, '.athanor-snapshots'));
    await mkdir(path.join(root, '.athanor-checkpoints'));
    await writeFile(path.join(root, 'stray-file'), '');
    expect(await workspaceDirectories(root)).toEqual(['workspace-1']);
    expect(await workspaceDirectories(path.join(root, 'not-here'))).toEqual([]);
  });
});

describe('reclaiming what a crashed runner left behind', () => {
  const record = newServiceRecord({
    workspaceId: 'workspace-1',
    owner: 'task-1',
    name: 'site',
    launch: {
      executable: '/usr/bin/python3',
      args: ['-m', 'http.server'],
      cwd: 'workspace',
      env: {},
      network: false,
      maxOutputBytes: 4_096
    }
  });

  /** The host came up long before this service did, which is what a runner crash looks like. */
  const bootedLongAgo = () => Date.parse(record.startedAt) - 3_600_000;

  it('stops the orphan a crashed runner left holding the port', async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const outcome = await reclaimOrphan(
      { ...record, pid: 4242 },
      {
        alive: () => alive,
        bootedAt: bootedLongAgo,
        kill: (_pid, signal) => {
          signals.push(signal);
          alive = false;
        },
        settleMs: 500
      }
    );
    expect(outcome).toBe('killed');
    // SIGTERM only: it went away when asked, so nothing was killed outright.
    expect(signals).toEqual(['SIGTERM']);
  });

  /*
   * After a host reboot every recorded pid has been handed out again from one, and some of them now
   * belong to the box's own system services. Signalling one of those process groups on the strength
   * of a stale number is the worst thing this file could do, so a run that began before this boot is
   * left strictly alone however alive its old number looks.
   *
   * The command line is deliberately no longer consulted, and this is the case that used to justify
   * it: it cannot do this job, because `sh -c` and every wrapper in the chain exec in place and
   * answer `ps` with something the record never wrote down.
   */
  it('leaves a stranger holding a pid from before the last boot completely alone', async () => {
    const signals: NodeJS.Signals[] = [];
    const outcome = await reclaimOrphan(
      { ...record, pid: 4242 },
      {
        alive: () => true,
        bootedAt: () => Date.parse(record.startedAt) + 1_000,
        kill: (_pid, signal) => signals.push(signal)
      }
    );
    expect(outcome).toBe('foreign');
    expect(signals).toEqual([]);
  });

  it('has nothing to do when the last runner stopped its own services', async () => {
    expect(await reclaimOrphan({ ...record, pid: 4242 }, { alive: () => false })).toBe('gone');
    expect(await reclaimOrphan(record, {})).toBe('gone');
  });
});

describe('a service the computer keeps running', () => {
  it(
    'restarts a service that dies, counts it, and survives a runner restart',
    async () => {
      const root = await workspace();
      // Writes a line every time it starts, so the file is the count of runs across restarts of
      // both the process and the manager - which is the property the record has to agree with.
      const marks = path.join(root, 'workspace', 'starts');
      const manager = new ProcessManager(50, HEALTHY_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', `echo start >> ${marks}; sleep 0.05`],
          service: 'mark writer',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      expect(started.sessionId).toMatch(/^svc_/);
      expect(started.service).toMatchObject({
        name: 'mark writer',
        command: ['/bin/sh', '-c', expect.any(String)]
      });

      // It keeps coming back on its own.
      await expect
        .poll(() => manager.list('workspace-1', 'task-1')[0]?.service?.restarts ?? 0, {
          interval: 20,
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(2);
      const live = manager.list('workspace-1', 'task-1')[0];
      expect(live?.service?.lastExit).toMatchObject({ exitCode: 0 });
      expect(live?.service?.startedAt).not.toEqual(live?.service?.createdAt);

      // The record is on disk, not in a Map, so the next runner can read it.
      const [persisted] = await readRecords(root);
      expect(persisted).toMatchObject({ name: 'mark writer', workspaceId: 'workspace-1' });

      // A runner restart: this manager stops everything, and a fresh one resumes from the file.
      manager.close();
      const resumedManager = new ProcessManager(50, HEALTHY_POLICY);
      const resumed = await resumedManager.resumeWorkspace(root, 'workspace-1', false);
      expect(resumed).toBe(1);
      expect(resumedManager.listWorkspace('workspace-1')[0]?.service).toMatchObject({
        name: 'mark writer'
      });
      await expect
        .poll(() => readFile(marks, 'utf8').then((text) => text.trim().split('\n').length), {
          interval: 20,
          timeout: 10_000
        })
        .toBeGreaterThanOrEqual(4);
      resumedManager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops restarting something that dies instantly and repeatedly',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'echo broken >&2; exit 3'],
          service: 'broken service',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      await expect
        .poll(() => manager.list('workspace-1', 'task-1')[0]?.service?.state, {
          interval: 20,
          timeout: 10_000
        })
        .toBe('crash_looped');
      const view = manager.list('workspace-1', 'task-1')[0];
      // It gave up, and it says how it ended rather than disappearing.
      expect(view?.service).toMatchObject({ name: 'broken service', state: 'crash_looped' });
      expect(view?.service?.lastExit).toMatchObject({ exitCode: 3 });
      expect(view?.service?.restarts).toBe(FAST_POLICY.maxRapidFailures - 1);
      // Still readable: the log is how the owner finds out why.
      expect(
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'log' }).stderr
      ).toContain('broken');
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stops a service for good when it is killed, and does not bring it back',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      expect(started.service).toMatchObject({
        name: 'long sleeper',
        state: 'running',
        restarts: 0
      });
      // The owner's own capability is not subject to the task that started it, and must still work.
      const killed = manager.action('workspace-1', null, started.sessionId, { action: 'kill' });
      expect(killed.status).toBe('stopped');
      await expect.poll(() => readRecords(root), { interval: 20, timeout: 5_000 }).toEqual([]);
      const resumedManager = new ProcessManager(50, FAST_POLICY);
      expect(await resumedManager.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
      manager.close();
      resumedManager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'never writes down a command that could not start even once',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await expect(
        manager.start(
          root,
          'workspace-1',
          'task-1',
          { executable: 'apt-get', args: ['install', '-y', 'nginx'], service: 'web server' },
          5,
          false
        )
      ).rejects.toThrow('cannot run as background processes');
      await expect(readRecords(root)).rejects.toThrow();
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'recognises a real orphan of its own against the real machine',
    async () => {
      /*
       * The one assertion here that a fixture cannot make: a record this manager actually wrote,
       * a process actually running, and the live probes - `processAlive` and this host's own boot
       * time - deciding between them.
       *
       * It is here because the first version of this was written against a fixture and was wrong
       * on every real box. Identity was "the recorded executable appears in what `ps` prints",
       * and a service declared exactly like this one - `/bin/sh -c ...`, which is most of them -
       * execs the inner command and answers `ps` with `sleep 30` within milliseconds. Its own
       * runner read it as a stranger, left it holding the port, and started a second copy beside
       * it.
       */
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'identifiable',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      const [record] = await new ServiceRegistry(root).load();
      expect(record?.pid).toBeGreaterThan(0);
      expect(Date.parse(record!.startedAt)).toBeGreaterThan(hostBootedAt());

      // The signals are collected rather than sent, so this asserts recognition without racing the
      // manager's own restart of what it would otherwise have just killed.
      const signals: NodeJS.Signals[] = [];
      const outcome = await reclaimOrphan(record!, {
        kill: (_pid, signal) => {
          signals.push(signal);
        },
        settleMs: 20
      });
      expect(outcome).toBe('killed');
      // Still alive after the SIGTERM, because nothing was really signalled - so the escalation the
      // record promises is the one that runs.
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'leaves nothing running and nothing forgotten when the runner shuts down',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      const started = await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      const pid = (await readRecords(root))[0]?.pid as number;
      expect(pid).toBeGreaterThan(0);
      manager.close();
      // The record stays - that is what brings it back - but the process does not.
      expect(await readRecords(root)).toHaveLength(1);
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { interval: 20, timeout: 10_000 }
        )
        .toBe(false);
      expect(() =>
        manager.action('workspace-1', 'task-1', started.sessionId, { action: 'poll' })
      ).toThrow('not found');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'forgets a workspace being deleted rather than restarting into a tree that is gone',
    async () => {
      const root = await workspace();
      const manager = new ProcessManager(50, FAST_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      manager.stopWorkspace('workspace-1', { forget: true });
      await expect.poll(() => readRecords(root), { interval: 20, timeout: 5_000 }).toEqual([]);
      manager.close();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'finds every workspace on the box at boot without being told which ones have services',
    async () => {
      // What the runner actually does on startup: it is handed a workspace root and nothing else.
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-service-boot-'));
      roots.push(workspaceRoot);
      const root = path.join(workspaceRoot, 'workspace-1');
      await mkdir(path.join(root, 'workspace'), { recursive: true });
      await mkdir(path.join(workspaceRoot, '.athanor-snapshots'), { recursive: true });
      const manager = new ProcessManager(50, HEALTHY_POLICY);
      await manager.start(
        root,
        'workspace-1',
        'task-1',
        {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          service: 'long sleeper',
          maxOutputBytes: 4_096
        },
        5,
        false
      );
      manager.close();

      const booted = new ProcessManager(50, HEALTHY_POLICY);
      expect(await booted.resume(workspaceRoot, false)).toBe(1);
      expect(booted.listWorkspace('workspace-1')[0]?.service).toMatchObject({
        name: 'long sleeper',
        // A resume is a restart, and the record says so rather than pretending it never stopped.
        restarts: 1
      });
      booted.close();
    },
    TEST_TIMEOUT_MS
  );

  it('renders the owner-facing record from what is on disk', () => {
    const record = newServiceRecord({
      workspaceId: 'workspace-1',
      owner: 'task-1',
      name: 'invoice dashboard',
      launch: {
        executable: 'python3',
        args: ['-m', 'http.server', '8080'],
        cwd: 'workspace',
        env: {},
        network: false,
        maxOutputBytes: 4_096
      },
      at: '2026-08-11T09:00:00.000Z'
    });
    expect(serviceView({ ...record, restarts: 3 })).toEqual({
      serviceId: record.id,
      name: 'invoice dashboard',
      state: 'running',
      command: ['python3', '-m', 'http.server', '8080'],
      createdAt: '2026-08-11T09:00:00.000Z',
      startedAt: '2026-08-11T09:00:00.000Z',
      restarts: 3
    });
  });
});
