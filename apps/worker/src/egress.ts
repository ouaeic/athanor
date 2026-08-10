import { isPublicHttpUrl, matchingHostSuffix } from '@athanor/core';
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
  /**
   * Whole addresses this turn was handed - by a search, or as the page a read actually landed on.
   *
   * Only the host used to survive a result, so following the third link a search returned scored
   * its whole path as novel material even though the harness itself had just put that path in front
   * of the model. Under a per-request bound that was merely untidy; under a running budget it would
   * be the difference between a research pass that costs nothing and one that stops to ask after
   * seventeen pages. These come from the harness's own reading of a tool result, never from what a
   * page said, so an attacker can add addresses the agent has already been to and nothing else.
   */
  readonly knownAddresses?: readonly string[];
  /** The owner's own words this task; material already in them is not novel. */
  readonly ownerText: string;
  /** This installation's own address, which is not somewhere data can be sent to. */
  readonly selfOrigins?: readonly string[];
  /**
   * What this turn has already sent that appears nowhere the owner put it, in bytes.
   *
   * Absent means nothing has left yet. The per-address bound below is a bound on one request, and
   * a request is not the unit an attacker is limited to: measured against the shipped classifier,
   * a 2,048-byte secret left in twenty-two addresses that were each individually under it and each
   * individually judged clean, because the count was computed, reported and then added to nothing.
   */
  readonly spentNoveltyBytes?: number;
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

/**
 * How much material the *name* may carry beyond the part that was already allowed.
 *
 * The bound above was measured on the path, the query and the fragment only, so the one part of an
 * address that needs no cooperation from the destination at all was not measured: with
 * `docs.example.com` already read, `https://<32 hex characters>.docs.example.com/` scored zero
 * novel bytes and left without a card - a working exfiltration channel out of a host the turn was
 * legitimately sent to, needing nothing but a wildcard DNS record and a log.
 *
 * Small on purpose, because a subdomain is a word. `support`, `blog`, `cdn`, `eu-west-1.api` are
 * all comfortably under it; sixteen bytes of hex are not, and the ones short enough to slip under
 * are charged to the turn budget like everything else.
 */
export const MAX_NOVEL_HOST_BYTES = 24;

/**
 * How much novel material may leave in total while untrusted content is in the turn.
 *
 * This is what makes the per-address bound mean anything: without it the bound was a bound on the
 * size of a chunk rather than on the size of what leaves. It is charged only while the turn is
 * tainted, so an ordinary research pass never touches it - a link followed out of a search result
 * costs a handful of bytes, and this is a kilobyte.
 *
 * Exceeding it is a card, not a refusal. The owner can still say yes; the point is that they are
 * asked once the material leaving stops looking like addresses.
 */
export const MAX_TURN_NOVEL_BYTES = 1_024;

const MAX_KNOWN_ORIGINS = 64;

/**
 * Bounded the same way and for the same reason as the hosts, but deep enough to outlast a search.
 *
 * `web_search` hands back twelve addresses by default and may be asked for fifty, so a bound of
 * thirty-two was spent inside three searches: the fourth evicted the first, and reading a page the
 * harness had itself put in front of the model then scored its whole path as novel material. The
 * budget below is a kilobyte and a real documentation path costs forty to sixty bytes of it, so
 * that eviction was worth roughly twenty pages of the budget - it would have turned the deep
 * unattended research turn this product exists for into a turn that stops to ask. Sixteen searches
 * deep, and at worst a few tens of kilobytes of the trajectory.
 */
const MAX_KNOWN_ADDRESSES = 192;
const MAX_ADDRESS_CHARS = 256;

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

/** Adds a whole address the turn was handed, newest last, so following it later is not novel. */
export const rememberAddress = (known: string[], value: string): string[] => {
  const address = value.trim().slice(0, MAX_ADDRESS_CHARS);
  if (!originOf(address) || known.includes(address)) return known;
  const next = [...known, address];
  return next.length > MAX_KNOWN_ADDRESSES ? next.slice(next.length - MAX_KNOWN_ADDRESSES) : next;
};

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

/** The labels a name adds in front of the part that was already allowed. */
const labelsBeyond = (host: string, suffix: string): string[] =>
  (host === suffix ? '' : host.slice(0, host.length - suffix.length - 1))
    .split('.')
    .filter(Boolean);

/** How much of these tokens appears nowhere the owner or an already-read page put it. */
const novelBytes = (tokens: readonly string[], corpus: string): number =>
  tokens
    .filter((token) => !corpus.includes(token.toLowerCase()))
    .reduce((total, token) => total + token.length, 0);

/**
 * Adds what one address carried to what this turn has already sent.
 *
 * Charged where the request is judged rather than where it is written, so the two can never
 * disagree about what a call reaches: an address the classifier did not see is an address the
 * budget does not know about.
 */
export const chargeNovelty = (spent: number, verdicts: readonly DestinationVerdict[]): number =>
  verdicts.reduce((total, verdict) => total + verdict.noveltyBytes, spent);

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
  /*
   * Somewhere data cannot go is not somewhere data can be sent.
   *
   * This asked the owner to approve the agent reading its own web server. A single "build a page
   * and serve it" run raised ten approval cards, and every one of them was athanor talking to
   * itself: four to `localhost:8080`, three to its own preview URL on its own domain. Nothing left
   * the machine in any of them, and the owner learned to click Approve without reading - which is
   * the only way this rule can actually fail.
   *
   * Loopback and the private ranges are decided by `isPublicHttpUrl` in core rather than by a
   * second opinion held here, because a spelling that walks past one of two lists is exactly how
   * this class of check breaks. Publishing something to the internet is still gated, on the tool
   * that does it: `publish_site` raises its own card and this is not a way round it.
   */
  if (!isPublicHttpUrl(url.toString())) return { sink: false, host, noveltyBytes: 0, reason: '' };
  if ((context.selfOrigins ?? []).some((origin) => origin && host === origin.toLowerCase()))
    return { sink: false, host, noveltyBytes: 0, reason: '' };
  // Compared case-insensitively and without the separators a URL adds, so a path segment that the
  // owner wrote as two words still counts as theirs.
  const corpus =
    `${context.ownerText}\n${context.knownOrigins.join('\n')}\n${(context.knownAddresses ?? []).join('\n')}`.toLowerCase();
  const addressNovelty = novelBytes(addressTokens(url), corpus);
  const matched = matchingHostSuffix(host, context.knownOrigins);
  if (!matched)
    return {
      sink: true,
      host,
      noveltyBytes: addressNovelty + novelBytes(host.split('.'), corpus),
      reason: `${host} is not a host the user named, a search returned, or this turn has already read`
    };
  /*
   * The name is measured too, against the part of it that was already allowed.
   *
   * `isKnownOrigin` answered yes for anything ending in an allowed suffix and nothing then looked
   * at what came in front of it, so every host already read this turn was also a wildcard channel
   * out. Held to its own, much smaller bound rather than folded into the address one: a real
   * subdomain is a word and cannot use the room a long legitimate path needs.
   */
  const hostNovelty = novelBytes(labelsBeyond(host, matched), corpus);
  const noveltyBytes = addressNovelty + hostNovelty;
  if (hostNovelty > MAX_NOVEL_HOST_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `the name ${host} puts ${hostNovelty} bytes in front of ${matched} that appear nowhere in the user's request or in a page already read`
    };
  if (noveltyBytes > MAX_NOVEL_URL_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `this address carries ${noveltyBytes} bytes that appear nowhere in the user's request or in a page already read`
    };
  const spent = Math.max(0, context.spentNoveltyBytes ?? 0);
  if (spent + noveltyBytes > MAX_TURN_NOVEL_BYTES)
    return {
      sink: true,
      host,
      noveltyBytes,
      reason: `this turn has already sent ${spent} bytes that appear nowhere in the user's request, and ${noveltyBytes} more here is past the ${MAX_TURN_NOVEL_BYTES} allowed while untrusted content is in the turn`
    };
  return { sink: false, host, noveltyBytes, reason: '' };
};
