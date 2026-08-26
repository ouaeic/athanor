import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  capabilityAudience,
  capabilityAudiences,
  deriveCapabilityNonce,
  MAX_CAPABILITY_TTL_SECONDS,
  requireCapability,
  signCapabilityToken,
  verifyCapabilityToken
} from './capability-token.js';

const secret = 'a'.repeat(32);

/** Mints a token the way a holder of the shared secret would, bypassing the signer's own limits. */
const forge = (claims: Record<string, unknown>): string => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'HS256', typ: 'OCAP', v: 1 })}.${encode(claims)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
};

describe('capability tokens', () => {
  it('binds a short-lived scope to one workspace', () => {
    const workspaceId = randomUUID();
    const request = { method: 'POST', path: `/v1/workspaces/${workspaceId}/exec` };
    const token = signCapabilityToken(
      {
        sub: 'worker',
        workspaceId,
        role: 'agent',
        scopes: ['exec'],
        aud: capabilityAudience(request.method, request.path),
        nonce: randomUUID()
      },
      secret
    );
    const claims = verifyCapabilityToken(token, secret, request);
    expect(claims.workspaceId).toBe(workspaceId);
    expect(() => requireCapability(claims, 'exec')).not.toThrow();
    expect(() => requireCapability(claims, 'browser.takeover')).toThrow();
  });

  it('grants nothing on a wildcard scope', () => {
    const request = { method: 'POST', path: '/v1/workspaces/w/exec' };
    const claims = verifyCapabilityToken(
      signCapabilityToken(
        {
          sub: 'agent',
          workspaceId: randomUUID(),
          role: 'agent',
          scopes: ['*'],
          aud: capabilityAudience(request.method, request.path),
          nonce: 'n'
        },
        secret
      ),
      secret,
      request
    );
    for (const scope of ['exec', 'terminal', 'files.write', 'workspace.manage'])
      expect(() => requireCapability(claims, scope)).toThrow(`Capability ${scope} is required`);
  });

  it('refuses a token replayed against a different request', () => {
    const workspaceId = randomUUID();
    const path = `/v1/workspaces/${workspaceId}/file`;
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId,
        role: 'user',
        scopes: ['files.read'],
        aud: capabilityAudience('GET', `${path}?path=notes.md`),
        nonce: randomUUID()
      },
      secret
    );
    expect(verifyCapabilityToken(token, secret, { method: 'GET', path }).workspaceId).toBe(
      workspaceId
    );
    // The query names the argument, not the capability, so it does not narrow the audience.
    expect(
      verifyCapabilityToken(token, secret, { method: 'GET', path: `${path}?path=other.md` }).sub
    ).toBe('user');
    expect(() =>
      verifyCapabilityToken(token, secret, {
        method: 'POST',
        path: `/v1/workspaces/${workspaceId}/exec`
      })
    ).toThrow('minted for a different request');
  });

  it('caps the lifetime a signer may ask for and a token may claim', () => {
    const request = { method: 'POST', path: '/v1/workspaces/w/exec' };
    const claims = {
      sub: 'agent',
      workspaceId: randomUUID(),
      role: 'agent' as const,
      scopes: ['exec'],
      aud: capabilityAudience(request.method, request.path),
      nonce: randomUUID()
    };
    expect(() => signCapabilityToken(claims, secret, MAX_CAPABILITY_TTL_SECONDS + 1)).toThrow(
      'Capability lifetime must be'
    );
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyCapabilityToken(
        forge({ ...claims, iat: now, exp: now + MAX_CAPABILITY_TTL_SECONDS + 60 }),
        secret,
        request
      )
    ).toThrow('Capability lifetime exceeds the maximum');
  });

  it('refuses a token stamped in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyCapabilityToken(
        forge({
          sub: 'agent',
          workspaceId: randomUUID(),
          role: 'agent',
          scopes: ['exec'],
          aud: capabilityAudience('POST', '/v1/workspaces/w/exec'),
          nonce: randomUUID(),
          iat: now + 3600,
          exp: now + 3630
        }),
        secret,
        { method: 'POST', path: '/v1/workspaces/w/exec' }
      )
    ).toThrow('not yet valid');
  });

  /**
   * The escape that made the scheme advisory. `aud` was compared only when the token carried one,
   * and nine of the worker's ten signing sites carried none - so a capability was a bearer token
   * for everything its scopes admitted, which for `exec` is every command the runner will run.
   */
  it('refuses a token that names no request at all', () => {
    const workspaceId = randomUUID();
    expect(() =>
      verifyCapabilityToken(
        signCapabilityToken(
          { sub: 'worker', workspaceId, role: 'agent', scopes: ['exec'], nonce: randomUUID() },
          secret
        ),
        secret,
        { method: 'POST', path: `/v1/workspaces/${workspaceId}/exec` }
      )
    ).toThrow('minted for a different request');
  });

  /**
   * A credential the client legitimately spends on more than one route - a takeover is a stream, an
   * action and a holder change - names all of them and still nothing else.
   */
  it('accepts any of the requests a multi-audience token names, and no others', () => {
    const workspaceId = randomUUID();
    const stream = { method: 'GET', path: `/v1/workspaces/${workspaceId}/browser/stream` };
    const action = { method: 'POST', path: `/v1/workspaces/${workspaceId}/browser/action` };
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId,
        role: 'user',
        scopes: ['browser.read', 'browser.control'],
        aud: capabilityAudiences([stream, action]),
        nonce: randomUUID()
      },
      secret
    );
    expect(verifyCapabilityToken(token, secret, stream).sub).toBe('user');
    expect(verifyCapabilityToken(token, secret, action).sub).toBe('user');
    // `read-many` fetches whatever address it is handed, on `browser.read`, and is the reason this
    // credential is worth binding at all.
    expect(() =>
      verifyCapabilityToken(token, secret, {
        method: 'POST',
        path: `/v1/workspaces/${workspaceId}/browser/read-many`
      })
    ).toThrow('minted for a different request');
  });

  it('derives the same runner nonce through every manager replica', () => {
    const derivationSecret = 'a sufficiently long capability secret value';
    expect(deriveCapabilityNonce('parent-nonce', derivationSecret)).toBe(
      deriveCapabilityNonce('parent-nonce', derivationSecret)
    );
    expect(deriveCapabilityNonce('other-parent', derivationSecret)).not.toBe(
      deriveCapabilityNonce('parent-nonce', derivationSecret)
    );
  });
});
