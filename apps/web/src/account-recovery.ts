/**
 * The file offered on the recovery screen. It is written to say, on its own, what the string is
 * and why it matters — the person who opens it months later will not have the screen in front of
 * them, and a stale copy of an older code is worse than no copy at all, so it says which one it is.
 */
export const recoveryFile = (
  code: string,
  issuedAt = new Date()
): { name: string; type: string; text: string } => ({
  name: 'athanor-recovery-code.txt',
  type: 'text/plain',
  text: [
    'athanor recovery code',
    code,
    '',
    `Issued ${issuedAt.toISOString().slice(0, 10)}.`,
    'Keep this file somewhere only you can reach.',
    'It replaces every passkey on this account.',
    'Issuing a new code from Settings retires this one, so keep only the newest file.',
    ''
  ].join('\n')
});
