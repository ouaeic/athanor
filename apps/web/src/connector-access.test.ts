import { describe, expect, it } from 'vitest';
import { connectorAccess, connectorCallLine, connectorCheckMessage } from './connector-access.js';
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
});

describe('asking an account whether it still works', () => {
  it('names the account the credential actually reached', () => {
    expect(
      connectorCheckMessage('Work mail', {
        connectorId: '00000000-0000-4000-8000-000000000001',
        ok: true,
        accountLabel: 'you@example.com',
        checkedAt: '2026-08-01T09:00:00.000Z',
        failure: null
      })
    ).toEqual({ ok: true, message: 'Work mail answered as you@example.com.' });
  });

  it('carries what the far end said, which is the whole point of asking', () => {
    expect(
      connectorCheckMessage('Work mail', {
        connectorId: '00000000-0000-4000-8000-000000000001',
        ok: false,
        accountLabel: null,
        checkedAt: '2026-08-01T09:00:00.000Z',
        failure: { code: 'mail_command_failed', message: 'imap.example.com refused the password' }
      })
    ).toEqual({
      ok: false,
      message: 'Work mail did not answer: imap.example.com refused the password'
    });
  });
});
