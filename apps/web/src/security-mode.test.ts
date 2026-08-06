import { describe, expect, it } from 'vitest';
import {
  loosensSecurity,
  securityModeCopy,
  securityModeNotice,
  securityModes
} from './security-mode.js';

describe('how the agent is told to ask', () => {
  it('covers every mode the control can be set to, in the order it offers them', () => {
    expect(securityModes).toEqual(['review', 'balanced', 'autonomous']);
    for (const mode of securityModes)
      expect(securityModeCopy[mode].description.length).toBeGreaterThan(0);
  });

  /* "Review" is the stored name, not something anyone would say about how they want to be asked. */
  it('labels the strictest mode by what it does rather than by its stored name', () => {
    expect(securityModeCopy.review.label).toBe('Ask first');
  });

  /*
   * The control offered "Ask first" and the confirmation it produced read "Security mode changed to
   * review". Same words in both places is the whole reason this table exists.
   */
  it('confirms a change in the words of the control that made it', () => {
    expect(securityModeNotice('review', 'task')).toBe('Now asking before every change.');
    expect(securityModeNotice('autonomous', 'task')).toBe(
      'Now working independently on reversible steps.'
    );
    for (const mode of securityModes) expect(securityModeNotice(mode, 'task')).not.toContain(mode);
  });

  it('speaks about the future when there is no conversation to change', () => {
    expect(securityModeNotice('balanced', 'workspace')).toBe(
      'New conversations on this computer will work normally.'
    );
    expect(securityModeNotice('review', 'workspace')).toBe(
      'New conversations on this computer will ask before every change.'
    );
  });

  /** Loosening asks for the passkey again; tightening never does. */
  it('knows which direction needs the owner to prove who they are', () => {
    expect(loosensSecurity('review', 'autonomous')).toBe(true);
    expect(loosensSecurity('balanced', 'autonomous')).toBe(true);
    expect(loosensSecurity('review', 'balanced')).toBe(true);
    expect(loosensSecurity('autonomous', 'review')).toBe(false);
    expect(loosensSecurity('balanced', 'review')).toBe(false);
    expect(loosensSecurity('balanced', 'balanced')).toBe(false);
  });
});
