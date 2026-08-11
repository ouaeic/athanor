import { describe, expect, it } from 'vitest';
import { sessionEnd } from './terminal-session.js';

/**
 * Every one of these used to render the same yellow "Session closed" line, with no way back. The
 * shape that matters: the owner's own exit is not an incident, an expired capability says so in
 * words the owner can act on, and anything else says what actually went wrong.
 */
describe('what the end of a terminal session says', () => {
  it('treats the shell exiting as an ending, not a fault', () => {
    // 1005 is what a browser reports when the runner closes after the pty exits with no code.
    expect(sessionEnd({ kind: 'socket', code: 1005, reason: '' })).toEqual({
      message: 'Session closed',
      clean: true
    });
    expect(sessionEnd({ kind: 'socket', code: 1000, reason: '' })).toEqual({
      message: 'Session closed',
      clean: true
    });
  });

  it('names the expiry rather than quoting the close reason', () => {
    expect(sessionEnd({ kind: 'socket', code: 1008, reason: 'Capability expired' })).toEqual({
      message: "This session's access expired",
      clean: false
    });
  });

  it('carries a server reason through, and has words for a drop that gives none', () => {
    expect(sessionEnd({ kind: 'socket', code: 1011, reason: 'Workspace unavailable' })).toEqual({
      message: 'Workspace unavailable',
      clean: false
    });
    // 1006 is the abnormal close a dropped network gives: no code from the peer, no reason.
    expect(sessionEnd({ kind: 'socket', code: 1006, reason: '' })).toEqual({
      message: 'The connection to this computer dropped',
      clean: false
    });
  });

  it('reports a session that never opened through describeFailure', () => {
    expect(sessionEnd({ kind: 'token', cause: new Error('Workspace is hibernated') })).toEqual({
      message: 'Workspace is hibernated',
      clean: false
    });
    // The transport failure `fetch` throws is an Error too, which is why this goes through
    // describeFailure instead of reading `.message`: the owner would otherwise be shown "Load
    // failed".
    expect(sessionEnd({ kind: 'token', cause: new TypeError('Failed to fetch') }).message).toBe(
      'Your athanor is not reachable right now. It keeps working; this device will reconnect.'
    );
  });
});
