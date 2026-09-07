import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encryptJson, wrapDataKey } from '@athanor/core';
import { createDatabase, migrateDatabase } from './database.js';
import { DataStore } from './store.js';
import {
  readProjectModelPreferences,
  writeProjectModelPreferences,
  resolvePurposeChoice
} from './project-model-preferences.js';

const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database),
  masterKey = Buffer.alloc(32, 7),
  key = Buffer.alloc(32, 9);
beforeAll(() => migrateDatabase(database));
afterAll(() => database.close());
const fixture = async () => {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
  const id = randomUUID();
  const workspace = await store.createWorkspace({
    id,
    userId: user.id,
    name: 'Project',
    imageRevision: 'fixture',
    region: 'auto',
    storageLimitBytes: 1_000_000,
    wrappedKey: wrapDataKey(key, masterKey, id)
  });
  const input = {
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson({ title: 'Test' }, key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'fixture',
    privacyRoute: 'provider_zdr' as const,
    maxComputeCredits: 1,
    promptCiphertext: encryptJson({ prompt: 'Test' }, key)
  };
  const root = await store.createTask(input),
    child = await store.createTask(input);
  await database.query('UPDATE tasks SET parent_task_id=$1 WHERE id=$2', [root.id, child.id]);
  return { user, root, child };
};
it('seals choices for the primary project, inherits through child work and preserves explicit automatic', async () => {
  const { root, child } = await fixture();
  expect(await readProjectModelPreferences(store, masterKey, child)).toEqual({
    projectTaskId: root.id,
    revision: 0,
    choices: {}
  });
  const choice = {
    automatic: false,
    preference: 'balanced' as const,
    modelId: 'owner-private-choice'
  };
  await writeProjectModelPreferences(store, masterKey, child, {
    expectedRevision: 0,
    choices: { image: choice }
  });
  expect(await readProjectModelPreferences(store, masterKey, root)).toMatchObject({
    revision: 1,
    choices: { image: choice }
  });
  const rows = await database.query(
    'SELECT choices_ciphertext FROM project_model_preferences WHERE project_task_id=$1',
    [root.id]
  );
  expect(rows.rows).toHaveLength(1);
  expect(JSON.stringify(rows.rows)).not.toContain(choice.modelId);
  expect(resolvePurposeChoice('image', {}, { image: choice })).toEqual({
    source: 'global',
    choice
  });
  const automatic = { automatic: true, preference: 'fast' as const, modelId: '' };
  expect(resolvePurposeChoice('image', { image: automatic }, { image: choice })).toEqual({
    source: 'project',
    choice: automatic
  });
});
it('refuses another owner and stale concurrent writes without overwriting current choices', async () => {
  const { root } = await fixture();
  const request = {
    expectedRevision: 0,
    choices: { audio: { automatic: true, preference: 'best' as const, modelId: '' } }
  };
  const outcomes = await Promise.allSettled([
    writeProjectModelPreferences(store, masterKey, root, request),
    writeProjectModelPreferences(store, masterKey, root, request)
  ]);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await expect(
    readProjectModelPreferences(store, masterKey, { id: root.id, userId: randomUUID() })
  ).rejects.toMatchObject({ code: 'project_not_found' });
  expect((await readProjectModelPreferences(store, masterKey, root)).revision).toBe(1);
  await writeProjectModelPreferences(store, masterKey, root, { expectedRevision: 1, choices: {} });
  expect(await readProjectModelPreferences(store, masterKey, root)).toMatchObject({
    revision: 2,
    choices: {}
  });
});
