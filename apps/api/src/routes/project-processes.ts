import { AthanorError } from '@athanor/core';
import type { ProcessList } from '@athanor/contracts';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerProjectProcessRoutes = ({ app, store, runner }: RouteContext): void => {
  for (const kind of ['task', 'project'] as const)
    app.get<{ Params: { taskId: string } }>(`/v1/${kind}s/:taskId/processes`, async (request) => {
      const user = requireUser(request.user);
      const members = await store.projectExecutionMembers(user.id, request.params.taskId, kind);
      if (
        kind === 'project'
          ? !(await store.getProject(user.id, request.params.taskId))
          : !members.some((member) => member.taskId === request.params.taskId)
      )
        throw new AthanorError('task_not_found', 'Project not found', 404);
      const scopes = new Map<string, Set<string>>();
      for (const member of members) {
        const owners = scopes.get(member.workspaceId) ?? new Set<string>();
        owners.add(member.taskId);
        scopes.set(member.workspaceId, owners);
      }
      const results: ProcessList[] = [];
      let unavailableWorkspaces = 0,
        next = 0;
      const workspaces = [...scopes.entries()];
      if (!workspaces.length)
        return {
          processes: [],
          observedAt: new Date().toISOString(),
          resourcesAvailable: false
        } satisfies ProcessList;
      await Promise.all(
        Array.from({ length: Math.min(4, workspaces.length) }, async () => {
          while (next < workspaces.length) {
            const [workspaceId, owners] = workspaces[next++]!;
            try {
              const list = await runner.request<ProcessList>({
                workspaceId,
                userId: user.id,
                role: 'user',
                scopes: ['exec'],
                path: `/v1/workspaces/${workspaceId}/processes`,
                timeoutMs: 5_000
              });
              if (list.processes.some((process) => !process.ownerTaskId)) unavailableWorkspaces++;
              results.push({
                ...list,
                processes: list.processes
                  .filter((process) => process.ownerTaskId && owners.has(process.ownerTaskId))
                  .map((process) => ({ ...process, workspaceId }))
              });
            } catch {
              unavailableWorkspaces++;
            }
          }
        })
      );
      if (!results.length)
        throw new AthanorError(
          'runner_unavailable',
          'Process status is temporarily unavailable',
          503
        );
      const first = results[0]!;
      return {
        processes: results.flatMap((list) => list.processes),
        observedAt: new Date().toISOString(),
        ...(first.refreshAfterMs ? { refreshAfterMs: first.refreshAfterMs } : {}),
        resourcesAvailable: results.some((list) => list.resourcesAvailable),
        ...(first.host ? { host: first.host } : {}),
        unavailableWorkspaces,
        ...(unavailableWorkspaces
          ? { note: 'Some project execution roots are unavailable. This list may be incomplete.' }
          : {})
      } satisfies ProcessList;
    });
};
