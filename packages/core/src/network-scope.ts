import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * One answer to "is this address out on the internet, or is it something of ours". Every fetch the
 * server or the agent makes on behalf of untrusted input has to ask it - a connector endpoint, a
 * page the agent was told to read, a browser navigation - and answering it in three places is how
 * one of them ends up missing 169.254.0.0/16 and handing out the instance credentials.
 *
 * Everything reserved is refused rather than only the obviously local ranges: documentation and
 * benchmarking blocks are not routable, so a name resolving to one is a redirection trick rather
 * than a destination.
 */
const isPublicIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where cloud metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
};

/**
 * Global unicast, decided by subnet arithmetic rather than by how the address is spelled.
 *
 * Allowed by inclusion: 2000::/3 is the internet and nothing else is, so listing the bad prefixes
 * instead would leave every block IANA has not yet assigned reachable until somebody remembered to
 * add it. That part was already right; how it was decided was not. `startsWith('2')` is a test on
 * text, and `2::1` - which is 0002:: and nowhere near 2000::/3 - passes it.
 */
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');

/**
 * Inside global unicast and still not a destination.
 *
 * 6to4 and Teredo are the ones that matter, and they are the exact thing this file exists to stop:
 * both carry an IPv4 address in their own bits, so `2002:a9fe:a9fe::` is a spelling of
 * 169.254.169.254 - the cloud metadata service - that walks through a check looking only at the
 * front of the string. A relay that honours them turns one refused address into a reachable one.
 */
const RESERVED_WITHIN_UNICAST = new BlockList();
RESERVED_WITHIN_UNICAST.addSubnet('2001::', 32, 'ipv6'); // Teredo, carries an IPv4 address
RESERVED_WITHIN_UNICAST.addSubnet('2002::', 16, 'ipv6'); // 6to4, carries an IPv4 address
RESERVED_WITHIN_UNICAST.addSubnet('2001:db8::', 32, 'ipv6'); // documentation, not routable
RESERVED_WITHIN_UNICAST.addSubnet('2001:10::', 28, 'ipv6'); // ORCHID, not routable
RESERVED_WITHIN_UNICAST.addSubnet('2001:2::', 48, 'ipv6'); // benchmarking

export const isPublicInternetAddress = (raw: string): boolean => {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicIpv4(mapped);
  return (
    GLOBAL_UNICAST.check(address, 'ipv6') && !RESERVED_WITHIN_UNICAST.check(address, 'ipv6')
  );
};

/**
 * "Is this host one the deployment allows" - the suffix match every connector asks before it lets
 * a credential leave. It lives here beside the address checks so that mail, WebDAV and MCP cannot
 * drift into three subtly different ideas of what `example.com` covers.
 */
export const hostMatchesSuffix = (host: string, suffixes: string[]): boolean =>
  suffixes.some((suffix) => {
    const normalized = suffix.trim().toLowerCase().replace(/^\./, '');
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
  });

/** Names that resolve inside the machine or the estate even though they are not IP literals. */
const isInternalHostname = (host: string): boolean =>
  !host ||
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host === 'metadata.google.internal' ||
  host.endsWith('.local') ||
  host.endsWith('.internal') ||
  host.endsWith('.home.arpa');

/**
 * Rejects `file:`, `chrome:` and every other scheme before the host is even considered: a reader
 * that only guards addresses still hands over /etc/passwd.
 */
export const isPublicHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isInternalHostname(host)) return false;
    return !isIP(host) || isPublicInternetAddress(host);
  } catch {
    return false;
  }
};

/**
 * The syntactic check plus the one it cannot make: a name the caller controls can point anywhere,
 * so every address it resolves to has to be public before the request is allowed to leave. Callers
 * that then make the request themselves must pin these addresses or re-check after redirects -
 * resolving twice is a race an attacker gets to win.
 */
export const assertPublicHttpUrl = async (raw: string): Promise<void> => {
  if (!isPublicHttpUrl(raw)) throw new Error('Address is not a public HTTP(S) URL');
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicInternetAddress(address)))
    throw new Error('Address resolves to a private, reserved, or local address');
};
