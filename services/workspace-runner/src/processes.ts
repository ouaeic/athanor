import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';
import { agentEnvironment, agentSearchPath } from './execution.js';
import { ensureWorkspace, resolveInside } from './files.js';
import { limitedInvocation, type CommandLimits } from './limits.js';
import { sandboxedInvocation, type AgentSandbox } from './sandbox.js';
import {
  DEFAULT_SERVICE_POLICY,
  givenUp,
  newServiceRecord,
  nextFailureCount,
  reclaimOrphan,
  restartDelayMs,
  serviceView,
  ServiceRegistry,
  SERVICE_LIMIT_PER_WORKSPACE,
  workspaceDirectories,
  type ServiceLaunch,
  type ServicePolicy,
  type ServiceRecord
} from './services.js';
import { awaitChildExit, DEFAULT_FLUSH_GRACE_MS, killProcessTree } from './subprocess.js';

const BackgroundRequest = z.object({
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(100_000)).max(256).default([]),
  cwd: z.string().default('workspace'),
  env: z.record(z.string(), z.string()).default({}),
  timeoutSeconds: z.number().int().positive().max(86_400).default(3_600),
  stdin: z.string().max(10_000_000).optional(),
  network: z.boolean().default(false),
  maxOutputBytes: z
    .number()
    .int()
    .min(4_096)
    .max(20 * 1024 * 1024)
    .default(1024 * 1024),
  /*
   * Naming the service is what turns a background session into one the computer keeps running: the
   * name is the record the owner reads, so there is no way to declare a service without saying what
   * it is. A service ignores `timeoutSeconds` entirely - the hour was the bug.
   */
  service: z.string().min(1).max(120).optional()
});

type Status = 'running' | 'completed' | 'failed' | 'timed_out' | 'stopped';

interface Session {
  id: string;
  workspaceId: string;
  owner: string;
  command: string[];
  child: ChildProcessWithoutNullStreams;
  status: Status;
  stdout: Buffer;
  stderr: Buffer;
  maxOutputBytes: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timeout?: NodeJS.Timeout;
}

/** Everything needed to put a service's process back, held once per supervised service. */
interface Supervised {
  record: ServiceRecord;
  registry: ServiceRegistry;
  root: string;
  isolateNetwork: boolean;
  guards: Guards;
  restart?: NodeJS.Timeout;
  /** Set before a deliberate kill so the exit that follows is not read as a death to recover from. */
  retiring: boolean;
}

export interface Guards {
  limits?: CommandLimits | undefined;
  limiter?: string | undefined;
  sandbox?: AgentSandbox | undefined;
}

const appendBounded = (current: Buffer, chunk: Buffer, limit: number): Buffer => {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
};

export class ProcessManager {
  readonly #sessions = new Map<string, Session>();
  readonly #supervised = new Map<string, Supervised>();
  readonly #registries = new Map<string, ServiceRegistry>();
  readonly #flushGraceMs: number;
  readonly #policy: ServicePolicy;

  /**
   * How long a session that has exited waits for output still in its pipes before it reports a
   * terminal status. Defaulted, because the bound is a property of this rule rather than something
   * an operator tunes; it is a parameter only so a test can assert against a deadline it owns. The
   * service policy is a parameter for the same reason: five failures at the shipped backoff take a
   * minute of wall clock, and a test cannot own that.
   */
  constructor(
    flushGraceMs: number = DEFAULT_FLUSH_GRACE_MS,
    policy: ServicePolicy = DEFAULT_SERVICE_POLICY
  ) {
    this.#flushGraceMs = flushGraceMs;
    this.#policy = policy;
  }

  async start(
    workspaceRoot: string,
    workspaceId: string,
    owner: string,
    value: unknown,
    maximumSeconds: number,
    isolateNetwork: boolean,
    guards: Guards = {}
  ) {
    const request = BackgroundRequest.parse(value);
    const name = request.service;
    if (name !== undefined)
      return this.#declareService(workspaceRoot, workspaceId, owner, name, request, {
        isolateNetwork,
        guards
      });
    const session = await this.#launch(workspaceRoot, workspaceId, owner, request, {
      maximumSeconds,
      isolateNetwork,
      guards
    });
    return this.#view(session, false);
  }

  /**
   * Spawns one run. Shared by an ordinary background session and by every start and restart of a
   * service, so a service is subject to exactly the same refusals, sandbox, resource limits and
   * environment rules as the command an agent runs in front of you - there is no second, laxer path
   * onto this box for the things that outlive a turn.
   */
  async #launch(
    workspaceRoot: string,
    workspaceId: string,
    owner: string,
    request: z.infer<typeof BackgroundRequest>,
    options: {
      maximumSeconds?: number;
      isolateNetwork: boolean;
      guards: Guards;
      id?: string;
      onSettled?: (session: Session) => void;
    }
  ): Promise<Session> {
    const guards = options.guards;
    const searchPath = agentSearchPath(workspaceRoot);
    // Asked first, so a policy the caller believes it is applying is refused before anything runs.
    const environment = agentEnvironment(workspaceRoot, searchPath, request.env);
    const cwd = resolveInside(workspaceRoot, request.cwd);
    const resolved = await resolveExecutable(request.executable, searchPath, cwd);
    const asResolved = resolved ? { executable: resolved, args: request.args } : request;
    if (
      privilegeEscalationBinary(request) ??
      privilegeEscalationBinary(asResolved) ??
      packageManagerInvocation(request) ??
      packageManagerInvocation(asResolved) ??
      privilegedHelperInvocation(request, [guards.sandbox?.helper]) ??
      privilegedHelperInvocation(asResolved, [guards.sandbox?.helper])
    ) {
      throw new Error('Privilege and system-package operations cannot run as background processes');
    }
    // Outermost so the limits are inherited by the sandbox and everything it execs.
    const { executable, args } = limitedInvocation(
      guards.sandbox
        ? sandboxedInvocation(
            { executable: request.executable, args: request.args },
            environment,
            guards.sandbox,
            options.isolateNetwork && !request.network
          )
        : { executable: request.executable, args: request.args },
      guards.limits,
      guards.limiter
    );
    const child = spawn(executable, args, {
      cwd,
      env: guards.sandbox ? {} : environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Leads its own process group so stopping the session reaches grandchildren too.
      detached: true,
      shell: false
    });
    const id = options.id ?? `proc_${randomUUID()}`;
    const supervised = options.onSettled !== undefined;
    // A service has no deadline. That is the whole point of it: the hour was what made a link the
    // agent handed the owner stop answering by dinner.
    const timeout = supervised
      ? undefined
      : setTimeout(
          () => {
            const session = this.#sessions.get(id);
            if (!session || session.status !== 'running') return;
            session.status = 'timed_out';
            killProcessTree(child, 'SIGTERM');
            setTimeout(() => killProcessTree(child, 'SIGKILL'), 2_000).unref();
          },
          Math.min(request.timeoutSeconds, options.maximumSeconds ?? request.timeoutSeconds) * 1_000
        );
    timeout?.unref();
    const session: Session = {
      id,
      workspaceId,
      owner,
      command: [request.executable, ...request.args],
      child,
      status: 'running',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      maxOutputBytes: request.maxOutputBytes,
      startedAt: new Date().toISOString(),
      ...(timeout ? { timeout } : {})
    };
    this.#sessions.set(id, session);
    child.stdout.on('data', (chunk: Buffer) => {
      session.stdout = appendBounded(session.stdout, chunk, session.maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      session.stderr = appendBounded(session.stderr, chunk, session.maxOutputBytes);
    });
    // Settled on the drained exit rather than on 'exit' itself. The poll that reads a terminal
    // status is also the poll that reads the log, and whatever was still sitting in the pipes when
    // the process ended is exactly the tail a job's result is in - so reporting `completed` before
    // the flush hands the agent a truncated log and calls it the whole thing. The foreground path
    // has always waited for the drain; this is the same rule for a background session.
    const settle = (status: Status, exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) clearTimeout(timeout);
      session.exitCode = exitCode;
      session.signal = signal;
      session.finishedAt = new Date().toISOString();
      if (session.status === 'running') session.status = status;
      if (options.onSettled) {
        // A service's row must not be swept: it is the record the owner reads while the backoff
        // counts, and the next run replaces this entry under the same id.
        options.onSettled(session);
        return;
      }
      setTimeout(() => this.#sessions.delete(id), 60 * 60 * 1_000).unref();
    };
    void awaitChildExit(child, this.#flushGraceMs).then(
      ({ exitCode, signal }) => settle(exitCode === 0 ? 'completed' : 'failed', exitCode, signal),
      // A command that never started - a missing executable, an unexecutable file - emits 'error'
      // and no 'exit'. Without this the session would sit at `running` until its timeout killed a
      // process that was never there, and the agent would poll a job that could not finish.
      () => settle('failed', null, null)
    );
    if (request.stdin) child.stdin.write(request.stdin);
    return session;
  }

  // ---------------------------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------------------------

  #registry(root: string, workspaceId: string): ServiceRegistry {
    const existing = this.#registries.get(workspaceId);
    if (existing) return existing;
    const registry = new ServiceRegistry(root);
    this.#registries.set(workspaceId, registry);
    return registry;
  }

  async #declareService(
    root: string,
    workspaceId: string,
    owner: string,
    name: string,
    request: z.infer<typeof BackgroundRequest>,
    options: { isolateNetwork: boolean; guards: Guards }
  ) {
    const registry = this.#registry(root, workspaceId);
    if (registry.list().length === 0) await registry.load();
    if (registry.list().length >= SERVICE_LIMIT_PER_WORKSPACE)
      throw new Error(
        `This computer already keeps ${SERVICE_LIMIT_PER_WORKSPACE} services running. Stop one before starting another.`
      );
    const launch: ServiceLaunch = {
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      network: request.network,
      maxOutputBytes: request.maxOutputBytes
    };
    const record = newServiceRecord({ workspaceId, owner, name, launch });
    // Launched before it is written down, so a command this runner refuses outright - a privilege
    // escalation, a package manager, a cwd outside the workspace - throws here and never becomes a
    // record that every later boot tries five times. A binary that simply is not there cannot be
    // caught this way: spawn reports that asynchronously, on the 'error' event, so it is written
    // down first and then dies its way to `crash_looped`, which is the record the owner reads to
    // find out why the thing they asked for is not answering.
    const session = await this.#launch(root, workspaceId, owner, request, {
      isolateNetwork: options.isolateNetwork,
      guards: options.guards,
      id: record.id,
      onSettled: () => this.#serviceDied(record.id)
    });
    record.pid = session.child.pid;
    // The pid and the moment it was handed out, written together: `reclaimOrphan` reads them as one
    // fact, because a pid on its own stops meaning anything the instant the host reboots.
    record.startedAt = session.startedAt;
    this.#supervised.set(record.id, {
      record,
      registry,
      root,
      isolateNetwork: options.isolateNetwork,
      guards: options.guards,
      retiring: false
    });
    await registry.put(record);
    return this.#view(session, false);
  }

  #serviceDied(id: string): void {
    const supervised = this.#supervised.get(id);
    const session = this.#sessions.get(id);
    if (!supervised || !session) return;
    // A deliberate stop, a workspace-wide stop, or a shutdown. The process ending is the intended
    // outcome, not something to recover from.
    if (supervised.retiring) return;
    const record = supervised.record;
    const ranForMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
    record.lastExit = {
      at: session.finishedAt ?? new Date().toISOString(),
      exitCode: session.exitCode ?? null,
      signal: session.signal ?? null,
      reason: session.status
    };
    record.consecutiveFailures = nextFailureCount(
      ranForMs,
      record.consecutiveFailures,
      this.#policy
    );
    record.pid = undefined;
    if (givenUp(record.consecutiveFailures, this.#policy)) {
      // Stated rather than retried: the record stays so the owner can see what it was and how it
      // ended, and nothing restarts it until they say so.
      record.state = 'crash_looped';
      void supervised.registry.put(record);
      return;
    }
    record.state = 'restarting';
    void supervised.registry.put(record);
    const wait = setTimeout(
      () => void this.#relaunchService(id),
      restartDelayMs(record.consecutiveFailures, this.#policy)
    );
    wait.unref();
    supervised.restart = wait;
  }

  async #relaunchService(id: string): Promise<void> {
    const supervised = this.#supervised.get(id);
    if (!supervised || supervised.retiring) return;
    const record = supervised.record;
    delete supervised.restart;
    try {
      const session = await this.#launch(
        supervised.root,
        record.workspaceId,
        record.owner,
        { ...record.launch, timeoutSeconds: 3_600 },
        {
          isolateNetwork: supervised.isolateNetwork,
          guards: supervised.guards,
          id: record.id,
          onSettled: () => this.#serviceDied(record.id)
        }
      );
      record.restarts += 1;
      record.state = 'running';
      record.startedAt = session.startedAt;
      record.pid = session.child.pid;
      await supervised.registry.put(record);
    } catch (cause) {
      // A start that throws - the executable has gone, the workspace is unwritable - counts as a
      // death, so the same backoff and the same give-up cover it instead of ending supervision
      // silently on an exception nobody is waiting for.
      record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: cause instanceof Error ? cause.message.slice(0, 200) : 'could not start'
      };
      record.consecutiveFailures = nextFailureCount(0, record.consecutiveFailures, this.#policy);
      if (givenUp(record.consecutiveFailures, this.#policy)) {
        record.state = 'crash_looped';
        await supervised.registry.put(record);
        return;
      }
      record.state = 'restarting';
      await supervised.registry.put(record);
      const wait = setTimeout(
        () => void this.#relaunchService(id),
        restartDelayMs(record.consecutiveFailures, this.#policy)
      );
      wait.unref();
      supervised.restart = wait;
    }
  }

  /**
   * Everything this box was keeping running, put back. Called once as the runner comes up.
   *
   * What happens where:
   * - **Runner asked to stop** (`onClose`): every service is signalled on the way out, so nothing
   *   is left behind and this finds pids that are gone.
   * - **Runner crashed**: the children were detached and survive, reparented to init. `reclaimOrphan`
   *   recognises them by pid and command line, stops them, and this starts them again - because a
   *   process whose pipes died with the last runner cannot be adopted, only replaced.
   * - **Host rebooted**: the records are on disk and the pids are meaningless. Every recorded pid
   *   is either dead or a stranger's, `reclaimOrphan` leaves strangers alone, and each service is
   *   started fresh.
   * - **Workspace deleted**: the tree, and the record inside `.athanor` with it, is gone before
   *   this ever runs.
   */
  async resume(
    workspaceRoot: string,
    isolateNetwork: boolean,
    guards: Guards = {}
  ): Promise<number> {
    const root = path.resolve(workspaceRoot);
    const workspaces = await workspaceDirectories(root);
    const resumed = await Promise.all(
      workspaces.map((workspaceId) =>
        this.resumeWorkspace(path.join(root, workspaceId), workspaceId, isolateNetwork, guards)
      )
    );
    return resumed.reduce((sum, count) => sum + count, 0);
  }

  /**
   * The same restore for one workspace. Also used after a snapshot or checkpoint restore, which
   * stop long-running commands so nothing writes into the tree mid-rewind: without this, making a
   * recovery point would quietly take the owner's dashboard down for good.
   *
   * Returns how many services it took back under supervision, which is not the same as how many are
   * up: one whose binary has since been removed is counted here and then goes round its own backoff.
   */
  async resumeWorkspace(
    root: string,
    workspaceId: string,
    isolateNetwork: boolean,
    guards: Guards = {}
  ): Promise<number> {
    const registry = this.#registry(root, workspaceId);
    const records = await registry.load();
    if (records.length === 0) return 0;
    await ensureWorkspace(root);
    let started = 0;
    for (const record of records) {
      if (this.#supervised.has(record.id)) continue;
      await reclaimOrphan(record);
      // A give-up is not permanent across a restart: the runner coming back is a different
      // machine state, and five more attempts over a minute is a cheap way to be wrong about it.
      record.consecutiveFailures = 0;
      record.state = 'restarting';
      record.pid = undefined;
      this.#supervised.set(record.id, {
        record,
        registry,
        root,
        isolateNetwork,
        guards,
        retiring: false
      });
      await this.#relaunchService(record.id);
      started += 1;
    }
    return started;
  }

  /** Stopping a service forgets it. A service the owner stopped must not return with the runner. */
  #retireService(supervised: Supervised): void {
    supervised.retiring = true;
    if (supervised.restart) clearTimeout(supervised.restart);
    delete supervised.restart;
    this.#supervised.delete(supervised.record.id);
    void supervised.registry.remove(supervised.record.id);
  }

  // ---------------------------------------------------------------------------------------------

  list(workspaceId: string, owner: string) {
    return [...this.#sessions.values()]
      .filter((session) => session.workspaceId === workspaceId && session.owner === owner)
      .map((session) => this.#view(session, false));
  }

  /**
   * Every background process on this computer, whoever started it.
   *
   * `list` above is narrowed to one owner because an agent's capability is subject to its own task:
   * it must not poll, write to or kill a session belonging to a turn it is not running. The person
   * who owns the computer is in the opposite position, and the owner filter silently denied them
   * everything - the agent starts these sessions under its task id as the subject, so an
   * owner-scoped list handed the panel an empty array for a box with three servers running on it,
   * and "what is my computer doing" had no answer anywhere in the product. The workspace is the
   * boundary that matters here, and the capability token already carries it.
   */
  listWorkspace(workspaceId: string) {
    return [...this.#sessions.values()]
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => this.#view(session, false));
  }

  /**
   * `owner` is the task a capability is subject to, or null for the person who owns the box - the
   * same split `listWorkspace` makes above, for the same reason. Without the null case the owner
   * could see a service in their panel and had no way to stop it, because every service on the
   * machine is subject to whichever task happened to start it.
   */
  action(workspaceId: string, owner: string | null, id: string, value: unknown) {
    const request = z
      .object({
        action: z.enum(['poll', 'log', 'kill', 'write']),
        data: z.string().max(1_000_000).optional()
      })
      .parse(value);
    const session = this.#sessions.get(id);
    if (
      !session ||
      session.workspaceId !== workspaceId ||
      (owner !== null && session.owner !== owner)
    )
      throw new Error('Background process not found');
    if (request.action === 'kill') {
      const supervised = this.#supervised.get(id);
      if (supervised) this.#retireService(supervised);
      if (session.status === 'running') {
        session.status = 'stopped';
        killProcessTree(session.child, 'SIGTERM');
        setTimeout(() => killProcessTree(session.child, 'SIGKILL'), 2_000).unref();
      }
    }
    if (request.action === 'write') {
      if (session.status !== 'running') throw new Error('Background process is not running');
      session.child.stdin.write(request.data ?? '');
    }
    return this.#view(session, request.action === 'log' || request.action === 'poll');
  }

  /**
   * Shutdown. Every child is signalled, including services: they are detached process-group
   * leaders, so a runner that exits without this leaves them running with nobody holding their
   * pipes, and the next boot has to hunt them down by pid. The records stay on disk untouched -
   * that is what brings the services back.
   */
  close() {
    for (const supervised of this.#supervised.values()) {
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
    }
    this.#supervised.clear();
    for (const session of this.#sessions.values()) {
      if (session.timeout) clearTimeout(session.timeout);
      if (session.status === 'running') this.#stop(session);
    }
    this.#sessions.clear();
  }

  /**
   * Stop everything this workspace is running now. `forget` is for a workspace being deleted, where
   * the services should not come back either; a snapshot or a checkpoint restore passes it off and
   * calls `resumeWorkspace` once the tree is settled.
   */
  stopWorkspace(workspaceId: string, options: { forget?: boolean } = {}) {
    for (const [id, supervised] of this.#supervised) {
      if (supervised.record.workspaceId !== workspaceId) continue;
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
      this.#supervised.delete(id);
      if (options.forget) void supervised.registry.remove(id);
    }
    if (options.forget) this.#registries.delete(workspaceId);
    for (const [id, session] of this.#sessions) {
      if (session.workspaceId !== workspaceId) continue;
      if (session.timeout) clearTimeout(session.timeout);
      if (session.status === 'running') this.#stop(session);
      this.#sessions.delete(id);
    }
  }

  #stop(session: Session): void {
    killProcessTree(session.child, 'SIGTERM');
    setTimeout(() => killProcessTree(session.child, 'SIGKILL'), 2_000).unref();
  }

  #view(session: Session, includeLogs: boolean) {
    const supervised = this.#supervised.get(session.id);
    return {
      sessionId: session.id,
      status: session.status,
      command: session.command,
      startedAt: session.startedAt,
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      // The session's own status stays the truth about the process - a service in its backoff
      // reads `failed`, not `running`, because a row that claims a dead thing is alive is the bug
      // this primitive exists to end. `service` is the durable record beside it.
      ...(supervised ? { service: serviceView(supervised.record) } : {}),
      ...(includeLogs
        ? { stdout: session.stdout.toString('utf8'), stderr: session.stderr.toString('utf8') }
        : {})
    };
  }
}
