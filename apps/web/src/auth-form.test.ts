import { describe, expect, it } from 'vitest';
import {
  authActionLabel,
  authHeading,
  canSubmitAuth,
  initialAuthMode,
  type AuthFormState
} from './auth-form.js';

const code = 'x'.repeat(24);

const state = (patch: Partial<AuthFormState> = {}): AuthFormState => ({
  mode: 'login',
  name: '',
  pairingCode: '',
  recoveryCode: '',
  busy: false,
  passkeysUsable: true,
  serverKnown: true,
  ...patch
});

describe('when the sign-in screen will accept a submission', () => {
  it('signs in with nothing typed: the passkey is the whole credential', () => {
    expect(canSubmitAuth(state())).toBe(true);
  });

  it('will not act twice while the passkey prompt is open', () => {
    expect(canSubmitAuth(state({ busy: true }))).toBe(false);
  });

  /*
   * WebAuthn requires a registrable domain, so a box reached by IP cannot hold a passkey at all.
   * Offering the button produces a browser error with no explanation.
   */
  it('refuses everything on a box that cannot hold a passkey', () => {
    for (const mode of ['login', 'register', 'recover', 'enroll'] as const)
      expect(
        canSubmitAuth(
          state({ mode, passkeysUsable: false, name: 'Ada', pairingCode: code, recoveryCode: code })
        )
      ).toBe(false);
  });

  it('claims the server only with a name and a pairing code that could be one', () => {
    expect(canSubmitAuth(state({ mode: 'register', name: 'Ada', pairingCode: code }))).toBe(true);
    expect(canSubmitAuth(state({ mode: 'register', name: '  ', pairingCode: code }))).toBe(false);
    expect(canSubmitAuth(state({ mode: 'register', name: 'Ada', pairingCode: 'short' }))).toBe(
      false
    );
  });

  it('waits for the box to say what it is before claiming it', () => {
    expect(
      canSubmitAuth(state({ mode: 'register', name: 'Ada', pairingCode: code, serverKnown: false }))
    ).toBe(false);
  });

  it('recovers with a name and a recovery code, and does not want the pairing code', () => {
    expect(canSubmitAuth(state({ mode: 'recover', name: 'Ada', recoveryCode: code }))).toBe(true);
    expect(canSubmitAuth(state({ mode: 'recover', name: 'Ada', recoveryCode: 'short' }))).toBe(
      false
    );
    expect(
      canSubmitAuth(state({ mode: 'recover', name: 'Ada', recoveryCode: code, serverKnown: false }))
    ).toBe(true);
  });

  it('ignores whitespace pasted around a code', () => {
    expect(
      canSubmitAuth(state({ mode: 'recover', name: 'Ada', recoveryCode: `  ${code}  ` }))
    ).toBe(true);
    expect(
      canSubmitAuth(state({ mode: 'recover', name: 'Ada', recoveryCode: ' '.repeat(30) }))
    ).toBe(false);
  });
});

/*
 * Every device after the first gets in this way: a claimed box refuses registration outright, and
 * signing in needs a passkey the new device does not have yet. The grant is the whole credential
 * asked for here - the account exists and is already named.
 */
describe('adding a second device', () => {
  it('asks for the grant and nothing else', () => {
    expect(canSubmitAuth(state({ mode: 'enroll', pairingCode: code }))).toBe(true);
    expect(canSubmitAuth(state({ mode: 'enroll', pairingCode: 'short' }))).toBe(false);
    expect(canSubmitAuth(state({ mode: 'enroll', pairingCode: `  ${code}  ` }))).toBe(true);
  });

  it('waits for the box to say what it is', () => {
    expect(canSubmitAuth(state({ mode: 'enroll', pairingCode: code, serverKnown: false }))).toBe(
      false
    );
  });
});

describe('what the screen opens on once the box has answered', () => {
  /*
   * The installer prints a QR code that opens this page with a grant in the fragment, and it prints
   * it on a box that by definition has no owner yet. Enrolling there cannot work — the grant it
   * wants comes from a signed-in device — so the scan has to land on claiming the box.
   */
  it('claims an unclaimed box whether or not a grant came with the address', () => {
    expect(initialAuthMode({ registrationAvailable: true, grantInHand: true })).toBe('register');
    expect(initialAuthMode({ registrationAvailable: true, grantInHand: false })).toBe('register');
  });

  it('adds a device only once the box refuses registration', () => {
    expect(initialAuthMode({ registrationAvailable: false, grantInHand: true })).toBe('enroll');
  });

  it('leaves a claimed box with no grant where it opens, signing in', () => {
    expect(initialAuthMode({ registrationAvailable: false, grantInHand: false })).toBeUndefined();
  });
});

describe('what the sign-in screen says it is doing', () => {
  it('names the four things this one screen does', () => {
    expect(authHeading('login')).toBe('Sign in with your passkey');
    expect(authHeading('register')).toBe('Claim this server');
    expect(authHeading('recover')).toBe('Replace your passkey');
    expect(authHeading('enroll')).toBe('Add this device');
  });

  it('says what is being waited for while the passkey prompt is open', () => {
    for (const mode of ['login', 'register', 'recover', 'enroll'] as const)
      expect(authActionLabel(mode, true)).toBe('Waiting for passkey…');
    expect(authActionLabel('login', false)).toBe('Sign in securely');
    expect(authActionLabel('recover', false)).toBe('Create replacement passkey');
    expect(authActionLabel('enroll', false)).toBe('Add with passkey');
  });
});
