import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { RouteContext } from '../http/server-context.js';
import { registerPreviewRoutes } from './previews.js';
import { verifyPreviewAccess } from '../preview-access.js';

describe('opening a private preview grants access without revoking another owner device', () => {
  const app = Fastify();
  const key = Buffer.alloc(32, 8);
  const preview = {
    id: 'preview',
    workspaceId: 'workspace',
    userId: 'owner',
    accessTokenHash: 'old-token-hash',
    status: 'active',
    expiresAt: null
  };
  const rotate = vi.fn();
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = {
      id: request.headers['x-owner'] === 'yes' ? 'owner' : 'outsider'
    } as typeof request.user;
  });
  registerPreviewRoutes({
    app,
    masterKey: key,
    store: {
      getWorkspacePreview: async (userId: string) => (userId === 'owner' ? preview : null),
      rotateWorkspacePreviewAccess: rotate
    },
    workspacePreviewResponse: (_preview: unknown, token: string) => ({
      url: `https://garden.test/preview/?access=${token}`
    }),
    idempotent: async (
      _request: unknown,
      _reply: unknown,
      _user: unknown,
      execute: () => unknown
    ) => execute()
  } as unknown as RouteContext);
  afterAll(async () => app.close());

  it('mints two grants only through authenticated POST and preserves the stored access epoch', async () => {
    const tokens: string[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/previews/preview/access',
        headers: { 'x-owner': 'yes' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const token = new URL(response.json<{ url: string }>().url).searchParams.get('access')!;
      expect(verifyPreviewAccess(token, preview, key)).toBe(true);
      tokens.push(token);
    }
    expect(new Set(tokens).size).toBe(2);
    expect(rotate).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/previews/preview/access',
          headers: { 'x-owner': 'yes' }
        })
      ).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/previews/preview/access' })).statusCode
    ).toBe(404);
  });
});
