import { describe, expect, it } from 'vitest';
import { describeAcceptanceCheck, parseAcceptanceChecks } from './acceptance.js';
import { agentTools } from './tools.js';

const parse = (check: Record<string, unknown>) => parseAcceptanceChecks([check]);

const artifact = {
  kind: 'artifact',
  label: 'The deck is twelve slides and none of them is cut off',
  path: 'workspace/board/deck.pptx',
  minBytes: 20_000
};

describe('an artifact check that is about the pages rather than the bytes', () => {
  it('keeps what the job asked for and defaults the margin to the page edge itself', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({
      kind: 'artifact',
      path: 'workspace/board/deck.pptx',
      minBytes: 20_000,
      render: { expectPages: 12, marginPoints: 0 }
    });
  });

  it('leaves a check that did not ask for a render exactly as it was', () => {
    const parsed = parse(artifact);
    // Named rather than inferred from a matcher: a size check that quietly grew a render clause
    // would be a measurement the model never declared and the owner was never shown.
    expect(parsed.ok && 'render' in parsed.checks[0]!).toBe(false);
  });

  it('refuses a render clause on a file that has no rendered page', () => {
    for (const path of ['workspace/notes.md', 'workspace/report', 'workspace/data.csv']) {
      const parsed = parse({ ...artifact, path, render: {} });
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('has no rendered page');
    }
  });

  it('accepts a clause that names nothing, because it still says the pages are intact', () => {
    const parsed = parse({ ...artifact, path: 'workspace/cv.pdf', render: {} });
    expect(parsed.ok && parsed.checks[0]).toMatchObject({ render: { marginPoints: 0 } });
  });

  it('refuses a page count that is not a number of pages', () => {
    for (const expectPages of [0, -3, 1.5, 'one']) {
      const parsed = parse({ ...artifact, render: { expectPages } });
      expect(!parsed.ok && parsed.reason).toContain('whole number of pages');
    }
  });

  /**
   * The half that decides whether any of the above is reachable at all.
   *
   * `set_acceptance` declares `additionalProperties: false`, so a clause this file parses but the
   * catalogue does not offer is a measurement no model can ask for - the whole thing inert, with
   * the parser and the description reading exactly as though it worked. Held against the schema
   * the model is actually sent, and against the fields the parser actually reads.
   */
  it('is a clause the model is offered, not only one this file can read', () => {
    const declared = agentTools.find((tool) => tool.name === 'set_acceptance');
    const properties = (
      declared?.parameters as {
        properties: { checks: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.checks.items.properties;
    expect(Object.keys(properties)).toContain('render');
    expect(Object.keys((properties.render as { properties: object }).properties)).toEqual([
      'expectPages',
      'marginPoints'
    ]);
  });
});

describe('what the owner is shown before the work starts', () => {
  it('says what will be measured, in pages and words rather than in tools', () => {
    const parsed = parse({ ...artifact, render: { expectPages: 12 } });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The deck is twelve slides and none of them is cut off): workspace/board/deck.pptx exists and is at least 20000 bytes, and renders as exactly 12 pages with no text cut off at a page edge and no page blank'
    );
  });

  it('names the margin when the job was given one', () => {
    const parsed = parse({
      ...artifact,
      path: 'workspace/cv.pdf',
      render: { expectPages: 1, marginPoints: 36 }
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toContain(
      'renders as exactly 1 page with every word inside a 36pt margin and no page blank'
    );
  });

  it('describes a plain size check the way it always did', () => {
    const parsed = parse({
      kind: 'artifact',
      label: 'The report exists',
      path: 'workspace/out.txt'
    });
    expect(parsed.ok && describeAcceptanceCheck(parsed.checks[0]!)).toBe(
      'check-1 (The report exists): workspace/out.txt exists and is at least 1 bytes'
    );
  });
});

/*
 * The red baseline is the only thing that ever falsifies a check, and it runs only `if
 * (!state.mutated)` while the hold that asks for a record at all fires on `mutatedBeyondProse`. So
 * the ordinary coding turn declares its record after the change and nothing runs against it. Every
 * case below goes through `parseAcceptanceChecks`, which is what `declareAcceptance` calls on both
 * paths, so what is pinned is the refusal the model actually meets rather than the predicate.
 */
describe('a check no state of the workspace can fail', () => {
  const command = { kind: 'command', label: 'the build is green' };

  it('refuses a command whose answer its own arguments already decide', () => {
    for (const [executable, args] of [
      ['echo', ['all tests pass']],
      ['echo', []],
      ['true', []],
      ['printf', ['ok\n']],
      // The wrapper comes off first, so a duration in front of it does not buy the check anything.
      ['timeout', ['30', 'echo', 'ok']],
      // And so does the interpreter, which is the spelling the shell tool tells the model to write.
      ['bash', ['-lc', 'echo BUILD OK']],
      ['sh', ['-c', 'true']],
      ['bash', ['-lc', 'echo one; echo two']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  /*
   * Both spellings of the same command, because for a while only one of them was refused.
   *
   * `effectiveCommands` returns the head as written; `acceptanceCommandRefusal`, the refusal this
   * one is chained to, lowers its binary before the set lookup. So `ECHO ok` was accepted and
   * `echo ok` refused - never a false pass on a Linux workspace, where `ECHO` is not on PATH and the
   * check would exit 127, but two adjacent guards reading the same token two ways. Held on the
   * wrapped spelling too, because that is the one the shell catalogue tells the model to write.
   */
  it('reads the command name the same way its sibling refusal does, in either case', () => {
    for (const [executable, args] of [
      ['ECHO', ['ok']],
      ['Echo', ['ok']],
      ['bash', ['-lc', 'ECHO ok']],
      ['bash', ['-lc', 'TRUE']],
      ['/bin/ECHO', ['ok']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  /*
   * The case the refusal used to get wrong, and the two quoted spellings it must still get right.
   *
   * `echo workspace/out/*.png` prints the file names when the thumbnails are there and the literal
   * pattern when they are not: the shell read the workspace before echo ran, so the check can fail
   * and can pass, and refusing it told the model something untrue about why. The wordier equivalent
   * `for f in workspace/*.jpg; do echo "$f"; done` is pinned as accepted in the row below, so the
   * two were the same check in two spellings.
   *
   * Two things keep this from being a blanket hole, and both are pinned below. Quoting: the tokens
   * keep their quotes, so a `*` inside them is text and the check is still refused. And a shell:
   * the runner spawns a check with `shell: false`, so the bare declaration
   * `{executable: 'echo', args: ['workspace/*.jpg']}` prints the pattern back unchanged on every
   * computer there is and is refused, while the same characters after `bash -lc` are not.
   */
  it('leaves a glob alone when a shell is there to expand it, and not otherwise', () => {
    for (const [executable, args] of [
      ['bash', ['-lc', 'echo workspace/out/*.png']],
      ['bash', ['-lc', 'printf "%s\\n" workspace/out/*.png']],
      ['bash', ['-lc', 'echo workspace/report-?.pdf']],
      ['bash', ['-lc', 'echo workspace/[abc].txt']],
      // The wrapper does not take the shell away, so neither does it take this away.
      ['timeout', ['30', 'bash', '-lc', 'echo workspace/out/*.png']]
    ] as Array<[string, string[]]>)
      expect(parse({ ...command, executable, args }).ok, `${executable} ${args.join(' ')}`).toBe(
        true
      );

    for (const [executable, args] of [
      // Quoted, so the shell that is there has nothing to expand.
      ['bash', ['-lc', "echo 'ok*'"]],
      ['bash', ['-lc', 'echo "ok*"']],
      ['bash', ['-lc', "printf '%s' 'thumb-*.png'"]],
      // Unquoted, and no shell: `execFile`-shaped, so the argument reaches echo as it was written.
      ['echo', ['workspace/*.jpg']],
      ['echo', ['*']],
      ['printf', ['%s\\n', 'workspace/out/*.png']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(false);
      expect(!parsed.ok && parsed.reason).toContain('answers the same way whatever is in the');
    }
  });

  it('refuses it whatever the check claims to expect, because the claim is in the command', () => {
    const parsed = parse({
      ...command,
      executable: 'bash',
      args: ['-lc', 'echo PASSED'],
      expectStdoutContains: 'PASSED'
    });
    expect(parsed.ok).toBe(false);
  });

  /*
   * The arm that matters. An acceptance gate that refuses honest work is an outage, and the shape
   * that reads most like the one above is honest: `test` decides the answer and the echo only
   * reports it. Every row here is a check a real turn declares - including
   * `bash workspace/rename-scans.sh`, which is `files-helper-script-then-run` in `evals/fixtures.ts`
   * and which the house prices as "the shape half the owner's work takes".
   */
  it('leaves every check the workspace decides exactly as it was', () => {
    for (const [executable, args] of [
      ['pytest', ['-q', 'test_retry.py']],
      ['pnpm', ['build']],
      ['bash', ['-lc', 'test -f workspace/out.pdf && echo ok']],
      ['bash', ['-lc', 'pnpm build && echo done']],
      ['bash', ['workspace/rename-scans.sh']],
      ['python', ['workspace/compute.py']],
      ['grep', ['-c', 'PASS', 'workspace/results.txt']],
      ['bash', ['-lc', 'for f in workspace/*.jpg; do echo "$f"; done']],
      ['node', ['--test']],
      ['ls', ['workspace']]
    ] as Array<[string, string[]]>) {
      const parsed = parse({ ...command, executable, args });
      expect(parsed.ok, `${executable} ${args.join(' ')}`).toBe(true);
      expect(parsed.ok && parsed.checks[0]).toMatchObject({ kind: 'command', executable, args });
    }
  });

  it('says plainly that the interpreted spellings are not caught, so nobody reads more into it', () => {
    // Not a wish: `effectiveCommands` reads the shell, and a print statement in another language is
    // a word-shaped token to it. Pinned so the day someone teaches it Python this row fails and the
    // comment above `acceptanceVacuousRefusal` is corrected rather than left lying.
    expect(parse({ ...command, executable: 'python', args: ['-c', "print('ok')"] }).ok).toBe(true);
    expect(parse({ ...command, executable: 'node', args: ['-e', "console.log('ok')"] }).ok).toBe(
      true
    );
  });

  /*
   * A regression pin on the older refusal, and deliberately NOT a proof about the order of the two.
   *
   * This row was once claimed as evidence that the destructive refusal is asked first. No input can
   * show that: `REFUSED_EXECUTABLES` and `CONSTANT_EXECUTABLES` share no member, so no command
   * exists for which both could fire and swapping the two operands changes nothing observable.
   * Measured, not reasoned: with the vacuity refusal unwired entirely, `rm -rf workspace` was still
   * refused with 'changes this computer' and this row stayed green - which is the definition of a
   * row that is not testing the join. What it does pin is worth keeping: adding a second refusal in
   * front of the first did not swallow it, and the reason the model reads still names the worse
   * fact rather than the emptier one.
   */
  it('still names the destructive fact, so the newer refusal did not swallow the older one', () => {
    const parsed = parse({ ...command, executable: 'bash', args: ['-lc', 'rm -rf workspace'] });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('changes this computer');
  });
});
