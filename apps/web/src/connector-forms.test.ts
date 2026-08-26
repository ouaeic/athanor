import { describe, expect, it } from 'vitest';
import { ApiFailure } from './api-failure.js';
import {
  calendarConnectFailure,
  calendarConnectRequest,
  connectActionLabel,
  connectReady,
  emptyCalendarForm,
  emptyMailForm,
  githubAccessChoices,
  githubScopes,
  mailConnectFailure,
  mailConnectRequest,
  splitHost,
  usesBrowserSignIn,
  webdavAccessChoices,
  webdavScopes,
  type CalendarConnectForm,
  type ConnectDraft,
  type MailConnectForm
} from './connector-forms.js';

const mailForm = (overrides: Partial<MailConnectForm> = {}): MailConnectForm => ({
  ...emptyMailForm(),
  address: 'jo@example.com',
  imapHost: 'imap.example.com',
  smtpHost: 'smtp.example.com',
  password: 'app-password',
  ...overrides
});

const calendarForm = (overrides: Partial<CalendarConnectForm> = {}): CalendarConnectForm => ({
  ...emptyCalendarForm(),
  url: 'https://cloud.example.com/remote.php/dav/',
  username: 'jo',
  password: 'app-password',
  address: 'jo@example.com',
  ...overrides
});

const endpoints = {
  imapHost: 'imap.example.com',
  imapPort: 993,
  smtpHost: 'smtp.example.com',
  smtpPort: 465
};

describe('splitHost', () => {
  it('takes a host however the provider’s help page wrote it', () => {
    expect(splitHost(' IMAP.Example.com ')).toEqual({ host: 'imap.example.com', port: '' });
    expect(splitHost('imaps://imap.example.com')).toEqual({ host: 'imap.example.com', port: '' });
    expect(splitHost('imap.example.com:143')).toEqual({ host: 'imap.example.com', port: '143' });
    expect(splitHost('https://imap.example.com/path')).toEqual({
      host: 'imap.example.com',
      port: ''
    });
  });
});

describe('mailConnectRequest', () => {
  it('builds the mailbox the API stores, with the ports that are not worth asking about', () => {
    expect(mailConnectRequest(mailForm(), 'Jo Bloggs')).toEqual({
      ok: true,
      endpoints: {
        imapHost: 'imap.example.com',
        imapPort: 993,
        smtpHost: 'smtp.example.com',
        smtpPort: 465
      },
      body: {
        kind: 'imap',
        label: 'jo@example.com',
        baseUrl: 'imaps://imap.example.com:993',
        username: 'jo@example.com',
        password: 'app-password',
        fromAddress: 'jo@example.com',
        fromName: 'Jo Bloggs',
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        scopes: ['mail:mailbox.read']
      }
    });
  });

  it('lets a port typed onto the host win, because that is the owner saying it', () => {
    const request = mailConnectRequest(mailForm({ imapHost: 'imap.example.com:1993' }), 'Jo');
    expect(request.ok && request.body.kind === 'imap' && request.body.baseUrl).toBe(
      'imaps://imap.example.com:1993'
    );
  });

  it('asks for sending capability only when the owner chose it', () => {
    const request = mailConnectRequest(mailForm({ access: 'send' }), 'Jo');
    expect(request.ok && request.body.scopes).toEqual([
      'mail:mailbox.read',
      'mail:message.write',
      'mail:message.send'
    ]);
  });

  it('keeps a username that differs from the address', () => {
    const request = mailConnectRequest(mailForm({ username: 'jo.bloggs' }), 'Jo');
    expect(request.ok && request.body.kind === 'imap' && request.body.username).toBe('jo.bloggs');
  });

  it('names the field that is wrong rather than sending it', () => {
    const refusal = (form: Partial<MailConnectForm>): string => {
      const request = mailConnectRequest(mailForm(form), 'Jo');
      return request.ok ? '' : request.message;
    };
    expect(refusal({ address: 'jo' })).toContain('email address');
    expect(refusal({ imapHost: 'imap' })).toContain('IMAP host');
    expect(refusal({ smtpPort: '' })).toContain('SMTP port');
    expect(refusal({ password: '' })).toContain('app password');
  });
});

describe('calendarConnectRequest', () => {
  it('builds the calendar the API stores', () => {
    expect(calendarConnectRequest(calendarForm({ access: 'write' }))).toEqual({
      ok: true,
      body: {
        kind: 'caldav',
        label: 'cloud.example.com',
        baseUrl: 'https://cloud.example.com/remote.php/dav/',
        username: 'jo',
        password: 'app-password',
        address: 'jo@example.com',
        scopes: ['calendar:calendars.read', 'calendar:events.write']
      }
    });
  });

  it('refuses the shapes the box would refuse, in words about the address', () => {
    const refusal = (form: Partial<CalendarConnectForm>): string => {
      const request = calendarConnectRequest(calendarForm(form));
      return request.ok ? '' : request.message;
    };
    expect(refusal({ url: 'cloud.example.com' })).toContain('https://');
    expect(refusal({ url: 'http://cloud.example.com/dav/' })).toContain('only connects');
    expect(refusal({ url: 'https://jo:pw@cloud.example.com/dav/' })).toContain(
      'username and password out'
    );
    expect(refusal({ url: 'https://cloud.example.com:8443/dav/' })).toContain('443');
    expect(refusal({ address: '' })).toContain('invitations are addressed to');
  });
});

describe('mailConnectFailure', () => {
  const fail = (code: string, message: string) => new ApiFailure(code, message, 400);

  it('tells a wrong port from a wrong password', () => {
    const wrongPort = mailConnectFailure(
      fail('connector_connection_failed', 'connect ECONNREFUSED 203.0.113.7:993'),
      endpoints
    );
    const wrongPassword = mailConnectFailure(
      fail(
        'mail_command_failed',
        'The IMAP server refused the command: NO [AUTHENTICATIONFAILED] Invalid credentials'
      ),
      endpoints
    );
    expect(wrongPort).toContain('refused the connection on port 993');
    expect(wrongPassword).toContain('refused that username and password');
    expect(wrongPort).not.toBe(wrongPassword);
  });

  it('names the submission host when the socket was dialling it', () => {
    expect(
      mailConnectFailure(
        fail('connector_connection_failed', 'connect ECONNREFUSED 203.0.113.7:465'),
        endpoints
      )
    ).toContain('smtp.example.com refused the connection on port 465');
  });

  it('says reading worked when only sending failed', () => {
    const sentence = mailConnectFailure(
      fail('mail_send_failed', 'The SMTP server answered 535: authentication failed'),
      endpoints
    );
    expect(sentence).toContain('Reading worked');
    expect(sentence).toContain('535');
  });

  it('reads a plaintext port answering a TLS connection as the wrong port', () => {
    expect(
      mailConnectFailure(
        fail(
          'connector_connection_failed',
          '4076:error:0A00010B:SSL routines:wrong version number'
        ),
        { ...endpoints, imapPort: 143 }
      )
    ).toContain('not with TLS');
  });

  it('separates a host that does not exist from a port that does not answer', () => {
    expect(
      mailConnectFailure(
        fail('connector_connection_failed', 'getaddrinfo ENOTFOUND imap.exmaple.com'),
        endpoints
      )
    ).toContain('no server called imap.exmaple.com');
    expect(mailConnectFailure(fail('mail_timeout', 'no answer'), endpoints)).toContain(
      'ran out of time'
    );
  });

  /*
   * Two bounds arrive under `mail_timeout`: a read that goes 30 seconds without a byte, and a
   * whole session that runs past five minutes however steadily it drips. The sentence said "within
   * 30 seconds", which is false for the second and sends a slow-server owner hunting a firewall.
   */
  it('covers both ways a mailbox runs out of time, not only the one that is 30 seconds', () => {
    const sentence = mailConnectFailure(
      fail(
        'mail_timeout',
        'The mail server did not finish within the time allowed for one session'
      ),
      endpoints
    );
    expect(sentence).toContain('30 seconds');
    expect(sentence).toContain('five minutes');
    expect(sentence).toContain('never finishes');
  });

  /* SMTP writes the reply code into two different sentences and the number matters in both. */
  it('reads the submission reply code out of either sentence SMTP writes it into', () => {
    expect(
      mailConnectFailure(
        fail('mail_send_failed', 'The SMTP server answered 535: authentication failed'),
        endpoints
      )
    ).toContain('with 535');
    expect(
      mailConnectFailure(
        fail('mail_send_failed', 'The SMTP server refused the message with 550: relay denied'),
        endpoints
      )
    ).toContain('with 550');
  });

  it('says a mailbox that only offers a provider sign-in cannot be connected', () => {
    expect(
      mailConnectFailure(
        fail(
          'mail_authentication_unsupported',
          'The IMAP server offers no password authentication athanor can use'
        ),
        endpoints
      )
    ).toContain('cannot be connected here');
  });

  it('keeps the network sentence when the box itself is unreachable', () => {
    const dropped = new TypeError('Failed to fetch');
    expect(mailConnectFailure(dropped, endpoints)).toContain('not reachable right now');
  });
});

/*
 * The three scopes the box enforces, catalogues and describes in its own GitHub blurb — "create
 * issues or pull requests when explicitly granted" — and that no client could explicitly grant.
 * POST /v1/connectors filters the requested list against the catalogue for the kind, so a scope
 * that does not belong to the connector is refused rather than quietly dropped; every string here
 * is asserted against the same table the agent's scope gate reads.
 */
describe('what a GitHub or WebDAV connection is allowed to do', () => {
  it('grants nothing that writes when the owner asked to read', () => {
    expect(githubScopes('read')).toEqual([
      'github:profile.read',
      'github:repository.read',
      'github:issues.read'
    ]);
    expect(webdavScopes('read')).toEqual(['webdav:files.read']);
  });

  it('can produce the issue scope, which nothing in this client could send before', () => {
    expect(githubScopes('issues')).toContain('github:issues.write');
    expect(githubScopes('issues')).not.toContain('github:pull_requests.write');
  });

  /* GitHub treats a pull request as an issue with a branch, so one without the other cannot
     comment on the thing it just opened. */
  it('carries the issue scope along with the pull request scope, never on its own', () => {
    expect(githubScopes('pull_requests')).toContain('github:pull_requests.write');
    expect(githubScopes('pull_requests')).toContain('github:issues.write');
  });

  it('reaches webdav_delete, the third gated operation with no control anywhere', () => {
    expect(webdavScopes('write')).toEqual(['webdav:files.read', 'webdav:files.write']);
    expect(webdavScopes('delete')).toEqual([
      'webdav:files.read',
      'webdav:files.write',
      'webdav:files.delete'
    ]);
  });

  /*
   * The copy and the grant sit in the same file so they cannot drift, and this is the assertion
   * that keeps them there: a level the owner can pick with no sentence describing it is exactly
   * the lying control this work exists to remove, only inverted.
   */
  it('has a sentence for every level a connection can be granted, and no spare ones', () => {
    expect(githubAccessChoices.map((choice) => choice.level)).toEqual([
      'read',
      'issues',
      'pull_requests'
    ]);
    expect(webdavAccessChoices.map((choice) => choice.level)).toEqual(['read', 'write', 'delete']);
    for (const choice of [...githubAccessChoices, ...webdavAccessChoices]) {
      expect(choice.title).not.toBe('');
      expect(choice.detail).not.toBe('');
    }
  });

  it('warns that deleting a file is the file service to answer for, not athanor', () => {
    expect(webdavAccessChoices.at(-1)?.detail).toContain('recovered');
  });

  /* Reading is always granted: a connection that may open an issue and not find the repository
     is not a thing anybody asked for. */
  it('always grants reading, at every level', () => {
    for (const scopes of [
      githubScopes('read'),
      githubScopes('issues'),
      githubScopes('pull_requests')
    ])
      expect(scopes).toContain('github:repository.read');
    for (const scopes of [webdavScopes('read'), webdavScopes('write'), webdavScopes('delete')])
      expect(scopes).toContain('webdav:files.read');
  });
});

describe('calendarConnectFailure', () => {
  const url = 'https://cloud.example.com/remote.php/dav/';

  it('tells a rejected password from an address with nothing behind it', () => {
    expect(
      calendarConnectFailure(
        new ApiFailure('caldav_request_failed', 'The calendar server answered 401', 400),
        url
      )
    ).toContain('refused that username and password');
    expect(
      calendarConnectFailure(
        new ApiFailure('caldav_request_failed', 'The calendar server answered 404', 400),
        url
      )
    ).toContain('nothing at that address');
  });

  it('explains a sign-in that worked but found no calendars', () => {
    expect(
      calendarConnectFailure(
        new ApiFailure(
          'calendar_none_found',
          'That address answered, but no calendars were found on it',
          400
        ),
        url
      )
    ).toContain('calendar home');
  });
});

const draft = (overrides: Partial<ConnectDraft> = {}): ConnectDraft => ({
  kind: 'imap',
  mail: mailForm(),
  calendar: calendarForm(),
  token: '',
  url: '',
  username: '',
  password: '',
  mcpAuth: 'oauth_dynamic',
  clientId: '',
  githubAccess: 'read',
  webdavAccess: 'write',
  ...overrides
});

describe('when the connect button will do anything at all', () => {
  it('waits for the four facts a mailbox cannot be opened without', () => {
    expect(connectReady(draft())).toBe(true);
    expect(connectReady(draft({ mail: mailForm({ smtpHost: '' }) }))).toBe(false);
    expect(connectReady(draft({ mail: mailForm({ password: '' }) }))).toBe(false);
  });

  it('does not require a username, because most providers sign in with the address', () => {
    expect(connectReady(draft({ mail: mailForm({ username: '' }) }))).toBe(true);
  });

  it('wants the address invitations are sent to before connecting a calendar', () => {
    expect(connectReady(draft({ kind: 'caldav' }))).toBe(true);
    expect(connectReady(draft({ kind: 'caldav', calendar: calendarForm({ address: '' }) }))).toBe(
      false
    );
  });

  it('asks a token connection for its token and nothing else', () => {
    expect(connectReady(draft({ kind: 'github' }))).toBe(false);
    expect(connectReady(draft({ kind: 'github', token: 'ghp_x' }))).toBe(true);
  });

  it('asks WebDAV for all three, since none of them has a default', () => {
    expect(connectReady(draft({ kind: 'webdav', url: 'https://x/dav', username: 'jo' }))).toBe(
      false
    );
    expect(
      connectReady(
        draft({ kind: 'webdav', url: 'https://x/dav', username: 'jo', password: 'secret' })
      )
    ).toBe(true);
  });

  /* Each MCP sign-in method needs a different second field, and browser sign-in needs none. */
  it('asks a tool server only for what its chosen sign-in actually needs', () => {
    expect(connectReady(draft({ kind: 'mcp_http', url: 'https://tools.example/mcp' }))).toBe(true);
    expect(connectReady(draft({ kind: 'mcp_http', mcpAuth: 'none' }))).toBe(false);
    expect(
      connectReady(draft({ kind: 'mcp_http', url: 'https://tools.example/mcp', mcpAuth: 'none' }))
    ).toBe(true);
    expect(
      connectReady(draft({ kind: 'mcp_http', url: 'https://tools.example/mcp', mcpAuth: 'bearer' }))
    ).toBe(false);
    expect(
      connectReady(
        draft({ kind: 'mcp_http', url: 'https://tools.example/mcp', mcpAuth: 'bearer', token: 't' })
      )
    ).toBe(true);
    expect(
      connectReady(
        draft({ kind: 'mcp_http', url: 'https://tools.example/mcp', mcpAuth: 'oauth_static' })
      )
    ).toBe(false);
  });

  it('knows which connections open a browser window rather than reading a field', () => {
    expect(usesBrowserSignIn(draft({ kind: 'mcp_http', mcpAuth: 'oauth_static' }))).toBe(true);
    expect(usesBrowserSignIn(draft({ kind: 'mcp_http', mcpAuth: 'bearer' }))).toBe(false);
    expect(usesBrowserSignIn(draft({ kind: 'imap' }))).toBe(false);
  });
});

describe('what the connect button says it is about to do', () => {
  it('says it tests first where the box actually does test first', () => {
    expect(connectActionLabel(draft(), false)).toBe('Test and connect');
    expect(connectActionLabel(draft({ kind: 'caldav' }), false)).toBe('Test and connect');
    expect(connectActionLabel(draft({ kind: 'github' }), false)).toBe('Connect');
  });

  it('says a browser window is about to open', () => {
    expect(connectActionLabel(draft({ kind: 'mcp_http' }), false)).toBe('Sign in and connect');
  });

  it('reports the wait, which on a mailbox is a real one', () => {
    expect(connectActionLabel(draft(), true)).toBe('Testing the connection…');
  });
});
