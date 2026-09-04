import { describe, expect, it } from 'vitest';
import { securityModeCopy, securityModeNotice, securityModes } from './security-mode.js';
import { alwaysAsks, balancedVsAutonomous, modeFloors } from './asking-rules.js';

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
   * The approval floor the product promises, stated as six things rather than as a policy. The
   * count is asserted because the value of this list is that it is short and finishable: an owner
   * who reads it has read all of it, and a seventh line added without deciding to would quietly
   * turn it back into the page of prose it replaced.
   *
   * The count moves in both directions and the deciding is the point of asserting it. One line went
   * and came back within two waves: "Running a repository's own build" arrived with a
   * `code_diagnostics` branch above every `securityMode` test and left with it, because the same
   * recipes run through `shell` without asking - so the page was promising a floor a rephrasing
   * walked around, and it charged an owner for checking their own Rust. What replaced it is an undo
   * point rather than a question (`REPEATABLE_TOOLS_THAT_WRITE` in the worker's turn-bounds.ts),
   * and a list of what always asks is the wrong page to describe something that never does.
   */
  it('names the things no setting can switch off', () => {
    expect(alwaysAsks).toHaveLength(7);
    const named = alwaysAsks.map((rule) => rule.what.toLowerCase()).join(' ');
    expect(named).toContain('money');
    expect(named).toContain('password');
    expect(named).toContain('public internet');
    expect(named).toContain('overwriting data');
    expect(named).toContain('git remote');
    expect(named).not.toContain("repository's own build");
    /*
     * The two that arrived with the floor gaining a rule and the page catching up with one it had
     * had all along. Publishing a package was measured raising no card in balanced OR autonomous
     * while the third line above promised that putting something on the public internet always
     * stops - and `npm publish` is exactly that, at an address nobody can take it back from.
     * Leaving something behind to run later was never on this page at all, though the card has
     * fired in every mode since the deferred-execution rule landed.
     */
    expect(named).toContain('package anyone can install');
    expect(named).toContain('run later');
    /*
     * The details of those last two, held rather than only their headings, because the wave that
     * widened them widened the floor with them. Measured at 89185c6, in balanced AND autonomous:
     * `dropdb production`, `redis-cli FLUSHALL`, `docker volume rm`, `crontab /tmp/mycron` and
     * `systemctl --user enable` all raised no card, while this page said removing data and leaving
     * something behind always stop. Both rows were lists of FILES, and none of those five is one.
     */
    const detailed = alwaysAsks.map((rule) => rule.detail.toLowerCase()).join(' ');
    for (const act of ['database', 'redis', 'bucket', 'docker volume', 'crontab', 'systemctl'])
      expect(detailed, act).toContain(act);
  });

  /*
   * The three sentences, held against the floor that enforces them.
   *
   * `scripts/check-repository.mjs` compares these character for character with
   * `SECURITY_MODE_FLOOR` in `apps/worker/src/approval-policy.ts`, which is the record the floor's
   * own mode tests now read - so a mode whose behaviour changes and whose sentence here does not
   * fails the build. What is asserted here is the shape the page depends on and that check cannot
   * see: that every mode has a sentence, that they are layered rather than repeated, and that none
   * of them answers with an adjective.
   */
  it('says what each mode stops for, layered from the floor upward', () => {
    for (const mode of securityModes) expect(modeFloors[mode].length).toBeGreaterThan(60);
    expect(modeFloors.review).toContain('Balanced');
    expect(modeFloors.balanced).toContain('Autonomous');
    // The floor every mode shares names no mode below it, because there is nothing below it.
    expect(modeFloors.autonomous).not.toContain('Balanced');
    expect(modeFloors.autonomous).not.toContain('Review');
    // The words this question used to be answered with, one line above on the same screen, and the
    // whole reason for this table: "High-impact actions always need approval" is not a fact anybody
    // can act on.
    for (const mode of securityModes) expect(modeFloors[mode]).not.toContain('High-impact');
    // Balanced asks about a COMMAND reaching the internet. The built-in web tools read without a
    // card in every mode, so a sentence that dropped the word would promise a card the floor never
    // raises - which is the sentence an owner reads while choosing the mode.
    expect(modeFloors.balanced).toMatch(/\bcommand\b/i);
  });

  /*
   * Both tables are read straight into a list of rows, so an entry that fills only one half of the
   * row renders as a heading with a gap under it or as a sentence with no subject.
   */
  it('gives every rule both a name and its concrete cases', () => {
    // Both halves, counted before either is walked: a screen that explains a security mode with no
    // rules on it is the failure this checks for, and an empty table passes a loop silently.
    expect(alwaysAsks.length).toBeGreaterThan(0);
    expect(balancedVsAutonomous.length).toBeGreaterThan(0);
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
