/**
 * The one-time grant inside a device link.
 *
 * A box that already has an owner refuses registration outright, so a second device gets in by
 * redeeming a grant that an already-signed-in device minted: the settings screen mints one, draws
 * it as a QR code and offers the link to copy. The link is `athanor://pair/<base64url(JSON)>`,
 * which is the shape the native client parses — and the person adding a phone or a second laptop
 * pastes exactly that string, because it is the only thing they were given.
 *
 * So both forms are accepted and reduced to the same thing: the grant. Nothing here trusts the rest
 * of the ticket — the endpoints, the identity and the discovery hints in it are the native client's
 * business, and a browser that is already talking to this box has no use for a stranger's idea of
 * where the box lives.
 */

const PREFIX = 'athanor://pair/';
/** The server mints 32 random bytes as base64url; the bound only rejects what cannot be one. */
const MIN_TOKEN = 20;
const MAX_TOKEN = 200;
/** A ticket is a few hundred bytes of JSON. Anything of this size is not one. */
const MAX_LINK = 8_192;

const usableToken = (value: unknown): string =>
  typeof value === 'string' && value.trim().length >= MIN_TOKEN && value.trim().length <= MAX_TOKEN
    ? value.trim()
    : '';

/**
 * The grant a pasted device link carries, or the empty string when there is not one in it.
 *
 * A bare code is returned as it stands: the installer prints one for the first owner, and the
 * native client hands one over directly, so the same field on the sign-in screen takes all three.
 */
export const deviceEnrollmentToken = (value: string): string => {
  const link = value.trim();
  if (link.length > MAX_LINK) return '';
  if (!link.toLowerCase().startsWith(PREFIX)) return usableToken(link);
  const encoded = link.slice(PREFIX.length).split(/[?#/]/)[0] ?? '';
  if (!encoded) return '';
  try {
    // base64url is not what atob reads, and a ticket routinely lands on a length that needs the
    // padding it never carries.
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const ticket: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
      )
    );
    return ticket && typeof ticket === 'object' && !Array.isArray(ticket)
      ? usableToken((ticket as { pairingCode?: unknown }).pairingCode)
      : '';
  } catch {
    // A mistyped link is not an error to report at this level: the button stays dark, which is the
    // same answer the screen gives to a half-pasted code.
    return '';
  }
};
