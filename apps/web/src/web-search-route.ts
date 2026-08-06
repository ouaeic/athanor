/**
 * Where this conversation's web searches are answered, said in the owner's words.
 *
 * A search query is frequently the most revealing sentence in a conversation, and athanor answers
 * one of two ways: in the workspace's own browser, where nothing leaves the box, or by asking the
 * model provider's search service, which sees the query. Which one applies is decided by
 * `resolveWebToolPlan` in @athanor/contracts from the conversation's privacy route, the owner's
 * stored credential and one deployment switch — and until now that decision was reachable only by
 * reading the source.
 *
 * The contract hands over a `reason` as a value rather than a sentence precisely so each surface
 * can say it in its own register. These are this client's sentences; nothing here re-decides
 * anything, and a reason this build does not recognise says nothing rather than guessing.
 */

export type WebSearchMode = 'in_house' | 'server';

export interface WebSearchRoute {
  mode: WebSearchMode;
  reason: string;
  /** The contract's own one-line disclosure. Shown as it arrives, never rewritten. */
  disclosure: string;
}

/** Both answers this box would give, one per privacy route a conversation can be started on. */
export interface WebSearchRoutes {
  standard: WebSearchRoute;
  zeroRetention: WebSearchRoute;
}

/**
 * Why the route came out the way it did.
 *
 * Phrased as what the owner can act on, in the order of the resolver's own precedence: the two
 * settings they can change, the fact about their provider they cannot, and the pin that only exists
 * because a running task is not moved onto a search service it did not start on.
 */
const REASONS: Record<string, string> = {
  forced_in_house: 'This server keeps every search in house, whatever a conversation asks for.',
  zero_retention_task: 'This conversation was started on the zero-retention route.',
  zero_retention_credential: 'Your saved provider key refuses data retention.',
  provider_has_no_server_tools: 'Your model provider has no search service to offer.',
  pinned_in_house_for_run:
    'This conversation started in house, so it stays there until it ends — a setting changed underneath it does not move it.',
  provider_search_available: 'Nothing on this conversation stands in the way.'
};

export const webSearchReason = (route: WebSearchRoute): string => REASONS[route.reason] ?? '';

/**
 * Which of the two answers applies to a conversation, given the route it was started on.
 *
 * A conversation carries its privacy route for its whole life, so this is a fact about the
 * transcript on screen rather than about the next message typed into it.
 */
export const webSearchRouteFor = (
  routes: WebSearchRoutes | undefined,
  privacyRoute: 'provider_zdr' | 'external'
): WebSearchRoute | undefined =>
  routes && (privacyRoute === 'provider_zdr' ? routes.zeroRetention : routes.standard);

/**
 * The line the composer carries, or nothing at all.
 *
 * Deliberately empty on the in-house route. That is the default posture and the unremarkable
 * answer, and a permanent badge saying "nothing left this computer" is a line the eye stops reading
 * by the second day — at which point it is no longer there for the day it changes. What is news is
 * a query leaving the box, so that is what earns a place beside the composer.
 */
export const webSearchNote = (route: WebSearchRoute | undefined): string =>
  route?.mode === 'server' ? 'Web searches go to your provider' : '';

/**
 * What the settings page says, where the owner is holding the switch that changes it.
 *
 * One line whenever both routes give the same answer: printing the identical sentence twice under
 * two headings is the page arguing with itself about a decision that was never split. It used to
 * require the two REASONS to match as well, which missed the common case - a box whose provider key
 * refuses retention answers both routes in house for two different reasons, so the owner read
 * "Web searches run on your own computer." twice under two headings.
 *
 * When it collapses, the reason kept is the standard route's. That is the one the owner can change:
 * a zero-retention conversation is held in house by the route it was started on whatever they do,
 * so quoting its reason under a single heading would describe a lock rather than a setting.
 *
 * `zero_retention_task` is dropped from the split form for the same reason it is tautological
 * there: its scope heading, "Private conversations", already says the conversation was started on
 * the zero-retention route, and the sentence repeats it back in the language of a conversation the
 * settings panel is not about.
 */
export const webSearchSummary = (
  routes: WebSearchRoutes | undefined
): Array<{ scope: string; disclosure: string; reason: string }> => {
  if (!routes) return [];
  const line = (scope: string, route: WebSearchRoute) => ({
    scope,
    disclosure: route.disclosure,
    reason: route.reason === 'zero_retention_task' ? '' : webSearchReason(route)
  });
  return routes.standard.mode === routes.zeroRetention.mode &&
    routes.standard.disclosure === routes.zeroRetention.disclosure
    ? [line('', routes.standard)]
    : [
        line('Private conversations', routes.zeroRetention),
        line('Everything else', routes.standard)
      ];
};
