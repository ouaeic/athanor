import { describeFailure } from './failure-text.js';

/**
 * What a terminal session's end should say.
 *
 * The pane used to write one yellow "Session closed" line into the scrollback and stop. Every way a
 * session can end - the owner typing `exit`, the capability running out, the box going away - read
 * identically, the six on-screen key buttons stayed lit and did nothing, and there was no control
 * anywhere that started another. So the decision is made here, where a test can reach it, and the
 * pane only renders it.
 *
 * The distinction that matters is between an ending the owner caused and one that happened to them:
 * the first needs no explanation, the second needs to say what went wrong. Both need the same way
 * back, and it has to be honest about what pressing it does - a new socket is a new shell in the
 * workspace folder, so a `cd` and anything running are gone. Calling that "Reconnect" would be the
 * failure the audit warns about, which is why the label says what it gives you.
 */
export type SessionClose =
  /** The socket closed. `code` is the WebSocket close code; 1005 is "closed with no code". */
  | { readonly kind: 'socket'; readonly code: number; readonly reason: string }
  /** The capability could never be fetched, so no socket was ever opened. */
  | { readonly kind: 'token'; readonly cause: unknown };

export interface SessionEnd {
  /** The line across the pane. */
  readonly message: string;
  /** True when the session simply ended - the shell exited, or the owner's own close. */
  readonly clean: boolean;
}

/**
 * 1000 is a normal close and 1005 is the close the runner sends after the shell exits, which
 * arrives with no code at all. Neither is a fault, so neither gets an explanation.
 */
const CLEAN_CODES = new Set([1000, 1005]);

export const sessionEnd = (close: SessionClose): SessionEnd => {
  if (close.kind === 'token')
    return { message: describeFailure(close.cause, 'Could not reach this computer'), clean: false };
  if (CLEAN_CODES.has(close.code)) return { message: 'Session closed', clean: true };
  // 1008 is the runner revoking the session because the capability behind it ran out. It is the
  // one failure that is not a fault of the connection, and the owner can fix it by starting
  // another, so it says what happened in those terms rather than quoting the close reason.
  if (close.code === 1008) return { message: "This session's access expired", clean: false };
  return {
    message: describeFailure(
      close.reason.trim() ? new Error(close.reason) : undefined,
      'The connection to this computer dropped'
    ),
    clean: false
  };
};
