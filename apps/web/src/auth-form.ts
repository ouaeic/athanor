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
  /** Whether the box has exactly one account, in which case recovery needs no name to find it. */
  singleOwner?: boolean;
}

/**
 * Which of the four things this screen is doing, decided the moment the box says what it is.
 *
 * Whether the box has an owner decides it, not how the grant arrived. Enrolment used to win
 * whenever anything had been scanned, which was written when the only QR code in existence came
 * from the settings screen of a box that already had an owner. The installer now prints one too,
 * and on an unclaimed box enrolling is the single thing that cannot work — the grant it wants is
 * minted by a signed-in device, and there is none. So a scan that was meant to be the first five
 * minutes ended on a screen asking for something that does not exist yet.
 *
 * Nothing back means leave the screen where it opens, signing in.
 */
export const initialAuthMode = (input: {
  registrationAvailable: boolean;
  /** A grant already in hand, from a scanned code or from the native client's bootstrap. */
  grantInHand: boolean;
}): AuthMode | undefined =>
  input.registrationAvailable ? 'register' : input.grantInHand ? 'enroll' : undefined;

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
  // Recovery on a single-owner box asks for the code and nothing else: there is one account to
  // find, and the name was a display name typed once at setup, being asked for months later on the
  // one day the owner has already lost every passkey.
  if (state.mode === 'recover' && state.singleOwner)
    return state.recoveryCode.trim().length >= CODE_MIN_LENGTH;
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
