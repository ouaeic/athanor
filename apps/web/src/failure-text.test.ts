import { describe, expect, it } from 'vitest';
import { ApiFailure } from './api-failure.js';
import { describeFailure, isTransportFailure } from './failure-text.js';

describe('failure wording', () => {
  it('replaces the browser string for a dropped connection', () => {
    // What Safari and Chrome actually throw from `fetch` when the network is gone.
    expect(describeFailure(new TypeError('Load failed'), 'Could not load')).toBe(
      'Your athanor is not reachable right now. It keeps working; this device will reconnect.'
    );
    expect(describeFailure(new TypeError('Failed to fetch'), 'Could not load')).toBe(
      'Your athanor is not reachable right now. It keeps working; this device will reconnect.'
    );
  });

  it('treats a timed-out or aborted request as unreachable too', () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(isTransportFailure(aborted)).toBe(true);
  });

  it('says the software is restarting when a proxy answered instead of it', () => {
    // What the owner actually hits: nginx stays up across an update while athanor@api is down, so
    // the browser gets HTML, `request` cannot parse it, and the whole failure is a status code.
    for (const status of [502, 503, 504])
      expect(describeFailure(new ApiFailure('request_failed', 'Request failed', status), 'x')).toBe(
        'Your athanor answered, but the software on it is not up yet. That normally means it is ' +
          'restarting; this device will keep trying.'
      );
  });

  it('leaves athanor its own 503, which says more than the gateway sentence could', () => {
    expect(
      describeFailure(
        new ApiFailure(
          'transcription_route_unavailable',
          'The connected provider offers no model that reads recordings.',
          503
        ),
        'x'
      )
    ).toBe('The connected provider offers no model that reads recordings.');
  });

  it('passes a real answer from the box through untouched', () => {
    expect(
      describeFailure(new ApiFailure('storage_limit', 'Workspace storage limit reached', 400), 'x')
    ).toBe('Workspace storage limit reached');
    expect(isTransportFailure(new ApiFailure('task_not_found', 'Task not found', 404))).toBe(false);
  });

  it('falls back when there is nothing worth showing', () => {
    expect(describeFailure(undefined, 'Could not stop the agent')).toBe('Could not stop the agent');
    expect(describeFailure(new Error('   '), 'Could not stop the agent')).toBe(
      'Could not stop the agent'
    );
  });
});
