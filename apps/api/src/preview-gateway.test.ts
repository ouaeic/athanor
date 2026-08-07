import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@athanor/core';
import type { DataStore, WorkspacePreviewRecord, WorkspaceRecord } from '@athanor/data';
import type { ApiConfig } from './config.js';
import { buildPreviewGateway } from './preview-gateway.js';
import { RunnerClient } from './runner-client.js';

const accessToken = 'preview-access-token';
const slug = 'a'.repeat(32);
const previewHost = `${slug}.preview.localhost:4400`;
const now = new Date().toISOString();

const preview: WorkspacePreviewRecord = {
  id: 'preview-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  label: 'Agent app',
  port: 3000,
  slug,
  accessTokenHash: sha256(accessToken),
  visibility: 'private',
  // Still on the row: the columns stay for now so a rollback to the previous release can read its
  // own data. Nothing in the product writes or reads them any more.
  customDomain: null,
  domainStatus: null,
  domainVerificationHash: null,
  status: 'active',
  expiresAt: null,
  lastAccessedAt: null,
  createdAt: now,
  updatedAt: now
};

const workspace: WorkspaceRecord = {
  id: 'workspace-1',
  userId: 'user-1',
  name: 'Agent computer',
  status: 'running',
  storageBytes: 0,
  storageLimitBytes: 1_000_000,
  imageRevision: 'dev',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  createdAt: now,
  updatedAt: now
};

let servedPreview: WorkspacePreviewRecord = preview;
let servedWorkspace: WorkspaceRecord = workspace;
let statusWrites: Array<[string, string]> = [];

const store = {
  getWorkspacePreviewBySlug: async (candidate: string) =>
    candidate === slug ? servedPreview : null,
  getWorkspacePreviewByCustomDomain: async () => null,
  getWorkspace: async () => servedWorkspace,
  updateWorkspaceStatus: async (id: string, status: string) => {
    statusWrites.push([id, status]);
    servedWorkspace = { ...servedWorkspace, status };
  },
  touchWorkspacePreview: async () => undefined
} as unknown as DataStore;

const config = {
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  PUBLIC_APP_URL: 'http://localhost:5173',
  API_PORT: 4100,
  PREVIEW_GATEWAY_PORT: 4400,
  WORKSPACE_RUNNER_URL: 'http://127.0.0.1:4300',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  DATABASE_URL: 'postgres://athanor:unused@127.0.0.1:5432/athanor',
  RESERVED_PREVIEW_PORTS: '4201,4203'
} as unknown as ApiConfig;

const upstreamCookies = ['workspace_app_session=opaque; Path=/', '__Host-athanor_session=forged'];

const buildGateway = async (): Promise<{
  gateway: Awaited<ReturnType<typeof buildPreviewGateway>>;
  forwarded: () => Headers;
}> => {
  let forwarded = new Headers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      forwarded = new Headers(init?.headers);
      const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
      for (const value of upstreamCookies) headers.append('set-cookie', value);
      return new Response('<!doctype html><title>Agent app</title>', { status: 200, headers });
    })
  );
  const runner = new RunnerClient(
    'http://workspace-manager.test',
    'runner-secret-with-at-least-32-characters'
  );
  return { gateway: await buildPreviewGateway(store, config, runner), forwarded: () => forwarded };
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  servedPreview = preview;
  servedWorkspace = workspace;
  statusWrites = [];
  vi.unstubAllGlobals();
});

describe('preview gateway credential isolation', () => {
  it('never forwards athanor session, preview access or authorization credentials', async () => {
    const { gateway, forwarded } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: previewHost,
        authorization: 'Bearer caller-supplied-token',
        cookie: [
          '__Host-athanor_session=host-session-secret',
          'athanor_session=plain-session-secret',
          `athanor-preview-access=${accessToken}`,
          '__Host-athanor-preview-access=production-access-secret',
          'workspace_app_session=opaque'
        ].join('; ')
      }
    });

    expect(response.statusCode).toBe(200);
    const cookie = forwarded().get('cookie');
    expect(cookie).toBe('workspace_app_session=opaque');
    expect(cookie).not.toContain('session-secret');
    expect(cookie).not.toContain(accessToken);
    expect(forwarded().get('authorization')).not.toBe('Bearer caller-supplied-token');
    expect(forwarded().get('authorization')).toMatch(/^Bearer /);
  });

  it('drops the cookie header entirely when only athanor cookies are present', async () => {
    const { gateway, forwarded } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: previewHost,
        cookie: `athanor-preview-access=${accessToken}; __Host-athanor_session=host-session-secret`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(forwarded().has('cookie')).toBe(false);
  });

  it('refuses to relay a session cookie set by the workspace application', async () => {
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `athanor-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('workspace_app_session=opaque');
    expect(setCookie).not.toContain('__Host-athanor_session');
  });

  /**
   * The agent writes preview rows through the store rather than through the API, so this is the
   * only place a published port is checked on every request rather than only when it was created.
   */
  it('refuses to proxy a preview pointed at one of this server own services', async () => {
    for (const port of [4100, 4201, 4300, 4400, 5432]) {
      servedPreview = { ...preview, port };
      const { gateway } = await buildGateway();
      const response = await gateway.inject({
        method: 'GET',
        url: '/',
        headers: { host: previewHost, cookie: `athanor-preview-access=${accessToken}` }
      });
      await gateway.close();
      expect(response.statusCode, `port ${port}`).toBe(404);
      expect(response.body).toContain('Preview unavailable');
    }
  });
});

/**
 * A live link is a promise the owner made to whoever holds it, so a sleeping computer is woken
 * rather than reported. This used to depend on a stored hosting mode and read the wrong way round:
 * the mode sold as "always on" was the only one that answered 503 to a visitor whenever the owner
 * had put the box to sleep. There is one behaviour now, and this is it.
 */
describe('a preview opened while the computer is asleep', () => {
  it('wakes a hibernated computer and serves the page', async () => {
    servedWorkspace = { ...workspace, status: 'hibernated' };
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `athanor-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(statusWrites).toEqual([[workspace.id, 'running']]);
  });

  it('does not claim to wake a computer that is not merely hibernated', async () => {
    servedWorkspace = { ...workspace, status: 'provisioning' };
    const { gateway } = await buildGateway();
    disposers.push(() => gateway.close());

    const response = await gateway.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `athanor-preview-access=${accessToken}` }
    });

    expect(response.statusCode).toBe(503);
    expect(statusWrites).toEqual([]);
  });
});
