import { decryptJson } from '@athanor/core';
import type { DataStore } from '@athanor/data';

export async function taskFailure(store: DataStore, taskId: string, key: Uint8Array) {
  const failure = await store.taskResourceFailure(taskId);
  if (!failure?.payloadCiphertext) return null;
  try {
    const decoded = decryptJson<{ summary?: unknown; payload?: { code?: unknown } }>(
      failure.payloadCiphertext,
      key,
      `task-event:${taskId}`
    );
    return typeof decoded.payload?.code === 'string' && typeof decoded.summary === 'string'
      ? { code: decoded.payload.code, summary: decoded.summary }
      : null;
  } catch {
    // An unreadable record cannot authorize a retry or supply a trustworthy explanation.
    return null;
  }
}
