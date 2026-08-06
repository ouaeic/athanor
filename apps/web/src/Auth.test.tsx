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
import { Auth } from './Auth.js';

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
