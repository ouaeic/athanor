import { describe, expect, it } from 'vitest';
import {
  webSearchNote,
  webSearchReason,
  webSearchSummary,
  type WebSearchRoute
} from './web-search-route.js';

/** Exactly what the server sends: the resolver's one verdict for this box. */
const onProvider: WebSearchRoute = {
  mode: 'server',
  reason: 'provider_search_available',
  disclosure:
    "Web searches are answered by your model provider's search service, which sees the query."
};

const inHouse: WebSearchRoute = {
  mode: 'in_house',
  reason: 'forced_in_house',
  disclosure: 'Web searches run on your own computer.'
};

describe('where this box’s searches go', () => {
  it('says nothing at all when the server did not send an answer', () => {
    expect(webSearchNote(undefined)).toBe('');
    expect(webSearchSummary(undefined)).toBeUndefined();
  });

  /*
   * The in-house route is the quiet answer. A badge that is always on the screen is one nobody
   * reads on the day it changes, so the composer only speaks when a query would leave the computer.
   */
  it('marks the composer only when a query would leave this computer', () => {
    expect(webSearchNote(onProvider)).toBe('Web searches go to your provider');
    expect(webSearchNote(inHouse)).toBe('');
  });

  /**
   * One sentence per verdict the resolver can reach, and no sentence for a verdict it cannot.
   *
   * The two retention reasons this list used to carry are gone with the branches that produced
   * them: a credential's retention setting is about what a provider keeps of an inference request
   * and never covered the search tools, so it no longer decides where a query goes. Leaving their
   * sentences here would have kept the old explanation available to a page that can no longer be
   * told it - which is how a settings screen ends up explaining a rule the server stopped applying.
   */
  it('gives the owner a reason they can act on for every verdict the resolver still has', () => {
    for (const reason of [
      'forced_in_house',
      'provider_has_no_server_tools',
      'pinned_in_house_for_run',
      'provider_search_available'
    ])
      expect(webSearchReason({ mode: 'in_house', reason, disclosure: '' })).not.toBe('');
    for (const withdrawn of ['zero_retention_task', 'zero_retention_credential'])
      expect(webSearchReason({ mode: 'in_house', reason: withdrawn, disclosure: '' })).toBe('');
  });

  /** A reason from a newer server says nothing rather than being guessed at. */
  it('stays silent about a reason this build does not know', () => {
    expect(webSearchReason({ mode: 'in_house', reason: 'something_later', disclosure: '' })).toBe(
      ''
    );
  });

  /*
   * The settings page used to print a heading per privacy route, and on the commonest box of all -
   * a provider key that refuses retention - the same sentence under both of them. There was never
   * a second answer to print: a box has one privacy route, because a model's route comes from that
   * same key and a task can only run on a model whose route matches its own.
   */
  it('states the one answer this box has, in the contract’s own words', () => {
    expect(webSearchSummary(inHouse)).toEqual({
      disclosure: 'Web searches run on your own computer.',
      reason: 'This server keeps every search in house, whatever a conversation asks for.'
    });
    expect(webSearchSummary(onProvider)).toEqual({
      disclosure:
        "Web searches are answered by your model provider's search service, which sees the query.",
      reason: 'Nothing on this server stands in the way.'
    });
  });

  it('shows the disclosure even when the reason beside it is one this build cannot phrase', () => {
    expect(webSearchSummary({ ...onProvider, reason: 'something_later' })).toEqual({
      disclosure: onProvider.disclosure,
      reason: ''
    });
  });
});
