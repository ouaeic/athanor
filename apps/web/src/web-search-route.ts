/**
 * Where this box's web searches are answered, said in the owner's words.
 *
 * A search query is frequently the most revealing sentence in a conversation, and athanor answers
 * one of two ways: in the workspace's own browser, where nothing leaves the box, or by asking the
 * model provider's search service, which sees the query. Which one applies is decided by
 * `resolveWebToolPlan` in @athanor/contracts from the owner's provider and one deployment switch —
 * and until this module existed that decision was reachable only by reading the source.
 *
 * It used to be two answers, one per privacy route a conversation could be started on. It never was
 * two: a model's privacy route comes from the credential's retention flag and a task can only run
 * on a model whose route matches its own, so a box has exactly one kind of conversation, and the
 * second heading described one nobody could start here.
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

/**
 * Why the route came out the way it did.
 *
 * Phrased as what the owner can act on, in the order of the resolver's own precedence: the setting
 * they can change, the fact about their provider they cannot, and the pin that only exists because
 * a running task is not moved onto a search service it did not start on.
 */
const REASONS: Record<string, string> = {
  forced_in_house: 'This server keeps every search in house, whatever a conversation asks for.',
  provider_has_no_server_tools: 'Your model provider has no search service to offer.',
  pinned_in_house_for_run:
    'This conversation started in house, so it stays there until it ends — a setting changed underneath it does not move it.',
  provider_search_available: 'Nothing on this server stands in the way.'
};

export const webSearchReason = (route: WebSearchRoute): string => REASONS[route.reason] ?? '';

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
 * One line, because there is one answer. The page used to print two headings and, on the commonest
 * box of all - a provider key that refuses retention - the identical sentence under both, which is
 * a page arguing with itself about a decision that was never split.
 *
 * The disclosure is the contract's own; the reason is this client's, and is omitted rather than
 * guessed when the server names one this build has never heard of.
 */
export const webSearchSummary = (
  route: WebSearchRoute | undefined
): { disclosure: string; reason: string } | undefined =>
  route && { disclosure: route.disclosure, reason: webSearchReason(route) };
