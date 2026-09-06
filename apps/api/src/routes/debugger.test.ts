import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerDebuggerRoutes } from './debugger.js';
import type { RouteContext } from '../http/server-context.js';
const session = 'debug-11111111-1111-4111-8111-111111111111';
async function fixture() {
  const app = Fastify(),
    runner = { request: vi.fn(async () => ({ sessions: [] })) },
    store = {
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
  registerDebuggerRoutes({
    app,
    runner,
    store,
    idempotent: async (
      _request: unknown,
      _reply: unknown,
      _user: unknown,
      run: () => Promise<unknown>
    ) => run()
  } as unknown as RouteContext);
  return { app, runner };
}
describe('owner debugger controls', () => {
  it('reads cached workspace sessions and forwards an exact owner stop', async () => {
    const { app, runner } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/workspaces/owned/debugger',
            headers: { 'x-test-user': 'owner' }
          })
        ).statusCode
      ).toBe(200);
      expect(runner.request).toHaveBeenLastCalledWith({
        workspaceId: 'owned',
        userId: 'owner',
        role: 'user',
        scopes: ['files.read'],
        path: '/v1/workspaces/owned/debugger',
        method: 'GET'
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/owned/debugger/${session}/control`,
            headers: { 'x-test-user': 'owner' },
            payload: { action: 'stop' }
          })
        ).statusCode
      ).toBe(200);
      expect(runner.request).toHaveBeenLastCalledWith({
        workspaceId: 'owned',
        userId: 'owner',
        role: 'user',
        scopes: ['exec'],
        path: '/v1/workspaces/owned/debugger',
        method: 'POST',
        body: JSON.stringify({ action: 'stop', sessionId: session }),
        contentType: 'application/json'
      });
    } finally {
      await app.close();
    }
  });
  it.each([
    { name: 'anonymous', user: '', token: '', id: session, body: { action: 'stop' } },
    { name: 'other owner', user: 'other', token: '', id: session, body: { action: 'stop' } },
    { name: 'API token', user: 'owner', token: 'token', id: session, body: { action: 'stop' } },
    { name: 'arbitrary path', user: 'owner', token: '', id: 'invalid', body: { action: 'stop' } },
    {
      name: 'execution payload',
      user: 'owner',
      token: '',
      id: session,
      body: { action: 'cell', code: '42' }
    },
    {
      name: 'hidden execution parameter',
      user: 'owner',
      token: '',
      id: session,
      body: { action: 'stop', code: '42' }
    }
  ])('rejects $name before minting execution authority', async ({ user, token, id, body }) => {
    const { app, runner } = await fixture();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/owned/debugger/${id}/control`,
            headers: { 'x-test-user': user, 'x-test-token': token },
            payload: body
          })
        ).statusCode
      ).toBeGreaterThanOrEqual(400);
      expect(runner.request).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
