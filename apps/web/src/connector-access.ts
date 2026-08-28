/**
 * What a connected account can actually do, and what it has been asked to do, in the words the
 * owner chose rather than the identifiers the box stores.
 *
 * The connect form asks one question — read only, or read and write — and then the list underneath
 * printed `mail:mailbox.read · mail:message.write · mail:message.send`, which is the answer to a
 * question nobody asked. The same list is the only place the owner can check what they granted, so
 * it has to be readable at the moment doubt arrives.
 */
import type { ConnectorAuditEvent, ConnectorTestResult } from '@athanor/contracts';
import type { ConnectorDefinition } from './types.js';

interface AccessRule {
  /** Least permissive first is wrong here: the most permissive true statement is the honest one. */
  levels: Array<{ scope: string; phrase: string }>;
  base: string;
}

const accessRules: Record<string, AccessRule> = {
  mail: {
    levels: [
      { scope: 'mail:message.send', phrase: 'Reads your mail, and sends messages as you' },
      {
        scope: 'mail:message.write',
        phrase: 'Reads your mail, and saves drafts and marks messages'
      }
    ],
    base: 'Reads your mail'
  },
  calendar: {
    levels: [
      {
        scope: 'calendar:events.write',
        phrase: 'Reads your calendar, and creates events and answers invitations'
      }
    ],
    base: 'Reads your calendar'
  },
  github: {
    levels: [
      {
        scope: 'github:pull_requests.write',
        phrase: 'Reads your repositories, and opens issues and pull requests'
      },
      { scope: 'github:issues.write', phrase: 'Reads your repositories, and opens issues' }
    ],
    base: 'Reads your repositories and issues'
  },
  webdav: {
    levels: [
      { scope: 'webdav:files.delete', phrase: 'Reads, writes and deletes your files' },
      { scope: 'webdav:files.write', phrase: 'Reads and writes your files' }
    ],
    base: 'Reads your files'
  },
  mcp: {
    levels: [{ scope: 'mcp:tools.execute', phrase: 'Lists its tools and runs them' }],
    base: 'Lists its tools'
  }
};

const humanise = (value: string): string =>
  value
    .replaceAll('_', ' ')
    .replaceAll('.', ' ')
    .replace(/^./, (first) => first.toUpperCase());

/**
 * One sentence per family of access. In practice a connection has exactly one, but a box that grows
 * a new scope family must not answer with silence.
 */
export const connectorAccess = (scopes: readonly string[]): string => {
  const families = [...new Set(scopes.map((scope) => scope.split(':')[0] ?? ''))].filter(Boolean);
  if (!families.length) return 'No access granted';
  return families
    .map((family) => {
      const rule = accessRules[family];
      if (!rule)
        return `${humanise(family)}: ${scopes
          .filter((scope) => scope.startsWith(`${family}:`))
          .map((scope) => scope.slice(family.length + 1).replaceAll('.', ' '))
          .join(', ')}`;
      return rule.levels.find((level) => scopes.includes(level.scope))?.phrase ?? rule.base;
    })
    .join(' · ');
};

/**
 * The box's own statement about a connection, in the order the owner asks it.
 *
 * `GET /v1/connectors/catalog` has served `dataAccess`, `tokenLocation` and `providerLogging` on
 * every open of the connect screen and the screen rendered `requirements` and nothing else — so
 * "what leaves my computer, where does my token live, what does the other end keep" were three
 * written, served, per-connection answers that were invisible at the exact moment the owner was
 * typing a password into the form. Not paraphrased: this is the cost of using open protocols
 * instead of a provider sign-in, stated by the box that pays it.
 *
 * A box that predates a field simply says less, which is why the list is filtered rather than
 * padded — an empty sentence under a heading reads as a claim that there is nothing to say.
 */
export const connectorDisclosure = (
  definition:
    | Pick<ConnectorDefinition, 'requirements' | 'dataAccess' | 'tokenLocation' | 'providerLogging'>
    | undefined
): string[] =>
  definition
    ? [
        definition.requirements ?? '',
        definition.dataAccess && `What leaves this box: ${definition.dataAccess}`,
        definition.tokenLocation && `Where the credential lives: ${definition.tokenLocation}`,
        definition.providerLogging && `What the other end keeps: ${definition.providerLogging}`
      ].filter(Boolean)
    : [];

const operationPhrases: Record<string, string> = {
  calendar_create_event: 'Created an event',
  calendar_list: 'Listed calendars',
  calendar_read_range: 'Read the calendar',
  calendar_respond_invitation: 'Answered an invitation',
  calendar_update_event: 'Changed an event',
  connection_rechecked: 'Checked the connection',
  connection_verified: 'Connected',
  github_create_issue: 'Opened an issue',
  github_create_pull_request: 'Opened a pull request',
  github_list_issues: 'Listed issues',
  github_list_repositories: 'Listed repositories',
  github_read_file: 'Read a file',
  mail_draft: 'Saved a draft',
  mail_list_mailboxes: 'Listed mailboxes',
  mail_mark: 'Marked a message',
  mail_read_attachment: 'Read an attachment',
  mail_read_message: 'Read a message',
  mail_reply: 'Sent a reply',
  mail_search: 'Searched the mailbox',
  mail_send: 'Sent a message',
  mcp_call_tool: 'Ran a tool',
  mcp_list_tools: 'Listed tools',
  oauth_connection_verified: 'Connected',
  revoke: 'Disconnected',
  webdav_delete: 'Deleted a file',
  webdav_list: 'Listed files',
  webdav_read: 'Read a file',
  webdav_write: 'Wrote a file'
};

const outcomePhrases: Record<ConnectorAuditEvent['outcome'], string> = {
  succeeded: '',
  failed: 'failed',
  // The box refusing a call the owner never granted is the access choice working, not an error.
  denied: 'refused: not part of the access you granted'
};

/**
 * One recorded call, as a sentence: what was asked for, and what came back. The record deliberately
 * holds no request and no response, so the size and the duration are all there is to say about it.
 */
export const connectorCallLine = (
  entry: Pick<
    ConnectorAuditEvent,
    | 'operation'
    | 'outcome'
    | 'statusCode'
    | 'durationMs'
    | 'requestBytes'
    | 'responseBytes'
    | 'createdAt'
  >,
  formatBytes: (bytes: number) => string
): { action: string; detail: string } => {
  const when = new Date(entry.createdAt);
  return {
    action: operationPhrases[entry.operation] ?? humanise(entry.operation),
    detail: [
      outcomePhrases[entry.outcome],
      // A status code is only ever news when something went wrong; on a success it is 200.
      entry.outcome === 'succeeded' || entry.statusCode === null ? '' : `HTTP ${entry.statusCode}`,
      `${entry.durationMs} ms`,
      /*
       * Sent before back, because sent is the number this record exists for.
       *
       * The store has selected `requestBytes` all along and this line printed only the reply, so
       * `mail_send`, `webdav_write` and `mcp_call_tool` — the three calls that put the owner's
       * own content on somebody else's server — were recorded with the one figure that says
       * nothing about how much of it left. Each is omitted at zero rather than printed as "0 B",
       * since a send answers with nothing and a list asks for nothing.
       */
      entry.requestBytes > 0 ? `${formatBytes(entry.requestBytes)} sent` : '',
      entry.responseBytes > 0 ? `${formatBytes(entry.responseBytes)} back` : '',
      Number.isNaN(when.getTime()) ? '' : when.toLocaleString()
    ]
      .filter(Boolean)
      .join(' · ')
  };
};

/** The answer to a check, with the instant the box asked it, which is what the row keeps. */
export interface ConnectorCheck {
  ok: boolean;
  message: string;
  /** ISO, straight off `ConnectorTestResult.checkedAt`. */
  checkedAt: string;
}

/** Codes that mean the stored credential itself stopped being accepted, whoever else is at fault. */
const credentialCodes = new Set([
  'mail_authentication_unsupported',
  'connector_secret_invalid',
  'connector_secret_context',
  'connector_secret_update_failed'
]);

/**
 * Codes that mean nothing was reached at all, so nothing stored here is known to be wrong.
 *
 * Deliberately only two. `mail_connection_closed` and `mail_address_not_allowed` also mean the
 * conversation never happened, but neither is transient — the first is usually the wrong port and
 * the second is a host that does not resolve publicly — and telling the owner to try again later
 * would send them back to a screen that will refuse in exactly the same way.
 */
const unreachedCodes = new Set(['mail_timeout', 'connector_connection_failed']);

const RECONNECT =
  ' Disconnect it and connect it again: the credential this box has stored is no longer accepted.';
const RETRY =
  ' Nothing stored here changed, so this is worth asking again when the server is back.';

/**
 * What a failed check means, decided on the code rather than on the sentence.
 *
 * The message is written by the far end for a mailbox or a calendar and reads well on its own, but
 * GitHub and WebDAV refusals arrive as `connector_request_failed` carrying "Connector request
 * failed with status 401" (`packages/core/src/connectors.ts:409-415`) — the box's own internal
 * sentence, which answers nothing an owner asked. The code is the only field that separates the
 * one failure with a next move, "your token stopped working", from the one with none, "the server
 * was not reachable"; that is the whole decision this row can help with, so it is the only thing
 * inferred here.
 *
 * `mail_command_failed` is not in either set: on a check the commands run are the login and a
 * mailbox listing, but "the server refused a command" is not by itself a claim about the password,
 * so it is matched on what the server actually said instead of assumed.
 */
const checkNextMove = (failure: { code: string; message: string } | null | undefined): string => {
  if (!failure) return '';
  if (credentialCodes.has(failure.code)) return RECONNECT;
  if (unreachedCodes.has(failure.code)) return RETRY;
  if (failure.code === 'mail_command_failed')
    return /auth|login|credential|password|invalid user/i.test(failure.message) ? RECONNECT : '';
  if (failure.code === 'connector_request_failed' || failure.code === 'caldav_request_failed') {
    const status = Number(/(?:status|answered)\s+(\d{3})\b/.exec(failure.message)?.[1] ?? 0);
    return status === 401 || status === 403 ? RECONNECT : '';
  }
  return '';
};

/**
 * The answer to "is this still good", asked deliberately rather than found out by a task that
 * failed. A password changes, a server moves, an authorization expires; none of those announce
 * themselves, and the box has always been able to answer this and was never asked.
 */
export const connectorCheckMessage = (
  label: string,
  result: ConnectorTestResult
): ConnectorCheck =>
  result.ok
    ? {
        ok: true,
        checkedAt: result.checkedAt,
        message: result.accountLabel
          ? `${label} answered as ${result.accountLabel}.`
          : `${label} answered.`
      }
    : {
        ok: false,
        checkedAt: result.checkedAt,
        message: `${label} did not answer: ${
          result.failure?.message ?? 'the account refused the connection'
        }${checkNextMove(result.failure)}`
      };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * How long ago, in the words a person uses for it, with the clock passed in so the same second can
 * be asserted against.
 *
 * `timeAgo` in file-rows.ts is the same seven lines and is not imported: it sits behind
 * `timeline-state.ts`, which reaches the diff renderer, and this module carries no runtime import
 * at all — `formatBytes` is a parameter for exactly that reason. The connect screen is lazy and
 * would gain nothing from the edge, and the settings bundle would gain the whole timeline.
 */
const ago = (iso: string, nowMs: number): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const elapsed = Math.max(0, nowMs - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${plural(Math.floor(elapsed / MINUTE), 'minute')} ago`;
  if (elapsed < DAY) return `${plural(Math.floor(elapsed / HOUR), 'hour')} ago`;
  if (elapsed < 30 * DAY) return `${plural(Math.floor(elapsed / DAY), 'day')} ago`;
  return `on ${new Date(at).toLocaleDateString()}`;
};

/**
 * The line under a connected account that answers "is this one still live, and is it still good" —
 * the two questions the disconnect button needs answered and neither revocation screen could.
 *
 * "Reached" rather than "used", deliberately. `connectors.last_used_at` is stamped by the same
 * statement that writes an audit row (packages/data/src/store/connectors.ts:366-378), and that row
 * is written by connecting and by checking as well as by an agent action — the connect route even
 * hands back `lastUsedAt: new Date()` on creation. So the column answers "when did this credential
 * last touch the far end", which is exactly the question that matters before revoking it, and does
 * not answer "when did the agent last use it". Saying "last used" would have been a lie of the
 * quiet kind, and the check line beside it is what lets the owner see that the last reach was
 * their own check.
 *
 * The check is not read from a column: nothing stores one. It is recovered from the recorded
 * calls, which are the most recent thirty, so a connection with no check visible may simply have
 * thirty newer calls in front of it. That case says nothing rather than "never checked", because a
 * control that invents an absence is worse than one that is quiet.
 */
export const connectorStatusLine = (
  input: {
    lastUsedAt: string | null;
    check: { ok: boolean; checkedAt: string } | null;
  },
  nowMs: number
): string =>
  [
    input.lastUsedAt ? `Last reached ${ago(input.lastUsedAt, nowMs)}` : 'No calls recorded',
    input.check
      ? `${input.check.ok ? 'Checked' : 'Check failed'} ${ago(input.check.checkedAt, nowMs)}`
      : ''
  ]
    .filter(Boolean)
    .join(' · ');

/** The two operations that are a connection being asked whether it works, rather than being used. */
const checkOperations = new Set([
  'connection_rechecked',
  'connection_verified',
  'oauth_connection_verified'
]);

/**
 * When this connection was last asked whether it still works, taken from the record of the asking.
 *
 * The test route mints `checkedAt` and hands it back once; nothing stores it on the connector. But
 * the same route writes a `connection_rechecked` row either way, and connecting writes
 * `connection_verified`, so the answer survives a reload without a new column. The list is newest
 * first (`connector_audit_events ORDER BY created_at DESC`) and the newest is taken by comparison
 * rather than by position, because ordering is the server's business and this is one line.
 */
export const connectorLastCheck = (
  audit: readonly Pick<
    ConnectorAuditEvent,
    'connectorId' | 'operation' | 'outcome' | 'createdAt'
  >[],
  connectorId: string
): { ok: boolean; checkedAt: string } | null => {
  let newest: { ok: boolean; checkedAt: string } | null = null;
  for (const entry of audit) {
    if (entry.connectorId !== connectorId || !checkOperations.has(entry.operation)) continue;
    if (newest && !(entry.createdAt > newest.checkedAt)) continue;
    newest = { ok: entry.outcome === 'succeeded', checkedAt: entry.createdAt };
  }
  return newest;
};

/**
 * The line under a connection the owner has already disconnected, which is a row that stays.
 *
 * `revokeConnector` is a soft delete and `listConnectors` filters nothing, so the row comes back on
 * the very reload the disconnect handler runs. It used to come back looking live, over
 * `connectorStatusLine` above, which then read "Last reached just now" — a claim about somebody
 * else's server that nothing had touched. `recordConnectorAudit` stamps
 * `last_used_at=NOW(),updated_at=NOW()` beside every row it writes
 * (packages/data/src/store/connectors.ts:373-375) and the revocation route writes one, so the
 * column the sentence came from was measuring the revocation itself.
 *
 * `updatedAt` is that same stamp and is passed here on purpose: after a revocation it is the
 * instant of the revocation and stays there. Every other statement that writes to the row —
 * `updateConnectorSecret`, and every caller of `recordConnectorAudit` — resolves the connector
 * through `getConnector` first, which filters `enabled=TRUE`, so nothing can move it again. The
 * difference from `lastUsedAt` is not the number, it is what the sentence built on it claims.
 */
export const connectorRevokedLine = (revokedAt: string | null, nowMs: number): string => {
  const when = revokedAt ? ago(revokedAt, nowMs) : '';
  return `${
    when ? `Disconnected ${when}` : 'Disconnected'
  }. The credential this box had stored was destroyed, so nothing can use this connection. Connecting again asks for a new one.`;
};
