import { describe, expect, it, vi } from 'vitest';
import {
  accountDeletionArmed,
  passkeyLabel,
  passkeyRemovable,
  securityActionMessage,
  withStepUp,
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

/*
 * The two controls this was written for are signing another device out and raising a spending cap.
 * Both went to a route behind step-up with no confirmation in front of it, and both failed silently
 * once the five-minute window had passed - which is every use of the screen that is not the first
 * minute after signing in.
 */
describe('a write the server wants confirmed', () => {
  const refused = { code: 'step_up_required', status: 403 };

  it('confirms and tries again, exactly once', async () => {
    const operation = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce(undefined);
    const stepUp = vi.fn().mockResolvedValue(undefined);

    await expect(withStepUp(operation, stepUp)).resolves.toBeUndefined();
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('asks for nothing when the server did not', async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    await withStepUp(async () => undefined, stepUp);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('carries any other failure straight out, unconfirmed and unretried', async () => {
    const operation = vi.fn().mockRejectedValue({ code: 'last_passkey' });
    const stepUp = vi.fn().mockResolvedValue(undefined);

    await expect(withStepUp(operation, stepUp)).rejects.toMatchObject({ code: 'last_passkey' });
    expect(stepUp).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  // A dismissed passkey sheet, or a second refusal, has to reach the owner as a sentence rather
  // than becoming an unbounded loop of prompts.
  it('gives up after one confirmation and says what the owner does next', async () => {
    const operation = vi.fn().mockRejectedValue(refused);
    const stepUp = vi.fn().mockResolvedValue(undefined);

    await expect(withStepUp(operation, stepUp)).rejects.toMatchObject(refused);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(securityActionMessage(refused)).toBe(
      'Your passkey confirmation did not land. Try again and approve the prompt.'
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
