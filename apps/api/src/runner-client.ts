import { randomUUID } from 'node:crypto';
import { capabilityAudience, redactText, signCapabilityToken } from '@athanor/core';

type Role = 'control' | 'agent' | 'user';

export class RunnerClient {
  constructor(
    readonly baseUrl: string,
    private readonly secret: string
  ) {}

  /**
   * `audience` binds the token to the one request it is for, so a token observed in flight cannot
   * be turned against another runner route. It is deliberately omitted for the stream credentials
   * the client uses for several calls in a row - a browser takeover is a snapshot, an action and a
   * holder change on one token - where a single audience would break the flow rather than secure
   * it; those stay bounded by their scopes and their lifetime.
   */
  token(
    workspaceId: string,
    userId: string,
    role: Role,
    scopes: string[],
    ttlSeconds = 60,
    audience?: { method: string; path: string }
  ): string {
    return signCapabilityToken(
      {
        sub: userId,
        workspaceId,
        role,
        scopes,
        ...(audience ? { aud: capabilityAudience(audience.method, audience.path) } : {}),
        nonce: randomUUID()
      },
      this.secret,
      ttlSeconds
    );
  }

  async request<T>(input: {
    workspaceId: string;
    userId: string;
    role: Role;
    scopes: string[];
    path: string;
    method?: string;
    body?: BodyInit;
    contentType?: string;
    headers?: Record<string, string>;
    acceptAnyStatus?: boolean;
    redirect?: RequestRedirect;
    timeoutMs?: number;
  }): Promise<T> {
    const response = await this.raw(input);
    const contentType = response.headers.get('content-type') ?? '';
    return (
      contentType.includes('application/json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer())
    ) as T;
  }

  /**
   * `timeoutMs` is opt-in because most runner routes are legitimately slow - a build under `exec`,
   * a whole-machine export - and undici's 300 s header timeout is the right ceiling for those. It
   * exists for the calls a person is waiting behind, where a runner that has stopped answering
   * should degrade to a stale figure in seconds rather than hold a response open for five minutes.
   */
  async raw(input: {
    workspaceId: string;
    userId: string;
    role: Role;
    scopes: string[];
    path: string;
    method?: string;
    body?: BodyInit;
    contentType?: string;
    headers?: Record<string, string>;
    acceptAnyStatus?: boolean;
    redirect?: RequestRedirect;
    timeoutMs?: number;
  }): Promise<Response> {
    const method = input.method ?? 'GET';
    const response = await fetch(`${this.baseUrl}${input.path}`, {
      method,
      headers: {
        ...input.headers,
        authorization: `Bearer ${this.token(input.workspaceId, input.userId, input.role, input.scopes, 60, { method, path: input.path })}`,
        ...(input.contentType ? { 'content-type': input.contentType } : {})
      },
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.redirect ? { redirect: input.redirect } : {}),
      ...(input.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(input.timeoutMs) })
    });
    if (!response.ok && !input.acceptAnyStatus) {
      // The upstream body is quoted because it is usually the only description of what went wrong,
      // and scrubbed because it is a response the agent's own code may have written.
      const error = await response.text().catch(() => '');
      throw new Error(
        `Workspace runtime returned ${response.status}${error ? `: ${redactText(error).slice(0, 250)}` : ''}`
      );
    }
    return response;
  }
}
