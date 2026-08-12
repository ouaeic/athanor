/**
 * The sign-in screen, rendered.
 *
 * Its decisions live in `auth-form.ts` and are tested there. What is asserted here is the one thing
 * a pure function cannot say: whether the path a second device needs is on the screen at all. It
 * was not — the box mints a device link, draws it as a QR code, and nothing in this client could
 * redeem it — and the only way to notice that is to look at what is drawn.
 *
 * `renderToStaticMarkup` runs no effects, so nothing is fetched and the screen is in the state it
 * opens in: signing in, before the box has answered.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Auth, authFailureText } from './Auth.js';

// The screen names the box it is signing in to, which is the one thing on it that comes from the
// browser rather than from the server.
vi.stubGlobal('window', { location: { host: 'box.example' } });

const markup = renderToStaticMarkup(<Auth onReady={() => undefined} />);

describe('the screen seen before there is an account', () => {
  it('offers the device link beside signing in', () => {
    expect(markup).toContain('Adding a new device?');
    expect(markup).toContain('Use a device link');
  });

  it('still offers the two paths it always had', () => {
    expect(markup).toContain('Sign in with your passkey');
    expect(markup).toContain('Lost access to your passkey?');
  });

  /* One field in that mode: the account exists and is already named. */
  it('does not ask a second device for a name it already knows', () => {
    expect(markup).not.toContain('Device link');
    expect(markup).not.toContain('Name used during setup');
  });
});

/*
 * A server serving the certificate it signed itself refuses nothing and offers everything: the
 * screen loads, the button is live, and the browser then declines to run WebAuthn at all because
 * the page is not trusted. The refusal names TLS, which on this screen reads as the passkey having
 * failed, so the owner presses the button again. The library passes a NotAllowedError through with
 * the browser's own wording and keeps the original on `cause`, so both are looked at.
 */
describe('the refusal a browser gives on an untrusted page', () => {
  const rejection = 'WebAuthn is not supported on sites with TLS certificate errors.';

  it('names the certificate and the command that fixes it', () => {
    const shown = authFailureText(new Error(rejection));
    expect(shown).toContain('does not trust');
    expect(shown).toContain('sudo athanor certificate enable --agree-tos --email you@example.com');
    expect(shown).not.toContain(rejection);
  });

  it('reads the wrapped original when the library has renamed the failure', () => {
    const wrapped = new Error('Registration failed', { cause: new Error(rejection) });
    expect(authFailureText(wrapped)).toContain('does not trust');
  });

  it('leaves every other failure exactly as the box reported it', () => {
    expect(authFailureText(new Error('That pairing code has already been used'))).toBe(
      'That pairing code has already been used'
    );
    expect(authFailureText('a thrown string')).toBe('Authentication failed');
  });
});
