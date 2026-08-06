import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  packageManagerInvocation,
  privilegeEscalationBinary,
  privilegedHelperInvocation,
  resolveExecutable
} from './command-policy.js';
import { agentEnvironment, agentSearchPath } from './execution.js';
import { resolveInside } from './files.js';
import { limitedInvocation, type CommandLimits } from './limits.js';
import { sandboxedInvocation, type AgentSandbox } from './sandbox.js';
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
    .default(1024 * 1024)
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
  timeout: NodeJS.Timeout;
}

const appendBounded = (current: Buffer, chunk: Buffer, limit: number): Buffer => {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
};

export class ProcessManager {
  readonly #sessions = new Map<string, Session>();
  readonly #flushGraceMs: number;

  /**
   * How long a session that has exited waits for output still in its pipes before it reports a
   * terminal status. Defaulted, because the bound is a property of this rule rather than something
   * an operator tunes; it is a parameter only so a test can assert against a deadline it owns.
   */
  constructor(flushGraceMs: number = DEFAULT_FLUSH_GRACE_MS) {
    this.#flushGraceMs = flushGraceMs;
  }

  async start(
    workspaceRoot: string,
    workspaceId: string,
    owner: string,
    value: unknown,
    maximumSeconds: number,
    isolateNetwork: boolean,
    guards: {
      limits?: CommandLimits | undefined;
      limiter?: string | undefined;
      sandbox?: AgentSandbox | undefined;
    } = {}
  ) {
    const request = BackgroundRequest.parse(value);
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
            isolateNetwork && !request.network
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
    const id = `proc_${randomUUID()}`;
    const timeout = setTimeout(
      () => {
        const session = this.#sessions.get(id);
        if (!session || session.status !== 'running') return;
        session.status = 'timed_out';
        killProcessTree(child, 'SIGTERM');
        setTimeout(() => killProcessTree(child, 'SIGKILL'), 2_000).unref();
      },
      Math.min(request.timeoutSeconds, maximumSeconds) * 1_000
    );
    timeout.unref();
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
      timeout
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
      clearTimeout(timeout);
      session.exitCode = exitCode;
      session.signal = signal;
      session.finishedAt = new Date().toISOString();
      if (session.status === 'running') session.status = status;
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
    return this.#view(session, false);
  }

  list(workspaceId: string, owner: string) {
    return [...this.#sessions.values()]
      .filter((session) => session.workspaceId === workspaceId && session.owner === owner)
      .map((session) => this.#view(session, false));
  }

  action(workspaceId: string, owner: string, id: string, value: unknown) {
    const request = z
      .object({
        action: z.enum(['poll', 'log', 'kill', 'write']),
        data: z.string().max(1_000_000).optional()
      })
      .parse(value);
    const session = this.#sessions.get(id);
    if (!session || session.workspaceId !== workspaceId || session.owner !== owner)
      throw new Error('Background process not found');
    if (request.action === 'kill' && session.status === 'running') {
      session.status = 'stopped';
      killProcessTree(session.child, 'SIGTERM');
      setTimeout(() => killProcessTree(session.child, 'SIGKILL'), 2_000).unref();
    }
    if (request.action === 'write') {
      if (session.status !== 'running') throw new Error('Background process is not running');
      session.child.stdin.write(request.data ?? '');
    }
    return this.#view(session, request.action === 'log' || request.action === 'poll');
  }

  close() {
    for (const session of this.#sessions.values()) {
      clearTimeout(session.timeout);
      if (session.status === 'running') this.#stop(session);
    }
    this.#sessions.clear();
  }

  stopWorkspace(workspaceId: string) {
    for (const [id, session] of this.#sessions) {
      if (session.workspaceId !== workspaceId) continue;
      clearTimeout(session.timeout);
      if (session.status === 'running') this.#stop(session);
      this.#sessions.delete(id);
    }
  }

  #stop(session: Session): void {
    killProcessTree(session.child, 'SIGTERM');
    setTimeout(() => killProcessTree(session.child, 'SIGKILL'), 2_000).unref();
  }

  #view(session: Session, includeLogs: boolean) {
    return {
      sessionId: session.id,
      status: session.status,
      command: session.command,
      startedAt: session.startedAt,
      ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
      ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
      ...(session.signal !== undefined ? { signal: session.signal } : {}),
      ...(includeLogs
        ? { stdout: session.stdout.toString('utf8'), stderr: session.stderr.toString('utf8') }
        : {})
    };
  }
}
