import { describe, expect, it } from 'vitest';
import { securityModeCopy, securityModeNotice, securityModes } from './security-mode.js';
import { alwaysAsks, balancedVsAutonomous } from './asking-rules.js';

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
});

describe('what asks whatever the mode says', () => {
  /*
   * The approval floor the product promises, stated as five things rather than as a policy. The
   * count is asserted because the value of this list is that it is short and finishable: an owner
   * who reads it has read all of it, and a sixth line added without deciding to would quietly turn
   * it back into the page of prose it replaced.
   */
  it('names the five things no setting can switch off', () => {
    expect(alwaysAsks).toHaveLength(5);
    const named = alwaysAsks.map((rule) => rule.what.toLowerCase()).join(' ');
    expect(named).toContain('money');
    expect(named).toContain('password');
    expect(named).toContain('public internet');
    expect(named).toContain('overwriting data');
    expect(named).toContain('git remote');
  });

  /*
   * Both tables are read straight into a list of rows, so an entry that fills only one half of the
   * row renders as a heading with a gap under it or as a sentence with no subject.
   */
  it('gives every rule both a name and its concrete cases', () => {
    for (const rule of [...alwaysAsks, ...balancedVsAutonomous]) {
      expect(rule.what.length).toBeGreaterThan(0);
      expect(rule.detail.length).toBeGreaterThan(20);
    }
  });

  /*
   * The point of this second table is that it is answerable. Every entry has to say what each of
   * the two modes does, because a difference described only from one side is the adjective again.
   */
  it('says what both modes do wherever they differ', () => {
    expect(balancedVsAutonomous.length).toBeGreaterThan(0);
    for (const rule of balancedVsAutonomous) {
      expect(rule.detail).toContain('Balanced');
      expect(rule.detail).toContain('Autonomous');
    }
  });
});
