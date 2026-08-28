/**
 * The token form against the scopes the server actually enforces.
 *
 * The list of scopes is written out in `api-token-scopes.ts` rather than imported, because pulling
 * the Zod schema runtime into the browser to render eleven checkboxes is not worth the first
 * paint. That copy is only safe if something fails when the two disagree — which is exactly the
 * drift that left four of them ungrantable — so this test imports the enum and holds the table to
 * it. A test file costs the bundle nothing.
 */
import { describe, expect, it } from 'vitest';
import { ApiTokenScope, CreateApiTokenRequest } from '@athanor/contracts';
import {
  apiTokenRequest,
  apiTokenScopeCopy,
  apiTokenSummary,
  defaultApiTokenScopes,
  emptyApiTokenDraft,
  toggleApiTokenScope,
  MAX_TOKEN_DAYS
} from './api-token-scopes.js';

describe('the scopes an owner can actually grant', () => {
  it('offers every scope the server enforces, and none it does not', () => {
    expect(apiTokenScopeCopy.map((item) => item.scope).sort()).toEqual(
      [...ApiTokenScope.options].sort()
    );
  });

  it('never labels a scope with its own enum value', () => {
    // A copy table that lost its entries would satisfy every expectation below by never reaching
    // one, and the form would render a scope list with no words in it.
    expect(apiTokenScopeCopy.length).toBeGreaterThan(0);
    for (const item of apiTokenScopeCopy) {
      expect(item.label, item.scope).not.toContain(':');
      expect(item.label.length, item.scope).toBeGreaterThan(3);
      expect(item.detail.length, item.scope).toBeGreaterThan(20);
    }
  });

  /*
   * Answering approvals on the owner's behalf and reconfiguring the machine each act in the world
   * with nobody watching. They are grantable; they are not default.
   *
   * Spending on generation acts without the owner present too, and it is default: a token that may
   * not start work is not a token anybody writes a script against. `defaultApiTokenScopes` says
   * that, and the checkbox for `tasks:write` says what it costs.
   *
   * The whole default set is asserted rather than two absences, because the sentence above claimed
   * three for as long as the loop below held out two, and only the set can catch that.
   */
  it('leaves answering approvals and reconfiguring the machine unticked by default', () => {
    expect([...defaultApiTokenScopes]).toEqual([
      'workspaces:read',
      'tasks:read',
      'tasks:write',
      'files:read',
      'files:write',
      'models:read'
    ]);
    for (const scope of ['approvals:write', 'workspaces:write'] as const)
      expect(defaultApiTokenScopes, scope).not.toContain(scope);
  });

  it('ticks and unticks a scope, keeping the order the form is read in', () => {
    const order = apiTokenScopeCopy.map((item) => item.scope);
    const ticked = toggleApiTokenScope(defaultApiTokenScopes, 'approvals:write');
    expect(ticked).toContain('approvals:write');
    expect(ticked).toEqual(order.filter((scope) => ticked.includes(scope)));
    expect(toggleApiTokenScope(ticked, 'approvals:write')).toEqual([...defaultApiTokenScopes]);
  });
});

describe('what the form sends, and what it refuses to send', () => {
  it('builds a request the server’s own schema accepts', () => {
    const request = apiTokenRequest({
      ...emptyApiTokenDraft(),
      label: '  Backup script  ',
      scopes: [...ApiTokenScope.options]
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.body.label).toBe('Backup script');
    expect(CreateApiTokenRequest.safeParse(request.body).success).toBe(true);
  });

  it('refuses a token with no label, because a list of unnamed tokens cannot be revoked safely', () => {
    const request = apiTokenRequest({ ...emptyApiTokenDraft(), label: '   ' });
    expect(request).toMatchObject({ ok: false });
    if (request.ok) return;
    expect(request.message).toContain('label');
  });

  it('refuses a token that may do nothing rather than letting the server answer in Zod', () => {
    const request = apiTokenRequest({ ...emptyApiTokenDraft(), label: 'Empty', scopes: [] });
    expect(request).toMatchObject({ ok: false });
    if (request.ok) return;
    expect(request.message).toContain('at least one');
  });

  it('refuses an expiry the server would refuse, in days rather than in a schema path', () => {
    for (const expiresInDays of ['0', '400', '30.5', '']) {
      const request = apiTokenRequest({ ...emptyApiTokenDraft(), label: 'Script', expiresInDays });
      expect({ expiresInDays, ok: request.ok }).toEqual({ expiresInDays, ok: false });
    }
    expect(
      apiTokenRequest({
        ...emptyApiTokenDraft(),
        label: 'Script',
        expiresInDays: String(MAX_TOKEN_DAYS)
      }).ok
    ).toBe(true);
  });
});

describe('what an issued token’s row says', () => {
  it('lists what it can reach in words, not scope strings', () => {
    const summary = apiTokenSummary({
      scopes: ['tasks:read', 'usage:read'],
      expiresAt: '2026-11-01T09:00:00.000Z'
    });
    expect(summary).toContain('Read conversations');
    expect(summary).toContain('Read spending');
    expect(summary).not.toContain('tasks:read');
    expect(summary).toContain('expires');
  });

  it('does not claim an expiry it could not read', () => {
    expect(apiTokenSummary({ scopes: ['tasks:read'], expiresAt: 'not-a-date' })).toContain(
      'no expiry recorded'
    );
  });
});
