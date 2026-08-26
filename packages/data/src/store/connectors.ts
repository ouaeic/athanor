import { randomUUID } from 'node:crypto';
import { AthanorError } from '@athanor/core';
import type { EncryptedEnvelope } from '@athanor/core';
import type { Database } from '../database.js';
import type {
  ConnectorAuditRecord,
  ConnectorOAuthAttemptRecord,
  ConnectorRecord,
  ManagedProviderCredentialRecord
} from '../types.js';
import {
  iso,
  json,
  mapConnector,
  mapConnectorAudit,
  mapConnectorOAuthAttempt,
  optionalText
} from './rows.js';

/**
 * One page of approvals, and the same bargain: the newest are the ones an owner is looking at, and
 * the cursor reaches everything behind them.
 *
 * Smaller than a page of events because each row costs far more than a row: the route that reads
 * this issues two further queries, a key unwrap and a decrypt for every approval it is handed.
 */
export const MAX_APPROVAL_PAGE = 200;

/**
 * The same position-is-a-row trick for approvals, and it is needed here for the same reason and
 * then some: a single turn can raise several approvals inside one millisecond, so a cursor that
 * carried only a timestamp would skip every approval that shared the last one on the page.
 *
 * The timestamp travels as the database's own text rather than as a re-serialised `Date`, because
 * `toISOString()` rounds a `timestamptz` to milliseconds and the comparison would then land on the
 * wrong side of any row written in between.
 */
const encodeApprovalCursor = (row: Record<string, unknown>): string =>
  Buffer.from(`${String(row.cursor_at)}|${String(row.id)}`, 'utf8').toString('base64url');

const decodeApprovalCursor = (cursor: string): { createdAt: string; id: string } => {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [createdAt, id] = parts;
  const at = new Date(String(createdAt));
  if (parts.length !== 2 || Number.isNaN(at.getTime()) || !id)
    throw new AthanorError('invalid_cursor', 'That approval list position is not valid');
  return { createdAt: String(createdAt), id };
};

/**
 * The two things standing between the agent and something outside this box: an approval, which is
 * permission asked for one action before it happens, and a connector, which is permission already
 * granted for a whole class of them - its stored credential, the OAuth attempt that obtained it,
 * and the audit line every use of it writes.
 *
 * They are one domain rather than two neighbours: the audit trail is what makes a standing grant
 * answerable after the fact, in the same way an approval makes a single action answerable before
 * it.
 */
export class ConnectorStore {
  constructor(private readonly database: Database) {}

  async createApproval(input: {
    userId: string;
    taskId: string;
    action: string;
    origin?: string;
    sideEffect: string;
    previewCiphertext: EncryptedEnvelope;
    previewHash: string;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO approvals(id,user_id,task_id,action,origin,side_effect,preview_ciphertext,preview_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        id,
        input.userId,
        input.taskId,
        input.action,
        input.origin ?? null,
        input.sideEffect,
        JSON.stringify(input.previewCiphertext),
        input.previewHash,
        input.expiresAt.toISOString()
      ]
    );
    return id;
  }

  /**
   * One page of approvals, newest first.
   *
   * It reads a page rather than the table because nothing here is ever deleted: a box run in
   * Balanced mode answers approvals all day and keeps every answer, so `status='approved'` on a
   * months-old box was the whole history - and the route that asks for it spends two queries, a key
   * unwrap and a decrypt on each row it is handed, all fired at the pool at once.
   *
   * `cursor` is the `cursor` field of the last row of the previous page, so a position in this list
   * is a row and not a count: approvals raised by one turn share a timestamp, and a cursor made of
   * the timestamp alone would skip every one of them that tied with the last row shown.
   */
  async listApprovals(
    userId: string,
    status: string | null = 'pending',
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<Array<Record<string, unknown>>> {
    const limit = Math.max(
      1,
      Math.min(Math.trunc(options.limit ?? MAX_APPROVAL_PAGE), MAX_APPROVAL_PAGE)
    );
    const position = options.cursor ? decodeApprovalCursor(options.cursor) : null;
    const result = await this.database.query(
      // The ordering key is selected as the database's own text as well as ordered on, so the
      // cursor for the last row of this page is the exact value the next page compares against.
      `SELECT *, created_at::text AS cursor_at FROM approvals
       WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [userId, status, position?.createdAt ?? null, position?.id ?? null, limit]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      action: String(row.action),
      origin: optionalText(row.origin),
      sideEffect: String(row.side_effect),
      previewCiphertext: json<EncryptedEnvelope>(row.preview_ciphertext),
      previewHash: String(row.preview_hash),
      status: String(row.status),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      cursor: encodeApprovalCursor(row)
    }));
  }

  /**
   * Whether one conversation is stopped on an approval.
   *
   * The send path asks this before it moves a waiting task back into the queue, and answered it by
   * reading every pending approval the owner has and scanning them in JavaScript - one indexed
   * question, asked as a table read, on the hot path of every follow-up message.
   *
   * Deliberately blind to `expires_at`, which is what the read it replaces was: an approval past
   * its deadline that `cleanupExpired` has not swept yet is still `pending`, and it is still what
   * the conversation is waiting for. `resolveApproval` is the one that owes the deadline an answer.
   */
  async hasPendingApproval(userId: string, taskId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM approvals
       WHERE user_id = $1 AND task_id = $2 AND status = 'pending' LIMIT 1`,
      [userId, taskId]
    );
    return result.rows.length > 0;
  }

  async resolveApproval(
    userId: string,
    id: string,
    decision: 'approved' | 'denied'
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE approvals SET status = $3, resolved_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()`,
      [id, userId, decision]
    );
    return result.rowCount === 1;
  }

  async getApproval(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.query('SELECT * FROM approvals WHERE id = $1', [id]);
    const row = result.rows[0];
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          taskId: String(row.task_id),
          action: String(row.action),
          status: String(row.status),
          previewHash: String(row.preview_hash),
          expiresAt: iso(row.expires_at)
        }
      : null;
  }

  async getManagedProviderCredential(
    userId: string,
    provider: string
  ): Promise<ManagedProviderCredentialRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    const row = result.rows[0];
    return row
      ? {
          userId: String(row.user_id),
          provider: String(row.provider),
          secretCiphertext: json<EncryptedEnvelope>(row.secret_ciphertext),
          externalRef: String(row.external_ref),
          monthlyLimitUsd: Number(row.monthly_limit_usd),
          status: String(row.status) as ManagedProviderCredentialRecord['status'],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : null;
  }

  async upsertManagedProviderCredential(input: {
    userId: string;
    provider: string;
    secretCiphertext: EncryptedEnvelope;
    externalRef: string;
    monthlyLimitUsd: number;
    status?: ManagedProviderCredentialRecord['status'];
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO managed_provider_credentials(
         user_id,provider,secret_ciphertext,external_ref,monthly_limit_usd,status
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT(user_id,provider) DO UPDATE SET
         secret_ciphertext=EXCLUDED.secret_ciphertext,
         external_ref=EXCLUDED.external_ref,
         monthly_limit_usd=EXCLUDED.monthly_limit_usd,
         status=EXCLUDED.status,
         updated_at=NOW()`,
      [
        input.userId,
        input.provider,
        JSON.stringify(input.secretCiphertext),
        input.externalRef,
        input.monthlyLimitUsd,
        input.status ?? 'active'
      ]
    );
  }

  async deleteManagedProviderCredential(userId: string, provider: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM managed_provider_credentials WHERE user_id=$1 AND provider=$2',
      [userId, provider]
    );
    return result.rowCount === 1;
  }

  async createConnector(input: {
    id: string;
    userId: string;
    kind: ConnectorRecord['kind'];
    authMode: ConnectorRecord['authMode'];
    label: string;
    baseUrl: string;
    scopes: ConnectorRecord['scopes'];
    secretCiphertext: EncryptedEnvelope;
  }): Promise<ConnectorRecord> {
    const result = await this.database.query(
      `INSERT INTO connectors(id,user_id,kind,auth_mode,label,base_url,scopes,secret_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.kind,
        input.authMode,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        JSON.stringify(input.secretCiphertext)
      ]
    );
    return mapConnector(result.rows[0]!);
  }

  async listConnectors(userId: string): Promise<ConnectorRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE user_id=$1 ORDER BY enabled DESC, created_at DESC`,
      [userId]
    );
    return result.rows.map(mapConnector);
  }

  async getConnector(userId: string, id: string): Promise<ConnectorRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM connectors WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rows[0] ? mapConnector(result.rows[0]) : null;
  }

  async revokeConnector(userId: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET enabled=FALSE,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId]
    );
    return result.rowCount === 1;
  }

  async updateConnectorSecret(
    userId: string,
    id: string,
    secretCiphertext: EncryptedEnvelope
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE connectors SET secret_ciphertext=$3::jsonb,updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND enabled=TRUE`,
      [id, userId, JSON.stringify(secretCiphertext)]
    );
    return result.rowCount === 1;
  }

  async createConnectorOAuthAttempt(input: {
    id: string;
    userId: string;
    label: string;
    baseUrl: string;
    scopes: ConnectorOAuthAttemptRecord['scopes'];
    stateHash: string;
    secretCiphertext: EncryptedEnvelope;
    expiresAt: Date;
  }): Promise<ConnectorOAuthAttemptRecord> {
    const result = await this.database.query(
      `INSERT INTO connector_oauth_attempts(
         id,user_id,label,base_url,scopes,state_hash,secret_ciphertext,expires_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.label,
        input.baseUrl,
        JSON.stringify(input.scopes),
        input.stateHash,
        JSON.stringify(input.secretCiphertext),
        input.expiresAt.toISOString()
      ]
    );
    return mapConnectorOAuthAttempt(result.rows[0]!);
  }

  async consumeConnectorOAuthAttempt(
    stateHash: string
  ): Promise<ConnectorOAuthAttemptRecord | null> {
    const result = await this.database.query(
      `DELETE FROM connector_oauth_attempts
       WHERE state_hash=$1 AND expires_at>NOW()
       RETURNING *`,
      [stateHash]
    );
    return result.rows[0] ? mapConnectorOAuthAttempt(result.rows[0]) : null;
  }

  async recordConnectorAudit(input: {
    connectorId: string;
    userId: string;
    taskId?: string;
    operation: string;
    outcome: ConnectorAuditRecord['outcome'];
    statusCode?: number;
    requestBytes?: number;
    responseBytes?: number;
    durationMs?: number;
  }): Promise<ConnectorAuditRecord> {
    const result = await this.database.query(
      `WITH inserted AS (
         INSERT INTO connector_audit_events(
           id,connector_id,user_id,task_id,operation,outcome,status_code,
           request_bytes,response_bytes,duration_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *
       ), touched AS (
         UPDATE connectors SET last_used_at=NOW(),updated_at=NOW()
         WHERE id=$2 AND user_id=$3
       ) SELECT * FROM inserted`,
      [
        randomUUID(),
        input.connectorId,
        input.userId,
        input.taskId ?? null,
        input.operation,
        input.outcome,
        input.statusCode ?? null,
        input.requestBytes ?? 0,
        input.responseBytes ?? 0,
        input.durationMs ?? 0
      ]
    );
    return mapConnectorAudit(result.rows[0]!);
  }

  async listConnectorAudit(userId: string, limit = 100): Promise<ConnectorAuditRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM connector_audit_events WHERE user_id=$1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, Math.max(1, Math.min(500, limit))]
    );
    return result.rows.map(mapConnectorAudit);
  }
}
