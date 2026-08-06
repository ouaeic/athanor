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
 * The line under a preview's name.
 *
 * It used to carry a hosting mode as well — "always on — this computer stays awake for it" — for a
 * stored choice that changed nothing: nothing here puts a computer to sleep on its own and nothing
 * holds one awake. There is one behaviour, so there is one line: what the link is, whether it still
 * works, and how long it has left.
 */
export const previewSummary = (
  preview: Pick<
    WorkspacePreview,
    'visibility' | 'status' | 'expiresAt' | 'customDomain' | 'domainStatus'
  >
): string => {
  const parts = [preview.visibility === 'public' ? 'Public link' : 'Private preview'];
  // "active" on every row is the stored enum printed where a sentence should be.
  if (preview.status !== 'active') parts.push(preview.status);
  parts.push(previewLifetime(preview.expiresAt));
  if (preview.customDomain)
    parts.push(`${preview.customDomain} (${preview.domainStatus ?? 'pending'})`);
  return parts.join(' · ');
};
