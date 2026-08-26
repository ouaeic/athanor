import { describe, expect, it } from 'vitest';
import {
  connectorAccess,
  connectorCallLine,
  connectorCheckMessage,
  connectorDisclosure,
  connectorLastCheck,
  connectorStatusLine
} from './connector-access.js';
import { formatBytes } from './timeline-state.js';

describe('what a connected account is allowed to do', () => {
  /*
   * The connect form asks one question — read only, or read and write — and the list underneath
   * answered with the stored scope ids, which is the answer to a different question entirely.
   */
  it('echoes the choice the owner actually made for a mailbox', () => {
    expect(connectorAccess(['mail:mailbox.read'])).toBe('Reads your mail');
    expect(connectorAccess(['mail:mailbox.read', 'mail:message.write', 'mail:message.send'])).toBe(
      'Reads your mail, and sends messages as you'
    );
  });

  it('does not claim sending for a mailbox that may only file and draft', () => {
    expect(connectorAccess(['mail:mailbox.read', 'mail:message.write'])).toBe(
      'Reads your mail, and saves drafts and marks messages'
    );
  });

  it('separates a calendar it may write from one it may only read', () => {
    expect(connectorAccess(['calendar:calendars.read'])).toBe('Reads your calendar');
    expect(connectorAccess(['calendar:calendars.read', 'calendar:events.write'])).toBe(
      'Reads your calendar, and creates events and answers invitations'
    );
  });

  /* The three scopes the connect form could not grant until this wave, said back to the owner. */
  it('separates the three levels of GitHub access the connect form can now grant', () => {
    const read = ['github:profile.read', 'github:repository.read', 'github:issues.read'];
    expect(connectorAccess(read)).toBe('Reads your repositories and issues');
    expect(connectorAccess([...read, 'github:issues.write'])).toBe(
      'Reads your repositories, and opens issues'
    );
    expect(connectorAccess([...read, 'github:issues.write', 'github:pull_requests.write'])).toBe(
      'Reads your repositories, and opens issues and pull requests'
    );
  });

  it('says the most permissive true thing, not the first one it finds', () => {
    expect(
      connectorAccess(['webdav:files.read', 'webdav:files.write', 'webdav:files.delete'])
    ).toBe('Reads, writes and deletes your files');
    expect(connectorAccess(['webdav:files.read', 'webdav:files.write'])).toBe(
      'Reads and writes your files'
    );
  });

  it('distinguishes a tool server that may run tools from one that may only list them', () => {
    expect(connectorAccess(['mcp:tools.read'])).toBe('Lists its tools');
    expect(connectorAccess(['mcp:tools.read', 'mcp:tools.execute'])).toBe(
      'Lists its tools and runs them'
    );
  });

  it('stays readable for a scope family this client has never heard of', () => {
    expect(connectorAccess(['notion:pages.read'])).toBe('Notion: pages read');
  });

  it('says plainly when nothing was granted rather than showing an empty line', () => {
    expect(connectorAccess([])).toBe('No access granted');
  });
});

describe('the record of what the agent did with them', () => {
  const entry = {
    operation: 'mail_send',
    outcome: 'succeeded' as const,
    statusCode: 250,
    durationMs: 812,
    requestBytes: 4_200,
    responseBytes: 1_500,
    createdAt: '2026-08-01T09:00:00.000Z'
  };

  it('says what was done rather than printing the stored action name', () => {
    expect(connectorCallLine(entry, formatBytes).action).toBe('Sent a message');
    expect(
      connectorCallLine({ ...entry, operation: 'calendar_respond_invitation' }, formatBytes).action
    ).toBe('Answered an invitation');
  });

  it('still reads as English for an operation added after this client', () => {
    expect(connectorCallLine({ ...entry, operation: 'notion_read_page' }, formatBytes).action).toBe(
      'Notion read page'
    );
  });

  /* A status code on a call that worked is 200, every time, in a list of thirty rows. */
  it('leaves the status code out of a call that worked, and keeps it on one that did not', () => {
    expect(connectorCallLine(entry, formatBytes).detail).not.toContain('HTTP');
    expect(
      connectorCallLine({ ...entry, outcome: 'failed', statusCode: 535 }, formatBytes).detail
    ).toContain('HTTP 535');
  });

  it('explains a refusal as the access choice working rather than as an error', () => {
    expect(connectorCallLine({ ...entry, outcome: 'denied' }, formatBytes).detail).toContain(
      'not part of the access you granted'
    );
  });

  it('reports the size that came back, and says nothing when nothing did', () => {
    expect(connectorCallLine(entry, formatBytes).detail).toContain('1.5 KB back');
    expect(connectorCallLine({ ...entry, responseBytes: 0 }, formatBytes).detail).not.toContain(
      'back'
    );
  });

  /*
   * The exfiltration-relevant figure, and the one the line left out. `mail_send`, `webdav_write`
   * and `mcp_call_tool` all answer with almost nothing and carry the owner's content outbound, so
   * a record showing only the reply described the least interesting half of the call.
   */
  it('reports how much left the box, ahead of how much came back', () => {
    const detail = connectorCallLine(entry, formatBytes).detail;
    expect(detail).toContain('4.2 KB sent');
    expect(detail.indexOf('sent')).toBeLessThan(detail.indexOf('back'));
  });

  it('says nothing about a request that carried no body, rather than "0 B sent"', () => {
    expect(
      connectorCallLine(
        { ...entry, operation: 'mail_list_mailboxes', requestBytes: 0 },
        formatBytes
      ).detail
    ).not.toContain('sent');
  });
});

describe('asking an account whether it still works', () => {
  const result = {
    connectorId: '00000000-0000-4000-8000-000000000001',
    accountLabel: null,
    checkedAt: '2026-08-01T09:00:00.000Z'
  };

  it('names the account the credential actually reached', () => {
    expect(
      connectorCheckMessage('Work mail', {
        ...result,
        ok: true,
        accountLabel: 'you@example.com',
        failure: null
      })
    ).toEqual({
      ok: true,
      checkedAt: '2026-08-01T09:00:00.000Z',
      message: 'Work mail answered as you@example.com.'
    });
  });

  it('carries what the far end said, which is the whole point of asking', () => {
    expect(
      connectorCheckMessage('Work mail', {
        ...result,
        ok: false,
        failure: { code: 'mail_command_failed', message: 'imap.example.com refused the password' }
      })
    ).toEqual({
      ok: false,
      checkedAt: '2026-08-01T09:00:00.000Z',
      message:
        'Work mail did not answer: imap.example.com refused the password Disconnect it and connect it again: the credential this box has stored is no longer accepted.'
    });
  });

  /*
   * The whole reason the code is read at all. A GitHub token that expired comes back as
   * `connector_request_failed` carrying the box's own internal sentence, which tells the owner
   * nothing about what to do with the connection in front of them.
   */
  it('turns an expired token into the one instruction that fixes it', () => {
    expect(
      connectorCheckMessage('GitHub', {
        ...result,
        ok: false,
        failure: {
          code: 'connector_request_failed',
          message: 'Connector request failed with status 401'
        }
      }).message
    ).toContain('Disconnect it and connect it again');
  });

  it('does not tell the owner to reconnect over a server that answered at all', () => {
    expect(
      connectorCheckMessage('Files', {
        ...result,
        ok: false,
        failure: {
          code: 'connector_request_failed',
          message: 'Connector request failed with status 503'
        }
      }).message
    ).not.toContain('Disconnect it');
  });

  it('says a credential that was never reached is not known to be wrong', () => {
    expect(
      connectorCheckMessage('Work mail', {
        ...result,
        ok: false,
        failure: { code: 'mail_timeout', message: 'The mail server did not answer in time' }
      }).message
    ).toContain('Nothing stored here changed');
  });

  /* "The server refused a command" is not by itself a claim about the password. */
  it('stays quiet about the credential when the refusal was not about signing in', () => {
    const message = connectorCheckMessage('Work mail', {
      ...result,
      ok: false,
      failure: { code: 'mail_command_failed', message: 'The IMAP server refused SELECT' }
    }).message;
    expect(message).toContain('refused SELECT');
    expect(message).not.toContain('Disconnect it');
  });

  it('hands back the instant the box asked, so the row can say when', () => {
    expect(
      connectorCheckMessage('Work mail', { ...result, ok: true, failure: null }).checkedAt
    ).toBe('2026-08-01T09:00:00.000Z');
  });
});

describe('whether a connected account is worth keeping', () => {
  const now = Date.parse('2026-08-01T12:00:00.000Z');

  /*
   * The two revocation screens could not tell a live credential from a dormant one, so the only
   * safe move was to keep everything. `lastUsedAt` has been served on every connector all along.
   */
  it('says how long ago the credential last touched the far end', () => {
    expect(connectorStatusLine({ lastUsedAt: '2026-07-30T12:00:00.000Z', check: null }, now)).toBe(
      'Last reached 2 days ago'
    );
    expect(connectorStatusLine({ lastUsedAt: '2026-08-01T11:59:30.000Z', check: null }, now)).toBe(
      'Last reached just now'
    );
  });

  /*
   * "Reached", not "used". The same statement that writes an audit row stamps the column, and
   * connecting and checking both write one — the connect route even hands back a `lastUsedAt` of
   * now on creation. Claiming the agent used it would be false on every connection the owner has
   * merely tested, which is the quiet kind of lie this wave exists to remove.
   */
  it('does not claim the agent used a credential the column cannot speak for', () => {
    expect(
      connectorStatusLine({ lastUsedAt: '2026-07-30T12:00:00.000Z', check: null }, now)
    ).not.toContain('used');
  });

  it('says plainly that no call has been recorded at all', () => {
    expect(connectorStatusLine({ lastUsedAt: null, check: null }, now)).toBe('No calls recorded');
  });

  it('adds when it was last verified, and whether the answer was yes', () => {
    expect(
      connectorStatusLine(
        {
          lastUsedAt: '2026-07-30T12:00:00.000Z',
          check: { ok: true, checkedAt: '2026-08-01T09:00:00.000Z' }
        },
        now
      )
    ).toBe('Last reached 2 days ago · Checked 3 hours ago');
    expect(
      connectorStatusLine(
        { lastUsedAt: null, check: { ok: false, checkedAt: '2026-08-01T09:00:00.000Z' } },
        now
      )
    ).toBe('No calls recorded · Check failed 3 hours ago');
  });

  /*
   * The audit list is the most recent thirty calls, so a connection with no check among them may
   * simply have thirty newer calls in front of it. Inventing "never checked" out of that would be
   * a sentence the owner could act on and the box cannot support.
   */
  it('says nothing about checking rather than claiming a check that may be off the list', () => {
    expect(connectorStatusLine({ lastUsedAt: null, check: null }, now)).not.toContain('Checked');
  });
});

describe('when a connection was last asked whether it works', () => {
  const audit = [
    {
      connectorId: 'a',
      operation: 'mail_read_message',
      outcome: 'succeeded' as const,
      createdAt: '2026-08-01T11:00:00.000Z'
    },
    {
      connectorId: 'a',
      operation: 'connection_rechecked',
      outcome: 'failed' as const,
      createdAt: '2026-08-01T10:00:00.000Z'
    },
    {
      connectorId: 'a',
      operation: 'connection_verified',
      outcome: 'succeeded' as const,
      createdAt: '2026-07-01T10:00:00.000Z'
    },
    {
      connectorId: 'b',
      operation: 'connection_rechecked',
      outcome: 'succeeded' as const,
      createdAt: '2026-08-01T11:30:00.000Z'
    }
  ];

  /* The test route stores no `checkedAt`, but it writes a row either way, so the answer survives. */
  it('reads the answer back out of the recorded calls, which outlive the reply', () => {
    expect(connectorLastCheck(audit, 'a')).toEqual({
      ok: false,
      checkedAt: '2026-08-01T10:00:00.000Z'
    });
  });

  it('never reports the check on one connection as the check on another', () => {
    expect(connectorLastCheck(audit, 'b')).toEqual({
      ok: true,
      checkedAt: '2026-08-01T11:30:00.000Z'
    });
    expect(connectorLastCheck(audit, 'c')).toBeNull();
  });

  it('counts connecting as a verification, because it is the same verification', () => {
    expect(
      connectorLastCheck(
        audit.filter((entry) => entry.operation !== 'connection_rechecked'),
        'a'
      )
    ).toEqual({ ok: true, checkedAt: '2026-07-01T10:00:00.000Z' });
  });

  /* Ordering is the server's business; taking the newest by comparison is one line. */
  it('takes the newest check rather than the first one it walks past', () => {
    expect(connectorLastCheck([...audit].reverse(), 'a')?.checkedAt).toBe(
      '2026-08-01T10:00:00.000Z'
    );
  });
});

/*
 * Three sentences the box writes about every connection, serves on every open of the connect
 * screen, and never showed — at the exact moment the owner is typing a password into the form.
 */
describe("the box's own statement about a connection", () => {
  const github = {
    requirements: 'A fine-grained personal access token.',
    dataAccess: 'Only the selected account and repository capabilities are sent to GitHub.',
    tokenLocation: 'Encrypted in the athanor control-plane secret store.',
    providerLogging: 'GitHub may retain API metadata under the connected account policy.'
  };

  it('answers the three questions in the order the owner asks them', () => {
    expect(connectorDisclosure(github)).toEqual([
      'A fine-grained personal access token.',
      'What leaves this box: Only the selected account and repository capabilities are sent to GitHub.',
      'Where the credential lives: Encrypted in the athanor control-plane secret store.',
      'What the other end keeps: GitHub may retain API metadata under the connected account policy.'
    ]);
  });

  /* The catalogue is fetched, so there is a paint before it arrives, and an older box may never
     send some of it. Neither may produce a labelled line with nothing after the colon. */
  it('says nothing at all rather than a heading with nothing under it', () => {
    expect(connectorDisclosure(undefined)).toEqual([]);
    expect(connectorDisclosure({ ...github, tokenLocation: '' })).not.toContain(
      'Where the credential lives: '
    );
  });

  it('keeps the requirements line the screen already had, ahead of the rest', () => {
    expect(connectorDisclosure(github)[0]).toBe('A fine-grained personal access token.');
    const { requirements: _unstated, ...older } = github;
    expect(connectorDisclosure(older)).toHaveLength(3);
  });
});
