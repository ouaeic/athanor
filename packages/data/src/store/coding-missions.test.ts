import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase } from '../database.js';
import { DataStore } from '../store.js';
import { BillingStore } from './billing.js';

const sealed = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
describe('native coding mission transactions', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  beforeAll(async () => migrateDatabase(database));
  afterAll(async () => database.close());
  const fixture = async (max = 1) => {
    const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: 'sealed'
    });
    await store.updateWorkspaceStatus(workspace.id, 'running');
    const parent = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: sealed,
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: max,
      promptCiphertext: sealed
    });
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [parent.id]
    );
    const input = (allocated = 0.4) => {
      const childWorkspace = randomUUID(),
        id = randomUUID();
      return {
        id,
        parentTaskId: parent.id,
        userId: user.id,
        workerId: 'worker',
        requestKey: id,
        requestHash: 'request-hash',
        manifestCiphertext: sealed,
        allocatedCredits: allocated,
        workspace: {
          id: childWorkspace,
          userId: user.id,
          name: 'Coding specialist',
          storageLimitBytes: 1e9,
          imageRevision: 'test',
          region: 'local',
          wrappedKey: 'sealed'
        },
        task: {
          userId: user.id,
          workspaceId: childWorkspace,
          titleCiphertext: sealed,
          nameIndex: { nameTokens: '', openingTokens: '' },
          modelId: 'model',
          privacyRoute: 'provider_zdr',
          maxComputeCredits: allocated,
          promptCiphertext: sealed
        }
      };
    };
    return { user, parent, workspace, input };
  };
  it('allocates concurrent children from one ceiling and hides internal workspaces while retaining owner access', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      store.createCodingMission(f.input(0.7)),
      store.createCodingMission(f.input(0.7))
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const missions = await store.listCodingMissions(f.user.id, f.parent.id);
    expect(missions).toHaveLength(1);
    expect(await store.listWorkspaces(f.user.id)).toHaveLength(1);
    expect(await store.getWorkspace(f.user.id, missions[0]!.childWorkspaceId)).not.toBeNull();
    expect(await store.getWorkspace(randomUUID(), missions[0]!.childWorkspaceId)).toBeNull();
    expect((await store.listTaskPage(f.user.id)).tasks.map((t) => t.id)).toEqual([f.parent.id]);
    expect(await store.getTask(f.user.id, missions[0]!.childTaskId)).toMatchObject({
      parentTaskId: f.parent.id,
      parentMissionId: missions[0]!.id,
      hasCodingFamily: true
    });
  });
  it('claims each native source request once and preserves uncertain family exposure across replay', async () => {
    const f = await fixture();
    await store.createCodingMission(f.input());
    const key = 'a'.repeat(64);
    const results = await Promise.allSettled([
      store.reserveCodingInference(f.parent.id, 'worker', 0.1, 0.02, key),
      store.reserveCodingInference(f.parent.id, 'worker', 0.1, 0.02, key)
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const fulfilled = results.find((entry) => entry.status === 'fulfilled');
    if (fulfilled?.status !== 'fulfilled') throw new Error('Missing first native reservation');
    await store.settleCodingInference(fulfilled.value, null);
    await expect(
      store.reserveCodingInference(f.parent.id, 'worker', 0.1, 0.02, key)
    ).rejects.toMatchObject({ code: 'native_input_submission_exists' });
    const rows = await database.query(
      'SELECT state,reserved_usd,actual_usd FROM coding_family_calls WHERE original_task_id=$1',
      [f.parent.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      state: 'uncertain',
      reserved_usd: 0.02,
      actual_usd: null
    });
    const other = await store.reserveCodingInference(
      f.parent.id,
      'worker',
      0.1,
      0.02,
      'b'.repeat(64)
    );
    expect(other).not.toBe(fulfilled.value);
  });
  it('replays creation once, rejects conflicting replays and never creates grandchildren', async () => {
    const f = await fixture(),
      input = f.input();
    const mission = await store.createCodingMission(input);
    expect((await store.createCodingMission(input)).id).toBe(mission.id);
    await expect(store.createCodingMission({ ...input, requestHash: 'different' })).rejects.toThrow(
      /different work/
    );
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [mission.childTaskId]
    );
    await expect(
      store.createCodingMission({ ...f.input(), parentTaskId: mission.childTaskId })
    ).rejects.toThrow(/another specialist/);
    expect(await store.listCodingMissions(f.user.id, f.parent.id)).toHaveLength(1);
  });
  it('reserves competing inference attempts atomically and preserves uncertain provider spend after cancellation', async () => {
    const f = await fixture(),
      mission = await store.createCodingMission(f.input(0.6));
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [mission.childTaskId]
    );
    const attempts = await Promise.allSettled([
      store.reserveCodingInference(mission.childTaskId, 'worker', 0.4),
      store.reserveCodingInference(mission.childTaskId, 'worker', 0.4)
    ]);
    const accepted = attempts.filter(
      (r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled'
    );
    expect(accepted).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(store.reserveCodingInference(f.parent.id, 'worker', 0.5)).rejects.toThrow(
      /capacity/
    );
    await store.settleCodingInference(accepted[0]!.value, 0.1);
    const uncertain = await store.reserveCodingInference(mission.childTaskId, 'worker', 0.4);
    await store.settleCodingInference(uncertain, null);
    await store.cancelCodingMission(f.user.id, mission.id);
    await expect(store.reserveCodingInference(mission.childTaskId, 'worker', 0.01)).rejects.toThrow(
      /authority|active/
    );
    const cancelled = await store.getCodingMission(f.user.id, mission.id);
    expect(cancelled).toMatchObject({
      phase: 'cancelled',
      usedCredits: 0.1,
      reservedCredits: 0.4,
      generation: 2
    });
    const parentCall = await store.reserveCodingInference(f.parent.id, 'worker', 0.4);
    await expect(store.reserveCodingInference(f.parent.id, 'worker', 0.2)).rejects.toThrow(
      /capacity/
    );
    await store.settleCodingInference(parentCall, 0.2);
    await store.settleCodingInference(parentCall, 0.8);
    expect((await store.getTask(f.user.id, f.parent.id))?.actualComputeCredits).toBeCloseTo(0.3, 8);
    await store.updateTask({
      id: f.parent.id,
      workerId: 'worker',
      status: 'running',
      actualComputeCredits: 0.2
    });
    expect((await store.getTask(f.user.id, f.parent.id))?.actualComputeCredits).toBeCloseTo(0.3, 8);
  });
  it('shares the dollar ceiling across inference, media and ledger settlement without counting a receipt twice', async () => {
    const f = await fixture(10);
    await database.query('UPDATE tasks SET max_spend_usd=1 WHERE id=$1', [f.parent.id]);
    const mission = await store.createCodingMission(f.input(4));
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [mission.childTaskId]
    );
    const reservation = await store.reserveCodingInference(mission.childTaskId, 'worker', 0.1, 0.7);
    await expect(store.reserveCodingInference(f.parent.id, 'worker', 0.1, 0.4)).rejects.toThrow(
      /spending allowance/
    );
    const media = {
      userId: f.user.id,
      workspaceId: f.workspace.id,
      taskId: f.parent.id,
      kind: 'model_inference',
      resourceClass: 'media:image',
      quantity: 1,
      unit: 'image',
      credits: 0,
      state: 'reserved' as const,
      idempotencyKey: randomUUID(),
      costUsd: 0.4,
      reserveAgainstCaps: true
    };
    await expect(store.recordUsage(media)).rejects.toThrow(/spending allowance/);
    await store.settleCodingInference(reservation, 0.05, 0.2);
    const before = await store.spendGuard({
      userId: f.user.id,
      taskId: f.parent.id,
      estimateUsd: 0.75,
      includeOpenCommitments: true
    });
    expect(before.outcome).not.toBe('deny');
    await store.recordUsage({
      ...media,
      state: 'settled',
      costUsd: 0.2,
      resourceClass: 'medium',
      reserveAgainstCaps: false,
      codingReservationId: reservation,
      taskId: mission.childTaskId,
      idempotencyKey: randomUUID()
    });
    const after = await store.spendGuard({
      userId: f.user.id,
      taskId: mission.childTaskId,
      estimateUsd: 0.75,
      includeOpenCommitments: true
    });
    expect(after.outcome).not.toBe('deny');
    await store.recordUsage({ ...media, costUsd: 0.7, idempotencyKey: randomUUID() });
    await expect(
      store.reserveCodingInference(mission.childTaskId, 'worker', 0.1, 0.2)
    ).rejects.toThrow(/spending allowance/);
    expect(await new BillingStore(database).openSpendCommitment(f.user.id, f.parent.id)).toBe(0);
  });
  it('refuses a stale parent lease before creating a workspace or allocating budget', async () => {
    const f = await fixture();
    await expect(store.createCodingMission({ ...f.input(), workerId: 'stale' })).rejects.toThrow(
      /no longer owns/
    );
    expect(await store.listCodingMissions(f.user.id, f.parent.id)).toEqual([]);
    expect(await store.listWorkspaces(f.user.id)).toHaveLength(1);
  });
  it('requires the live parent lease or an idle parent for exact completed integration and does not revive cancelled work', async () => {
    const f = await fixture(),
      mission = await store.createCodingMission(f.input());
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await store.updateTask({ id: mission.childTaskId, status: 'completed' });
    await store.recordCodingMissionReview(f.user.id, mission.id, 1, {
      digest: 'digest',
      changedFiles: 1,
      conflicts: 0
    });
    await expect(
      store.beginCodingMissionIntegration(f.user.id, mission.id, 1, 'digest')
    ).rejects.toThrow(/released/);
    await expect(
      store.beginCodingMissionIntegration(f.user.id, mission.id, 1, 'different', 'worker')
    ).rejects.toThrow(/reviewed again/);
    await store.beginCodingMissionIntegration(f.user.id, mission.id, 1, 'digest', 'worker');
    await store.cancelTaskAndReleaseReservations(f.user.id, f.parent.id);
    expect(
      await store.finishCodingMissionIntegration(f.user.id, mission.id, 1, 'digest', false)
    ).toBe(true);
    expect((await store.getCodingMission(f.user.id, mission.id))?.phase).toBe('cancelled');
    await expect(
      store.setTaskStatusForUser(f.user.id, mission.childTaskId, 'queued')
    ).resolves.toBe(false);
  });
  it('seals completed children and prevents independent resumes or follow-up allocation resets', async () => {
    const f = await fixture(),
      mission = await store.createCodingMission(f.input());
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await store.updateTask({ id: mission.childTaskId, status: 'completed' });
    expect((await store.codingMissionsNeedingSync()).map((m) => m.id)).toContain(mission.id);
    await store.acknowledgeCodingMissionRunner(f.user.id, mission.id, 1, true);
    expect((await store.codingMissionsNeedingSync()).map((m) => m.id)).not.toContain(mission.id);
    expect(await store.setTaskStatusForUser(f.user.id, mission.childTaskId, 'queued')).toBe(false);
    expect(
      await store.continueTask({
        id: mission.childTaskId,
        userId: f.user.id,
        modelId: 'model',
        privacyRoute: 'provider_zdr',
        additionalComputeCredits: 10,
        agentStateCiphertext: sealed,
        reservationKey: randomUUID(),
        resourceClass: 'medium',
        userMessageCiphertext: sealed
      })
    ).toBeNull();
    await database.query("UPDATE tasks SET status='failed' WHERE id=$1", [f.parent.id]);
    expect(
      (await store.codingMissionsNeedingSync()).find((m) => m.id === mission.id)
    ).toMatchObject({ parentStatus: 'failed', childStatus: 'completed' });
  });
  it('preserves family credits through terminal completion and projects dollars from child receipts', async () => {
    const f = await fixture(),
      mission = await store.createCodingMission(f.input(0.6));
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [mission.childTaskId]
    );
    const call = await store.reserveCodingInference(mission.childTaskId, 'worker', 0.3, 0.3);
    await store.settleCodingInference(call, 0.2, 0.2);
    expect((await store.getTask(f.user.id, f.parent.id))?.spentUsd).toBeCloseTo(0.2, 8);
    expect(
      await store.completeTaskIfNoQueued({
        id: f.parent.id,
        workerId: 'worker',
        actualComputeCredits: 0.01,
        agentStateCiphertext: sealed
      })
    ).toBe(true);
    expect((await store.getTask(f.user.id, f.parent.id))?.actualComputeCredits).toBeCloseTo(0.2, 8);
  });
  it('retains possible provider charges after task deletion and links a late receipt without double billing', async () => {
    const f = await fixture(),
      mission = await store.createCodingMission(f.input(0.6));
    await store.activateCodingMission(f.user.id, mission.id, 1);
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [mission.childTaskId]
    );
    const call = await store.reserveCodingInference(mission.childTaskId, 'worker', 0.3, 0.4);
    await store.settleCodingInference(call, null);
    await store.cancelTaskAndReleaseReservations(f.user.id, f.parent.id);
    expect(await store.deleteTask(f.user.id, f.parent.id)).toBe(true);
    const retained = (await database.query('SELECT * FROM coding_family_calls WHERE id=$1', [call]))
      .rows[0];
    expect(retained).toMatchObject({
      user_id: f.user.id,
      original_task_id: mission.childTaskId,
      task_id: null,
      parent_task_id: null,
      state: 'uncertain',
      reserved_usd: 0.4
    });
    await store.setSpendLimits({ userId: f.user.id, dailyCapUsd: 0.5, monthlyCapUsd: 1 });
    expect(
      (
        await store.spendGuard({
          userId: f.user.id,
          estimateUsd: 0.2,
          includeOpenCommitments: true
        })
      ).outcome
    ).toBe('deny');
    await store.settleCodingInference(call, 0.1, 0.2);
    const billing = new BillingStore(database),
      from = new Date(Date.now() - 86400000),
      to = new Date(Date.now() + 86400000);
    expect(await billing.spendTotal(f.user.id, from, to)).toBeCloseTo(0.2, 8);
    await store.recordUsage({
      userId: f.user.id,
      workspaceId: mission.childWorkspaceId,
      taskId: mission.childTaskId,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'tokens',
      credits: 0.1,
      state: 'settled',
      idempotencyKey: randomUUID(),
      costUsd: 0.2,
      codingReservationId: call
    });
    expect(await billing.spendTotal(f.user.id, from, to)).toBeCloseTo(0.2, 8);
    expect(
      (await database.query('SELECT usage_id FROM coding_family_calls WHERE id=$1', [call])).rows[0]
        ?.usage_id
    ).toBeTruthy();
  });
});
