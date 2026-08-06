/**
 * Where a request is allowed to go once untrusted content is in the turn.
 *
 * `network-scope.ts` in core answers one question - is this address on the public internet - which
 * stops SSRF against a metadata service and stops nothing else. The read tools take a complete URL
 * and raise no approval, so an attacker who has landed an instruction has a clean GET channel: put
 * the owner's secret in a path segment and read the attacker's page. That is the third leg of the
 * lethal trifecta, and it survives every fix to the chat client because it is a tool call rather
 * than a rendered image.
 *
 * The rule here is deliberately about provenance and volume rather than about reputation. There is
 * no blocklist to keep current and no attempt to recognise a malicious host: a destination is
 * ordinary if the owner named it, a search returned it, or this turn has already read it, and the
 * address itself carries no more novel material than a real URL needs. Everything else is shown to
 * the owner before it is fetched, with the host and the byte count computed here rather than taken
 * from anything the model wrote.
 *
 * It only applies while the turn is tainted. A clean research task reads whatever it likes.
 */

export interface DestinationContext {
  /** Hosts the owner named, a search returned, or a page already read this turn resolved to. */
  readonly knownOrigins: readonly string[];
  /** The owner's own words this task; material already in them is not novel. */
  readonly ownerText: string;
}

export interface DestinationVerdict {
  readonly sink: boolean;
  readonly host: string;
  readonly noveltyBytes: number;
  /** Why it is a sink, in the words the approval card uses. Empty when it is not one. */
  readonly reason: string;
}

/**
 * How much material an address may carry that appears nowhere the owner put it.
 *
 * This is the number that turns "exfiltrate a mailbox" into "exfiltrate a bit at a time": a base64
 * payload is one long token and trips it immediately, while a real deep link - a docs path, a slug,
 * a tracking parameter - is comfortably under it.
 */
export const MAX_NOVEL_URL_BYTES = 96;

const MAX_KNOWN_ORIGINS = 64;

export const originOf = (value: string): string => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Adds a host to the known set, newest last, bounded so a long task cannot grow it forever. */
export const rememberOrigin = (known: string[], value: string): string[] => {
  const host = originOf(value);
  if (!host || known.includes(host)) return known;
  const next = [...known, host];
  return next.length > MAX_KNOWN_ORIGINS ? next.slice(next.length - MAX_KNOWN_ORIGINS) : next;
};

const isKnownOrigin = (host: string, known: readonly string[]): boolean =>
  known.some((origin) => host === origin || host.endsWith(`.${origin}`));

/**
 * The parts of an address that could carry a payload: path segments, query names and query values,
 * and the fragment. The host is judged separately, and the scheme carries nothing.
 */
const addressTokens = (url: URL): string[] => {
  const raw = [
    ...url.pathname.split('/'),
    ...[...url.searchParams].flatMap(([name, value]) => [name, value]),
    url.hash.replace(/^#/, '')
  ];
  return raw
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .map((part) => part.trim())
    .filter(Boolean);
};

export const classifyDestination = (
  value: string,
  context: DestinationContext
): DestinationVerdict => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      sink: true,
      host: 'unparseable address',
      noveltyBytes: value.length,
      reason: 'this address could not be parsed'
    };
  }
  if (!['http:', 'https:'].includes(url.protocol))
    return {
      sink: true,
      host: url.protocol.replace(':', ''),
      noveltyBytes: value.length,
      reason: `the ${url.protocol.replace(':', '')} scheme is not a web read`
    };
  const host = url.hostname.toLowerCase();
  // Compared case-insensitively and without the separators a URL adds, so a path segment that the
  // owner wrote as two words still counts as theirs.
  const corpus = `${context.ownerText}\n${context.knownOrigins.join('\n')}`.toLowerCase();
  const noveltyBytes = addressTokens(url)
    .filter((token) => !corpus.includes(token.toLowerCase()))
    .reduce((total, token) => total + token.length, 0);
  if (!isKnownOrigin(host, context.knownOrigins))
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `${host} is not a host the user named, a search returned, or this turn has already read`
    };
  if (noveltyBytes > MAX_NOVEL_URL_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `this address carries ${noveltyBytes} bytes that appear nowhere in the user's request or in a page already read`
    };
  return { sink: false, host, noveltyBytes, reason: '' };
};

/** Every destination in one call that the policy would stop, in the order they were requested. */
export const sinkDestinations = (
  urls: readonly string[],
  context: DestinationContext
): DestinationVerdict[] =>
  urls
    .map((url) => classifyDestination(url, context))
    .filter((verdict): verdict is DestinationVerdict => verdict.sink);
