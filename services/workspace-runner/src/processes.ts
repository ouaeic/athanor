import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  boundedCollector,
  DISK_FLOOR_POLL_MS,
  HOST_DISK_FLOOR_NOTE,
  KILLED_NOTE,
  prepareInvocation,
  refuseUnreachableTimeout,
  stopProcessTree,
  timedOutNote,
  type ExecutionGuards
} from './execution.js';
import { ensureWorkspace } from './files.js';
import { belowHostStorageFloor, hostStorage as probeHostStorage } from './host-storage.js';
import { type AgentSandbox } from './sandbox.js';
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
import { awaitChildExit, DEFAULT_FLUSH_GRACE_MS } from './subprocess.js';

const BackgroundRequest = z.object({
  executable: z.string().min(1).max(4096),
  /** 8,192 for the reason `ExecRequest` states: a per-contig scatter is thousands of arguments. */
  args: z.array(z.string().max(100_000)).max(8_192).default([]),
  cwd: z.string().default('workspace'),
  env: z.record(z.string(), z.string()).default({}),
  /*
   * An hour by default and a day at the ceiling, which `MAX_BACKGROUND_SECONDS` now allows this
   * schema to actually mean. The DEFAULT stays an hour on purpose: it is what a caller that names
   * nothing gets, and a job with no stated deadline should not be able to hold a slot for a day by
   * omission. A long job says how long it is, and now it can be believed.
   */
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
  /**
   * Head, tail and a byte count, the same collector the foreground path uses. These were plain
   * Buffers holding only the tail, which is the shape a long job is worst served by.
   */
  stdout: OutputCollector;
  stderr: OutputCollector;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  timeout?: NodeJS.Timeout;
  /** The host-disk floor watch, cleared the moment the process is no longer writing to it. */
  diskFloor?: NodeJS.Timeout;
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

/**
 * The same guards the foreground path carries, plus the sandbox this path installs itself.
 *
 * They were two declarations, and the background copy was the one missing the host-disk floor -
 * which is the guard that matters most here, because this is the path with no deadline. A
 * background command runs for up to an hour and a service runs for ever, and the only disk check
 * either of them had was the pre-flight in the route, which proves the disk was healthy at the
 * moment the command started and says nothing about the command that is filling it.
 */
export interface Guards extends ExecutionGuards {
  sandbox?: AgentSandbox | undefined;
  /**
   * Where the root-owned system-package helper lives, so this path can refuse a command that names
   * it. Not so this path can use it: an install is refused here outright. The field exists because
   * the refusal is a check against a list of helper names, and for as long as this list was built
   * only from the arm of the policy that rewrites onto the helper, the background path did not know
   * the name to refuse. On a host with no sandbox helper - a laptop, which config.ts documents as
   * supported - the list was empty and `POST /processes/start` would happily run the helper, which
   * install-native.sh grants NOPASSWD sudo. Root, from a background start, with no capability scope
   * and no approval. The foreground path had refused exactly this since the helper existed.
   */
  systemPackageHelper?: string | undefined;
}

const StopOwnerRequest = z.object({ owner: z.string().min(1).max(256).optional() });

/**
 * Written into the stopped session's own log, because `process(poll)` is the only place an agent
 * ever finds out why a job it started is no longer running - the same reason the disk-floor stop
 * above states itself there. A process that simply dies on a signal reads to a model as a crash
 * worth retrying, and this one must not be retried: whoever it was working for has gone.
 */
export const OWNER_STOPPED_NOTE =
  'stopped: the task that started this background command is no longer running';

/**
 * What a cancellation confirmation says about the background work it just ended.
 *
 * The sentence belongs here rather than in the caller because the exemption is this file's rule. A
 * service is declared precisely so it outlives the turn, so cancelling a task deliberately leaves
 * it serving - and an owner who is told only "cancelled" reads that as everything having stopped.
 * They then close the tab on a dashboard that is still up, or wonder why a port they thought they
 * had freed is busy. Naming the services that are still running is the difference between an
 * exemption and a surprise.
 */
export const ownerStopNote = (stopped: number, services: string[]): string => {
  const ended =
    stopped === 0
      ? 'No background commands were running for this task.'
      : `Stopped ${stopped} background command${stopped === 1 ? '' : 's'}.`;
  if (services.length === 0) return ended;
  const named = services.map((name) => `"${name}"`).join(', ');
  return `${ended} The declared service${services.length === 1 ? '' : 's'} ${named} ${services.length === 1 ? 'is' : 'are'} still running: a service is meant to outlive the task that started it, so stopping one is its own action.`;
};

type OutputCollector = ReturnType<typeof boundedCollector>;

/** A runner-written sentence about why this session stopped, on the session's own stderr. */
const noteOnStderr = (session: Session, note: string): void => {
  session.stderr.push(Buffer.from(`\n${note}`));
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
    // Below the service branch because a service has no deadline at all, so the ceiling is not its
    // business. Everything else is answered before it starts rather than killed part-way through:
    // see `refuseUnreachableTimeout`, which is where the argument for refusing over clamping is.
    refuseUnreachableTimeout(value, maximumSeconds, true);
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
    // The refusals, the sandbox and the resource limiter, shared with the foreground path so a
    // service is subject to the same rules as a command an agent runs in front of you. The one
    // difference is stated in the policy rather than left implicit in a second copy of the checks:
    // a package manager is refused here, not rewritten onto the approved helper.
    const prepared = await prepareInvocation(workspaceRoot, request, {
      isolateNetwork: options.isolateNetwork,
      sandbox: guards.sandbox,
      limits: guards.limits,
      limiter: guards.limiter,
      // Refused, and named: refusing an install is not the same statement as refusing to be the
      // helper, and this path owes both.
      systemPackages: { mode: 'refused', helper: guards.systemPackageHelper }
    });
    const child = spawn(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Leads its own process group so stopping the session reaches grandchildren too.
      detached: true,
      shell: false
    });
    const id = options.id ?? `proc_${randomUUID()}`;
    const supervised = options.onSettled !== undefined;
    // A service has no deadline. That is the whole point of it: the hour was what made a link the
    // agent handed the owner stop answering by dinner.
    const allowedSeconds = Math.min(
      request.timeoutSeconds,
      options.maximumSeconds ?? request.timeoutSeconds
    );
    const timeout = supervised
      ? undefined
      : setTimeout(() => {
          const session = this.#sessions.get(id);
          if (!session || session.status !== 'running') return;
          session.status = 'timed_out';
          // The deadline states itself in the log, exactly as the disk floor and the owner's stop
          // do. This was the one stop on this path that left `status: "timed_out"` beside an empty
          // stderr, which reads to a model like a job that died for no reason it can name.
          noteOnStderr(
            session,
            timedOutNote(allowedSeconds, options.maximumSeconds ?? allowedSeconds, true)
          );
          stopProcessTree(child);
        }, allowedSeconds * 1_000);
    timeout?.unref();
    const session: Session = {
      id,
      workspaceId,
      owner,
      command: [request.executable, ...request.args],
      child,
      status: 'running',
      stdout: boundedCollector(request.maxOutputBytes),
      stderr: boundedCollector(request.maxOutputBytes),
      startedAt: new Date().toISOString(),
      ...(timeout ? { timeout } : {})
    };
    this.#sessions.set(id, session);
    /*
     * The floor, watched for as long as this process can write to the disk.
     *
     * The foreground path has polled free space since a `dd` took the box down; this path had the
     * pre-flight check in the route and nothing else, which only ever proved the disk was healthy
     * at the moment the command started - and the command is what fills it. A background `dd`, a
     * service that logs to a file, an `npm ci` in a service wrapper: each of them runs for up to an
     * hour, and a service runs with no deadline at all, with nothing watching. PostgreSQL shares
     * this filesystem, so reaching the last free byte stops the database, the interface and every
     * other task on the computer, not just the command that caused it.
     */
    const storageProbe = guards.hostStorage ?? probeHostStorage;
    let probing = false;
    const diskFloor = setInterval(() => {
      const current = this.#sessions.get(id);
      if (probing || !current || current.status !== 'running') return;
      probing = true;
      void storageProbe(workspaceRoot)
        .then((storage) => {
          if (!belowHostStorageFloor(storage) || current.status !== 'running') return;
          this.#stopOnDiskFloor(id, current);
        })
        .catch(() => undefined)
        .finally(() => {
          probing = false;
        });
    }, guards.hostStoragePollMs ?? DISK_FLOOR_POLL_MS);
    diskFloor.unref();
    session.diskFloor = diskFloor;
    child.stdout.on('data', (chunk: Buffer) => session.stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => session.stderr.push(chunk));
    // Settled on the drained exit rather than on 'exit' itself. The poll that reads a terminal
    // status is also the poll that reads the log, and whatever was still sitting in the pipes when
    // the process ended is exactly the tail a job's result is in - so reporting `completed` before
    // the flush hands the agent a truncated log and calls it the whole thing. The foreground path
    // has always waited for the drain; this is the same rule for a background session.
    const settle = (status: Status, exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timeout) clearTimeout(timeout);
      clearInterval(diskFloor);
      // The kernel's own stop, said here for the reason `KILLED_NOTE` gives - and guarded on the
      // status rather than on a flag, because the three stops this class performs all set it away
      // from 'running' before they kill, and all three of them kill with SIGKILL.
      if (signal === 'SIGKILL' && session.status === 'running') noteOnStderr(session, KILLED_NOTE);
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

  /**
   * What the runner does about a background process that is taking the last of the host disk.
   *
   * The session is stopped and the reason is appended to its own stderr, because `process(poll)` is
   * the only place the agent ever finds out why a job it started is no longer running - a process
   * that simply dies on a signal reads to the model as an unexplained crash it should retry, and
   * retrying is the one thing that must not happen while the disk is still full.
   *
   * A supervised service is retired first. Otherwise the death goes round the ordinary backoff and
   * the supervisor puts the thing that filled the disk straight back into the disk it filled,
   * every second or two, for as long as the owner takes to notice. The record stays on disk in
   * `crash_looped`, which is the state that means supervision has stopped and is telling the owner
   * so: they see what it was and how it ended, and the service comes back when the runner is next
   * restarted with room on the disk, rather than never.
   */
  #stopOnDiskFloor(id: string, session: Session): void {
    const supervised = this.#supervised.get(id);
    if (supervised) {
      supervised.retiring = true;
      if (supervised.restart) clearTimeout(supervised.restart);
      delete supervised.restart;
      const record = supervised.record;
      record.state = 'crash_looped';
      record.pid = undefined;
      record.lastExit = {
        at: new Date().toISOString(),
        exitCode: null,
        signal: null,
        reason: 'stopped: the host disk was down to its last free bytes'
      };
      void supervised.registry.put(record);
    }
    session.status = 'stopped';
    noteOnStderr(session, HOST_DISK_FLOOR_NOTE);
    this.#stop(session);
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
   *
   * The null case is narrowed to reading and stopping. `write` puts chosen bytes on the stdin of a
   * process belonging to some other task, which is the one thing here that could be turned into
   * cross-task influence; stopping and reading are what the owner's panel was widened for, and
   * neither can be aimed at another turn's reasoning.
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
      (owner !== null && session.owner !== owner) ||
      (owner === null && request.action === 'write')
    )
      throw new Error('Background process not found');
    if (request.action === 'kill') {
      const supervised = this.#supervised.get(id);
      if (supervised) this.#retireService(supervised);
      if (session.status === 'running') {
        session.status = 'stopped';
        this.#stop(session);
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
      if (session.diskFloor) clearInterval(session.diskFloor);
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
      if (session.diskFloor) clearInterval(session.diskFloor);
      if (session.status === 'running') this.#stop(session);
      this.#sessions.delete(id);
    }
  }

  /**
   * Everything one task left running in the background, stopped - and everything it declared to
   * outlive itself, left alone and named.
   *
   * Cancelling a task aborts whatever runner request is in flight, which covers `/exec` completely
   * and covers this path not at all: `processes/start` answers in milliseconds, so by the time the
   * owner presses Stop there is no request left to abort. The scraper the model started ran on for
   * the rest of its hour, writing into the workspace and making outbound requests attributed to
   * this computer, with the interface saying the task was cancelled. `coding_agent` had to poll
   * the task row and issue its own kill, which is the proof this general mechanism was missing.
   *
   * `subject` is the task a capability is subject to, or null for the person who owns the box - the
   * same split `list`/`listWorkspace` and `action` make. A task may only ever name itself: this
   * route would otherwise be the way round the boundary those two hold, letting one turn stop
   * another turn's work by asking. The owner is subject to no task and so must say which one they
   * mean, rather than having "everything" quietly assumed.
   *
   * Sessions are stopped where they stand rather than forgotten, unlike `stopWorkspace`: the row
   * stays so a poll reads `stopped` with the reason in its log, instead of the session vanishing.
   */
  stopOwner(workspaceId: string, subject: string | null, value: unknown) {
    const request = StopOwnerRequest.parse(value ?? {});
    if (subject !== null && request.owner !== undefined && request.owner !== subject)
      throw new Error('A task can only stop the background processes it started');
    const owner = subject ?? request.owner;
    if (owner === undefined)
      throw new Error('Stopping background processes requires which task they belong to');
    /*
     * Read from the supervision map rather than from the sessions, so a service counts as exempt
     * even in the window where it has no live session at all - between a death and its restart, or
     * after a resumed record whose first launch threw. Those are exactly the moments an owner is
     * most likely to be pressing Stop, and reporting nothing there would say the service was
     * stopped when supervision is still holding it.
     */
    const services = [...this.#supervised.values()]
      .filter(
        (supervised) =>
          supervised.record.workspaceId === workspaceId && supervised.record.owner === owner
      )
      .map((supervised) => supervised.record.name);
    const stopped: string[] = [];
    for (const [id, session] of this.#sessions) {
      if (session.workspaceId !== workspaceId || session.owner !== owner) continue;
      if (this.#supervised.has(id)) continue;
      if (session.status !== 'running') continue;
      if (session.timeout) clearTimeout(session.timeout);
      if (session.diskFloor) clearInterval(session.diskFloor);
      session.status = 'stopped';
      noteOnStderr(session, OWNER_STOPPED_NOTE);
      this.#stop(session);
      stopped.push(id);
    }
    return { stopped, services, note: ownerStopNote(stopped.length, services) };
  }

  #stop(session: Session): void {
    stopProcessTree(session.child);
  }

  /**
   * What a poll of this session says, and why two of these fields exist.
   *
   * `ranForMs` and `outputBytes` are here because a supervision loop was impossible without them.
   * Every field above them is fixed for the life of the session, so polling a job that is quietly
   * working - an alignment, a build, anything that writes to a file rather than to a terminal -
   * returned a byte-identical answer every time. The turn guard reads repeated identical tool
   * results as a model going in circles, and measured against the production expression it pushed
   * back at the fourth poll and stopped the turn at the eighth: the agent was stopped for watching
   * a six-hour job correctly, which is the one thing this primitive exists to let it do.
   *
   * Both advance, and they answer different questions. `ranForMs` says the job is still there;
   * `outputBytes` counts everything the job has ever produced, including what the collector has
   * dropped, so it distinguishes a job that is working silently from one that is progressing. They
   * are measured, not stored: elapsed comes from the timestamps this session already carried, and
   * the count from the collectors that already had it.
   */
  #view(session: Session, includeLogs: boolean) {
    const supervised = this.#supervised.get(session.id);
    const ranToMs = session.finishedAt ? Date.parse(session.finishedAt) : Date.now();
    return {
      sessionId: session.id,
      status: session.status,
      command: session.command,
      startedAt: session.startedAt,
      ranForMs: Math.max(0, ranToMs - Date.parse(session.startedAt)),
      outputBytes: session.stdout.bytes + session.stderr.bytes,
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      // The session's own status stays the truth about the process - a service in its backoff
      // reads `failed`, not `running`, because a row that claims a dead thing is alive is the bug
      // this primitive exists to end. `service` is the durable record beside it.
      ...(supervised ? { service: serviceView(supervised.record) } : {}),
      ...(includeLogs
        ? { stdout: session.stdout.text('stdout'), stderr: session.stderr.text('stderr') }
        : {})
    };
  }
}
