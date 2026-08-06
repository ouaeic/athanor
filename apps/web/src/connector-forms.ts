/**
 * The two connect forms that are not a single token field: a mailbox and a calendar.
 *
 * Both are held here rather than in the screen because connecting one is the only place in athanor
 * where the owner types six facts about somebody else's server and gets one answer back. What that
 * answer says is the whole feature: a wrong port and a wrong password arrive as different failures
 * and must read as different failures, or the owner's next move is to retype the password until
 * they give up.
 */
import type { ConnectorScope, CreateConnectorRequest } from '@athanor/contracts';
import { isTransportFailure } from './failure-text.js';

type MailAccess = 'read' | 'send';
type CalendarAccess = 'read' | 'write';

/**
 * Everything the connect screen can be pointed at. A mailbox and a calendar are first because they
 * are what most work needs; the other three are a URL and a credential.
 */
export const connectorKinds = [
  { id: 'imap', label: 'Mailbox (IMAP and SMTP)' },
  { id: 'caldav', label: 'Calendar (CalDAV)' },
  { id: 'github', label: 'GitHub token' },
  { id: 'webdav', label: 'WebDAV files' },
  { id: 'mcp_http', label: 'MCP tool server' }
] as const;

export type ConnectorKind = (typeof connectorKinds)[number]['id'];
export type McpAuthMode = 'oauth_dynamic' | 'oauth_static' | 'bearer' | 'none';

export interface MailConnectForm {
  label: string;
  address: string;
  imapHost: string;
  /** Ports are held as typed: an emptied number input is '', which is not a number. */
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  username: string;
  password: string;
  access: MailAccess;
}

export interface CalendarConnectForm {
  label: string;
  url: string;
  username: string;
  password: string;
  address: string;
  access: CalendarAccess;
}

/** Ports the owner should not have to know, and the only ones athanor connects on by default. */
const DEFAULT_IMAP_PORT = '993';
const DEFAULT_SMTP_PORT = '465';

export const emptyMailForm = (): MailConnectForm => ({
  label: '',
  address: '',
  imapHost: '',
  imapPort: DEFAULT_IMAP_PORT,
  smtpHost: '',
  smtpPort: DEFAULT_SMTP_PORT,
  username: '',
  password: '',
  access: 'read'
});

export const emptyCalendarForm = (): CalendarConnectForm => ({
  label: '',
  url: '',
  username: '',
  password: '',
  address: '',
  access: 'read'
});

/** Everything the connect screen holds, so what the button does is one decision in one place. */
export interface ConnectDraft {
  kind: ConnectorKind;
  mail: MailConnectForm;
  calendar: CalendarConnectForm;
  /** GitHub's fine-grained token, or an MCP bearer token. */
  token: string;
  /** The WebDAV or MCP address. */
  url: string;
  username: string;
  password: string;
  mcpAuth: McpAuthMode;
  clientId: string;
}

/** Whether this connection is made by signing in through a browser window rather than by a field. */
export const usesBrowserSignIn = (draft: Pick<ConnectDraft, 'kind' | 'mcpAuth'>): boolean =>
  draft.kind === 'mcp_http' &&
  (draft.mcpAuth === 'oauth_dynamic' || draft.mcpAuth === 'oauth_static');

/**
 * Whether there is enough on the form to be worth sending. Deliberately shallow — it asks only
 * whether the required fields have something in them. Whether that something is a hostname or a
 * calendar home is decided by the two request builders below, which can say why.
 */
export const connectReady = (draft: ConnectDraft): boolean => {
  if (draft.kind === 'imap')
    return Boolean(
      draft.mail.address && draft.mail.imapHost && draft.mail.smtpHost && draft.mail.password
    );
  if (draft.kind === 'caldav')
    return Boolean(
      draft.calendar.url &&
      draft.calendar.username &&
      draft.calendar.password &&
      draft.calendar.address
    );
  if (draft.kind === 'github') return Boolean(draft.token);
  if (draft.kind === 'webdav') return Boolean(draft.url && draft.username && draft.password);
  if (!draft.url) return false;
  if (draft.mcpAuth === 'bearer') return Boolean(draft.token);
  return draft.mcpAuth !== 'oauth_static' || Boolean(draft.clientId);
};

/**
 * What the one button says it is about to do. A mailbox and a calendar are verified against the
 * real server before anything is stored, so the button both tests and connects and says so.
 */
export const connectActionLabel = (draft: ConnectDraft, testing: boolean): string => {
  if (testing) return 'Testing the connection…';
  if (usesBrowserSignIn(draft)) return 'Sign in and connect';
  return draft.kind === 'imap' || draft.kind === 'caldav' ? 'Test and connect' : 'Connect';
};

/*
 * The body is typed against the contract the box parses rather than as a bag of fields: a mailbox
 * is nine of them and a renamed one would otherwise fail as a 400 nobody could read.
 */
type ConnectRequest = { ok: true; body: CreateConnectorRequest } | { ok: false; message: string };

interface MailEndpoints {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/** The request plus the two endpoints it resolved to, which is what a failure has to be read against. */
type MailConnectResult =
  | { ok: true; body: CreateConnectorRequest; endpoints: MailEndpoints }
  | { ok: false; message: string };

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * A host as the owner is likely to have it on the clipboard.
 *
 * Provider help pages write the IMAP server as `imap.fastmail.com`, as `imaps://imap.fastmail.com`
 * and as `imap.fastmail.com:993`, and all three mean the same server. Rejecting two of them teaches
 * nothing; the port travelling with the host is kept, because that is the owner saying it.
 */
export const splitHost = (raw: string): { host: string; port: string } => {
  const trimmed = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const bare = trimmed.replace(/\/.*$/, '');
  const withPort = /^(.+):(\d{1,5})$/.exec(bare);
  return withPort
    ? { host: withPort[1]!.toLowerCase(), port: withPort[2]! }
    : { host: bare.toLowerCase(), port: '' };
};

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const portNumber = (value: string): number | undefined => {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
};

const mailScopes = (access: MailAccess): ConnectorScope[] =>
  access === 'read'
    ? ['mail:mailbox.read']
    : ['mail:mailbox.read', 'mail:message.write', 'mail:message.send'];

const calendarScopes = (access: CalendarAccess): ConnectorScope[] =>
  access === 'read'
    ? ['calendar:calendars.read']
    : ['calendar:calendars.read', 'calendar:events.write'];

/**
 * @param ownerName the display name this athanor already knows the owner by, so mail goes out as a
 * person rather than as an address without ever asking for the name a second time.
 */
export const mailConnectRequest = (form: MailConnectForm, ownerName: string): MailConnectResult => {
  const address = form.address.trim();
  if (!ADDRESS.test(address))
    return { ok: false, message: 'Enter the email address this mailbox sends and receives as.' };
  const imap = splitHost(form.imapHost);
  const smtp = splitHost(form.smtpHost);
  if (!HOSTNAME.test(imap.host))
    return {
      ok: false,
      message: 'The IMAP host is the server name your provider publishes, like imap.example.com.'
    };
  if (!HOSTNAME.test(smtp.host))
    return {
      ok: false,
      message:
        'The SMTP submission host is the server name your provider publishes for sending, like smtp.example.com.'
    };
  const imapPort = portNumber(imap.port || form.imapPort);
  const smtpPort = portNumber(smtp.port || form.smtpPort);
  if (!imapPort) return { ok: false, message: 'The IMAP port is a number, and is usually 993.' };
  if (!smtpPort) return { ok: false, message: 'The SMTP port is a number, and is usually 465.' };
  const password = form.password;
  if (!password) return { ok: false, message: 'The app password for this mailbox is missing.' };
  const name = ownerName.trim();
  return {
    ok: true,
    endpoints: { imapHost: imap.host, imapPort, smtpHost: smtp.host, smtpPort },
    body: {
      kind: 'imap',
      label: form.label.trim() || address,
      baseUrl: `imaps://${imap.host}:${imapPort}`,
      // Most providers sign in with the address itself, so an empty username means that, rather
      // than a field the owner has to fill in with what they just typed one line above.
      username: form.username.trim() || address,
      password,
      fromAddress: address,
      ...(name ? { fromName: name } : {}),
      smtpHost: smtp.host,
      smtpPort,
      scopes: mailScopes(form.access)
    }
  };
};

export const calendarConnectRequest = (form: CalendarConnectForm): ConnectRequest => {
  const raw = form.url.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      message:
        'Paste the whole CalDAV address, starting with https:// — for example https://cloud.example.com/remote.php/dav/'
    };
  }
  if (url.protocol !== 'https:')
    return { ok: false, message: 'athanor only connects to a calendar over https.' };
  if (url.username || url.password)
    return {
      ok: false,
      message:
        'Leave the username and password out of the address; they go in the two fields below.'
    };
  if (url.port && url.port !== '443')
    return { ok: false, message: 'athanor connects to a calendar on port 443 only.' };
  const address = form.address.trim();
  if (!ADDRESS.test(address))
    return {
      ok: false,
      message: 'Enter the email address invitations are addressed to, so athanor can find you.'
    };
  if (!form.username.trim()) return { ok: false, message: 'The calendar username is missing.' };
  if (!form.password)
    return { ok: false, message: 'The app password for this calendar is missing.' };
  return {
    ok: true,
    body: {
      kind: 'caldav',
      label: form.label.trim() || url.hostname,
      // The hash is dropped rather than refused: it is never part of a CalDAV collection.
      baseUrl: `${url.origin}${url.pathname}${url.search}`,
      username: form.username.trim(),
      password: form.password,
      address,
      scopes: calendarScopes(form.access)
    }
  };
};

const failure = (cause: unknown): { code: string; message: string } => {
  const error = cause as { code?: unknown; message?: unknown };
  return {
    code: typeof error?.code === 'string' ? error.code : '',
    message: typeof error?.message === 'string' ? error.message : ''
  };
};

const UNREACHABLE =
  'Your athanor is not reachable right now. It keeps working; this device will reconnect.';

/**
 * A box that predates mail and calendar connectors refuses the request as malformed, because its
 * schema has never heard of the kind. Saying so is the difference between "update athanor" and an
 * evening spent retyping a password that was always right.
 */
const BEHIND =
  'This athanor is older than this screen and cannot connect a mailbox or a calendar yet. Update it and try again.';

/**
 * Which end failed, when the failure came from the socket rather than from the protocol.
 *
 * Node writes the port it was dialling into the message — "connect ECONNREFUSED 203.0.113.7:465" —
 * so the port names the endpoint even though the address in the text is the resolved IP.
 */
const endpointFromMessage = (
  message: string,
  imap: { host: string; port: number },
  smtp: { host: string; port: number }
): { host: string; port: number } => {
  const dialled = /:(\d{2,5})\b/.exec(message);
  if (dialled && Number(dialled[1]) === smtp.port && smtp.port !== imap.port) return smtp;
  return imap;
};

const hostFromLookup = (message: string): string => {
  const found = /(?:ENOTFOUND|EAI_AGAIN)\s+([a-z0-9.-]+)/i.exec(message);
  return found?.[1] ?? '';
};

/**
 * What went wrong with a mailbox, in a sentence that points at the field to change.
 *
 * The verification runs IMAP first and only opens the submission connection once reading works, so
 * anything naming SMTP happened with the reading half already proven — which is worth saying,
 * because "it works for reading but not for sending" is a different job from "it does not work".
 */
export const mailConnectFailure = (cause: unknown, endpoints: MailEndpoints): string => {
  if (isTransportFailure(cause)) return UNREACHABLE;
  const { code, message } = failure(cause);
  if (code === 'invalid_request' || code === 'connector_kind_invalid') return BEHIND;
  const imap = { host: endpoints.imapHost, port: endpoints.imapPort };
  const smtp = { host: endpoints.smtpHost, port: endpoints.smtpPort };
  const smtpSide = /smtp/i.test(message);
  const side = smtpSide ? smtp : imap;
  const both = `${imap.host}:${imap.port} for reading and ${smtp.host}:${smtp.port} for sending`;

  if (code === 'mail_timeout')
    return `No answer within 30 seconds. Check ${both} — a port nothing is listening on looks exactly like this.`;
  if (code === 'mail_greeting_invalid')
    return `Something is listening on ${side.host}:${side.port}, but it did not answer as ${smtpSide ? 'an SMTP submission server. Submission over TLS is usually port 465' : 'an IMAP server. IMAP over TLS is usually port 993'}.`;
  if (code === 'mail_command_failed')
    return /auth|login|credential|password|invalid user/i.test(message)
      ? `${imap.host} refused that username and password. If your provider uses two-factor sign-in, this needs an app password rather than your account password.`
      : `${imap.host} refused a command: ${message.replace(/^The IMAP server refused the command:\s*/i, '')}`;
  if (code === 'mail_send_failed') {
    const answered = /answered (\d{3})/.exec(message)?.[1] ?? '';
    return `Reading worked. Sending did not: ${smtp.host} refused the sign-in${answered ? ` with ${answered}` : ''}. Some providers need a separate app password for submission, or need submission switched on for the account.`;
  }
  if (code === 'mail_authentication_unsupported')
    return `${side.host} offers no password sign-in athanor can use. A mailbox that can only be opened with a provider's own sign-in cannot be connected here.`;
  if (code === 'mail_address_not_allowed')
    return `${imap.host} does not resolve to an address on the public internet, so athanor will not open a connection to it.`;
  if (code === 'mail_connection_closed' || code === 'mail_response_invalid')
    return `${side.host}:${side.port} closed the connection without speaking ${smtpSide ? 'SMTP' : 'IMAP'}. That is usually the wrong port.`;
  if (code === 'connector_url_not_allowed' || code === 'connector_secret_invalid') return message;

  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    const host = hostFromLookup(message);
    return `There is no server called ${host || imap.host}. Check the spelling of the host.`;
  }
  const dialled = endpointFromMessage(message, imap, smtp);
  if (/ECONNREFUSED/i.test(message))
    return `${dialled.host} refused the connection on port ${dialled.port}. Nothing is listening there: IMAP over TLS is usually 993 and submission 465.`;
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(message))
    return `${dialled.host} did not answer on port ${dialled.port}. Check the port, and that your provider allows a mail client at all.`;
  if (/wrong version number|SSL routines|ERR_SSL|packet length too long|ECONNRESET/i.test(message))
    return `${dialled.host}:${dialled.port} answered, but not with TLS. athanor connects over TLS only — 993 and 465, not 143 or 587.`;
  if (/certificate|CERT_|altname|self.signed/i.test(message))
    return `The TLS certificate ${dialled.host} presented is not valid for that name, so athanor stopped rather than trust it.`;
  return message || 'The mailbox could not be connected.';
};

export const calendarConnectFailure = (cause: unknown, url: string): string => {
  if (isTransportFailure(cause)) return UNREACHABLE;
  const { code, message } = failure(cause);
  if (code === 'invalid_request' || code === 'connector_kind_invalid') return BEHIND;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL never reached the server; the code below still says something true.
  }
  if (code === 'caldav_request_failed') {
    const status = Number(/answered (\d{3})/.exec(message)?.[1] ?? 0);
    if (status === 401 || status === 403)
      return `${host} refused that username and password. If your provider uses two-factor sign-in, this needs an app password rather than your account password.`;
    if (status === 404)
      return `There is nothing at that address on ${host}. Paste the calendar home your server publishes — often something like https://${host}/remote.php/dav/`;
    if (status === 405)
      return `${host} answered, but that address is a web page rather than a CalDAV collection.`;
    return `${host} answered ${status || 'with an error'} instead of listing calendars.`;
  }
  if (code === 'calendar_none_found')
    return `Signed in to ${host}, but there are no calendars under that address. Point it at your calendar home rather than at a single calendar or the site root.`;
  if (code === 'caldav_href_invalid' || code === 'connector_url_not_allowed') return message;
  if (code === 'connector_address_not_allowed')
    return `${host} does not resolve to an address on the public internet, so athanor will not open a connection to it.`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(message))
    return `There is no server called ${hostFromLookup(message) || host}. Check the spelling of the address.`;
  if (/certificate|CERT_|altname|self.signed/i.test(message))
    return `The TLS certificate ${host} presented is not valid for that name, so athanor stopped rather than trust it.`;
  if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timed out/i.test(message))
    return `${host} did not answer. Check the address, and that the server is reachable from outside your network.`;
  return message || 'The calendar could not be connected.';
};
