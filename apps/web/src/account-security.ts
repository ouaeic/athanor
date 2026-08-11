export interface PasskeySummary {
  id: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
}

/**
 * The server refuses to delete the final passkey, because a self-hosted account with no sign-in
 * method left is unrecoverable. Knowing that here means the control is explained rather than
 * offered and then rejected.
 */
export const passkeyRemovable = (passkeys: PasskeySummary[], id: string): boolean =>
  passkeys.length > 1 && passkeys.some((item) => item.id === id);

/** One line naming the credential, since an authenticator has no name of its own. */
export const passkeyLabel = (passkey: PasskeySummary): string => {
  const kind = passkey.deviceType === 'multiDevice' ? 'Synced' : 'Device-bound';
  return `${kind} passkey · added ${new Date(passkey.createdAt).toLocaleDateString()}`;
};

/** The server's own word for "this session's passkey confirmation is older than five minutes". */
const stepUpRequired = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  String(cause.code) === 'step_up_required';

/**
 * A settings write, with the passkey confirmation the server may ask for folded in.
 *
 * Which routes sit behind step-up is the server's decision, and it is not one the client can read:
 * `PUT /v1/spend-limits` asks only when a cap is being raised or cleared, and `DELETE
 * /v1/sessions/:id` asks always. Neither client path asked, so more than five minutes after signing
 * in, raising a spending cap and signing a lost device out both failed - and the only thing on
 * screen was the server's instruction to confirm with a passkey, with no control that would.
 *
 * Asking the server first and confirming only when it refuses is what keeps this from becoming a
 * prompt on every save: no route is asked more than it asks for, and each new sensitive route is
 * covered without having to remember. Once, because a second refusal is the confirmation failing
 * rather than a stale window.
 */
export const withStepUp = async (
  operation: () => Promise<void>,
  stepUp: () => Promise<void>
): Promise<void> => {
  try {
    await operation();
  } catch (cause) {
    if (!stepUpRequired(cause)) throw cause;
    await stepUp();
    await operation();
  }
};

/**
 * Turns a failed security action into something the owner can act on. `last_passkey` and
 * `confirmation_failed` are both ordinary outcomes with an obvious next step, and a generic
 * "could not be saved" hides it.
 */
export const securityActionMessage = (cause: unknown): string => {
  const code =
    cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'request_failed';
  const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
  // A route this server has never had answers in Fastify's own shape, with no athanor code in it.
  // "Request failed (404)" reads as a bug in the screen rather than as a server that is behind.
  if (status === 404 && code === 'request_failed')
    return 'This server is older than this screen and has no route for that yet. Update athanor and try again.';
  if (code === 'last_passkey')
    return 'This is the only way left to sign in. Add another passkey first, then remove this one.';
  if (code === 'confirmation_failed') return 'That did not match. Type the exact username.';
  if (code === 'step_up_failed') return 'Passkey verification did not complete. Try again.';
  // Reached only when the ceremony ran and the server still refused, so the server's own sentence -
  // "Confirm this sensitive action with your passkey" - is an instruction with no control attached
  // and no way to follow it. Say what happened and what the owner does next.
  if (code === 'step_up_required')
    return 'Your passkey confirmation did not land. Try again and approve the prompt.';
  return cause instanceof Error && cause.message ? cause.message : 'The change could not be saved';
};

/** Deleting the account is irreversible, so the control stays inert until the name matches. */
export const accountDeletionArmed = (typed: string, username: string): boolean =>
  typed.trim().length > 0 && typed.trim().toLowerCase() === username.toLowerCase();
