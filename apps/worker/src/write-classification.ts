/**
 * What a call writes, and whether that write is the kind the completion contract has to wait for.
 *
 * Lifted out of tools.ts unchanged. These read as one rule and were four hundred lines apart: a
 * change is what `finish` dates its evidence against, and `writtenPaths` is what decides whether a
 * change landed on the running brief, on prose, or on something with a test to run. The one
 * transcription defect this file exists to prevent is a classifier that answers for one of the two
 * write paths - `file_write` and a redirect inside a script - and not the other.
 *
 * It imports the command classifiers rather than the other way round: judging a `shell` call needs
 * `gitSubcommand`, the package-manager sets and `commandScript`, and nothing in
 * command-classification.ts needs to know what a write is.
 *
 * `tools.ts` re-exports what it always exported, so no caller moved.
 */
import {
  commandInterpreters,
  commandScript,
  consequentialExecutables,
  FILE_WRITING_EXECUTABLES,
  gitConfigWrite,
  gitSubcommand,
  packageInstallCommands,
  packageRemovalCommands,
  packageRemovalExecutables,
  shellWriteTargets,
  WRITING_GIT_SUBCOMMANDS
} from './command-classification.js';
import { textValue } from './surface-actions.js';

/** Tools whose successful result is a check, not a change; everything else here changes something. */
const NON_MUTATING_TOOLS = new Set([
  // A question changes nothing on the computer or outside it. Counting it as a change would put it
  // in front of the completion-evidence rule, where the only result after it is the question - which
  // shows nothing about the work, for exactly the reason notify is listed below.
  'ask',
  // Added with the tool and not with the set, which is the whole defect: a transcription read as a
  // change, so one voice memo took a full workspace checkpoint, set mutatedBeyondProse, and sent
  // the model back for a set_acceptance on a job with nothing to build. The transcript sidecar it
  // writes is a .txt beside the recording, which isProsePath already classifies as prose.
  'audio_read',
  'browser_snapshot',
  'code_diagnostics',
  'code_search',
  'compact_context',
  'connector_list',
  'delegate',
  'desktop_observe',
  'document_read',
  'document_search',
  'file_read',
  'files_list',
  'finish',
  'image_read',
  'memory_recall',
  // It sends a line to the owner's own devices and touches nothing else. Counting it as a change
  // would put it in front of the completion-evidence rule, where the only citable result after it
  // is the notice itself - which shows nothing about whether the work it describes actually landed.
  'notify',
  'parallel_web_read',
  'publish_artifact',
  'read_elements',
  'repo_overview',
  'session_search',
  'set_plan',
  'web_search'
]);

/**
 * Whether a successful call changed the computer, the workspace, or something outside it.
 *
 * `finish` uses this to insist that evidence comes from after the last change rather than before
 * it. A shell command is judged on its executable: the point is to catch "edited a file, then cited
 * the search from four steps ago", not to force a second check after every `ls`. A test runner, a
 * compiler or a linter invoked directly is therefore not a mutation, because it is exactly what the
 * rule wants the model to reach for next.
 *
 * An inline `bash -lc` is a mutation whatever it turns out to have run, since nothing here reads a
 * shell script. That is the safe direction for the two other callers, but it means the shell a
 * model checks its work with is itself a change - so `completionVerification` lets a shell result
 * be cited as the observation of its own change. Without that pair, an agent that verifies through
 * the shell, which is most of them, can never ground a completion.
 */
export const isMutatingToolCall = (name: string, args: Record<string, unknown> = {}): boolean => {
  if (NON_MUTATING_TOOLS.has(name)) return false;
  if (name === 'shell') {
    // Deliberately asymmetric. A command wrongly called a change costs nothing but a second check;
    // a verification command wrongly called a change can never satisfy the rule it is meant to
    // satisfy, and the model would be stuck rejecting its own correct completion. So only
    // recognisable writers count, and an unrecognised executable with no script to run is treated
    // as a check.
    const executable = textValue(args.executable).split('/').pop() ?? '';
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const lowerArgs = commandArgs.map((argument) => argument.toLowerCase());
    // `git config --global core.hooksPath …` was not a change here while the floor was calling it
    // `external_consequential` and stopping the turn for it - two mechanisms answering the same
    // question about the same call two different ways, which is the one defect this file exists to
    // prevent. It writes `.gitconfig`, and every later git invocation on this computer reads what
    // landed there, so evidence gathered before it does not cover it. A reading `git config` stays
    // a check, which is what keeps the asymmetry above intact: nobody verifies with a write.
    if (executable === 'git')
      return (
        WRITING_GIT_SUBCOMMANDS.has(gitSubcommand(commandArgs) ?? '') ||
        gitConfigWrite(commandArgs) !== null
      );
    if (packageRemovalExecutables.has(executable))
      return lowerArgs.some(
        (argument) =>
          packageInstallCommands.has(argument) ||
          packageRemovalCommands.has(argument) ||
          argument === 'publish'
      );
    // Every other classifier in this file was converted to commandScript and this one was not, so
    // `bash -lc 'echo … >> workspace/ATHANOR.md'` stopped for the owner's review and the identical
    // script handed to the same interpreter on stdin raised no card at all - writtenPaths gates on
    // this predicate, so the durable-instruction rule never saw the path. An interpreter with a
    // script is a writer wherever the script was written down.
    if (commandInterpreters.has(executable)) return commandScript(args).trim().length > 0;
    if (executable === 'sed') return lowerArgs.some((argument) => argument.startsWith('-i'));
    return (
      consequentialExecutables.has(executable) ||
      FILE_WRITING_EXECUTABLES.has(executable) ||
      executable.startsWith('mkfs') ||
      ['curl', 'wget', 'gh', 'ssh', 'scp', 'systemctl', 'apt', 'apt-get'].includes(executable)
    );
  }
  if (['schedule', 'memory', 'skill', 'process'].includes(name))
    return !['list', 'poll', 'log', 'view'].includes(textValue(args.action));
  if (name === 'coding_agent') return textValue(args.action) !== 'status';
  return true;
};

/**
 * Files whose contents become instructions in every later task on this computer.
 *
 * Matched on the tail of the path rather than anchored at its front. `resolveInside` in the runner
 * accepts an absolute path that lands inside the workspace exactly as happily as a relative one, so
 * a front-anchored rule recognised `workspace/ATHANOR.md` and missed
 * `/home/athanor/ws-1/workspace/ATHANOR.md` - the same file, written by the same call. A bare
 * `ATHANOR.md` still counts, because `shell` runs in `workspace` by default and that is where a
 * relative redirect lands.
 */
/**
 * Whether a call's only writes are to the running brief.
 *
 * The completion contract demands evidence observed after the last change, which is right for work
 * and wrong for bookkeeping: an agent that finished, cited what it had proved, and then wrote the
 * outcome into workspace/ATHANOR.md had just made a new last change, so its own record-keeping
 * invalidated the evidence it had already gathered. It then read the brief back to satisfy the
 * gate, which proves only that a file it just wrote contains what it wrote.
 *
 * Narrow on purpose: the brief and workspace skills, the same set `isDurableInstructionPath`
 * already names, and only when every path the call wrote is one of them. A call that touched the
 * brief and a source file is still a change to the source file.
 */
/**
 * Files whose correctness nothing can execute: prose, notes, data written to be read.
 *
 * The completion rule demands evidence dated after the last change, and the way to produce it is to
 * observe the change - run the tests, re-read the page, check the exit code. For a research report
 * or a note there is nothing to run, so the only observation available is reading back a file the
 * agent has just written, which proves that a file it wrote says what it wrote. Measured on one
 * research task: a correct answer, a published report, and then about ten more model turns spent
 * proving prose. A write is its own evidence here, exactly as a shell result is its own evidence
 * for a command.
 *
 * Deliberately by extension and not by guessing at content: a `.ts` file is code whatever is in it,
 * and a `.md` file is prose even when it contains a code block.
 */
const PROSE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.rst',
  '.txt',
  '.text',
  '.adoc',
  '.asciidoc',
  '.org',
  '.csv',
  '.tsv',
  '.log'
]);

export const isProsePath = (path: string): boolean => {
  const last =
    path
      .toLowerCase()
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 && PROSE_EXTENSIONS.has(last.slice(dot));
};

/** True when a call writes files and every one of them is prose. */
export const writesOnlyProse = (name: string, args: Record<string, unknown>): boolean => {
  // Only the two file tools. A shell command is judged on what it ran, and `writtenPaths` casts a
  // deliberately wide net over a script - wide enough that one prose-looking token would speak for
  // the whole command.
  if (name !== 'file_write' && name !== 'file_patch') return false;
  const paths = writtenPaths(name, args);
  return paths.length > 0 && paths.every(isProsePath);
};

export const writesOnlyDurableInstructions = (
  name: string,
  args: Record<string, unknown>
): boolean => {
  const paths = writtenPaths(name, args);
  return paths.length > 0 && paths.every(isDurableInstructionPath);
};

export const isDurableInstructionPath = (path: string): boolean => {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  const last = segments.at(-1) ?? '';
  if (last === 'athanor.md' || last === 'open_cloud.md')
    return segments.length === 1 || segments.at(-2) === 'workspace';
  const skills = segments.indexOf('skills');
  if (skills < 0 || skills === segments.length - 1) return false;
  return skills === 0 || segments[skills - 1] === 'workspace';
};

/**
 * Files nothing on this computer reads as prose and something on it later executes.
 *
 * The durable-instruction rule above is about text that becomes *instructions* in a later task.
 * This is the harder case: text that becomes *execution* in a later process, without a model, a
 * task or a card anywhere near it. The agent's `HOME` is the workspace root (execution.ts sets it),
 * and the subscription coding CLIs run from there - so a written `.bashrc` runs at the next login
 * shell, a written `.git/hooks/pre-commit` runs at the next commit, a written `.gitconfig` alias or
 * `core.hooksPath` runs at the next git invocation of any kind, and a written CLI configuration
 * runs inside a process holding somebody's subscription credentials. Every one of them executes
 * after this task is over and outside every approval this task could have raised, which is why the
 * card these raise is not gated on the turn being tainted: the write is deferred code execution
 * whether or not anything hostile has been read yet.
 *
 * Matched on segments rather than anchored, for the same reason the durable rule is: `~/.bashrc`,
 * `.bashrc`, `../.bashrc` and `/home/athanor/ws-1/.bashrc` are one file written by one call, and a
 * rule that only recognised one spelling is a rule one spelling away from being no rule.
 */
const DEFERRED_EXECUTION_FILES = new Set([
  '.bash_login',
  '.bash_logout',
  '.bash_profile',
  '.bashrc',
  '.gitconfig',
  '.gitmodules',
  '.mcp.json',
  '.profile',
  '.zlogin',
  '.zlogout',
  '.zprofile',
  '.zshenv',
  '.zshrc'
]);

/**
 * Directories whose whole contents configure a process that runs on its own afterwards: the
 * coding CLIs this computer installs, each of which reads its own directory under the agent's
 * HOME. Named as directories rather than as files because none of them documents a fixed set of
 * filenames, and a rule listing today's would miss tomorrow's.
 */
const DEFERRED_EXECUTION_DIRECTORIES = new Set(['.claude', '.codex', '.opencode']);

/** The same directories spelled the way XDG spells them, as `~/.config/<name>`. */
const XDG_DEFERRED_EXECUTION_DIRECTORIES = new Set(['claude', 'codex', 'opencode']);

export const isDeferredExecutionPath = (path: string): boolean => {
  const segments = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter((segment) => segment && segment !== '.');
  if (DEFERRED_EXECUTION_FILES.has(segments.at(-1) ?? '')) return true;
  // `.git/hooks/<anything>` is run by git itself, and `.git/config` can point `core.hooksPath` at
  // a directory of the writer's choosing, which is the same fact one level of indirection away.
  // A bare `.git` or a bare `.git/hooks` is not a write to either.
  const git = segments.lastIndexOf('.git');
  if (git >= 0 && git < segments.length - 1) {
    const next = segments[git + 1] ?? '';
    if (next === 'hooks' ? git + 2 < segments.length : next === 'config') return true;
  }
  return segments.some((segment, index) => {
    if (index === segments.length - 1) return false;
    if (DEFERRED_EXECUTION_DIRECTORIES.has(segment)) return true;
    return (
      segment === '.config' &&
      XDG_DEFERRED_EXECUTION_DIRECTORIES.has(segments[index + 1] ?? '') &&
      index + 2 < segments.length
    );
  });
};

export const writtenPaths = (name: string, args: Record<string, unknown>): string[] => {
  if (name === 'file_write' || name === 'print_pdf') return [textValue(args.path)].filter(Boolean);
  // A redirect writes the brief as surely as file_write does, and the whole point of the durable
  // rule is that the file is read back as a system message in every later task - so a rule that
  // only watched the two file tools was one `bash -lc 'echo ... >> workspace/ATHANOR.md'` away from
  // being no rule. Gated on the command already being classified as a writer, so `cat` on the same
  // path raises nothing: a card that fires on reading the brief is a card the owner stops reading.
  //
  // That gate was the whole of the precision for a long time, and an inline script clears it
  // whatever it turns out to run - so every token of `bash -lc 'cat ~/.bashrc'` arrived here and the
  // deferred-execution rule carded a read. `shellWriteTargets` resolves what the script actually
  // writes; the wide net is what it falls back to when it cannot, which is the same fail-closed
  // answer as before for every shape it cannot read.
  if (name === 'shell') {
    if (!isMutatingToolCall(name, args)) return [];
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    return (
      shellWriteTargets(args) ??
      [...commandArgs, ...commandScript(args).split(/[\s'"`>|;()]+/)].filter(Boolean)
    );
  }
  if (name !== 'file_patch') return [];
  return (Array.isArray(args.patches) ? args.patches : [])
    .map((patch) => textValue((patch as { path?: unknown } | null)?.path))
    .filter(Boolean);
};
