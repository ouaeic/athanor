import { describe, expect, it, vi } from 'vitest';
import { decryptJson } from '@athanor/core';
import type { TaskPlanRecord } from '@athanor/data';
import type { ToolContext } from '../tool-dispatch.js';
import { executePlanTool } from './plan.js';

describe('sealed plan output intent', () => {
  const fixture = () => {
    const key = Buffer.alloc(32, 3);
    let current: TaskPlanRecord | null = null;
    const event = vi.fn<
      (input: { payloadCiphertext: Parameters<typeof decryptJson>[0] }) => Promise<{ id: string }>
    >(async () => ({ id: 'event' }));
    const create = vi.fn(async (input: Partial<TaskPlanRecord>) => {
      current = {
        ...input,
        id: 'plan',
        version: (current?.version ?? 0) + 1,
        createdAt: new Date().toISOString()
      } as TaskPlanRecord;
      return current;
    });
    const context = {
      task: { id: 'task', userId: 'owner', workspaceId: 'workspace' },
      key,
      state: { messages: [], step: 1, credits: 0 },
      store: {
        getLatestTaskPlan: async () => current,
        createTaskPlan: create,
        appendTaskEvent: event
      }
    } as unknown as ToolContext;
    return { context, key, create, event, plan: () => current! };
  };
  it('preserves output intent through normal progress edits and records it for the owner', async () => {
    const { context, key, plan, event } = fixture();
    const outputs = [
      { kind: 'app', title: 'Maze game', directories: ['maze'], delivery: 'preview' }
    ];
    await executePlanTool(context, {
      id: 'declare',
      name: 'set_plan',
      arguments: { steps: ['Build', 'Verify'], outputs }
    });
    await executePlanTool(context, {
      id: 'advance',
      name: 'set_plan',
      arguments: {
        steps: [
          { title: 'Build', status: 'completed' },
          { title: 'Verify', status: 'in_progress' }
        ]
      }
    });
    const content = decryptJson<{ outputs: unknown; steps: Array<{ status: string }> }>(
      plan().stepsCiphertext,
      key,
      'task-plan:task'
    );
    expect(content.outputs).toEqual(outputs);
    expect(content.steps.map((step) => step.status)).toEqual(['completed', 'in_progress']);
    expect(event).toHaveBeenCalledTimes(2);
    const recorded = event.mock.calls.at(-1)?.[0];
    expect(recorded).toBeDefined();
    expect(
      decryptJson<{ payload: { outputs: unknown } }>(
        recorded!.payloadCiphertext,
        key,
        'task-event:task'
      ).payload.outputs
    ).toEqual(outputs);
  });
  it('rejects external and escaped output paths before any plan write', async () => {
    const { context, create } = fixture();
    for (const path of ['../outside', '/etc/passwd', 'https://untrusted.test/result']) {
      await expect(
        executePlanTool(context, {
          id: 'declare',
          name: 'set_plan',
          arguments: {
            steps: ['Build'],
            outputs: [{ kind: 'document', title: 'Report', files: [path] }]
          }
        })
      ).rejects.toThrow();
    }
    expect(create).not.toHaveBeenCalled();
  });
});
