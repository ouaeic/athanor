import { describe, expect, it } from 'vitest';
import { deviceEnrollmentToken } from './device-link.js';

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
});
