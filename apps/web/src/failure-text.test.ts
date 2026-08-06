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
