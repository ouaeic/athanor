/**
 * Every write that costs money or creates a record runs inside this.
 *
 * A phone on a train retries; the point is that the second attempt returns the first answer
 * rather than doing the work twice. The key is claimed before the operation runs and settled
 * after it, so a crash in between leaves the row `in_progress` and the retry is told to wait
 * rather than being served a half-finished result.
 */

import { AthanorError } from '@athanor/core';
import type { UserRecord } from '@athanor/data';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { idempotencyRequestHash } from '../context.js';
import type { ServerBase } from './server-context.js';

/** The wrapper a route puts round the work it does not want done twice. */
export type IdempotentOperation = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRecord,
  operation: () => Promise<T>
) => Promise<T>;

export const createIdempotentOperation = (context: ServerBase): IdempotentOperation => {
  const { store } = context;
  const idempotent = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRecord,
    operation: () => Promise<T>
  ): Promise<T> => {
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || !/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
      throw new AthanorError(
        'idempotency_key_required',
        'A valid Idempotency-Key header is required'
      );
    }
    const operationPath = request.routeOptions.url ?? request.url.split('?')[0]!;
    const requestHash = idempotencyRequestHash(request.method, request.url, request.body);
    const existing = await store.beginOperation({
      userId: user.id,
      idempotencyKey: key,
      method: request.method,
      path: operationPath,
      requestHash
    });
    if (existing) {
      if (
        existing.method !== request.method ||
        existing.path !== operationPath ||
        existing.requestHash !== requestHash
      ) {
        throw new AthanorError(
          'idempotency_conflict',
          'This key was already used for a different operation'
        );
      }
      if (existing.state === 'completed' && existing.responseStatus !== null) {
        reply.status(existing.responseStatus).header('idempotency-replayed', 'true');
        return existing.responseBody as T;
      }
      throw new AthanorError(
        'operation_in_progress',
        'The original request is still being reconciled'
      );
    }
    try {
      const result = await operation();
      await store.completeOperation(user.id, key, reply.statusCode, result);
      return result;
    } catch (error) {
      await store.failOperation(user.id, key);
      throw error;
    }
  };

  return idempotent;
};
