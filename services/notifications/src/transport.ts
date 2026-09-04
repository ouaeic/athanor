import type { PendingRow } from './context.js';
import type { NotificationSubject, OwnerNotificationSettings } from './model.js';

/**
 * What one delivery hands back. A push has nothing to say; a message on a phone has an id the far
 * side gave it, which is what a later edit that clears its buttons is addressed to, and a card
 * with buttons carries a nonce the ledger must hold to check a tap against.
 */
export interface Delivered {
  externalRef?: string;
  nonce?: string;
}

/**
 * One way a notification can travel. The sweep decides whether to send; a transport decides how,
 * and is chosen by the row's own `transport` field. `settings` is there for a transport that has
 * a reason to read the owner's preferences beyond the send decision; neither of the two does today.
 */
export interface Transport {
  kind: PendingRow['transport'];
  send(
    row: PendingRow,
    subject: NotificationSubject,
    settings: OwnerNotificationSettings
  ): Promise<Delivered>;
}

export type Transports = Partial<Record<PendingRow['transport'], Transport>>;

/**
 * A refusal from the far end, in the three terms the retry policy reads: the status it answered
 * with, a wait it named itself, and whether it said the target no longer exists at all.
 */
export class TransportError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs: number | undefined;
  readonly gone: boolean;

  constructor(
    message: string,
    options: { statusCode?: number; retryAfterMs?: number; gone?: boolean } = {}
  ) {
    super(message);
    this.name = 'TransportError';
    this.statusCode = options.statusCode ?? 0;
    this.retryAfterMs = options.retryAfterMs;
    this.gone = options.gone ?? false;
  }
}

/**
 * The same three terms read off whatever was thrown. The push library throws its own error class
 * with a `statusCode` on it and nothing else, so that shape is read as well as this file's own.
 */
export const transportFailure = (
  error: unknown
): { statusCode: number; retryAfterMs: number | undefined; gone: boolean } => {
  if (error instanceof TransportError)
    return { statusCode: error.statusCode, retryAfterMs: error.retryAfterMs, gone: error.gone };
  const statusCode =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode) || 0
      : 0;
  return { statusCode, retryAfterMs: undefined, gone: false };
};
