import { discardMissionInvocation, trackMissionInvocation } from './mission-processes.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { CodeIntelligenceRequest } from '@athanor/contracts';
import { prepareInvocation, type InvocationPolicy } from './execution.js';
import { assertUserDataPath, resolveInside } from './files.js';
import { killProcessTree } from './subprocess.js';
import { LspConnection } from './lsp-protocol.js';
import {
  CodeRange,
  codeSource,
  codeUriPath,
  displayRange,
  sourceRange,
  workspaceEdits,
  type Source
} from './code-intelligence-source.js';

export const CODE_SESSION_IDLE_MS = 10 * 60_000;
export const CODE_SESSION_MAX_MS = 60 * 60_000;
export const CODE_SESSION_LIMIT = 8;
export const CODE_DOCUMENT_LIMIT = 32;
const RESULT_LIMIT = 200;
const require = createRequire(import.meta.url);
type Language = CodeIntelligenceRequest['language'];
type Diagnostic = {
  range: z.infer<typeof CodeRange>;
  message: string;
  severity?: number | undefined;
  source?: string | undefined;
  code?: string | number | undefined;
};
const Diagnostics = z.array(
  z.object({
    range: CodeRange,
    message: z.string(),
    severity: z.number().optional(),
    source: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional()
  })
);
type Session = {
  key: string;
  root: string;
  project: string;
  language: Language;
  owner: string;
  child: ChildProcessWithoutNullStreams;
  connection: LspConnection;
  createdAt: number;
  lastUsedAt: number;
  pending: number;
  ready: Promise<void>;
  tail: Promise<unknown>;
  capabilities: Record<string, unknown>;
  documents: Map<string, Source & { version: number }>;
  diagnostics: Map<string, { version?: number | undefined; items: Diagnostic[]; at: number }>;
};

export function nativeLanguageServer(language: Language): { executable: string; args: string[] } {
  const name = language === 'typescript' ? 'typescript-native' : 'pyright';
  const packageRoot = path.dirname(require.resolve(`${name}/package.json`));
  return {
    executable: process.execPath,
    args:
      language === 'typescript'
        ? [path.join(packageRoot, 'bin/tsc'), '--lsp', '--stdio']
        : [path.join(packageRoot, 'langserver.index.js'), '--stdio']
  };
}

/** Sessions are analysis processes. They never supervise or restart scientific jobs. */
export class CodeIntelligenceManager {
  #sessions = new Map<string, Session>();
  #timer: NodeJS.Timeout;
  constructor(
    private readonly policy: InvocationPolicy,
    private readonly now: () => number = Date.now
  ) {
    this.#timer = setInterval(() => this.sweep(), 60_000);
    this.#timer.unref();
  }

  async act(root: string, owner: string, value: unknown): Promise<unknown> {
    const request = CodeIntelligenceRequest.parse(value);
    const relative = assertUserDataPath(root, request.root);
    const project = resolveInside(path.join(root, 'workspace'), path.join(root, relative));
    if ((await realpath(project)) !== project || !(await stat(project)).isDirectory())
      throw new Error('Code intelligence requires a real directory inside the workspace');
    const key = JSON.stringify([root, owner, project, request.language]);
    this.sweep();
    let session = this.#sessions.get(key);
    if (request.action === 'status') return this.#status(session, request.language);
    if (request.action === 'stop') {
      if (session) this.#stop(session);
      return this.#status(undefined, request.language);
    }
    if (request.action === 'start') {
      if (!session) session = await this.#start(root, project, owner, key, request.language);
      await session.ready;
      session.lastUsedAt = this.now();
      return this.#status(session, request.language);
    }
    if (!session || session.connection.closed)
      throw new Error(
        'No active language session. Use code_diagnostics action=start for this root and language; starting requires approval.'
      );
    if (session.pending >= 8) throw new Error('Language session request queue is full');
    const active = session;
    active.pending++;
    const result = active.tail
      .catch(() => undefined)
      .then(async () => {
        await active.ready;
        active.lastUsedAt = this.now();
        return this.#read(active, request);
      });
    active.tail = result;
    try {
      return await result;
    } finally {
      active.pending--;
      active.lastUsedAt = this.now();
    }
  }

  sweep(): void {
    const now = this.now();
    for (const session of this.#sessions.values())
      if (
        session.connection.closed ||
        now - session.createdAt >= CODE_SESSION_MAX_MS ||
        (!session.pending && now - session.lastUsedAt >= CODE_SESSION_IDLE_MS)
      )
        this.#stop(session);
  }
  isWorkspaceBusy(root: string): boolean {
    return [...this.#sessions.values()].some(
      (session) => session.root === root && session.pending > 0
    );
  }
  async quiesceWorkspace(root: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter((session) => session.root === root);
    this.stopWorkspace(root);
    await Promise.allSettled(sessions.map((session) => session.tail));
  }
  stopWorkspace(root: string): void {
    for (const session of this.#sessions.values()) if (session.root === root) this.#stop(session);
  }
  close(): void {
    clearInterval(this.#timer);
    for (const session of this.#sessions.values()) this.#stop(session);
  }
  #stop(session: Session): void {
    if (this.#sessions.get(session.key) !== session) return;
    this.#sessions.delete(session.key);
    if (!session.connection.closed) {
      void session.connection
        .request('shutdown')
        .then(() => session.connection.notify('exit'))
        .catch(() => undefined)
        .finally(() => {
          session.connection.close();
          killProcessTree(session.child, 'SIGTERM');
        });
    } else killProcessTree(session.child, 'SIGTERM');
    const force = setTimeout(() => {
      session.connection.close();
      killProcessTree(session.child, 'SIGKILL');
    }, 1000);
    force.unref();
  }
  #status(session: Session | undefined, language: Language) {
    return {
      language,
      running: Boolean(session && !session.connection.closed),
      root: session ? path.relative(session.root, session.project) : null,
      startedAt: session ? new Date(session.createdAt).toISOString() : null,
      idleExpiresAt: session
        ? new Date(session.lastUsedAt + CODE_SESSION_IDLE_MS).toISOString()
        : null,
      capabilities: session
        ? {
            diagnostics: Boolean(session.capabilities.diagnosticProvider),
            definition: Boolean(session.capabilities.definitionProvider),
            references: Boolean(session.capabilities.referencesProvider),
            rename: Boolean(session.capabilities.renameProvider)
          }
        : null
    };
  }
  async #start(
    root: string,
    project: string,
    owner: string,
    key: string,
    language: Language
  ): Promise<Session> {
    if (this.#sessions.size >= CODE_SESSION_LIMIT)
      throw new Error('Language session capacity reached; stop an unused session');
    const invocation = await prepareInvocation(
      root,
      {
        ...nativeLanguageServer(language),
        cwd: path.relative(root, project),
        env: {},
        network: false,
        requireNetworkIsolation: true
      },
      this.policy
    );
    // Preparation can await the sandbox specification; recheck before reserving a slot.
    const existing = this.#sessions.get(key);
    if (existing) {
      await discardMissionInvocation(invocation);
      return existing;
    }
    if (this.#sessions.size >= CODE_SESSION_LIMIT)
      throw new Error('Language session capacity reached; stop an unused session');
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: true,
      stdio: 'pipe'
    });
    trackMissionInvocation(root, invocation, child);
    const diagnostics: Session['diagnostics'] = new Map();
    let diagnosticsRegistered: (() => void) | undefined;
    const diagnosticsReady = new Promise<void>((resolve) => {
      diagnosticsRegistered = resolve;
    });
    const connection = new LspConnection(
      child.stdout,
      child.stdin,
      (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        const parsed = z
          .object({ uri: z.string(), version: z.number().optional(), diagnostics: Diagnostics })
          .safeParse(params);
        if (!parsed.success || !session.documents.has(parsed.data.uri)) return;
        diagnostics.set(parsed.data.uri, {
          version: parsed.data.version,
          items: parsed.data.diagnostics.slice(0, RESULT_LIMIT),
          at: this.now()
        });
      },
      (method, params) => {
        if (method === 'workspace/configuration') {
          const items = z
            .object({ items: z.array(z.object({ section: z.string().optional() })).max(100) })
            .parse(params).items;
          return items.map((item) => {
            if (language !== 'python') return { disableAutomaticTypeAcquisition: true };
            const analysis = {
              diagnosticMode: 'workspace',
              typeCheckingMode: 'standard',
              autoSearchPaths: true
            };
            if (item.section === 'python.analysis') return analysis;
            if (item.section === 'python') return { analysis };
            return {};
          });
        }
        if (method === 'workspace/workspaceFolders')
          return [{ uri: pathToFileURL(project).href, name: path.basename(project) }];
        if (method === 'client/registerCapability') {
          const registrations = z
            .object({
              registrations: z
                .array(
                  z.object({
                    method: z.literal('textDocument/diagnostic'),
                    registerOptions: z.unknown().optional()
                  })
                )
                .min(1)
                .max(8)
            })
            .parse(params).registrations;
          session.capabilities.diagnosticProvider = registrations[0]?.registerOptions ?? true;
          diagnosticsRegistered?.();
          return null;
        }
        if (method === 'client/unregisterCapability') {
          z.object({
            unregisterations: z
              .array(z.object({ method: z.literal('textDocument/diagnostic'), id: z.string() }))
              .max(8)
          }).parse(params);
          return null;
        }
        if (method === 'workspace/applyEdit')
          return {
            applied: false,
            failureReason:
              'garden requires an approved file edit; language servers return previews only'
          };
        if (
          method === 'window/workDoneProgress/create' ||
          method === 'workspace/diagnostic/refresh'
        )
          return null;
        throw new Error('Unsupported language server request');
      },
      () => this.#stop(session)
    );
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => connection.close(error));
    child.on('exit', () =>
      connection.close(new Error('Language server exited; a new approved start is required'))
    );
    const session: Session = {
      key,
      root,
      project,
      language,
      owner,
      child,
      connection,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      pending: 0,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      capabilities: {},
      documents: new Map(),
      diagnostics
    };
    this.#sessions.set(key, session);
    session.ready = (async () => {
      const result = await connection.request('initialize', {
        processId: child.pid ?? null,
        clientInfo: { name: 'garden' },
        rootUri: pathToFileURL(project).href,
        workspaceFolders: [{ uri: pathToFileURL(project).href, name: path.basename(project) }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: true },
            diagnostic: { dynamicRegistration: true },
            publishDiagnostics: { versionSupport: true }
          }
        },
        initializationOptions: { disableAutomaticTypeAcquisition: true }
      });
      const initialized = z
        .object({ capabilities: z.record(z.string(), z.unknown()) })
        .parse(result);
      if (
        initialized.capabilities.positionEncoding &&
        initialized.capabilities.positionEncoding !== 'utf-16'
      )
        throw new Error('Language server did not negotiate UTF-16 positions');
      session.capabilities = initialized.capabilities;
      connection.notify('initialized', {});
      if (language === 'python' && !session.capabilities.diagnosticProvider) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            diagnosticsReady,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Language server did not register diagnostics')),
                20_000
              );
              timer.unref();
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    })().catch((error: unknown) => {
      this.#stop(session);
      throw error;
    });
    return session;
  }

  async #sync(session: Session, requested: string): Promise<Source & { version: number }> {
    const source = await codeSource(session.root, session.project, requested);
    const previous = session.documents.get(source.uri);
    if (previous?.sha256 === source.sha256) return previous;
    if (!previous && session.documents.size >= CODE_DOCUMENT_LIMIT)
      throw new Error(
        'Language session open-file limit reached; use a narrower project or restart the session'
      );
    const document = { ...source, version: (previous?.version ?? 0) + 1 };
    session.documents.set(source.uri, document);
    session.diagnostics.delete(source.uri);
    if (previous)
      session.connection.notify('textDocument/didChange', {
        textDocument: { uri: source.uri, version: document.version },
        contentChanges: [{ text: source.text }]
      });
    else
      session.connection.notify('textDocument/didOpen', {
        textDocument: {
          uri: source.uri,
          languageId:
            session.language === 'python'
              ? 'python'
              : /\.[cm]?jsx?$/.test(source.path)
                ? 'javascript'
                : /\.tsx$/.test(source.path)
                  ? 'typescriptreact'
                  : 'typescript',
          version: document.version,
          text: source.text
        }
      });
    // Opening a Python source joins asynchronous project discovery. Its diagnostic response
    // acknowledges analysis before rename can classify that source as an external library.
    if (session.language === 'python') {
      try {
        await session.connection.request('textDocument/diagnostic', {
          textDocument: { uri: source.uri }
        });
      } catch (error) {
        this.#stop(session);
        throw error;
      }
    }
    return document;
  }

  async #read(session: Session, request: CodeIntelligenceRequest): Promise<unknown> {
    if (!request.path) throw new Error('This code-intelligence action requires path');
    for (const document of session.documents.values()) {
      try {
        await this.#sync(session, document.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        session.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
        session.documents.delete(document.uri);
        session.diagnostics.delete(document.uri);
      }
    }
    const source = await this.#sync(session, request.path);
    if (request.action === 'diagnostics') {
      if (!session.capabilities.diagnosticProvider)
        throw new Error('This language server does not support pull diagnostics');
      const report = z.object({ kind: z.literal('full'), items: Diagnostics }).parse(
        await session.connection.request('textDocument/diagnostic', {
          textDocument: { uri: source.uri }
        })
      );
      await this.#assertCurrent(session, source);
      for (const entry of report.items) sourceRange(source.text, entry.range);
      return {
        path: source.path,
        sha256: source.sha256,
        complete: true,
        total: report.items.length,
        truncated: report.items.length > RESULT_LIMIT,
        diagnostics: report.items.slice(0, RESULT_LIMIT).map((entry) => ({
          ...entry,
          message: entry.message.slice(0, 4000),
          range: displayRange(entry.range)
        }))
      };
    }
    if (!request.line || !request.column)
      throw new Error('This action requires one-based line and UTF-16 column');
    const position = { line: request.line - 1, character: request.column - 1 };
    sourceRange(source.text, { start: position, end: position });
    const params = { textDocument: { uri: source.uri }, position };
    if (request.action === 'rename') return this.#rename(session, source, params, request.newName);
    const method =
      request.action === 'definition' ? 'textDocument/definition' : 'textDocument/references';
    if (
      !session.capabilities[
        request.action === 'definition' ? 'definitionProvider' : 'referencesProvider'
      ]
    )
      throw new Error(`Language server does not support ${request.action}`);
    const raw = await session.connection.request(method, {
      ...params,
      context: { includeDeclaration: true }
    });
    const locations = z
      .array(
        z.union([
          z.object({ uri: z.string(), range: CodeRange }),
          z.object({
            targetUri: z.string(),
            targetRange: CodeRange,
            targetSelectionRange: CodeRange
          })
        ])
      )
      .parse(raw === null ? [] : Array.isArray(raw) ? raw : [raw]);
    const entries = [];
    let excluded = 0;
    for (const location of locations.slice(0, RESULT_LIMIT)) {
      try {
        const uri = 'uri' in location ? location.uri : location.targetUri;
        const range = 'range' in location ? location.range : location.targetSelectionRange;
        const target = await codeSource(
          session.root,
          session.project,
          codeUriPath(session.root, session.project, uri)
        );
        sourceRange(target.text, range);
        entries.push({
          path: target.path,
          range: displayRange(range),
          sha256: target.sha256,
          lineText: target.text.split('\n')[range.start.line]?.slice(0, 500) ?? ''
        });
      } catch {
        excluded++;
      }
    }
    await this.#assertCurrent(session, source);
    return {
      path: source.path,
      sha256: source.sha256,
      entries,
      excluded,
      total: locations.length,
      truncated: locations.length > RESULT_LIMIT
    };
  }
  async #assertCurrent(session: Session, source: Source): Promise<void> {
    if ((await codeSource(session.root, session.project, source.path)).sha256 !== source.sha256)
      throw new Error('Source changed during language analysis; retry against the current file');
  }
  async #rename(
    session: Session,
    source: Source,
    params: unknown,
    newName: string | undefined
  ): Promise<unknown> {
    if (!newName || !session.capabilities.renameProvider)
      throw new Error('Rename requires newName and a language server with rename support');
    const rename = async () =>
      workspaceEdits(
        await session.connection.request('textDocument/rename', { ...(params as object), newName })
      );
    let edits = await rename();
    for (const uri of edits.keys())
      await this.#sync(session, codeUriPath(session.root, session.project, uri));
    edits = await rename();
    const files = [];
    let bytes = 0;
    for (const [uri, changes] of edits) {
      const snapshot = session.documents.get(uri);
      if (!snapshot) throw new Error('Rename scope changed during analysis; retry');
      await this.#assertCurrent(session, snapshot);
      const ranges = changes
        .map((edit) => ({ ...edit, ...sourceRange(snapshot.text, edit.range) }))
        .sort((a, b) => a.start - b.start);
      for (let index = 1; index < ranges.length; index++)
        if (ranges[index]!.start < ranges[index - 1]!.end)
          throw new Error('Language server returned overlapping rename edits');
      files.push({
        path: snapshot.path,
        sha256: snapshot.sha256,
        edits: ranges.map((edit) => ({
          range: displayRange(edit.range),
          oldText: snapshot.text.slice(edit.start, edit.end),
          newText: edit.newText
        }))
      });
      bytes += Buffer.byteLength(JSON.stringify(files[files.length - 1]));
      if (bytes > 100_000)
        throw new Error('Rename preview exceeds its response limit; narrow the project');
    }
    await this.#assertCurrent(session, source);
    return {
      preview: true,
      applied: false,
      newName,
      files,
      edits: files.reduce((sum, file) => sum + file.edits.length, 0)
    };
  }
}
