import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRunnerProxyRoutes } from './runner-proxy.js';
import type { RouteContext } from '../http/server-context.js';

describe('owner browser tab retention', () => {
  async function fixture() {
    const app = Fastify();
    const runner = { request: vi.fn(async () => ({ tabs: [] })) };
    const store = {
      getWorkspace: vi.fn(async (user: string, id: string) =>
        user === 'owner' && id === 'owned' ? { id } : null
      )
    };
    app.decorateRequest('user', null);
    app.decorateRequest('apiToken', null);
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-test-user']
        ? ({ id: request.headers['x-test-user'] } as never)
        : null;
      request.apiToken = request.headers['x-test-token'] ? ({} as never) : null;
    });
    registerRunnerProxyRoutes({
      app,
      store,
      runner,
      idempotent: async (
        _request: unknown,
        _reply: unknown,
        _user: unknown,
        run: () => Promise<unknown>
      ) => run()
    } as unknown as RouteContext);
    return { app, runner, store };
  }
  it('binds a valid tab retention change to its owner and browser control scope', async () => {
    const { app, runner, store } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/owned/browser/tabs/tab-12/retention',
        headers: { 'x-test-user': 'owner' },
        payload: { pinned: true }
      });
      expect(response.statusCode).toBe(200);
      expect(store.getWorkspace).toHaveBeenCalledWith('owner', 'owned');
      expect(runner.request).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'owned',
        userId: 'owner',
        role: 'user',
        scopes: ['browser.control'],
        path: '/v1/workspaces/owned/browser/tabs/tab-12/retention',
        method: 'POST',
        body: '{"pinned":true}',
        contentType: 'application/json'
      });
    } finally {
      await app.close();
    }
  });
  it.each([
    { name: 'anonymous caller', user: '', token: '', tab: 'tab-1' },
    { name: 'another owner', user: 'other', token: '', tab: 'tab-1' },
    { name: 'automation token', user: 'owner', token: 'yes', tab: 'tab-1' },
    { name: 'arbitrary runner path', user: 'owner', token: '', tab: 'escape' }
  ])('rejects $name before minting a runner request', async ({ user, token, tab }) => {
    const { app, runner } = await fixture();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/owned/browser/tabs/${tab}/retention`,
        headers: { 'x-test-user': user, 'x-test-token': token },
        payload: { pinned: false }
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(runner.request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('binds checkpoint resume to the signed-in owner and the exact native job path', async () => {
    const { app, runner } = await fixture();
    const session = 'job_11111111-1111-4111-8111-111111111111';
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/owned/processes/${session}/resume`,
        headers: { 'x-test-user': 'owner' },
        payload: {}
      });
      expect(response.statusCode).toBe(200);
      expect(runner.request).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'owned',
        userId: 'owner',
        role: 'user',
        scopes: ['exec'],
        method: 'POST',
        path: `/v1/workspaces/owned/processes/${session}/resume`,
        contentType: 'application/json',
        body: '{}',
        timeoutMs: 15_000
      });
    } finally {
      await app.close();
    }
  });
  it.each([
    { user: '', token: '', session: 'job_11111111-1111-4111-8111-111111111111' },
    { user: 'other', token: '', session: 'job_11111111-1111-4111-8111-111111111111' },
    { user: 'owner', token: 'yes', session: 'job_11111111-1111-4111-8111-111111111111' },
    { user: 'owner', token: '', session: 'proc_11111111-1111-4111-8111-111111111111' }
  ])(
    'rejects an unauthorized or non-job resume before minting execution scope: $user $token $session',
    async ({ user, token, session }) => {
      const { app, runner } = await fixture();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/workspaces/owned/processes/${session}/resume`,
          headers: { 'x-test-user': user, 'x-test-token': token },
          payload: {}
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(runner.request).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
});
