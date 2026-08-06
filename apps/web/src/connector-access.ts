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
    'operation' | 'outcome' | 'statusCode' | 'durationMs' | 'responseBytes' | 'createdAt'
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
      // Sending a message answers with nothing at all, and "0 B back" says less than silence.
      entry.responseBytes > 0 ? `${formatBytes(entry.responseBytes)} back` : '',
      Number.isNaN(when.getTime()) ? '' : when.toLocaleString()
    ]
      .filter(Boolean)
      .join(' · ')
  };
};

/**
 * The answer to "is this still good", asked deliberately rather than found out by a task that
 * failed. A password changes, a server moves, an authorization expires; none of those announce
 * themselves, and the box has always been able to answer this and was never asked.
 */
export const connectorCheckMessage = (
  label: string,
  result: ConnectorTestResult
): { ok: boolean; message: string } =>
  result.ok
    ? {
        ok: true,
        message: result.accountLabel
          ? `${label} answered as ${result.accountLabel}.`
          : `${label} answered.`
      }
    : {
        ok: false,
        message: `${label} did not answer: ${result.failure?.message ?? 'the account refused the connection'}`
      };
