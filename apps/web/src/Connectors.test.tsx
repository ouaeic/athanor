/**
 * The connect screen, rendered.
 *
 * Connecting a mailbox is the only place in athanor where the owner types eight facts about
 * somebody else's server and makes a decision that lets an agent send mail as them. What is on
 * screen before they type anything decides whether that goes well.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectedList, Connectors } from './Connectors.js';
import type { Connector, ConnectorAuditEvent } from './types.js';

const render = (): string =>
  renderToStaticMarkup(
    <Connectors
      ownerName="Ada"
      busy={false}
      act={async (operation) => operation()}
      setNotice={() => undefined}
      setError={() => undefined}
    />
  );

describe('what the connect screen opens on', () => {
  const markup = render();

  it('opens on the mailbox, which is what most work needs', () => {
    expect(markup).toContain('Mailbox (IMAP and SMTP)');
    expect(markup).toContain('IMAP host');
    expect(markup).toContain('SMTP submission host');
  });

  /* Ports nobody should have to know, filled in rather than asked for. */
  it('fills in the two ports athanor actually connects on', () => {
    expect(markup).toContain('value="993"');
    expect(markup).toContain('value="465"');
  });

  it('opens read-only, so sending as the owner is something they chose', () => {
    expect(markup).toContain('Read only');
    expect(markup).toContain('Read and send');
    expect(markup).toContain('waits for your approval');
  });

  /* The POST verifies IMAP login, mailbox listing and SMTP auth before it stores anything. */
  it('says the button tests before it saves, and starts inert', () => {
    expect(markup).toContain('Test and connect');
    expect(markup).toContain('<button disabled=""');
  });

  it('never puts a credential field in the markup with a readable type', () => {
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('autocomplete="current-password"');
  });

  /*
   * The catalogue is fetched, so on the very first paint there is nothing to say about the
   * connection yet. A box that predates a field says less for the same reason. Neither may leave
   * an empty paragraph behind: a heading with nothing under it reads as "there is nothing to say".
   */
  it('leaves no empty line where the box has not yet said what a connection reaches', () => {
    expect(markup).not.toContain('<p class="subtle"></p>');
    expect(markup).not.toContain('What leaves this box:</p>');
  });
});

/*
 * What the list shows after a disconnect.
 *
 * Disconnecting is `PATCH`-shaped underneath: `revokeConnector` sets `enabled=FALSE` and
 * `listConnectors` selects every row for the user with no filter on it, ordered `enabled DESC`. So
 * the row was always going to come back on the reload the handler runs, and the question the list
 * had never answered is what it comes back as. It came back as a live connection with a Check
 * button and a Disconnect button that both 404 against `getConnector`, which does filter
 * `enabled=TRUE` — and the Disconnect one asked for a second passkey first.
 */
describe('the list after a connection is disconnected', () => {
  const connector = (patch: Partial<Connector> = {}): Connector => ({
    id: 'c1',
    kind: 'imap',
    authMode: 'secret',
    label: 'Fastmail',
    baseUrl: 'imaps://imap.fastmail.com:993',
    scopes: ['mail:mailbox.read', 'mail:message.send'],
    enabled: true,
    lastUsedAt: '2026-08-27T08:59:30.000Z',
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-08-27T08:59:30.000Z',
    ...patch
  });

  /*
   * Both stamps a revocation leaves behind, exactly as the box leaves them: the audit row for the
   * revocation itself, and the `last_used_at` that same insert writes on the connector.
   */
  const revoked = connector({
    id: 'c2',
    label: 'Old mailbox',
    enabled: false,
    lastUsedAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z'
  });

  const audit: ConnectorAuditEvent[] = [
    {
      id: 'e1',
      connectorId: 'c2',
      taskId: null,
      operation: 'revoke',
      outcome: 'succeeded',
      statusCode: null,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 0,
      createdAt: '2026-08-24T09:00:00.000Z'
    }
  ];

  const list = (connectors: Connector[]): string =>
    renderToStaticMarkup(
      <ConnectedList
        connectors={connectors}
        audit={audit}
        checks={{}}
        checking=""
        busy={false}
        now={Date.parse('2026-08-27T09:00:00.000Z')}
        onCheck={() => undefined}
        onDisconnect={() => undefined}
      />
    );

  it('keeps the disconnected connection on screen and says that is what it is', () => {
    const markup = list([connector(), revoked]);
    expect(markup).toContain('Old mailbox');
    expect(markup).toContain('· disconnected');
  });

  /* Both controls resolve through `getConnector`, which filters `enabled=TRUE`. Neither can work. */
  it('offers neither control on it, because both of them answer 404', () => {
    const markup = list([revoked]);
    expect(markup).not.toContain('aria-label="Check Old mailbox"');
    expect(markup).not.toContain('Disconnect Old mailbox');
  });

  /*
   * `recordConnectorAudit` stamps `last_used_at=NOW()` beside every row it writes and the
   * revocation writes one, so the connector's own column says the far end was reached at the
   * instant of the revocation. It was not reached at all.
   */
  it('says when, and never that the far end was reached at the instant it was revoked', () => {
    const markup = list([revoked]);
    expect(markup).toContain('Disconnected 3 days ago');
    expect(markup).not.toContain('Last reached');
  });

  /* What it could do while it held a credential is the question a revocation leaves behind. */
  it('still says what that connection could reach, under a clause that puts it in the past', () => {
    const markup = list([revoked]);
    expect(markup).toContain('What it could reach');
    expect(markup).toContain('Reads your mail, and sends messages as you');
  });

  /* The other direction: a live connection keeps everything it had. */
  it('leaves a live connection with both of its controls and its own status line', () => {
    const markup = list([connector(), revoked]);
    expect(markup).toContain('aria-label="Check Fastmail"');
    expect(markup).toContain('Disconnect Fastmail');
    expect(markup).toContain('Last reached just now');
    expect(markup).not.toContain('Fastmail · Mailbox · disconnected');
  });
});
