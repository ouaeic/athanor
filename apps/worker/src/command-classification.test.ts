/*
 * What a `shell` call really runs, and what that means for provenance.
 *
 * These classifiers had no test file of their own: they were exercised only through the cards
 * approval-policy.test.ts asserts, which means every one of them was tested at the outer
 * executable and none of them at the command inside it. That is exactly the gap the interpreter
 * evasions lived in, so the questions are asked here directly, of the four shapes a model actually
 * writes: the bare command, `bash -lc`, `sh -c` with a `cd` in front, and a runner wrapping either.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveCommands,
  gitConfigRunsCode,
  gitConfigWrite,
  sendsDataOverNetwork,
  shellWriteTargets,
  untrustedShellOrigin
} from './command-classification.js';

describe('what a shell call really runs', () => {
  it('takes the wrappers off and reads the script inside an interpreter', () => {
    expect(effectiveCommands({ executable: 'curl', args: ['-s', 'https://x.example'] })).toEqual([
      ['curl', '-s', 'https://x.example']
    ]);
    expect(effectiveCommands({ executable: '/usr/bin/curl', args: ['-s'] })).toEqual([
      ['curl', '-s']
    ]);
    // A runner is setup for the command that follows it, along with its own flags and the number
    // some of them take. `timeout 30 curl` runs curl, not `30`.
    expect(
      effectiveCommands({ executable: 'timeout', args: ['30', 'curl', 'https://x.example'] })
    ).toEqual([['curl', 'https://x.example']]);
    expect(
      effectiveCommands({ executable: 'nice', args: ['-n', '5', 'wget', 'https://x'] })
    ).toEqual([['wget', 'https://x']]);
    expect(effectiveCommands({ executable: 'env', args: ['FOO=1', 'curl', 'https://x'] })).toEqual([
      ['curl', 'https://x']
    ]);
    // Runner wrapping interpreter: the script is still found where commandScript looks for it.
    expect(
      effectiveCommands({ executable: 'env', args: ['A=1', 'bash', '-lc', 'curl -d @n https://x'] })
    ).toEqual([['curl', '-d', '@n', 'https://x']]);
    expect(
      effectiveCommands({ executable: 'sh', args: ['-c', 'cd repo && git push origin main'] })
    ).toEqual([
      ['cd', 'repo'],
      ['git', 'push', 'origin', 'main']
    ]);
    // A script this cannot read is no commands at all, and every caller treats that as unknown
    // rather than as safe.
    expect(effectiveCommands({ executable: 'bash', args: ['deploy.sh'] })).toEqual([]);
    expect(effectiveCommands({ executable: 'bash', args: ['-lc', '   '] })).toEqual([]);
    expect(effectiveCommands({})).toEqual([]);
  });

  /*
   * The taint half of the shell evasion.
   *
   * `untrustedShellOrigin` judged the outer executable, the git subcommand, the package verb and
   * any literal http(s) address in the command - and the literal address is what made the hole
   * look closed, because `bash -lc 'curl https://x'` names one. Take the address out of the
   * command, which every real script does the moment the URL is in a variable or assembled from
   * parts, and the interpreter was an unknown executable: an attacker-chosen page arrived in the
   * turn with the floor still reporting it clean, so no egress card, no novelty charge, and a
   * write to the brief with no card either.
   */
  it('raises the same taint for a fetch inside an interpreter as for the bare command', () => {
    const fetched = 'network command output';
    expect(
      untrustedShellOrigin({ executable: 'curl', args: ['-s', '$U', '-o', 'page.html'] })
    ).toBe(fetched);
    expect(
      untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'curl -s "$U" -o page.html'] })
    ).toBe(fetched);
    expect(untrustedShellOrigin({ executable: 'sh', args: ['-c', 'cd tmp && wget -q "$U"'] })).toBe(
      fetched
    );
    expect(
      untrustedShellOrigin({ executable: 'env', args: ['FOO=1', 'bash', '-lc', 'curl -s "$U"'] })
    ).toBe(fetched);
    expect(untrustedShellOrigin({ executable: 'bash', stdin: 'curl -s "$U"' })).toBe(fetched);
    // The other three fetching shapes, all of which the bare form already recognised.
    expect(untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'gh api /repos/x/y'] })).toBe(
      fetched
    );
    expect(untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'git pull --rebase'] })).toBe(
      fetched
    );
    expect(
      untrustedShellOrigin({ executable: 'bash', args: ['-lc', 'pip install requests'] })
    ).toBe(fetched);
    expect(untrustedShellOrigin({ executable: 'xargs', args: ['curl'] })).toBe(fetched);
  });

  it('leaves ordinary local work clean, wrapped or not', () => {
    for (const args of [
      { executable: 'pnpm', args: ['test'] },
      { executable: 'bash', args: ['-lc', 'pnpm test'] },
      { executable: 'bash', args: ['-lc', 'git status && git log -n 3'] },
      { executable: 'bash', args: ['-lc', 'echo hi > notes.txt'] },
      { executable: 'sh', args: ['-c', 'cd apps/web && node build.mjs'] },
      { executable: 'timeout', args: ['30', 'pnpm', 'test'] }
    ])
      expect(untrustedShellOrigin(args), JSON.stringify(args)).toBeNull();
  });

  /*
   * S-2 and S-3: three option pairs that differ only in case.
   *
   * curl's `-T` uploads a file and `-t` sets a telnet option; `-X` chooses the method and `-x`
   * names a proxy; gh's `-F` and `-f` both write, and `-F` reads its value from a file. The lists
   * were matched entirely against lowercased arguments, so each pair collapsed into whichever
   * spelling happened to be written down - safe by accident, because every collapse erred towards
   * the card, and `-F` was caught only because it arrived as `-f`. The repair that looks obvious,
   * matching the raw argument against the same list, would have let `gh api -F key=@file` through
   * as a read.
   */
  it('tells the two spellings of an option apart', () => {
    // gh: both field flags write, whichever case they are written in.
    expect(sendsDataOverNetwork('gh', ['api', '/x', '-F', 'key=@secrets.json'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '-f', 'key=value'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '--field', 'key=value'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '--raw-field', 'key=value'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '--input', 'body.json'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '-X', 'POST'])).toBe(true);
    expect(sendsDataOverNetwork('gh', ['api', '/x'])).toBe(false);
    expect(sendsDataOverNetwork('gh', ['api', '/x', '-X', 'GET'])).toBe(false);
    // curl: the uppercase form of each pair sends data and the lowercase form does not.
    expect(sendsDataOverNetwork('curl', ['-T', 'results.zip', 'https://x'])).toBe(true);
    expect(sendsDataOverNetwork('curl', ['-F', 'file=@cv.pdf', 'https://x'])).toBe(true);
    expect(sendsDataOverNetwork('curl', ['-d', '@notes.txt', 'https://x'])).toBe(true);
    expect(sendsDataOverNetwork('curl', ['-X', 'POST', 'https://x'])).toBe(true);
    expect(sendsDataOverNetwork('curl', ['--upload-file', 'results.zip', 'https://x'])).toBe(true);
    // `-t` is a telnet option, `-x` is a proxy and `-D` writes the response headers to a local
    // file. None of them sends anything out, and a card in front of an ordinary GET is a card the
    // owner learns to tap through.
    expect(sendsDataOverNetwork('curl', ['-t', 'BINARY', 'https://x'])).toBe(false);
    expect(sendsDataOverNetwork('curl', ['-x', 'http://proxy.internal:3128', 'https://x'])).toBe(
      false
    );
    expect(sendsDataOverNetwork('curl', ['-D', 'headers.txt', 'https://x'])).toBe(false);
    expect(sendsDataOverNetwork('curl', ['-s', 'https://x'])).toBe(false);
  });
  /*
   * The wrapper the model is told to reach for was the one hole the literal-URL scan never covered.
   *
   * `scriptCommands` read the first word of each segment, and for `timeout 30 curl -s "$U"` inside
   * an interpreter that word was `timeout`. The bare form was unwrapped and tainted; the wrapped
   * form - with no address written down for `shellDestinations` to find - was an unknown command
   * running an unknown command, so an attacker-chosen page arrived with the floor reporting the
   * turn clean. Measured before the repair on all three runners and on the shell keywords.
   */
  it('unwraps a runner or a keyword inside a script, not only outside one', () => {
    const fetched = 'network command output';
    for (const script of [
      'timeout 30 curl -s "$U" -o page.html',
      'env P=1 curl -s "$U"',
      'nice -n 5 wget "$U"',
      'xargs curl -s < urls.txt',
      'if curl -sf "$U"; then echo ok; fi',
      'then curl -s "$U"',
      'while curl -s "$U"; do echo again; done'
    ])
      expect(untrustedShellOrigin({ executable: 'bash', args: ['-lc', script] }), script).toBe(
        fetched
      );
    // And the wrapper still comes off the same way it did before, so nothing that was clean stops
    // being clean.
    for (const script of ['timeout 30 pnpm test', 'env CI=1 pnpm build', 'if [ -f x ]; then :; fi'])
      expect(
        untrustedShellOrigin({ executable: 'bash', args: ['-lc', script] }),
        script
      ).toBeNull();
  });

  /*
   * What a script writes, as opposed to every word it contains.
   *
   * `writtenPaths` split the script on whitespace and punctuation and handed the result to the
   * deferred-execution rule, so `bash -lc 'cat ~/.bashrc'` was a write of `~/.bashrc`. The
   * resolution here is fail-closed in the same direction the wide net was, and moved rather than
   * dropped: a command it cannot place on either side returns null, and `writtenPaths` goes back to
   * listing every token for exactly those shapes.
   */
  it('resolves what a script writes, and returns null rather than guess', () => {
    const script = (body: string) => shellWriteTargets({ executable: 'bash', args: ['-lc', body] });
    expect(script('cat ~/.bashrc')).toEqual([]);
    expect(script('grep -n PATH ~/.zshrc | head -3')).toEqual([]);
    expect(script('echo x >> ~/.bashrc')).toEqual(['~/.bashrc']);
    expect(script('echo x > out.log 2>&1')).toEqual(['out.log']);
    // `2>&1` and `>&2` duplicate a descriptor and write no file; `2>err.log` writes one.
    expect(script('cat notes.txt 2>&1')).toEqual([]);
    expect(script('cat notes.txt 2>err.log')).toEqual(['err.log']);
    // An executable this cannot place is null however harmless it is, which is the fail-closed
    // half: `pnpm` is neither a recognised reader nor a recognised writer.
    expect(script('pnpm test 2>&1')).toBeNull();
    expect(script('cp a ~/.bashrc')).toEqual(['a', '~/.bashrc']);
    expect(script('dd if=/dev/zero of=disk.img')).toContain('disk.img');
    // Unknown fails closed: a downloader's output flag, a language runtime and a script this
    // cannot read at all are all null, not an empty list.
    expect(script('curl -o ~/.bashrc https://x')).toBeNull();
    expect(
      shellWriteTargets({ executable: 'python3', args: ['-c', "open('.bashrc','w')"] })
    ).toBeNull();
    expect(shellWriteTargets({ executable: 'bash', args: ['script.sh'] })).toBeNull();
    // A bare invocation is judged the same way, with no script to read.
    expect(shellWriteTargets({ executable: 'tee', args: ['-a', '~/.bashrc'] })).toEqual([
      '~/.bashrc'
    ]);
    expect(shellWriteTargets({ executable: 'cat', args: ['~/.bashrc'] })).toEqual([]);
  });

  /*
   * `git config` names no path, so the rule that reads the paths a call writes cannot see it at
   * all. One predicate answers for both the card and the completion clock, because a call the floor
   * calls consequential and the write classifier calls no change is two mechanisms disagreeing
   * about the same call.
   */
  it('tells a git identity from a git setting that runs a command', () => {
    expect(gitConfigWrite(['config', '--global', 'user.name', 'Dan'])).toBe('user.name');
    expect(gitConfigWrite(['config', '--global', 'core.hooksPath', '/x'])).toBe('core.hookspath');
    expect(gitConfigWrite(['config', '--list'])).toBeNull();
    expect(gitConfigWrite(['config', '--get', 'user.name'])).toBeNull();
    expect(gitConfigWrite(['config', 'user.name'])).toBeNull();
    expect(gitConfigWrite(['status'])).toBeNull();
    // An option this cannot read makes the key unnameable, and an unnameable key is exempted by
    // nothing.
    expect(gitConfigWrite(['config', '--file', '~/.bashrc', 'user.name', 'Dan'])).toBe('');
    expect(gitConfigRunsCode(['config', '--global', 'user.name', 'Dan'])).toBe(false);
    expect(gitConfigRunsCode(['config', '--global', 'user.email', 'me@example.com'])).toBe(false);
    expect(gitConfigRunsCode(['config', '--global', 'pull.rebase', 'true'])).toBe(false);
    expect(gitConfigRunsCode(['config', '--global', 'alias.ci', '!evil'])).toBe(true);
    expect(gitConfigRunsCode(['config', '--global', 'include.path', '/x'])).toBe(true);
    expect(gitConfigRunsCode(['config', '--file', '~/.bashrc', 'user.name', 'Dan'])).toBe(true);
    expect(gitConfigRunsCode(['-C', 'repo', 'config', 'alias.x', '!evil'])).toBe(true);
  });
});
