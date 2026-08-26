/**
 * What a preview row says about itself, and why a port will not be accepted.
 *
 * A preview is the one thing on this box that can outlive the conversation that made it and can be
 * reached by people who have never seen athanor, so the row has to say what it currently is rather
 * than what it was when it was created.
 */
import { previewLifetime } from './timeline-state.js';
import type { WorkspacePreview } from './types.js';

/** The runner's own port. The server refuses more than this; it is the one the client can know. */
const RESERVED_RUNTIME_PORT = 4300;
const MIN_PORT = 1024;
const MAX_PORT = 65_535;

export const previewPortProblem = (port: number): string => {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT)
    return `A preview publishes a port between ${MIN_PORT} and ${MAX_PORT}.`;
  if (port === RESERVED_RUNTIME_PORT)
    return `Port ${RESERVED_RUNTIME_PORT} is the agent computer’s own runtime. Use the port your app listens on.`;
  return '';
};

/**
 * When a link was last opened, said as a fact rather than a timestamp.
 *
 * It is the field the expiry rule is driven by — every visit pushes the deadline out — so a row
 * that reports how long a preview has left and not whether anything is using it is reporting half
 * of one rule. "Never opened" is the useful answer for the other half: it is the row that can be
 * revoked without asking anyone.
 */
const previewUse = (lastAccessedAt: string | null, nowMs: number): string => {
  if (!lastAccessedAt) return 'never opened';
  const at = Date.parse(lastAccessedAt);
  if (Number.isNaN(at)) return 'never opened';
  const days = Math.floor((nowMs - at) / 86_400_000);
  if (days <= 0) return 'opened today';
  if (days === 1) return 'opened yesterday';
  return `opened ${days} days ago`;
};

/**
 * The line under a preview's name.
 *
 * It used to carry a hosting mode as well — "always on — this computer stays awake for it" — for a
 * stored choice that changed nothing: nothing here puts a computer to sleep on its own and nothing
 * holds one awake. There is one behaviour, so there is one line: what the link is, whether it still
 * works, which port it publishes, how long it has left and whether anybody is using it.
 *
 * The port is on it because a computer may hold up to a hundred of these and "App preview" is the
 * default name for every one of them: without the port two rows for two different services are the
 * same row, and revoking is a guess.
 */
export const previewSummary = (
  preview: Pick<
    WorkspacePreview,
    'visibility' | 'status' | 'expiresAt' | 'port' | 'lastAccessedAt'
  >,
  nowMs: number = Date.now()
): string => {
  const parts = [preview.visibility === 'public' ? 'Public link' : 'Private preview'];
  // "active" on every row is the stored enum printed where a sentence should be.
  if (preview.status !== 'active') parts.push(preview.status);
  parts.push(`port ${preview.port}`);
  parts.push(previewLifetime(preview.expiresAt));
  parts.push(previewUse(preview.lastAccessedAt, nowMs));
  return parts.join(' · ');
};
