import { z } from 'zod';

/**
 * Where a web search and a web fetch are actually performed, and what that discloses.
 *
 * athanor can answer a search two ways. In house means the workspace's own browser on the owner's
 * own machine: nothing leaves the box but the request the engine would have received from a person
 * sitting at it. On the provider means the model provider runs the search itself and hands the
 * model structured results with citations - faster, cheaper, and reachable from an address a search
 * engine will not serve directly.
 *
 * That last clause is why this file reads the way it does now. The in-house route is a browser
 * making an ordinary request from wherever athanor is installed, and athanor is built to be
 * installed on a server. Search engines challenge datacenter address ranges as a matter of course,
 * so on the deployment this product is designed for the in-house route does not degrade, it fails:
 * the engine answers with an anti-bot challenge instead of results, and it will answer the same way
 * to the next attempt, because what it is refusing is the address. Nothing in this repository may
 * work around a challenge. So a box whose only route is the in-house one is a box that cannot
 * search at all, and it finds that out one abandoned research task at a time.
 *
 * This module used to let zero data retention decide that, and it decided it twice. It read the
 * owner's stored credential enforcing zero retention, and it read the conversation's own privacy
 * route, and refused the provider on either. Those are not two facts: the credential's setting is
 * what labels every model in the catalogue `provider_zdr`, and a task may only run on a model whose
 * route matches its own, so a task's privacy route is a copy of the credential flag rather than
 * anything a conversation ever chose. The flag ships on. The result was that the shipped default
 * bought a promise about inference by spending the entire web, on every box, without saying so.
 *
 * The promise it was spending that on was never athanor's to make. Zero-data-retention enforcement
 * is documented as covering inference routing only: "It does not apply to plugins and tools you
 * choose to enable, such as web search." A search query is frequently the most revealing sentence
 * in a conversation - more revealing than the answer - and it falls outside that guarantee whichever
 * way this file resolves. So reading the retention flag as a refusal never kept a query private. It
 * only kept the search from happening, and left the owner believing otherwise.
 *
 * What the owner is actually owed is the truth about where their queries go, in the place they
 * type them and in the model's own runtime context. That is what `WEB_TOOL_DISCLOSURE` is, and it
 * is the reason this decision is a contract rather than a flag: the settings page, the composer and
 * the tools that go on the wire all read this one verdict, so they cannot come to disagree.
 *
 * The two questions are therefore answered by the two settings that are about them. What a provider
 * may keep of an inference request is the credential's business, and reaches the wire as the
 * provider block on the request. Whether a search query may be sent to a search service at all is
 * `AI_FORCE_INHOUSE_WEB`, which was built for exactly this question, says so where it is declared,
 * and restores every previous refusal in one line of environment - no credential edit, and so no
 * passkey step-up, for an owner who wants the old behaviour back.
 *
 * What the two modes disclose, stated exactly rather than approximately. Provider search discloses
 * the query string, any domain filters, and an approximate location if one is configured, to
 * whoever runs the engine. Provider fetch additionally discloses which URLs the owner is interested
 * in, and a publisher may retain parameters passed in those URLs. Neither discloses the
 * conversation, the workspace, or any file. The in-house route discloses the query to the search
 * engine and nothing to the model provider.
 *
 * The mode is decided once per run, and the decision only ever moves one way afterwards. The
 * provider is read from the owner's stored credential, which they can replace from the settings
 * page while a task is still running: repointing a box at OpenRouter mid-run would otherwise flip a
 * task that began under the in-house promise into one sending its queries to a third party, without
 * the owner ever being asked about that task. So a run carries the mode it started on, in
 * `startedMode`, and a run that started in house stays in house until it ends. The other direction
 * is deliberately not pinned: a change that takes provider search off this box applies on the very
 * next step, because withholding a privacy fact that has just become true to protect a cache prefix
 * is the wrong trade every time.
 *
 * That prefix is the reason the tool block is worth keeping still at all. The catalogue is
 * serialised into the cached prompt prefix, so a mode that changed mid-task would end the prefix at
 * the tool catalogue and re-bill the whole window at full input rate on that step. Which is a cost
 * worth paying exactly once, in the direction that protects the owner, and never in the other.
 */

export const WebToolMode = z.enum(['in_house', 'server']);
export type WebToolMode = z.infer<typeof WebToolMode>;

/**
 * Why the route came out the way it did, as a value rather than a sentence, so the timeline, the
 * settings page and the audit trail can each say it in their own words.
 */
export const WebToolRouteReason = z.enum([
  /** The deployment turned provider-side web tools off for every task on this box. */
  'forced_in_house',
  /** The model is reached through an endpoint that has no provider-side web tools to offer. */
  'provider_has_no_server_tools',
  /**
   * Nothing about the task forbids it any more, but this run already started in house, so it
   * finishes in house. Only reachable when a fact changed underneath a running task.
   */
  'pinned_in_house_for_run',
  /** Nothing stands in the way: the provider answers searches for this task. */
  'provider_search_available'
]);
export type WebToolRouteReason = z.infer<typeof WebToolRouteReason>;

export interface WebToolRouteInput {
  /** Which kind of endpoint the task's model is reached through. */
  provider: string;
  /** The deployment-wide override, `AI_FORCE_INHOUSE_WEB`. Absent means the owner has not set it. */
  forceInHouse?: boolean | undefined;
  /**
   * The mode this run has already been running under, where there is a run. Absent when the
   * question is about a task that has not started - which is what the settings page asks - and
   * carried on every step after the first once one has.
   */
  startedMode?: WebToolMode | undefined;
}

export interface WebToolRoute {
  mode: WebToolMode;
  reason: WebToolRouteReason;
  /** One sentence for the owner about where their queries go. Never more, and never a prompt. */
  disclosure: string;
}

/**
 * The only two sentences athanor says about this.
 *
 * Deliberately not a per-search confirmation: a prompt on every search makes the tool unusable, and
 * an owner who has to answer the same question thirty times stops reading it by the fourth. This is
 * a standing statement about the box instead, shown where a conversation is typed and carried into
 * the model's runtime context, so nobody has to open the source to learn where a query went.
 */
export const WEB_TOOL_DISCLOSURE: Readonly<Record<WebToolMode, string>> = Object.freeze({
  in_house: 'Web searches run on your own computer.',
  server: "Web searches are answered by your model provider's search service, which sees the query."
});

/**
 * The route, resolved from the facts and nothing else.
 *
 * Order is precedence, and every branch before the last one is a refusal, so a fact that is missing
 * or wrong can only ever move the answer towards the in-house route. `provider` is compared against
 * the one provider that has server tools rather than against a list of ones that do not, so a new
 * kind of endpoint arrives refused rather than arrives trusted.
 *
 * The deployment override is checked first because it is the one an operator set deliberately, and
 * every refusal reaches the same mode: an operator who took provider search off this box should be
 * told that is what decided it, not told about their model.
 *
 * The run pin is checked last of the refusals rather than first, so it is only ever the reported
 * reason when it is the thing actually holding the line. A run held in house by the deployment
 * switch is still told that is why, on every step, which is the sentence the owner can act on;
 * `pinned_in_house_for_run` appears only when the fact that refused this run has since stopped
 * being true.
 *
 * Not exported: `resolveWebToolPlan` below is the only way in, because a caller holding the mode
 * on its own is a caller that can send the provider's tools while keeping the in-house ones.
 */
const resolveWebToolRoute = (input: WebToolRouteInput): WebToolRoute => {
  const inHouse = (reason: WebToolRouteReason): WebToolRoute => ({
    mode: 'in_house',
    reason,
    disclosure: WEB_TOOL_DISCLOSURE.in_house
  });
  if (input.forceInHouse === true) return inHouse('forced_in_house');
  if (input.provider !== 'openrouter') return inHouse('provider_has_no_server_tools');
  if (input.startedMode === 'in_house') return inHouse('pinned_in_house_for_run');
  return {
    mode: 'server',
    reason: 'provider_search_available',
    disclosure: WEB_TOOL_DISCLOSURE.server
  };
};

/**
 * A provider-side tool, which is not a function the client implements but a name the provider
 * recognises and runs on its own infrastructure. It travels in the same `tools` array as a function
 * tool and has to survive serialisation without being wrapped in `{type:'function'}`.
 */
export interface ServerWebTool {
  readonly type: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Ceilings, pinned rather than left null.
 *
 * A provider search is billed per request and its results re-enter the prompt on every later step
 * of the same task, so an unbounded research loop is the expensive failure here, not the individual
 * call. Eight searches and twelve fetches is more than any single turn has ever needed and is a
 * bound a runaway cannot cross; ten results is what one page of results has always been on the
 * in-house route, so the two modes hand the model the same amount of material.
 */
export const SERVER_WEB_SEARCH_MAX_USES = 8;
export const SERVER_WEB_SEARCH_MAX_RESULTS = 10;
export const SERVER_WEB_FETCH_MAX_USES = 12;
/**
 * Roughly an eighth of the working window. The provider's own default is 100,000, which is a
 * documentation page that costs a quarter of the context to read.
 */
export const SERVER_WEB_FETCH_MAX_CONTENT_TOKENS = 20_000;

/**
 * Every provider-side tool athanor sends, each carried beside the in-house tool it stands in for.
 *
 * The pairing lives in the same structure as the tool rather than in a list beside it because the
 * two can never be allowed to disagree: a provider tool added without withdrawing what it replaces
 * hands the model two ways to do one thing, which is the failure this module exists to prevent, and
 * a withdrawal left behind after a provider tool is dropped takes the web off the task entirely.
 * Only the tool half is ever serialised - `supersedes` is athanor's own bookkeeping and has no
 * business on the wire.
 */
const PROVIDER_WEB_TOOLS = Object.freeze([
  Object.freeze({
    supersedes: 'web_search',
    tool: Object.freeze({
      type: 'openrouter:web_search',
      parameters: Object.freeze({
        // `auto` resolves to the model vendor's own search where the model has one and to Exa
        // otherwise, so this is not a capability only the frontier models get.
        engine: 'auto',
        max_results: SERVER_WEB_SEARCH_MAX_RESULTS,
        max_uses: SERVER_WEB_SEARCH_MAX_USES
      })
    })
  }),
  Object.freeze({
    supersedes: 'parallel_web_read',
    tool: Object.freeze({
      type: 'openrouter:web_fetch',
      parameters: Object.freeze({
        // The provider's own fetch engine, which is the free one; the paid engines buy nothing the
        // browser fallback does not already do better.
        engine: 'openrouter',
        max_uses: SERVER_WEB_FETCH_MAX_USES,
        max_content_tokens: SERVER_WEB_FETCH_MAX_CONTENT_TOKENS
      })
    })
  })
]);

const SERVER_WEB_TOOLS: readonly ServerWebTool[] = Object.freeze(
  PROVIDER_WEB_TOOLS.map((entry) => entry.tool)
);

const SUPERSEDED_IN_HOUSE_WEB_TOOLS: readonly string[] = Object.freeze(
  PROVIDER_WEB_TOOLS.map((entry) => entry.supersedes)
);

/**
 * Everything one run needs to know about the web, decided in a single call.
 *
 * The route, the provider tools to send and the in-house tools to withdraw are one decision, so
 * they are one call. Asking separately would mean resolving twice against facts the owner can edit
 * from the settings page between the two reads, and the two answers that disagree are the exact
 * pair the tool catalogue cannot survive: the provider's search sent while `web_search` is still
 * offered, so the model holds two descriptions of one capability, or the in-house tools withdrawn
 * on a route that sends no provider tool at all, which takes the web off the task entirely.
 *
 * `supersedes` names the in-house tools that have to leave the catalogue exactly when the provider
 * ones enter it, and is empty on every route that stayed in house. `web_search` is one capability
 * under one name in both modes, so sending both would be a duplicate key in the tools array before
 * it was ever a quality problem. `parallel_web_read` and the provider's `web_fetch` keep different
 * names because they are genuinely different calls - one reads twelve sources at once, the other
 * reads one - and giving them a single name would be a lie to the model about how to call it. What
 * matters is not that the names match but that the model is never holding both.
 *
 * The browser tools are deliberately never withdrawn. A provider fetch beats a throwaway browser on
 * a static page - one request instead of a browser launch, and no anti-bot challenge to meet - and
 * it loses outright on anything with a session, a login, a paywall or a form behind it, which is
 * what `browser_action` and `browser_snapshot` are for. Withdrawing them in server mode would trade
 * the half of the web that needs a real browser for the half that does not.
 */
export interface WebToolPlan extends WebToolRoute {
  readonly serverTools: readonly ServerWebTool[];
  readonly supersedes: readonly string[];
}

export const resolveWebToolPlan = (input: WebToolRouteInput): WebToolPlan => {
  const route = resolveWebToolRoute(input);
  return route.mode === 'server'
    ? { ...route, serverTools: SERVER_WEB_TOOLS, supersedes: SUPERSEDED_IN_HOUSE_WEB_TOOLS }
    : { ...route, serverTools: [], supersedes: [] };
};

/**
 * The in-house tools still in a catalogue that is being sent with the provider tools beside them.
 *
 * The pairing above is a rule the request has to hold, and a rule nobody checks is a convention.
 * This is what lets the gateway check it on the way out: the withdrawal happens where the tool
 * catalogue is built and the sending happens two packages away, so an agent that adds the provider
 * tools and forgets the withdrawal would otherwise be told by nothing at all, and the first
 * evidence would be a model choosing between two descriptions of one capability mid-task.
 */
export const duplicatedWebCapabilities = (
  serverTools: readonly ServerWebTool[],
  functionToolNames: readonly string[]
): readonly string[] => {
  const sending = new Set(serverTools.map((tool) => tool.type));
  const offered = new Set(functionToolNames);
  return PROVIDER_WEB_TOOLS.filter(
    (entry) => sending.has(entry.tool.type) && offered.has(entry.supersedes)
  ).map((entry) => entry.supersedes);
};

/**
 * The provider-side tools athanor deliberately does not send, recorded here because this is the
 * file somebody reaches for when they notice the list is longer than two.
 *
 * `openrouter:shell`, code execution and hosted interpreters: refused. They run in network-isolated
 * containers that cannot install a package at runtime and cannot see the owner's files, against a
 * persistent Linux computer that can do both. The argument is set out in full above athanor's own
 * exec route, in services/workspace-runner/src/execution.ts.
 *
 * `openrouter:apply_patch` and `openrouter:image_generation`: refused for the same reason in
 * smaller. athanor's `file_patch` edits real files with conflict detection, and `generate_media`
 * prices a request against the owner's spend limit before anything is spent, which the provider
 * tool has no equivalent of.
 *
 * `openrouter:subagent`: refused. It accepts only provider server tools and rejects function tools
 * outright, so a subagent could not read the workspace - which is the entire point of athanor's own
 * specialists.
 *
 * `openrouter:fusion`: held, not refused. A panel of models with an analyst is a real capability,
 * but its price is unpublished, and an unmetered spend does not belong in a product where one owner
 * pays the bill. It becomes buildable the day it is priced, through the same spend check
 * `generate_media` already uses.
 *
 * `openrouter:advisor`: wanted, and not yet built. Consulting a stronger model mid-generation on
 * one genuinely hard decision is the highest quality-per-token lever available and the one thing
 * athanor cannot do at all today - a cheap lead model that meets a hard question can currently only
 * answer it badly or have the owner restart the task. It belongs on this same gate when it lands,
 * because a server tool is a server tool: zero retention does not cover it either.
 */

const CITATION_TITLE_LIMIT = 300;
/**
 * Long enough to hold the paragraph a claim came from, short enough that a dozen of them do not
 * become the answer. A provider that sends more is trimmed rather than refused - see below.
 */
const CITATION_EXCERPT_LIMIT = 4_000;

/**
 * The passage the provider attached, under whichever name that provider gives it.
 *
 * OpenRouter puts it in `content` on a `url_citation`; the vendors whose native citations arrive
 * through that route call it `cited_text`. Reading only one of those names is how the grounding
 * evidence gets silently dropped on every citation from the other, so all of them are read, in
 * athanor's own order: an excerpt a caller has already normalised wins over either raw field.
 */
const citationPassage = (row: Record<string, unknown>): string | undefined => {
  for (const key of ['excerpt', 'content', 'cited_text']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '')
      return value.slice(0, CITATION_EXCERPT_LIMIT);
  }
  return undefined;
};

/**
 * A grounded source the provider attached to an answer. Stronger evidence than a tool-call id,
 * because the provider fetched it rather than the model reporting that it did.
 *
 * Everything that is not the address itself is repaired rather than rejected, and that asymmetry is
 * deliberate: a citation whose title runs long, whose excerpt runs to a whole page, or whose title
 * arrives null - all of which real responses contain - is still a real source the owner can open,
 * and throwing it away to enforce a length would lose the evidence in order to protect the field
 * that was carrying it. A citation with no usable address is the one case where there is nothing
 * left to keep, so that alone is refused.
 */
export const WebCitation = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    const title =
      typeof row.title === 'string' ? row.title.slice(0, CITATION_TITLE_LIMIT) : undefined;
    const excerpt = citationPassage(row);
    return {
      url: row.url,
      ...(title === undefined ? {} : { title }),
      ...(excerpt === undefined ? {} : { excerpt })
    };
  },
  z.object({
    url: z.string().url(),
    title: z.string().max(CITATION_TITLE_LIMIT).default(''),
    /** The passage the provider says the claim came from, where it gives one. */
    excerpt: z.string().max(CITATION_EXCERPT_LIMIT).optional()
  })
);
export type WebCitation = z.infer<typeof WebCitation>;

/**
 * The citation as it arrives, which is one level deeper than the citation itself.
 *
 * A provider annotates an answer with `{type:'url_citation', url_citation:{url,title,content}}`,
 * naming the payload after the type. Reading `row.type` and unwrapping the field it names handles
 * that without a list of type names to keep current - and a shape that is already flat, or that
 * names a field it did not send, falls through to the row itself rather than being lost.
 */
const citationRow = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const nested = typeof row.type === 'string' ? row[row.type] : undefined;
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : row;
};

/**
 * Every usable source in a provider's annotation list, in the order it cited them.
 *
 * Deduplicated on the address and the passage together rather than on the address alone: a provider
 * that grounds three separate claims in one page sends three annotations with three passages, and
 * collapsing those to one would throw away the evidence for two of the claims. What it does collapse
 * is the identical annotation arriving twice, which is what a streamed response does when it resends
 * the whole list on a later chunk instead of appending to it.
 *
 * Anything without a usable address is dropped rather than refused, because one malformed annotation
 * in a list of ten is not a reason to lose the other nine - and because there is nothing left in it
 * to keep. An answer's text never depends on this succeeding.
 */
export const webCitationsFrom = (value: unknown): WebCitation[] => {
  if (!Array.isArray(value)) return [];
  const citations: WebCitation[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const row = citationRow(entry);
    if (row === undefined) continue;
    const parsed = WebCitation.safeParse(row);
    if (!parsed.success) continue;
    const key = `${parsed.data.url}\n${parsed.data.excerpt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(parsed.data);
  }
  return citations;
};

/**
 * How many provider-side tool calls a response actually spent, keyed by the provider's own counter
 * name (`web_search_requests`, and whatever it adds later). Recorded so a search-heavy task is
 * visible against the owner's spend limit rather than arriving as a surprise line on the bill.
 */
export const ServerToolUse = z.record(
  z.string().min(1).max(64),
  z.number().int().nonnegative().max(1_000_000)
);
export type ServerToolUse = z.infer<typeof ServerToolUse>;

/**
 * The counters a response reported, entry by entry.
 *
 * Each is validated on its own so that one counter the provider has just started sending in a shape
 * this build does not recognise cannot discard the count of the searches the owner was actually
 * billed for. Nothing at all, rather than an empty object, when there is nothing to report: a task
 * that spent no provider tool call should carry no field saying so on every step of its trajectory.
 */
export const serverToolUseFrom = (value: unknown): ServerToolUse | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const counters: ServerToolUse = {};
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = ServerToolUse.safeParse({ [name]: count });
    if (parsed.success) Object.assign(counters, parsed.data);
  }
  return Object.keys(counters).length > 0 ? counters : undefined;
};
