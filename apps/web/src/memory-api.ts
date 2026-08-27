/**
 * The one route only the memory review screen calls.
 *
 * Not in `api.ts`, for the reason `inspector-api.ts` gives at length and which holds here word for
 * word: `api.ts` is imported by `App.tsx` and so is downloaded before the first screen is painted,
 * whether or not the owner ever opens Settings. This is reached only from `MemoryReview.tsx`, which
 * rides in the lazily-loaded settings chunk, so it costs the eager graph nothing. The failure shape
 * is `ApiFailure` either way, because `describeFailure` is what reads it and `memoryReviewFailure`
 * pulls the request id off it.
 */
import { ApiFailure } from './api-failure.js';
import type { MemoryItemBody } from '@athanor/contracts';

/** The same deadline `api.ts` puts on everything, for the same reason: a stalled fetch is a hang. */
const REQUEST_TIMEOUT_MS = 45_000;

const read = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'include',
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    throw new ApiFailure(
      failure.error?.code ?? 'request_failed',
      failure.error?.message ?? `Request failed (${response.status})`,
      response.status,
      failure.error?.requestId
    );
  }
  return (await response.json()) as T;
};

/**
 * The whole of one remembered row, fetched when the owner opens it and not before.
 *
 * Deliberately one row at a time. The queue can carry fifty, the bodies are arbitrarily long, and
 * the screen shows two lines of each until something is opened — pulling all fifty down to answer a
 * question about one of them would be paid for on every visit to a screen most of whose rows are
 * never expanded.
 */
export const memoryItemBody = (
  workspaceId: string,
  itemId: string,
  signal?: AbortSignal
): Promise<MemoryItemBody> =>
  read<MemoryItemBody>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/memory-items/${encodeURIComponent(itemId)}`,
    signal
  );
