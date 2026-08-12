import type { FireState } from './fire.js';
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

/**
 * The same corner of the screen, told what the fire is doing.
 *
 * `workspaceStatusLabel` describes the computer, and the computer is "running" throughout a turn -
 * so the sidebar said **Ready** while an answer was being written and while something was waiting
 * to be approved. Both were lies of the useful kind: the owner reads that word to decide whether to
 * go and do something else.
 *
 * It is also what makes the mark legible without seeing it. Every fire state now has a word beside
 * it, so nothing in this instrument is carried by colour, motion or shape alone. The two states
 * with nothing to say fall through to the computer's own label, which is what they are about.
 */
export const hearthLabel = (state: FireState, status: Workspace['status']): string =>
  state === 'calling'
    ? 'Your move'
    : state === 'drawing'
      ? 'Working'
      : workspaceStatusLabel(status);
