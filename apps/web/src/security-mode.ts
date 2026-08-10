/**
 * The three ways athanor can be told to ask, said the same way everywhere.
 *
 * There were four descriptions of these modes in two files — the option labels in the composer, a
 * tooltip table, a confirmation table, a future-tense table, and a paragraph in Settings — and they
 * had already drifted apart: the control offered "Ask first" and the confirmation it produced said
 * "Security mode changed to review". One table, read by every one of those places.
 */
import type { SecurityMode } from './types.js';

export const securityModes: SecurityMode[] = ['review', 'balanced', 'autonomous'];

interface SecurityModeCopy {
  /** The word on the control. Never the stored enum. */
  label: string;
  /** What it does, for the tooltip and for Settings. */
  description: string;
  /** What just changed, in the past tense, for the conversation it was changed on. */
  confirmation: string;
  /** What will change, for a computer where it governs conversations not yet started. */
  future: string;
}

export const securityModeCopy: Record<SecurityMode, SecurityModeCopy> = {
  review: {
    label: 'Ask first',
    description:
      'Asks before changing files, apps, or settings. High-impact actions always need approval.',
    confirmation: 'Now asking before every change.',
    future: 'ask before every change'
  },
  balanced: {
    label: 'Balanced',
    description:
      'Recommended. Works normally and asks before actions that could have wider effects.',
    confirmation: 'Now working normally.',
    future: 'work normally'
  },
  autonomous: {
    label: 'Autonomous',
    description:
      'Works independently on reversible steps. High-impact actions still need approval.',
    confirmation: 'Now working independently on reversible steps.',
    future: 'work independently on reversible steps'
  }
};

/**
 * What to say once the change has landed: a conversation carries its own mode, while changing it
 * with none open sets the default the next conversation on this computer will start under.
 */
export const securityModeNotice = (mode: SecurityMode, scope: 'task' | 'workspace'): string =>
  scope === 'task'
    ? securityModeCopy[mode].confirmation
    : `New conversations on this computer will ${securityModeCopy[mode].future}.`;
