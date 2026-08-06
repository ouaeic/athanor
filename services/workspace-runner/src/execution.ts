import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { z } from 'zod';
import {
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

export const ExecRequest = z.object({
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
    .default(1024 * 1024)
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
 */
const DISK_FLOOR_POLL_MS = 5_000;

export interface ExecutionGuards {
  limits?: CommandLimits | undefined;
  /** Absolute path to prlimit, or undefined on a host that has no equivalent. */
  limiter?: string | undefined;
  /** Overridable so the floor can be exercised without filling a real filesystem. */
  hostStorage?: ((root: string) => Promise<HostStorage>) | undefined;
  hostStoragePollMs?: number | undefined;
}

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
  const searchPath = agentSearchPath(workspaceRoot);
  // Asked first, so a policy the caller believes it is applying is refused before anything runs.
  const environment = agentEnvironment(workspaceRoot, searchPath, request.env);
  const cwd = resolveInside(workspaceRoot, request.cwd);
  // Checked as the kernel will read it as well as as it was written, so a symbolic link or a
  // relative name cannot present a basename the checks below do not recognise.
  const resolved = await resolveExecutable(request.executable, searchPath, cwd);
  const asResolved = resolved ? { executable: resolved, args: request.args } : request;
  if (privilegeEscalationBinary(request) ?? privilegeEscalationBinary(asResolved)) {
    throw new Error(
      'Direct privilege escalation is disabled; install packages with apt-get so Athanor can apply the approval policy'
    );
  }
  const privilegedHelpers = [systemPackageHelper, sandbox?.helper];
  if (
    privilegedHelperInvocation(request, privilegedHelpers) ??
    privilegedHelperInvocation(asResolved, privilegedHelpers)
  ) {
    throw new Error(
      "Athanor's own privileged helpers are reached by the runner after an approval, not by a command"
    );
  }
  const packageManager = packageManagerInvocation(request) ?? packageManagerInvocation(asResolved);
  // A wrapped apt run cannot be rewritten onto the approved helper, so it never executes.
  if (packageManager === 'wrapped') {
    throw new Error('Host-native package management supports approved apt update and install only');
  }
  if (packageManager === 'direct') {
    if (!allowSystemPackages || !systemPackageHelper) {
      throw new Error('An approved system-packages capability is required');
    }
    const operation = request.args.find((argument) => !argument.startsWith('-'));
    if (!operation || !['update', 'install'].includes(operation)) {
      throw new Error(
        'Host-native package management supports approved apt update and install only'
      );
    }
    const packages =
      operation === 'install'
        ? request.args
            .slice(request.args.indexOf(operation) + 1)
            .filter((argument) => !['-y', '--yes', '--no-install-recommends'].includes(argument))
        : [];
    if (
      packages.some(
        (packageName) => !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9_-]*)?$/i.test(packageName)
      )
    ) {
      throw new Error('Package names may not contain apt options, paths, or hook configuration');
    }
    request.executable = systemPackageHelper;
    request.args = operation === 'update' ? ['update'] : ['install', ...packages];
  }
  const started = performance.now();
  // The approved package install is the one command that has to keep the runner's own identity:
  // it reaches root through sudo, which the sandbox deliberately makes impossible.
  const sandboxed = sandbox && packageManager !== 'direct';
  // The limiter wraps the sandbox rather than the other way round: resource limits are inherited
  // across exec, so setting them outermost applies them to everything underneath.
  const { executable, args } = limitedInvocation(
    sandboxed
      ? sandboxedInvocation(
          { executable: request.executable, args: request.args },
          environment,
          sandbox,
          isolateNetwork && !request.network
        )
      : { executable: request.executable, args: request.args },
    guards.limits,
    guards.limiter
  );
  const child = spawn(executable, args, {
    cwd,
    // The sandbox helper installs the environment itself, from arguments, because sudo resets it.
    env: sandboxed ? {} : environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Leads its own process group so a timeout reaches grandchildren too.
    detached: true,
    shell: false
  });

  const output = boundedCollector(request.maxOutputBytes);
  const errors = boundedCollector(request.maxOutputBytes);
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errors.push(chunk);
  });
  if (request.stdin) child.stdin.end(request.stdin);
  else child.stdin.end();

  let timedOut = false;
  let cancelled = false;
  let diskExhausted = false;
  let escalation: NodeJS.Timeout | undefined;
  const stopTree = () => {
    killProcessTree(child, 'SIGTERM');
    escalation = setTimeout(() => killProcessTree(child, 'SIGKILL'), 2_000);
    escalation.unref();
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
  const timeout = setTimeout(
    () => {
      timedOut = true;
      stopTree();
    },
    Math.min(request.timeoutSeconds, maximumSeconds) * 1_000
  );
  timeout.unref();

  const { exitCode, signal } = await awaitChildExit(child);
  clearTimeout(timeout);
  clearInterval(diskFloor);
  if (escalation) clearTimeout(escalation);
  abortSignal?.removeEventListener('abort', onAbort);
  // The wrapper may have died on SIGTERM while its descendants kept running.
  if (timedOut || cancelled || diskExhausted) killProcessTree(child, 'SIGKILL');
  // Said on the command's own stderr so the reason travels with the tool result: a command that
  // dies on a signal otherwise reads to the model as an unexplained crash it should retry.
  const stderr = diskExhausted
    ? `${errors.text('stderr')}\n[stopped: this command was using the last of the host disk, which the database and the rest of the computer also need]`
    : errors.text('stderr');
  return {
    exitCode,
    signal,
    stdout: output.text('stdout'),
    stderr,
    durationMs: Math.round(performance.now() - started),
    timedOut,
    ...(diskExhausted ? { stoppedReason: 'host_disk_floor' as const } : {})
  };
};
