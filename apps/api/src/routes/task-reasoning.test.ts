import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { encryptJson, wrapDataKey } from '@athanor/core';
import type { RouteContext } from '../http/server-context.js';
import { registerTaskRoutes } from './tasks.js';

describe('reasoning selection at the authenticated task boundary', () => {
  const app = Fastify();
  const ownerId = '00000000-0000-4000-8000-000000000001';
  const workspaceId = '00000000-0000-4000-8000-000000000002';
  const key = Buffer.alloc(32, 7),
    masterKey = Buffer.alloc(32, 9);
  const task = {
    id: '00000000-0000-4000-8000-000000000003',
    userId: ownerId,
    workspaceId,
    status: 'queued',
    modelId: 'model',
    reasoningEffort: 'high',
    privacyRoute: 'provider_zdr',
    queuedMessageCount: 0,
    agentStateCiphertext: encryptJson(
      { messages: [], step: 0, credits: 0 },
      key,
      'task-state:00000000-0000-4000-8000-000000000003'
    )
  };
  const createTask = vi.fn(async (input: Record<string, unknown>) => ({ ...task, ...input }));
  const enqueueTaskMessage = vi.fn(async () => ({ ...task, queuedMessageCount: 1 }));
  const continueTask = vi.fn(async (input: Record<string, unknown>) => ({ ...task, ...input }));
  const recordUsage = vi.fn(async () => undefined);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: ownerId } as typeof request.user;
  });
  registerTaskRoutes({
    app,
    masterKey,
    config: { TASK_MAX_STEPS: 3 },
    log: { warn() {} },
    store: {
      getTask: async () => task,
      getWorkspace: async () => ({
        id: workspaceId,
        status: 'running',
        securityMode: 'balanced',
        wrappedKey: wrapDataKey(key, masterKey, workspaceId)
      }),
      createTask,
      enqueueTaskMessage,
      continueTask,
      recordUsage,
      appendTaskEvent: async () => ({ id: 'event' })
    },
    privateTaskResponse: async (value: unknown) => value,
    nameIndexFor: () => ({ nameTokens: '', openingTokens: '' }),
    resolveSpendCeiling: async () => 1,
    assertSpendCeilingAllowed: async () => undefined,
    computeAllowanceFor: () => 1,
    modelsForUser: async () => [
      {
        id: 'model',
        displayName: 'Model',
        availability: 'available',
        privacyRoute: 'provider_zdr',
        usageClass: 'light',
        reasoning: { supportedEfforts: ['low', 'high'], mandatory: true }
      }
    ],
    idempotent: async (
      _request: unknown,
      _reply: unknown,
      _user: unknown,
      execute: () => unknown
    ) => execute()
  } as unknown as RouteContext);
  afterAll(async () => app.close());

  it('passes a supported effort through create and rejects an unsupported effort before reservation', async () => {
    const valid = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        workspaceId,
        modelId: 'model',
        prompt: 'Analyse the sample',
        reasoningEffort: 'low'
      }
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json<{ reasoningEffort: string }>().reasoningEffort).toBe('low');
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }));
    const reserved = recordUsage.mock.calls.length;
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        workspaceId,
        modelId: 'model',
        prompt: 'Analyse the sample',
        reasoningEffort: 'max'
      }
    });
    expect(invalid.statusCode).not.toBe(200);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(reserved);
  });

  it('carries an explicit follow-up choice, preserves omission, and accepts Auto for a finished task', async () => {
    const url = `/v1/tasks/${task.id}/messages`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { prompt: 'Use less reasoning', reasoningEffort: 'low' }
        })
      ).statusCode
    ).toBe(200);
    expect(enqueueTaskMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningEffort: 'low' })
    );
    expect(
      (await app.inject({ method: 'POST', url, payload: { prompt: 'Continue' } })).statusCode
    ).toBe(200);
    expect(enqueueTaskMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' })
    );
    task.status = 'completed';
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { prompt: 'Adapt effort', reasoningEffort: 'auto' }
        })
      ).statusCode
    ).toBe(200);
    expect(continueTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ reasoningEffort: 'auto' })
    );
  });
});
