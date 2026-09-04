import type {
  CreateShareRequest,
  CreateShareResponse,
  ShareRecord,
  ShareSnapshot
} from '@athanor/contracts';
import { request } from './api.js';

/**
 * The owner's side of share links. Kept out of `api.ts` because every method here is reached from
 * one lazily loaded dialog, and the eager client should not carry a surface nothing on the first
 * screen calls.
 */
const write = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'idempotency-key': crypto.randomUUID() }
});

export const shareApi = {
  /** The exact document a link would carry, in the clear, before any link exists. */
  preview: (taskId: string, body: CreateShareRequest) =>
    request<ShareSnapshot>(`/v1/tasks/${encodeURIComponent(taskId)}/shares/preview`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  create: (taskId: string, body: CreateShareRequest) =>
    request<CreateShareResponse>(
      `/v1/tasks/${encodeURIComponent(taskId)}/shares`,
      write('POST', body)
    ),
  list: (taskId: string) =>
    request<ShareRecord[]>(`/v1/tasks/${encodeURIComponent(taskId)}/shares`),
  revoke: (shareId: string) =>
    request<{ revoked: boolean }>(`/v1/shares/${encodeURIComponent(shareId)}`, write('DELETE', {})),
  revokeAll: (taskId: string) =>
    request<{ revoked: number }>(
      `/v1/tasks/${encodeURIComponent(taskId)}/shares`,
      write('DELETE', {})
    ),
  refresh: (shareId: string, body: CreateShareRequest) =>
    request<CreateShareResponse>(
      `/v1/shares/${encodeURIComponent(shareId)}/refresh`,
      write('POST', body)
    )
};

/** A link is live when the owner has not closed it and its expiry, if any, is ahead. */
export const isLiveShare = (share: ShareRecord, now = Date.now()): boolean =>
  share.revokedAt === null && (share.expiresAt === null || Date.parse(share.expiresAt) > now);

/** The link as the owner is handed it: this box's origin in front of the path and fragment. */
export const absoluteShareUrl = (url: string, origin = window.location.origin): string =>
  `${origin}${url}`;
