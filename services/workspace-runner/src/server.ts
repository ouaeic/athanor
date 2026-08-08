import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { z } from 'zod';
import {
  BrowserAction,
  DesktopAction,
  DesktopHolder,
  DesktopLaunchRequest,
  WebFetchRequest
} from '@athanor/contracts';
import { reservedPreviewPorts } from '@athanor/core';
import { authenticateRunnerRequest, requireScope } from './auth.js';
import { BotWallError, BrowserManager, type BrowserStreamState } from './browser.js';
import { WorkspaceCheckpoints } from './checkpoints.js';
import type { RunnerConfig } from './config.js';
import { DesktopManager, type DesktopStreamState } from './desktop.js';
import { agentSearchPath, execute } from './execution.js';
import { assertHostStorageWrite, hostStorage } from './host-storage.js';
import { commandLimits, resolveCommandLimiter } from './limits.js';
import { ProcessManager } from './processes.js';
import { resolveAgentSandbox, sandboxedInvocation, sandboxedShell } from './sandbox.js';
import {
  assertUserDataPath,
  createWorkspaceFolder,
  ensureWorkspace,
  deleteWorkspaceFile,
  listFiles,
  readWorkspaceFile,
  readWorkspaceFileLines,
  renameWorkspaceEntry,
  workspacePath,
  workspaceUsage,
  writeWorkspaceFile,
  WorkspaceFileError
} from './files.js';
import { probeBinaries, toolchainReport } from './toolchain.js';
import {
  checkPreviewPort,
  previewPort,
  previewRequestHeaders,
  previewResponseHeaders,
  previewTarget
} from './preview.js';
import { SEARCH_RESULT_LIMIT } from './search.js';
import {
  createSnapshot,
  deleteAllSnapshots,
  deleteSnapshot,
  restoreSnapshot
} from './snapshots.js';

/**
 * What was wrong with a request, in a sentence somebody can act on.
 *
 * Zod's own `message` is the issue array pretty-printed as JSON, and that string travelled all the
 * way to the conversation, where the owner read it. This says the same thing in the form the model
 * needs to correct itself and the owner needs to understand: which field, and what it should have
 * been. Bounded, because a malformed body can raise a hundred issues and the first few are the ones
 * that matter.
 */
export const sayWhatIsWrong = (error: z.ZodError): string => {
  const shown = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message.toLowerCase()}`);
  const rest = error.issues.length - shown.length;
  return `Invalid request - ${shown.join('; ')}${rest > 0 ? ` (and ${rest} more)` : ''}`;
};

const WorkspaceRelativePath = z.string().min(1).max(1_024);

const FolderRequest = z.object({ path: WorkspaceRelativePath });
const RenameRequest = z.object({ from: WorkspaceRelativePath, to: WorkspaceRelativePath });
const BinaryProbeRequest = z.object({
  binaries: z.array(z.string().min(1).max(120)).min(1).max(64)
});
const ReadElementsRequest = z.object({
  /** Scopes the read to one form or panel; omitted, it reads the whole page as a snapshot would. */
  selector: z.string().min(1).max(1_024).optional(),
  tabId: z.string().min(1).max(32).optional()
});
const WebSearchRequest = z.object({
  query: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(SEARCH_RESULT_LIMIT).default(SEARCH_RESULT_LIMIT)
});
const PrintPdfRequest = z.object({
  path: WorkspaceRelativePath,
  format: z.enum(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']).default('A4'),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  tabId: z.string().min(1).max(32).optional()
});

/** A query value that has to be a count. Anything else is treated as if it had not been sent. */
const positiveQueryInteger = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const contentTypeFor = (requestedPath: string): string =>
  ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
  })[path.extname(requestedPath).toLowerCase()] ?? 'application/octet-stream';

export const buildServer = async (config: RunnerConfig) => {
  const app = Fastify({ logger: false, bodyLimit: config.MAX_FILE_BYTES });
  const sandbox = await resolveAgentSandbox(config.AGENT_SANDBOX_HELPER);
  const privilegedHelpers = [config.SYSTEM_PACKAGE_HELPER, sandbox?.helper];
  const desktop = new DesktopManager(
    config.DESKTOP_BRIDGE_EXECUTABLE,
    config.DESKTOP_SESSION_EXECUTABLE,
    privilegedHelpers
  );
  // The browser runs on the workspace's own X server when there is one, so a page sees an
  // ordinary desktop and a person taking over finds the browser on the screen they are watching.
  const browser = new BrowserManager({
    executablePath: config.BROWSER_EXECUTABLE_PATH,
    desktopDisplay: config.BROWSER_USE_DESKTOP_DISPLAY
      ? (workspaceId, root) => desktop.displayEnvironment(workspaceId, root)
      : undefined,
    maxFileBytes: config.MAX_FILE_BYTES
  });
  const processes = new ProcessManager();
  const checkpoints = new WorkspaceCheckpoints({
    workspaceRoot: config.WORKSPACE_ROOT,
    btrfsExecutable: config.CHECKPOINT_BTRFS_EXECUTABLE,
    zfsExecutable: config.CHECKPOINT_ZFS_EXECUTABLE,
    packageManifestPath: config.CHECKPOINT_PACKAGE_MANIFEST,
    includeBrowserProfile: config.CHECKPOINT_INCLUDE_BROWSER_PROFILE,
    retainTurns: config.CHECKPOINT_RETAIN_TURNS,
    retainDailyDays: config.CHECKPOINT_RETAIN_DAILY_DAYS,
    maxFiles: config.CHECKPOINT_MAX_FILES,
    maxFileBytes: config.CHECKPOINT_MAX_FILE_BYTES
  });
  const authenticate = authenticateRunnerRequest(config.RUNNER_SHARED_SECRET);
  const limits = commandLimits(config, totalmem());
  const limiter = await resolveCommandLimiter(config.RESOURCE_LIMIT_EXECUTABLE);
  const guards = { limits, limiter, sandbox };
  const reservedPorts = reservedPreviewPorts({
    ports: [config.RUNNER_PORT, ...config.RESERVED_PREVIEW_PORTS]
  });
  if (!limiter && process.platform === 'linux') {
    // Worth saying out loud: on Linux the limiter is expected to exist, and without it a single
    // command can take the memory and the process table the rest of the computer needs.
    console.warn(
      `athanor runner: ${config.RESOURCE_LIMIT_EXECUTABLE} is missing, so commands run without memory, file-size and process limits. Install util-linux to restore them.`
    );
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(websocket);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id ?? randomUUID());
    const message = error instanceof Error ? error.message : 'Workspace runtime request failed';
    // A challenge is the one failure whose answer is a person, so it crosses the wire as data: the
    // worker needs the vendor, the site and the tab to raise it with the owner and to offer them
    // the takeover, and none of that survives being read back out of a sentence.
    if (error instanceof BotWallError) {
      void reply.status(409).send({
        error: { code: 'browser_bot_wall', message, requestId, botWall: error.wall }
      });
      return;
    }
    // A schema failure, said as a sentence.
    //
    // `ZodError.message` is a getter that returns `JSON.stringify(issues, null, 2)`. That message
    // was forwarded verbatim, rebuilt into the worker's error, written to the task event and
    // rendered in the conversation - so a model that passed `args` as a string put a page of issue
    // objects in front of the owner. This sits ahead of the generic branch so it covers every
    // `.parse()` in the runner rather than the one that was noticed.
    if (error instanceof z.ZodError) {
      void reply
        .status(400)
        .send({
          error: { code: 'runner_invalid_request', message: sayWhatIsWrong(error), requestId }
        });
      return;
    }
    void reply
      .status(
        error instanceof WorkspaceFileError
          ? error.status
          : message.includes('Capability')
            ? 403
            : message.includes('Storage quota') || message.includes('Host disk')
              ? 507
              : 400
      )
      .send({
        error: { code: 'runner_request_failed', message, requestId }
      });
  });

  const storageUsage = async (root: string): Promise<number> =>
    (
      await Promise.all(
        ['workspace', '.athanor/artifacts', '.athanor/browser'].map((relative) =>
          workspaceUsage(path.join(root, relative))
        )
      )
    ).reduce((sum, bytes) => sum + bytes, 0);
  const ensureRuntimeWorkspace = async (root: string): Promise<void> => {
    await ensureWorkspace(root);
  };

  // Loopback only, and deliberately says what the sandbox is actually doing: an operator - and a
  // control plane that tells the owner an agent shell is confined - has to be able to check.
  app.get('/healthz', async () => ({
    ok: true,
    service: 'workspace-runner',
    agentSandbox: Boolean(sandbox),
    agentNetworkIsolated: config.ISOLATE_AGENT_NETWORK
  }));

  app.addHook('preHandler', async (request) => {
    if (request.routeOptions.url === '/healthz') return;
    await authenticate(request);
  });

  app.put<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId', async (request) => {
    requireScope(request, 'workspace.manage');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureRuntimeWorkspace(root);
    return { id: request.params.workspaceId, state: 'running', root };
  });

  /**
   * Deleting a workspace takes both accounts, because the tree is split between them on purpose.
   * The runner owns `.athanor` at a mode the agent cannot traverse, which is what keeps an agent
   * away from its own checkpoints; the agent in turn owns whatever its programs left under its
   * home, some of it at modes the runner cannot traverse. `~/.cache` is the everyday case - GLib
   * creates it with an explicit 0700, so neither a umask nor a pre-created parent changes it, and
   * a workspace that had ever opened a GUI program could not be deleted at all.
   *
   * So the agent clears what it owns and the runner finishes. This grants nothing new: the agent
   * could always delete its own files. It is best-effort by design - the pass ends on the first
   * thing the agent may not touch, and the runner's own removal below is what actually decides
   * whether the workspace is gone, and what reports the failure if it is not.
   */
  const clearAgentOwnedFiles = async (root: string): Promise<void> => {
    if (!sandbox) return;
    const invocation = sandboxedInvocation(
      { executable: '/bin/rm', args: ['-rf', '--', root] },
      { PATH: '/usr/bin:/bin' },
      sandbox,
      false
    );
    await new Promise<void>((resolve) => {
      const child = spawn(invocation.executable, invocation.args, {
        shell: false,
        stdio: 'ignore'
      });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    });
  };

  app.delete<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId',
    async (request, reply) => {
      requireScope(request, 'workspace.manage');
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      processes.stopWorkspace(request.params.workspaceId);
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await clearAgentOwnedFiles(root);
      await rm(root, { recursive: true, force: true });
      await deleteAllSnapshots(config.WORKSPACE_ROOT, request.params.workspaceId);
      await checkpoints.deleteAll(request.params.workspaceId);
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      processes.stopWorkspace(request.params.workspaceId);
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      return createSnapshot({
        snapshotExecutable: config.SNAPSHOT_EXECUTABLE,
        workspaceRoot: config.WORKSPACE_ROOT,
        root,
        workspaceId: request.params.workspaceId,
        snapshotId: request.body.snapshotId
      });
    }
  );

  app.delete<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId',
    async (request, reply) => {
      requireScope(request, 'workspace.manage');
      await deleteSnapshot({
        workspaceRoot: config.WORKSPACE_ROOT,
        workspaceId: request.params.workspaceId,
        snapshotId: request.params.snapshotId
      });
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId/restore',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      processes.stopWorkspace(request.params.workspaceId);
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      await restoreSnapshot({
        snapshotExecutable: config.SNAPSHOT_EXECUTABLE,
        workspaceRoot: config.WORKSPACE_ROOT,
        root,
        workspaceId: request.params.workspaceId,
        snapshotId: request.params.snapshotId
      });
      return { restored: true };
    }
  );

  // Turn checkpoints are a different, cheaper thing than the named recovery points above: no
  // archive, no headroom for a second copy of the workspace, and one per turn rather than one when
  // the owner asks. They share nothing but the workspace they protect.
  app.post<{
    Params: { workspaceId: string };
    Body: { checkpointId: string; taskId?: string; turn?: number };
  }>('/v1/workspaces/:workspaceId/checkpoints', async (request) => {
    requireScope(request, 'workspace.manage');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureRuntimeWorkspace(root);
    const created = await checkpoints.create(request.params.workspaceId, root, {
      checkpointId: request.body.checkpointId,
      taskId: request.body.taskId ?? null,
      turn: request.body.turn ?? 0
    });
    const { deleted } = await checkpoints.prune(request.params.workspaceId);
    return { ...created, pruned: deleted };
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints',
    async (request) => {
      requireScope(request, 'workspace.manage');
      return { checkpoints: await checkpoints.list(request.params.workspaceId) };
    }
  );

  app.get<{ Params: { workspaceId: string; checkpointId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/preview',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return checkpoints.preview(request.params.workspaceId, root, request.params.checkpointId);
    }
  );

  app.post<{ Params: { workspaceId: string; checkpointId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints/:checkpointId/restore',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      // Long-running commands are stopped because a build writing into the tree mid-restore would
      // leave a mixture of both states. The browser and the desktop are deliberately left running:
      // their profiles are outside what a checkpoint covers, so a rewind cannot disturb them.
      processes.stopWorkspace(request.params.workspaceId);
      return checkpoints.restore(request.params.workspaceId, root, request.params.checkpointId);
    }
  );

  app.delete<{ Params: { workspaceId: string; checkpointId: string } }>(
    '/v1/workspaces/:workspaceId/checkpoints/:checkpointId',
    async (request, reply) => {
      requireScope(request, 'workspace.manage');
      await checkpoints.delete(request.params.workspaceId, request.params.checkpointId);
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/exec',
    async (request, reply) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      // Every byte a command writes used to bypass the disk guard, which only covered the file
      // upload route. Refusing to start is the cheap half; execute() also watches the floor while
      // the command runs, because a command that fills the disk does it after this check.
      await assertHostStorageWrite(root);
      // A worker that abandons the request has been cancelled or has died. Either way nobody will
      // ever read this command's result, so it must not keep running - and keep acting on the box.
      const disconnected = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) disconnected.abort();
      });
      return execute(root, request.body, {
        maximumSeconds: config.MAX_EXECUTION_SECONDS,
        isolateNetwork: request.capability.role === 'agent' && config.ISOLATE_AGENT_NETWORK,
        allowSystemPackages: request.capability.scopes.includes('system.packages'),
        systemPackageHelper: config.SYSTEM_PACKAGE_HELPER,
        sandbox,
        abortSignal: disconnected.signal,
        guards
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes/start',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      await assertHostStorageWrite(root);
      return processes.start(
        root,
        request.params.workspaceId,
        request.capability.sub,
        request.body,
        config.MAX_EXECUTION_SECONDS,
        request.capability.role === 'agent' && config.ISOLATE_AGENT_NETWORK,
        guards
      );
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes',
    async (request) => {
      requireScope(request, 'exec');
      return { processes: processes.list(request.params.workspaceId, request.capability.sub) };
    }
  );

  app.post<{ Params: { workspaceId: string; sessionId: string } }>(
    '/v1/workspaces/:workspaceId/processes/:sessionId',
    async (request) => {
      requireScope(request, 'exec');
      return processes.action(
        request.params.workspaceId,
        request.capability.sub,
        request.params.sessionId,
        request.body
      );
    }
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/v1/workspaces/:workspaceId/files',
    async (request) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return { entries: await listFiles(root, assertUserDataPath(root, request.query.path)) };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/usage',
    async (request) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const storageBytes = await storageUsage(root);
      return { storageBytes, ...(await hostStorage(root)) };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/export',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const archive = spawn(
        config.TAR_EXECUTABLE,
        [
          '--create',
          '--gzip',
          '--file=-',
          '--format=pax',
          '--numeric-owner',
          '--directory',
          root,
          'workspace',
          '.athanor/artifacts'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], shell: false }
      );
      archive.once('error', (error) => archive.stdout.destroy(error));
      archive.once('exit', (code) => {
        if (code !== 0) archive.stdout.destroy(new Error('Workspace archive process failed'));
      });
      reply.raw.once('close', () => {
        if (!archive.killed) archive.kill('SIGTERM');
      });
      return reply
        .type('application/gzip')
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          `attachment; filename="athanor-workspace-${request.params.workspaceId}.tar.gz"`
        )
        .send(archive.stdout);
    }
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: { path: string; startLine?: string; endLine?: string; maxBytes?: string };
  }>('/v1/workspaces/:workspaceId/file', async (request, reply) => {
    requireScope(request, 'files.read');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    const requestedPath = assertUserDataPath(root, request.query.path);
    // A caller that names a budget is asking for a window rather than the file, and gets it without
    // the file being read. The ceiling is the same one an unbounded read has, so asking for a
    // window can never cost the runner more than asking for everything already could.
    const maxBytes = positiveQueryInteger(request.query.maxBytes);
    try {
      if (maxBytes !== undefined) {
        const window = await readWorkspaceFileLines(root, requestedPath, {
          startLine: positiveQueryInteger(request.query.startLine) ?? 1,
          endLine: positiveQueryInteger(request.query.endLine) ?? Number.MAX_SAFE_INTEGER,
          maxBytes: Math.min(maxBytes, config.MAX_FILE_BYTES)
        });
        reply.headers({
          'x-start-line': String(window.startLine),
          'x-end-line': String(window.endLine),
          'x-file-bytes': String(window.sizeBytes),
          'x-truncated': String(window.truncated),
          ...(window.totalLines === undefined
            ? {}
            : { 'x-total-lines': String(window.totalLines) }),
          ...(window.nextStartLine === undefined
            ? {}
            : { 'x-next-start-line': String(window.nextStartLine) })
        });
        return reply.type(contentTypeFor(requestedPath)).send(window.content);
      }
      const file = await readWorkspaceFile(root, requestedPath, config.MAX_FILE_BYTES);
      reply.header('x-content-sha256', file.sha256);
      return reply.type(contentTypeFor(requestedPath)).send(file.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return reply.status(404).send({
          error: { code: 'file_not_found', message: 'Workspace file not found' }
        });
      throw error;
    }
  });

  app.put<{
    Params: { workspaceId: string };
    Querystring: { path: string; expectSha256?: string };
  }>('/v1/workspaces/:workspaceId/file', async (request) => {
    requireScope(request, 'files.write');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    await ensureRuntimeWorkspace(root);
    const requestedPath = assertUserDataPath(root, request.query.path);
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    await assertHostStorageWrite(root, body.length);
    // The caller's claim about what it is replacing, checked under the write's own descriptor.
    const expected = (request.query.expectSha256 ?? '').trim();
    return writeWorkspaceFile(
      root,
      requestedPath,
      body,
      config.MAX_FILE_BYTES,
      expected || undefined
    );
  });

  app.delete<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await deleteWorkspaceFile(root, assertUserDataPath(root, request.query.path));
      return reply.status(204).send();
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { path?: unknown } }>(
    '/v1/workspaces/:workspaceId/files/folder',
    async (request) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const requested = FolderRequest.parse(request.body);
      return createWorkspaceFolder(root, assertUserDataPath(root, requested.path));
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { from?: unknown; to?: unknown } }>(
    '/v1/workspaces/:workspaceId/files/rename',
    async (request) => {
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const requested = RenameRequest.parse(request.body);
      return renameWorkspaceEntry(
        root,
        assertUserDataPath(root, requested.from),
        assertUserDataPath(root, requested.to)
      );
    }
  );

  // What this computer can actually do with documents, probed rather than assumed. A procedure
  // that names a binary the box does not have is worse than no procedure at all, so this is the
  // route that lets the agent find out before it starts instead of one failed call at a time.
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/toolchain',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return toolchainReport(root);
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { binaries?: unknown } }>(
    '/v1/workspaces/:workspaceId/toolchain/probe',
    async (request) => {
      requireScope(request, 'exec');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const requested = BinaryProbeRequest.parse(request.body);
      const present = await probeBinaries(root, requested.binaries);
      return {
        present: requested.binaries.filter((name) => present.has(name)),
        missing: requested.binaries.filter((name) => !present.has(name))
      };
    }
  );

  const previewRoute = '/v1/workspaces/:workspaceId/preview/:port/*';
  app.get<{ Params: { workspaceId: string; port: string } }>(
    '/v1/workspaces/:workspaceId/preview-check/:port',
    async (request) => {
      const port = previewPort(request.params.port, reservedPorts);
      requireScope(request, `preview:${port}`);
      return { port, available: await checkPreviewPort(port, reservedPorts) };
    }
  );
  const proxyPreview = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { workspaceId: string; port: string; '*': string };
    const port = previewPort(params.port, reservedPorts);
    requireScope(request, `preview:${port}`);
    const target = previewTarget(port, params['*'], request.raw.url ?? '/', reservedPorts);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : Buffer.isBuffer(request.body)
        ? request.body
        : request.body === undefined
          ? undefined
          : Buffer.from(
              typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
            );
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers: previewRequestHeaders(request.headers),
        ...(body ? { body: Uint8Array.from(body).buffer } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000)
      });
    } catch {
      /*
       * A page, because a person is looking at it.
       *
       * Everything else this service answers is read by the worker, so JSON is right for it - but
       * these bytes go through the preview gateway to a browser, unchanged. The owner opened the
       * link they were given and got `{"error":{"code":"preview_unavailable",…}}` rendered as text.
       * The gateway's own two failure pages are HTML for exactly this reason; this one was the odd
       * one out because it is raised a layer further down.
       */
      return reply
        .status(502)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><title>Nothing is listening</title><h1>Nothing is listening</h1><p>The app on port ${port} is not answering. It may have stopped, or never started - ask athanor to start it again.</p>`
        );
    }
    reply.status(response.status);
    const cookies: string[] = [];
    for (const [name, value] of previewResponseHeaders(response.headers)) {
      if (name.toLowerCase() === 'set-cookie') cookies.push(value);
      else reply.header(name, value);
    }
    if (cookies.length) reply.header('set-cookie', cookies);
    if (request.method === 'HEAD' || !response.body) return reply.send();
    return reply.send(Buffer.from(await response.arrayBuffer()));
  };
  const proxyPreviewSocket = (socket: WebSocket, request: FastifyRequest) => {
    const params = request.params as { workspaceId: string; port: string; '*': string };
    let port: number;
    try {
      port = previewPort(params.port, reservedPorts);
      requireScope(request, `preview:${port}`);
    } catch {
      socket.close(1008, 'Preview capability required');
      return;
    }
    const target = previewTarget(port, params['*'], request.raw.url ?? '/', reservedPorts);
    target.protocol = 'ws:';
    const protocols =
      request.headers['sec-websocket-protocol']
        ?.split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== 'athanor-capability') ?? [];
    const headers = previewRequestHeaders(request.headers);
    const upstream = protocols.length
      ? new WebSocket(target, protocols, { headers })
      : new WebSocket(target, { headers });
    upstream.on('message', (data, binary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
    });
    upstream.on('close', (code, reason) => socket.close(code, reason.toString()));
    upstream.on('error', () => socket.close(1011, 'Preview service unavailable'));
    socket.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    socket.on('close', () => upstream.close());
  };
  app.route({
    method: 'GET',
    url: previewRoute,
    handler: proxyPreview,
    wsHandler: proxyPreviewSocket
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: previewRoute,
    handler: proxyPreview
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/snapshot',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return browser.snapshot(
        request.params.workspaceId,
        root,
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  // Reading the controls of one form without a screenshot, so checking that thirty fields hold
  // what was typed costs thirty cheap reads rather than thirty full snapshots.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/elements',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return browser.readElements(
        request.params.workspaceId,
        root,
        ReadElementsRequest.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/print-pdf',
    async (request) => {
      requireScope(request, 'browser.read');
      requireScope(request, 'files.write');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      const input = PrintPdfRequest.parse(request.body);
      await assertHostStorageWrite(root);
      return browser.printPdf(
        request.params.workspaceId,
        root,
        input,
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/read-many',
    async (request) => {
      requireScope(request, 'browser.read');
      const input = WebFetchRequest.parse(request.body);
      return browser.readMany(input.urls, input.maxCharactersPerPage);
    }
  );

  // Search as a call rather than as a browsing procedure: the engine's own results page, read on
  // this side, so the model gets ten titles, links and snippets instead of a screenshot of them.
  // It answers from a browser of its own, so unlike every other route here it neither needs the
  // workspace's session browser nor a runtime workspace on disk to have been prepared for it.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/search',
    async (request) => {
      requireScope(request, 'browser.read');
      return browser.search(
        request.params.workspaceId,
        WebSearchRequest.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/preflight',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return browser.preflight(
        request.params.workspaceId,
        root,
        BrowserAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/action',
    async (request) => {
      requireScope(request, 'browser.control');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return browser.act(
        request.params.workspaceId,
        root,
        BrowserAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent',
        request.capability.scopes.includes('browser.consequential')
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/browser/holder', async (request) => {
    requireScope(request, 'browser.takeover');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    return browser.setHolder(request.params.workspaceId, root, request.body.holder);
  });

  app.get('/v1/workspaces/:workspaceId/browser/stream', { websocket: true }, (socket, request) => {
    requireScope(request, 'browser.read');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    let unsubscribe: (() => Promise<void>) | undefined;
    const sendState = (state: BrowserStreamState) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: 'state', state, protocol: 'chromium-screencast-v1' }));
    };
    const sendError = (requestId: string | undefined, cause: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'control_error',
          ...(requestId ? { requestId } : {}),
          message: cause instanceof Error ? cause.message : 'Browser control failed'
        })
      );
    };
    const expiresIn = Math.max(1, request.capability.exp * 1000 - Date.now());
    const expiry = setTimeout(() => socket.close(1008, 'Capability expired'), expiresIn);
    void ensureRuntimeWorkspace(root)
      .then(() =>
        browser.subscribeStream(workspaceId, root, {
          state: sendState,
          frame: (frame, state) => {
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount >= 2 * 1024 * 1024)
              return;
            sendState(state);
            socket.send(frame, { binary: true });
          }
        })
      )
      .then((stop) => {
        unsubscribe = stop;
      })
      .catch(() => socket.close(1011, 'Workspace unavailable'));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      void (async () => {
        let message: {
          type?: string;
          requestId?: string;
          holder?: 'agent' | 'user' | 'secure_input';
          action?: unknown;
        } = {};
        try {
          const serialized = Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw)).toString('utf8')
              : raw.toString('utf8');
          message = JSON.parse(serialized) as typeof message;
          if (message.type === 'holder') {
            requireScope(request, 'browser.takeover');
            if (!['agent', 'user', 'secure_input'].includes(message.holder ?? ''))
              throw new Error('Invalid browser holder');
            await browser.setHolder(workspaceId, root, message.holder!);
          } else if (message.type === 'action') {
            requireScope(request, 'browser.control');
            await browser.act(workspaceId, root, BrowserAction.parse(message.action), 'user');
          } else throw new Error('Unsupported browser control message');
          if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: 'control_ack', requestId: message.requestId }));
        } catch (cause) {
          sendError(message?.requestId, cause);
        }
      })();
    });
    socket.on('close', () => {
      clearTimeout(expiry);
      void unsubscribe?.();
    });
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/snapshot',
    async (request) => {
      requireScope(request, 'desktop.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return desktop.snapshot(
        request.params.workspaceId,
        root,
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/launch',
    async (request) => {
      requireScope(request, 'desktop.control');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return desktop.launch(
        request.params.workspaceId,
        root,
        DesktopLaunchRequest.parse(request.body)
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/preflight',
    async (request) => {
      requireScope(request, 'desktop.read');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return desktop.preflight(
        request.params.workspaceId,
        root,
        DesktopAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent'
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/action',
    async (request) => {
      requireScope(request, 'desktop.control');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return desktop.act(
        request.params.workspaceId,
        root,
        DesktopAction.parse(request.body),
        request.capability.role === 'user' ? 'user' : 'agent',
        request.capability.scopes.includes('desktop.consequential')
      );
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/desktop/holder', async (request) => {
    requireScope(request, 'desktop.takeover');
    const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
    return desktop.setHolder(
      request.params.workspaceId,
      root,
      DesktopHolder.parse(request.body.holder)
    );
  });

  app.get('/v1/workspaces/:workspaceId/desktop/stream', { websocket: true }, (socket, request) => {
    requireScope(request, 'desktop.read');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    let unsubscribe: (() => Promise<void>) | undefined;
    const sendState = (state: DesktopStreamState) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: 'state', state, protocol: 'desktop-jpeg-v1' }));
    };
    const sendError = (requestId: string | undefined, cause: unknown) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'control_error',
          ...(requestId ? { requestId } : {}),
          message: cause instanceof Error ? cause.message : 'Desktop control failed'
        })
      );
    };
    const expiresIn = Math.max(1, request.capability.exp * 1000 - Date.now());
    const expiry = setTimeout(() => socket.close(1008, 'Capability expired'), expiresIn);
    void ensureRuntimeWorkspace(root)
      .then(() =>
        desktop.subscribeStream(workspaceId, root, {
          state: sendState,
          frame: (frame, state) => {
            if (socket.readyState !== socket.OPEN || socket.bufferedAmount >= 2 * 1024 * 1024)
              return;
            sendState(state);
            socket.send(frame, { binary: true });
          }
        })
      )
      .then((stop) => {
        unsubscribe = stop;
      })
      .catch(() => socket.close(1011, 'Desktop unavailable'));
    socket.on('message', (raw, binary) => {
      if (binary) return;
      void (async () => {
        let message: {
          type?: string;
          requestId?: string;
          holder?: 'agent' | 'user' | 'secure_input';
          action?: unknown;
        } = {};
        try {
          const serialized = Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw)).toString('utf8')
              : raw.toString('utf8');
          message = JSON.parse(serialized) as typeof message;
          if (message.type === 'holder') {
            requireScope(request, 'desktop.takeover');
            await desktop.setHolder(workspaceId, root, DesktopHolder.parse(message.holder));
          } else if (message.type === 'action') {
            requireScope(request, 'desktop.control');
            await desktop.act(workspaceId, root, DesktopAction.parse(message.action), 'user');
          } else throw new Error('Unsupported desktop control message');
          if (socket.readyState === socket.OPEN)
            socket.send(JSON.stringify({ type: 'control_ack', requestId: message.requestId }));
        } catch (cause) {
          sendError(message?.requestId, cause);
        }
      })();
    });
    socket.on('close', () => {
      clearTimeout(expiry);
      void unsubscribe?.();
    });
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/hibernate',
    async (request) => {
      requireScope(request, 'workspace.manage');
      await browser.close(request.params.workspaceId);
      await desktop.close(request.params.workspaceId);
      return { id: request.params.workspaceId, state: 'hibernated' };
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/resume',
    async (request) => {
      requireScope(request, 'workspace.manage');
      const root = workspacePath(config.WORKSPACE_ROOT, request.params.workspaceId);
      await ensureRuntimeWorkspace(root);
      return { id: request.params.workspaceId, state: 'running' };
    }
  );

  // Nothing to do, and nothing that could be done: there is one computer and it is this host, so
  // its capacity is the host's disk and its limits are the host's limits. The stored figure the
  // control plane is bookkeeping here reaches no allocator. Kept because the control plane still
  // calls it; it used to answer with a note calling this the development runner, which on a
  // packaged install is the production one.
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/resize',
    async (request) => {
      requireScope(request, 'workspace.manage');
      return { id: request.params.workspaceId, state: 'running' };
    }
  );

  app.get('/v1/workspaces/:workspaceId/terminal', { websocket: true }, (socket, request) => {
    requireScope(request, 'terminal');
    const { workspaceId } = request.params as { workspaceId: string };
    const root = workspacePath(config.WORKSPACE_ROOT, workspaceId);
    // A terminal is a shell on the box, so it may not outlive the capability that opened it. The
    // browser and desktop streams have always closed on expiry; without the same timer here a
    // sixty-second token bought a session that ran until one side hung up, with nothing able to
    // revoke it in between.
    const expiresIn = Math.max(1, request.capability.exp * 1000 - Date.now());
    const expiry = setTimeout(() => socket.close(1008, 'Capability expired'), expiresIn);
    void ensureRuntimeWorkspace(root).then(() => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const environment = {
        PATH: `${agentSearchPath(root)}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: root,
        TERM: 'xterm-256color',
        LANG: 'C.UTF-8'
      };
      // The same account and the same one-way privilege drop as every other agent command: a
      // shell here would otherwise be the way around the whole sandbox. Interactive use keeps
      // the network, which is what an owner opening a terminal expects.
      const invocation = sandbox
        ? sandboxedShell({ executable: shell, args: [] }, environment, sandbox)
        : { executable: shell, args: [] };
      const terminal = pty.spawn(invocation.executable, invocation.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: path.join(root, 'workspace'),
        env: sandbox ? {} : environment
      });
      terminal.onData((data) => socket.send(JSON.stringify({ type: 'data', data })));
      terminal.onExit(({ exitCode, signal }) => {
        socket.send(JSON.stringify({ type: 'exit', exitCode, signal }));
        socket.close();
      });
      socket.on('message', (raw: unknown) => {
        const message = JSON.parse(String(raw)) as
          | { type: 'input'; data: string }
          | { type: 'resize'; cols: number; rows: number };
        if (message.type === 'input') terminal.write(message.data);
        else terminal.resize(Math.max(20, message.cols), Math.max(5, message.rows));
      });
      socket.on('close', () => {
        clearTimeout(expiry);
        terminal.kill();
      });
    });
  });

  app.addHook('onClose', () => {
    processes.close();
  });
  return app;
};
