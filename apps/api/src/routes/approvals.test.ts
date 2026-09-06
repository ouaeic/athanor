import { describe, expect, it, vi } from 'vitest';
import { registerApprovalRoutes } from './approvals.js';
import type { RouteContext } from '../http/server-context.js';

describe('browser approval settlement', () => {
  it('does not overwrite a cancellation that follows atomic settlement', async () => {
    let taskStatus = 'awaiting_user';
    let handler: (request: unknown, reply: unknown) => Promise<unknown> = async () => undefined;
    const settle = vi.fn(async () => {
      taskStatus = 'queued';
      // Another owner action commits after the store's atomic answer has returned.
      taskStatus = 'cancelled';
      return true;
    });
    const statusWrite = vi.fn(async (_owner: string, _task: string, status: string) => {
      taskStatus = status;
      return true;
    });
    registerApprovalRoutes({
      app: {
        get() {},
        post(_path: string, route: typeof handler) {
          handler = route;
        }
      },
      store: {
        getApproval: async () => ({ userId: 'owner', taskId: 'task' }),
        resolveApproval: settle,
        setTaskStatusForUser: statusWrite
      },
      masterKey: new Uint8Array(32),
      idempotent: async (_request: unknown, _reply: unknown, _user: unknown, run: () => unknown) =>
        run()
    } as unknown as RouteContext);
    expect(
      await handler(
        { user: { id: 'owner' }, params: { approvalId: 'approval', decision: 'approve' } },
        {}
      )
    ).toEqual({ ok: true });
    expect(settle).toHaveBeenCalledWith('owner', 'approval', 'approved');
    expect(statusWrite).not.toHaveBeenCalled();
    expect(taskStatus).toBe('cancelled');
  });
});
