import { randomUUID } from 'node:crypto';
import { AthanorError, decryptJson, unwrapDataKey } from '@athanor/core';
import type { EncryptedEnvelope } from '@athanor/core';
import { MAX_AGENT_NOTIFICATIONS_PER_TASK } from '@athanor/contracts';
import type { NotificationKind } from '@athanor/contracts';
import type { Database } from '../database.js';
import type {
  AgentNotificationRecord,
  PendingNotificationRecord,
  PushSubscriptionRecord
} from '../types.js';
import { iso, json, numericOrNull, optionalText } from './rows.js';

/**
 * How far back the notifier still looks for something to say, and how long the ledger row that
 * stops it saying it twice is kept. The second is comfortably longer than the first, so a delivery
 * record is only ever dropped once the thing it settled has fallen out of consideration entirely.
 *
 * The ledger window is exported because the sweep that applies it, `DataStore.cleanupExpired`, is
 * maintenance rather than notification and did not move here in Wave 6.3. Exporting it keeps the
 * pair under one comment, which is the whole point of the sentence above: separate them and the
 * relation between the two numbers stops being written down anywhere.
 */
const NOTIFICATION_CANDIDATE_INTERVAL = '14 days';
export const NOTIFICATION_LEDGER_INTERVAL = '30 days';

/**
 * How stopped the work is, as an ordering key. Written once and aliased, because the notifier states
 * this order twice - once to decide which rows are the page and once to hand the page back in that
 * order after the conversation names are joined on - and two copies of it would be two orders the
 * day somebody edited one.
 */
const notificationUrgency = (alias: string): string => `
         CASE ${alias}.kind
           WHEN 'approval_required' THEN 0
           WHEN 'takeover_needed' THEN 1
           WHEN 'spend_paused' THEN 2
           WHEN 'agent_message' THEN 3
           ELSE 4
         END`;

/**
 * The owner's notification preferences as they are stored: kinds by their wire names, and quiet
 * hours as minutes past local midnight. The zone those minutes are read in is the one on
 * `spend_limits` - there is one answer on this box to when the owner's day rolls over.
 */
export interface StoredNotificationSettings {
  kinds: Record<NotificationKind, boolean>;
  quietHours: { startMinute: number; endMinute: number } | null;
  quietHoursAllowApprovals: boolean;
}

/**
 * A conversation's own name, for a notification that would otherwise have to say "a task".
 *
 * Failure is expected rather than exceptional here: a workspace whose key is held elsewhere, an
 * older row, a title written under a different context. All of those mean "no title", never a
 * notification that does not get sent.
 */
const decryptTaskTitle = (row: Record<string, unknown>, masterKey: Uint8Array): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  if (!row.title_ciphertext || !wrappedKey || !workspaceId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.title_ciphertext);
    return decryptJson<{ title: string }>(envelope, key, `task-title:${workspaceId}`).title;
  } catch {
    return null;
  }
};

/**
 * The additional data an agent-raised notification is sealed with. Bound to the conversation, so a
 * message lifted onto another task's row will not decrypt rather than being read out under the
 * wrong name.
 */
export const agentNotificationAad = (taskId: string): string => `agent-notification:${taskId}`;

/**
 * The sentence the agent asked to have pushed, unsealed here for the same reason the title is:
 * this is the only layer holding both the envelope and the key that opens it.
 *
 * A message that will not decrypt comes back null, and the notifier words the push from the
 * conversation name alone - a notification the owner can still act on beats one that never arrives.
 */
const decryptAgentMessage = (
  row: Record<string, unknown>,
  masterKey: Uint8Array
): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  const taskId = optionalText(row.task_id);
  if (!row.message_ciphertext || !wrappedKey || !workspaceId || !taskId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.message_ciphertext);
    return decryptJson<{ message: string }>(envelope, key, agentNotificationAad(taskId)).message;
  } catch {
    return null;
  }
};

/**
 * What reaches the owner while they are not looking: the web-push subscriptions a device
 * registers, the notifications the agent raises against a conversation, the queue the notifier
 * drains, and the settings that decide whether any of it is sent at this hour.
 *
 * The two decrypt helpers above sit here rather than with the other row mappers because this is
 * the only layer holding both the sealed envelope and the key that opens it, and because both of
 * them fail soft on purpose - a notification the owner can still act on beats one that never
 * arrives.
 */
export class NotificationStore {
  constructor(private readonly database: Database) {}

  async upsertPushSubscription(input: {
    userId: string;
    sessionPublicId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<PushSubscriptionRecord> {
    const result = await this.database.query(
      `INSERT INTO push_subscriptions(id,user_id,session_public_id,endpoint,p256dh,auth)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(endpoint) DO UPDATE SET
         session_public_id=EXCLUDED.session_public_id,p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,updated_at=NOW()
       WHERE push_subscriptions.user_id=EXCLUDED.user_id
       RETURNING *`,
      [randomUUID(), input.userId, input.sessionPublicId, input.endpoint, input.p256dh, input.auth]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Push endpoint is already registered to another account');
    return {
      id: String(row.id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [userId, endpoint]
    );
    return result.rowCount === 1;
  }

  async deletePushSubscriptionById(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM push_subscriptions WHERE id=$1', [id]);
    return result.rowCount === 1;
  }

  /**
   * One notification the agent decided the owner should have.
   *
   * This is the only way a push exists because something chose to send it rather than because a
   * row changed status, and it is what makes a watcher possible: the run itself is silent, and the
   * message arrives on the mornings the page actually moved.
   *
   * The cap is per conversation and enforced inside the transaction, so a model that decides
   * everything is urgent runs out of notifications rather than out of the owner's patience. It
   * throws `agent_notification_limit`, which the caller turns into a tool error the agent can read
   * and keep working through - a refused notification is not a reason to abandon the task.
   */
  async createAgentNotification(input: {
    userId: string;
    taskId: string;
    kind: AgentNotificationRecord['kind'];
    messageCiphertext: EncryptedEnvelope;
  }): Promise<AgentNotificationRecord> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.query(
        `SELECT COUNT(*) AS count FROM agent_notifications
         WHERE task_id=$1 AND user_id=$2`,
        [input.taskId, input.userId]
      );
      if (Number(existing.rows[0]?.count ?? 0) >= MAX_AGENT_NOTIFICATIONS_PER_TASK)
        throw new AthanorError(
          'agent_notification_limit',
          `This conversation has already sent its ${MAX_AGENT_NOTIFICATIONS_PER_TASK} notifications`
        );
      const result = await tx.query(
        `INSERT INTO agent_notifications(id,user_id,task_id,kind,message_ciphertext)
         SELECT $1,$2,$3,$4,$5::jsonb FROM tasks WHERE id=$3 AND user_id=$2
         RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.taskId,
          input.kind,
          JSON.stringify(input.messageCiphertext)
        ]
      );
      const row = result.rows[0];
      if (!row) throw new AthanorError('task_not_found', 'Conversation not found', 404);
      return {
        id: String(row.id),
        userId: String(row.user_id),
        taskId: String(row.task_id),
        kind: String(row.kind) as AgentNotificationRecord['kind'],
        messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
        createdAt: iso(row.created_at)
      };
    });
  }

  /**
   * Everything the agent has told this owner, newest first, across every conversation.
   *
   * A push is a moment and a device: it fires once, on whatever was subscribed, and is gone. This
   * is the standing record of the same rows, for the owner who was asleep, whose phone was off, or
   * who wants to read a week of a watcher's findings in one place instead of one conversation at a
   * time. It deliberately ignores the delivery ledger - whether a device was reached says nothing
   * about whether the owner has seen it.
   */
  async listAgentNotifications(
    userId: string,
    limit = 50,
    masterKey?: Uint8Array
  ): Promise<
    Array<AgentNotificationRecord & { taskTitle: string | null; message: string | null }>
  > {
    const result = await this.database.query(
      `SELECT n.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM agent_notifications n
       JOIN tasks t ON t.id=n.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(Math.trunc(limit), 200))]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      kind: String(row.kind) as AgentNotificationRecord['kind'],
      messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
      createdAt: iso(row.created_at),
      taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
      message: masterKey ? decryptAgentMessage(row, masterKey) : null
    }));
  }

  /**
   * Everything waiting to be told to a device that has not been told it yet.
   *
   * `masterKey` is optional and buys two things: the conversation's own name, and the sentence an
   * agent-raised notification carries. Both are encrypted with a workspace key, and this is the
   * only layer holding both the envelope and the key to unwrap it - so a notification that can say
   * which conversation it is about is decrypted here rather than by the service that sends it,
   * which has neither. Either one failing to decrypt comes back null and the notification is
   * worded without it.
   */
  async listPendingNotifications(
    limit = 100,
    masterKey?: Uint8Array
  ): Promise<PendingNotificationRecord[]> {
    const result = await this.database.query(
      `WITH candidates AS (
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'approval_required'::text AS kind, a.id AS resource_id, a.task_id,
           NULL::text AS task_status, a.created_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN approvals a ON a.user_id=ps.user_id
          AND a.status='pending' AND a.expires_at>NOW() AND a.created_at>=ps.created_at
         UNION ALL
         -- A conversation the owner started and walked away from is worth a receipt. A scheduled
         -- run is not: it finishes on a timer whether or not anything happened, and pushing that
         -- turns a fifteen-minute watcher into ninety-six identical notifications a day. Those say
         -- nothing unless the agent raises one itself, below - except when the run failed, because
         -- a watcher that has silently stopped watching is exactly what the silence would hide.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'task_finished'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, COALESCE(t.completed_at,t.updated_at) AS event_at,
           NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN tasks t ON t.user_id=ps.user_id
          AND t.status IN ('completed','failed','cancelled')
          AND COALESCE(t.completed_at,t.updated_at)>=ps.created_at
          -- Asked of the conversation and not of the ledger of due slots. task_schedule_runs is
          -- pruned at the delivery ledger's horizon, so a NOT EXISTS over it says "the owner
          -- started this" about any run old enough to have lost its row. That never fired only
          -- because the candidate window is fourteen days and the prune is thirty - an accident of
          -- two constants rather than a property - and a run that parks after an ask, or at a spend
          -- cap, and is resumed five weeks later completes inside the window with its row already
          -- gone. tasks.schedule_id (migration 62) is on the row itself and cannot be pruned.
          AND (t.status='failed' OR t.schedule_id IS NULL)
         UNION ALL
         -- A task the box stopped at a ceiling, which is the one pause nobody chose and which
         -- waits forever if the owner is not told. An ordinary Pause has no spend_paused_at.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           'spend_paused'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, t.spend_paused_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM push_subscriptions ps
         JOIN tasks t ON t.user_id=ps.user_id
          AND t.status='paused' AND t.spend_paused_at IS NOT NULL
          AND t.spend_paused_at>=ps.created_at
         UNION ALL
         -- The two the agent raises: something it was asked to watch for, and a wall it cannot get
         -- past on its own. Both carry their own sentence, and both are already the agent's
         -- decision, so nothing here re-derives whether they are worth sending.
         SELECT ps.id AS subscription_id, ps.user_id, ps.endpoint, ps.p256dh, ps.auth,
           ps.created_at AS subscription_created_at, ps.updated_at AS subscription_updated_at,
           n.kind, n.id AS resource_id, n.task_id,
           NULL::text AS task_status, n.created_at AS event_at, n.message_ciphertext
         FROM push_subscriptions ps
         JOIN agent_notifications n ON n.user_id=ps.user_id AND n.created_at>=ps.created_at
       )
       -- The page is chosen before anything is decorated with the name of the conversation it is
       -- about. Both are one statement's worth of work either way, but not the same amount of it:
       -- joining tasks to the candidate set makes the planner build a hash over every conversation
       -- on the box to answer at most a hundred lookups. Measured on 20,000 conversations of which
       -- 406 were candidates, that hash was 10.6 ms of the statement's 13.1 and 770 of its 810
       -- buffers - on a read that runs every two seconds per subscribed device. Picking first turns
       -- it into a hundred primary-key probes.
       --
       -- The ordering is stated twice on purpose. The inner one decides which rows the page is; the
       -- outer one is what makes the page come back in that order, because a join is not obliged to
       -- preserve its input's.
       , picked AS (
         SELECT c.*
         FROM candidates c
         LEFT JOIN notification_deliveries d ON d.subscription_id=c.subscription_id
           AND d.kind=c.kind AND d.resource_id=c.resource_id
         -- A terminal task stays terminal, so without a horizon every finished conversation is a
         -- candidate forever and the ledger row that stops it firing twice can never be pruned.
         -- Past this age the event has stopped being news anyway.
         WHERE d.subscription_id IS NULL AND c.event_at > NOW() - $2::interval
         -- Ordered by how stopped the work is. An approval and a takeover are both the agent
         -- waiting on a person; a spend pause is the box refusing to spend more; the rest is news.
         -- The id is the final tiebreaker so a page is stable - without it two rows sharing a
         -- timestamp swap places between reads, which looks to a delivering process like a set it
         -- has not seen.
         ORDER BY c.event_at, ${notificationUrgency('c')}, c.resource_id
         LIMIT $1
       )
       SELECT p.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM picked p
       LEFT JOIN tasks t ON t.id=p.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       ORDER BY p.event_at, ${notificationUrgency('p')}, p.resource_id`,
      [limit, NOTIFICATION_CANDIDATE_INTERVAL]
    );
    return result.rows.map((row) => ({
      id: String(row.subscription_id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      createdAt: iso(row.subscription_created_at),
      updatedAt: iso(row.subscription_updated_at),
      kind: String(row.kind) as PendingNotificationRecord['kind'],
      resourceId: String(row.resource_id),
      taskId: String(row.task_id),
      taskStatus: optionalText(row.task_status),
      eventAt: iso(row.event_at),
      taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
      message: masterKey ? decryptAgentMessage(row, masterKey) : null
    }));
  }

  /** The kinds this owner still wants, and the window the box may not wake them in. */
  async notificationSettings(userId: string): Promise<StoredNotificationSettings | null> {
    const result = await this.database.query(
      'SELECT * FROM notification_settings WHERE user_id=$1',
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const startMinute = numericOrNull(row.quiet_start_minute);
    const endMinute = numericOrNull(row.quiet_end_minute);
    return {
      kinds: {
        approval_required: row.approval_required !== false,
        task_finished: row.task_finished !== false,
        spend_paused: row.spend_paused !== false,
        agent_message: row.agent_message !== false,
        takeover_needed: row.takeover_needed !== false
      },
      quietHours:
        startMinute === null || endMinute === null
          ? null
          : { startMinute: Math.trunc(startMinute), endMinute: Math.trunc(endMinute) },
      quietHoursAllowApprovals: row.quiet_allow_approvals !== false
    };
  }

  /** Upsert. A null window is how quiet hours are turned off; there is no separate flag. */
  async setNotificationSettings(
    userId: string,
    input: StoredNotificationSettings
  ): Promise<StoredNotificationSettings> {
    await this.database.query(
      `INSERT INTO notification_settings(
         user_id,approval_required,task_finished,spend_paused,agent_message,takeover_needed,
         quiet_start_minute,quiet_end_minute,quiet_allow_approvals,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT(user_id) DO UPDATE SET
         approval_required=EXCLUDED.approval_required,
         task_finished=EXCLUDED.task_finished,
         spend_paused=EXCLUDED.spend_paused,
         agent_message=EXCLUDED.agent_message,
         takeover_needed=EXCLUDED.takeover_needed,
         quiet_start_minute=EXCLUDED.quiet_start_minute,
         quiet_end_minute=EXCLUDED.quiet_end_minute,
         quiet_allow_approvals=EXCLUDED.quiet_allow_approvals,
         updated_at=NOW()`,
      [
        userId,
        input.kinds.approval_required,
        input.kinds.task_finished,
        input.kinds.spend_paused,
        input.kinds.agent_message,
        input.kinds.takeover_needed,
        input.quietHours?.startMinute ?? null,
        input.quietHours?.endMinute ?? null,
        input.quietHoursAllowApprovals
      ]
    );
    return (await this.notificationSettings(userId))!;
  }

  async recordNotificationDelivery(
    subscriptionId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO notification_deliveries(subscription_id,kind,resource_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [subscriptionId, kind, resourceId]
    );
  }
}
