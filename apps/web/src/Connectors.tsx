import { useEffect, useState } from 'react';
import { Link2, Plus, ScrollText, Stethoscope, Trash2 } from 'lucide-react';
import { api } from './api.js';
import {
  calendarConnectFailure,
  calendarConnectRequest,
  connectActionLabel,
  connectReady,
  connectorKinds,
  emptyCalendarForm,
  emptyMailForm,
  mailConnectFailure,
  mailConnectRequest,
  usesBrowserSignIn,
  type CalendarConnectForm,
  type ConnectorKind,
  type MailConnectForm,
  type McpAuthMode
} from './connector-forms.js';
import { connectorAccess, connectorCallLine, connectorCheckMessage } from './connector-access.js';
import { formatBytes } from './timeline-state.js';
import type { Connector, ConnectorAuditEvent, ConnectorDefinition } from './types.js';

/** What a connected service is, said as the owner thinks of it rather than as a protocol name. */
const connectedKindLabel = (kind: string): string =>
  ({
    imap: 'Mailbox',
    caldav: 'Calendar',
    github: 'GitHub',
    webdav: 'Files',
    mcp_http: 'Tool server'
  })[kind] ?? kind;

const authModeLabel = (mode: Connector['authMode']): string =>
  mode === 'oauth'
    ? 'OAuth'
    : mode === 'bearer'
      ? 'Bearer token'
      : mode === 'none'
        ? 'No credentials'
        : 'Encrypted credentials';

/**
 * Everything the owner can point athanor at, and the two forms that are more than a token field.
 *
 * A mailbox is eight facts about somebody else's server and a decision about whether athanor may
 * send as the owner; a calendar is five and a decision about whether it may write. Both are tested
 * against the real server before anything is stored — the POST verifies IMAP login, mailbox listing
 * and SMTP authentication, or a CalDAV discovery, and only then encrypts the password — so the
 * button both tests and connects, and the failure it comes back with is the whole conversation.
 */
export function Connectors({
  ownerName,
  busy,
  act,
  setNotice,
  setError
}: {
  /** The name this box already knows the owner by; mail goes out as a person because of it. */
  ownerName: string;
  busy: boolean;
  act: (operation: () => Promise<void>) => Promise<void>;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
}) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  /** Whether the list could not be read, as opposed to being genuinely empty. */
  const [unavailable, setUnavailable] = useState(false);
  const [audit, setAudit] = useState<ConnectorAuditEvent[]>([]);
  const [catalog, setCatalog] = useState<ConnectorDefinition[]>([]);
  const [kind, setKind] = useState<ConnectorKind>('imap');
  const [mail, setMail] = useState<MailConnectForm>(emptyMailForm);
  const [calendar, setCalendar] = useState<CalendarConnectForm>(emptyCalendarForm);
  const [token, setToken] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mcpAuth, setMcpAuth] = useState<McpAuthMode>('oauth_dynamic');
  const [oauthScopes, setOauthScopes] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  /** Its own flag, so the button says what it is doing rather than what some other row is doing. */
  const [testing, setTesting] = useState(false);
  /** Which connected row is being re-checked, so only that row's control goes quiet. */
  const [checking, setChecking] = useState('');

  const load = () =>
    void Promise.all([api.connectors(), api.connectorAudit()])
      .then(([nextConnectors, nextAudit]) => {
        setConnectors(nextConnectors);
        setAudit(nextAudit);
        setUnavailable(false);
      })
      // Distinguished from "you have none": an empty list after a failed read told the owner
      // their connections were gone when they were only unreachable.
      .catch(() => {
        setUnavailable(true);
        setConnectors([]);
        setAudit([]);
      });

  useEffect(() => {
    load();
    // The catalogue is the box's own statement of what each connection needs and what it can see.
    // An older box that does not publish it simply says less; nothing here is invented locally.
    void api
      .connectorCatalog()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    const receiveMcpOAuth = (event: MessageEvent<unknown>) => {
      const payload =
        event.data && typeof event.data === 'object'
          ? (event.data as Record<string, unknown>)
          : null;
      if (
        event.origin !== window.location.origin ||
        !payload ||
        payload.source !== 'athanor-mcp-oauth'
      )
        return;
      const message = typeof payload.message === 'string' ? payload.message : '';
      if (payload.ok === true) {
        void api.connectors().then(setConnectors);
        setNotice(message || 'MCP service connected securely.');
      } else {
        setError(message || 'The MCP connection was not completed.');
      }
    };
    window.addEventListener('message', receiveMcpOAuth);
    return () => window.removeEventListener('message', receiveMcpOAuth);
  }, [setError, setNotice]);

  const definition = catalog.find((entry) => entry.kind === kind);
  const draft = { kind, mail, calendar, token, url, username, password, mcpAuth, clientId };
  const oauth = usesBrowserSignIn(draft);

  /*
   * Both of these test before they save, because the POST does: it opens IMAP, signs in, lists the
   * mailboxes and authenticates against submission — or discovers the calendars — and only stores
   * an encrypted credential once all of that worked. What is left to this screen is saying which
   * part failed, which is why the raw error never reaches the owner.
   */
  const connectMail = () =>
    act(async () => {
      const request = mailConnectRequest(mail, ownerName);
      if (!request.ok) throw new Error(request.message);
      setTesting(true);
      try {
        await api.stepUp();
        await api.addConnector(request.body).catch((cause: unknown) => {
          throw new Error(mailConnectFailure(cause, request.endpoints));
        });
      } finally {
        setTesting(false);
      }
      setMail(emptyMailForm());
      load();
      setNotice(
        mail.access === 'send'
          ? 'Mailbox connected. Reading works, sending works, and every message it sends asks you first.'
          : 'Mailbox connected, for reading only.'
      );
    });

  const connectCalendar = () =>
    act(async () => {
      const request = calendarConnectRequest(calendar);
      if (!request.ok) throw new Error(request.message);
      setTesting(true);
      try {
        await api.stepUp();
        await api.addConnector(request.body).catch((cause: unknown) => {
          throw new Error(calendarConnectFailure(cause, calendar.url));
        });
      } finally {
        setTesting(false);
      }
      setCalendar(emptyCalendarForm());
      load();
      setNotice(
        calendar.access === 'write'
          ? 'Calendar connected. athanor can read it and put events in it.'
          : 'Calendar connected, for reading only.'
      );
    });

  const connectOther = () => {
    const popup = oauth
      ? window.open('about:blank', 'athanor-mcp-oauth', 'popup,width=560,height=720,noopener=false')
      : null;
    void act(async () => {
      try {
        if (oauth && !popup)
          throw new Error(
            'Your browser blocked the secure sign-in window. Allow popups and try again.'
          );
        await api.stepUp();
        if (oauth) {
          const target = new URL(url);
          const started = await api.startMcpOAuth({
            label: target.hostname,
            baseUrl: target.toString(),
            scopes: ['mcp:tools.read', 'mcp:tools.execute'],
            oauthScopes: oauthScopes
              .split(/[\s,]+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
            registration: mcpAuth === 'oauth_static' ? 'static' : 'dynamic',
            ...(mcpAuth === 'oauth_static'
              ? { clientId, ...(clientSecret ? { clientSecret } : {}) }
              : {})
          });
          popup!.location.replace(started.authorizationUrl);
          setClientSecret('');
          setNotice(
            `Continue securely at ${started.authorizationHost}. This request expires in 10 minutes.`
          );
          return;
        }
        await api.addConnector(
          kind === 'github'
            ? {
                kind: 'github',
                label: 'GitHub',
                token,
                scopes: ['github:profile.read', 'github:repository.read', 'github:issues.read']
              }
            : kind === 'webdav'
              ? {
                  kind: 'webdav',
                  label: 'WebDAV',
                  baseUrl: url,
                  username,
                  password,
                  scopes: ['webdav:files.read', 'webdav:files.write']
                }
              : {
                  kind: 'mcp_http',
                  label: new URL(url).hostname,
                  baseUrl: url,
                  ...(mcpAuth === 'bearer' ? { token } : {}),
                  scopes: ['mcp:tools.read', 'mcp:tools.execute']
                }
        );
        setToken('');
        setPassword('');
        load();
      } catch (cause) {
        popup?.close();
        throw cause;
      }
    });
  };

  return (
    <>
      <div className="section-heading">
        <Link2 />
        <div>
          <strong>Connections</strong>
          <span>
            Your mailbox, your calendar, your files, your tools. Credentials are encrypted on this
            box, and athanor gets only the access you pick here.
          </span>
        </div>
      </div>
      <div className="form-grid connect-grid">
        <label>
          Service
          <select value={kind} onChange={(event) => setKind(event.target.value as ConnectorKind)}>
            {connectorKinds.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'imap' && (
          <>
            <label>
              Name (optional)
              <input
                placeholder={mail.address || 'Work mail'}
                value={mail.label}
                onChange={(event) => setMail({ ...mail, label: event.target.value })}
              />
            </label>
            <label>
              Your email address
              <input
                type="email"
                autoComplete="off"
                placeholder="you@example.com"
                value={mail.address}
                onChange={(event) => setMail({ ...mail, address: event.target.value })}
              />
            </label>
            <label>
              App password
              <input
                type="password"
                autoComplete="new-password"
                value={mail.password}
                onChange={(event) => setMail({ ...mail, password: event.target.value })}
              />
            </label>
            <label>
              IMAP host
              <input
                placeholder="imap.example.com"
                value={mail.imapHost}
                onChange={(event) => setMail({ ...mail, imapHost: event.target.value })}
              />
            </label>
            <label>
              IMAP port
              <input
                inputMode="numeric"
                value={mail.imapPort}
                onChange={(event) => setMail({ ...mail, imapPort: event.target.value })}
              />
            </label>
            <label>
              SMTP submission host
              <input
                placeholder="smtp.example.com"
                value={mail.smtpHost}
                onChange={(event) => setMail({ ...mail, smtpHost: event.target.value })}
              />
            </label>
            <label>
              SMTP port
              <input
                inputMode="numeric"
                value={mail.smtpPort}
                onChange={(event) => setMail({ ...mail, smtpPort: event.target.value })}
              />
            </label>
            <label>
              Username (optional)
              <input
                autoComplete="off"
                placeholder={mail.address || 'Same as your address'}
                value={mail.username}
                onChange={(event) => setMail({ ...mail, username: event.target.value })}
              />
            </label>
          </>
        )}
        {kind === 'caldav' && (
          <>
            <label>
              Name (optional)
              <input
                placeholder="My calendar"
                value={calendar.label}
                onChange={(event) => setCalendar({ ...calendar, label: event.target.value })}
              />
            </label>
            <label>
              CalDAV address
              <input
                placeholder="https://cloud.example.com/remote.php/dav/"
                value={calendar.url}
                onChange={(event) => setCalendar({ ...calendar, url: event.target.value })}
              />
            </label>
            <label>
              Username
              <input
                autoComplete="off"
                value={calendar.username}
                onChange={(event) => setCalendar({ ...calendar, username: event.target.value })}
              />
            </label>
            <label>
              App password
              <input
                type="password"
                autoComplete="new-password"
                value={calendar.password}
                onChange={(event) => setCalendar({ ...calendar, password: event.target.value })}
              />
            </label>
            <label>
              The address people invite you by
              <input
                type="email"
                autoComplete="off"
                placeholder="you@example.com"
                value={calendar.address}
                onChange={(event) => setCalendar({ ...calendar, address: event.target.value })}
              />
            </label>
          </>
        )}
        {kind === 'github' && (
          <label>
            Fine-grained token
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        )}
        {kind === 'webdav' && (
          <>
            <label>
              WebDAV URL
              <input value={url} onChange={(event) => setUrl(event.target.value)} />
            </label>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        )}
        {kind === 'mcp_http' && (
          <>
            <label>
              Streamable HTTP URL
              <input
                placeholder="https://tools.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label>
              Sign in
              <select
                value={mcpAuth}
                onChange={(event) => setMcpAuth(event.target.value as typeof mcpAuth)}
              >
                <option value="oauth_dynamic">Secure browser sign-in</option>
                <option value="none">No sign-in</option>
                <option value="bearer">Bearer token</option>
                <option value="oauth_static">OAuth client credentials</option>
              </select>
            </label>
            {mcpAuth === 'bearer' && (
              <label>
                Bearer token
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
            )}
            {(mcpAuth === 'oauth_dynamic' || mcpAuth === 'oauth_static') && (
              <label>
                Requested OAuth scopes (optional)
                <input
                  placeholder="tools.read tools.execute"
                  value={oauthScopes}
                  onChange={(event) => setOauthScopes(event.target.value)}
                />
              </label>
            )}
            {mcpAuth === 'oauth_static' && (
              <>
                <label>
                  OAuth client ID
                  <input value={clientId} onChange={(event) => setClientId(event.target.value)} />
                </label>
                <label>
                  OAuth client secret (optional)
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                  />
                </label>
              </>
            )}
          </>
        )}
      </div>
      {/*
        The access decision is made here, at connect time, and it is the whole difference between a
        mailbox athanor reads and a mailbox athanor can write from. It is two choices rather than a
        row of capability checkboxes because there is no useful third answer.
      */}
      {kind === 'imap' && (
        <div className="access-choice">
          <label className="toggle-row">
            <input
              type="radio"
              name="mail-access"
              checked={mail.access === 'read'}
              onChange={() => setMail({ ...mail, access: 'read' })}
            />
            <strong>Read only</strong>
            <small>Search and read your mail. It cannot send, delete or change anything.</small>
          </label>
          <label className="toggle-row">
            <input
              type="radio"
              name="mail-access"
              checked={mail.access === 'send'}
              onChange={() => setMail({ ...mail, access: 'send' })}
            />
            <strong>Read and send</strong>
            <small>
              Also saves drafts, marks messages read, and sends mail as you. Every message shows you
              the recipients and the text before it goes, and waits for your approval.
            </small>
          </label>
        </div>
      )}
      {kind === 'caldav' && (
        <div className="access-choice">
          <label className="toggle-row">
            <input
              type="radio"
              name="calendar-access"
              checked={calendar.access === 'read'}
              onChange={() => setCalendar({ ...calendar, access: 'read' })}
            />
            <strong>Read only</strong>
            <small>See what is in your calendar. It cannot add, change or answer anything.</small>
          </label>
          <label className="toggle-row">
            <input
              type="radio"
              name="calendar-access"
              checked={calendar.access === 'write'}
              onChange={() => setCalendar({ ...calendar, access: 'write' })}
            />
            <strong>Read and write</strong>
            <small>
              Also creates and changes events, and answers invitations addressed to you.
            </small>
          </label>
        </div>
      )}
      {/* The box's own words about what the owner must already have. This is where the cost of
          using open protocols instead of a provider sign-in is stated, so it is not paraphrased. */}
      {definition?.requirements && <p className="subtle">{definition.requirements}</p>}
      {kind === 'mcp_http' && (
        <p className="subtle">
          athanor verifies the service, encrypts its credentials, and asks before every MCP tool
          execution. Browser sign-in uses OAuth with PKCE.
        </p>
      )}
      <button
        disabled={busy || !connectReady(draft)}
        onClick={() =>
          kind === 'imap'
            ? void connectMail()
            : kind === 'caldav'
              ? void connectCalendar()
              : connectOther()
        }
      >
        <Plus /> {connectActionLabel(draft, testing)}
      </button>
      <div className="settings-list">
        {connectors.map((item) => (
          <div key={item.id}>
            <span>
              <strong>
                {item.label} · {connectedKindLabel(item.kind)}
              </strong>
              {/* What was granted, said the way it was granted. This was the stored scope ids. */}
              <small>
                {connectorAccess(item.scopes)} · {authModeLabel(item.authMode)}
              </small>
            </span>
            {/* One cell, two controls: the row is a two-column grid and a third child would drop
                the disconnect button onto a line of its own. */}
            <div className="settings-row-actions">
              {/*
                A credential is verified once, when it is added, and then trusted. Passwords change,
                servers move and authorizations expire, and none of those announce themselves — so
                this is the answer to "is this still good", asked rather than found out by a task
                that failed at three in the morning.
              */}
              <button
                className="icon-btn"
                aria-label={`Check ${item.label}`}
                title="Ask this account whether the connection still works"
                disabled={busy || checking === item.id}
                onClick={() =>
                  void act(async () => {
                    setChecking(item.id);
                    try {
                      const result = connectorCheckMessage(
                        item.label,
                        await api.testConnector(item.id)
                      );
                      if (!result.ok) throw new Error(result.message);
                      setNotice(result.message);
                      load();
                    } finally {
                      setChecking('');
                    }
                  })
                }
              >
                <Stethoscope />
              </button>
              <button
                className="icon-btn"
                aria-label={`Disconnect ${item.label} · asks for your passkey`}
                title="Disconnecting cannot be undone; the stored credential is destroyed"
                onClick={() =>
                  void act(async () => {
                    await api.stepUp();
                    await api.revokeConnector(item.id);
                    load();
                  })
                }
              >
                <Trash2 />
              </button>
            </div>
          </div>
        ))}
      </div>
      {unavailable && (
        <p className="connector-unavailable">
          Your connections could not be read just now. Nothing was removed — this device could not
          reach the server.
        </p>
      )}
      {connectors.length > 0 && (
        <>
          <hr />
          <div className="section-heading compact">
            <ScrollText />
            <div>
              <strong>What the agent did with them</strong>
              <span>
                Every connector call is recorded with its outcome and size. The record never
                contains the request or the response.
              </span>
            </div>
          </div>
          <div className="settings-list">
            {!audit.length && (
              <div>
                <span>
                  <strong>No calls yet</strong>
                  <small>Nothing has used a connected service on this installation.</small>
                </span>
              </div>
            )}
            {audit.map((entry) => {
              const label = connectors.find((item) => item.id === entry.connectorId)?.label;
              const line = connectorCallLine(entry, formatBytes);
              return (
                <div key={entry.id}>
                  <span>
                    <strong>
                      {label ?? 'Disconnected service'} · {line.action}
                    </strong>
                    <small>{line.detail}</small>
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
