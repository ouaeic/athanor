import { describe, expect, it } from 'vitest';
import {
  duplicatedWebCapabilities,
  resolveWebToolPlan,
  serverToolUseFrom,
  webCitationsFrom,
  SERVER_WEB_FETCH_MAX_CONTENT_TOKENS,
  SERVER_WEB_FETCH_MAX_USES,
  SERVER_WEB_SEARCH_MAX_RESULTS,
  SERVER_WEB_SEARCH_MAX_USES,
  WEB_TOOL_DISCLOSURE,
  WebCitation,
  type WebToolRouteInput
} from './web-tools.js';

/** The route half of the plan, which is what every question about precedence is about. */
const resolveWebToolRoute = (input: WebToolRouteInput) => {
  const { mode, reason, disclosure } = resolveWebToolPlan(input);
  return { mode, reason, disclosure };
};

const serverWebTools = (input: WebToolRouteInput) => resolveWebToolPlan(input).serverTools;
const supersededInHouseWebTools = (input: WebToolRouteInput) =>
  resolveWebToolPlan(input).supersedes;

/** The only combination of facts that lets a query leave the box. Everything else is a refusal. */
const permitting: WebToolRouteInput = {
  privacyRoute: 'external',
  enforceZeroDataRetention: false,
  provider: 'openrouter'
};

describe('web tool route', () => {
  it('answers searches on the provider only when nothing about the task forbids it', () => {
    expect(resolveWebToolRoute(permitting)).toEqual({
      mode: 'server',
      reason: 'provider_search_available',
      disclosure: WEB_TOOL_DISCLOSURE.server
    });
  });

  // The documented boundary this whole module exists for: OpenRouter's zero-retention flag governs
  // inference routing and says in terms that it does not cover tools. A provider-side search on a
  // zero-retention task would put the query - usually the most revealing sentence in the
  // conversation - outside every guarantee athanor makes, with the badge still showing.
  it('refuses the provider on a zero-retention task even when the credential permits it', () => {
    expect(resolveWebToolRoute({ ...permitting, privacyRoute: 'provider_zdr' })).toMatchObject({
      mode: 'in_house',
      reason: 'zero_retention_task'
    });
  });

  it('refuses the provider when the credential enforces zero retention, whatever the task asked', () => {
    expect(resolveWebToolRoute({ ...permitting, enforceZeroDataRetention: true })).toMatchObject({
      mode: 'in_house',
      reason: 'zero_retention_credential'
    });
  });

  it('refuses an endpoint that has no server tools, rather than sending a name it will reject', () => {
    for (const provider of ['custom', 'openai-compatible', 'ollama-cloud', ''])
      expect(resolveWebToolRoute({ ...permitting, provider })).toMatchObject({
        mode: 'in_house',
        reason: 'provider_has_no_server_tools'
      });
  });

  it('lets the deployment take provider web tools off the box entirely', () => {
    expect(resolveWebToolRoute({ ...permitting, forceInHouse: true })).toMatchObject({
      mode: 'in_house',
      reason: 'forced_in_house'
    });
  });

  it('states the deployment override first, so the operator is told what actually decided it', () => {
    // Every refusal reaches the same mode; only the reason differs, and the reason is what the
    // settings page shows. An operator who set the override should not be told it was their model.
    expect(
      resolveWebToolRoute({
        privacyRoute: 'provider_zdr',
        enforceZeroDataRetention: true,
        provider: 'custom',
        forceInHouse: true
      }).reason
    ).toBe('forced_in_house');
  });

  it('never resolves to the provider from an unspecified override', () => {
    for (const forceInHouse of [undefined, false])
      expect(resolveWebToolRoute({ ...permitting, forceInHouse }).mode).toBe('server');
  });

  // The owner can edit the stored credential from the settings page while a task is still running.
  // Without the pin, turning zero retention off mid-run would move a task that began under the
  // in-house promise onto the provider's search, for a task the owner was never asked about.
  it('keeps a run that started in house there after the fact that refused it stops being true', () => {
    expect(resolveWebToolRoute({ ...permitting, startedMode: 'in_house' })).toEqual({
      mode: 'in_house',
      reason: 'pinned_in_house_for_run',
      disclosure: WEB_TOOL_DISCLOSURE.in_house
    });
    expect(serverWebTools({ ...permitting, startedMode: 'in_house' })).toEqual([]);
    expect(supersededInHouseWebTools({ ...permitting, startedMode: 'in_house' })).toEqual([]);
  });

  it('still moves a run onto the in-house route the moment a privacy fact becomes true', () => {
    // The pin is one-directional on purpose: a credential that turns zero retention on takes
    // effect on the next step, cache prefix or no cache prefix.
    for (const refusing of [
      { ...permitting, enforceZeroDataRetention: true },
      { ...permitting, forceInHouse: true },
      { ...permitting, provider: 'custom' }
    ])
      expect(resolveWebToolRoute({ ...refusing, startedMode: 'server' }).mode).toBe('in_house');
  });

  it('leaves a run that started on the provider alone while nothing has changed', () => {
    expect(resolveWebToolRoute({ ...permitting, startedMode: 'server' }).reason).toBe(
      'provider_search_available'
    );
    expect(resolveWebToolRoute({ ...permitting, startedMode: undefined }).mode).toBe('server');
  });

  it('reports the fact that refused this run, not the pin, while that fact still holds', () => {
    // Every step of a zero-retention conversation should say so; the pin is not an explanation the
    // owner can act on, and it is only the honest answer once nothing else refuses.
    expect(
      resolveWebToolRoute({
        ...permitting,
        privacyRoute: 'provider_zdr',
        startedMode: 'in_house'
      }).reason
    ).toBe('zero_retention_task');
  });

  it('says one sentence per mode and never asks a question', () => {
    for (const line of Object.values(WEB_TOOL_DISCLOSURE)) {
      expect(line.split('. ').length).toBe(1);
      expect(line).not.toContain('?');
    }
    // The line the owner reads has to name the disclosure, not merely mention that a choice exists.
    expect(WEB_TOOL_DISCLOSURE.server).toContain('sees the query');
    expect(WEB_TOOL_DISCLOSURE.in_house).toContain('your own computer');
  });
});

describe('provider web tools', () => {
  it('hands out nothing at all on any route that refused the provider', () => {
    for (const refusing of [
      { ...permitting, privacyRoute: 'provider_zdr' as const },
      { ...permitting, enforceZeroDataRetention: true },
      { ...permitting, provider: 'custom' },
      { ...permitting, forceInHouse: true }
    ])
      expect(serverWebTools(refusing)).toEqual([]);
  });

  it('sends both provider tools with their ceilings pinned, never null', () => {
    const tools = serverWebTools(permitting);
    expect(tools.map((tool) => tool.type)).toEqual([
      'openrouter:web_search',
      'openrouter:web_fetch'
    ]);
    expect(tools[0]?.parameters).toEqual({
      engine: 'auto',
      max_results: SERVER_WEB_SEARCH_MAX_RESULTS,
      max_uses: SERVER_WEB_SEARCH_MAX_USES
    });
    expect(tools[1]?.parameters).toEqual({
      engine: 'openrouter',
      max_uses: SERVER_WEB_FETCH_MAX_USES,
      max_content_tokens: SERVER_WEB_FETCH_MAX_CONTENT_TOKENS
    });
    // Left null, these are the unbounded research loop that arrives as a surprise on the bill.
    for (const tool of tools)
      for (const value of Object.values(tool.parameters)) expect(value).not.toBeNull();
  });

  /**
   * The cache guard. The tool block is serialised into the prompt prefix; if the same mode ever
   * produced two different byte strings, the prefix would end at the tool catalogue and the whole
   * window would be re-billed at full input rate on that step.
   */
  it('serialises byte-identically on repeated calls for the same facts', () => {
    const first = JSON.stringify(serverWebTools(permitting));
    for (let attempt = 0; attempt < 8; attempt += 1)
      expect(JSON.stringify(serverWebTools({ ...permitting }))).toBe(first);
  });

  it('cannot be mutated by a caller into something a later task would send', () => {
    const tools = serverWebTools(permitting);
    expect(() => {
      (tools[0] as { type: string }).type = 'openrouter:shell';
    }).toThrow();
    expect(() => {
      (tools[0]?.parameters as Record<string, unknown>).max_uses = 10_000;
    }).toThrow();
    expect(serverWebTools(permitting)[0]?.type).toBe('openrouter:web_search');
  });

  it('puts nothing on the wire but the two fields the provider reads', () => {
    // `supersedes` is athanor's own bookkeeping. A third key here would travel in the tools array
    // of every request on this route, where the provider has no field to put it in.
    for (const tool of serverWebTools(permitting))
      expect(Object.keys(tool).sort()).toEqual(['parameters', 'type']);
  });

  it('names the real in-house tools the provider ones stand in for, one for one', () => {
    // The failure this prevents: `parallel_web_read` left in the catalogue beside the provider's
    // web_fetch, so the model holds two ways to read a public page and has to guess between them.
    const superseded = supersededInHouseWebTools(permitting);
    expect([...superseded]).toEqual(['web_search', 'parallel_web_read']);
    // Exactly one withdrawal per provider tool, and no name withdrawn twice - the pairing is the
    // only thing standing between "one capability" and "two descriptions of one capability".
    expect(superseded).toHaveLength(serverWebTools(permitting).length);
    expect(new Set(superseded).size).toBe(superseded.length);
  });

  it('withdraws nothing at all on any route that stayed in house', () => {
    // A withdrawal applied in the wrong mode does not degrade the web, it removes it: these are
    // the only two web tools the in-house catalogue has.
    for (const refusing of [
      { ...permitting, privacyRoute: 'provider_zdr' as const },
      { ...permitting, enforceZeroDataRetention: true },
      { ...permitting, provider: 'custom' },
      { ...permitting, forceInHouse: true }
    ])
      expect(supersededInHouseWebTools(refusing)).toEqual([]);
  });

  it('never withdraws the browser, which is the half of the web the provider cannot reach', () => {
    // Provider fetch wins on a static page and cannot sign in, fill a form or hold a session.
    for (const browserTool of ['browser_action', 'browser_snapshot', 'read_elements', 'print_pdf'])
      expect(supersededInHouseWebTools(permitting)).not.toContain(browserTool);
  });

  it('answers the tools and the withdrawals from one verdict, on every combination of facts', () => {
    // The pair that disagrees is the whole failure: provider tools sent while the in-house ones are
    // still offered, or the in-house ones withdrawn on a route that sends no provider tool at all.
    for (const privacyRoute of ['provider_zdr', 'external'] as const)
      for (const enforceZeroDataRetention of [true, false])
        for (const provider of ['openrouter', 'custom'])
          for (const forceInHouse of [true, false, undefined])
            for (const startedMode of ['in_house', 'server', undefined] as const) {
              const plan = resolveWebToolPlan({
                privacyRoute,
                enforceZeroDataRetention,
                provider,
                forceInHouse,
                startedMode
              });
              const sendsProviderTools = plan.serverTools.length > 0;
              expect(sendsProviderTools).toBe(plan.mode === 'server');
              expect(plan.supersedes.length > 0).toBe(sendsProviderTools);
              expect(plan.disclosure).toBe(WEB_TOOL_DISCLOSURE[plan.mode]);
            }
  });
});

describe('duplicated web capabilities', () => {
  it('names an in-house tool left in the catalogue beside the provider tool that replaces it', () => {
    const plan = resolveWebToolPlan(permitting);
    expect(
      duplicatedWebCapabilities(plan.serverTools, ['shell', 'web_search', 'file_read'])
    ).toEqual(['web_search']);
    expect(duplicatedWebCapabilities(plan.serverTools, [...plan.supersedes])).toEqual([
      'web_search',
      'parallel_web_read'
    ]);
  });

  it('says nothing about a catalogue that withdrew what it had to', () => {
    const plan = resolveWebToolPlan(permitting);
    expect(
      duplicatedWebCapabilities(plan.serverTools, ['shell', 'browser_action', 'browser_snapshot'])
    ).toEqual([]);
    // The in-house route sends no provider tool, so every web tool in the catalogue belongs there.
    const inHouse = resolveWebToolPlan({ ...permitting, privacyRoute: 'provider_zdr' });
    expect(
      duplicatedWebCapabilities(inHouse.serverTools, ['web_search', 'parallel_web_read'])
    ).toEqual([]);
  });
});

describe('citations from a provider annotation list', () => {
  it('reads the citation out of the field the annotation names after its own type', () => {
    expect(
      webCitationsFrom([
        {
          type: 'url_citation',
          url_citation: {
            url: 'https://example.invalid/rate',
            title: 'Rates',
            content: 'The rate was 4.25 per cent.'
          }
        }
      ])
    ).toEqual([
      {
        url: 'https://example.invalid/rate',
        title: 'Rates',
        excerpt: 'The rate was 4.25 per cent.'
      }
    ]);
  });

  it('reads a flat annotation too, so one provider spelling is not the only one understood', () => {
    expect(webCitationsFrom([{ url: 'https://example.invalid/flat', title: 'Flat' }])).toEqual([
      { url: 'https://example.invalid/flat', title: 'Flat' }
    ]);
  });

  it('keeps a page cited twice for two different claims, and drops the same claim twice', () => {
    const cited = webCitationsFrom([
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'one' } },
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'two' } },
      { type: 'url_citation', url_citation: { url: 'https://example.invalid/a', content: 'one' } }
    ]);
    expect(cited.map((citation) => citation.excerpt)).toEqual(['one', 'two']);
  });

  it('drops what has no address and keeps the rest of the list', () => {
    expect(
      webCitationsFrom([
        { type: 'file_citation', file_citation: { file_id: 'f-1', quote: 'no address' } },
        null,
        'https://example.invalid/string',
        { url: 'https://example.invalid/kept' }
      ])
    ).toEqual([{ url: 'https://example.invalid/kept', title: '' }]);
  });

  it('answers nothing at all when the provider attached no annotations', () => {
    for (const value of [undefined, null, [], {}, 'annotations'])
      expect(webCitationsFrom(value)).toEqual([]);
  });
});

describe('server tool counters', () => {
  it('reports what the provider says it spent, under the provider’s own counter names', () => {
    expect(serverToolUseFrom({ web_search_requests: 3, web_fetch_requests: 0 })).toEqual({
      web_search_requests: 3,
      web_fetch_requests: 0
    });
  });

  it('keeps the counters it understands when one arrives in a shape it does not', () => {
    // The searches the owner was billed for must not be lost because a counter this build has
    // never seen arrived beside them.
    expect(
      serverToolUseFrom({ web_search_requests: 2, something_new: { calls: 4 }, negative: -1 })
    ).toEqual({ web_search_requests: 2 });
  });

  it('answers nothing rather than an empty object when no provider tool ran', () => {
    for (const value of [undefined, null, {}, [], 7, { web_search_requests: 'many' }])
      expect(serverToolUseFrom(value)).toBeUndefined();
  });
});

describe('web citation', () => {
  it('keeps the passage OpenRouter attaches, which it sends as content', () => {
    // The shape of a url_citation on the wire. Reading only `excerpt` here drops the grounding
    // evidence from every citation the provider sends and leaves a bare link behind.
    expect(
      WebCitation.parse({
        url: 'https://example.invalid/a',
        title: 'A',
        content: 'The rate was 4.25 per cent.',
        start_index: 10,
        end_index: 42
      })
    ).toEqual({
      url: 'https://example.invalid/a',
      title: 'A',
      excerpt: 'The rate was 4.25 per cent.'
    });
  });

  it('keeps the passage a vendor native citation calls cited_text', () => {
    expect(WebCitation.parse({ url: 'https://example.invalid/b', cited_text: 'Quoted.' })).toEqual({
      url: 'https://example.invalid/b',
      title: '',
      excerpt: 'Quoted.'
    });
  });

  it('prefers an excerpt a caller already normalised over either raw field', () => {
    expect(
      WebCitation.parse({
        url: 'https://example.invalid/c',
        excerpt: 'chosen',
        content: 'raw',
        cited_text: 'raw'
      }).excerpt
    ).toBe('chosen');
  });

  it('accepts a citation with no passage at all, and one with no title', () => {
    expect(WebCitation.parse({ url: 'https://example.invalid/d' })).toEqual({
      url: 'https://example.invalid/d',
      title: ''
    });
    // Providers do send an explicit null here, which a plain default would refuse outright.
    expect(WebCitation.parse({ url: 'https://example.invalid/e', title: null }).title).toBe('');
    expect(WebCitation.parse({ url: 'https://example.invalid/f', content: '   ' }).excerpt).toBe(
      undefined
    );
  });

  it('trims an over-long title or passage rather than losing the source', () => {
    const parsed = WebCitation.parse({
      url: 'https://example.invalid/g',
      title: 'T'.repeat(1_000),
      content: 'C'.repeat(20_000)
    });
    expect(parsed.title).toHaveLength(300);
    expect(parsed.excerpt).toHaveLength(4_000);
  });

  it('refuses a citation that does not carry a real address', () => {
    expect(() => WebCitation.parse({ url: 'not-a-url', title: 'A' })).toThrow();
    expect(() => WebCitation.parse({ title: 'A' })).toThrow();
    for (const value of [null, 'https://example.invalid/h', ['https://example.invalid/i']])
      expect(() => WebCitation.parse(value)).toThrow();
  });
});
