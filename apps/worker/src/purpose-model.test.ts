import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ModelRelease } from '@athanor/contracts';
import {
  AthanorError,
  decryptJson,
  encryptJson,
  generateDataKey,
  selectPurposeModel,
  wrapDataKey
} from '@athanor/core';
import {
  createDatabase,
  DataStore,
  migrateDatabase,
  writeProjectModelPreferences
} from '@athanor/data';
import { applyProjectMainModel, resolveTaskPurposeModel } from './purpose-model.js';
import type { AgentState } from './agent-state.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database),
  masterKey = Buffer.alloc(32, 9),
  key = generateDataKey();
const models: ModelRelease[] = ['main', 'specialist', 'coding'].map((id, index) => ({
  id,
  providerModelId: id,
  displayName: id,
  provider: 'custom',
  revision: 'test',
  availability: 'available',
  openness: 'remote_proprietary',
  license: 'Provider-defined',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128000,
  modalities: ['text'],
  capabilities: ['chat', 'tools', 'reasoning'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.7 + index / 20,
  measuredLatencyMs: 100,
  inputUsdPerMillionTokens: 0.1,
  outputUsdPerMillionTokens: 0.2,
  updatedAt: '2026-09-01T00:00:00.000Z'
}));
beforeAll(async () => {
  await migrateDatabase(database);
  await store.upsertModels(models);
});
afterAll(async () => database.close());
async function fixture() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const workspaceId = randomUUID();
  await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Project',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'local',
    wrappedKey: wrapDataKey(key, masterKey, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId,
    modelId: 'main',
    securityMode: 'autonomous',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    maxSpendUsd: 0.2,
    titleCiphertext: encryptJson({ title: 'Project' }, key, `task-title:${workspaceId}`),
    promptCiphertext: encryptJson(
      { prompt: 'Build an analysis' },
      key,
      `task-prompt:${workspaceId}`
    ),
    nameIndex: { nameTokens: '', openingTokens: '' }
  });
  await database.query(
    "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
    [task.id]
  );
  return {
    task,
    user,
    context: {
      store,
      masterKey,
      inferenceCredential: async () => ({ provider: 'openai-compatible' as const })
    }
  };
}
const pin = (modelId: string) => ({ automatic: false, preference: 'balanced' as const, modelId });

it('routes each purpose through its project override and refuses a missing explicit choice', async () => {
  const f = await fixture();
  await writeProjectModelPreferences(store, masterKey, f.task, {
    expectedRevision: 0,
    choices: { specialist: pin('specialist'), coding: pin('coding') }
  });
  expect((await resolveTaskPurposeModel(f.context, f.task, 'specialist', models)).id).toBe(
    'specialist'
  );
  expect((await resolveTaskPurposeModel(f.context, f.task, 'coding', models)).id).toBe('coding');
  await expect(
    resolveTaskPurposeModel(
      f.context,
      f.task,
      'coding',
      models.filter((model) => model.id !== 'coding')
    )
  ).rejects.toMatchObject({ code: 'purpose_model_unavailable' });
});

it('applies a main choice once at a leased boundary while preserving subsequent explicit choices and authority', async () => {
  const f = await fixture();
  await writeProjectModelPreferences(store, masterKey, f.task, {
    expectedRevision: 0,
    choices: { main: pin('specialist') }
  });
  const state: AgentState = {
    messages: [{ role: 'user', content: 'Build an analysis' }],
    step: 0,
    credits: 0
  };
  await applyProjectMainModel(f.context, f.task, state, models, key, 'worker');
  expect(f.task.modelId).toBe('specialist');
  const stored = await store.getTask(f.user.id, f.task.id);
  expect(stored).toMatchObject({
    modelId: 'specialist',
    securityMode: 'autonomous',
    maxComputeCredits: 1,
    maxSpendUsd: 0.2
  });
  expect(decryptJson<AgentState>(stored!.agentStateCiphertext!, key).mainModelPreference).toBe(
    state.mainModelPreference
  );
  f.task.modelId = 'main';
  await applyProjectMainModel(f.context, f.task, state, models, key, 'worker');
  expect(f.task.modelId).toBe('main');
  await writeProjectModelPreferences(store, masterKey, f.task, {
    expectedRevision: 1,
    choices: { main: pin('coding') }
  });
  await expect(
    applyProjectMainModel(f.context, f.task, state, models, key, 'other-worker')
  ).rejects.toMatchObject({ code: 'task_changed' });
});

it('shares privacy, provider and price refusal between settings and runtime selection', () => {
  const selected = (catalog: ModelRelease[], overrides = {}) =>
    selectPurposeModel({
      purpose: 'coding',
      choice: pin('coding'),
      catalog,
      privacyRoute: 'provider_zdr',
      provider: 'custom',
      ...overrides
    });
  expect(selected(models).model?.id).toBe('coding');
  expect(
    selected(models.map((model) => ({ ...model, privacyRoute: 'external' }))).model
  ).toBeNull();
  expect(selected(models, { provider: 'openrouter' }).model).toBeNull();
  expect(selected(models, { ceiling: { maxOutputUsdPerMillionTokens: 0.01 } }).model).toBeNull();
});

it('uses the connected provider after migration and never falls back to the task provider', async () => {
  const f = await fixture();
  const former = { ...models[0]!, id: 'former-main', provider: 'openrouter' as const };
  const catalog = [...models, former];
  await store.upsertModels([former]);
  await database.query('UPDATE tasks SET model_id=$2 WHERE id=$1', [f.task.id, former.id]);
  f.task.modelId = former.id;
  await writeProjectModelPreferences(store, masterKey, f.task, {
    expectedRevision: 0,
    choices: { main: pin('main'), coding: pin('coding'), specialist: pin('specialist') }
  });
  expect((await resolveTaskPurposeModel(f.context, f.task, 'coding', catalog)).id).toBe('coding');
  expect((await resolveTaskPurposeModel(f.context, f.task, 'specialist', catalog)).id).toBe(
    'specialist'
  );
  const state: AgentState = { messages: [], step: 0, credits: 0 };
  await applyProjectMainModel(f.context, f.task, state, catalog, key, 'worker');
  expect((await store.getTask(f.user.id, f.task.id))?.modelId).toBe('main');
  await writeProjectModelPreferences(store, masterKey, f.task, {
    expectedRevision: 1,
    choices: { main: pin(former.id), coding: pin(former.id) }
  });
  await expect(resolveTaskPurposeModel(f.context, f.task, 'coding', catalog)).rejects.toMatchObject(
    { code: 'purpose_model_unavailable' }
  );
  await expect(
    applyProjectMainModel(f.context, f.task, state, catalog, key, 'worker')
  ).rejects.toMatchObject({ code: 'purpose_model_unavailable' });
  const disconnected = {
    ...f.context,
    inferenceCredential: async () => {
      throw new AthanorError('provider_not_connected', 'Disconnected');
    }
  };
  await expect(
    resolveTaskPurposeModel(disconnected, f.task, 'coding', catalog)
  ).rejects.toMatchObject({ code: 'provider_not_connected' });
  await expect(
    applyProjectMainModel(disconnected, f.task, state, catalog, key, 'worker')
  ).rejects.toMatchObject({ code: 'provider_not_connected' });
  expect((await store.getTask(f.user.id, f.task.id))?.modelId).toBe('main');
});
