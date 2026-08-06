import { describe, expect, it } from 'vitest';
import {
  accountDeletionArmed,
  passkeyLabel,
  passkeyRemovable,
  securityActionMessage,
  type PasskeySummary
} from './account-security.js';

const passkey = (id: string, deviceType = 'singleDevice'): PasskeySummary => ({
  id,
  deviceType,
  backedUp: false,
  createdAt: '2026-07-01T00:00:00.000Z'
});

describe('passkey revocation', () => {
  it('offers removal only while another sign-in method remains', () => {
    const two = [passkey('a'), passkey('b')];
    expect(passkeyRemovable(two, 'a')).toBe(true);
    expect(passkeyRemovable([passkey('a')], 'a')).toBe(false);
    expect(passkeyRemovable(two, 'missing')).toBe(false);
  });

  it('names the credential, which the authenticator does not', () => {
    expect(passkeyLabel(passkey('a', 'multiDevice'))).toContain('Synced passkey');
    expect(passkeyLabel(passkey('a'))).toContain('Device-bound passkey');
  });

  it('explains the last-passkey refusal instead of reporting a generic failure', () => {
    expect(securityActionMessage({ code: 'last_passkey' })).toContain('Add another passkey first');
    expect(securityActionMessage({ code: 'confirmation_failed' })).toContain('exact username');
    expect(securityActionMessage(new Error('Network down'))).toBe('Network down');
    expect(securityActionMessage(undefined)).toBe('The change could not be saved');
  });

  it('tells the owner their server is behind rather than showing a bare 404', () => {
    expect(
      securityActionMessage({
        code: 'request_failed',
        status: 404,
        message: 'Request failed (404)'
      })
    ).toContain('older than this screen');
    // A real athanor error that happens to be a 404 keeps its own sentence.
    expect(securityActionMessage({ code: 'last_passkey', status: 404 })).toContain(
      'Add another passkey first'
    );
  });
});

describe('account deletion', () => {
  it('stays inert until the typed name matches, ignoring case and padding', () => {
    expect(accountDeletionArmed('', 'dan')).toBe(false);
    expect(accountDeletionArmed('da', 'dan')).toBe(false);
    expect(accountDeletionArmed(' Dan ', 'dan')).toBe(true);
  });
});
