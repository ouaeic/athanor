import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

/**
 * The two time ceilings, measured where they are actually applied.
 *
 * There were four numbers spelling one hour and only one of them enforced anything. The tool
 * catalogue said 3,600 and is advice to a model - nothing in the worker validates a tool call
 * against it. The runner's two request schemas said 86,400 and no caller could ever reach it.
 * `TOOL_REQUEST_TIMEOUT_MS` in the worker bounds a held-open HTTP request and not a command. What
 * actually stopped work was `MAX_EXECUTION_SECONDS`, clamped in with `Math.min` on both paths, and
 * a six-hour alignment therefore died at the one-hour mark with nothing in the result naming
 * either number.
 *
 * These two cases are the whole change, and they have to be routed rather than unit tests: the
 * distinction is which config value each ROUTE hands to which executor, and a bound proved on the
 * executor while its caller passed the other number is a defect this repository has shipped twice.
 * Same command, same seconds, same workspace, same token shape - refused in the foreground and
 * accepted in the background.
 */
const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig =>
  ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 4300,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    // Deliberately different from each other, which is the property under test. On the shipped
    // configuration they are an hour and a day.
    MAX_EXECUTION_SECONDS: 30,
    MAX_BACKGROUND_SECONDS: 120,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    IMAGE_CONVERT_EXECUTABLE: 'magick',
    COMMAND_PROCESS_LIMIT: 1024,
    COMMAND_OPEN_FILE_LIMIT: 4096,
    MAX_FILE_BYTES: 1024 * 1024,
    RESERVED_PREVIEW_PORTS: [],
    CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
    CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  }) as RunnerConfig;

describe('a long job is bounded by the path it runs on', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-longwork-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000c1';
    await ensureWorkspace(path.join(workspaceRoot, id));
    let issued = 0;
    // A nonce is spent on first use, so every request in a test needs its own.
    const token = (method: string, route: string): string =>
      signCapabilityToken(
        {
          sub: 'task-1',
          workspaceId: id,
          role: 'agent',
          scopes: ['exec'],
          aud: capabilityAudience(method, `/v1/workspaces/${id}${route}`),
          nonce: `longwork-${(issued += 1)}`
        },
        secret
      );
    return { app, id, token };
  };

  it('refuses in the foreground, naming the field that would carry it', async () => {
    const { app, id, token } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/exec`,
      headers: {
        authorization: `Bearer ${token('POST', '/exec')}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 60 }
    });

    expect(response.statusCode).toBe(400);
    const { message } = response.json<{ error: { message: string } }>().error;
    // Both numbers, because they are different facts: what was asked for, and what is allowed.
    expect(message).toContain('30s');
    expect(message).toContain('60s');
    expect(message).toContain('background: true');
  });

  /*
   * The same sixty seconds, accepted. Nothing holds a request open on this route - it returns a
   * session id in milliseconds - so the hour it used to share with the foreground was never about
   * a resource this process spends, and it was the number that made a six-hour alignment or a
   * variant-calling run impossible to ask for on the one path built to outlive a turn.
   */
  it('accepts the identical command in the background', async () => {
    const { app, id, token } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/start`,
      headers: {
        authorization: `Bearer ${token('POST', '/processes/start')}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 60'], timeoutSeconds: 60 }
    });

    expect(response.statusCode).toBe(200);
    const started = response.json<{ status: string; sessionId: string; ranForMs: number }>();
    expect(started.status).toBe('running');
    // The field that makes supervising this job possible at all: every other thing a poll returns
    // is fixed for the life of the session, so a silent job's polls were byte-identical and the
    // turn guard stopped the agent for repeating itself.
    expect(typeof started.ranForMs).toBe('number');

    const killed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/${started.sessionId}`,
      headers: {
        authorization: `Bearer ${token('POST', `/processes/${started.sessionId}`)}`,
        'content-type': 'application/json'
      },
      payload: { action: 'kill' }
    });
    expect(killed.statusCode).toBe(200);
  });
});

/**
 * The guard the removed per-file rlimit handed its job to, proved where the command actually runs.
 *
 * RLIMIT_FSIZE is gone because of how it failed - SIGXFSZ, an empty stderr and a truncated file
 * that `ls` reports as present, or exit 0 and a truncated file when the writer is not the last
 * stage of a pipeline - and the argument for removing rather than raising it is that the host-disk
 * floor already covers a runaway write, on both paths, and covers what an rlimit cannot see at all.
 * That makes this floor load-bearing in a way it was not before.
 *
 * It had no case through a route. `RunnerServerOptions.hostStorage` says it is injected so the
 * disk floor can be exercised without filling a filesystem, and it reached the pre-flight write
 * check and the checkpoints but not the floor that polls while a command runs - `buildServer` did
 * not put it in `guards`. So the floor was proved on `execute` and on `ProcessManager` with the
 * probe passed in by hand, and the callers those tests stand in for had no case at all. That is
 * the shape this repository has shipped twice, and it is the reason this test is routed.
 */
describe('the host-disk floor reaches a command started through the route', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('stops it, and says so on the command own stderr', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-longwork-floor-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-longwork-test-secret-at-least-32-characters';
    let reads = 0;
    const app = await buildServer(runnerConfig(workspaceRoot, secret), {
      // Healthy when the command starts, past the floor once it is running: the pre-flight cannot
      // catch this by construction, because the command is what fills the disk.
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: (reads += 1) > 1 ? 64 * 1024 ** 2 : 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000c2';
    await ensureWorkspace(path.join(workspaceRoot, id));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/exec`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'task-1',
            workspaceId: id,
            role: 'agent',
            scopes: ['exec'],
            aud: capabilityAudience('POST', `/v1/workspaces/${id}/exec`),
            nonce: 'longwork-floor-1'
          },
          secret
        )}`,
        'content-type': 'application/json'
      },
      // A spin rather than a write: what is under test is that the probe reaches the poll, and a
      // process wedged in uninterruptible write I/O measures the kernel's signal delivery instead.
      payload: { executable: '/bin/sh', args: ['-c', 'while true; do :; done'], timeoutSeconds: 25 }
    });

    const body = response.json<{ stderr: string; stoppedReason?: string; timedOut: boolean }>();
    expect(body.stoppedReason).toBe('host_disk_floor');
    expect(body.timedOut).toBe(false);
    expect(body.stderr).toContain('last of the host disk');
  }, 30_000);
});
