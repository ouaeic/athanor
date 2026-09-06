import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '../database.js';
import { DataStore } from '../store.js';
describe('native input ledger', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  beforeAll(async () => migrateDatabase(database));
  afterAll(async () => database.close());
  const fixture = async () => {
    const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'media',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: 'sealed'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'test',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 10
    });
    const usage = {
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'media:native-input',
      quantity: 1000,
      unit: 'tokens',
      credits: 1,
      costUsd: 1,
      state: 'reserved' as const,
      idempotencyKey: `native-input:${task.id}:source`,
      reserveAgainstCaps: true
    };
    return { user, workspace, task, usage };
  };
  it('prevents duplicate submissions and settles the owner receipt after the original task is deleted', async () => {
    const f = await fixture();
    await store.recordUsage(f.usage);
    await expect(store.recordUsage(f.usage)).rejects.toMatchObject({
      code: 'media_submission_exists'
    });
    await database.query('DELETE FROM tasks WHERE id=$1', [f.task.id]);
    await store.settleNativeInputUsage({
      userId: f.user.id,
      idempotencyKey: f.usage.idempotencyKey,
      costUsd: 0.2,
      credits: 0.3,
      quantity: 300
    });
    const rows = (
      await database.query(
        'SELECT state,cost_usd,credits,quantity,task_id FROM usage_entries WHERE idempotency_key=$1',
        [f.usage.idempotencyKey]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('settled');
    expect(Number(rows[0]?.cost_usd)).toBe(0.2);
    expect(Number(rows[0]?.credits)).toBe(0.3);
    expect(Number(rows[0]?.quantity)).toBe(300);
    expect(rows[0]?.task_id).toBeNull();
  });
  it('requires owner and native reservation identity and refuses invalid or repeated settlements', async () => {
    const f = await fixture();
    await store.recordUsage(f.usage);
    const other = await fixture();
    const settlement = {
      userId: f.user.id,
      idempotencyKey: f.usage.idempotencyKey,
      costUsd: 0.2,
      credits: 0.3,
      quantity: 300
    };
    await expect(
      store.settleNativeInputUsage({ ...settlement, userId: other.user.id })
    ).rejects.toMatchObject({ code: 'native_input_usage_missing' });
    await expect(
      store.settleNativeInputUsage({ ...settlement, costUsd: Number.NaN })
    ).rejects.toMatchObject({ code: 'native_input_usage_invalid' });
    await store.settleNativeInputUsage(settlement);
    await expect(store.settleNativeInputUsage(settlement)).rejects.toMatchObject({
      code: 'native_input_usage_missing'
    });
    const ordinary = { ...other.usage, resourceClass: 'media:transcription' };
    await store.recordUsage(ordinary);
    await expect(
      store.settleNativeInputUsage({
        ...settlement,
        userId: other.user.id,
        idempotencyKey: ordinary.idempotencyKey
      })
    ).rejects.toMatchObject({ code: 'native_input_usage_missing' });
  });
  it('round trips native pricing beside live input modality metadata', async () => {
    await store.upsertModels([
      {
        id: 'native-price-test',
        providerModelId: 'native-price-test',
        displayName: 'Native test',
        provider: 'openrouter',
        revision: 'test',
        availability: 'available',
        openness: 'remote_proprietary',
        license: 'Provider-defined',
        commercialUse: true,
        privacyRoute: 'external',
        contextTokens: 32000,
        modalities: ['text', 'audio', 'video'],
        capabilities: ['chat', 'tools'],
        usageClass: 'light',
        recommendationTags: [],
        measuredQuality: null,
        measuredLatencyMs: null,
        nativeInputPricing: { audioUsdPerMillionTokens: 4, videoUsdPerMillionTokens: 2 }
      }
    ]);
    expect(
      (await store.listModels()).find((entry) => entry.id === 'native-price-test')
    ).toMatchObject({
      modalities: ['text', 'audio', 'video'],
      nativeInputPricing: { audioUsdPerMillionTokens: 4, videoUsdPerMillionTokens: 2 }
    });
  });
  it('atomically counts pending native requests against the owner cap', async () => {
    const f = await fixture();
    await store.setSpendLimits({
      userId: f.user.id,
      dailyCapUsd: 1,
      monthlyCapUsd: 1,
      defaultTaskCapUsd: 1
    });
    const outcomes = await Promise.allSettled([
      store.recordUsage({
        ...f.usage,
        costUsd: 0.7,
        idempotencyKey: `${f.usage.idempotencyKey}:first`
      }),
      store.recordUsage({
        ...f.usage,
        costUsd: 0.7,
        idempotencyKey: `${f.usage.idempotencyKey}:second`
      })
    ]);
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { code: 'spend_cap_reached' }
    });
  });
});
