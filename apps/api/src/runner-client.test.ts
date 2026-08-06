import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCapabilityToken } from '@athanor/core';
import { RunnerClient } from './runner-client.js';

const secret = 'runner-secret-with-at-least-32-characters';

afterEach(() => vi.unstubAllGlobals());

describe('runner capability requests', () => {
  it('binds the token it sends to the request it sends it with', async () => {
    let authorization = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = String(new Headers(init?.headers).get('authorization'));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const runner = new RunnerClient('http://runner.test', secret);
    await runner.request({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'control',
      scopes: ['files.read'],
      path: '/v1/workspaces/workspace-1/file?path=notes.md'
    });
    const claims = verifyCapabilityToken(authorization.slice('Bearer '.length), secret, {
      method: 'GET',
      path: '/v1/workspaces/workspace-1/file'
    });
    expect(claims.aud).toBe('GET /v1/workspaces/workspace-1/file');
    expect(() =>
      verifyCapabilityToken(authorization.slice('Bearer '.length), secret, {
        method: 'POST',
        path: '/v1/workspaces/workspace-1/exec'
      })
    ).toThrow('minted for a different request');
  });

  it('scrubs a secret out of an upstream failure before it becomes an error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('command failed: OPENAI_KEY=sk-live-01234567890abcdefgh not accepted', {
            status: 500
          })
      )
    );
    const runner = new RunnerClient('http://runner.test', secret);
    await expect(
      runner.request({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        role: 'agent',
        scopes: ['exec'],
        path: '/v1/workspaces/workspace-1/exec',
        method: 'POST'
      })
    ).rejects.toThrow(/Workspace runtime returned 500.*\[REDACTED\]/);
  });
});
