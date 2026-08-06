/**
 * The sign-in screen's decisions, which are the ones that decide whether anyone gets in.
 *
 * This is the only screen an owner sees before they have an account, and it does three different
 * things with the same two fields. What it asks for, what it will accept, and why the button is
 * dark were a five-clause boolean and three ternaries inside the markup.
 */
export type AuthMode = 'login' | 'register' | 'recover' | 'enroll';

/**
 * The pairing code the installer prints and the recovery code the box issues. Both are long random
 * strings; the length is checked here only to keep the button dark until something plausible has
 * been pasted, and the box is what actually decides.
 */
const CODE_MIN_LENGTH = 20;

export interface AuthFormState {
  mode: AuthMode;
  name: string;
  pairingCode: string;
  recoveryCode: string;
  busy: boolean;
  /**
   * Whether this box can hold a passkey at all. WebAuthn requires a registrable domain, so a box
   * reached by IP address cannot, and the screen says so with the command that fixes it.
   */
  passkeysUsable: boolean;
  /** Whether the box has answered with what it is. Claiming it before then would guess at it. */
  serverKnown: boolean;
}

/**
 * Whether the form is ready to be sent. Enter and the button ask the same question.
 *
 * Adding a device asks for the grant and nothing else. The account already exists and is already
 * named, so a name field there would be asking the owner to retype something the box knows and
 * would refuse to change.
 */
export const canSubmitAuth = (state: AuthFormState): boolean => {
  if (state.busy || !state.passkeysUsable) return false;
  if (state.mode === 'login') return true;
  if (state.mode === 'enroll')
    return state.serverKnown && state.pairingCode.trim().length >= CODE_MIN_LENGTH;
  if (!state.name.trim()) return false;
  if (state.mode === 'recover') return state.recoveryCode.trim().length >= CODE_MIN_LENGTH;
  return state.serverKnown && state.pairingCode.trim().length >= CODE_MIN_LENGTH;
};

/** What this screen is for, right now. */
export const authHeading = (mode: AuthMode): string =>
  mode === 'login'
    ? 'Sign in with your passkey'
    : mode === 'register'
      ? 'Claim this server'
      : mode === 'enroll'
        ? 'Add this device'
        : 'Replace your passkey';

/** What the button does, said as the thing it does rather than as the mode it is in. */
export const authActionLabel = (mode: AuthMode, busy: boolean): string =>
  busy
    ? 'Waiting for passkey…'
    : mode === 'login'
      ? 'Sign in securely'
      : mode === 'register'
        ? 'Create with passkey'
        : mode === 'enroll'
          ? 'Add with passkey'
          : 'Create replacement passkey';
