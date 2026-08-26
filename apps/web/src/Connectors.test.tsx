/**
 * The connect screen, rendered.
 *
 * Connecting a mailbox is the only place in athanor where the owner types eight facts about
 * somebody else's server and makes a decision that lets an agent send mail as them. What is on
 * screen before they type anything decides whether that goes well.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Connectors } from './Connectors.js';

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
