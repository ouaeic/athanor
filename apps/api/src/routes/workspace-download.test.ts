import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../http/server-context.js';
import { registerWorkspaceFileRoutes } from './workspace-files.js';

describe('owner file download proxy', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('forwards byte ranges and streams bytes without invoking a buffering response reader', async () => {
    const app = Fastify();
    apps.push(app);
    const bytes = Buffer.from([0, 1, 255, 128]);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        }
      }),
      {
        status: 206,
        headers: {
          'content-length': '4',
          'content-range': 'bytes 80-83/84',
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-disposition': 'attachment; filename="result.bin"'
        }
      }
    );
    const buffered = vi
      .spyOn(response, 'arrayBuffer')
      .mockRejectedValue(new Error('Do not buffer downloads'));
    const raw = vi.fn<RouteContext['runner']['raw']>(async () => response);
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = { id: 'owner' } as typeof request.user;
    });
    registerWorkspaceFileRoutes({
      app,
      store: {
        getWorkspace: async (owner: string, id: string) =>
          owner === 'owner' && id === 'workspace' ? { id } : null
      },
      runner: { raw }
    } as unknown as RouteContext);
    const result = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/workspace/download?path=results%2Flarge.bin',
      headers: { range: 'bytes=80-', 'if-range': '"known"' }
    });
    expect(result.statusCode).toBe(206);
    expect(result.rawPayload).toEqual(bytes);
    expect(result.headers['content-range']).toBe('bytes 80-83/84');
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(buffered).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        scopes: ['files.read'],
        headers: { range: 'bytes=80-', 'if-range': '"known"' }
      })
    );
    expect(raw.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/workspaces/other/download?path=results%2Flarge.bin'
    });
    expect(denied.statusCode).not.toBe(200);
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
