import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  capabilityAudience,
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
    const token = signCapabilityToken(
      { sub: 'worker', workspaceId, role: 'agent', scopes: ['exec'], nonce: randomUUID() },
      secret
    );
    const claims = verifyCapabilityToken(token, secret);
    expect(claims.workspaceId).toBe(workspaceId);
    expect(() => requireCapability(claims, 'exec')).not.toThrow();
    expect(() => requireCapability(claims, 'browser.takeover')).toThrow();
  });

  it('grants nothing on a wildcard scope', () => {
    const claims = verifyCapabilityToken(
      signCapabilityToken(
        { sub: 'agent', workspaceId: randomUUID(), role: 'agent', scopes: ['*'], nonce: 'n' },
        secret
      ),
      secret
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
    const claims = {
      sub: 'agent',
      workspaceId: randomUUID(),
      role: 'agent' as const,
      scopes: ['exec'],
      nonce: randomUUID()
    };
    expect(() => signCapabilityToken(claims, secret, MAX_CAPABILITY_TTL_SECONDS + 1)).toThrow(
      'Capability lifetime must be'
    );
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      verifyCapabilityToken(
        forge({ ...claims, iat: now, exp: now + MAX_CAPABILITY_TTL_SECONDS + 60 }),
        secret
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
          nonce: randomUUID(),
          iat: now + 3600,
          exp: now + 3630
        }),
        secret
      )
    ).toThrow('not yet valid');
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
