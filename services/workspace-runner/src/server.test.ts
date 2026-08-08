import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { capabilityAudience, signCapabilityToken } from '@athanor/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

describe('a preview whose app is not running', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  /*
   * These bytes go through the preview gateway to a browser without being touched, so the owner
   * opened the link they had been given and read
   * `{"error":{"code":"preview_unavailable",...}}` as text on the page. Everything else this
   * service answers is read by the worker, which is why it was JSON; the gateway's own two failure
   * pages are HTML for exactly this reason and this one sits a layer below them.
   */
  it('answers the browser with a page rather than with JSON', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-preview-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-preview-test-secret-at-least-32-characters';
    const config = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      COMMAND_FILE_LIMIT_BYTES: 4 * 1024 ** 3,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    } as RunnerConfig;
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000a1';
    await ensureWorkspace(path.join(workspaceRoot, id));
    // A high port nothing binds, which is the case this covers.
    const token = signCapabilityToken(
      { sub: 'user', workspaceId: id, role: 'user', scopes: ['preview:45999'], nonce: 'preview-test' },
      secret
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/preview/45999/`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Nothing is listening');
    expect(response.body).not.toContain('"error"');
  });
});

describe('workspace export', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('streams workspace files and artifacts without browser profile data', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-export-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-export-test-secret-at-least-32-characters';
    const config: RunnerConfig = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      COMMAND_FILE_LIMIT_BYTES: 4 * 1024 ** 3,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000001';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    await writeFile(path.join(root, 'workspace', 'report.txt'), 'private report');
    await writeFile(path.join(root, '.athanor', 'artifacts', 'chart.svg'), '<svg/>');
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'must-not-export');
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['files.read'],
        nonce: 'export-test'
      },
      secret
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/export`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/gzip');
    expect(response.headers['content-disposition']).toContain(`athanor-workspace-${id}.tar.gz`);
    const archive = gunzipSync(response.rawPayload).toString('utf8');
    expect(archive).toContain('workspace/report.txt');
    expect(archive).toContain('private report');
    expect(archive).toContain('.athanor/artifacts/chart.svg');
    expect(archive).not.toContain('must-not-export');
    expect(archive).not.toContain('.athanor/browser');

    const missingToken = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['files.read'],
        nonce: 'missing-file-test'
      },
      secret
    );
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/file?path=workspace%2FATHANOR.md`,
      headers: { authorization: `Bearer ${missingToken}` }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'file_not_found' } });

    const replay = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/export`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('closes a terminal when the capability that opened it expires', async () => {
    // The browser and desktop streams have always done this. Without it here a sixty-second
    // token bought a shell on the box that ran until one side hung up, with nothing able to
    // revoke it in between.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-terminal-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-terminal-test-secret-at-least-32-characters';
    const config: RunnerConfig = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 0,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      COMMAND_FILE_LIMIT_BYTES: 4 * 1024 ** 3,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const id = '00000000-0000-4000-8000-000000000002';
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['terminal'],
        nonce: 'terminal-expiry-test'
      },
      secret,
      // Long enough that the handshake always wins the race against the clock. At one second a
      // loaded machine could finish signing after the token had already expired, and the server
      // then refused the upgrade instead of accepting it and closing on expiry - the same
      // behaviour arriving as an error rather than the close this asserts.
      3
    );
    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${id}/terminal`,
      ['athanor-capability', token]
    );
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      socket.once('error', reject);
    });
    expect(closed).toEqual({ code: 1008, reason: 'Capability expired' });
  }, 15_000);
});

describe('turn checkpoints over the runner API', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('creates, previews and restores one, and refuses a token without workspace.manage', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-checkpoint-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-checkpoint-test-secret-at-least-32-chars';
    const config: RunnerConfig = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      COMMAND_FILE_LIMIT_BYTES: 4 * 1024 ** 3,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: path.join(workspaceRoot, 'dpkg-status'),
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000003';
    const checkpointId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be9';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'the good version\n');
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=live');

    const manage = (nonce: string): string =>
      signCapabilityToken(
        { sub: 'worker', workspaceId: id, role: 'agent', scopes: ['workspace.manage'], nonce },
        secret
      );

    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints`,
      headers: { authorization: `Bearer ${manage('cp-create')}` },
      payload: { checkpointId, taskId: '00000000-0000-4000-8000-0000000000aa', turn: 0 }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: checkpointId, mechanism: 'content', pruned: [] });

    await writeFile(path.join(root, 'workspace', 'notes.md'), 'the bad version\n');
    await writeFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'session=signed-in-since');

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/preview`,
      headers: { authorization: `Bearer ${manage('cp-preview')}` }
    });
    expect(preview.json()).toMatchObject({
      modifiedCount: 1,
      addedCount: 0,
      deletedCount: 0,
      modified: [{ path: 'workspace/notes.md' }]
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'worker',
            workspaceId: id,
            role: 'agent',
            scopes: ['files.read'],
            nonce: 'cp-weak'
          },
          secret
        )}`
      }
    });
    expect(forbidden.statusCode).toBe(403);

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`,
      headers: { authorization: `Bearer ${manage('cp-restore')}` }
    });
    expect(restored.json()).toMatchObject({ restoredFileCount: 1, removedFileCount: 0 });
    await expect(readFile(path.join(root, 'workspace', 'notes.md'), 'utf8')).resolves.toBe(
      'the good version\n'
    );
    // The sign-in that happened after the checkpoint survives the rewind, which is the point.
    await expect(readFile(path.join(root, '.athanor', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=signed-in-since'
    );

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/checkpoints`,
      headers: { authorization: `Bearer ${manage('cp-list')}` }
    });
    expect(listed.json()).toMatchObject({ checkpoints: [{ id: checkpointId, turn: 0 }] });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}`,
      headers: { authorization: `Bearer ${manage('cp-delete')}` }
    });
    expect(removed.statusCode).toBe(204);
    const empty = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/checkpoints`,
      headers: { authorization: `Bearer ${manage('cp-list-2')}` }
    });
    expect(empty.json()).toEqual({ checkpoints: [] });
  });
});

describe('file organisation and toolchain routes', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 4300,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/athanor-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    MAX_EXECUTION_SECONDS: 30,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    COMMAND_FILE_LIMIT_BYTES: 4 * 1024 ** 3,
    COMMAND_PROCESS_LIMIT: 1024,
    COMMAND_OPEN_FILE_LIMIT: 4096,
    MAX_FILE_BYTES: 1024 * 1024,
    RESERVED_PREVIEW_PORTS: [],
    CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
    CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  });

  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'athanor-files-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-files-route-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000010';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    // A nonce is spent on first use, so every request in a test needs its own.
    let issued = 0;
    const token = (scopes: string[], audience?: { method: string; path: string }) =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes,
          ...(audience ? { aud: capabilityAudience(audience.method, audience.path) } : {}),
          nonce: `files-${(issued += 1)}`
        },
        secret
      );
    return { app, id, root, token };
  };

  it('creates a folder and renames a file without ever overwriting one', async () => {
    const { app, id, root, token } = await harness();
    const authorization = () => `Bearer ${token(['files.write'])}`;
    await writeFile(path.join(root, 'workspace', 'draft.md'), '# draft');

    const folder = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: { authorization: authorization() },
      payload: { path: 'workspace/applications' }
    });
    expect(folder.statusCode).toBe(200);
    expect(folder.json()).toEqual({ path: path.join('workspace', 'applications') });

    const renamed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: { authorization: authorization() },
      payload: { from: 'workspace/draft.md', to: 'workspace/applications/cover-letter.md' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      await readFile(path.join(root, 'workspace', 'applications', 'cover-letter.md'), 'utf8')
    ).toBe('# draft');

    await writeFile(path.join(root, 'workspace', 'keep.md'), 'keep me');
    const clash = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: { authorization: authorization() },
      payload: { from: 'workspace/keep.md', to: 'workspace/applications/cover-letter.md' }
    });
    // A conflict, not a generic failure: the file browser has to be able to say which it was.
    expect(clash.statusCode).toBe(409);
    expect(await readFile(path.join(root, 'workspace', 'keep.md'), 'utf8')).toBe('keep me');
  });

  it('keeps both routes inside the workspace and behind files.write', async () => {
    const { app, id, token } = await harness();
    const escape = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: { authorization: `Bearer ${token(['files.write'])}` },
      payload: { path: '../../escaped' }
    });
    expect(escape.statusCode).toBe(400);
    const profile = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: { authorization: `Bearer ${token(['files.write'])}` },
      payload: { from: '.athanor/browser/Cookies', to: 'workspace/cookies' }
    });
    expect(profile.statusCode).toBe(400);
    const readOnly = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: { authorization: `Bearer ${token(['files.read'])}` },
      payload: { path: 'workspace/nope' }
    });
    expect(readOnly.statusCode).toBe(403);
  });

  it('refuses a capability minted for one request when it is presented on another', async () => {
    // The claim the token carries had never been compared against the request serving it, so a
    // token seen on a file listing was still good against every other route its scopes reached.
    const { app, id, token } = await harness();
    const filesPath = `/v1/workspaces/${id}/files`;

    const onItsOwnRequest = await app.inject({
      method: 'GET',
      url: `${filesPath}?path=workspace`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: `${filesPath}?path=workspace` })}`
      }
    });
    expect(onItsOwnRequest.statusCode).toBe(200);

    const elsewhere = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/usage`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: filesPath })}`
      }
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toMatchObject({
      error: { message: 'Capability token was minted for a different request' }
    });

    // The arguments of a call are not its identity: one listing capability still answers for the
    // folder it was asked about, whichever query string the request happens to carry.
    const differentQuery = await app.inject({
      method: 'GET',
      url: `${filesPath}?path=workspace`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: `${filesPath}?path=.athanor/artifacts` })}`
      }
    });
    expect(differentQuery.statusCode).toBe(200);
  });

  it('answers what the computer can actually do with documents', async () => {
    const { app, id, token } = await harness();
    const report = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/toolchain`,
      headers: { authorization: `Bearer ${token(['exec'])}` }
    });
    expect(report.statusCode).toBe(200);
    const body: {
      capabilities: Array<{ id: string; ready: boolean; install?: string }>;
      summary: string;
    } = report.json();
    expect(body.capabilities.some((capability) => capability.id === 'office-authoring')).toBe(true);
    // Whatever the host has, every unmet capability has to say how it would be met.
    for (const capability of body.capabilities)
      expect(capability.ready || typeof capability.install === 'string').toBe(true);
    expect(body.summary.length).toBeGreaterThan(0);

    const probe = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/toolchain/probe`,
      headers: { authorization: `Bearer ${token(['exec'])}` },
      payload: { binaries: ['sh', 'athanor-definitely-absent'] }
    });
    expect(probe.json()).toEqual({
      present: ['sh'],
      missing: ['athanor-definitely-absent']
    });
  });
});
