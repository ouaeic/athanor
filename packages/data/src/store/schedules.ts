import { randomUUID } from 'node:crypto';
import type { EncryptedEnvelope } from '@athanor/core';
import type { Database } from '../database.js';
import type { TaskRecord, TaskScheduleRecord } from '../types.js';
import { json, mapTask, mapTaskSchedule, numericOrNull } from './rows.js';
import type { BillingStore } from './billing.js';
import { TASK_EVENT_CHANNEL, TASK_QUEUE_CHANNEL } from './tasks.js';
import type { TaskSignals } from './tasks.js';

/**
 * Schedules: the one thing on this box that starts work while nobody is watching.
 *
 * Everything unattended about that is in `materializeTaskSchedule`, and it is one transaction on
 * purpose. The lease, the spend guard, the task insert and the run row all take the same handle -
 * `spendGuardIn` is `Database`-parameterised for exactly this, so the ceiling a run is authorised
 * under is read on the handle that then commits the work. Give the guard its own connection and it
 * reads a total another connection is still free to change before the insert lands, which on an
 * hourly schedule is a brake that reports the wrong number all night.
 *
 * That is why this file holds the `BillingStore` itself rather than a copy of its statements.
 */
export class ScheduleStore {
  readonly #billing: BillingStore;
  readonly #taskSignals: TaskSignals;

  /**
   * Assigned in the constructor body rather than in field initialisers, for the reason `DataStore`
   * records: `database` is a parameter property, and with `useDefineForClassFields` on under ES2022
   * a field initialiser runs before the constructor body assigns it.
   */
  constructor(
    private readonly database: Database,
    billing: BillingStore,
    taskSignals: TaskSignals
  ) {
    this.#billing = billing;
    this.#taskSignals = taskSignals;
  }

  /**
   * Says that this task has changed, to whoever is watching it and wherever they are.
   *
   * A materialised run is a task arriving, so it wakes the same worker slots and the same open
   * streams that `tasks.ts` wakes, through the same `TaskSignals`.
   */
  #signal(channel: string, payload: string): void {
    this.#taskSignals.signal(channel, payload);
  }

  async createTaskSchedule(input: {
    userId: string;
    workspaceId: string;
    titleCiphertext: EncryptedEnvelope;
    promptCiphertext: EncryptedEnvelope;
    modelId: string;
    privacyRoute: string;
    maxComputeCredits: number;
    maxSpendUsd?: number | null;
    spec: TaskScheduleRecord['spec'];
    nextRunAt: Date;
    maxSchedules?: number;
  }): Promise<TaskScheduleRecord> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
      if (input.maxSchedules !== undefined) {
        const count = await tx.query(
          'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
          [input.userId]
        );
        if (Number(count.rows[0]?.count ?? 0) >= input.maxSchedules) {
          throw new Error('schedule_limit');
        }
      }
      const result = await tx.query(
        `INSERT INTO task_schedules(
          id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,model_id,privacy_route,
          max_compute_credits,spec,next_run_at,max_spend_usd
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.workspaceId,
          JSON.stringify(input.titleCiphertext),
          JSON.stringify(input.promptCiphertext),
          input.modelId,
          input.privacyRoute,
          input.maxComputeCredits,
          JSON.stringify(input.spec),
          input.nextRunAt.toISOString(),
          input.maxSpendUsd ?? null
        ]
      );
      return mapTaskSchedule(result.rows[0]!);
    });
  }

  async countTaskSchedules(userId: string): Promise<number> {
    const result = await this.database.query(
      'SELECT COUNT(*) AS count FROM task_schedules WHERE user_id=$1 AND next_run_at IS NOT NULL',
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listTaskSchedules(userId: string): Promise<TaskScheduleRecord[]> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE w.user_id=$1 ORDER BY s.created_at DESC`,
      [userId]
    );
    return result.rows.map(mapTaskSchedule);
  }

  async getTaskSchedule(userId: string, id: string): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `SELECT s.* FROM task_schedules s JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.id=$2 AND w.user_id=$1`,
      [userId, id]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  /**
   * The switch an owner throws, on either side.
   *
   * `consecutive_failures=0` is here because this is the statement a resume goes through, and a
   * schedule that has just been turned back on has to get its full patience back: the streak that
   * paused it is over the moment a person decides to try again. Before the counter existed the
   * streak was read out of `task_schedule_runs`, which this statement does not touch, so the three
   * failures that caused the pause were still the three newest rows and the very next failure
   * re-paused the schedule - measured through the resume route, one failure rather than three.
   *
   * It resets on the pause side too, which costs nothing: a disabled schedule is not dispatched, so
   * the only reader of the counter cannot run until something enables it again.
   */
  async setTaskScheduleEnabled(
    userId: string,
    id: string,
    enabled: boolean,
    nextRunAt: Date | null
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET enabled=$3,
       next_run_at=CASE WHEN $3 THEN $4 ELSE next_run_at END,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,consecutive_failures=0,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [userId, id, enabled, nextRunAt?.toISOString() ?? null]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async updateTaskSchedule(
    userId: string,
    id: string,
    input: {
      titleCiphertext: EncryptedEnvelope;
      promptCiphertext: EncryptedEnvelope;
      spec: TaskScheduleRecord['spec'];
      maxComputeCredits: number;
      maxSpendUsd?: number | null;
      nextRunAt: Date | null;
    }
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET title_ciphertext=$3::jsonb,prompt_ciphertext=$4::jsonb,
       spec=$5::jsonb,max_compute_credits=$6,next_run_at=$7,max_spend_usd=$8,lease_owner=NULL,
       lease_expires_at=NULL,last_error_code=NULL,updated_at=NOW()
       WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       ) RETURNING *`,
      [
        userId,
        id,
        JSON.stringify(input.titleCiphertext),
        JSON.stringify(input.promptCiphertext),
        JSON.stringify(input.spec),
        input.maxComputeCredits,
        input.nextRunAt?.toISOString() ?? null,
        input.maxSpendUsd ?? null
      ]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async deleteTaskSchedule(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM task_schedules WHERE id=$2 AND EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id=task_schedules.workspace_id AND w.user_id=$1
       )`,
      [userId, id]
    );
    return result.rowCount === 1;
  }

  async leaseDueTaskSchedule(
    workerId: string,
    leaseSeconds = 120
  ): Promise<TaskScheduleRecord | null> {
    const result = await this.database.query(
      `UPDATE task_schedules SET lease_owner=$1,
       lease_expires_at=NOW()+($2 * INTERVAL '1 second'),updated_at=NOW()
       WHERE id=(
         SELECT id FROM task_schedules
         WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
         ORDER BY next_run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ) RETURNING *`,
      [workerId, leaseSeconds]
    );
    return result.rows[0] ? mapTaskSchedule(result.rows[0]) : null;
  }

  async deferTaskSchedule(
    scheduleId: string,
    workerId: string,
    errorCode: string,
    delaySeconds = 300
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE task_schedules SET next_run_at=NOW()+($4 * INTERVAL '1 second'),
       last_error_code=$3,lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
       WHERE id=$1 AND lease_owner=$2 AND enabled=TRUE`,
      [scheduleId, workerId, errorCode, delaySeconds]
    );
    return result.rowCount === 1;
  }

  async materializeTaskSchedule(input: {
    scheduleId: string;
    workerId: string;
    taskId: string;
    nextRunAt: Date | null;
    resourceClass: string;
    preparingEventCiphertext: EncryptedEnvelope;
    failureEventCiphertext: EncryptedEnvelope;
    forceFailureCode?: string;
  }): Promise<{
    task: TaskRecord;
    outcome: 'queued' | 'failed';
    errorCode: string | null;
    /**
     * How many runs in a row, ending with this one, have failed for `model_unavailable`. Zero after
     * any other outcome, including a queued run and a failure with a different code.
     *
     * Returned rather than left for the caller to query, because the value the caller needs is the
     * one this transaction just wrote: a separate read afterwards is a second answer to the same
     * question, and on a box with two schedulers it is a read of somebody else's write.
     */
    consecutiveFailures: number;
  } | null> {
    const materialized = await this.database.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT * FROM task_schedules WHERE id=$1 AND lease_owner=$2
         AND enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at<=NOW() FOR UPDATE`,
        [input.scheduleId, input.workerId]
      );
      const schedule = locked.rows[0];
      if (!schedule) return null;

      let errorCode = input.forceFailureCode ?? null;
      if (!errorCode) {
        // The unattended path is the one that has to fail closed: nobody is watching a 3am run,
        // so a schedule that would take the account past its ceiling never starts at all. The
        // ceiling is the owner's own spend cap, in the currency the provider bills - there is no
        // allowance to check it against, because there is nobody selling one.
        const decision = await this.#billing.spendGuardIn(tx, {
          userId: String(schedule.user_id),
          estimateUsd: numericOrNull(schedule.max_spend_usd) ?? 0,
          includeOpenCommitments: true,
          taskCapUsd: numericOrNull(schedule.max_spend_usd)
        });
        if (decision.outcome === 'deny') errorCode = 'spend_cap_reached';
      }

      const outcome: 'queued' | 'failed' = errorCode ? 'failed' : 'queued';
      const status = errorCode ? 'failed' : 'awaiting_resource';
      const eventKind = errorCode ? 'error' : 'task_created';
      const eventCiphertext = errorCode
        ? input.failureEventCiphertext
        : input.preparingEventCiphertext;
      const taskResult = await tx.query(
        // The run says where it came from in the same statement that creates it. Anything later -
        // a second UPDATE, a join through task_schedule_runs at read time - leaves a window where a
        // run exists without its provenance, and the sidebar reads tasks, not runs.
        `INSERT INTO tasks(
          id,user_id,workspace_id,title,status,model_id,privacy_route,max_compute_credits,
          prompt_ciphertext,security_mode,completed_at,max_spend_usd,schedule_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
           (SELECT security_mode FROM workspaces WHERE id=$3),
           CASE WHEN $5='failed' THEN NOW() ELSE NULL END,$10,$11) RETURNING *`,
        [
          input.taskId,
          schedule.user_id,
          schedule.workspace_id,
          JSON.stringify(json(schedule.title_ciphertext)),
          status,
          schedule.model_id,
          schedule.privacy_route,
          schedule.max_compute_credits,
          JSON.stringify(json(schedule.prompt_ciphertext)),
          numericOrNull(schedule.max_spend_usd),
          input.scheduleId
        ]
      );
      await tx.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext)
         VALUES ($1,$2,1,$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          input.taskId,
          eventKind,
          errorCode ? 'Encrypted schedule error event' : 'Encrypted scheduled task event',
          JSON.stringify(eventCiphertext)
        ]
      );
      if (!errorCode) {
        await tx.query(
          `INSERT INTO usage_entries(
            id,user_id,workspace_id,task_id,kind,resource_class,quantity,unit,credits,state,
            idempotency_key
           ) VALUES ($1,$2,$3,$4,'task_compute',$5,$6,'credits',$6,'reserved',$7)`,
          [
            randomUUID(),
            schedule.user_id,
            schedule.workspace_id,
            input.taskId,
            input.resourceClass,
            schedule.max_compute_credits,
            `task:${input.taskId}:reservation`
          ]
        );
      }
      await tx.query(
        `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome,error_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.scheduleId, schedule.next_run_at, input.taskId, outcome, errorCode]
      );
      /*
       * The streak moves in the same statement that records the run, so there is no window in which
       * the ledger and the counter disagree, and it is `RETURNING` rather than read back because a
       * second SELECT on a box running two schedulers reads whichever write landed last.
       *
       * `model_unavailable` is the only code that increments, matching the only code the dispatcher
       * escalates on: a workspace that is starting or being deleted is a state that ends, and
       * `spend_cap_reached` rolls over into the next window on its own. Every other outcome - a
       * queued run included - resets to zero, so the count is a streak ending at this run and not a
       * lifetime total.
       */
      const counted = await tx.query<{ consecutive_failures: number }>(
        `UPDATE task_schedules SET enabled=$3,next_run_at=$4,last_run_at=$5,last_task_id=$6,
         last_error_code=$7,consecutive_failures=CASE WHEN $7='model_unavailable'
           THEN consecutive_failures + 1 ELSE 0 END,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE id=$1 AND lease_owner=$2 RETURNING consecutive_failures`,
        [
          input.scheduleId,
          input.workerId,
          input.nextRunAt !== null,
          input.nextRunAt?.toISOString() ?? null,
          schedule.next_run_at,
          input.taskId,
          errorCode
        ]
      );
      return {
        task: mapTask(taskResult.rows[0]!),
        outcome,
        errorCode,
        consecutiveFailures: Number(counted.rows[0]?.consecutive_failures ?? 0)
      };
    });
    if (materialized) {
      if (materialized.task.status === 'queued') this.#signal(TASK_QUEUE_CHANNEL, input.taskId);
      this.#signal(TASK_EVENT_CHANNEL, input.taskId);
    }
    return materialized;
  }

  async failMaterializedTaskSchedule(
    scheduleId: string,
    taskId: string,
    errorCode: string
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE task_schedule_runs SET outcome='failed',error_code=$3
         WHERE schedule_id=$1 AND task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
      await tx.query(
        `UPDATE task_schedules SET last_error_code=$3,updated_at=NOW()
         WHERE id=$1 AND last_task_id=$2`,
        [scheduleId, taskId, errorCode]
      );
    });
  }
}
