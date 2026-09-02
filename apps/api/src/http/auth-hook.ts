/**
 * Who is calling, whether they may, and whether the thing they named could exist.
 *
 * Read as one because they run as one: the request hook that turns a session cookie or a bearer
 * token into `request.user`, the pre-handler that refuses a path identifier which is not a UUID,
 * and the pre-handler that is the ONLY place a workspace id is checked against its owner.
 *
 * That last one is why the Wave 6 split could not be a plain file move. Fastify snapshots hooks
 * per route at registration time, which makes the order in `server.ts` load-bearing: every
 * `registerXRoutes` call happens after `registerAuthHooks`, and a group added before it is
 * registered with no workspace check on it at all.
 *
 * That check is defence in depth, and Wave 6 measured that it had no net: disabling it turned
 * nothing red, because every workspace-scoped handler in `routes/` independently resolves the
 * workspace through `store.getWorkspace(user.id, ...)` and refuses on its own, so both boundary
 * tests in `server.test.ts` pass with this hook defeated. They pin the handlers, not the hook.
 *
 * `auth-hook.test.ts` is the net that can tell the two layers apart. It registers a route that
 * deliberately does NOT re-scope - which is the route this hook exists for, the one nobody has
 * written yet - so the pre-handler is the only authorization in the request and deleting it fails
 * exactly one test. The self-scoping route sits beside it as the control, still green either way.
 */

import type { ApiTokenScope } from '@athanor/contracts';
import { AthanorError, sha256 } from '@athanor/core';
import type { ApiTokenRecord, UserRecord } from '@athanor/data';
import type { FastifyRequest } from 'fastify';
import { STEP_UP_WINDOW_SECONDS, sessionCookieName, sessionUser } from '../session.js';
import type { ServerBase } from './server-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRecord | null;
    apiToken: ApiTokenRecord | null;
    rawBody?: Buffer;
  }
}

const publicPaths = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/v1/legal',
  '/v1/auth/register/options',
  '/v1/auth/register/verify',
  '/v1/auth/login/options',
  '/v1/auth/login/verify',
  '/v1/auth/recover/options',
  '/v1/auth/recover/verify',
  /*
   * Adding a device is unauthenticated by construction, and these two were not on this list.
   *
   * A device redeeming an enrollment grant has no session - that is the entire thing it is asking
   * for - so the gate refused the pair before either route could look at the token, and the only
   * way onto a claimed box was the recovery code, which replaces every passkey the owner has. What
   * authorises the request is the grant itself: single use, ten minutes, minted by a device that is
   * already signed in and stepped up, and worth nothing without a WebAuthn ceremony completed on
   * top of it.
   */
  '/v1/auth/enroll/options',
  '/v1/auth/enroll/verify',
  '/v1/auth/dev',
  '/v1/connectors/mcp/oauth/callback',
  '/v1/connectors/mcp/oauth/client-metadata'
]);

/**
 * Passkey ceremonies are unauthenticated or reauthentication surfaces, so they are throttled per
 * caller address the way account recovery already is.
 */
const authRateLimitedPaths = new Set([
  /*
   * Registration is the first-owner ceremony and was the one pair on `publicPaths` that this table
   * did not cover, which made the comment above false. It is gated on a pairing code presented by a
   * caller with no session - the same profile as enrollment, two entries down - and the code being
   * 128 bits is an argument about guessing, not about an unauthenticated endpoint that will answer
   * as often as it is asked on a box with a public address.
   */
  '/v1/auth/register/options',
  '/v1/auth/register/verify',
  '/v1/auth/login/options',
  '/v1/auth/login/verify',
  '/v1/auth/step-up/options',
  '/v1/auth/step-up/verify',
  // Both recovery routes derive a 32 MB scrypt hash, so the throttle protects the machine as well
  // as the code.
  '/v1/auth/recover/options',
  '/v1/auth/recover/verify',
  // The enrollment grant is 256 bits and cannot be guessed, but it is a secret presented by an
  // unauthenticated caller, which is the profile this throttle exists for.
  '/v1/auth/enroll/options',
  '/v1/auth/enroll/verify'
]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The error a malformed path identifier is reported as. Every `*Id` path parameter in the API names
 * a UUID primary key, so an id that is not one names nothing - the same answer as an id that named
 * a record which is gone. The two codes the clients already branch on keep their own names so that
 * handling does not have to change.
 */
const missingRecordCode: Record<string, string> = {
  taskId: 'task_not_found',
  workspaceId: 'workspace_not_found'
};
const missingRecordLabel: Record<string, string> = {
  taskId: 'Task',
  workspaceId: 'Workspace'
};

export const requireUser = (user: UserRecord | null): UserRecord => {
  if (!user) throw new AthanorError('authentication_required', 'Sign in to continue');
  return user;
};

/**
 * The three `*-token` routes hand back a runner capability - a terminal one is an interactive shell
 * on the box, reachable from anywhere the published runner is. That is a session-cookie flow for a
 * person driving the machine, not something an automation token should be able to reach: no scope
 * in the list says "may open a shell", and `workspaces:write` reads as "may create and modify
 * workspaces". Returning undefined refuses them to bearer tokens outright.
 */
const streamCredentialRoutes = new Set([
  '/v1/workspaces/:workspaceId/terminal-token',
  '/v1/workspaces/:workspaceId/browser-token',
  '/v1/workspaces/:workspaceId/desktop-token'
]);

const requiredApiTokenScope = (method: string, route: string): ApiTokenScope | undefined => {
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (streamCredentialRoutes.has(route)) return undefined;
  if (route.startsWith('/v1/models')) return 'models:read';
  /*
   * Read-only, and under the model scope, because the only thing on this surface an automation has
   * any business with is which model an automatic pick will make.
   *
   * Nothing under `/v1/account` matched any entry in this table, so it fell through to `return
   * undefined` and a bearer token was refused the setting outright - while the server had just
   * started honouring that same setting on every task the token creates. A headless client could be
   * governed by a preference it had no way to read. Writing it stays refused: a standing choice
   * about which model answers for the owner is theirs to change at their own keyboard, and
   * `DELETE /v1/account` is on the same prefix.
   */
  if (route === '/v1/account/preferences') return writing ? undefined : 'models:read';
  /*
   * The one `/v1/tasks` route no scope reaches, and it is the same rule the notification surface
   * below is refused under, applied where it matters more.
   *
   * `PATCH /v1/tasks/:taskId/security-mode` sets how much a run asks. Its own route comment records
   * that there is deliberately no second factor on it - which is right for the owner at their own
   * keyboard, and wrong for a bearer token, because it fell through to the generic rule below and
   * needed only `tasks:write`: the minimum scope any automation holds, the same one it needs to
   * start the work at all. So a token minted to let a script create tasks could set those tasks to
   * `autonomous`, where `SECURITY_MODE_FLOOR` turns off asking before reaching the internet and
   * before installing software. The task-owner check on the route does not help: the task belongs
   * to the token's own user by construction.
   *
   * This table already says the same thing twice - changing the spend ceiling is refused to an
   * automation while reading it is `usage:read`, and no scope reaches `/v1/notifications` because
   * "an automation token that could switch off approval prompts could act unwatched". Switching the
   * prompts off outright is the stronger form of exactly that, and it was the case the table missed.
   * Reading the mode stays available: a client that must not change how much a run asks still has
   * every reason to know.
   */
  if (route === '/v1/tasks/:taskId/security-mode') return writing ? undefined : 'tasks:read';
  // One `/v1/tasks` write is not a task write: `POST /v1/tasks/:taskId/trajectory` with a
  // `computer` or `both` rewind replaces the filesystem. This table is read from `onRequest`,
  // before a body exists, so that one is refused at its own route instead.
  if (route.startsWith('/v1/tasks') || route.startsWith('/v1/schedules'))
    return writing ? 'tasks:write' : 'tasks:read';
  if (route.startsWith('/v1/approvals')) return writing ? 'approvals:write' : 'approvals:read';
  if (route.startsWith('/v1/usage')) return 'usage:read';
  // Reading what has been spent is usage. Changing the ceiling is the owner deciding how much of
  // their own money the agent may spend, which is not something an automation token gets to do.
  if (route === '/v1/spend' || (route === '/v1/spend-limits' && !writing)) return 'usage:read';
  // No scope reaches the notification surface: an automation token that could switch off approval
  // prompts could act unwatched, which is the one thing the prompts exist to prevent.
  if (route.startsWith('/v1/notifications')) return undefined;
  if (route.startsWith('/v1/connectors')) return writing ? undefined : 'connectors:read';
  if (route.startsWith('/v1/previews')) return 'workspaces:write';
  if (route.startsWith('/v1/workspaces')) {
    /*
     * The sibling of the task route above, and the worse of the two: this one sets the DEFAULT that
     * every future task on the workspace inherits, so a single call relaxes work that has not been
     * created yet. It had no case here at all and fell through to `workspaces:write` - the scope a
     * token needs to make a workspace in the first place - while the per-task route beside it was
     * being refused. Closing one and not the other left the wider door open.
     *
     * Reading stays available for the same reason it does there: a client that may not change how
     * much a run asks still has every reason to know what it will ask.
     */
    if (route === '/v1/workspaces/:workspaceId/security-mode')
      return writing ? undefined : 'workspaces:read';
    if (route.includes('/file')) return writing ? 'files:write' : 'files:read';
    if (route.includes('/browser') || route.includes('/desktop') || route.includes('/terminal'))
      return 'workspaces:write';
    return writing ? 'workspaces:write' : 'workspaces:read';
  }
  return undefined;
};

/** The passkey a sensitive route insists on having seen inside the step-up window. */
export type StepUpGuard = (request: FastifyRequest, user: UserRecord) => Promise<void>;

export const createStepUpGuard = (context: ServerBase): StepUpGuard => {
  const { store, secure } = context;
  const requireRecentStepUp = async (request: FastifyRequest, user: UserRecord): Promise<void> => {
    const token = request.cookies[sessionCookieName(secure)];
    if (
      !token ||
      !(await store.hasRecentSessionStepUp(user.id, sha256(token), STEP_UP_WINDOW_SECONDS))
    ) {
      throw new AthanorError(
        'step_up_required',
        'Confirm this sensitive action with your passkey',
        403
      );
    }
  };

  return requireRecentStepUp;
};

/** The gates above, hung on the app in the order a request meets them. */
export const registerAuthHooks = (context: ServerBase): void => {
  const { app, store, secure, requestStarted, checkAuthRate, config } = context;
  app.addHook('onRequest', async (request, reply) => {
    requestStarted.set(request, performance.now());
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (authRateLimitedPaths.has(path)) checkAuthRate(`${request.ip}:${path}`);
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const value = authorization.slice('Bearer '.length);
      const authenticated = /^oc_live_[A-Za-z0-9_-]{40,80}$/.test(value)
        ? await store.authenticateApiToken(sha256(value))
        : null;
      request.user = authenticated?.user ?? null;
      request.apiToken = authenticated?.token ?? null;
    } else {
      request.user = await sessionUser(
        store,
        request.cookies[sessionCookieName(secure)],
        reply,
        secure
      );
      request.apiToken = null;
    }
    if (!publicPaths.has(path) && !request.user) {
      throw new AthanorError('authentication_required', 'Sign in to continue');
    }
    if (request.apiToken) {
      const scope = requiredApiTokenScope(request.method, path);
      if (!scope || !request.apiToken.scopes.includes(scope))
        throw new AthanorError(
          'api_token_scope_required',
          scope
            ? `This API token requires the ${scope} scope`
            : 'API tokens cannot call this endpoint',
          403
        );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== config.PUBLIC_APP_URL)
        throw new AthanorError('invalid_origin', 'Request origin is not allowed');
    }
  });
  /**
   * Every identifier that appears in a path is a UUID column. PostgreSQL answers a malformed one
   * with error 22P02 rather than an empty result, and that reached the owner as a 500 and
   * "The request could not be completed" - for a truncated link, a bookmark to a conversation that
   * has been deleted, or a path segment the router matched as an id because no static route claimed
   * it. None of those are server faults, so the shape is checked here while it is still known which
   * record was being asked for.
   */
  app.addHook('preHandler', async (request) => {
    const parameters = request.params as Record<string, unknown> | null;
    if (!parameters) return;
    for (const [name, value] of Object.entries(parameters)) {
      if (!name.endsWith('Id') || typeof value !== 'string') continue;
      if (uuidPattern.test(value)) continue;
      throw new AthanorError(
        missingRecordCode[name] ?? 'not_found',
        `${missingRecordLabel[name] ?? 'The record'} was not found`,
        404
      );
    }
  });
  app.addHook('preHandler', async (request) => {
    const user = request.user;
    if (!user) return;
    const route = request.routeOptions.url ?? '';
    const parameters = request.params as { workspaceId?: string; taskId?: string };
    if (parameters.workspaceId) {
      // The workspace reports its own liveness; there is no caller to authorize.
      if (route.endsWith('/heartbeat')) return;
      /**
       * Every route carrying a workspace id is authorized here, reads included, so a GET added
       * later cannot ship with no check at all - which is how the file routes once came to be
       * readable more widely than the export they duplicate.
       *
       * There is one question left to ask. The computer belongs to the person who installed this,
       * and nothing can put a second person on it, so "may this caller act here" and "is this the
       * owner's own workspace" are the same question with one answer.
       */
      if (!(await store.workspaceBelongsToUser(user.id, parameters.workspaceId)))
        throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
    }
    if (parameters.taskId && route === '/v1/tasks/:taskId/:action' && request.method === 'POST') {
      if (!(await store.getTask(user.id, parameters.taskId)))
        throw new AthanorError('task_not_found', 'Task not found', 404);
    }
  });
};
