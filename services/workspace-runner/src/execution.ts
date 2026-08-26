import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { z } from 'zod';
import {
  binaryName,
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';
import { resolveInside } from './files.js';
import {
  belowHostStorageFloor,
  hostStorage as probeHostStorage,
  type HostStorage
} from './host-storage.js';
import { limitedInvocation, type CommandLimits } from './limits.js';
import { sandboxedInvocation, type AgentSandbox } from './sandbox.js';
import { awaitChildExit, killProcessTree } from './subprocess.js';

/**
 * Why athanor runs commands here rather than handing them to a provider's hosted interpreter, so
 * the question is answered once instead of every time somebody notices the option exists.
 *
 * The hosted sandboxes are strictly smaller machines. Anthropic's code execution container has, in
 * its own documentation, "Internet access: Completely disabled for security" and "no internet
 * access, so Claude can't download or install additional packages at runtime"; it expires thirty
 * days after creation and is checkpointed after minutes of inactivity. OpenAI's hosted shell is
 * billed per twenty-minute container session by memory tier. OpenRouter's `openrouter:shell` runs
 * "in an isolated container - not on OpenRouter infrastructure or your machine" and is Responses-API
 * only, which is not the endpoint athanor speaks.
 *
 * What is on this side of the boundary instead: the owner's own persistent Linux computer, with
 * their files, their installed software, real network access, background processes that can be
 * polled rather than blocked on, a pinned interpreter and toolchain, and state that survives
 * between tasks and between weeks. There is nothing a provider sandbox does better, and the same
 * verdict follows for a provider patch tool against `file_patch` and a provider image tool against
 * `generate_media`, which prices a request against the owner's spend limit before anything is
 * spent. The one genuinely good thing in that region of the API - a model writing code to filter
 * search results before they reach its context - comes free with the provider web tools and needs
 * none of this. The persistent machine is the product.
 */

export const ExecRequest = z
  .object({
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(100_000)).max(256).default([]),
    cwd: z.string().default('workspace'),
    env: z.record(z.string(), z.string()).default({}),
    timeoutSeconds: z.number().int().positive().max(86_400).default(300),
    stdin: z.string().max(10_000_000).optional(),
    network: z.boolean().default(false),
    maxOutputBytes: z
      .number()
      .int()
      .min(4_096)
      .max(20 * 1024 * 1024)
      .default(1024 * 1024),
    /*
     * Declared here only so that naming one can be refused.
     *
     * `service` belongs to the background route. Arriving on this one it was an unknown key, which
     * a plain object schema strips: the command ran in the foreground for five minutes and came
     * back as an ordinary result, with no error, no service and no record - and a model that had
     * been told a service was what it just started. A silent wrong outcome for a corrected call is
     * the cheapest trade in the runner.
     */
    service: z.string().min(1).max(120).optional()
  })
  .superRefine((value, context) => {
    if (value.service !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['service'],
        message:
          'Naming a service needs background: true, because a service is a process this computer keeps running after the turn ends'
      });
  });

const boundedCollector = (limit: number) => {
  const headLimit = Math.floor(limit * 0.62);
  const tailLimit = limit - headLimit;
  const head: Buffer[] = [];
  const exact: Buffer[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let overflowed = false;

  return {
    push(chunk: Buffer) {
      totalBytes += chunk.length;
      if (!overflowed) {
        if (totalBytes <= limit) exact.push(chunk);
        else {
          overflowed = true;
          exact.length = 0;
        }
      }
      if (headBytes < headLimit) {
        const keep = chunk.subarray(0, Math.min(chunk.length, headLimit - headBytes));
        if (keep.length) head.push(keep);
        headBytes += keep.length;
      }
      const combined = Buffer.concat([tail, chunk]);
      tail = combined.subarray(Math.max(0, combined.length - tailLimit));
    },
    text(stream: string) {
      const beginning = Buffer.concat(head);
      if (!overflowed) return Buffer.concat(exact).toString('utf8');
      const omitted = Math.max(0, totalBytes - beginning.length - tail.length);
      return `${beginning.toString('utf8')}\n[… ${omitted} bytes omitted from ${stream}; beginning and end preserved …]\n${tail.toString('utf8')}`;
    }
  };
};

/**
 * The only environment a caller may put in front of an agent command. PATH, HOME and LANG belong
 * to the runner - they are how a command is confined to the workspace - and everything else here
 * is a locale, terminal or policy setting a caller named deliberately.
 *
 * OPENCODE_AUTO_SHARE and OPENCODE_PERMISSION are on the list because they are safety controls
 * rather than conveniences: one turns off the share link that would publish the owner's session,
 * the other carries the deny-list that stops the coding CLI running sudo, pushing a branch or
 * reading a .env. One declaration, read by the foreground and the background path alike, because
 * when this list existed twice the background path - the only one that carries these keys - was
 * the copy that did not have them.
 */
export const SAFE_ENV_KEYS =
  /^(?:LANG|LC_[A-Z_]+|TERM|NO_COLOR|FORCE_COLOR|CI|TZ|PYTHONUNBUFFERED|OPENCODE_AUTO_SHARE|OPENCODE_PERMISSION)$/;

/**
 * Refuses rather than filters. A dropped variable is invisible, and the caller goes on believing a
 * policy is in force that never reached the process - which for a deny-list is the difference
 * between a guard and the belief in one. Saying so costs one failed call and nothing else.
 */
export const agentEnvironment = (
  workspaceRoot: string,
  searchPath: string,
  requested: Record<string, string>
): Record<string, string> => {
  const refused = Object.keys(requested)
    .filter((key) => !SAFE_ENV_KEYS.test(key))
    .sort();
  if (refused.length)
    throw new Error(
      `The workspace runtime sets the environment of an agent command itself and does not accept ${refused.join(', ')}`
    );
  return {
    PATH: searchPath,
    HOME: workspaceRoot,
    LANG: 'C.UTF-8',
    ...requested
  };
};

/**
 * Free space is re-read this often while a command runs. The pre-flight check only proves the
 * disk was healthy at the start; a `dd` reaches the last free byte in the seconds after that.
 *
 * Exported because the background path polls on the same rule. When these two intervals were
 * separate declarations the background one did not exist at all.
 */
export const DISK_FLOOR_POLL_MS = 5_000;

/**
 * Why a command stopped, said on the command's own stderr so the reason travels with the result:
 * a process that dies on a signal otherwise reads to the model as an unexplained crash it should
 * retry, and retrying is the one thing that must not happen here. One declaration, read by the
 * foreground and the background path alike.
 */
export const HOST_DISK_FLOOR_NOTE =
  '[stopped: this command was using the last of the host disk, which the database and the rest of the computer also need]';

export interface ExecutionGuards {
  limits?: CommandLimits | undefined;
  /** Absolute path to prlimit, or undefined on a host that has no equivalent. */
  limiter?: string | undefined;
  /** Overridable so the floor can be exercised without filling a real filesystem. */
  hostStorage?: ((root: string) => Promise<HostStorage>) | undefined;
  hostStoragePollMs?: number | undefined;
}

/**
 * The two operations the approved helper performs, and how each family spells them.
 *
 * This computer installs on four distribution families, and the reader of a package command knew
 * one of them: it took the first argument that was not a flag and required it to be `update` or
 * `install`, which is apt's grammar and nobody else's. `dnf install -y nmap` yielded `install` and
 * was rewritten onto a helper that ran `apt-get`, so on a Fedora or Rocky host the owner approved
 * an install and got exit 127; `pacman -S nmap` yielded `nmap` and was refused one step earlier
 * with a sentence about apt, so on an Arch host the owner approved an install and was told their
 * package name was an unsupported operation. Two wrong answers, two different messages, both after
 * the owner had already said yes.
 *
 * Left out on purpose: a whole-system rewrite. `dnf upgrade`, `apt-get upgrade` and `pacman -Syu`
 * are not what an install approval was granted for, and rounding them down to an index refresh
 * would report success for something the owner asked for and did not get. Left out for the same
 * reason: `emerge`, `rpm`, `rpm-ostree` and `yay`, which either build from source, take a local
 * file rather than a repository name, rewrite the whole image, or refuse to run as root at all.
 * They are still package management as far as the approval card and the desktop refusal are
 * concerned - they are just not something this helper can carry out.
 *
 * The helper's own argument list stays `update` / `install PACKAGE...`: which manager runs on this
 * host is the helper's question, answered where the install already knows the answer, and not a
 * fourteen-way guess made by a process that cannot see the host's release file.
 *
 * pacman has a row here even though its parse is the branch below rather than these two verbs.
 * Membership of this table is what decides whether a manager can be carried out at all, and
 * `HELPER_PACKAGE_MANAGERS` in `apps/worker/src/turn-bounds.ts` is a copy of that membership on
 * the far side of a package boundary the worker cannot import across. A pacman that was handled
 * in code but absent from the table made the two lists uncomparable, so `check-repository.mjs`
 * could not hold them together; with the row present it can, and does.
 *
 * `assent` is how the family spells "do not ask me", and it is here rather than at the two call
 * sites for the same reason the verbs are: it is the third thing that differs per family, and the
 * toolchain report needs it to tell an agent a command it can actually run.
 */
const PACKAGE_OPERATIONS: Record<string, { update: string; install: string; assent: string }> = {
  // apk needs no assent flag: it is non-interactive already, and `apk add -y` is an error.
  apk: { update: 'update', install: 'add', assent: '' },
  apt: { update: 'update', install: 'install', assent: '-y' },
  'apt-get': { update: 'update', install: 'install', assent: '-y' },
  aptitude: { update: 'update', install: 'install', assent: '-y' },
  dnf: { update: 'makecache', install: 'install', assent: '-y' },
  dnf5: { update: 'makecache', install: 'install', assent: '-y' },
  microdnf: { update: 'makecache', install: 'install', assent: '-y' },
  pacman: { update: '-Sy', install: '-S', assent: '--noconfirm' },
  yum: { update: 'makecache', install: 'install', assent: '-y' },
  zypper: { update: 'refresh', install: 'install', assent: '-y' }
};

/**
 * How to say "install these" to this host's package manager, for advice an agent can run.
 *
 * The toolchain report used to name `apt-get install -y` whatever the host was, so on a Fedora,
 * Rocky, Arch or openSUSE box the one sentence telling an agent how to close a gap named a binary
 * that host has never had. It is built from the table above rather than beside it, so the command
 * the report suggests and the command this file will accept are the same fact.
 */
export const packageInstallCommandLine = (
  manager: string,
  packages: readonly string[]
): string | undefined => {
  const spelling = PACKAGE_OPERATIONS[manager];
  if (!spelling || !packages.length) return undefined;
  return [manager, spelling.install, spelling.assent, ...packages].filter(Boolean).join(' ');
};

/** The short spellings zypper accepts, which a model that knows zypper will use. */
const ZYPPER_ALIASES: Record<string, string> = { ref: 'refresh', in: 'install' };

/**
 * Assent flags. The helper supplies its own - it runs unattended by construction - so these are
 * the only arguments dropped rather than refused. Everything else survives into the package list
 * and is answered by the name check, which is what keeps `-o APT::Update::Pre-Invoke::=id` from
 * being read as a package.
 */
const PACKAGE_ASSENT_FLAGS = new Set([
  '-y',
  '--yes',
  '--assume-yes',
  '--assumeyes',
  '--noconfirm',
  '--needed',
  '--non-interactive',
  '--no-install-recommends'
]);

/**
 * What this invocation asks the helper to do, or undefined when it asks for something else.
 *
 * pacman is read by its operation flag rather than by a verb, because that is how pacman is
 * written: `-S` with names is an install, `-Sy` with none is an index refresh, and anything
 * carrying `u` is a system upgrade and is refused above.
 */
const packageOperation = (
  manager: string,
  args: string[]
): { operation: 'update' | 'install'; packages: string[] } | undefined => {
  const spelling = PACKAGE_OPERATIONS[manager];
  if (!spelling) return undefined;
  if (manager === 'pacman') {
    const sync = args.find((argument) => /^-[A-Za-z]*S[A-Za-z]*$/.test(argument));
    if (!sync || sync.includes('u')) return undefined;
    const packages = args.filter(
      (argument) => argument !== sync && !PACKAGE_ASSENT_FLAGS.has(argument)
    );
    if (packages.length) return { operation: 'install', packages };
    return sync.includes('y') ? { operation: 'update', packages: [] } : undefined;
  }
  const verbIndex = args.findIndex((argument) => !argument.startsWith('-'));
  if (verbIndex === -1) return undefined;
  const verb =
    (manager === 'zypper' ? ZYPPER_ALIASES[args[verbIndex] ?? ''] : undefined) ??
    args[verbIndex] ??
    '';
  const operands = args.filter(
    (argument, index) => index !== verbIndex && !PACKAGE_ASSENT_FLAGS.has(argument)
  );
  // An index refresh takes no operands. One here means the model meant an operation this helper
  // does not have, and running the refresh instead would answer it with silence.
  if (verb === spelling.update)
    return operands.length ? undefined : { operation: 'update', packages: [] };
  // An install with nothing to install would be discovered by the helper, as root, which is the
  // wrong place to find out that an argument list was empty.
  if (verb === spelling.install)
    return operands.length ? { operation: 'install', packages: operands } : undefined;
  return undefined;
};

export interface ExecutionOptions {
  maximumSeconds: number;
  isolateNetwork?: boolean;
  allowSystemPackages?: boolean;
  systemPackageHelper?: string | undefined;
  /** Absent on a host that cannot drop to a separate account, such as a developer's laptop. */
  sandbox?: AgentSandbox | undefined;
  /**
   * Aborts when the caller goes away - which is what a cancelled task looks like from here. Without
   * it a `Cancel` only stopped the worker waiting for the result; the command itself kept running
   * to completion on the box, still writing files and still reaching the network.
   */
  abortSignal?: AbortSignal | undefined;
  guards?: ExecutionGuards;
}

/** The PATH every agent command runs with, and therefore the one a policy check must resolve in. */
export const agentSearchPath = (workspaceRoot: string): string =>
  [
    path.join(workspaceRoot, 'workspace', '.athanor', 'tools', 'node_modules', '.bin'),
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin'
  ].join(path.delimiter);

/** The command as the kernel will receive it, after every refusal, the sandbox and the limiter. */
export interface PreparedInvocation {
  executable: string;
  args: string[];
  cwd: string;
  /** Empty when the sandbox helper is in front, because it installs the environment itself. */
  env: Record<string, string>;
}

/**
 * The part of a run request the refusals read. Both route schemas are supersets of it, which is
 * why the checks below can be stated once instead of once per schema.
 */
export interface InvocationRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  network: boolean;
}

/**
 * How the foreground and the background path differ, said as data.
 *
 * These checks were written twice, and the two copies drifted the way copies do: the background one
 * has never known about the system-package helper, and no test on that side ever named it. Stating
 * the difference as a field rather than as a second function means the next reader sees the whole
 * of it at once instead of diffing two hundred lines of near-identical code to find the one clause
 * that is not the same.
 *
 * `mode: 'refused'` is the background rule: a package manager is not rewritten onto the approved
 * helper, it is refused outright, because an install is an approval the owner gave for a command
 * they are watching and a process that outlives the turn is by construction not that.
 *
 * `helper` sits outside that choice, on both arms, and that placement is the whole of a live
 * privilege gap. It was once carried only by the arm that rewrites onto it, so the refusing path
 * could not name it - and naming it is exactly what the refusal below needs, because a command may
 * not invoke the helper itself. The helper's location is a fact about the host, not about what
 * this path does with a package manager, so both arms state it.
 */
export type SystemPackagePolicy =
  | { mode: 'refused'; helper: string | undefined }
  | { mode: 'approved'; allowed: boolean; helper: string | undefined };

export interface InvocationPolicy {
  isolateNetwork: boolean;
  /** Absent on a host that cannot drop to a separate account, such as a developer's laptop. */
  sandbox?: AgentSandbox | undefined;
  limits?: CommandLimits | undefined;
  /** Absolute path to prlimit, or undefined on a host that has no equivalent. */
  limiter?: string | undefined;
  systemPackages: SystemPackagePolicy;
}

/**
 * Every refusal the runner applies to a command, and the wrapping that follows them, in one place.
 *
 * Read as a sequence: the environment is settled first so a caller that believes it is applying a
 * policy is told otherwise before anything runs; the executable is then resolved the way the kernel
 * will resolve it, so a symbolic link cannot present a basename the checks do not recognise; the
 * refusals are asked against both spellings; and only then is the survivor wrapped in the sandbox
 * and the resource limiter. Nothing here spawns - that is the caller's, because the foreground path
 * awaits its child and the background path files it away, and those two lifecycles have nothing in
 * common but the arguments computed here.
 */
export const prepareInvocation = async (
  workspaceRoot: string,
  request: InvocationRequest,
  policy: InvocationPolicy
): Promise<PreparedInvocation> => {
  const searchPath = agentSearchPath(workspaceRoot);
  // Asked first, so a policy the caller believes it is applying is refused before anything runs.
  const environment = agentEnvironment(workspaceRoot, searchPath, request.env);
  const cwd = resolveInside(workspaceRoot, request.cwd);
  // Checked as the kernel will read it as well as as it was written, so a symbolic link or a
  // relative name cannot present a basename the checks below do not recognise.
  const resolved = await resolveExecutable(request.executable, searchPath, cwd);
  const asResolved = resolved ? { executable: resolved, args: request.args } : request;
  // Both paths contribute the package helper, because both refuse a command that names it. This
  // list used to be built from the rewriting arm alone, which left the background path holding
  // only the sandbox's elevator - and nothing at all on a host with AGENT_SANDBOX_HELPER unset,
  // a configuration config.ts documents as supported. The helper reaches root through NOPASSWD
  // sudo, so on that host a background start could name it directly and get there.
  const privilegedHelpers = [policy.systemPackages.helper, policy.sandbox?.helper];
  let executable = request.executable;
  let args = request.args;
  let sandbox = policy.sandbox;

  if (policy.systemPackages.mode === 'refused') {
    // One sentence for the whole family: on this path none of them is rewritten onto anything, so
    // there is no second outcome to distinguish and no reason to make the caller read six.
    if (
      privilegeEscalationBinary(request) ??
      privilegeEscalationBinary(asResolved) ??
      packageManagerInvocation(request) ??
      packageManagerInvocation(asResolved) ??
      privilegedHelperInvocation(request, privilegedHelpers) ??
      privilegedHelperInvocation(asResolved, privilegedHelpers)
    ) {
      throw new Error('Privilege and system-package operations cannot run as background processes');
    }
  } else {
    if (privilegeEscalationBinary(request) ?? privilegeEscalationBinary(asResolved)) {
      throw new Error(
        "Direct privilege escalation is disabled; install packages with this computer's own package manager so Athanor can apply the approval policy"
      );
    }
    if (
      privilegedHelperInvocation(request, privilegedHelpers) ??
      privilegedHelperInvocation(asResolved, privilegedHelpers)
    ) {
      throw new Error(
        "Athanor's own privileged helpers are reached by the runner after an approval, not by a command"
      );
    }
    const packageManager =
      packageManagerInvocation(request) ?? packageManagerInvocation(asResolved);
    // A wrapped package run cannot be rewritten onto the approved helper, so it never executes.
    if (packageManager === 'wrapped') {
      throw new Error(
        'Host-native package management supports approved update and install only, named directly rather than through a wrapper'
      );
    }
    if (packageManager === 'direct') {
      const { allowed, helper } = policy.systemPackages;
      if (!allowed || !helper) {
        throw new Error('An approved system-packages capability is required');
      }
      // Whichever spelling matched is the manager: `packageManagerInvocation` answers `direct` only
      // for the executable's own basename, and the resolved form is the one the kernel will run.
      const manager =
        packageManagerInvocation(request) === 'direct'
          ? binaryName(request.executable)
          : binaryName(asResolved.executable);
      const asked = packageOperation(manager, request.args);
      if (!asked) {
        throw new Error(
          `Host-native package management supports approved update and install only, and this ${manager} command is neither`
        );
      }
      if (
        asked.packages.some(
          (packageName) => !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9_-]*)?$/i.test(packageName)
        )
      ) {
        throw new Error('Package names may not contain options, paths, or hook configuration');
      }
      executable = helper;
      args = asked.operation === 'update' ? ['update'] : ['install', ...asked.packages];
      // The approved package install is the one command that has to keep the runner's own identity:
      // it reaches root through sudo, which the sandbox deliberately makes impossible.
      sandbox = undefined;
    }
  }

  // The limiter wraps the sandbox rather than the other way round: resource limits are inherited
  // across exec, so setting them outermost applies them to everything underneath.
  const limited = limitedInvocation(
    sandbox
      ? sandboxedInvocation(
          { executable, args },
          environment,
          sandbox,
          policy.isolateNetwork && !request.network
        )
      : { executable, args },
    policy.limits,
    policy.limiter
  );
  return {
    executable: limited.executable,
    args: limited.args,
    cwd,
    // The sandbox helper installs the environment itself, from arguments, because sudo resets it.
    env: sandbox ? {} : environment
  };
};

/**
 * How long a process gets to answer SIGTERM before it is sent the signal it cannot catch.
 *
 * One declaration because the number was written out at four call sites across the two files, and
 * a grace that differs between the path that runs a command and the path that runs the same command
 * in the background is a difference nobody chose.
 */
const TERMINATION_GRACE_MS = 2_000;

/**
 * Stops a command's whole process group: the polite signal, then the certain one.
 *
 * Returns the escalation timer so a caller still holding the child can cancel it once the process
 * has actually gone; a caller with nothing left to wait for can ignore it, because the timer is
 * unreferenced and cannot by itself hold the runner open.
 */
export const stopProcessTree = (child: ChildProcess): NodeJS.Timeout => {
  killProcessTree(child, 'SIGTERM');
  const escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), TERMINATION_GRACE_MS);
  escalation.unref();
  return escalation;
};

/**
 * One foreground command, run to completion under every guard the runner puts around it: the
 * bounded collectors, the deadline, the caller's abort, and the host-disk floor.
 *
 * Deliberately not shared with the background path, and this is the note that says why so the next
 * reader does not try again. There the collectors are the session's own buffers and keep only the
 * tail; the deadline mutates a session row rather than a local flag, and is absent entirely for a
 * declared service; the floor retires a supervised service before it stops the process, or the
 * supervisor puts the thing that filled the disk straight back into it; and there is no abort at
 * all, because `processes/start` has already answered by the time a task is cancelled. Four of the
 * five guards differ in what they do, not in how they are wired, so a shared version would be five
 * callbacks around a `spawn` - more surface than the duplication it removed.
 */
const startGuardedChild = async (
  workspaceRoot: string,
  prepared: PreparedInvocation,
  options: {
    stdin: string | undefined;
    maxOutputBytes: number;
    timeoutMs: number;
    abortSignal: AbortSignal | undefined;
    guards: ExecutionGuards;
  }
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  diskExhausted: boolean;
}> => {
  const { abortSignal, guards } = options;
  const child = spawn(prepared.executable, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Leads its own process group so a timeout reaches grandchildren too.
    detached: true,
    shell: false
  });

  const output = boundedCollector(options.maxOutputBytes);
  const errors = boundedCollector(options.maxOutputBytes);
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors.push(chunk);
  });
  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();

  let timedOut = false;
  let cancelled = false;
  let diskExhausted = false;
  let escalation: NodeJS.Timeout | undefined;
  const stopTree = () => {
    escalation = stopProcessTree(child);
  };
  // A command that keeps writing past the floor is stopped rather than allowed to reach the last
  // free byte: PostgreSQL shares this filesystem, and a full disk stops the database, the
  // interface and every other task, not just the command that caused it.
  const storageProbe = guards.hostStorage ?? probeHostStorage;
  let probing = false;
  const diskFloor = setInterval(() => {
    if (probing || diskExhausted) return;
    probing = true;
    void storageProbe(workspaceRoot)
      .then((storage) => {
        if (!belowHostStorageFloor(storage)) return;
        diskExhausted = true;
        stopTree();
      })
      .catch(() => undefined)
      .finally(() => {
        probing = false;
      });
  }, guards.hostStoragePollMs ?? DISK_FLOOR_POLL_MS);
  diskFloor.unref();
  const onAbort = () => {
    cancelled = true;
    stopTree();
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    stopTree();
  }, options.timeoutMs);
  timeout.unref();

  const { exitCode, signal } = await awaitChildExit(child);
  clearTimeout(timeout);
  clearInterval(diskFloor);
  if (escalation) clearTimeout(escalation);
  abortSignal?.removeEventListener('abort', onAbort);
  // The wrapper may have died on SIGTERM while its descendants kept running.
  if (timedOut || cancelled || diskExhausted) killProcessTree(child, 'SIGKILL');
  return {
    exitCode,
    signal,
    stdout: output.text('stdout'),
    stderr: errors.text('stderr'),
    timedOut,
    diskExhausted
  };
};

export const execute = async (
  workspaceRoot: string,
  value: unknown,
  options: ExecutionOptions
): Promise<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stoppedReason?: 'host_disk_floor';
}> => {
  const {
    maximumSeconds,
    isolateNetwork = false,
    allowSystemPackages = false,
    systemPackageHelper,
    sandbox,
    abortSignal,
    guards = {}
  } = options;
  const request = ExecRequest.parse(value);
  const prepared = await prepareInvocation(workspaceRoot, request, {
    isolateNetwork,
    sandbox,
    limits: guards.limits,
    limiter: guards.limiter,
    systemPackages: { mode: 'approved', allowed: allowSystemPackages, helper: systemPackageHelper }
  });
  // Started after the refusals, so a PATH resolution the caller never sees is not billed to the
  // command as time it spent running.
  const started = performance.now();
  const run = await startGuardedChild(workspaceRoot, prepared, {
    stdin: request.stdin,
    maxOutputBytes: request.maxOutputBytes,
    timeoutMs: Math.min(request.timeoutSeconds, maximumSeconds) * 1_000,
    abortSignal,
    guards
  });
  const stderr = run.diskExhausted ? `${run.stderr}\n${HOST_DISK_FLOOR_NOTE}` : run.stderr;
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    stdout: run.stdout,
    stderr,
    durationMs: Math.round(performance.now() - started),
    timedOut: run.timedOut,
    ...(run.diskExhausted ? { stoppedReason: 'host_disk_floor' as const } : {})
  };
};
