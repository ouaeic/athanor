import { describe, expect, it } from 'vitest';
import {
  webSearchNote,
  webSearchReason,
  webSearchRouteFor,
  webSearchSummary,
  type WebSearchRoutes
} from './web-search-route.js';

/** Exactly what the server sends: the resolver's verdict for each of the two privacy routes. */
const routes = (patch: Partial<WebSearchRoutes> = {}): WebSearchRoutes => ({
  standard: {
    mode: 'server',
    reason: 'provider_search_available',
    disclosure:
      "Web searches are answered by your model provider's search service, which sees the query."
  },
  zeroRetention: {
    mode: 'in_house',
    reason: 'zero_retention_task',
    disclosure: 'Web searches run on your own computer.'
  },
  ...patch
});

const allInHouse: WebSearchRoutes = {
  standard: {
    mode: 'in_house',
    reason: 'zero_retention_credential',
    disclosure: 'Web searches run on your own computer.'
  },
  zeroRetention: {
    mode: 'in_house',
    reason: 'zero_retention_credential',
    disclosure: 'Web searches run on your own computer.'
  }
};

describe('where a conversation’s searches go', () => {
  it('answers for the route the conversation was started on, not for the box', () => {
    expect(webSearchRouteFor(routes(), 'provider_zdr')?.mode).toBe('in_house');
    expect(webSearchRouteFor(routes(), 'external')?.mode).toBe('server');
  });

  it('says nothing at all when the server did not send an answer', () => {
    expect(webSearchRouteFor(undefined, 'external')).toBeUndefined();
    expect(webSearchNote(undefined)).toBe('');
    expect(webSearchSummary(undefined)).toEqual([]);
  });

  /*
   * The in-house route is the default posture. A badge that is always on the screen is one nobody
   * reads on the day it changes, so the composer only speaks when a query would leave the computer.
   */
  it('marks the composer only when a query would leave this computer', () => {
    expect(webSearchNote(webSearchRouteFor(routes(), 'external'))).toBe(
      'Web searches go to your provider'
    );
    expect(webSearchNote(webSearchRouteFor(routes(), 'provider_zdr'))).toBe('');
  });

  it('gives the owner a reason they can act on for every verdict the resolver has', () => {
    for (const reason of [
      'forced_in_house',
      'zero_retention_task',
      'zero_retention_credential',
      'provider_has_no_server_tools',
      'pinned_in_house_for_run',
      'provider_search_available'
    ])
      expect(webSearchReason({ mode: 'in_house', reason, disclosure: '' })).not.toBe('');
  });

  /** A reason from a newer server says nothing rather than being guessed at. */
  it('stays silent about a reason this build does not know', () => {
    expect(webSearchReason({ mode: 'in_house', reason: 'something_later', disclosure: '' })).toBe(
      ''
    );
  });

  it('states one answer when both routes agree, and two only when they differ', () => {
    expect(webSearchSummary(allInHouse)).toEqual([
      {
        scope: '',
        disclosure: 'Web searches run on your own computer.',
        reason: 'Your saved provider key refuses data retention.'
      }
    ]);
    const split = webSearchSummary(routes());
    expect(split.map((line) => line.scope)).toEqual(['Private conversations', 'Everything else']);
    expect(split[1]?.reason).toBe('Nothing on this conversation stands in the way.');
    // The heading already says the conversation was started on the zero-retention route, so the
    // sentence saying it back adds a line and no fact - in the language of a conversation this
    // panel is not about, at that.
    expect(split[0]?.reason).toBe('');
  });

  it('states one answer when the routes agree but arrived there for different reasons', () => {
    // The common case the old rule missed: a provider key that refuses retention answers both
    // routes in house, but the zero-retention conversation is held there by its own route. Same
    // sentence, two headings, and the owner reads it twice.
    const agreeing = webSearchSummary({
      standard: {
        mode: 'in_house',
        reason: 'zero_retention_credential',
        disclosure: 'Web searches run on your own computer.'
      },
      zeroRetention: {
        mode: 'in_house',
        reason: 'zero_retention_task',
        disclosure: 'Web searches run on your own computer.'
      }
    });
    expect(agreeing).toHaveLength(1);
    // The reason kept is the one the owner can act on. A zero-retention conversation is held in
    // house whatever they change, so quoting its reason would describe a lock, not a setting.
    expect(agreeing[0]?.reason).toBe('Your saved provider key refuses data retention.');
  });
});
