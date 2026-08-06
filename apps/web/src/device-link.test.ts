import { describe, expect, it } from 'vitest';
import {
  deviceEnrollmentToken,
  grantInPairingFragment,
  isPairingFragment
} from './device-link.js';

const token = 'w6Yl8Qk2nT4vXbR7pL0sZaC3dF5gH9jK';

/** Exactly what POST /v1/devices/enrollments returns, encoded the way the server encodes it. */
const link = (payload: unknown): string =>
  `athanor://pair/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

const ticket = link({
  version: 2,
  endpoints: ['https://box.example'],
  identity: 'sha256/box',
  discovery: { mdnsService: '_athanor._tcp.local', mdnsPort: 443 },
  pairingCode: token,
  expiresAt: 1_800_000_000
});

describe('the code inside a device link', () => {
  it('takes the grant out of the link the settings screen hands over', () => {
    expect(deviceEnrollmentToken(ticket)).toBe(token);
    expect(deviceEnrollmentToken(`  ${ticket}\n`)).toBe(token);
  });

  /* The installer prints one, and the native client hands one over directly. Same field. */
  it('accepts a bare code as itself', () => {
    expect(deviceEnrollmentToken(token)).toBe(token);
    expect(deviceEnrollmentToken(` ${token} `)).toBe(token);
  });

  it('has nothing for anything that is not one', () => {
    expect(deviceEnrollmentToken('')).toBe('');
    expect(deviceEnrollmentToken('half-a-code')).toBe('');
    expect(deviceEnrollmentToken('athanor://pair/')).toBe('');
    expect(deviceEnrollmentToken('athanor://pair/not-base64url!!')).toBe('');
    expect(deviceEnrollmentToken(link({ version: 1, endpoints: [] }))).toBe('');
    expect(deviceEnrollmentToken(link({ pairingCode: 'short' }))).toBe('');
    expect(deviceEnrollmentToken(link(['not', 'an', 'object']))).toBe('');
    expect(deviceEnrollmentToken(`athanor://pair/${'A'.repeat(9_000)}`)).toBe('');
  });

  /*
   * The rest of the ticket is the native client's business - where the box lives, what identity to
   * pin. A browser already talking to the box takes the grant and nothing else.
   */
  it('reads only the grant, whatever else the ticket carries', () => {
    expect(
      deviceEnrollmentToken(
        link({ pairingCode: token, endpoints: ['https://attacker.example'], identity: 'no' })
      )
    ).toBe(token);
  });

  /*
   * What a scanned QR code leaves behind. The code is an ordinary https address at the box, because
   * that is the only kind a phone's camera opens, so the ticket arrives with no scheme in front of
   * it - far longer than a bare grant and previously rejected on length.
   */
  it('takes the grant out of a bare ticket, as a scanned code leaves it', () => {
    const bare = ticket.replace('athanor://pair/', '');
    expect(deviceEnrollmentToken(bare)).toBe(token);
  });
});

describe('the grant a scanned code leaves in the address', () => {
  const bare = ticket.replace('athanor://pair/', '');

  it('reads the ticket out of the fragment, with or without the hash', () => {
    expect(grantInPairingFragment(`#pair=${bare}`)).toBe(token);
    expect(grantInPairingFragment(`pair=${bare}`)).toBe(token);
    // Some scanners percent-encode the fragment on the way through.
    expect(grantInPairingFragment(`#pair=${encodeURIComponent(bare)}`)).toBe(token);
  });

  it('leaves an address that is not a pairing link alone', () => {
    expect(grantInPairingFragment('#settings')).toBe('');
    expect(isPairingFragment('#settings')).toBe(false);
    expect(isPairingFragment('')).toBe(false);
  });

  /* A mistyped code still has to come out of the address bar, so the two questions differ. */
  it('knows a pairing fragment from a usable grant', () => {
    expect(grantInPairingFragment('#pair=not-a-ticket')).toBe('');
    expect(isPairingFragment('#pair=not-a-ticket')).toBe(true);
  });
});
