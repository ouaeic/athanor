import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PREVIEW_IDLE_EXPIRY_DAYS } from '@athanor/contracts';
import {
  encryptJson,
  generateDataKey,
  sha256,
  unwrapDataKey,
  wrapDataKey,
  type ConnectorTransport,
  type MailSocketFactory
} from '@athanor/core';
import { agentNotificationAad } from '@athanor/data';
import { seedModels } from '@athanor/model-gateway';
import type { ApiConfig } from './config.js';
import { createLogger } from './log.js';
import { buildServer, idempotencyRequestHash, UNREADABLE_AGENT_MESSAGE } from './server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

describe('API production boundaries', () => {
  test('replays primary-computer creation and exposes only hosted model routes', async () => {
    let provisioningCalls = 0;
    let forwardedPreviewCookie: string | null = null;
    let transcriptionRequest: Record<string, unknown> | null = null;
    let mcpOAuthBearer = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        if (requestUrl.includes('/models?output_modalities=transcription')) {
          return new Response(JSON.stringify({ data: [{ id: 'test/transcription-model' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (requestUrl.endsWith('/audio/transcriptions')) {
          if (typeof init?.body !== 'string') {
            throw new Error('Expected a JSON transcription request body');
          }
          transcriptionRequest = JSON.parse(init.body) as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              text: 'A private voice note',
              usage: { seconds: 1.25, total_tokens: 12 }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (requestUrl.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: seedModels().map((model) => ({
                id: model.providerModelId,
                context_length: model.contextTokens,
                architecture: { input_modalities: model.modalities },
                supported_parameters: ['tools', 'reasoning']
              }))
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (requestUrl.endsWith('/endpoints/zdr')) {
          return new Response(
            JSON.stringify({
              data: seedModels().map((model) => ({
                model_id: model.providerModelId,
                status: 0
              }))
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (requestUrl.includes('/benchmarks?')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        provisioningCalls += 1;
        if (requestUrl.endsWith('/export')) {
          return new Response(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]), {
            status: 200,
            headers: { 'content-type': 'application/gzip' }
          });
        }
        if (requestUrl.includes('/preview-check/3000')) {
          return new Response(JSON.stringify({ port: 3000, available: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (requestUrl.includes('/preview/3000')) {
          forwardedPreviewCookie = new Headers(init?.headers).get('cookie');
          return new Response(
            '<!doctype html><title>Private app</title><h1>Workspace preview</h1>',
            {
              status: 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'set-cookie': 'preview_app_session=opaque; Path=/; HttpOnly'
              }
            }
          );
        }
        if (requestUrl.includes('/snapshots') && init?.method === 'POST') {
          return new Response(JSON.stringify({ sizeBytes: 4096, restored: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const config: ApiConfig = {
      DEPLOYMENT_MODE: 'development',
      MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
      CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
      ATHANOR_STATE_PATH: directory,
      RELAY_STATE_DIR: join(directory, 'relay'),
      RELAY_LOCAL_HOST: '127.0.0.1',
      RELAY_LOCAL_PORT: 443,
      RELAY_LOCAL_HTTP_PORT: 80,
      REGISTRATION_BOOTSTRAP_TOKEN: 'test-pairing-token-with-at-least-20-characters',
      REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
      PUBLIC_APP_URL: 'http://localhost:5173',
      PREVIEW_BASE_URL: 'http://preview.localhost:4400',
      API_HOST: '127.0.0.1',
      API_PORT: 4100,
      PREVIEW_GATEWAY_HOST: '127.0.0.1',
      PREVIEW_GATEWAY_PORT: 4400,
      RESERVED_PREVIEW_PORTS: '4201,4203',
      DATABASE_DRIVER: 'pglite',
      DATABASE_URL: 'postgres://unused',
      PGLITE_PATH: join(directory, 'database'),
      DATA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
      RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
      WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
      PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
      WORKSPACE_IMAGE_REVISION: 'dev',
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_RP_NAME: 'athanor Test',
      WEBAUTHN_ORIGIN: 'http://localhost:5173',
      ALLOW_INSECURE_DEV_AUTH: true,
      WORKER_ID: 'embedded-test-worker',
      // These tests are about the API's own answers, so no agent runs behind them: a task they
      // create stays queued, holding the reservation the assertion is about.
      EMBEDDED_WORKER: false,
      WORKER_CONCURRENCY: 2,
      WORKER_POLL_MS: 60_000,
      SCHEDULER_POLL_MS: 1_000,
      TASK_MAX_STEPS: 3,
      SECURITY_EVENT_RETENTION_DAYS: 30,
      LOG_LEVEL: 'silent',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_PROVIDER: 'openrouter',
      AI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      AI_REQUIRE_ZDR: true,
      AI_FORCE_INHOUSE_WEB: false,
      ALLOW_INSECURE_PROVIDER_URLS: false,
      CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
      PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
      PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com,updates.push.services.mozilla.com'
    };
    const { app, previewApp, database, store } = await buildServer(config, {
      connectorTransport: async (input) => {
        const connectorResponse = (
          body: unknown,
          status = 200,
          headers: Record<string, string> = { 'content-type': 'application/json' }
        ) => ({
          status,
          headers,
          body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
          durationMs: 3
        });
        if (input.url.hostname.startsWith('mcp-')) {
          const path = input.url.pathname;
          if (path.startsWith('/.well-known/oauth-protected-resource'))
            return connectorResponse({
              resource: `https://${input.url.hostname}/tools`,
              authorization_servers: [`https://${input.url.hostname}`],
              scopes_supported: ['tools.read', 'offline_access']
            });
          if (path === '/.well-known/oauth-authorization-server')
            return connectorResponse({
              issuer: `https://${input.url.hostname}`,
              authorization_endpoint: `https://${input.url.hostname}/authorize`,
              token_endpoint: `https://${input.url.hostname}/token`,
              registration_endpoint: `https://${input.url.hostname}/register`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              token_endpoint_auth_methods_supported: ['client_secret_basic'],
              code_challenge_methods_supported: ['S256']
            });
          if (path === '/register')
            return connectorResponse({
              client_id: 'athanor-api-test',
              client_secret: 'registered-secret',
              token_endpoint_auth_method: 'client_secret_basic',
              redirect_uris: ['http://localhost:5173/v1/connectors/mcp/oauth/callback'],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              client_name: 'athanor'
            });
          if (path === '/token')
            return connectorResponse({
              access_token: 'oauth-access-token',
              refresh_token: 'oauth-refresh-token',
              token_type: 'bearer'
            });
          if (input.method === 'DELETE') return connectorResponse('', 200);
          const message = JSON.parse(Buffer.from(input.body ?? []).toString('utf8')) as {
            id?: string | number;
            method?: string;
          };
          if (input.url.hostname === 'mcp-oauth.example')
            mcpOAuthBearer = input.headers.authorization ?? '';
          if (message.method === 'notifications/initialized') return connectorResponse('', 202);
          if (message.method === 'initialize')
            return connectorResponse(
              {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: input.url.hostname, version: '1.0.0' }
                }
              },
              200,
              {
                'content-type': 'application/json',
                'mcp-session-id': `${input.url.hostname}-session`
              }
            );
          if (message.method === 'tools/list')
            return connectorResponse({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [] }
            });
          throw new Error(`Unexpected test MCP operation: ${message.method}`);
        }
        return {
          status: input.method === 'PROPFIND' ? 207 : 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            input.url.hostname === 'api.github.com'
              ? JSON.stringify({ login: 'private-user' })
              : '<?xml version="1.0"?><multistatus xmlns="DAV:"/>'
          ),
          durationMs: 3
        };
      }
    });
    disposers.push(() => app.close());

    const publicMcpClientMetadata = await app.inject({
      method: 'GET',
      url: '/v1/connectors/mcp/oauth/client-metadata'
    });
    expect(publicMcpClientMetadata.statusCode).toBe(200);
    expect(publicMcpClientMetadata.json()).toMatchObject({
      client_id: 'http://localhost:5173/v1/connectors/mcp/oauth/client-metadata',
      redirect_uris: ['http://localhost:5173/v1/connectors/mcp/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none'
    });
    expect(publicMcpClientMetadata.body).not.toContain('secret');

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      payload: { username: 'private-user' }
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const transcription = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { cookie: cookie! },
      payload: { data: Buffer.from('test voice bytes').toString('base64'), format: 'webm' }
    });
    expect(transcription.statusCode, transcription.body).toBe(200);
    expect(transcription.json()).toMatchObject({
      text: 'A private voice note',
      model: 'test/transcription-model',
      privacyRoute: 'provider_zdr'
    });
    expect(transcriptionRequest).toMatchObject({
      model: 'test/transcription-model',
      provider: {
        zdr: true,
        data_collection: 'deny',
        require_parameters: true
      }
    });

    const nativeLoginOptions = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/options',
      payload: {
        username: 'private-user',
        nativeOrigin: 'http://localhost:49876'
      }
    });
    expect(nativeLoginOptions.statusCode, nativeLoginOptions.body).toBe(200);
    expect(nativeLoginOptions.json<{ options: { rpId: string } }>().options.rpId).toBe('localhost');
    const nativeChallenge = await database.query(
      `SELECT expected_origin,rp_id
       FROM auth_challenges
       WHERE id=$1`,
      [nativeLoginOptions.json<{ challengeId: string }>().challengeId]
    );
    expect(nativeChallenge.rows[0]).toMatchObject({
      expected_origin: 'http://localhost:49876',
      rp_id: 'localhost'
    });

    const spoofedNativeOrigin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login/options',
      payload: {
        username: 'private-user',
        nativeOrigin: 'http://127.0.0.1:49876'
      }
    });
    expect(spoofedNativeOrigin.statusCode).toBe(400);
    expect(spoofedNativeOrigin.json<{ error: { code: string } }>().error.code).toBe(
      'invalid_native_origin'
    );

    provisioningCalls = 0;
    const headers = { cookie: cookie!, 'idempotency-key': 'workspace-create-0001' };
    const payload = {
      name: 'Analysis room',
      storageLimitBytes: 10_000_000_000,
      region: 'auto'
    };

    const created = await app.inject({ method: 'POST', url: '/v1/workspaces', headers, payload });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ securityMode: 'balanced' });
    const replay = await app.inject({ method: 'POST', url: '/v1/workspaces', headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ id: string }>().id).toBe(created.json<{ id: string }>().id);
    expect(provisioningCalls).toBe(1);

    const aboveWorkspaceLimit = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: cookie!, 'idempotency-key': 'workspace-create-0002' },
      payload: { ...payload, name: 'Second computer' }
    });
    expect(aboveWorkspaceLimit.statusCode).toBe(409);
    expect(aboveWorkspaceLimit.json<{ error: { code: string } }>().error.code).toBe(
      'computer_already_exists'
    );
    expect(provisioningCalls).toBe(1);

    const issuedToken = await app.inject({
      method: 'POST',
      url: '/v1/api-tokens',
      headers: { cookie: cookie! },
      payload: {
        label: 'Automation test',
        scopes: ['models:read', 'workspaces:read'],
        expiresInDays: 7
      }
    });
    expect(issuedToken.statusCode, issuedToken.body).toBe(200);
    const tokenResult = issuedToken.json<{
      token: string;
      apiToken: { id: string; prefix: string; scopes: string[] };
    }>();
    expect(tokenResult.token).toMatch(/^oc_live_/);
    expect(tokenResult.apiToken.scopes).toEqual(['models:read', 'workspaces:read']);
    const storedToken = await database.query('SELECT token_hash FROM api_tokens');
    expect(JSON.stringify(storedToken.rows)).not.toContain(tokenResult.token);
    const tokenModels = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${tokenResult.token}` }
    });
    expect(tokenModels.statusCode).toBe(200);
    const tokenBootstrap = await app.inject({
      method: 'GET',
      url: '/v1/bootstrap',
      headers: { authorization: `Bearer ${tokenResult.token}` }
    });
    expect(tokenBootstrap.statusCode).toBe(403);
    expect(tokenBootstrap.json<{ error: { code: string } }>().error.code).toBe(
      'api_token_scope_required'
    );
    const revokedToken = await app.inject({
      method: 'DELETE',
      url: `/v1/api-tokens/${tokenResult.apiToken.id}`,
      headers: { cookie: cookie! }
    });
    expect(revokedToken.json()).toEqual({ revoked: true });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: `Bearer ${tokenResult.token}` }
        })
      ).statusCode
    ).toBe(401);

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers,
      payload: { ...payload, name: 'Different input' }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('idempotency_conflict');

    const strangerLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      payload: { username: 'team-editor', displayName: 'Team Editor' }
    });
    const strangerSetCookie = strangerLogin.headers['set-cookie'];
    const strangerCookie = (
      Array.isArray(strangerSetCookie) ? strangerSetCookie[0] : strangerSetCookie
    )?.split(';', 1)[0];
    expect(strangerCookie).toBeTruthy();

    // A second account on the box is not a colleague, a viewer or a guest. It has no computer of
    // its own here and no way to be given one, so the owner's list is not its list.
    const strangerWorkspaces = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: strangerCookie! }
    });
    expect(strangerWorkspaces.json<Array<{ id: string }>>()).not.toContainEqual(
      expect.objectContaining({ id: created.json<{ id: string }>().id })
    );
    const strangerWrite = await app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${created.json<{ id: string }>().id}/file?path=workspace/blocked.txt`,
      headers: {
        cookie: strangerCookie!,
        'content-type': 'application/octet-stream',
        'idempotency-key': 'team-viewer-write-0001'
      },
      payload: Buffer.from('must not write')
    });
    expect(strangerWrite.statusCode).toBe(404);
    expect(strangerWrite.json<{ error: { code: string } }>().error.code).toBe(
      'workspace_not_found'
    );
    const strangerTask = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie: strangerCookie!, 'idempotency-key': 'team-policy-denied-0001' },
      payload: {
        workspaceId: created.json<{ id: string }>().id,
        prompt: "Start work on somebody else's computer",
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 3
      }
    });
    expect(strangerTask.statusCode).toBe(404);
    expect(strangerTask.json<{ error: { code: string } }>().error.code).toBe('workspace_not_found');

    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v1/bootstrap',
      headers: { cookie: cookie! }
    });
    expect(bootstrap.statusCode).toBe(200);
    const models = bootstrap.json<{
      models: Array<{ privacyRoute: string; provider: string; availability: string }>;
    }>().models;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => ['provider_zdr', 'external'].includes(model.privacyRoute))).toBe(
      true
    );
    expect(models.every((model) => !model.provider.toLowerCase().includes('local'))).toBe(true);
    expect(models.every((model) => model.provider === 'openrouter')).toBe(true);
    expect(models.every((model) => model.availability === 'available')).toBe(true);

    const pushConfig = await app.inject({
      method: 'GET',
      url: '/v1/notifications/config',
      headers: { cookie: cookie! }
    });
    expect(pushConfig.json()).toMatchObject({
      enabled: true,
      publicKey: config.PUSH_VAPID_PUBLIC_KEY
    });
    const subscribed = await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: { cookie: cookie!, 'idempotency-key': 'push-subscribe-0001' },
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/opaque-token',
        keys: { p256dh: 'p'.repeat(80), auth: 'a'.repeat(24) }
      }
    });
    expect(subscribed.statusCode).toBe(201);
    const unsafePush = await app.inject({
      method: 'POST',
      url: '/v1/notifications/subscriptions',
      headers: { cookie: cookie!, 'idempotency-key': 'push-subscribe-0002' },
      payload: {
        endpoint: 'https://internal.example/push',
        keys: { p256dh: 'p'.repeat(80), auth: 'a'.repeat(24) }
      }
    });
    expect(unsafePush.statusCode).toBe(400);
    expect(unsafePush.json<{ error: { code: string } }>().error.code).toBe('invalid_push_endpoint');

    const removedProviderCatalog = await app.inject({
      method: 'GET',
      url: '/v1/providers/catalog',
      headers: { cookie: cookie! }
    });
    expect(removedProviderCatalog.statusCode).toBe(404);

    const connectedService = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie: cookie!, 'idempotency-key': 'connector-connect-0001' },
      payload: {
        kind: 'github',
        label: 'My GitHub',
        token: 'github-private-token',
        scopes: ['github:profile.read', 'github:repository.read']
      }
    });
    expect(connectedService.statusCode, connectedService.body).toBe(200);
    expect(connectedService.json()).toMatchObject({
      kind: 'github',
      label: 'My GitHub',
      baseUrl: 'https://api.github.com',
      scopes: ['github:profile.read', 'github:repository.read'],
      enabled: true
    });
    expect(connectedService.body).not.toContain('github-private-token');
    const rawConnector = await database.query('SELECT secret_ciphertext FROM connectors');
    expect(JSON.stringify(rawConnector.rows)).not.toContain('github-private-token');
    const connectorList = await app.inject({
      method: 'GET',
      url: '/v1/connectors',
      headers: { cookie: cookie! }
    });
    expect(connectorList.body).not.toContain('secretCiphertext');
    const connectorAudit = await app.inject({
      method: 'GET',
      url: '/v1/connectors/audit',
      headers: { cookie: cookie! }
    });
    expect(connectorAudit.json()).toMatchObject([
      { operation: 'connection_verified', outcome: 'succeeded' }
    ]);
    expect(connectorAudit.body).not.toContain('github-private-token');
    const mixedScopes = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie: cookie!, 'idempotency-key': 'connector-connect-0002' },
      payload: {
        kind: 'github',
        label: 'Unsafe scope mix',
        token: 'github-private-token',
        scopes: ['webdav:files.read']
      }
    });
    expect(mixedScopes.statusCode).toBe(400);
    expect(mixedScopes.json<{ error: { code: string } }>().error.code).toBe(
      'connector_scope_invalid'
    );

    const mcpWithoutCredentials = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie: cookie!, 'idempotency-key': 'connector-mcp-no-auth-0001' },
      payload: {
        kind: 'mcp_http',
        label: 'Public tools',
        baseUrl: 'https://mcp-noauth.example/tools',
        scopes: ['mcp:tools.read', 'mcp:tools.execute']
      }
    });
    expect(mcpWithoutCredentials.statusCode, mcpWithoutCredentials.body).toBe(200);
    expect(mcpWithoutCredentials.json()).toMatchObject({
      kind: 'mcp_http',
      authMode: 'none',
      label: 'Public tools'
    });

    const oauthStart = await app.inject({
      method: 'POST',
      url: '/v1/connectors/mcp/oauth/start',
      headers: { cookie: cookie!, 'idempotency-key': 'connector-mcp-oauth-0001' },
      payload: {
        registration: 'dynamic',
        label: 'Secure tools',
        baseUrl: 'https://mcp-oauth.example/tools',
        scopes: ['mcp:tools.read', 'mcp:tools.execute'],
        oauthScopes: ['tools.read', 'offline_access']
      }
    });
    expect(oauthStart.statusCode, oauthStart.body).toBe(200);
    const oauthStartBody = oauthStart.json<{
      authorizationUrl: string;
      authorizationHost: string;
      expiresAt: string;
    }>();
    expect(oauthStartBody.authorizationHost).toBe('mcp-oauth.example');
    expect(oauthStart.body).not.toContain('registered-secret');
    const authorizationUrl = new URL(oauthStartBody.authorizationUrl);
    const oauthState = authorizationUrl.searchParams.get('state');
    expect(oauthState).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    const pendingOAuth = await database.query(
      'SELECT state_hash,secret_ciphertext FROM connector_oauth_attempts'
    );
    expect(pendingOAuth.rows).toHaveLength(1);
    expect(JSON.stringify(pendingOAuth.rows)).not.toContain(oauthState!);

    const oauthCallback = await app.inject({
      method: 'GET',
      url: `/v1/connectors/mcp/oauth/callback?code=one-time-code&state=${encodeURIComponent(oauthState!)}`
    });
    expect(oauthCallback.statusCode, oauthCallback.body).toBe(200);
    expect(oauthCallback.headers['cache-control']).toBe('no-store');
    expect(oauthCallback.body).toContain('Secure tools is connected');
    expect(oauthCallback.body).not.toContain('oauth-access-token');
    expect(mcpOAuthBearer).toBe('Bearer oauth-access-token');
    expect(
      await database.query('SELECT COUNT(*) AS count FROM connector_oauth_attempts')
    ).toMatchObject({ rows: [{ count: 0 }] });

    const oauthReplay = await app.inject({
      method: 'GET',
      url: `/v1/connectors/mcp/oauth/callback?code=replayed-code&state=${encodeURIComponent(oauthState!)}`
    });
    expect(oauthReplay.statusCode).toBe(400);
    expect(oauthReplay.body).toContain('could not be completed');
    const connectorsAfterOAuth = await app.inject({
      method: 'GET',
      url: '/v1/connectors',
      headers: { cookie: cookie! }
    });
    expect(connectorsAfterOAuth.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mcp_http',
          authMode: 'oauth',
          label: 'Secure tools'
        })
      ])
    );
    expect(connectorsAfterOAuth.body).not.toContain('oauth-refresh-token');

    const secondLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      payload: { username: 'private-user' },
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/605.1' }
    });
    expect(secondLogin.statusCode).toBe(200);
    const sessionsResponse = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { cookie: cookie! }
    });
    const sessions =
      sessionsResponse.json<Array<{ id: string; deviceLabel: string; current: boolean }>>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessions.some((session) => session.deviceLabel === 'Safari on iOS')).toBe(true);
    const otherSession = sessions.find((session) => !session.current)!;
    const revokedSession = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${otherSession.id}`,
      headers: { cookie: cookie!, 'idempotency-key': 'session-revoke-0001' },
      payload: {}
    });
    expect(revokedSession.json()).toEqual({ revoked: true, current: false });

    const workspaceId = created.json<{ id: string }>().id;
    const savedMemory = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/memories`,
      headers: { cookie: cookie! },
      payload: {
        target: 'workspace',
        content: 'Reports use a concise executive summary followed by evidence.'
      }
    });
    expect(savedMemory.statusCode, savedMemory.body).toBe(200);
    expect(savedMemory.json()).toMatchObject({
      target: 'workspace',
      content: 'Reports use a concise executive summary followed by evidence.',
      status: 'active',
      source: 'owner'
    });
    const savedSkill = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/skills`,
      headers: { cookie: cookie! },
      payload: {
        name: 'report-review',
        description: 'Review a report before publication',
        content:
          '## When to use\n\nBefore publishing reports.\n\n## Procedure\n\n1. Check evidence.\n\n## Pitfalls\n\n- Unsupported claims.\n\n## Verification\n\nConfirm every claim.'
      }
    });
    expect(savedSkill.statusCode, savedSkill.body).toBe(200);
    expect(savedSkill.json()).toMatchObject({ name: 'report-review', version: 1 });
    const encryptedKnowledge = await database.query(
      'SELECT content_ciphertext FROM workspace_memories'
    );
    const encryptedSkills = await database.query(
      'SELECT name_hash,document_ciphertext FROM workspace_skills'
    );
    expect(JSON.stringify(encryptedKnowledge.rows)).not.toContain('executive summary');
    expect(JSON.stringify(encryptedSkills.rows)).not.toContain('report-review');
    const visibleMemory = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/memories`,
      headers: { cookie: cookie! }
    });
    expect(visibleMemory.json()).toMatchObject([
      {
        content: 'Reports use a concise executive summary followed by evidence.',
        status: 'active',
        source: 'owner'
      }
    ]);
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    const blockedExport = await app.inject({
      method: 'GET',
      url: '/v1/privacy/export',
      headers: { cookie: cookie! }
    });
    expect(blockedExport.statusCode).toBe(403);
    expect(blockedExport.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/options',
      headers: { cookie: cookie! },
      payload: {}
    });
    expect(refreshed.json()).toEqual({ verified: true });
    const workspaceExport = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export`,
      headers: { cookie: cookie! }
    });
    expect(workspaceExport.statusCode).toBe(200);
    expect(workspaceExport.headers['content-disposition']).toContain(
      `athanor-workspace-${workspaceId}.tar.gz`
    );

    await database.query(
      "UPDATE model_releases SET availability='available' WHERE id='openrouter/openai/gpt-oss-120b'"
    );

    const scheduled = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: { cookie: cookie!, 'idempotency-key': 'schedule-create-0001' },
      payload: {
        workspaceId,
        title: 'Private recurring report',
        prompt: 'Review the private workspace and prepare the recurring report',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        spec: { kind: 'interval', everyMinutes: 60 }
      }
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    const scheduleId = scheduled.json<{ id: string }>().id;
    expect(scheduled.json<{ enabled: boolean; nextRunAt: string }>().enabled).toBe(true);
    expect(new Date(scheduled.json<{ nextRunAt: string }>().nextRunAt).getTime()).toBeGreaterThan(
      Date.now()
    );
    const storedSchedule = await database.query(
      'SELECT title_ciphertext,prompt_ciphertext,spec FROM task_schedules WHERE id=$1',
      [scheduleId]
    );
    expect(JSON.stringify(storedSchedule.rows)).not.toContain('Private recurring report');
    expect(JSON.stringify(storedSchedule.rows)).not.toContain('Review the private workspace');
    const pausedSchedule = await app.inject({
      method: 'POST',
      url: `/v1/schedules/${scheduleId}/pause`,
      headers: { cookie: cookie!, 'idempotency-key': 'schedule-pause-0001' },
      payload: {}
    });
    expect(pausedSchedule.json<{ enabled: boolean }>().enabled).toBe(false);
    const resumedSchedule = await app.inject({
      method: 'POST',
      url: `/v1/schedules/${scheduleId}/resume`,
      headers: { cookie: cookie!, 'idempotency-key': 'schedule-resume-0001' },
      payload: {}
    });
    expect(resumedSchedule.json<{ enabled: boolean }>().enabled).toBe(true);
    const schedules = await app.inject({
      method: 'GET',
      url: '/v1/schedules',
      headers: { cookie: cookie! }
    });
    expect(schedules.json<Array<{ id: string; title: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scheduleId, title: 'Private recurring report' })
      ])
    );
    const privacyExport = await app.inject({
      method: 'GET',
      url: '/v1/privacy/export',
      headers: { cookie: cookie! }
    });
    expect(privacyExport.statusCode).toBe(200);
    const privacyExportBody = privacyExport.json<{
      schemaVersion: number;
      scheduleContents: Array<{ scheduleId: string; title: string; prompt: string }>;
      connectors: Array<{ kind: string; label: string }>;
    }>();
    expect(privacyExportBody).toMatchObject({
      schemaVersion: 12,
      scheduleContents: [
        {
          scheduleId,
          title: 'Private recurring report',
          prompt: 'Review the private workspace and prepare the recurring report'
        }
      ]
    });
    expect(privacyExportBody.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'github', label: 'My GitHub' }),
        expect.objectContaining({ kind: 'mcp_http', label: 'Public tools' }),
        expect.objectContaining({ kind: 'mcp_http', label: 'Secure tools' })
      ])
    );
    await database.query('UPDATE task_schedules SET next_run_at=NOW() WHERE id=$1', [scheduleId]);
    let scheduledTaskId: string | undefined;
    for (let attempt = 0; attempt < 30 && !scheduledTaskId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const row = await database.query<{ last_task_id: string | null }>(
        'SELECT last_task_id FROM task_schedules WHERE id=$1',
        [scheduleId]
      );
      scheduledTaskId = row.rows[0]?.last_task_id ? String(row.rows[0]?.last_task_id) : undefined;
    }
    expect(scheduledTaskId).toBeTruthy();
    const scheduledTask = await database.query('SELECT status FROM tasks WHERE id=$1', [
      scheduledTaskId
    ]);
    expect(scheduledTask.rows[0]?.status).toBe('queued');
    await database.query("UPDATE tasks SET status='completed',completed_at=NOW() WHERE id=$1", [
      scheduledTaskId
    ]);

    const previewCreated = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/previews`,
      headers: { cookie: cookie!, 'idempotency-key': 'preview-create-0001' },
      payload: { label: 'Private app', port: 3000 }
    });
    expect(previewCreated.statusCode, previewCreated.body).toBe(201);
    const privatePreview = previewCreated.json<{
      id: string;
      url: string;
      visibility: string;
      status: string;
      expiresAt: string | null;
    }>();
    expect(privatePreview).toMatchObject({ visibility: 'private', status: 'active' });
    // The owner's own app on the owner's own computer, with no lifetime to have chosen. What is
    // left is an idle window every visit pushes back out, so this is weeks rather than hours.
    expect(
      (new Date(privatePreview.expiresAt!).getTime() - Date.now()) / 86_400_000
    ).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);
    const privateUrl = new URL(privatePreview.url);
    const privateAccess = privateUrl.searchParams.get('access');
    expect(privateAccess).toBeTruthy();
    const rawPreview = await database.query(
      'SELECT access_token_hash,slug FROM workspace_previews'
    );
    expect(JSON.stringify(rawPreview.rows)).not.toContain(privateAccess);
    const previewHost = privateUrl.host;
    const deniedPreview = await previewApp.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost }
    });
    expect(deniedPreview.statusCode).toBe(401);
    const previewBootstrap = await previewApp.inject({
      method: 'GET',
      url: `/?access=${encodeURIComponent(privateAccess!)}`,
      headers: { host: previewHost }
    });
    expect(previewBootstrap.statusCode).toBe(303);
    expect(previewBootstrap.headers.location).toBe('/');
    const previewCookieHeader = previewBootstrap.headers['set-cookie'];
    const previewCookie = (
      Array.isArray(previewCookieHeader) ? previewCookieHeader[0] : previewCookieHeader
    )?.split(';', 1)[0];
    expect(previewCookie).toContain('athanor-preview-access=');
    const privatePage = await previewApp.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: previewCookie! }
    });
    expect(privatePage.statusCode).toBe(200);
    expect(privatePage.body).toContain('Workspace preview');
    expect(privatePage.headers['content-security-policy']).toContain(
      'frame-ancestors http://localhost:5173'
    );
    expect(privatePage.headers['cache-control']).toBe('private, no-store');
    expect(forwardedPreviewCookie).toBeNull();
    expect(String(privatePage.headers['set-cookie'])).toContain('preview_app_session=opaque');
    const appSessionPage = await previewApp.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost, cookie: `${previewCookie!}; preview_app_session=opaque` }
    });
    expect(appSessionPage.statusCode).toBe(200);
    expect(forwardedPreviewCookie).toBe('preview_app_session=opaque');
    const publishedPreview = await app.inject({
      method: 'POST',
      url: `/v1/previews/${privatePreview.id}/publish`,
      headers: { cookie: cookie!, 'idempotency-key': 'preview-publish-0001' },
      payload: { confirmPublic: true }
    });
    expect(publishedPreview.statusCode, publishedPreview.body).toBe(200);
    const published = publishedPreview.json<{
      visibility: string;
      expiresAt: string | null;
      warning: string;
    }>();
    expect(published).toMatchObject({ visibility: 'public', expiresAt: null });
    expect(published).not.toHaveProperty('hostingMode');
    // The warning used to promise an "always ready" mode that held the box awake and consumed
    // "included active hours". Neither exists, and nobody sells hours.
    expect(published.warning).toContain('public internet');
    expect(published.warning).not.toMatch(/active hours|always ready/i);
    const publicPage = await previewApp.inject({
      method: 'GET',
      url: '/',
      headers: { host: previewHost }
    });
    expect(publicPage.statusCode).toBe(200);
    // Taking a site off the public internet hands the owner their private link back, still
    // persistent. It used to hand back two hours.
    const unpublished = await app.inject({
      method: 'POST',
      url: `/v1/previews/${privatePreview.id}/unpublish`,
      headers: { cookie: cookie!, 'idempotency-key': 'preview-unpublish-0001' },
      payload: {}
    });
    expect(unpublished.statusCode, unpublished.body).toBe(200);
    const returned = unpublished.json<{ visibility: string; expiresAt: string | null }>();
    expect(returned.visibility).toBe('private');
    expect((new Date(returned.expiresAt!).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(
      PREVIEW_IDLE_EXPIRY_DAYS - 1
    );
    const revokedPreview = await app.inject({
      method: 'DELETE',
      url: `/v1/previews/${privatePreview.id}`,
      headers: { cookie: cookie!, 'idempotency-key': 'preview-revoke-0001' },
      payload: {}
    });
    expect(revokedPreview.json()).toEqual({ revoked: true });
    expect(
      (
        await previewApp.inject({
          method: 'GET',
          url: '/',
          headers: { host: previewHost }
        })
      ).statusCode
    ).toBe(404);

    const task = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie: cookie!, 'idempotency-key': 'task-create-0001' },
      payload: {
        workspaceId,
        prompt: 'Prepare a concise report',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1
      }
    });
    expect(task.statusCode).toBe(200);
    const taskId = task.json<{ id: string }>().id;
    expect(task.json()).toMatchObject({ securityMode: 'balanced', forkKind: null });
    const conversationSearch = await app.inject({
      method: 'GET',
      url: `/v1/search?q=${encodeURIComponent('concise report')}&workspaceId=${workspaceId}`,
      headers: { cookie: cookie! }
    });
    expect(conversationSearch.statusCode, conversationSearch.body).toBe(200);
    expect(conversationSearch.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId, workspaceId, title: 'Prepare a concise report' })
      ])
    );
    const reviewedTask = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}/security-mode`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-security-review-0001' },
      payload: { securityMode: 'review' }
    });
    expect(reviewedTask.statusCode, reviewedTask.body).toBe(200);
    expect(reviewedTask.json()).toMatchObject({ securityMode: 'review' });
    /*
     * And back the other way with no passkey. Loosening used to demand a step-up inside the last
     * five minutes, so reaching Autonomous meant a fingerprint every time - on the setting whose
     * whole purpose is to be interrupted less. The session is already passkey-bound, and somebody
     * holding it can send tasks regardless; the prompt bought almost nothing and cost the owner the
     * control they reach for most. Step-up stays on the provider credential and on raising a
     * spending cap, which is asserted elsewhere in this file.
     */
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    const autonomousTask = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}/security-mode`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-security-autonomous-0001' },
      payload: { securityMode: 'autonomous' }
    });
    expect(autonomousTask.statusCode, autonomousTask.body).toBe(200);
    expect(autonomousTask.json()).toMatchObject({ securityMode: 'autonomous' });
    // Put the step-up back where the rest of this test found it.
    await database.query('UPDATE sessions SET step_up_at=NOW()');
    await database.query("UPDATE tasks SET security_mode='balanced' WHERE id=$1", [taskId]);
    const firstPlan = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/plan`,
      headers: { cookie: cookie! },
      payload: {
        expectedVersion: 0,
        branchName: 'Team plan',
        steps: [
          { title: 'Read the private inputs', status: 'in_progress' },
          { title: 'Prepare the confidential result', status: 'pending' }
        ]
      }
    });
    expect(firstPlan.statusCode, firstPlan.body).toBe(200);
    expect(firstPlan.json<{ version: number; createdBy: string }>()).toMatchObject({
      version: 1,
      createdBy: 'user'
    });
    const storedPlan = await database.query(
      'SELECT branch_name,steps_ciphertext FROM task_plans WHERE task_id=$1',
      [taskId]
    );
    expect(JSON.stringify(storedPlan.rows)).not.toContain('confidential result');
    expect(JSON.stringify(storedPlan.rows)).not.toContain('Team plan');
    const planHistory = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/plans`,
      headers: { cookie: cookie! }
    });
    expect(
      planHistory.json<Array<{ version: number; steps: Array<{ title: string }> }>>()
    ).toMatchObject([
      {
        version: 1,
        steps: [{ title: 'Read the private inputs' }, { title: 'Prepare the confidential result' }]
      }
    ]);
    const stalePlan = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/plan`,
      headers: { cookie: cookie! },
      payload: {
        expectedVersion: 0,
        branchName: 'Stale edit',
        steps: [{ title: 'This must not replace the active plan' }]
      }
    });
    expect(stalePlan.statusCode).toBe(409);
    expect(stalePlan.json<{ error: { code: string } }>().error.code).toBe('plan_version_conflict');
    // A conversation is reachable through the workspace it lives in, so a second account gets
    // the same answer here as it does everywhere else on this box.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/tasks/${taskId}`,
          headers: { cookie: strangerCookie! }
        })
      ).statusCode
    ).toBe(404);
    expect(task.json<{ title: string }>().title).toBe('Prepare a concise report');
    const storedTaskContent = await database.query(
      'SELECT title,prompt_ciphertext FROM tasks WHERE id=$1',
      [taskId]
    );
    const storedEvents = await database.query(
      'SELECT summary,payload_ciphertext FROM task_events WHERE task_id=$1',
      [taskId]
    );
    expect(JSON.stringify(storedTaskContent.rows)).not.toContain('Prepare a concise report');
    expect(JSON.stringify(storedEvents.rows)).not.toContain('Prepare a concise report');
    const events = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/events`,
      headers: { cookie: cookie! }
    });
    expect(events.statusCode).toBe(200);
    const busySnapshot = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/snapshots`,
      headers: { cookie: cookie!, 'idempotency-key': 'snapshot-create-busy-0001' },
      payload: { name: 'Unsafe while task runs' }
    });
    expect(busySnapshot.statusCode).toBe(409);
    expect(busySnapshot.json<{ error: { code: string } }>().error.code).toBe('workspace_busy');
    const paused = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/pause`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-pause-0001' },
      payload: {}
    });
    expect(paused.json<{ status: string }>().status).toBe('paused');
    const taskWorkspace = await store.getWorkspaceById(workspaceId);
    const taskKey = unwrapDataKey(taskWorkspace!.wrappedKey!, Buffer.alloc(32, 7), workspaceId);
    const checkpoint = encryptJson(
      {
        messages: [
          { role: 'system', content: 'System policy' },
          { role: 'user', content: 'Prepare a concise report' },
          { role: 'assistant', content: 'The first report is ready.' }
        ],
        step: 1,
        credits: 0.2
      },
      taskKey,
      `task-state:${taskId}`
    );
    await database.query(
      "UPDATE tasks SET status='completed',agent_state_ciphertext=$2::jsonb,updated_at=NOW() WHERE id=$1",
      [taskId, JSON.stringify(checkpoint)]
    );
    const branchPoint = events
      .json<Array<{ id: string; kind: string }>>()
      .find((event) => event.kind === 'user_message')!;
    const branched = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/branch`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-branch-0001' },
      payload: { eventId: branchPoint.id }
    });
    expect(branched.statusCode, branched.body).toBe(200);
    const branch = branched.json<{
      id: string;
      parentTaskId: string;
      branchedFromEventId: string;
      status: string;
      title: string;
    }>();
    expect(branch).toMatchObject({
      parentTaskId: taskId,
      branchedFromEventId: branchPoint.id,
      status: 'completed',
      title: 'Prepare a concise report · branch'
    });
    const branchEvents = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${branch.id}/events`,
      headers: { cookie: cookie! }
    });
    expect(branchEvents.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user_message',
          payload: { markdown: 'Prepare a concise report' }
        })
      ])
    );
    const storedBranch = await database.query(
      'SELECT title,prompt_ciphertext,agent_state_ciphertext FROM tasks WHERE id=$1',
      [branch.id]
    );
    expect(JSON.stringify(storedBranch.rows)).not.toContain('Prepare a concise report');
    const edited = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-edit-trajectory-0001' },
      payload: {
        operation: 'edit',
        eventId: branchPoint.id,
        prompt: 'Prepare a detailed report with a comparison table',
        maxComputeCredits: 0.25,
        stopSource: false
      }
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      parentTaskId: taskId,
      branchedFromEventId: branchPoint.id,
      forkKind: 'edit',
      securityMode: 'balanced',
      status: 'queued'
    });
    const editedTaskId = edited.json<{ id: string }>().id;
    const editedEvents = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${editedTaskId}/events`,
      headers: { cookie: cookie! }
    });
    expect(
      editedEvents
        .json<
          Array<{
            kind: string;
            payload?: { markdown?: string; editedFromEventId?: string };
          }>
        >()
        .some(
          (event) =>
            event.kind === 'user_message' &&
            event.payload?.markdown === 'Prepare a detailed report with a comparison table' &&
            event.payload.editedFromEventId === branchPoint.id
        )
    ).toBe(true);
    const cancelledEdit = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${editedTaskId}/cancel`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-edit-cancel-0001' },
      payload: {}
    });
    expect(cancelledEdit.json<{ status: string }>().status).toBe('cancelled');

    const assistantEvent = await store.appendTaskEvent({
      taskId,
      kind: 'assistant_message',
      summary: 'Assistant response',
      payloadCiphertext: encryptJson(
        { markdown: 'The first report is ready.' },
        taskKey,
        `task-event:${taskId}`
      )
    });
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-retry-trajectory-0001' },
      payload: {
        operation: 'retry',
        eventId: assistantEvent.id,
        maxComputeCredits: 0.25,
        stopSource: false
      }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({
      parentTaskId: taskId,
      branchedFromEventId: assistantEvent.id,
      forkKind: 'retry',
      status: 'queued'
    });
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${retried.json<{ id: string }>().id}/cancel`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-retry-cancel-0001' },
      payload: {}
    });
    const followedUp = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/messages`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-follow-up-0001' },
      payload: {
        prompt: 'Now turn it into a presentation',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1
      }
    });
    expect(followedUp.statusCode, followedUp.body).toBe(200);
    expect(
      followedUp.json<{ id: string; status: string; maxComputeCredits: number }>()
    ).toMatchObject({ id: taskId, status: 'queued', maxComputeCredits: 2 });
    const followedUpEvents = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/events`,
      headers: { cookie: cookie! }
    });
    expect(
      followedUpEvents
        .json<Array<{ kind: string; payload?: { markdown?: string } }>>()
        .some(
          (event) =>
            event.kind === 'user_message' &&
            event.payload?.markdown === 'Now turn it into a presentation'
        )
    ).toBe(true);
    const encryptedFollowUp = await database.query(
      "SELECT payload_ciphertext FROM task_events WHERE task_id=$1 AND kind='user_message'",
      [taskId]
    );
    expect(JSON.stringify(encryptedFollowUp.rows)).not.toContain('Now turn it into a presentation');
    const queuedFollowUp = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/messages`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-follow-up-queued-0001' },
      payload: {
        prompt: 'Use the green visual direction and add speaker notes',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1
      }
    });
    expect(queuedFollowUp.statusCode, queuedFollowUp.body).toBe(200);
    expect(
      queuedFollowUp.json<{
        status: string;
        maxComputeCredits: number;
        queuedMessageCount: number;
      }>()
    ).toMatchObject({ status: 'queued', maxComputeCredits: 2, queuedMessageCount: 1 });
    const queuedRows = await database.query(
      'SELECT prompt_ciphertext,status,reservation_key FROM task_message_queue WHERE task_id=$1',
      [taskId]
    );
    expect(queuedRows.rows).toHaveLength(1);
    expect(queuedRows.rows[0]?.status).toBe('queued');
    expect(JSON.stringify(queuedRows.rows)).not.toContain('green visual direction');
    const queueEvents = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/events`,
      headers: { cookie: cookie! }
    });
    expect(
      queueEvents
        .json<Array<{ kind: string; payload?: { markdown?: string } }>>()
        .some(
          (event) =>
            event.kind === 'queued_message' &&
            event.payload?.markdown === 'Use the green visual direction and add speaker notes'
        )
    ).toBe(true);
    const cancelledTrajectory = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: { cookie: cookie!, 'idempotency-key': 'task-cancel-with-queue-0001' },
      payload: {}
    });
    expect(cancelledTrajectory.statusCode, cancelledTrajectory.body).toBe(200);
    expect(cancelledTrajectory.json()).toMatchObject({
      status: 'cancelled',
      queuedMessageCount: 0
    });
    const cancelledQueue = await database.query(
      'SELECT status FROM task_message_queue WHERE task_id=$1',
      [taskId]
    );
    expect(cancelledQueue.rows).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    const reservedAfterCancel = await database.query(
      "SELECT state FROM usage_entries WHERE task_id=$1 AND state='reserved'",
      [taskId]
    );
    expect(reservedAfterCancel.rows).toHaveLength(0);
    await database.query("UPDATE tasks SET status='completed',updated_at=NOW() WHERE id=$1", [
      taskId
    ]);
    const eventStream = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/events/stream`,
      headers: { cookie: cookie! }
    });
    expect(eventStream.statusCode).toBe(200);
    expect(eventStream.headers['content-type']).toContain('text/event-stream');
    expect(eventStream.body).toContain('id: 1');
    expect(eventStream.body).toContain('event: terminal');

    const snapshot = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/snapshots`,
      headers: { cookie: cookie!, 'idempotency-key': 'snapshot-create-0001' },
      payload: { name: 'Known good workspace' }
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json<{ status: string; scope: string }>()).toMatchObject({
      status: 'ready',
      scope: 'workspace_files_and_browser_profile'
    });
    const snapshotId = snapshot.json<{ id: string }>().id;
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/snapshots/${snapshotId}/restore`,
      headers: { cookie: cookie!, 'idempotency-key': 'snapshot-restore-0001' },
      payload: { confirmName: payload.name }
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const restoreResult = restored.json<{
      workspace: { status: string };
      safetySnapshotId: string;
      scope: string;
      excludes: string[];
    }>();
    expect(restoreResult.workspace.status).toBe('running');
    expect(restoreResult.scope).toBe('workspace_files_and_browser_profile');
    expect(restoreResult.excludes).toContain('task_history');
    const listedSnapshots = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/snapshots`,
      headers: { cookie: cookie! }
    });
    expect(listedSnapshots.json<Array<{ status: string }>>()).toHaveLength(2);
    expect(
      listedSnapshots.json<Array<{ status: string }>>().every((item) => item.status === 'ready')
    ).toBe(true);
    const deletedSnapshot = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/snapshots/${restoreResult.safetySnapshotId}`,
      headers: { cookie: cookie!, 'idempotency-key': 'snapshot-delete-0001' },
      payload: {}
    });
    expect(deletedSnapshot.json()).toMatchObject({ deleted: true });
    // The longest test in this file - a whole install, a scheduled run and every production
    // boundary in one pass - and the only one that was held to twenty seconds while its siblings
    // get thirty or forty. It takes fifteen on an idle machine, which left it failing on nothing
    // more than the other eleven suites running beside it.
  }, 40_000);
});

const isolatedConfig = (directory: string): ApiConfig => ({
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'provider_catalog',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  ATHANOR_STATE_PATH: directory,
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 443,
  RELAY_LOCAL_HTTP_PORT: 80,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  API_HOST: '127.0.0.1',
  API_PORT: 4101,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 4401,
  RESERVED_PREVIEW_PORTS: '4201,4203',
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://athanor:unused@127.0.0.1:5432/athanor',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
  RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
  WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'athanor Test',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'authorization-test-worker',
  // No agent runs behind these: they assert the API's own answers, not the agent's.
  EMBEDDED_WORKER: false,
  WORKER_CONCURRENCY: 2,
  WORKER_POLL_MS: 60_000,
  SCHEDULER_POLL_MS: 60_000,
  TASK_MAX_STEPS: 3,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  LOG_LEVEL: 'silent',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
});

const sessionCookie = (response: { headers: Record<string, unknown> }): string => {
  const header = response.headers['set-cookie'];
  const value = (Array.isArray(header) ? header[0] : header) as string | undefined;
  if (!value) throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
};

describe('workspace authorization boundaries', () => {
  test("keeps a second account away from every route on the owner's computer", async () => {
    const artifactBytes = Buffer.from('# Private report\n');
    const runnerDeletes: string[] = [];
    let exportStreams = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? 'GET';
        if (requestUrl.includes('/usage'))
          return new Response(
            JSON.stringify({
              storageBytes: artifactBytes.byteLength,
              hostStorageTotalBytes: 1_000_000_000,
              hostStorageAvailableBytes: 900_000_000
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        if (requestUrl.endsWith('/export')) {
          exportStreams += 1;
          return new Response(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]), {
            status: 200,
            headers: { 'content-type': 'application/gzip' }
          });
        }
        if (requestUrl.includes('/file?path=')) {
          if (method === 'DELETE') {
            runnerDeletes.push(decodeURIComponent(requestUrl.split('/file?path=')[1]!));
            return new Response(JSON.stringify({ deleted: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          if (method === 'GET')
            return new Response(Uint8Array.from(artifactBytes), {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' }
            });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-authz-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const owner = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const stranger = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'reader' } })
    );

    const workspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: owner, 'idempotency-key': 'authz-workspace-0001' },
      payload: {
        name: 'The computer',
        storageLimitBytes: 10_000_000_000,
        region: 'auto'
      }
    });
    expect(workspace.statusCode, workspace.body).toBe(200);
    expect(workspace.statusCode, workspace.body).toBe(200);
    const workspaceId = workspace.json<{ id: string }>().id;

    /**
     * There is one owner, and nothing on this box can put a second person on it - so the whole of
     * the authorization question for a workspace-scoped route is "is this the owner's own
     * workspace", asked once in the preHandler. A second account is answered exactly as it would
     * be for a workspace that does not exist, because from where it stands there is no difference.
     */
    for (const url of [
      `/v1/workspaces/${workspaceId}/files`,
      `/v1/workspaces/${workspaceId}/file?path=workspace/report.md`,
      `/v1/workspaces/${workspaceId}/artifacts`,
      `/v1/workspaces/${workspaceId}/memories`,
      `/v1/workspaces/${workspaceId}/skills`,
      `/v1/workspaces/${workspaceId}/snapshots`,
      `/v1/workspaces/${workspaceId}/previews`,
      `/v1/workspaces/${workspaceId}/brief`,
      `/v1/workspaces/${workspaceId}/export`,
      `/v1/workspaces/${workspaceId}/terminal-token`,
      `/v1/workspaces/${workspaceId}/browser-token`,
      `/v1/workspaces/${workspaceId}/desktop-token`
    ]) {
      const refused = await app.inject({ method: 'GET', url, headers: { cookie: stranger } });
      expect({ url, status: refused.statusCode }).toEqual({ url, status: 404 });
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('workspace_not_found');
      // A refusal must never carry the thing it refused: the capability routes mint a live
      // credential for the machine, and the export streams the whole of it.
      expect(refused.body).not.toContain('token');
    }
    expect(exportStreams).toBe(0);

    const readableFiles = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/files`,
      headers: { cookie: owner }
    });
    expect(readableFiles.statusCode, readableFiles.body).toBe(200);

    const ownerExport = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/export`,
      headers: { cookie: owner }
    });
    expect(ownerExport.statusCode, ownerExport.body).toBe(200);
    expect(exportStreams).toBe(1);

    const artifact = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/artifacts`,
      headers: { cookie: owner, 'idempotency-key': 'authz-artifact-0001' },
      payload: { path: 'workspace/report.md', name: 'report.md', mimeType: 'text/markdown' }
    });
    expect(artifact.statusCode, artifact.body).toBe(200);
    const artifactId = artifact.json<{ id: string }>().id;

    // The artifact routes sit outside /v1/workspaces/:workspaceId, so the preHandler never sees
    // them and the owner-scoped read in the handler is the whole gate.
    const strangerDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/artifacts/${artifactId}`,
      headers: { cookie: stranger, 'idempotency-key': 'authz-artifact-delete-0001' },
      payload: {}
    });
    expect(strangerDelete.statusCode).toBe(404);
    expect(runnerDeletes).toEqual([]);
    const strangerArtifact = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { cookie: stranger }
    });
    expect(strangerArtifact.statusCode, strangerArtifact.body).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/workspaces/${workspaceId}/artifacts`,
          headers: { cookie: owner }
        })
      ).json<Array<{ id: string }>>()
    ).toHaveLength(1);

    const ownerDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/artifacts/${artifactId}`,
      headers: { cookie: owner, 'idempotency-key': 'authz-artifact-delete-0002' },
      payload: {}
    });
    expect(ownerDelete.statusCode, ownerDelete.body).toBe(200);
    expect(runnerDeletes).toHaveLength(1);
    expect(runnerDeletes[0]).toContain('.athanor/artifacts/');

    /*
     * An artifact never decides how the browser treats it.
     *
     * `publish_artifact` takes a free-form mimeType from the agent, and the agent takes what
     * amounts to instructions from any page it reads. Replayed into the response, a `text/html`
     * artifact opened from the Saved results list is a script on this box's own origin, holding the
     * owner's session - and there is no CSP on /v1/ to catch it. So the declaration is constrained
     * here rather than trusted.
     */
    const hostileTypes = ['text/html', 'image/svg+xml', 'application/xhtml+xml'];
    for (const [index, hostile] of hostileTypes.entries()) {
      const published = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/artifacts`,
        headers: { cookie: owner, 'idempotency-key': `authz-artifact-hostile-000${index}` },
        payload: { path: 'workspace/report.md', name: 'page.html', mimeType: hostile }
      });
      expect(published.statusCode, published.body).toBe(200);
      const served = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${published.json<{ id: string }>().id}/content`,
        headers: { cookie: owner }
      });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toContain('application/octet-stream');
      expect(String(served.headers['content-disposition'])).toContain('attachment');
      expect(String(served.headers['content-security-policy'])).toContain('sandbox');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
    }
    // A type that is safe to look at is still shown, or the rule would have cost the feature.
    const image = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/artifacts`,
      headers: { cookie: owner, 'idempotency-key': 'authz-artifact-image' },
      payload: { path: 'workspace/report.md', name: 'chart.png', mimeType: 'image/png' }
    });
    const shown = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${image.json<{ id: string }>().id}/content`,
      headers: { cookie: owner }
    });
    expect(shown.headers['content-type']).toContain('image/png');
    expect(String(shown.headers['content-disposition'])).toContain('inline');
  }, 30_000);

  test('throttles repeated passkey ceremonies from one caller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-rate-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login/options',
        payload: { username: 'nobody' }
      });
    for (let index = 0; index < 20; index += 1) expect((await attempt()).statusCode).toBe(200);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('auth_rate_limited');
  }, 30_000);
});

describe('idempotency request fingerprints', () => {
  test('digests binary upload bodies as raw bytes', () => {
    const body = Buffer.from('a'.repeat(4096));
    expect(idempotencyRequestHash('PUT', '/v1/workspaces/w/file?path=a', body)).toBe(
      sha256(`PUT\n/v1/workspaces/w/file?path=a\nbytes:${sha256(body)}`)
    );
  });

  test('separates upload bodies whose contents differ', () => {
    const url = '/v1/workspaces/w/file?path=a';
    expect(idempotencyRequestHash('PUT', url, Buffer.from('one'))).not.toBe(
      idempotencyRequestHash('PUT', url, Buffer.from('two'))
    );
  });

  test('still fingerprints JSON bodies structurally', () => {
    expect(idempotencyRequestHash('POST', '/v1/tasks', { prompt: 'hello' })).toBe(
      sha256('POST\n/v1/tasks\n{"prompt":"hello"}')
    );
  });
});

describe('conversation management', () => {
  test('renames a conversation and deletes it owner-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        // Task creation refuses a model that has no live route, so the catalogue refresh that
        // runs on provider connect has to see one.
        if (requestUrl.endsWith('/models'))
          return json({
            data: seedModels().map((model) => ({
              id: model.providerModelId,
              context_length: model.contextTokens,
              architecture: { input_modalities: model.modalities },
              supported_parameters: ['tools', 'reasoning']
            }))
          });
        if (requestUrl.endsWith('/endpoints/zdr'))
          return json({
            data: seedModels().map((model) => ({ model_id: model.providerModelId, status: 0 }))
          });
        if (requestUrl.includes('/benchmarks?')) return json({ data: [] });
        return json({
          storageBytes: 0,
          hostStorageTotalBytes: 1_000_000_000,
          hostStorageAvailableBytes: 900_000_000,
          ok: true
        });
      })
    );
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-tasks-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const owner = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const reader = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'reader' } })
    );

    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie: owner, 'idempotency-key': 'task-mgmt-workspace' },
        payload: {
          name: 'Computer',
          storageLimitBytes: 10_000_000_000,
          region: 'auto'
        }
      })
    ).json<{ id: string }>().id;

    const provider = await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-provider' },
      payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
    });
    expect(provider.statusCode, provider.body).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-create' },
      payload: {
        workspaceId,
        prompt: 'Summarise the quarterly numbers',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 5
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const taskId = created.json<{ id: string }>().id;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-rename' },
      payload: { title: 'Q3 numbers' }
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<{ title: string }>().title).toBe('Q3 numbers');
    // The stored title stays encrypted, so the rename must survive a fresh read.
    expect(
      (
        await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { cookie: owner } })
      ).json<{ title: string }>().title
    ).toBe('Q3 numbers');

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-rename-empty' },
      payload: { title: '   ' }
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    // A second account cannot destroy the history, and is told what it would be told about a
    // conversation that does not exist - because from where it stands there is no difference.
    const strangerDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: reader, 'idempotency-key': 'task-mgmt-delete-editor' },
      payload: {}
    });
    expect(strangerDelete.statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { cookie: owner } }))
        .statusCode
    ).toBe(200);

    // A running conversation is refused rather than torn out from under the worker.
    const activeDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-delete-active' },
      payload: {}
    });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.json<{ error: { code: string } }>().error.code).toBe('task_active');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/tasks/${taskId}/cancel`,
          headers: { cookie: owner, 'idempotency-key': 'task-mgmt-cancel' },
          payload: {}
        })
      ).statusCode
    ).toBe(200);

    const ownerDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: owner, 'idempotency-key': 'task-mgmt-delete-owner' },
      payload: {}
    });
    expect(ownerDelete.statusCode, ownerDelete.body).toBe(200);
    expect(ownerDelete.json<{ deleted: boolean }>().deleted).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { cookie: owner } }))
        .statusCode
    ).toBe(404);
  }, 30_000);

  /*
   * Pinning holds a conversation above the dates and filing takes it out of the list, and both were
   * reachable through this route and through nothing in the client. The list is what has to change
   * for either to mean anything, so that is what is asserted: the order it comes back in, and
   * whether it comes back at all.
   */
  test('pins a conversation to the top of the list and files another out of it', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-filing-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie, 'idempotency-key': 'filing-workspace' },
        payload: { name: 'Filing' }
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie, 'idempotency-key': 'filing-provider' },
      payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
    });
    const create = async (prompt: string, key: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/v1/tasks',
          headers: { cookie, 'idempotency-key': key },
          payload: {
            workspaceId,
            prompt,
            modelId: 'openrouter/openai/gpt-oss-120b',
            privacyRoute: 'provider_zdr',
            maxComputeCredits: 5
          }
        })
      ).json<{ id: string }>().id;
    const older = await create('The one worth keeping', 'filing-task-1');
    const newer = await create('Today’s question', 'filing-task-2');

    const listed = async () =>
      (await app.inject({ method: 'GET', url: '/v1/tasks', headers: { cookie } })).json<{
        tasks: Array<{ id: string; pinned: boolean; archivedAt: string | null }>;
      }>().tasks;
    expect((await listed()).map((task) => task.id)).toEqual([newer, older]);

    const pinned = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${older}`,
      headers: { cookie, 'idempotency-key': 'filing-pin' },
      payload: { pinned: true }
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json<{ pinned: boolean }>().pinned).toBe(true);
    expect((await listed()).map((task) => task.id)).toEqual([older, newer]);

    const filed = await app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${newer}`,
      headers: { cookie, 'idempotency-key': 'filing-archive' },
      payload: { archived: true }
    });
    expect(filed.statusCode, filed.body).toBe(200);
    expect(filed.json<{ archivedAt: string | null }>().archivedAt).not.toBeNull();
    expect((await listed()).map((task) => task.id)).toEqual([older]);
    // Filed away, not gone: it is still there to be opened, and asking for it says so.
    const archived = (
      await app.inject({ method: 'GET', url: '/v1/tasks?include=archived', headers: { cookie } })
    ).json<{ tasks: Array<{ id: string }> }>().tasks;
    expect(archived.map((task) => task.id)).toEqual([newer]);
  }, 30_000);

  /*
   * The bootstrap carries the newest page and the cursor that resumes it. The cursor had no caller
   * at all, so a box with more conversations than one page could only reach the older ones through
   * search - which needs the owner to remember something about them first.
   */
  test('resumes the conversation list from the cursor the bootstrap carries', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-taskpage-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie, 'idempotency-key': 'page-workspace' },
        payload: { name: 'Paging' }
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie, 'idempotency-key': 'page-provider' },
      payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
    });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/tasks',
            headers: { cookie, 'idempotency-key': `page-task-${index}` },
            payload: {
              workspaceId,
              prompt: `Question ${index}`,
              modelId: 'openrouter/openai/gpt-oss-120b',
              privacyRoute: 'provider_zdr',
              maxComputeCredits: 5
            }
          })
        ).json<{ id: string }>().id
      );

    const firstPage = (
      await app.inject({ method: 'GET', url: '/v1/tasks?limit=2', headers: { cookie } })
    ).json<{ tasks: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean }>();
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    const nextPage = (
      await app.inject({
        method: 'GET',
        url: `/v1/tasks?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        headers: { cookie }
      })
    ).json<{ tasks: Array<{ id: string }>; hasMore: boolean }>();
    // The two pages together are the whole list, in order, with nothing repeated or skipped.
    expect([...firstPage.tasks, ...nextPage.tasks].map((task) => task.id)).toEqual(
      [...ids].reverse()
    );
    expect(nextPage.hasMore).toBe(false);

    const bootstrap = (
      await app.inject({ method: 'GET', url: '/v1/bootstrap', headers: { cookie } })
    ).json<{ tasksCursor: string | null }>();
    // One page holds all three, so the client is told there is nothing to resume.
    expect(bootstrap.tasksCursor).toBeNull();
  }, 30_000);
});

const stubProviderFetch = (onRunnerRequest?: (url: string) => void) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      if (requestUrl.endsWith('/models'))
        return json({
          data: seedModels().map((model) => ({
            id: model.providerModelId,
            context_length: model.contextTokens,
            architecture: { input_modalities: model.modalities },
            supported_parameters: ['tools', 'reasoning']
          }))
        });
      if (requestUrl.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((model) => ({ model_id: model.providerModelId, status: 0 }))
        });
      if (requestUrl.includes('/benchmarks?')) return json({ data: [] });
      onRunnerRequest?.(requestUrl);
      return json({
        storageBytes: 0,
        hostStorageTotalBytes: 1_000_000_000,
        hostStorageAvailableBytes: 900_000_000,
        ok: true
      });
    })
  );

const masterKey = Buffer.alloc(32, 9);

/** A signed-in owner with a workspace, a connected provider and one task. */
const seedOwnerWithTask = async (
  app: Awaited<ReturnType<typeof buildServer>>['app'],
  prefix: string,
  prompt: string
) => {
  const cookie = sessionCookie(
    await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
  );
  const workspaceId = (
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie, 'idempotency-key': `${prefix}-workspace` },
      payload: {
        name: 'Computer',
        storageLimitBytes: 10_000_000_000,
        region: 'auto'
      }
    })
  ).json<{ id: string }>().id;
  const provider = await app.inject({
    method: 'PUT',
    url: '/v1/providers',
    headers: { cookie, 'idempotency-key': `${prefix}-provider` },
    payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
  });
  expect(provider.statusCode, provider.body).toBe(200);
  const created = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { cookie, 'idempotency-key': `${prefix}-task` },
    payload: {
      workspaceId,
      prompt,
      modelId: 'openrouter/openai/gpt-oss-120b',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 5
    }
  });
  expect(created.statusCode, created.body).toBe(200);
  return { cookie, workspaceId, taskId: created.json<{ id: string }>().id };
};

describe('unattended recovery', () => {
  test('releases a task whose approval expired unanswered', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-approvals-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, store, database, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey
    });
    disposers.push(() => app.close());
    const { cookie, workspaceId, taskId } = await seedOwnerWithTask(
      app,
      'approval-expiry',
      'Send the quarterly numbers to the board'
    );

    const workspace = (await store.getWorkspaceById(workspaceId))!;
    const key = unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id);
    await database.query(`UPDATE tasks SET status='awaiting_user' WHERE id=$1`, [taskId]);
    const approvalId = await store.createApproval({
      userId: workspace.userId,
      taskId,
      action: 'connector_action',
      sideEffect: 'external_consequential',
      previewCiphertext: encryptJson(
        { action: 'Email the board', preview: 'To: board@example.com' },
        key,
        `approval:${taskId}`
      ),
      previewHash: 'not-a-real-binding-hash',
      // The 24-hour deadline the worker sets, already behind us.
      expiresAt: new Date(Date.now() - 60_000)
    });

    await runMaintenance();

    const task = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie }
    });
    expect(task.json<{ status: string; resumable: boolean }>()).toMatchObject({
      status: 'paused',
      resumable: true
    });

    // The credits the abandoned approval was holding are back in the monthly allowance.
    const reserved = await database.query<{ credits: string }>(
      `SELECT COALESCE(SUM(credits),0) AS credits FROM usage_entries
       WHERE task_id=$1 AND state='reserved'`,
      [taskId]
    );
    expect(Number(reserved.rows[0]!.credits)).toBe(0);

    // The timeline says what happened rather than leaving a task that simply stopped.
    const events = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/events`,
      headers: { cookie }
    });
    const expiry = events
      .json<
        Array<{ kind: string; summary: string; payload?: { code?: string; owner?: boolean } }>
      >()
      .find((event) => event.payload?.code === 'approval_expired');
    expect(expiry?.kind).toBe('warning');
    expect(expiry?.summary).toContain('expired');
    // And says it out on the page. Warnings without `owner` are folded into the collapsed work log
    // with the machinery the agent recovered from; a task that stopped and needs a reply is not
    // that, and this one carries no other evidence of why it stopped.
    expect(expiry?.payload?.owner).toBe(true);

    // The card is gone from the pending list but is still reachable, so the owner can read what
    // was being asked before deciding whether to resume.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/approvals', headers: { cookie } })).json<
        unknown[]
      >()
    ).toHaveLength(0);
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=expired',
      headers: { cookie }
    });
    expect(expired.json<Array<{ id: string; preview: { action: string } }>>()).toMatchObject([
      { id: approvalId, preview: { action: 'Email the board' } }
    ]);

    // Resuming is allowed from where the sweep left the task, and the sweep is idempotent.
    await runMaintenance();
    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/resume`,
      headers: { cookie, 'idempotency-key': 'approval-expiry-resume' },
      payload: {}
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json<{ status: string }>().status).toBe('queued');
  }, 30_000);

  test('leaves a task alone while its approval can still be answered', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-approvals-live-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, store, database, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey
    });
    disposers.push(() => app.close());
    const { cookie, workspaceId, taskId } = await seedOwnerWithTask(
      app,
      'approval-live',
      'Tidy the download folder'
    );
    const workspace = (await store.getWorkspaceById(workspaceId))!;
    const key = unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id);
    await database.query(`UPDATE tasks SET status='awaiting_user' WHERE id=$1`, [taskId]);
    await store.createApproval({
      userId: workspace.userId,
      taskId,
      action: 'delete_file',
      sideEffect: 'workspace_write',
      previewCiphertext: encryptJson({ action: 'Delete a file' }, key, `approval:${taskId}`),
      previewHash: 'not-a-real-binding-hash',
      expiresAt: new Date(Date.now() + 60 * 60_000)
    });

    await runMaintenance();

    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { cookie } })).json<{
        status: string;
      }>().status
    ).toBe('awaiting_user');
  }, 30_000);

  test('finishes a scheduled dispatch the API died in the middle of', async () => {
    const resumed: string[] = [];
    stubProviderFetch((url) => {
      if (url.endsWith('/resume')) resumed.push(url);
    });
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-schedule-recovery-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey
    });
    disposers.push(() => app.close());
    const { cookie, workspaceId, taskId } = await seedOwnerWithTask(
      app,
      'schedule-recovery',
      'Post the weekly summary'
    );

    const schedule = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: { cookie, 'idempotency-key': 'schedule-recovery-create' },
      payload: {
        workspaceId,
        prompt: 'Post the weekly summary',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        spec: { kind: 'daily', timeZone: 'America/New_York', localTime: '09:00' }
      }
    });
    expect(schedule.statusCode, schedule.body).toBe(201);
    const scheduleId = schedule.json<{ id: string }>().id;

    // Exactly the state materializeTaskSchedule leaves behind: the run recorded, the task
    // created and reserved, and the process gone before the workspace was resumed.
    await database.query(
      `UPDATE tasks SET status='awaiting_resource', attempt=0,
       updated_at=NOW() - INTERVAL '5 minutes' WHERE id=$1`,
      [taskId]
    );
    await database.query(`UPDATE workspaces SET status='suspended' WHERE id=$1`, [workspaceId]);
    await database.query(
      `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome)
       VALUES ($1,NOW() - INTERVAL '5 minutes',$2,'queued')`,
      [scheduleId, taskId]
    );

    await runMaintenance();

    expect(
      (await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers: { cookie } })).json<{
        status: string;
      }>().status
    ).toBe('queued');
    expect(resumed).toHaveLength(1);
  }, 30_000);

  test('does not re-queue a task that ran and then hit a resource wall', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-schedule-wall-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey
    });
    disposers.push(() => app.close());
    const { cookie, workspaceId, taskId } = await seedOwnerWithTask(
      app,
      'schedule-wall',
      'Draft the release notes'
    );
    const schedule = await app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: { cookie, 'idempotency-key': 'schedule-wall-create' },
      payload: {
        workspaceId,
        prompt: 'Draft the release notes',
        modelId: 'openrouter/openai/gpt-oss-120b',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        spec: { kind: 'daily', timeZone: 'America/New_York', localTime: '09:00' }
      }
    });
    // attempt = 1 means a worker leased this task: it started, and the provider turned it away.
    await database.query(
      `UPDATE tasks SET status='awaiting_resource', attempt=1,
       updated_at=NOW() - INTERVAL '5 minutes' WHERE id=$1`,
      [taskId]
    );
    await database.query(
      `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome)
       VALUES ($1,NOW() - INTERVAL '5 minutes',$2,'queued')`,
      [schedule.json<{ id: string }>().id, taskId]
    );

    await runMaintenance();

    const task = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie }
    });
    // It stays where the worker put it, and the client is told it can be resumed by hand.
    expect(task.json<{ status: string; resumable: boolean }>()).toMatchObject({
      status: 'awaiting_resource',
      resumable: true
    });
    const resumeResponse = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/resume`,
      headers: { cookie, 'idempotency-key': 'schedule-wall-resume' },
      payload: {}
    });
    expect(resumeResponse.statusCode, resumeResponse.body).toBe(200);
    expect(resumeResponse.json<{ status: string; resumable: boolean }>()).toMatchObject({
      status: 'queued',
      resumable: false
    });
  }, 30_000);

  test('dispatches a due schedule and moves it past the run it just served', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-schedule-dispatch-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database } = await buildServer(
      { ...isolatedConfig(directory), SCHEDULER_POLL_MS: 1_000 },
      { masterKey }
    );
    disposers.push(() => app.close());
    const { cookie, workspaceId } = await seedOwnerWithTask(
      app,
      'schedule-dispatch',
      'Warm up the workspace'
    );
    const scheduleId = (
      await app.inject({
        method: 'POST',
        url: '/v1/schedules',
        headers: { cookie, 'idempotency-key': 'schedule-dispatch-create' },
        payload: {
          workspaceId,
          prompt: 'Post the weekly summary',
          modelId: 'openrouter/openai/gpt-oss-120b',
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 1,
          spec: { kind: 'daily', timeZone: 'America/New_York', localTime: '09:00' }
        }
      })
    ).json<{ id: string }>().id;
    await database.query(`UPDATE workspaces SET status='running' WHERE id=$1`, [workspaceId]);
    const due = new Date(Date.now() - 60_000);
    await database.query('UPDATE task_schedules SET next_run_at=$2 WHERE id=$1', [
      scheduleId,
      due.toISOString()
    ]);

    const dispatched = await vi.waitFor(
      async () => {
        const schedules = await app.inject({
          method: 'GET',
          url: '/v1/schedules',
          headers: { cookie }
        });
        const schedule = schedules
          .json<Array<{ id: string; lastTaskId: string | null; nextRunAt: string | null }>>()
          .find((entry) => entry.id === scheduleId)!;
        expect(schedule.lastTaskId).toBeTruthy();
        return schedule;
      },
      { timeout: 15_000, interval: 250 }
    );

    // The run it just served is behind it, and the next one is a real future occurrence rather
    // than a second pass over the same reading.
    expect(new Date(dispatched.nextRunAt!).getTime()).toBeGreaterThan(due.getTime());
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/tasks/${dispatched.lastTaskId}`,
          headers: { cookie }
        })
      ).json<{ status: string }>().status
    ).toBe('queued');
  }, 30_000);

  test('survives a maintenance step that throws, and logs it', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-maintenance-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const lines: Array<Record<string, unknown>> = [];
    const { app, store, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey,
      logger: createLogger({
        level: 'debug',
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>)
      })
    });
    disposers.push(() => app.close());

    const failure = new Error('terminating connection due to administrator command');
    vi.spyOn(store, 'cleanupExpired').mockRejectedValueOnce(failure);
    // A rejection escaping here used to reach Node's default handler and end the process.
    await expect(runMaintenance()).resolves.toBeUndefined();
    expect(lines.map((line) => line.event)).toContain('maintenance.cleanup_failed');
    expect(lines.map((line) => line.event)).toContain('maintenance.swept');
    expect(JSON.stringify(lines)).not.toContain('administrator command');
  }, 30_000);

  /**
   * The dump and the key are two halves of one backup, and a hand-run `pg_restore` onto a freshly
   * installed box brings only the first half. Everything that looks like a health check passes on
   * the wrong key, so the guard has to be the boot itself: a server that came up here would wrap
   * new workspaces under the new key while the old rows stayed sealed under the old one, and no
   * single key opens a database once both generations are in it.
   */
  test('refuses to serve when the master key does not open this database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-master-key-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const config = isolatedConfig(directory);
    const original = await buildServer(config, { masterKey });
    const owner = await original.store.createUser({ username: 'owner', displayName: 'Owner' });
    const workspaceId = randomUUID();
    await original.store.createWorkspace({
      id: workspaceId,
      userId: owner.id,
      name: 'Computer',
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'dev',
      region: 'local',
      wrappedKey: wrapDataKey(generateDataKey(), masterKey, workspaceId)
    });
    await original.app.close();

    await expect(buildServer(config, { masterKey: Buffer.alloc(32, 4) })).rejects.toThrow(
      /different DATA_MASTER_KEY/
    );
  }, 30_000);
});

describe('operator-facing logs', () => {
  test('records the failure the client was told to quote, and no content', async () => {
    stubProviderFetch();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-logs-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const lines: Array<Record<string, unknown>> = [];
    const { app, runMaintenance } = await buildServer(isolatedConfig(directory), {
      masterKey,
      logger: createLogger({
        level: 'debug',
        service: 'api',
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>)
      })
    });
    disposers.push(() => app.close());
    const secretPrompt = 'Reconcile the Vanguard statement for account 4471';
    const { cookie, taskId } = await seedOwnerWithTask(app, 'logging', secretPrompt);
    await runMaintenance();

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/tasks/00000000-0000-4000-8000-000000000000',
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);
    const requestId = missing.json<{ error: { requestId: string } }>().error.requestId;
    const rejected = lines.find(
      (line) => line.event === 'http.request_rejected' && line.requestId === requestId
    );
    expect(rejected).toMatchObject({
      level: 'warn',
      code: 'task_not_found',
      statusCode: 404,
      method: 'GET',
      route: '/v1/tasks/:taskId'
    });
    expect(typeof rejected!.durationMs).toBe('number');

    // Cancelling is an owner action worth a line, and the task id is how it is found again.
    await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/cancel`,
      headers: { cookie, 'idempotency-key': 'logging-cancel' },
      payload: {}
    });
    expect(lines).toContainEqual(expect.objectContaining({ event: 'task.action', taskId }));

    const written = JSON.stringify(lines);
    expect(written).not.toContain(secretPrompt);
    expect(written).not.toContain('Vanguard');
    expect(written).not.toContain(cookie);
    expect(written).not.toContain('test-key');
    // A signed-in session cookie is the single most damaging thing a log could carry.
    expect(written).not.toContain('athanor_session');
  }, 30_000);
});

/** The provider catalogue, workspace metering and runner calls a task-creating test needs. */
const stubProviderAndRunner = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      if (requestUrl.endsWith('/models'))
        return json({
          data: seedModels().map((model) => ({
            id: model.providerModelId,
            context_length: model.contextTokens,
            architecture: { input_modalities: model.modalities },
            supported_parameters: ['tools', 'reasoning']
          }))
        });
      if (requestUrl.endsWith('/endpoints/zdr'))
        return json({
          data: seedModels().map((model) => ({ model_id: model.providerModelId, status: 0 }))
        });
      if (requestUrl.includes('/benchmarks?')) return json({ data: [] });
      return json({
        storageBytes: 0,
        hostStorageTotalBytes: 1_000_000_000,
        hostStorageAvailableBytes: 900_000_000,
        available: true,
        ok: true
      });
    })
  );
};

describe('spending caps', () => {
  test('refuses work that would pass the daily cap and reports where it stands', async () => {
    stubProviderAndRunner();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-spend-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const owner = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie: owner, 'idempotency-key': 'spend-workspace' },
        payload: {
          name: 'Computer',
          storageLimitBytes: 10_000_000_000,
          region: 'auto'
        }
      })
    ).json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/providers',
          headers: { cookie: owner, 'idempotency-key': 'spend-provider' },
          payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
        })
      ).statusCode
    ).toBe(200);

    // An owner who has never opened the settings has no caps and a default warning threshold.
    expect(
      (
        await app.inject({ method: 'GET', url: '/v1/spend-limits', headers: { cookie: owner } })
      ).json<{ dailyCapUsd: number | null; warnAtPercent: number }>()
    ).toMatchObject({ dailyCapUsd: null, warnAtPercent: 80 });

    const limits = await app.inject({
      method: 'PUT',
      url: '/v1/spend-limits',
      headers: { cookie: owner, 'idempotency-key': 'spend-limits-1' },
      payload: { dailyCapUsd: 2, defaultTaskCapUsd: 0.5, timeZone: 'Europe/Lisbon' }
    });
    expect(limits.statusCode, limits.body).toBe(200);
    expect(limits.json()).toMatchObject({
      dailyCapUsd: 2,
      defaultTaskCapUsd: 0.5,
      monthlyCapUsd: null,
      timeZone: 'Europe/Lisbon'
    });

    /*
     * The direction decides whether a passkey is asked for.
     *
     * Removing the cap is the one control between the owner and an unbounded provider bill, and it
     * used to need nothing but an unlocked browser - while reading an export, which spends nothing,
     * needed a passkey. Tightening still needs nothing: it cannot cost anybody anything, and asking
     * would put a biometric prompt in front of a routine adjustment.
     */
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    const tightened = await app.inject({
      method: 'PUT',
      url: '/v1/spend-limits',
      headers: { cookie: owner, 'idempotency-key': 'spend-limits-tighter' },
      payload: { dailyCapUsd: 1 }
    });
    expect(tightened.statusCode, tightened.body).toBe(200);
    expect(tightened.json()).toMatchObject({ dailyCapUsd: 1 });

    for (const [key, payload] of [
      ['spend-limits-raise', { dailyCapUsd: 50 }],
      ['spend-limits-clear', { dailyCapUsd: null }]
    ] as const) {
      const loosened = await app.inject({
        method: 'PUT',
        url: '/v1/spend-limits',
        headers: { cookie: owner, 'idempotency-key': key },
        payload
      });
      expect(loosened.statusCode, loosened.body).toBe(403);
      expect(loosened.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    }
    // And the cap it refused to change is still the one that was there.
    expect(
      (
        await app.inject({ method: 'GET', url: '/v1/spend-limits', headers: { cookie: owner } })
      ).json<{ dailyCapUsd: number | null }>()
    ).toMatchObject({ dailyCapUsd: 1 });
    // Stepped up again, and the cap put back where the rest of this test expects it — which is
    // itself the loosening path working once the passkey is fresh.
    await database.query('UPDATE sessions SET step_up_at=NOW()');
    const restored = await app.inject({
      method: 'PUT',
      url: '/v1/spend-limits',
      headers: { cookie: owner, 'idempotency-key': 'spend-limits-restore' },
      payload: { dailyCapUsd: 2 }
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ dailyCapUsd: 2 });

    const rejectedZone = await app.inject({
      method: 'PUT',
      url: '/v1/spend-limits',
      headers: { cookie: owner, 'idempotency-key': 'spend-limits-zone' },
      payload: { timeZone: 'Mars/Olympus_Mons' }
    });
    expect(rejectedZone.statusCode).toBe(400);
    expect(rejectedZone.json<{ error: { code: string } }>().error.code).toBe('invalid_time_zone');

    const task = (payload: Record<string, unknown>, key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { cookie: owner, 'idempotency-key': key },
        payload: {
          workspaceId,
          prompt: 'Summarise the quarterly numbers',
          modelId: 'openrouter/openai/gpt-oss-120b',
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5,
          ...payload
        }
      });

    const overCap = await task({ maxSpendUsd: 10 }, 'spend-task-over');
    expect(overCap.statusCode, overCap.body).toBe(402);
    const failure = overCap.json<{ error: { code: string; message: string } }>();
    expect(failure.error.code).toBe('spend_cap_reached');
    expect(failure.error.message).toContain('$2.00');

    // Omitting a ceiling means the account default, not "unlimited".
    const withinCap = await task({}, 'spend-task-within');
    expect(withinCap.statusCode, withinCap.body).toBe(200);
    expect(withinCap.json<{ maxSpendUsd: number; spentUsd: number }>()).toMatchObject({
      maxSpendUsd: 0.5,
      spentUsd: 0
    });

    // The first task's commitment is counted against the second, so four half-dollar tasks fit
    // under a two-dollar day and the fifth does not.
    for (const index of [2, 3, 4]) {
      const next = await task({}, `spend-task-${index}`);
      expect(next.statusCode, `task ${index}: ${next.body}`).toBe(200);
    }
    const exhausted = await task({}, 'spend-task-5');
    expect(exhausted.statusCode, exhausted.body).toBe(402);
    expect(exhausted.json<{ error: { code: string } }>().error.code).toBe('spend_cap_reached');

    const summary = await app.inject({
      method: 'GET',
      url: '/v1/spend',
      headers: { cookie: owner }
    });
    expect(summary.statusCode, summary.body).toBe(200);
    const spend = summary.json<{
      limits: { dailyCapUsd: number };
      windows: Array<{ name: string; capUsd: number | null; pendingUsd: number }>;
      byDay: unknown[];
      byModel: unknown[];
      byTask: unknown[];
    }>();
    expect(spend.limits.dailyCapUsd).toBe(2);
    expect(spend.windows.find((window) => window.name === 'daily')).toMatchObject({
      capUsd: 2,
      pendingUsd: 2
    });
    expect(spend.windows.find((window) => window.name === 'monthly')?.capUsd).toBeNull();
    expect(Array.isArray(spend.byDay) && Array.isArray(spend.byModel)).toBe(true);
  }, 40_000);
});

describe('capability and preview boundaries', () => {
  test('refuses stream credentials to API tokens and reserved ports to previews', async () => {
    stubProviderAndRunner();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-capability-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const owner = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie: owner, 'idempotency-key': 'capability-workspace' },
        payload: {
          name: 'Computer',
          storageLimitBytes: 10_000_000_000,
          region: 'auto'
        }
      })
    ).json<{ id: string }>().id;

    const issued = await app.inject({
      method: 'POST',
      url: '/v1/api-tokens',
      headers: { cookie: owner },
      payload: { label: 'automation', scopes: ['workspaces:write', 'files:read'], expiresInDays: 7 }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const bearer = `Bearer ${issued.json<{ token: string }>().token}`;

    // workspaces:write is "may create and modify workspaces". It is not "may open a shell".
    for (const capability of ['terminal-token', 'browser-token', 'desktop-token']) {
      const refused = await app.inject({
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/${capability}`,
        headers: { authorization: bearer }
      });
      expect(refused.statusCode, `${capability}: ${refused.body}`).toBe(403);
      expect(refused.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: 'api_token_scope_required',
        message: 'API tokens cannot call this endpoint'
      });
    }

    // The owner's own session still gets one, and it is bound to the socket it is for.
    const terminal = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/terminal-token`,
      headers: { cookie: owner }
    });
    expect(terminal.statusCode, terminal.body).toBe(200);
    const claims = JSON.parse(
      Buffer.from(terminal.json<{ token: string }>().token.split('.')[1]!, 'base64url').toString(
        'utf8'
      )
    ) as { aud: string; scopes: string[]; exp: number; iat: number };
    expect(claims).toMatchObject({
      aud: `GET /v1/workspaces/${workspaceId}/terminal`,
      scopes: ['terminal']
    });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(900);

    const preview = (port: number, key: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/previews`,
        headers: { cookie: owner, 'idempotency-key': key },
        payload: { label: 'demo', port }
      });

    // 4101 is this server's own API port, 4401 the preview gateway, 4201 a sibling service's
    // health endpoint and 5432 the database. The contract has always refused the runner's 4300;
    // every other loopback service used to be publishable.
    for (const port of [4101, 4201, 4401, 5432]) {
      const refused = await preview(port, `preview-${port}`);
      expect(refused.statusCode, `port ${port}: ${refused.body}`).toBe(422);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('preview_port_reserved');
    }
    expect((await preview(4300, 'preview-4300')).statusCode).toBe(400);
    const allowed = await preview(3000, 'preview-3000');
    expect(allowed.statusCode, allowed.body).toBe(201);
  }, 40_000);
});

describe('authentication posture', () => {
  test('refuses development sign-in unless the deployment really is development', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-devauth-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    // The flag is set exactly as a stray environment file would leave it.
    const { app } = await buildServer({
      ...isolatedConfig(directory),
      DEPLOYMENT_MODE: 'production',
      ALLOW_INSECURE_DEV_AUTH: true
    });
    disposers.push(() => app.close());

    const attempt = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      payload: { username: 'intruder' }
    });
    expect(attempt.statusCode).toBe(500);
    expect(attempt.headers['set-cookie']).toBeUndefined();
  }, 30_000);

  /**
   * The door every device after the first comes in through.
   *
   * A claimed box refuses registration outright and signing in needs a passkey the new device does
   * not have yet, so the only way in is a single-use grant minted by a device that is already
   * signed in. The client had no call to this pair at all - it sent the grant to the registration
   * route, which answers `registration_closed` on a box that has an owner - so the QR code the
   * settings screen draws had nothing that could redeem it.
   */
  test('opens a passkey ceremony for a minted device grant, and for nothing else', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-enroll-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    // The ticket carries where the box can be reached, so the box has to know that first.
    await writeFile(
      join(directory, 'connection.json'),
      JSON.stringify({ endpoints: ['https://203.0.113.9'], identity: 'sha256/box' })
    );
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const created = await app.inject({
      method: 'POST',
      url: '/v1/devices/enrollments',
      headers: { cookie, 'idempotency-key': 'enroll-ticket-0001' },
      payload: { label: 'Phone' }
    });
    expect(created.statusCode, created.body).toBe(200);
    const ticket = JSON.parse(
      Buffer.from(
        created.json<{ uri: string }>().uri.replace('athanor://pair/', ''),
        'base64url'
      ).toString('utf8')
    ) as { pairingCode: string };

    const opened = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/options',
      payload: { token: ticket.pairingCode }
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json<{ challengeId: string }>().challengeId).toMatch(/[0-9a-f-]{36}/);

    // Asking for the ceremony again is fine, and has to be: the authenticator prompt can be
    // dismissed, time out, or lose to a phone call, and burning the grant on the way in meant the
    // owner had to walk back to a signed-in device and mint another one behind a passkey
    // confirmation. Nothing is weakened by this - a set of options is not a credential.
    const reopened = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/options',
      payload: { token: ticket.pairingCode }
    });
    expect(reopened.statusCode, reopened.body).toBe(200);

    // Single use still, but spent where a credential actually appears. A ceremony that fails
    // verification leaves the grant alone, so the retry above stays available.
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/verify',
      payload: {
        challengeId: reopened.json<{ challengeId: string }>().challengeId,
        token: ticket.pairingCode,
        response: { id: 'not-a-credential', rawId: 'not-a-credential', type: 'public-key' }
      }
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    const afterFailure = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/options',
      payload: { token: ticket.pairingCode }
    });
    expect(afterFailure.statusCode, afterFailure.body).toBe(200);

    // Revoking it from the signed-in device is still immediate, which is what stops a photographed
    // screen from being a standing credential once the owner notices.
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/devices/enrollments',
      headers: { cookie }
    });
    const enrollmentId = listed.json<Array<{ id: string }>>()[0]?.id;
    expect(enrollmentId).toBeTruthy();
    await app.inject({
      method: 'DELETE',
      url: `/v1/devices/enrollments/${enrollmentId}`,
      headers: { cookie }
    });
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/options',
      payload: { token: ticket.pairingCode }
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json<{ error: { code: string } }>().error.code).toBe('enrollment_invalid');

    const invented = await app.inject({
      method: 'POST',
      url: '/v1/auth/enroll/options',
      payload: { token: 'w6Yl8Qk2nT4vXbR7pL0sZaC3dF5gH9jK' }
    });
    expect(invented.statusCode).toBe(403);
  }, 30_000);

  /*
   * Renewal starts about thirty days before a certificate expires, and the helper writes down why
   * it failed. Nothing read that file, so the app was reachable and silent for a month and the
   * owner found out when every device refused at once - with a shell as the only way to ask why.
   */
  test('reports what the box wrote down about its own failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-diagnostics-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );

    // Nothing written is the healthy answer: both helpers delete their file on the next success.
    const healthy = await app.inject({
      method: 'GET',
      url: '/v1/instance/diagnostics',
      headers: { cookie }
    });
    expect(healthy.statusCode, healthy.body).toBe(200);
    expect(healthy.json()).toEqual({ certificate: null, dynamicDns: null });

    await writeFile(
      join(directory, 'certificate.error'),
      '2026-08-01T03:14:00Z\nacme: DNS-01 challenge was not answered\n'
    );
    const failing = await app.inject({
      method: 'GET',
      url: '/v1/instance/diagnostics',
      headers: { cookie }
    });
    expect(failing.json()).toMatchObject({
      certificate: {
        failedAt: '2026-08-01T03:14:00Z',
        reason: 'acme: DNS-01 challenge was not answered'
      },
      dynamicDns: null
    });

    // Signed out, it says nothing: this names what is wrong with somebody's server.
    expect((await app.inject({ method: 'GET', url: '/v1/instance/diagnostics' })).statusCode).toBe(
      401
    );
  }, 30_000);

  test('throttles account recovery per caller as well as per username', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-recovery-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    // Each attempt names a different account, so only the per-address limit can stop them - and it
    // has to, because every one of these derives a 32 MB scrypt hash.
    for (let index = 0; index < 20; index += 1) {
      const attempt = await app.inject({
        method: 'POST',
        url: '/v1/auth/recover/options',
        payload: { username: `nobody-${index}`, recoveryCode: 'not-a-real-code' }
      });
      expect(attempt.statusCode, attempt.body).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover/options',
      payload: { username: 'nobody-20', recoveryCode: 'not-a-real-code' }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe('auth_rate_limited');

    // The second recovery route derives the same hash and used to have no throttle of its own.
    const verify = (index: number) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/recover/verify',
        payload: {
          challengeId: randomUUID(),
          recoveryCode: `not-a-real-code-${index}`,
          response: {}
        }
      });
    for (let index = 0; index < 20; index += 1) expect((await verify(index)).statusCode).toBe(401);
    const verifyLimited = await verify(20);
    expect(verifyLimited.statusCode).toBe(429);
    expect(verifyLimited.json<{ error: { code: string } }>().error.code).toBe('auth_rate_limited');
  }, 30_000);

  /**
   * One biometric for the whole first run.
   *
   * Signing in, registering, recovering and enrolling a device each complete a WebAuthn ceremony
   * with `userVerification: 'required'` and each opens the five-minute step-up window. Every route
   * that guards a sensitive action honours that window - but the route that hands out the step-up
   * challenge never read it, so the client ran a second ceremony against the same authenticator
   * moments later, and again for the action after that. The owner met a fingerprint prompt per
   * sensitive action for the first five minutes of owning the machine.
   *
   * What this pins down is that removing the duplicate removed only the duplicate: freshness is
   * still the server's, still anchored to a real ceremony, still per session, and the floor that
   * must always ask still refuses a session that cannot show one.
   */
  test('answers a sensitive action with the ceremony the owner just completed, once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-stepup-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, store, database } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());

    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const owner = await store.getUserByUsername('owner');
    expect(owner).toBeTruthy();
    // A registered passkey, because without one the route takes the developer shortcut and none of
    // what follows would be about the window.
    await store.addPasskey({
      userId: owner!.id,
      credentialId: 'step-up-window-credential',
      publicKey: Buffer.alloc(32, 7).toString('base64url'),
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true
    });

    const stepUpOptions = (as: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/step-up/options',
        headers: { cookie: as },
        payload: {}
      });
    const reissueRecoveryCode = (as: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-code',
        headers: { cookie: as },
        payload: {}
      });
    const idHash = (value: string) => sha256(value.slice(value.indexOf('=') + 1));
    const stepUpAge = async (value: string) =>
      Number(
        (
          await database.query(
            'SELECT EXTRACT(EPOCH FROM (NOW()-step_up_at)) AS age FROM sessions WHERE id_hash=$1',
            [idHash(value)]
          )
        ).rows[0]!.age
      );

    // Signing in was the ceremony, so there is nothing left to prove: no challenge is minted at all.
    const fresh = await stepUpOptions(cookie);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json()).toEqual({ verified: true });
    expect(
      Number(
        (await database.query("SELECT COUNT(*) AS count FROM auth_challenges WHERE kind='step_up'"))
          .rows[0]!.count
      )
    ).toBe(0);
    const reissued = await reissueRecoveryCode(cookie);
    expect(reissued.statusCode, reissued.body).toBe(200);

    // Answering `verified` is a reading of the window, not a grant of one. If it wrote `step_up_at`
    // the way the developer shortcut does, whoever held the cookie could hold the window open
    // forever by polling this route, and the five minutes would never expire for anybody.
    await database.query(
      "UPDATE sessions SET step_up_at=NOW()-INTERVAL '4 minutes' WHERE id_hash=$1",
      [idHash(cookie)]
    );
    expect((await stepUpOptions(cookie)).json()).toEqual({ verified: true });
    expect(await stepUpAge(cookie)).toBeGreaterThan(200);

    // Past the window the ceremony comes back, with presence still required of the authenticator.
    await database.query(
      "UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes' WHERE id_hash=$1",
      [idHash(cookie)]
    );
    const challenged = await stepUpOptions(cookie);
    expect(challenged.statusCode, challenged.body).toBe(200);
    const offered = challenged.json<{
      verified?: boolean;
      challengeId?: string;
      options?: { userVerification?: string };
    }>();
    expect(offered.verified).toBeUndefined();
    expect(offered.challengeId).toMatch(/[0-9a-f-]{36}/);
    expect(offered.options?.userVerification).toBe('required');

    // The floor that must always ask. A recovery code is a permanent way back into the account from
    // any device, and being handed a challenge is not the same as answering one: asking for options
    // over and over, and failing the ceremony outright, both leave the credential route refused.
    for (let attempt = 0; attempt < 3; attempt += 1) await stepUpOptions(cookie);
    const failedCeremony = await app.inject({
      method: 'POST',
      url: '/v1/auth/step-up/verify',
      headers: { cookie },
      payload: {
        challengeId: offered.challengeId,
        response: { id: 'step-up-window-credential', rawId: 'step-up-window-credential' }
      }
    });
    expect(failedCeremony.statusCode).toBeGreaterThanOrEqual(400);
    const refused = await reissueRecoveryCode(cookie);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('step_up_required');

    // And freshness belongs to one session, not to the account. A second device that has gone stale
    // cannot ride on the ceremony the first device completed a moment ago.
    const second = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    await database.query(
      "UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes' WHERE id_hash=$1",
      [idHash(second)]
    );
    await database.query('UPDATE sessions SET step_up_at=NOW() WHERE id_hash=$1', [idHash(cookie)]);
    expect((await stepUpOptions(cookie)).json()).toEqual({ verified: true });
    expect((await stepUpOptions(second)).json<{ verified?: boolean }>().verified).toBeUndefined();
    expect((await reissueRecoveryCode(second)).statusCode).toBe(403);
  }, 30_000);
});

describe('the settings and file surfaces the client already calls', () => {
  test('governs notifications, edits the file tree, and re-issues a recovery code', async () => {
    const runnerCalls: Array<{ method: string; path: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          });
        if (requestUrl.includes('workspace-manager.test')) {
          const url = new URL(requestUrl);
          runnerCalls.push({
            method: init?.method ?? 'GET',
            path: `${url.pathname}${url.search}`,
            body: typeof init?.body === 'string' ? init.body : ''
          });
          if (url.pathname.endsWith('/files/rename')) return json({ path: 'workspace/renamed.md' });
          if (url.pathname.endsWith('/files/folder')) return json({ path: 'workspace/notes' });
          if (url.pathname.endsWith('/checkpoints/preview')) return json({});
        }
        return json({
          storageBytes: 4_096,
          hostStorageTotalBytes: 1_000_000_000,
          hostStorageAvailableBytes: 900_000_000,
          ok: true
        });
      })
    );
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-surfaces-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie, 'idempotency-key': 'surfaces-workspace' },
        payload: { name: 'Computer', storageLimitBytes: 10_000_000_000 }
      })
    ).json<{ id: string }>().id;

    // A box that has never been configured notifies about everything and is never quiet, and says
    // so in the owner's own time zone rather than storing a second copy of their day.
    const defaults = await app.inject({
      method: 'GET',
      url: '/v1/notifications/settings',
      headers: { cookie }
    });
    expect(defaults.statusCode, defaults.body).toBe(200);
    expect(defaults.json()).toMatchObject({
      kinds: {
        approvalRequired: true,
        taskFinished: true,
        spendPaused: true,
        agentMessage: true,
        takeoverNeeded: true
      },
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursAllowApprovals: true,
      timeZone: 'UTC'
    });

    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/settings',
      headers: { cookie, 'idempotency-key': 'surfaces-notifications' },
      payload: {
        kinds: {
          approvalRequired: true,
          taskFinished: false,
          spendPaused: true,
          // The two the agent raises can be silenced too: the notification the owner asked for
          // should not also be the one they cannot turn down.
          agentMessage: true,
          takeoverNeeded: false
        },
        quietHoursStart: '22:00',
        quietHoursEnd: '07:30',
        quietHoursAllowApprovals: false
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      kinds: {
        approvalRequired: true,
        taskFinished: false,
        spendPaused: true,
        agentMessage: true,
        takeoverNeeded: false
      },
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30',
      quietHoursAllowApprovals: false
    });
    // Survives a fresh read: the switches only mean anything if the box kept them.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/notifications/settings',
          headers: { cookie }
        })
      ).json()
    ).toMatchObject({
      kinds: { takeoverNeeded: false },
      quietHoursStart: '22:00',
      quietHoursEnd: '07:30'
    });

    // A window that starts and ends at the same minute would never be quiet, and half a window is
    // not a window - both are refused with a reason rather than stored and silently ignored.
    for (const [key, payload] of [
      [
        'surfaces-quiet-same',
        {
          kinds: {
            approvalRequired: true,
            taskFinished: true,
            spendPaused: true,
            agentMessage: true,
            takeoverNeeded: true
          },
          quietHoursStart: '22:00',
          quietHoursEnd: '22:00',
          quietHoursAllowApprovals: true
        }
      ],
      [
        'surfaces-quiet-half',
        {
          kinds: {
            approvalRequired: true,
            taskFinished: true,
            spendPaused: true,
            agentMessage: true,
            takeoverNeeded: true
          },
          quietHoursStart: '22:00',
          quietHoursEnd: null,
          quietHoursAllowApprovals: true
        }
      ]
    ] as const) {
      const refused = await app.inject({
        method: 'PUT',
        url: '/v1/notifications/settings',
        headers: { cookie, 'idempotency-key': key },
        payload
      });
      expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('invalid_quiet_hours');
    }

    runnerCalls.length = 0;
    const folder = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/files/folder`,
      headers: { cookie, 'idempotency-key': 'surfaces-folder' },
      payload: { path: 'workspace/notes' }
    });
    expect(folder.statusCode, folder.body).toBe(200);
    expect(folder.json()).toEqual({ path: 'workspace/notes' });

    const renamed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/files/rename`,
      headers: { cookie, 'idempotency-key': 'surfaces-rename' },
      payload: { from: 'workspace/draft.md', to: 'workspace/renamed.md' }
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toEqual({ path: 'workspace/renamed.md' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent('workspace/old.md')}`,
      headers: { cookie, 'idempotency-key': 'surfaces-delete' }
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    expect(runnerCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /v1/workspaces/${workspaceId}/files/folder`,
      `POST /v1/workspaces/${workspaceId}/files/rename`,
      `DELETE /v1/workspaces/${workspaceId}/file?path=workspace%2Fold.md`,
      // Deleting changes what the machine is holding, so the figure the owner sees is re-read.
      `GET /v1/workspaces/${workspaceId}/usage`
    ]);
    expect(JSON.parse(runnerCalls[1]!.body)).toEqual({
      from: 'workspace/draft.md',
      to: 'workspace/renamed.md'
    });

    // The Usage pane reports what was just measured, not what the previous visit measured: the
    // records were read before the walk, so summing them lagged one refresh behind.
    const usage = await app.inject({ method: 'GET', url: '/v1/usage', headers: { cookie } });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.json<{ storageBytes: number }>().storageBytes).toBe(4_096);

    const reissued = await app.inject({
      method: 'POST',
      url: '/v1/auth/recovery-code',
      headers: { cookie },
      payload: {}
    });
    expect(reissued.statusCode, reissued.body).toBe(200);
    const first = reissued.json<{ recoveryCode: string }>().recoveryCode;
    expect(first.length).toBeGreaterThan(20);
    // Issuing again replaces it: the code is shown once and nothing can read the old one back.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/recovery-code',
      headers: { cookie },
      payload: {}
    });
    expect(again.json<{ recoveryCode: string }>().recoveryCode).not.toBe(first);
  }, 30_000);

  /*
   * "Verify and save" now has to have verified something.
   *
   * Everything this route called for an OpenRouter key - the adapter's model list, then the
   * catalogue refresh's `/models` and `/endpoints/zdr` - is a public route that answers 200 with no
   * credential at all. So a key with a trailing character was stored, encrypted, under a green
   * success message, and the first thing that ever read it was the owner's next conversation,
   * failing as a raw 401 mid-task. `/key` is the call the provider gates.
   */
  test('refuses a key the provider does not accept, and stores nothing', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          });
        if (requestUrl.endsWith('/key')) {
          asked.push(requestUrl);
          return json({ error: { message: 'No auth credentials found' } }, 401);
        }
        // Both catalogue routes answer, exactly as they do for a request carrying no key at all.
        if (requestUrl.endsWith('/models')) return json({ data: [{ id: 'z-ai/glm-5.2' }] });
        if (requestUrl.endsWith('/endpoints/zdr')) return json({ data: [] });
        return json({
          storageBytes: 0,
          hostStorageTotalBytes: 1_000_000_000,
          hostStorageAvailableBytes: 900_000_000,
          ok: true
        });
      })
    );
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-provider-key-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );

    const refused = await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie, 'idempotency-key': 'provider-bad-key' },
      payload: { provider: 'openrouter', apiKey: 'sk-or-typo ', enforceZeroDataRetention: true }
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'provider_key_rejected'
    });
    expect(asked.length).toBe(1);
    // Nothing was written, so the screen still offers to connect rather than claiming it is ready.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/providers', headers: { cookie } })).json<{
        configured: boolean;
        hasApiKey: boolean;
      }>()
    ).toMatchObject({ configured: false, hasApiKey: false });
  }, 30_000);
});

describe('rewinding the computer, not only the conversation', () => {
  test('previews an undo point, refuses one that does not exist, and restores before it forks', async () => {
    const runnerCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          });
        if (requestUrl.endsWith('/models'))
          return json({
            data: seedModels().map((model) => ({
              id: model.providerModelId,
              context_length: model.contextTokens,
              architecture: { input_modalities: model.modalities },
              supported_parameters: ['tools', 'reasoning']
            }))
          });
        if (requestUrl.endsWith('/endpoints/zdr'))
          return json({
            data: seedModels().map((model) => ({ model_id: model.providerModelId, status: 0 }))
          });
        if (requestUrl.includes('/benchmarks?')) return json({ data: [] });
        if (requestUrl.includes('workspace-manager.test')) {
          const url = new URL(requestUrl);
          runnerCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
          // The safety point taken before the tree is replaced, so the state one second before the
          // click is still reachable afterwards.
          if (url.pathname.endsWith('/snapshots') && (init?.method ?? 'GET') === 'POST')
            return json({ sizeBytes: 2_048 });
          if (url.pathname.endsWith('/preview'))
            return json({
              checkpointId: 'preview',
              mechanism: 'content',
              takenAt: '2026-08-01T00:00:00.000Z',
              added: [],
              modified: [{ path: 'workspace/report.md', sizeBytes: 12 }],
              deleted: [],
              truncated: false,
              addedCount: 0,
              modifiedCount: 1,
              deletedCount: 0,
              packagesInstalled: [{ name: 'ripgrep', version: '14.1.0' }],
              packagesRemoved: [],
              uncovered: []
            });
        }
        return json({
          storageBytes: 4_096,
          hostStorageTotalBytes: 1_000_000_000,
          hostStorageAvailableBytes: 900_000_000,
          ok: true
        });
      })
    );
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-rewind-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, store } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspaceId = (
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        headers: { cookie, 'idempotency-key': 'rewind-workspace' },
        payload: { name: 'Computer', storageLimitBytes: 10_000_000_000 }
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie, 'idempotency-key': 'rewind-provider' },
      payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: true }
    });
    const taskId = (
      await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { cookie, 'idempotency-key': 'rewind-task' },
        payload: {
          workspaceId,
          prompt: 'Write the report',
          modelId: 'openrouter/openai/gpt-oss-120b',
          privacyRoute: 'provider_zdr',
          maxComputeCredits: 5
        }
      })
    ).json<{ id: string }>().id;
    const events = () =>
      app
        .inject({ method: 'GET', url: `/v1/tasks/${taskId}/events`, headers: { cookie } })
        .then((response) => response.json<Array<{ id: string; kind: string; summary: string }>>());
    const firstMessage = (await events()).find((event) => event.kind === 'user_message')!;
    // A fork inherits the source's system context, so the task needs the conversation state a run
    // would have written. No agent runs behind these tests, so it is written here instead.
    const workspace = (await store.getWorkspace(
      (await store.getUserByUsername('owner'))!.id,
      workspaceId
    ))!;
    const dataKey = unwrapDataKey(workspace.wrappedKey!, Buffer.alloc(32, 9), workspaceId);
    await store.updateTask({
      id: taskId,
      status: 'queued',
      agentStateCiphertext: encryptJson(
        {
          messages: [
            { role: 'system', content: 'CLOUD RUNTIME CONTEXT: a private computer' },
            { role: 'user', content: 'Write the report' }
          ],
          step: 0,
          credits: 0,
          turn: 0
        },
        dataKey,
        `task-state:${taskId}`
      )
    });

    // No checkpoint yet: the answer is that the computer cannot be put back to that point, which
    // is what turns a three-way choice into an honest two-way one.
    const bare = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/rewind-preview?eventId=${firstMessage.id}`,
      headers: { cookie }
    });
    expect(bare.statusCode, bare.body).toBe(200);
    expect(bare.json()).toMatchObject({ checkpoint: null, computer: null });

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie, 'idempotency-key': 'rewind-refused' },
      payload: { operation: 'branch', eventId: firstMessage.id, rewind: 'both' }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('checkpoint_unavailable');

    const checkpoint = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bc7',
      workspaceId,
      taskId,
      turn: 0,
      mechanism: 'content',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 512,
      durationMs: 40
    });
    /*
     * There is one route that answers "can this point be undone", and it is the one the dialog
     * asks. A second route listing a conversation's checkpoints answered a coarser version of the
     * same question - it cannot say what a restore would change, and a checkpoint may be pruned
     * between the listing and the restore - and nothing ever called it.
     */
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/tasks/${taskId}/checkpoints`,
          headers: { cookie }
        })
      ).statusCode
    ).toBe(404);

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/rewind-preview`,
      headers: { cookie }
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      checkpoint: { id: checkpoint.id },
      // The part the owner most needs: a rewind does not uninstall anything.
      computer: { modifiedCount: 1, packagesInstalled: [{ name: 'ripgrep' }] }
    });

    /*
     * Not while a step could be writing. This replaces the tree under whatever is running, so a
     * file being written mid-call lands in a directory that is about to be deleted and the step
     * carries on against a machine that silently became a different one. The task is still
     * `queued` from the setup above, which is exactly that case.
     */
    const busy = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie, 'idempotency-key': 'rewind-busy' },
      payload: { operation: 'branch', eventId: firstMessage.id, rewind: 'both' }
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json<{ error: { code: string } }>().error.code).toBe('workspace_busy');

    // Waiting for the owner is not working: this is the state the conversation is in when somebody
    // is looking at it and reaches for the rewind, so refusing here would put the control out of
    // reach of the only screen that offers it.
    await store.updateTask({ id: taskId, status: 'awaiting_user' });

    runnerCalls.length = 0;
    const rewound = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie, 'idempotency-key': 'rewind-both' },
      payload: { operation: 'branch', eventId: firstMessage.id, rewind: 'both' }
    });
    expect(rewound.statusCode, rewound.body).toBe(200);
    expect(rewound.json()).toMatchObject({
      rewind: 'both',
      restoredCheckpointId: checkpoint.id
    });
    // A safety point first, then the restore. Every other destructive act in the product takes one;
    // this one asked the owner to choose a past state and then made the present unreachable.
    expect(
      runnerCalls.indexOf(`POST /v1/workspaces/${workspaceId}/snapshots`)
    ).toBeGreaterThanOrEqual(0);
    expect(runnerCalls.indexOf(`POST /v1/workspaces/${workspaceId}/snapshots`)).toBeLessThan(
      runnerCalls.indexOf(`POST /v1/workspaces/${workspaceId}/checkpoints/${checkpoint.id}/restore`)
    );
    expect(runnerCalls).toContain(
      `POST /v1/workspaces/${workspaceId}/checkpoints/${checkpoint.id}/restore`
    );

    // `computer` alone forks nothing: the transcript carries on, with a note about the files.
    const machineOnly = await app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/trajectory`,
      headers: { cookie, 'idempotency-key': 'rewind-computer' },
      payload: { operation: 'branch', eventId: firstMessage.id, rewind: 'computer' }
    });
    expect(machineOnly.statusCode, machineOnly.body).toBe(200);
    expect(machineOnly.json<{ id: string }>().id).toBe(taskId);
    expect((await events()).some((event) => event.summary === 'Computer rewound')).toBe(true);
  }, 30_000);
});

describe('the standing record of what athanor said', () => {
  test('gives every notice a sentence, including one it can no longer read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-notices-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, store } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const user = (await store.getUserByUsername('owner'))!;
    const masterKey = Buffer.alloc(32, 9);
    const workspaceId = randomUUID();
    const dataKey = generateDataKey();
    await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: 'Watching',
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId,
      titleCiphertext: encryptJson({ title: 'Permit watch' }, dataKey, `task-title:${workspaceId}`),
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'Watch the permits' }, dataKey)
    });
    await store.createAgentNotification({
      userId: user.id,
      taskId: task.id,
      kind: 'agent_message',
      messageCiphertext: encryptJson(
        { message: 'Three September slots opened.' },
        dataKey,
        agentNotificationAad(task.id)
      )
    });
    // Sealed with a key this box does not hold, which is the shape of a replaced master key or a
    // workspace key lost with its row. The sentence is unrecoverable; the fact that one was said
    // is not, and it is the more alarming of the two.
    await store.createAgentNotification({
      userId: user.id,
      taskId: task.id,
      kind: 'takeover_needed',
      messageCiphertext: encryptJson(
        { message: 'A site is asking for you.' },
        generateDataKey(),
        agentNotificationAad(task.id)
      )
    });

    const log = await app.inject({
      method: 'GET',
      url: '/v1/notifications/agent',
      headers: { cookie }
    });
    expect(log.statusCode, log.body).toBe(200);
    const notices = log.json<Array<{ kind: string; message: string; taskTitle: string | null }>>();
    expect(notices).toHaveLength(2);
    // Newest first, and no row carries a null message: a client with nothing to render drops the
    // row, so a null here would silently delete the only report that a key has stopped opening.
    expect(notices[0]).toMatchObject({
      kind: 'takeover_needed',
      message: UNREADABLE_AGENT_MESSAGE,
      taskTitle: 'Permit watch'
    });
    expect(notices[1]).toMatchObject({
      kind: 'agent_message',
      message: 'Three September slots opened.'
    });
    expect(notices.every((notice) => typeof notice.message === 'string' && notice.message)).toBe(
      true
    );
    expect(log.body).not.toContain('A site is asking for you');
  }, 30_000);
});

/**
 * A mailbox and a calendar the owner can actually add.
 *
 * The connector layer speaks IMAP and SMTP over TLS sockets rather than HTTPS, so the connect
 * route has its own seam for them; these tests drive it with a server that answers the real line
 * protocol, because "the credentials were stored" is worth nothing if the endpoint was never
 * spoken to and the owner finds out at the moment they ask for a message to be sent.
 */
class ScriptedMailServer extends Duplex {
  #pending = Buffer.alloc(0);
  readonly received: string[] = [];

  constructor(private readonly respond: (command: string, server: ScriptedMailServer) => void) {
    super();
  }

  override _read(): void {
    // Everything this server says is pushed when it decides to say it.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    for (;;) {
      const at = this.#pending.indexOf(0x0a);
      if (at < 0) break;
      const line = this.#pending.subarray(0, at).toString('binary').replace(/\r$/, '');
      this.#pending = this.#pending.subarray(at + 1);
      this.received.push(line);
      this.respond(line, this);
    }
    callback();
  }

  say(text: string): void {
    this.push(Buffer.from(text, 'binary'));
  }
}

const mailboxHarness = (refuse?: RegExp) => {
  // Held in an object rather than closed over directly, so a test can make a mailbox that answered
  // once stop answering - which is the whole subject of re-verification.
  const state = { refuse };
  const spoken: string[] = [];
  const socketFactory: MailSocketFactory = (endpoint) => {
    if (endpoint.port === 993) {
      const imap = new ScriptedMailServer((command, server) => {
        spoken.push(`imap ${command}`);
        const tag = command.split(' ')[0] ?? '';
        const rest = command.slice(tag.length + 1);
        if (state.refuse?.test(rest)) return server.say(`${tag} NO refused\r\n`);
        if (rest === 'LIST "" "*"')
          return server.say(
            `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n${tag} OK done\r\n`
          );
        return server.say(`${tag} OK done\r\n`);
      });
      imap.say('* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] athanor test ready\r\n');
      return imap;
    }
    const smtp = new ScriptedMailServer((command, server) => {
      spoken.push(`smtp ${command}`);
      if (command.startsWith('EHLO'))
        return server.say('250-mail.example.test\r\n250 AUTH PLAIN LOGIN\r\n');
      if (command.startsWith('AUTH PLAIN'))
        return server.say(
          state.refuse?.test(command)
            ? '535 5.7.8 authentication failed\r\n'
            : '235 2.7.0 authenticated\r\n'
        );
      if (command === 'QUIT') return server.say('221 2.0.0 bye\r\n');
      return server.say('502 5.5.1 unhandled\r\n');
    });
    smtp.say('220 mail.example.test ESMTP\r\n');
    return smtp;
  };
  return { spoken, socketFactory, state };
};

const calendarTransport: ConnectorTransport = async (input) => {
  const xml = (body: string) => ({
    status: 207,
    headers: { 'content-type': 'application/xml' },
    body: Buffer.from(`<?xml version="1.0"?><multistatus xmlns="DAV:">${body}</multistatus>`),
    durationMs: 2
  });
  if (input.url.hostname !== 'calendar.example.test')
    throw new Error(`unexpected calendar host ${input.url.hostname}`);
  if (input.url.pathname === '/dav/')
    return xml(
      '<response><href>/dav/</href><propstat><prop><current-user-principal><href>/dav/principals/owner/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>'
    );
  if (input.url.pathname === '/dav/principals/owner/')
    return xml(
      '<response><href>/dav/principals/owner/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">/dav/calendars/owner/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>'
    );
  return xml(
    '<response><href>/dav/calendars/owner/personal/</href><propstat><prop><displayname>Personal</displayname><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>'
  );
};

describe('mail and calendar connectors', () => {
  const openServer = async (
    label: string,
    overrides: Parameters<typeof buildServer>[1],
    hostSuffixes = ''
  ) => {
    const directory = await mkdtemp(join(tmpdir(), `athanor-api-${label}-`));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database } = await buildServer(
      { ...isolatedConfig(directory), CONNECTOR_ALLOWED_HOST_SUFFIXES: hostSuffixes },
      overrides
    );
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    return { app, database, cookie };
  };

  test('connects a mailbox only after both halves of it answer', async () => {
    const mail = mailboxHarness();
    const { app, database, cookie } = await openServer('mailbox', {
      mailSocketFactory: mail.socketFactory
    });

    const catalog = await app.inject({
      method: 'GET',
      url: '/v1/connectors/catalog',
      headers: { cookie }
    });
    expect(
      catalog.json<Array<{ kind: string; requirements?: string }>>().find((e) => e.kind === 'imap')
        ?.requirements
    ).toContain('app password');

    const connected = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'mailbox-connect-0001' },
      payload: {
        kind: 'imap',
        label: 'My mailbox',
        baseUrl: 'imaps://mail.example.test:993',
        username: 'owner@example.test',
        password: 'the-app-password',
        fromAddress: 'owner@example.test',
        fromName: 'The Owner',
        smtpHost: 'mail.example.test',
        scopes: ['mail:mailbox.read', 'mail:message.write', 'mail:message.send']
      }
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({
      kind: 'imap',
      authMode: 'secret',
      label: 'My mailbox',
      baseUrl: 'imaps://mail.example.test:993',
      enabled: true
    });

    // Both endpoints were actually spoken to, and the submission half was checked now rather than
    // at the moment the owner first asks for a message to go out.
    expect(mail.spoken.some((line) => line.startsWith('imap') && line.includes('LIST'))).toBe(true);
    expect(mail.spoken.some((line) => line.startsWith('smtp AUTH PLAIN'))).toBe(true);

    // The app password reaches the database sealed and never comes back out of the API.
    expect(connected.body).not.toContain('the-app-password');
    const stored = await database.query('SELECT secret_ciphertext FROM connectors');
    expect(JSON.stringify(stored.rows)).not.toContain('the-app-password');
    const listed = await app.inject({ method: 'GET', url: '/v1/connectors', headers: { cookie } });
    expect(listed.body).not.toContain('the-app-password');
    expect(listed.body).not.toContain('secretCiphertext');
  }, 30_000);

  test('refuses a mailbox whose submission host will not authenticate', async () => {
    const mail = mailboxHarness(/AUTH PLAIN/);
    const { app, database, cookie } = await openServer('mailbox-refused', {
      mailSocketFactory: mail.socketFactory
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'mailbox-refused-0001' },
      payload: {
        kind: 'imap',
        label: 'Wrong password',
        baseUrl: 'imaps://mail.example.test:993',
        username: 'owner@example.test',
        password: 'stale-app-password',
        fromAddress: 'owner@example.test',
        smtpHost: 'mail.example.test',
        scopes: ['mail:mailbox.read', 'mail:message.send']
      }
    });
    expect(refused.statusCode).toBe(400);
    // Nothing half-connected survives a refusal.
    await expect(
      database
        .query('SELECT COUNT(*) AS count FROM connectors')
        .then((r) => Number(r.rows[0]!.count))
    ).resolves.toBe(0);
  }, 30_000);

  test('binds a mailbox to the deployment host list when one is set', async () => {
    const mail = mailboxHarness();
    const { app, cookie } = await openServer(
      'mailbox-scoped',
      { mailSocketFactory: mail.socketFactory },
      'mail.company.test'
    );
    const outside = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'mailbox-scoped-0001' },
      payload: {
        kind: 'imap',
        label: 'Elsewhere',
        baseUrl: 'imaps://mail.example.test:993',
        username: 'owner@example.test',
        password: 'the-app-password',
        fromAddress: 'owner@example.test',
        smtpHost: 'mail.example.test',
        scopes: ['mail:mailbox.read']
      }
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json<{ error: { code: string } }>().error.code).toBe(
      'connector_url_not_allowed'
    );
    // The socket is never opened, so the password never leaves the box for a host it may not reach.
    expect(mail.spoken).toEqual([]);
  }, 30_000);

  test('connects a calendar once its CalDAV address answers with a calendar', async () => {
    const { app, cookie } = await openServer('calendar', {
      connectorTransport: calendarTransport
    });
    const catalog = await app.inject({
      method: 'GET',
      url: '/v1/connectors/catalog',
      headers: { cookie }
    });
    expect(
      catalog
        .json<Array<{ kind: string; requirements?: string }>>()
        .find((entry) => entry.kind === 'caldav')?.requirements
    ).toContain('CalDAV URL');

    const connected = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'calendar-connect-0001' },
      payload: {
        kind: 'caldav',
        label: 'My calendar',
        baseUrl: 'https://calendar.example.test/dav/',
        username: 'owner',
        password: 'calendar-app-password',
        address: 'owner@example.test',
        scopes: ['calendar:calendars.read', 'calendar:events.write']
      }
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({
      kind: 'caldav',
      authMode: 'secret',
      label: 'My calendar',
      scopes: ['calendar:calendars.read', 'calendar:events.write']
    });
    expect(connected.body).not.toContain('calendar-app-password');

    // A scope from another connector is not a capability this one can be granted.
    const wrongScope = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'calendar-connect-0002' },
      payload: {
        kind: 'caldav',
        label: 'Mixed up',
        baseUrl: 'https://calendar.example.test/dav/',
        username: 'owner',
        password: 'calendar-app-password',
        address: 'owner@example.test',
        scopes: ['mail:message.send']
      }
    });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json<{ error: { code: string } }>().error.code).toBe(
      'connector_scope_invalid'
    );
  }, 30_000);

  /**
   * The account was good when it was connected. The question this answers is whether it still is,
   * and the point of asking is that the alternative is a task failing at the moment it mattered.
   */
  test('re-verifies a connected mailbox and says so when it has stopped working', async () => {
    const mail = mailboxHarness();
    const { app, cookie } = await openServer('mailbox-recheck', {
      mailSocketFactory: mail.socketFactory
    });
    const connected = await app.inject({
      method: 'POST',
      url: '/v1/connectors',
      headers: { cookie, 'idempotency-key': 'mailbox-recheck-0001' },
      payload: {
        kind: 'imap',
        label: 'My mailbox',
        baseUrl: 'imaps://mail.example.test:993',
        username: 'owner@example.test',
        password: 'the-app-password',
        fromAddress: 'owner@example.test',
        smtpHost: 'mail.example.test',
        scopes: ['mail:mailbox.read', 'mail:message.send']
      }
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const connectorId = connected.json<{ id: string }>().id;

    const healthy = await app.inject({
      method: 'POST',
      url: `/v1/connectors/${connectorId}/test`,
      headers: { cookie }
    });
    expect(healthy.statusCode, healthy.body).toBe(200);
    expect(healthy.json()).toMatchObject({
      connectorId,
      ok: true,
      accountLabel: 'owner@example.test',
      failure: null
    });
    // The stored credential was used: nothing in the request carries one, and both halves answered.
    expect(mail.spoken.filter((line) => line.startsWith('smtp AUTH PLAIN'))).toHaveLength(2);

    // The password on the far end changes. Nothing on this box knows until it asks.
    mail.state.refuse = /AUTH PLAIN/;
    const stale = await app.inject({
      method: 'POST',
      url: `/v1/connectors/${connectorId}/test`,
      headers: { cookie }
    });
    // A refused login is an answer to the question, not a bad request.
    expect(stale.statusCode, stale.body).toBe(200);
    const result = stale.json<{
      ok: boolean;
      accountLabel: string | null;
      failure: { code: string; message: string } | null;
    }>();
    expect(result.ok).toBe(false);
    expect(result.accountLabel).toBeNull();
    expect(result.failure?.message).toBeTruthy();
    expect(stale.body).not.toContain('the-app-password');

    // Both checks are in the connector's own audit trail, which is where an owner reading "when did
    // this stop working" has to be able to find them.
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/connectors/audit',
      headers: { cookie }
    });
    const rechecks = audit
      .json<Array<{ operation: string; outcome: string }>>()
      .filter((entry) => entry.operation === 'connection_rechecked');
    expect(rechecks.map((entry) => entry.outcome).sort()).toEqual(['failed', 'succeeded']);

    // The connector is still connected: a failed check reports, it does not revoke.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/connectors', headers: { cookie } })).json<
        Array<{ id: string; enabled: boolean }>
      >()
    ).toMatchObject([{ id: connectorId, enabled: true }]);

    const missing = await app.inject({
      method: 'POST',
      url: `/v1/connectors/${randomUUID()}/test`,
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);
  }, 30_000);
});

describe('where web searches are answered', () => {
  /**
   * The one disclosure athanor cannot get wrong. A search query is routinely the most revealing
   * sentence in a conversation, and OpenRouter's zero-retention enforcement is documented as
   * covering inference routing only - "It does not apply to plugins and tools you choose to enable,
   * such as web search". That cuts both ways, and the product used to read only one half of it:
   * because the guarantee never covered a search, refusing to send the search tools protected
   * nothing, while quietly costing a server-hosted box the only search route that works from a
   * datacenter address. What the owner is actually owed is the sentence saying where their queries
   * go, and it has to reach that verdict through the same function the worker sends the request
   * with, or the two can disagree about a task that has already run.
   */
  // A provider that lists at least one model, because one that lists none is refused: the answer
  // built from an empty list is the seed allowlist with nothing live behind it, and believing it
  // would flatten the owner's catalogue on the way through this very route.
  const stubProviderCalls = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: 'z-ai/glm-5.2', name: 'GLM-5.2', context_length: 1_000_000 }],
              ok: true
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

  const providerSettings = async (
    config: ApiConfig,
    connect: { enforceZeroDataRetention: boolean } | null
  ) => {
    const { app } = await buildServer(config);
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    if (connect) {
      const connected = await app.inject({
        method: 'PUT',
        url: '/v1/providers',
        headers: { cookie, 'idempotency-key': 'web-route-provider' },
        payload: {
          provider: 'openrouter',
          apiKey: 'test-key',
          enforceZeroDataRetention: connect.enforceZeroDataRetention
        }
      });
      expect(connected.statusCode, connected.body).toBe(200);
    }
    return (await app.inject({ method: 'GET', url: '/v1/providers', headers: { cookie } })).json<{
      webSearch: { mode: string; reason: string; disclosure: string };
    }>();
  };

  /*
   * The same verdict has to reach the screen where a conversation is actually typed. The client
   * asks once, at startup, because every screen that can start a conversation needs it.
   */
  test('carries the same answer in the bootstrap every client starts from', async () => {
    stubProviderCalls();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-websearch-bootstrap-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const connected = await app.inject({
      method: 'PUT',
      url: '/v1/providers',
      headers: { cookie, 'idempotency-key': 'web-route-bootstrap' },
      payload: { provider: 'openrouter', apiKey: 'test-key', enforceZeroDataRetention: false }
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const bootstrap = (
      await app.inject({ method: 'GET', url: '/v1/bootstrap', headers: { cookie } })
    ).json<{ instance: { webSearch: unknown } }>();
    const settings = (
      await app.inject({ method: 'GET', url: '/v1/providers', headers: { cookie } })
    ).json<{ webSearch: { mode: string } }>();
    expect(bootstrap.instance.webSearch).toEqual(settings.webSearch);
    expect(settings.webSearch.mode).toBe('server');
  }, 30_000);

  /**
   * The bug this whole wave is about, held down at the surface an owner actually reads.
   *
   * The shipped default is a credential that refuses data retention, and that used to take
   * provider-side search off the box - which on a server is the only search route that works, since
   * search engines answer a datacenter address with an anti-bot challenge rather than results. The
   * owner was never offered that trade: nothing on this page said their privacy setting had also
   * bought them a box that cannot search, and no setting on this page could give it back.
   *
   * It bought nothing either. The retention promise covers inference routing and says in terms that
   * it does not cover tools, so the query was outside it whichever way this resolved. What is owed
   * is the sentence, and the sentence is what this asserts.
   */
  test('still answers searches on the provider when the credential enforces zero retention', async () => {
    stubProviderCalls();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-websearch-cred-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const settings = await providerSettings(isolatedConfig(directory), {
      enforceZeroDataRetention: true
    });
    expect(settings.webSearch).toMatchObject({
      mode: 'server',
      reason: 'provider_search_available'
    });
    // And says so, in the words the worker puts in front of the model on the same run.
    expect(settings.webSearch.disclosure).toContain('sees the query');
  }, 30_000);

  test('lets the deployment take provider search off the box, and says that is what did it', async () => {
    stubProviderCalls();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-websearch-forced-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    // The switch that is about search rather than about retention, and the whole of the way back
    // to the old behaviour - reachable from the environment, with no credential edit and so no
    // passkey step-up in the way.
    const settings = await providerSettings(
      { ...isolatedConfig(directory), AI_FORCE_INHOUSE_WEB: true },
      { enforceZeroDataRetention: true }
    );
    expect(settings.webSearch).toMatchObject({
      mode: 'in_house',
      reason: 'forced_in_house'
    });
    expect(settings.webSearch.disclosure).toContain('your own computer');
  }, 30_000);

  test('answers for a box configured from its environment and never connected by hand', async () => {
    stubProviderCalls();
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-websearch-env-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    // AI_REQUIRE_ZDR is the shipped default and no longer speaks to this question at all.
    const settings = await providerSettings(isolatedConfig(directory), null);
    expect(settings.webSearch).toMatchObject({
      mode: 'server',
      reason: 'provider_search_available'
    });
  }, 30_000);
});

describe('a half-typed message', () => {
  /*
   * The client's own storage module gives "closing the laptop and picking the same work up on a
   * phone" as its reason for existing, and then kept the draft in localStorage - so the sentence
   * was true only when both were the same browser. Start a message on the laptop, open the phone,
   * and the box is empty.
   */
  test('is saved on the box and handed to the next device that asks', async () => {
    // Creating a workspace provisions it through the runner, which is not what this is about.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, storageBytes: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-drafts-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, database } = await buildServer(isolatedConfig(directory));
    disposers.push(() => app.close());
    const cookie = sessionCookie(
      await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
    );
    const workspace = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie, 'idempotency-key': 'draft-workspace' },
      payload: { name: 'Drafting', storageLimitBytes: 10_000_000_000, region: 'auto' }
    });
    expect(workspace.statusCode, workspace.body).toBe(200);
    const workspaceId = workspace.json<{ id: string }>().id;

    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { cookie },
      payload: {
        workspaceId,
        body: 'a sentence begun on another device',
        // A message that is mostly its files used to sync as an empty draft: the tray lived in one
        // composer's memory, so the other device saw the sentence and none of the attachments.
        attachments: [
          {
            path: 'workspace/uploads/abc-report.pdf',
            name: 'report.pdf',
            sizeBytes: 1024,
            mimeType: 'application/pdf'
          }
        ]
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);

    // Read back the way a second device gets it: through bootstrap, decrypted by the box.
    const next = await app.inject({ method: 'GET', url: '/v1/bootstrap', headers: { cookie } });
    // `updatedAt` travels with it: without a time against the sentence, a device that had once
    // seen a draft could only ever keep its own copy, and would eventually write that stale copy
    // back over a newer one.
    const drafts = next.json<{ drafts: Array<Record<string, unknown>> }>().drafts;
    expect(drafts).toHaveLength(1);
    const [draft] = drafts;
    // The stamp has to be a real time; the rest is compared whole, so a field leaking into this
    // payload fails here rather than travelling to every device unnoticed.
    expect(Number.isFinite(new Date(String(draft?.updatedAt)).getTime())).toBe(true);
    expect({ ...draft, updatedAt: 'checked separately' }).toEqual({
      workspaceId,
      taskId: null,
      body: 'a sentence begun on another device',
      attachments: [
        {
          path: 'workspace/uploads/abc-report.pdf',
          name: 'report.pdf',
          sizeBytes: 1024,
          mimeType: 'application/pdf'
        }
      ],
      updatedAt: 'checked separately'
    });

    // And the box holds no plaintext of it, because a draft is the owner's words like any other.
    const stored = await database.query('SELECT body_ciphertext FROM message_drafts');
    expect(JSON.stringify(stored.rows[0])).not.toContain('another device');

    // Emptying it removes the row rather than keeping emptiness for every conversation opened.
    await app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { cookie },
      payload: { workspaceId, body: '   ' }
    });
    const cleared = await app.inject({ method: 'GET', url: '/v1/bootstrap', headers: { cookie } });
    expect(cleared.json<{ drafts: unknown[] }>().drafts).toEqual([]);
  });
});
