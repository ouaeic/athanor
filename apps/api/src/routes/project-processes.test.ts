import Fastify from 'fastify';
import type { ProcessList } from '@athanor/contracts';
import { describe, expect, it, vi } from 'vitest';
import { registerProjectProcessRoutes } from './project-processes.js';
import type { RouteContext } from '../http/server-context.js';

async function fixture() {
  const app = Fastify();
  const members = [
    { taskId: 'root', workspaceId: 'one' },
    { taskId: 'branch', workspaceId: 'two' }
  ];
  const store = {
    projectExecutionMembers: vi.fn(async (user: string, task: string) =>
      user === 'owner' && ['root', 'branch'].includes(task) ? members : []
    )
  };
  const runner = {
    request: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      processes: [
        { sessionId: `job-${workspaceId}`, ownerTaskId: workspaceId === 'one' ? 'root' : 'branch' },
        { sessionId: 'unrelated', ownerTaskId: 'other-task' }
      ],
      refreshAfterMs: 120_000,
      resourcesAvailable: true
    }))
  };
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = request.headers['x-owner']
      ? ({ id: request.headers['x-owner'] } as never)
      : null;
  });
  registerProjectProcessRoutes({ app, store, runner } as unknown as RouteContext);
  return { app, store, runner };
}

describe('project process scope', () => {
  it('collects owned branches across execution roots and excludes unrelated tasks sharing a workspace', async () => {
    const { app, store, runner } = await fixture();
    try {
      const response = await app.inject({
        url: '/v1/tasks/branch/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBe(200);
      expect(store.projectExecutionMembers).toHaveBeenCalledWith('owner', 'branch');
      expect(response.json<ProcessList>().processes).toEqual(
        expect.arrayContaining([
          { sessionId: 'job-one', ownerTaskId: 'root', workspaceId: 'one' },
          { sessionId: 'job-two', ownerTaskId: 'branch', workspaceId: 'two' }
        ])
      );
      expect(response.json<ProcessList>().processes).toHaveLength(2);
      expect(runner.request).toHaveBeenCalledTimes(2);
      expect(runner.request).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          userId: 'owner',
          scopes: ['exec'],
          path: '/v1/workspaces/one/processes'
        })
      );
    } finally {
      await app.close();
    }
  });
  it.each([
    { user: '', task: 'root' },
    { user: 'other', task: 'root' },
    { user: 'owner', task: 'missing' }
  ])(
    'refuses an unowned or unknown project before contacting the runner (%s)',
    async ({ user, task }) => {
      const { app, runner } = await fixture();
      try {
        const response = await app.inject({
          url: `/v1/tasks/${task}/processes`,
          headers: { 'x-owner': user }
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(runner.request).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );
  it('retains reachable results and explicitly reports a partial list', async () => {
    const { app, runner } = await fixture();
    runner.request.mockRejectedValueOnce(new Error('offline'));
    try {
      const response = await app.inject({
        url: '/v1/tasks/root/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<ProcessList>().unavailableWorkspaces).toBe(1);
      expect(response.json<ProcessList>().note).toContain('incomplete');
      expect(response.json<ProcessList>().processes).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
  it('does not turn an unavailable runner into an empty successful list', async () => {
    const { app, runner } = await fixture();
    runner.request.mockRejectedValue(new Error('offline'));
    try {
      const response = await app.inject({
        url: '/v1/tasks/root/processes',
        headers: { 'x-owner': 'owner' }
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.json<ProcessList>()).not.toHaveProperty('processes');
    } finally {
      await app.close();
    }
  });
});
