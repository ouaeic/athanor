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
  if (!link.toLowerCase().startsWith(PREFIX)) {
    // A ticket on its own, which is what a scanned QR code leaves in the address fragment. Tried
    // before the bare-code path because a ticket is far longer than a grant and would otherwise be
    // rejected on length and reported as "not a link" — the one case where the owner did nothing
    // wrong at all.
    const fromTicket = grantInTicket(link);
    return fromTicket || usableToken(link);
  }
  const encoded = link.slice(PREFIX.length).split(/[?#/]/)[0] ?? '';
  return grantInTicket(encoded);
};

const grantInTicket = (encoded: string): string => {
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

/**
 * The grant a scanned QR code left in the address fragment, and a function to take it back out.
 *
 * The code encodes an ordinary `https://` address at this box, because that is the only kind a
 * phone's camera will open — an `athanor://` code scans to nothing at all unless the native client
 * is already installed, which on the device being added it is not. The ticket rides in the fragment
 * rather than the path or the query, so it is never sent to the server in a request line and never
 * reaches an access log or a proxy.
 *
 * `clear` replaces the entry instead of pushing one, so a one-time grant does not sit in the address
 * bar or come back with the Back button.
 */
const PAIR_FRAGMENT = 'pair=';

/** The grant a scanned code left in `location.hash`, or nothing when the fragment is not one. */
export const grantInPairingFragment = (hash: string): string => {
  const value = hash.replace(/^#/, '');
  if (!value.startsWith(PAIR_FRAGMENT)) return '';
  return deviceEnrollmentToken(decodeURIComponent(value.slice(PAIR_FRAGMENT.length)));
};

/**
 * Whether the address is carrying a pairing fragment at all, which is a different question from
 * whether the grant in it is any good: a mistyped one still has to come out of the address bar.
 */
export const isPairingFragment = (hash: string): boolean =>
  hash.replace(/^#/, '').startsWith(PAIR_FRAGMENT);
