import type { Workspace } from './types.js';

/**
 * What the agent computer's status is called, in one place.
 *
 * The sidebar mapped these to words an owner reads - "Ready", "Sleeping", "Needs attention" - and
 * Settings printed the raw column beside it, so the same computer was "Needs attention" in the
 * corner of the screen and "failed" in the panel the owner opened to find out why. `failed` is the
 * worst one to leak: it reads as a fault in athanor rather than as a box that needs starting.
 *
 * Deliberately not a status the server sends: these are the words for the owner, and the server's
 * vocabulary is the schema's. An unknown value falls back to itself with its underscores removed,
 * so a status added later reads as something rather than as nothing.
 */
export const workspaceStatusLabel = (status: Workspace['status']): string =>
  ({
    provisioning: 'Starting',
    running: 'Ready',
    hibernated: 'Sleeping',
    resizing: 'Resizing',
    failed: 'Needs attention',
    deleting: 'Deleting'
  })[status] ?? String(status).replace(/_/g, ' ');
