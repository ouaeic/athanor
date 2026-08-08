import path from 'node:path';
import { access, mkdir, rm } from 'node:fs/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Download,
  type Frame,
  type Locator,
  type Page,
  type Response as PageResponse
} from 'playwright-core';
import type {
  BrowserAction,
  BrowserPrimitiveAction,
  ParallelWebReadResult,
  ResearchReadSource
} from '@athanor/contracts';
import { assertPublicHttpUrl, isPublicHttpUrl, isPublicInternetAddress } from '@athanor/core';
import {
  assertUserDataPath,
  clearStagedUploads,
  stageUserFileForUpload,
  writeWorkspaceFile
} from './files.js';
import {
  duckDuckGoSearchUrl,
  readSearchRows,
  searchResults,
  searchRoutePlan,
  SEARCH_ENGINE,
  SEARCH_WALL_BACKOFF_MS,
  type SearchRoute,
  type WebSearchResult
} from './search.js';

export interface BrowserStreamState {
  url: string;
  title: string;
  holder: 'agent' | 'user' | 'secure_input';
  width: number;
  height: number;
  transport: 'chromium_screencast';
  /**
   * The challenge currently waiting for a person, on whichever tab raised it. It rides the stream
   * because a wall is the one browser state nobody can act on but the owner, and the pane is where
   * they are: without it the agent stops on a page nobody is looking at and nothing says so.
   */
  botWall: BotWallReport | null;
}

interface BrowserStreamSubscriber {
  state: (state: BrowserStreamState) => void;
  frame: (frame: Buffer, state: BrowserStreamState) => void;
}

interface BrowserStream {
  cdp: CDPSession;
  subscribers: Set<BrowserStreamSubscriber>;
}

export interface BrowserDownloadRecord {
  /** Workspace-relative, so the agent and the file browser name the file the same way. */
  path: string | null;
  url: string;
  error?: string;
}

interface Session {
  context: BrowserContext;
  page: Page;
  /** The workspace this session belongs to, so shutting it down can clean up after it. */
  root: string;
  /**
   * Stable tab identity. Playwright only offers positional access to context.pages(), and a
   * position changes whenever any other tab closes - so an agent that opened a reference tab,
   * did some work, and came back would act on whatever had shifted into that slot. Ids are
   * minted once per page and never reused, so a stale id fails loudly instead of hitting the
   * wrong page.
   */
  tabs: Map<string, Page>;
  nextTabId: number;
  holder: 'agent' | 'user' | 'secure_input';
  /** The challenges standing in this browser: which tab is stopped, and which sites are closed. */
  walls: BotWallLedger;
  pendingDialog?: Dialog;
  consoleMessages: Array<{ level: string; text: string; url: string; at: string }>;
  stream?: BrowserStream;
  downloadsDirectory: string;
  downloads: BrowserDownloadRecord[];
  pendingDownloads: Set<Promise<void>>;
}

interface ElementPolicyInput {
  tag: string;
  type: string;
  name: string;
  autocomplete: string;
  formAction: string;
  inForm: boolean;
}

export interface BrowserActionPreflight {
  consequential: boolean;
  sensitiveInput: boolean;
  preview: string;
}

export interface BrowserSelectOption {
  value: string;
  label: string;
  selected: boolean;
}

/**
 * Everything needed to tell one form field from another and to read back what is in it.
 * The optional members are omitted rather than emitted empty: a snapshot carries up to 250 of
 * these through a truncated tool result, so a key that says nothing costs a control the agent
 * could otherwise have reached.
 */
export interface BrowserSnapshotElement {
  index: number;
  selector: string;
  tag: string;
  role: string | null;
  /** Accessible name: aria-label, aria-labelledby, `<label>`, placeholder, title, then text. */
  name: string;
  type: string | null;
  href: string | null;
  id?: string;
  /** The submitted `name` attribute, which is what a site's own validation messages refer to. */
  field?: string;
  /** Present on every value-bearing control, empty string included: "still empty" is an answer. */
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  invalid?: boolean;
  /** aria-describedby and aria-errormessage text: the hint or the error the site is showing. */
  description?: string;
  options?: BrowserSelectOption[];
}

export interface BrowserTabSummary {
  tabId: string;
  active: boolean;
  url: string;
  title: string;
}

export interface BrowserSnapshotParts {
  url: string;
  title: string;
  holder: 'agent' | 'user' | 'secure_input';
  botWall: BotWallReport | null;
  elements: BrowserSnapshotElement[];
  tabs: BrowserTabSummary[];
  downloads: BrowserDownloadRecord[];
  pendingDialog: { type: string; message: string } | null;
  consoleMessages: Array<{ level: string; text: string; url: string; at: string }>;
  images: Array<{ url: string; alt: string; width: number; height: number }>;
  screenshotBase64: string;
  text: string;
}

// The worker truncates a serialized tool result to a fixed budget, keeping the head and
// the tail, so a long page body placed early destroys everything after it. Page text is
// therefore emitted last and bounded, leaving the actionable fields intact.
export const BROWSER_SNAPSHOT_TEXT_LIMIT = 12_000;

export const composeBrowserSnapshot = (parts: BrowserSnapshotParts): BrowserSnapshotParts => ({
  url: parts.url,
  title: parts.title,
  holder: parts.holder,
  botWall: parts.botWall,
  elements: parts.elements,
  tabs: parts.tabs,
  downloads: parts.downloads,
  pendingDialog: parts.pendingDialog,
  consoleMessages: parts.consoleMessages,
  images: parts.images,
  screenshotBase64: parts.screenshotBase64,
  text: parts.text.slice(0, BROWSER_SNAPSHOT_TEXT_LIMIT)
});

/** Popups must not steal the agent's page; adopt one only once the current page is gone. */
export const shouldAdoptNewPage = (current: Pick<Page, 'isClosed'> | undefined): boolean =>
  !current || current.isClosed();

/** How long an action waits for a download it started before reporting without it. */
const DOWNLOAD_SETTLE_MS = 15_000;
const DOWNLOAD_START_GRACE_MS = 250;
const DOWNLOAD_HISTORY_LIMIT = 25;
const SNAPSHOT_FRAME_LIMIT = 12;
const SNAPSHOT_ELEMENT_LIMIT = 250;

/**
 * Ref numbers are handed out from a counter that never rewinds, so a number names one control until
 * that control leaves the page.
 *
 * The scan used to clear every `data-athanor-ref` in the whole document and then re-stamp from zero
 * inside whatever scope it had been given. A scoped re-read - which is the cheap loop the
 * form-filling procedure teaches - therefore silently re-pointed every ref the agent was holding:
 * `oc-0-3` had been Submit and became Postcode, and the next click landed on a different control
 * with nothing anywhere reporting that anything had changed. It is the highest-frequency silent
 * wrong action the product had.
 *
 * A counter costs nothing and removes the whole class: an element that already carries a ref keeps
 * it, a new element gets a number never used before, and a number that has gone is simply gone.
 */
let nextRefNumber = 0;
const reserveRefBlock = (size: number): number => {
  const seed = nextRefNumber;
  nextRefNumber += Math.max(0, size);
  return seed;
};
/**
 * Labels are scanned so their text can be folded onto the control they name, and so a control a
 * site has hidden behind a styled label still has a handle. Most of them are dropped again once
 * folded, so the scan takes this much headroom over the caller's budget to spend on them.
 */
const LABEL_FOLD_OVERSCAN = 64;
const INTERACTIVE_ELEMENT_QUERY =
  'a[href],button,input,textarea,select,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="combobox"],[contenteditable="true"]';

/**
 * The downloading site chooses this name, so it is hostile input: reduce it to one plain
 * filename component that cannot climb out of the session's download directory.
 */
export const downloadFileName = (suggested: string): string => {
  const segment = path.basename(suggested.replace(/\\/g, '/'));
  const cleaned = segment
    // eslint-disable-next-line no-control-regex -- control characters are exactly what to strip.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120) || 'download';
};

const uniqueDownloadName = async (directory: string, name: string): Promise<string> => {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length) || 'download';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${extension}`;
    try {
      await access(path.join(directory, candidate));
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${extension}`;
};

/** The frame ordinal baked into a snapshot ref, used as the first place to look for it. */
export const refFrameOrdinal = (selector: string): number | null => {
  const ordinal = /data-athanor-ref="oc-(\d+)-\d+"/.exec(selector)?.[1];
  return ordinal === undefined ? null : Number(ordinal);
};

/**
 * page.locator() only sees the main frame, so a control inside a payment or consent iframe is
 * otherwise unreachable. Playwright exposes every frame — including cross-origin ones — as a
 * first-class frame, so the ref is looked up frame by frame, preferring the frame it was
 * scanned from. The main-frame locator remains the fallback so a ref for an element that has
 * not rendered yet still gets Playwright's normal auto-waiting.
 */
export const resolveBrowserTarget = async (page: Page, selector: string): Promise<Locator> => {
  const frames = page.frames();
  const preferredOrdinal = refFrameOrdinal(selector);
  // A hand-written selector is the caller's own, and Playwright's auto-wait is exactly what it
  // wants: the element may not have rendered yet. Only a ref this scan minted is held to the rules
  // below, because only a ref carries the promise that it names one particular control.
  if (preferredOrdinal === null) return page.locator(selector).first();
  const preferred = frames[preferredOrdinal];
  const ordered = preferred
    ? [preferred, ...frames.filter((frame) => frame !== preferred)]
    : frames;
  for (const frame of ordered) {
    const locator = frame.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 1) return locator;
    // Two elements answering to one ref means the page moved a node between frames, or a document
    // was re-rendered while the scan was reading it. Acting on `.first()` is a coin toss on the
    // owner's behalf, and the recoverable answer is to look again.
    if (count > 1)
      throw new Error(
        `${selector} matches ${count} elements, so it no longer names one control - snapshot the page again`
      );
  }
  // A ref that has gone is the ordinary consequence of the page moving on. Said plainly and
  // immediately, rather than spending the turn's clock inside Playwright's auto-wait for an element
  // that is never coming back.
  throw new Error(`${selector} is no longer on the page - snapshot it again to get current refs`);
};

export type ScannedElement = Omit<BrowserSnapshotElement, 'index' | 'selector'> & { ref: string };

/**
 * One element exactly as the page reports it. The page does extraction only — every judgement
 * about what to keep, what to name it and what to redact is made here in the runner, where it
 * can be tested without a browser.
 */
export interface RawScannedElement {
  ref: string;
  tag: string;
  role: string | null;
  ariaLabel: string;
  labelledByText: string;
  labelText: string;
  placeholder: string;
  title: string;
  text: string;
  type: string | null;
  href: string | null;
  elementId: string;
  fieldName: string;
  /** Whether this element holds a value at all, which is not the same as holding a non-empty one. */
  valueBearing: boolean;
  value: string;
  password: boolean;
  checked: boolean | null;
  disabled: boolean;
  required: boolean;
  maxLength: number | null;
  pattern: string;
  invalid: boolean;
  description: string;
  options: BrowserSelectOption[] | null;
  /** For a `<label>`, the ref of the control it names, when that control was scanned too. */
  labelFor: string | null;
}

/**
 * Page text arrives with the source's own line breaks and indentation in it. Normalising here
 * rather than in the page keeps the page function free of named helpers, which the development
 * transpiler rewrites into calls that do not exist inside a browser.
 */
const flatten = (value: string): string => value.replace(/\s+/g, ' ').trim();

const ELEMENT_NAME_LIMIT = 160;
const ELEMENT_VALUE_LIMIT = 200;
const ELEMENT_DESCRIPTION_LIMIT = 300;
const ELEMENT_OPTION_LIMIT = 200;

/**
 * A password never leaves the browser in a tool result, but "is this field filled, and with how
 * much" is exactly what a form checker needs, so the length is reported and the text is not.
 */
export const redactPasswordValue = (value: string): string =>
  value.length ? `${value.length} characters entered` : '';

export const describeScannedElement = (raw: RawScannedElement): ScannedElement => {
  const name =
    [raw.ariaLabel, raw.labelledByText, raw.labelText, raw.placeholder, raw.title, raw.text]
      .map(flatten)
      .find((candidate) => candidate.length > 0) ?? '';
  return {
    ref: raw.ref,
    tag: raw.tag,
    role: raw.role,
    name: name.slice(0, ELEMENT_NAME_LIMIT),
    type: raw.type,
    href: raw.href,
    ...(raw.elementId ? { id: raw.elementId } : {}),
    ...(raw.fieldName ? { field: flatten(raw.fieldName) } : {}),
    ...(raw.valueBearing
      ? {
          value: raw.password
            ? redactPasswordValue(raw.value)
            : raw.value.slice(0, ELEMENT_VALUE_LIMIT)
        }
      : {}),
    ...(raw.checked === null ? {} : { checked: raw.checked }),
    ...(raw.disabled ? { disabled: true } : {}),
    ...(raw.required ? { required: true } : {}),
    ...(raw.maxLength !== null && raw.maxLength >= 0 ? { maxLength: raw.maxLength } : {}),
    ...(raw.pattern ? { pattern: raw.pattern } : {}),
    ...(raw.invalid ? { invalid: true } : {}),
    ...(flatten(raw.description)
      ? { description: flatten(raw.description).slice(0, ELEMENT_DESCRIPTION_LIMIT) }
      : {}),
    ...(raw.options
      ? {
          options: raw.options
            .slice(0, ELEMENT_OPTION_LIMIT)
            .map((option) => ({ ...option, label: flatten(option.label) }))
        }
      : {})
  };
};

/**
 * A `<label>` is dropped once its control is in the list, because the label's own text is already
 * on that control and two entries for one field is how an agent ends up filling the wrong one. A
 * label whose control was not scanned is kept: sites routinely style a label over an input of zero
 * size, and then the label is the only thing that can be clicked.
 */
export const foldScannedElements = (raw: RawScannedElement[], limit: number): ScannedElement[] => {
  const scanned = new Set(raw.map((entry) => entry.ref));
  return raw
    .filter(
      (entry) => !(entry.tag === 'label' && entry.labelFor !== null && scanned.has(entry.labelFor))
    )
    .slice(0, limit)
    .map(describeScannedElement);
};

const scanFrameElements = async (
  frame: Frame,
  ordinal: number,
  limit: number,
  rootSelector?: string
): Promise<ScannedElement[]> => {
  const raw = await frame
    .evaluate<
      RawScannedElement[],
      { query: string; prefix: string; limit: number; root: string | null; seed: number }
    >(
      // Extraction only, and deliberately written without a single named inner function: the
      // development transpiler rewrites those into calls to a helper that does not exist inside
      // a page, and the whole scan then fails silently. Text arrives unnormalised; the runner
      // tidies and judges it, where that can be tested without a browser.
      ({ query, prefix, limit: budget, root, seed }) => {
        const scope: ParentNode | null = root ? document.querySelector(root) : document;
        if (!scope) return [];
        const visible = Array.from(scope.querySelectorAll<HTMLElement>(query))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .slice(0, budget);
        // Every ref is assigned before anything is read, so a label can report the ref of the
        // control it names even when that control comes later in document order. An element that
        // already carries one keeps it: that is what makes a ref survive a scoped re-read, which
        // used to renumber the whole page from zero. Only a number belonging to another frame is
        // replaced, which can happen when a document is moved between frames.
        let offset = 0;
        const taken = new Set<string>();
        for (const element of visible) {
          const existing = element.getAttribute('data-athanor-ref') ?? '';
          if (existing.startsWith(`${prefix}-`) && !taken.has(existing)) {
            taken.add(existing);
            continue;
          }
          const assigned = `${prefix}-${seed + offset}`;
          offset += 1;
          taken.add(assigned);
          element.setAttribute('data-athanor-ref', assigned);
        }
        return visible.map((element) => {
          const field = element as HTMLInputElement;
          const select = element instanceof HTMLSelectElement ? element : null;
          const labels = field.labels ? Array.from(field.labels) : [];
          const wrapping = element.closest('label');
          const named = labels[0] ?? (wrapping === element ? null : wrapping);
          const control = element instanceof HTMLLabelElement ? element.control : null;
          const valueBearing =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement ||
            element.isContentEditable;
          return {
            // Read back rather than recomputed: the element may be carrying a ref from an earlier
            // scan, which is the whole point of not clearing them.
            ref: element.getAttribute('data-athanor-ref') ?? '',
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role'),
            ariaLabel: element.getAttribute('aria-label') ?? '',
            labelledByText: (element.getAttribute('aria-labelledby') ?? '')
              .split(/\s+/)
              .filter(Boolean)
              .map((id) => document.getElementById(id)?.innerText ?? '')
              .filter(Boolean)
              .join(' '),
            labelText: named?.innerText ?? '',
            placeholder: element.getAttribute('placeholder') ?? '',
            title: element.getAttribute('title') ?? '',
            text: (element.innerText ?? '').slice(0, 400),
            type: element.getAttribute('type'),
            href: element instanceof HTMLAnchorElement ? element.href : null,
            elementId: element.id,
            fieldName: element.getAttribute('name') ?? '',
            valueBearing,
            value: valueBearing
              ? element.isContentEditable && !select
                ? (element.innerText ?? '')
                : (field.value ?? '')
              : '',
            password: element instanceof HTMLInputElement && element.type === 'password',
            checked:
              element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
                ? element.checked
                : element.getAttribute('aria-checked') === null
                  ? null
                  : element.getAttribute('aria-checked') === 'true',
            disabled: field.disabled === true || element.getAttribute('aria-disabled') === 'true',
            required: field.required === true || element.getAttribute('aria-required') === 'true',
            maxLength:
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                ? element.maxLength
                : null,
            pattern: element instanceof HTMLInputElement ? element.pattern : '',
            invalid: element.getAttribute('aria-invalid') === 'true',
            description: [
              ...(element.getAttribute('aria-describedby') ?? '').split(/\s+/),
              ...(element.getAttribute('aria-errormessage') ?? '').split(/\s+/)
            ]
              .filter(Boolean)
              .map((id) => document.getElementById(id)?.innerText ?? '')
              .filter(Boolean)
              .join(' '),
            options: select
              ? Array.from(select.options).map((option) => ({
                  value: option.value,
                  label: option.label || option.text,
                  selected: option.selected
                }))
              : null,
            labelFor: control?.getAttribute('data-athanor-ref') ?? null
          };
        });
      },
      {
        query: INTERACTIVE_ELEMENT_QUERY,
        prefix: `oc-${ordinal}`,
        limit: limit + LABEL_FOLD_OVERSCAN,
        root: rootSelector ?? null,
        // Reserved before the page is touched, so two scans can never hand out the same number even
        // if one of them fails part-way through.
        seed: reserveRefBlock(limit + LABEL_FOLD_OVERSCAN)
      }
    )
    // A frame can navigate or detach mid-scan; losing one frame must not lose the snapshot. Said
    // out loud because the failure is otherwise indistinguishable from a page with no controls,
    // which is exactly how a broken scan stayed invisible while the agent kept working blind.
    .catch((cause: unknown) => {
      console.warn(
        `athanor runner: a frame could not be scanned for controls: ${cause instanceof Error ? cause.message : 'unknown reason'}`
      );
      return [];
    });
  return foldScannedElements(raw, limit);
};

/*
 * Whether a source the agent was told to read is out on the internet.
 *
 * This used to be a second implementation living here, and the two had already drifted apart in
 * both directions: this copy refused unassigned IPv6 that core allowed, and allowed part of
 * 192.0.0.0/16 that core refused. One of them was always going to be the one missing a range, so
 * there is one, in @athanor/core, shared with the connector and mail paths.
 */

/** The wire shape lives in @athanor/contracts, where the worker reads it from too. */
export type ResearchReadResult = ResearchReadSource;

/** Below this a page has said nothing, whatever the parse thought of it. */
const THIN_SOURCE_CHARACTERS = 500;
const SCRIPT_REQUIRED_TEXT =
  /\b(?:enable javascript|javascript is (?:required|disabled)|requires javascript|turn on javascript|checking your browser)\b/i;

export const needsScriptedRender = (text: string): boolean =>
  text.trim().length < THIN_SOURCE_CHARACTERS || SCRIPT_REQUIRED_TEXT.test(text);

/**
 * What a research read is allowed to fetch. Documents always; scripts only on the retry and only
 * from the document's own origin, which keeps a page's own bundle in reach without turning the
 * research fan-out into a general fetcher for whatever a third party wants to serve.
 */
export const researchResourceAllowed = (input: {
  resourceType: string;
  requestUrl: string;
  documentOrigin: string;
  scripts: boolean;
}): boolean => {
  if (input.resourceType === 'document') return true;
  if (!input.scripts || !['script', 'xhr', 'fetch'].includes(input.resourceType)) return false;
  try {
    return new URL(input.requestUrl).origin === input.documentOrigin;
  } catch {
    return false;
  }
};

export interface BotWall {
  vendor: string;
  url: string;
  /** What was recognised, so the owner is told why their browser stopped rather than just that. */
  reason: string;
  /**
   * Where the evidence was. Page evidence can be looked at again, so a challenge that passes on
   * its own clears itself. Response evidence arrived in headers only a fresh request would produce
   * again - and a fresh request is exactly the retry that must not happen - so it stands until the
   * tab leaves the page or the owner deals with it.
   */
  evidence: 'page' | 'response';
}

/** A wall as everything outside the runner sees it: the pane, the worker, and the owner's phone. */
export interface BotWallReport extends BotWall {
  /** Which tab is stopped, so the owner can be offered exactly that one to open. */
  tabId: string | null;
}

/**
 * Carries the wall through the HTTP boundary as data rather than as a sentence in an error string,
 * so the worker can raise it with the owner instead of parsing prose.
 */
export class BotWallError extends Error {
  constructor(readonly wall: BotWallReport) {
    super(botWallMessage(wall));
    this.name = 'BotWallError';
  }
}

/**
 * A challenge the search route walked into, which is deliberately not the same failure.
 *
 * A wall in the session browser is a page standing open on the owner's screen that only they can
 * clear, so it crosses the wire as data and reaches their phone. A wall in the search route is a
 * results page in a browser that has already been closed: there is nothing to take over and nobody
 * needs to be interrupted. Raising the first for the second would page an owner about a page that
 * no longer exists.
 */
export class SearchWallError extends Error {
  constructor(readonly wall: BotWall) {
    super(searchWallMessage(wall));
    this.name = 'SearchWallError';
  }
}

/**
 * Recognising an anti-bot challenge, so the agent stops instead of reloading into a harder block.
 * This is detection only: nothing here works around a challenge, and nothing may be added that
 * does. The cost of getting it wrong is the owner's own address and account reputation, which is
 * why the agent is taken off the page entirely rather than told to try something else.
 */
const BOT_WALL_FRAMES: Array<{ vendor: string; pattern: RegExp }> = [
  { vendor: 'Cloudflare Turnstile', pattern: /challenges\.cloudflare\.com/i },
  { vendor: 'hCaptcha', pattern: /\bhcaptcha\.com/i },
  { vendor: 'reCAPTCHA', pattern: /google\.com\/recaptcha|recaptcha\.net/i },
  { vendor: 'DataDome', pattern: /captcha-delivery\.com|datadome\.co/i },
  { vendor: 'Arkose Labs', pattern: /arkoselabs\.com|funcaptcha\.com/i },
  { vendor: 'PerimeterX', pattern: /perimeterx\.net|px-cdn\.net|px-cloud\.net/i }
];

const BOT_WALL_TITLES =
  /^(?:just a moment|attention required!|access denied|pardon our interruption|are you a robot|security check|verify you are human|checking your browser)/i;

// "complete the following challenge" and "made by a human" are how a search engine words it when
// it decides a query came from software - the exact page a research task walks into first.
const BOT_WALL_TEXT =
  /\b(?:verify (?:you are|you're) (?:a )?human|checking if the site connection is secure|enable javascript and cookies to continue|complete the (?:security check|following challenge)|unusual traffic from your computer network|made by a human)\b/i;

const BOT_WALL_HEADERS = [
  { vendor: 'Cloudflare', header: 'cf-mitigated' },
  { vendor: 'DataDome', header: 'x-datadome' },
  { vendor: 'DataDome', header: 'x-datadome-cid' },
  { vendor: 'PerimeterX', header: 'x-px-block' }
];

export const detectBotWall = (input: {
  url: string;
  title: string;
  text?: string;
  frameUrls?: string[];
  status?: number | null;
  headers?: Record<string, string>;
}): BotWall | null => {
  const wall = (vendor: string, reason: string, evidence: 'page' | 'response'): BotWall => ({
    vendor,
    url: input.url,
    reason,
    evidence
  });
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  for (const { vendor, header } of BOT_WALL_HEADERS)
    if (headers[header] !== undefined)
      return wall(vendor, `response carried ${header}`, 'response');
  const blockedStatus = input.status === 403 || input.status === 429;
  if (blockedStatus && /cloudflare/i.test(headers.server ?? ''))
    return wall('Cloudflare', `HTTP ${input.status} from a Cloudflare bot manager`, 'response');
  for (const { vendor, pattern } of BOT_WALL_FRAMES)
    if ((input.frameUrls ?? []).some((frameUrl) => pattern.test(frameUrl)))
      return wall(vendor, 'challenge widget is embedded in the page', 'page');
  const title = input.title.trim();
  if (BOT_WALL_TITLES.test(title))
    return wall('Unnamed bot wall', `page title is “${title}”`, 'page');
  if (BOT_WALL_TEXT.test(input.text ?? ''))
    return wall('Unnamed bot wall', 'page is asking the visitor to prove they are human', 'page');
  return null;
};

/**
 * How long a site stays closed after a challenge. Long enough that no single task can loop back
 * onto it, short enough that tomorrow's work starts from a clean sheet rather than inheriting a
 * verdict a bot manager made about a moment yesterday.
 */
export const BOT_WALL_HOST_COOLDOWN_MS = 30 * 60_000;

/** The host a wall belongs to, which is the unit the stop is remembered by. */
export const botWallHost = (url: string): string | null => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

/**
 * Whether a challenge still stands, judged against what the tab shows now rather than against the
 * memory of what it showed then. A tab that has moved on is not blocked by what used to be there,
 * and an interstitial that passed by itself - which most of them do, a few seconds later - leaves
 * nothing to stop. Response evidence is the exception: it came from headers that only a fresh
 * request would produce again, and a fresh request is the retry that must not happen.
 */
export const reviewBotWall = (
  standing: BotWall,
  observed: { url: string; title: string; text: string; frameUrls: string[] }
): BotWall | null => {
  if (observed.url !== standing.url) return null;
  if (standing.evidence === 'response') return standing;
  return detectBotWall(observed);
};

/**
 * The stops in force in one browser session. A challenge is recorded against the tab that hit it,
 * so the rest of the browser keeps working, and against the site it was on, so the stop cannot be
 * crossed by opening the same page in a fresh tab - which is the retry the challenge is asking
 * for, made against the owner's own address. The site is held for a cooldown rather than forever,
 * because a bot manager's verdict is about a moment: an hour later this is an ordinary visit.
 */
export class BotWallLedger {
  readonly #tabs = new Map<string, BotWallReport>();
  readonly #hosts = new Map<string, { wall: BotWall; at: number }>();

  raise(tabId: string | null, wall: BotWall, now = Date.now()): BotWallReport {
    const report: BotWallReport = { ...wall, tabId };
    if (tabId !== null) this.#tabs.set(tabId, report);
    const host = botWallHost(wall.url);
    if (host) this.#hosts.set(host, { wall, at: now });
    return report;
  }

  standing(tabId: string | null): BotWallReport | undefined {
    return tabId === null ? undefined : this.#tabs.get(tabId);
  }

  /** The page got through, so neither the tab nor the site is refusing this computer any more. */
  clear(tabId: string, url: string): void {
    this.#tabs.delete(tabId);
    const host = botWallHost(url);
    if (host) this.#hosts.delete(host);
  }

  /** A closed tab takes its own stop with it; the site stays closed for the rest of the cooldown. */
  forgetTab(tabId: string): void {
    this.#tabs.delete(tabId);
  }

  /** The challenge standing between this computer and that site, if one still is. */
  hostClosed(requestedUrl: string, now = Date.now()): BotWall | null {
    const host = botWallHost(requestedUrl);
    const remembered = host === null ? undefined : this.#hosts.get(host);
    if (!remembered || host === null) return null;
    if (now - remembered.at > BOT_WALL_HOST_COOLDOWN_MS) {
      this.#hosts.delete(host);
      return null;
    }
    return remembered.wall;
  }

  /**
   * The newest stop, from whichever tab raised it. This is what the pane shows: a challenge the
   * agent walked into on a background tab is exactly the one nobody would otherwise see.
   */
  latest(): BotWallReport | null {
    return [...this.#tabs.values()].at(-1) ?? null;
  }

  clearAll(): void {
    this.#tabs.clear();
    this.#hosts.clear();
  }
}

/**
 * A challenge is a fact about one page and one site at one moment, and the message says so: the
 * agent is told what is still open to it, because a stop that reads as "the browser is gone" is
 * what turned one interstitial into a failed task.
 */
export const botWallMessage = (wall: BotWallReport | BotWall): string => {
  const tabId = 'tabId' in wall ? wall.tabId : null;
  const host = botWallHost(wall.url) ?? 'this site';
  return `Blocked by ${wall.vendor}: this page is showing an anti-bot challenge (${wall.reason}). ${
    tabId ? `Tab ${tabId} is stopped and ` : ''
  }${host} is closed to you until the owner opens it. Do not retry, reload, open it in another tab, or touch the challenge. Every other tab and every other site still works, so carry on with the rest of the task there and tell the owner this one page needs them.`;
};

/**
 * The same fact, worded for what it actually cost.
 *
 * The browser's wording would be wrong here in every particular: no tab is stopped, the site is not
 * closed to the browser, and nobody has to open anything. Saying so precisely matters because the
 * agent acts on this sentence - told the web was gone, it would stop researching, which is the
 * failure the whole route was rebuilt to end.
 *
 * It used to say searching would be available again in about a minute, and to search again shortly.
 * That was the backoff timer described as if it were a prognosis, and on the deployment this
 * product is built for it was simply false: a server's address is what most engines are refusing,
 * so the next attempt meets the same challenge, and the one after that. Every retry the sentence
 * invited was a turn and a bill spent to be refused again. What it says now is the part that is
 * actually known - this engine did not answer, from here - and it names the routes that do not go
 * through it, without promising that waiting fixes anything.
 */
export const searchWallMessage = (wall: BotWall): string =>
  `Blocked by ${wall.vendor}: the search engine answered with an anti-bot challenge instead of results (${wall.reason}). Nothing else is affected - the browser, every site and every other tool still work. Do not touch the challenge, and do not simply repeat the same search: this engine is refusing this computer, not this query, so an immediate retry meets the same challenge. Read a source you already have the address of, or open a different search engine in the browser. If you needed search to make progress and have no other way in, say so and stop rather than guessing at addresses.`;

/** Actions whose approval depends on which control they land on, so preflight must resolve it. */
const ELEMENT_POLICY_ACTIONS: BrowserAction['type'][] = [
  'click',
  'double_click',
  'type',
  'select_option'
];

/** Actions that can start a download, and so wait to report where the file landed. */
const DOWNLOAD_TRIGGERING_ACTIONS: BrowserAction['type'][] = [
  'click',
  'double_click',
  'click_at',
  'navigate',
  'press'
];

const consequentialText =
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes)\b/i;
const sensitiveFieldText =
  /\b(password|passcode|one.?time|otp|verification code|credit.?card|card number|cvv|cvc|social security|ssn|passport number|bank account)\b/i;

export const classifyBrowserAction = (
  action: BrowserAction,
  element?: ElementPolicyInput
): BrowserActionPreflight => {
  if (action.type === 'click_at') {
    return {
      consequential: true,
      sensitiveInput: false,
      preview: `Coordinate click at ${Math.round(action.x)}, ${Math.round(action.y)}`
    };
  }
  if (action.type === 'press' && action.key.toLowerCase() === 'enter') {
    return {
      consequential: true,
      sensitiveInput: false,
      preview: 'Press Enter in the currently focused page control'
    };
  }
  if (action.type === 'dialog' && action.response === 'accept') {
    return {
      consequential: true,
      sensitiveInput: Boolean(action.promptText),
      preview: action.promptText
        ? 'Accept the page dialog with private text'
        : 'Accept the page confirmation dialog'
    };
  }
  if (action.type === 'text_input') {
    return {
      consequential: false,
      sensitiveInput: true,
      preview: 'Enter private text in the currently focused field'
    };
  }
  if (action.type === 'upload') {
    // Attaching a file sends workspace content to an external site, and many pages upload it
    // the moment it is chosen, so this is approved before it happens rather than at submit.
    return {
      consequential: true,
      sensitiveInput: false,
      preview: `Attach workspace ${action.paths.length === 1 ? 'file' : 'files'} ${action.paths.join(', ').slice(0, 300)} to this page`
    };
  }
  if (!element) {
    return { consequential: false, sensitiveInput: false, preview: action.type };
  }
  const label = element.name.trim().slice(0, 160) || `${element.tag} ${element.type}`.trim();
  const autocomplete = element.autocomplete.toLowerCase();
  const sensitiveInput =
    action.type === 'type' &&
    (element.type === 'password' ||
      ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].some((token) =>
        autocomplete.split(/\s+/).includes(token)
      ) ||
      sensitiveFieldText.test(`${label} ${element.formAction}`));
  // A double click activates the same control a click does, so it inherits the same gate.
  const activates = action.type === 'click' || action.type === 'double_click';
  const isSubmitControl =
    activates &&
    element.inForm &&
    ((element.tag === 'button' && element.type === 'submit') ||
      (element.tag === 'input' && ['submit', 'image'].includes(element.type)));
  const consequential =
    activates && (isSubmitControl || consequentialText.test(`${label} ${element.formAction}`));
  const verb =
    action.type === 'type'
      ? 'Fill'
      : action.type === 'select_option'
        ? 'Choose an option in'
        : action.type === 'double_click'
          ? 'Double-click'
          : action.type === 'hover'
            ? 'Hover'
            : 'Click';
  return {
    consequential,
    sensitiveInput,
    preview: `${verb} “${label || 'page control'}”${element.formAction ? ` · form destination ${element.formAction}` : ''}`
  };
};

/**
 * A batch is exactly as consequential as the most consequential thing in it. Classifying the
 * wrapper on its own would let a submit click ride through the approval gate inside one, so the
 * steps are classified individually and the strongest verdict wins.
 */
export const combineBatchPreflight = (
  steps: Array<{ index: number; preflight: BrowserActionPreflight }>
): BrowserActionPreflight => ({
  consequential: steps.some((step) => step.preflight.consequential),
  sensitiveInput: steps.some((step) => step.preflight.sensitiveInput),
  preview: steps
    .map((step) => `${step.index + 1}. ${step.preflight.preview}`)
    .join('\n')
    .slice(0, 1_200)
});

/**
 * How to put text into a control. `fill` sets the value in one assignment, which is fast and
 * exactly wrong for a typeahead: no keydown, no input event per character, so the suggestion list
 * that an application form requires the applicant to pick from never opens.
 */
export const typeStrategy = (descriptor: {
  tag: string;
  role: string;
  ariaAutocomplete: string;
  hasList: boolean;
  contentEditable: boolean;
}): 'fill' | 'keys' =>
  descriptor.role === 'combobox' ||
  descriptor.ariaAutocomplete !== '' ||
  descriptor.hasList ||
  descriptor.contentEditable
    ? 'keys'
    : 'fill';

/** Resolves a tab id to its live page, or the active page when no tab is named. */
const resolveTab = (session: Session, tabId: string | undefined): Page => {
  if (!tabId) return session.page;
  const page = session.tabs.get(tabId);
  // A closed tab is removed from the registry, so an unknown id means the page is gone rather
  // than that the caller miscounted. Saying so is more useful than silently acting elsewhere.
  if (!page || page.isClosed()) throw new Error(`Browser tab ${tabId} is no longer open`);
  return page;
};

/** The id this page was minted with, or null once it has been closed and forgotten. */
export const tabIdFor = (session: Session, page: Page): string | null => {
  for (const [tabId, candidate] of session.tabs) if (candidate === page) return tabId;
  return null;
};

/** The tab list every snapshot carries, so the agent and a watching human see the same thing. */
export const sessionTabs = async (session: Session): Promise<BrowserTabSummary[]> => {
  const entries: BrowserTabSummary[] = [];
  for (const [tabId, page] of session.tabs) {
    if (page.isClosed()) continue;
    entries.push({
      tabId,
      active: page === session.page,
      url: page.url(),
      title: await page.title().catch(() => '')
    });
  }
  return entries;
};

/**
 * The one coordinate space the browser works in: the contract bounds a coordinate click to it,
 * the screencast is published at it, and the agent reads every position off a screenshot of it.
 */
export const BROWSER_VIEWPORT = { width: 1440, height: 900 } as const;

export interface BrowserLaunchAttempt {
  headless: boolean;
  chromiumSandbox: boolean;
}

/**
 * Chromium adds these only when it is headless, and each one lies about the machine.
 * `--hide-scrollbars` produces the `innerWidth === clientWidth` mismatch no real window has, and
 * the blink settings make `(hover: none)` and `(pointer: coarse)` match — so a responsive site
 * serves its phone layout to a browser whose user agent says desktop Linux, and the agent is then
 * clicking a hamburger menu that nobody watching the same page would see.
 */
export const HEADLESS_DEVICE_ARGUMENTS = [
  '--hide-scrollbars',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
];

/**
 * Launch configurations in the order they are worth trying. Running on the workspace's own X
 * server is preferred because it is the only way the page sees an ordinary desktop, and because
 * it puts the agent's browser on the screen a person can already watch and take over. The
 * renderer sandbox is preferred for the obvious reason, and cannot be had as root at all.
 */
export const browserLaunchLadder = (input: {
  displayAvailable: boolean;
  runningAsRoot: boolean;
}): BrowserLaunchAttempt[] => {
  const modes = input.displayAvailable ? [false, true] : [true];
  const sandboxes = input.runningAsRoot ? [false] : [true, false];
  return modes.flatMap((headless) =>
    sandboxes.map((chromiumSandbox) => ({ headless, chromiumSandbox }))
  );
};

export const browserLaunchOptions = (attempt: BrowserLaunchAttempt) => ({
  headless: attempt.headless,
  chromiumSandbox: attempt.chromiumSandbox,
  ignoreDefaultArgs: attempt.headless ? HEADLESS_DEVICE_ARGUMENTS : [],
  args: [
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    ...(attempt.headless
      ? []
      : [`--window-size=${BROWSER_VIEWPORT.width},${BROWSER_VIEWPORT.height}`])
  ],
  viewport: { ...BROWSER_VIEWPORT }
});

/**
 * Where the agent may drive the session browser, decided by the same module every other outbound
 * fetch asks - `parallel_web_read`, the connectors, the calendar - rather than by a second opinion
 * kept here. The session browser is the one path that used to have no opinion at all, which made
 * `navigate` a way to read the cloud metadata endpoint and every service listening on loopback out
 * of a page or an email the agent had been told to read.
 *
 * Two questions, deliberately answered differently: where the agent may send the browser, and what
 * page it may read back. The second is the wider set, because a page can move itself after the
 * navigation that opened it returned. It admits a tab that has loaded nothing - `about:blank` is
 * where every session and every new tab begins - and a blob, which is a page's own bytes under its
 * own origin and is what a site does when it opens a PDF it has just generated. Neither fetches
 * anything, and a blob's origin has already had to pass this same check to be on the screen.
 */
export const agentReachablePage = (url: string): boolean => {
  if (url === '' || url === 'about:blank') return true;
  if (url.startsWith('blob:')) return isPublicHttpUrl(url.slice('blob:'.length));
  return isPublicHttpUrl(url);
};

export const agentDestinationRefused = (url: string): Error =>
  new Error(
    `The browser is only driven to addresses on the public internet, and ${url.slice(0, 200)} is not one - it is a loopback, private, link-local or otherwise reserved address, or not an HTTP(S) address at all`
  );

/**
 * The syntactic check and the resolution one, kept apart so each says what it actually found. A
 * name that does not resolve at all fails the second, and reporting that as an address-policy
 * refusal would tell the agent something untrue about a site that is merely down.
 */
export const assertAgentReachableUrl = async (url: string): Promise<void> => {
  if (!isPublicHttpUrl(url)) throw agentDestinationRefused(url);
  try {
    await assertPublicHttpUrl(url);
  } catch (cause) {
    throw new Error(
      `The browser could not open ${url.slice(0, 200)}: ${cause instanceof Error ? cause.message : 'its address could not be checked'}`
    );
  }
};

/**
 * Every address a single step would open. One list, so the challenge check and the address check
 * cannot end up covering different actions - which is how `new_tab` came to be guarded against a
 * site standing a challenge and not against the address it was pointed at.
 */
export const stepDestinations = (action: BrowserPrimitiveAction): string[] => {
  if (action.type === 'navigate') return [action.url];
  if (action.type === 'new_tab' && action.url) return [action.url];
  return [];
};

export class BrowserManager {
  readonly #sessions = new Map<string, Session>();
  /**
   * The last challenge the search route walked into, per workspace, and when. Kept apart from the
   * session's own ledger on purpose: a wall the search route hit must not close that host for the
   * browser the agent drives, and a wall the browser hit must not take searching away.
   */
  readonly #searchWalls = new Map<string, { wall: BotWall; at: number }>();

  constructor(
    private readonly options: {
      executablePath?: string | undefined;
      /**
       * How the throwaway browser behind the research fan-out and the search route is started.
       * Present so those two paths can be exercised without a Chromium on the machine running the
       * tests; unset everywhere else, which is the real launch below.
       */
      launchIsolatedBrowser?: (() => Promise<Browser>) | undefined;
      /**
       * Resolves the X11 environment of the workspace's own desktop, so the browser runs on the
       * screen the Computer pane already streams. Absent on a host with no desktop runtime, and
       * allowed to fail: the browser falls back to headless rather than not starting.
       */
      desktopDisplay?:
        | ((workspaceId: string, root: string) => Promise<NodeJS.ProcessEnv | undefined>)
        | undefined;
      /**
       * The same ceiling the file routes apply, because an upload and a printed page are the file
       * API arriving by another door and must not be a way around its limits.
       */
      maxFileBytes: number;
    }
  ) {}

  async ensure(workspaceId: string, root: string): Promise<Session> {
    const existing = this.#sessions.get(workspaceId);
    if (existing) return existing;
    const profile = path.join(root, '.athanor', 'browser');
    // systemd kills the runner's full process group on restart. Chromium can
    // nevertheless leave these exact profile locks behind after a crash.
    await Promise.all(
      ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
        rm(path.join(profile, name), { force: true })
      )
    );
    // A staged upload only matters while the form that may submit it is open, which is the life
    // of a session. Anything left here belongs to a session that is already gone.
    await clearStagedUploads(root);
    const displayEnvironment = await this.#displayEnvironment(workspaceId, root);
    const ladder = browserLaunchLadder({
      displayAvailable: Boolean(displayEnvironment),
      runningAsRoot: typeof process.getuid === 'function' && process.getuid() === 0
    });
    let context: BrowserContext | undefined;
    let refused: unknown;
    let settled: BrowserLaunchAttempt | undefined;
    for (const attempt of ladder) {
      settled = attempt;
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
          ...browserLaunchOptions(attempt),
          ...(attempt.headless || !displayEnvironment
            ? {}
            : { env: { ...process.env, ...displayEnvironment } }),
          acceptDownloads: true,
          // Without this Playwright stages downloads in a temp directory it deletes on close,
          // which both loses late arrivals and puts the bytes outside storage accounting.
          downloadsPath: path.join(root, '.athanor', 'downloads')
        });
        break;
      } catch (cause) {
        // The renderer sandbox needs kernel support the host may not offer, and a desktop can be
        // configured and still not come up. Both are worth trying for and neither is worth
        // losing the browser over, so each is tried once and then given up in a fixed order.
        refused = cause;
      }
    }
    if (!context) throw refused instanceof Error ? refused : new Error('Browser did not start');
    // Worth saying out loud rather than degrading quietly: headless changes what pages serve, and
    // an unsandboxed renderer is a weaker boundary on the process that browses arbitrary content.
    if (settled !== ladder[0])
      console.warn(
        `athanor runner: the browser started ${settled?.headless ? 'headless' : 'on the workspace display'} with the renderer sandbox ${settled?.chromiumSandbox ? 'on' : 'off'} after the preferred configuration was refused: ${refused instanceof Error ? refused.message.split('\n')[0] : 'unknown reason'}`
      );
    const page = context.pages()[0] ?? (await context.newPage());
    const session: Session = {
      context,
      page,
      root,
      holder: 'agent',
      consoleMessages: [],
      // One directory per browser session keeps a re-download of the same file from silently
      // overwriting the copy an earlier session handed the user.
      downloadsDirectory: path.join(
        'workspace',
        'downloads',
        new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      ),
      downloads: [],
      pendingDownloads: new Set(),
      tabs: new Map(),
      nextTabId: 1,
      walls: new BotWallLedger()
    };
    const attachPage = (candidate: Page) => {
      const tabId = `tab-${session.nextTabId}`;
      session.nextTabId += 1;
      session.tabs.set(tabId, candidate);
      candidate.on('close', () => {
        session.tabs.delete(tabId);
        session.walls.forgetTab(tabId);
      });
      candidate.on('console', (message) => {
        session.consoleMessages.push({
          level: message.type(),
          text: message.text().slice(0, 2_000),
          url: message.location().url.slice(0, 2_000),
          at: new Date().toISOString()
        });
        if (session.consoleMessages.length > 200) session.consoleMessages.splice(0, 50);
      });
      candidate.on('pageerror', (error) => {
        session.consoleMessages.push({
          level: 'pageerror',
          text: error.message.slice(0, 2_000),
          url: candidate.url().slice(0, 2_000),
          at: new Date().toISOString()
        });
        if (session.consoleMessages.length > 200) session.consoleMessages.splice(0, 50);
      });
      candidate.on('dialog', (dialog) => {
        session.pendingDialog = dialog;
      });
      candidate.on('download', (download) => {
        const saving = this.#saveDownload(session, root, download);
        session.pendingDownloads.add(saving);
        void saving.finally(() => session.pendingDownloads.delete(saving));
      });
    };
    for (const candidate of context.pages()) attachPage(candidate);
    context.on('page', (candidate) => {
      attachPage(candidate);
      // An ad or oauth popup opens a page too; it stays a background tab the agent can
      // select deliberately instead of hijacking the one being driven.
      if (!shouldAdoptNewPage(session.page)) return;
      session.page = candidate;
      void this.#retargetStream(session).catch(() => undefined);
    });
    // Nothing here masks automation. The switch that used to suppress `navigator.webdriver`
    // (`--disable-blink-features=AutomationControlled`) has been removed, because masking it is
    // bot-defence evasion, which SECURITY.md places out of scope and which the owner would be
    // the one exposed for. Sites that refuse automation are recognised and handed to the owner.
    this.#sessions.set(workspaceId, session);
    context.on('close', () => this.#sessions.delete(workspaceId));
    return session;
  }

  async #displayEnvironment(
    workspaceId: string,
    root: string
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (!this.options.desktopDisplay) return undefined;
    const environment = await this.options.desktopDisplay(workspaceId, root).catch(() => undefined);
    return environment?.DISPLAY ? environment : undefined;
  }

  async #saveDownload(session: Session, root: string, download: Download): Promise<void> {
    const url = download.url().slice(0, 2_000);
    try {
      const directory = path.join(root, session.downloadsDirectory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name = await uniqueDownloadName(
        directory,
        downloadFileName(download.suggestedFilename())
      );
      await download.saveAs(path.join(directory, name));
      session.downloads.push({ path: path.join(session.downloadsDirectory, name), url });
    } catch (cause) {
      session.downloads.push({
        path: null,
        url,
        error: cause instanceof Error ? cause.message.slice(0, 300) : 'Download could not be saved'
      });
    }
    if (session.downloads.length > DOWNLOAD_HISTORY_LIMIT)
      session.downloads.splice(0, session.downloads.length - DOWNLOAD_HISTORY_LIMIT);
  }

  async #settleDownloads(session: Session): Promise<void> {
    // Chromium reports the download just after the click that caused it resolves, so an action
    // that could start one waits a beat before concluding that nothing arrived.
    if (!session.pendingDownloads.size)
      await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_START_GRACE_MS));
    if (!session.pendingDownloads.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...session.pendingDownloads]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DOWNLOAD_SETTLE_MS);
      })
    ]);
    if (timer) clearTimeout(timer);
  }

  async snapshot(workspaceId: string, root: string, actor: 'agent' | 'user') {
    const session = await this.ensure(workspaceId, root);
    if (session.holder === 'secure_input' && actor === 'agent') {
      throw new Error('Browser is in secure input mode');
    }
    if (session.holder === 'secure_input') {
      return composeBrowserSnapshot({
        url: session.page.url(),
        title: await session.page.title(),
        holder: session.holder,
        botWall: null,
        elements: [],
        tabs: [],
        downloads: [],
        pendingDialog: null,
        consoleMessages: [],
        images: [],
        screenshotBase64: '',
        text: ''
      });
    }
    if (session.holder === 'user' && actor === 'agent')
      throw new Error('Browser is held by the user');
    const page = session.page;
    this.#assertReadablePage(page, actor);
    // The standing wall is re-read against the live page first, so a challenge that has since
    // passed on its own leaves an ordinary snapshot rather than a permanent refusal.
    let wall = await this.#reviewWall(session, page);
    const text = await page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '');
    const title = await page.title().catch(() => '');
    if (!wall) {
      const detected = detectBotWall({
        url: page.url(),
        title,
        text,
        frameUrls: page.frames().map((frame) => frame.url())
      });
      if (detected) wall = this.#raiseWall(session, page, detected);
    }
    if (wall) {
      // Deliberately no screenshot, no elements and no page text: what a challenge page contains
      // is a puzzle, and putting it in front of the model is an invitation to have a go at it.
      return composeBrowserSnapshot({
        url: page.url(),
        title,
        holder: session.holder,
        botWall: wall,
        elements: [],
        tabs: await sessionTabs(session),
        downloads: [],
        pendingDialog: null,
        consoleMessages: [],
        images: [],
        screenshotBase64: '',
        text: botWallMessage(wall)
      });
    }
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 72 });
    const images = await page.evaluate(() =>
      Array.from(document.images)
        .filter((image) => image.currentSrc || image.src)
        .slice(0, 100)
        .map((image) => ({
          url: image.currentSrc || image.src,
          alt: image.alt.slice(0, 500),
          width: image.naturalWidth,
          height: image.naturalHeight
        }))
    );
    return composeBrowserSnapshot({
      url: page.url(),
      title,
      holder: session.holder,
      botWall: null,
      elements: await this.#scanPage(page),
      tabs: await sessionTabs(session),
      // A download that outlived the action that started it is only discoverable here.
      downloads: session.downloads.slice(-10),
      pendingDialog: session.pendingDialog
        ? { type: session.pendingDialog.type(), message: session.pendingDialog.message() }
        : null,
      consoleMessages: session.consoleMessages.slice(-40),
      images,
      screenshotBase64: screenshot.toString('base64'),
      text
    });
  }

  /**
   * Payment forms, embedded editors and consent dialogs live in iframes, so the scan walks every
   * frame the page exposes rather than the top document alone. The ref carries the frame ordinal,
   * which is how an action finds the frame the control belongs to again.
   */
  async #scanPage(page: Page, rootSelector?: string): Promise<BrowserSnapshotElement[]> {
    const elements: BrowserSnapshotElement[] = [];
    for (const [ordinal, frame] of page.frames().slice(0, SNAPSHOT_FRAME_LIMIT).entries()) {
      const budget = SNAPSHOT_ELEMENT_LIMIT - elements.length;
      if (budget <= 0) break;
      for (const scanned of await scanFrameElements(frame, ordinal, budget, rootSelector)) {
        const { ref, ...rest } = scanned;
        elements.push({
          index: elements.length,
          selector: `[data-athanor-ref="${ref}"]`,
          ...rest
        });
      }
    }
    return elements;
  }

  /**
   * Reads the controls of one form without a screenshot, so checking that thirty fields hold what
   * was typed costs thirty cheap reads instead of thirty full snapshots.
   */
  async readElements(
    workspaceId: string,
    root: string,
    input: { selector?: string | undefined; tabId?: string | undefined },
    actor: 'agent' | 'user'
  ) {
    const session = await this.ensure(workspaceId, root);
    if (session.holder === 'secure_input') throw new Error('Browser is in secure input mode');
    if (session.holder !== actor) throw new Error(`Browser control is held by ${session.holder}`);
    const page = resolveTab(session, input.tabId);
    if (actor === 'agent') await this.#assertNoWall(session, page);
    this.#assertReadablePage(page, actor);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      tabId: tabIdFor(session, page),
      elements: await this.#scanPage(page, input.selector)
    };
  }

  /**
   * Records the stop. The holder is deliberately left where it was: taking the browser off the
   * agent used to be what made this a stop, but it stopped everything - unrelated tabs, unrelated
   * sites, the whole task - and it could only be undone by a person. The stop is now the wall
   * itself, which no agent call can cross and no agent call can clear.
   */
  #raiseWall(session: Session, page: Page, wall: BotWall): BotWallReport {
    const report = session.walls.raise(tabIdFor(session, page), wall);
    void this.#notifyStreamState(session).catch(() => undefined);
    return report;
  }

  /**
   * Re-reads the live page behind a standing wall, so a challenge that has passed stops being one.
   * Every agent entry goes through here rather than trusting the flag, and nothing here reloads or
   * re-requests: the page is only looked at again.
   */
  async #reviewWall(session: Session, page: Page): Promise<BotWallReport | null> {
    const tabId = tabIdFor(session, page);
    const standing = session.walls.standing(tabId);
    if (!standing || tabId === null) return null;
    const current = reviewBotWall(standing, {
      url: page.url(),
      title: await page.title().catch(() => ''),
      text: await page
        .locator('body')
        .innerText({ timeout: 2_000 })
        .catch(() => ''),
      frameUrls: page.frames().map((frame) => frame.url())
    });
    if (current) return session.walls.raise(tabId, current);
    session.walls.clear(tabId, standing.url);
    void this.#notifyStreamState(session).catch(() => undefined);
    return null;
  }

  async #assertNoWall(session: Session, page: Page): Promise<void> {
    const wall = await this.#reviewWall(session, page);
    if (wall) throw new BotWallError(wall);
  }

  /**
   * The other half of the address policy: what the agent is allowed to read back. A page can move
   * itself long after the navigation that opened it returned, so guarding only the navigation would
   * leave a script on an injected page free to send the tab at a loopback service and let the next
   * snapshot do the reading.
   */
  #assertReadablePage(page: Page, actor: 'agent' | 'user'): void {
    if (actor !== 'agent') return;
    if (!agentReachablePage(page.url()))
      throw new Error(
        `This tab is on ${page.url().slice(0, 200)}, which is not an address on the public internet, so its contents are not read back`
      );
  }

  /** Refuses a site a challenge is standing on, whichever tab the request would go out from. */
  #assertHostOpen(session: Session, requestedUrl: string): void {
    const closed = session.walls.hostClosed(requestedUrl);
    if (closed) throw new BotWallError({ ...closed, tabId: null });
  }

  /**
   * Reads a set of public pages in throwaway contexts of their own. It deliberately touches
   * neither the session browser nor its walls: these are one-shot document reads in a browser with
   * no profile, no cookies and no shared state, so a challenge on one site the agent was driving
   * has nothing to say about a paper on another - and the owner holding the browser to deal with
   * one is no reason for the research half of the task to stop.
   */
  async readMany(urls: string[], maxCharactersPerPage: number): Promise<ParallelWebReadResult> {
    const unique = [...new Set(urls)].slice(0, 12);
    if (unique.some((url) => !isPublicHttpUrl(url)))
      throw new Error('Parallel web reading accepts public HTTP(S) URLs only');
    const results: ResearchReadResult[] = unique.map((requestedUrl) => ({
      requestedUrl,
      error: 'Source was not read'
    }));
    let cursor = 0;
    const researchBrowser = await this.#launchIsolatedBrowser();
    const readNext = async () => {
      for (;;) {
        const index = cursor++;
        const requestedUrl = unique[index];
        if (requestedUrl === undefined) return;
        const withoutScripts = await this.#readResearchSource(researchBrowser, requestedUrl, {
          scripts: false,
          maxCharactersPerPage
        });
        // Scripts are off by default because most primary sources do not need them and a source
        // that cannot run code cannot do anything else either. The cost is that an app-shaped
        // page returns its empty shell, which reads as a source that said nothing rather than as
        // one that was never rendered - so a thin answer is worth exactly one honest retry.
        results[index] =
          withoutScripts.error === undefined && !needsScriptedRender(withoutScripts.text ?? '')
            ? withoutScripts
            : await this.#readResearchSource(researchBrowser, requestedUrl, {
                scripts: true,
                maxCharactersPerPage
              }).then((rendered) => (rendered.error === undefined ? rendered : withoutScripts));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => readNext()));
      return { sources: results, requested: urls.length, read: unique.length };
    } finally {
      await researchBrowser.close();
    }
  }

  /**
   * One search, answered as data. The alternative it replaces was driving the browser to an engine
   * and reading the results out of a snapshot, which spent a screenshot and a 250-element scan on
   * ten links and put the model on the page of every site most likely to challenge it.
   *
   * It is answered from an isolated browser first and from the session browser only as a second
   * attempt - see the note at the top of search.ts for why a search stopped sharing the browsing
   * session. What follows from that here: this never launches the session browser, so a research
   * task needs no desktop Chromium at all; it never consults the session's walls except to decide
   * whether the second attempt is worth making; and a challenge on the isolated route is remembered
   * for a minute against searching alone, leaving every other tab, every other site and every other
   * tool untouched.
   */
  async search(
    workspaceId: string,
    input: { query: string; limit: number },
    actor: 'agent' | 'user'
  ): Promise<{
    engine: string;
    query: string;
    route: SearchRoute;
    results: WebSearchResult[];
  }> {
    const searchUrl = duckDuckGoSearchUrl(input.query);
    const session = this.#sessions.get(workspaceId);
    const remembered = this.#searchWalls.get(workspaceId);
    const backingOff =
      remembered !== undefined && Date.now() - remembered.at <= SEARCH_WALL_BACKOFF_MS;
    if (remembered !== undefined && !backingOff) this.#searchWalls.delete(workspaceId);
    const plan = searchRoutePlan({
      actor,
      sessionHolder: session?.holder ?? null,
      sessionHostClosed: session ? session.walls.hostClosed(searchUrl) !== null : false,
      isolatedBackoffActive: backingOff
    });
    // Reachable only while the isolated route is backing off with no usable session behind it, so
    // the wall being reported is always the one that put it there - answered from memory rather
    // than by launching a second browser to be refused again.
    if (plan.length === 0 && remembered) throw new SearchWallError(remembered.wall);
    let stopped: BotWallError | SearchWallError | null = null;
    for (const route of plan) {
      try {
        if (route === 'session') {
          if (!session) continue;
          return { ...(await this.#searchInSession(session, searchUrl, input)), route };
        }
        return { ...(await this.#searchIsolated(workspaceId, searchUrl, input)), route };
      } catch (cause) {
        if (!(cause instanceof BotWallError) && !(cause instanceof SearchWallError)) throw cause;
        stopped = cause;
      }
    }
    // The session wall wins when both raised one, because it is the one with a page behind it that
    // the owner can actually clear.
    if (stopped) throw stopped;
    // Unreachable: an empty plan is answered above, and every route either returns or raises a
    // wall. Stated rather than asserted, because a sentence is a better failure than a cast.
    throw new Error('No browser was available to answer this search');
  }

  /**
   * The search as a one-shot read: a browser of its own, launched for this query and closed after
   * it, which is what makes a challenge here cost one search rather than the session.
   */
  async #searchIsolated(
    workspaceId: string,
    searchUrl: string,
    input: { query: string; limit: number }
  ): Promise<{ engine: string; query: string; results: WebSearchResult[] }> {
    const browser = await this.#launchIsolatedBrowser();
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();
      const response = await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      const wall = detectBotWall({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: await page
          .locator('body')
          .innerText({ timeout: 5_000 })
          .catch(() => ''),
        frameUrls: page.frames().map((frame) => frame.url()),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {}
      });
      if (wall) {
        // Remembered against searching, not against the site: `browser_action` may still be driven
        // to the engine, and every other host is untouched. This is the whole cost of the wall.
        this.#searchWalls.set(workspaceId, { wall, at: Date.now() });
        throw new SearchWallError(wall);
      }
      this.#searchWalls.delete(workspaceId);
      return {
        engine: SEARCH_ENGINE,
        query: input.query.trim(),
        results: searchResults(await page.evaluate(readSearchRows), input.limit)
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /**
   * The second attempt, through the profile the owner can see and take over. The results tab is
   * opened in the background so the page being worked on keeps the screen, and closed as soon as it
   * has been read - unless it is a challenge, which is left open precisely because it is the page
   * the owner has to be handed.
   */
  async #searchInSession(
    session: Session,
    searchUrl: string,
    input: { query: string; limit: number }
  ): Promise<{ engine: string; query: string; results: WebSearchResult[] }> {
    const page = await session.context.newPage();
    let challenged = false;
    try {
      const response = await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      });
      const wall = detectBotWall({
        url: page.url(),
        title: await page.title().catch(() => ''),
        text: await page
          .locator('body')
          .innerText({ timeout: 5_000 })
          .catch(() => ''),
        frameUrls: page.frames().map((frame) => frame.url()),
        status: response?.status() ?? null,
        headers: response?.headers() ?? {}
      });
      if (wall) {
        challenged = true;
        throw new BotWallError(this.#raiseWall(session, page, wall));
      }
      return {
        engine: SEARCH_ENGINE,
        query: input.query.trim(),
        results: searchResults(await page.evaluate(readSearchRows), input.limit)
      };
    } finally {
      if (!challenged) await page.close().catch(() => undefined);
    }
  }

  /**
   * A browser with no profile, no cookies and no shared state, for work that is a fetch rather than
   * a session: the research fan-out and the search route. Headless because nobody is watching it,
   * and one per call because the isolation is the point.
   */
  async #launchIsolatedBrowser(): Promise<Browser> {
    if (this.options.launchIsolatedBrowser) return this.options.launchIsolatedBrowser();
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const options = (chromiumSandbox: boolean) => ({
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      headless: true,
      chromiumSandbox,
      ignoreDefaultArgs: HEADLESS_DEVICE_ARGUMENTS,
      args: ['--no-first-run', '--disable-background-networking', '--disable-component-update']
    });
    // The same fallback the session browser has had all along, and for the same reason: Ubuntu
    // 23.10 and later refuse unprivileged user namespaces under AppArmor, so Chromium cannot build
    // its renderer sandbox and refuses to start at all. Without this the research fan-out and the
    // search route were the only two things on the box that simply did not work there - and they
    // failed with a page of Chromium log rather than anything an owner could act on.
    //
    // Losing the renderer sandbox is a real reduction, not a free win, which is why it is a
    // fallback and why the installer lays down an AppArmor profile so the first attempt succeeds.
    // The command is still confined to the agent's own account either way.
    if (asRoot) return chromium.launch(options(false));
    try {
      return await chromium.launch(options(true));
    } catch (error) {
      console.warn(
        'athanor runner: the isolated browser started with the renderer sandbox off after the ' +
          `preferred configuration was refused: ${
            error instanceof Error ? error.message.split('\n')[0] : 'unknown reason'
          }`
      );
      return chromium.launch(options(false));
    }
  }

  async #readResearchSource(
    researchBrowser: Browser,
    requestedUrl: string,
    options: { scripts: boolean; maxCharactersPerPage: number }
  ): Promise<ResearchReadResult> {
    const context = await researchBrowser.newContext({
      javaScriptEnabled: options.scripts,
      acceptDownloads: false,
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    try {
      await assertPublicHttpUrl(requestedUrl);
      let blockedReason = '';
      let documentOrigin = new URL(requestedUrl).origin;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const requestUrl = request.url();
        const isDocument = request.resourceType() === 'document';
        if (
          !researchResourceAllowed({
            resourceType: request.resourceType(),
            requestUrl,
            documentOrigin,
            scripts: options.scripts
          })
        ) {
          await route.abort('blockedbyclient');
          return;
        }
        try {
          await assertPublicHttpUrl(requestUrl);
          if (isDocument) documentOrigin = new URL(requestUrl).origin;
          await route.continue();
        } catch (cause) {
          blockedReason =
            cause instanceof Error ? cause.message : 'Source resolved outside the public web';
          await route.abort('blockedbyclient');
        }
      });
      const response = await page.goto(requestedUrl, {
        waitUntil: options.scripts ? 'load' : 'domcontentloaded',
        timeout: 30_000
      });
      if (blockedReason) throw new Error(blockedReason);
      if (!isPublicHttpUrl(page.url()))
        throw new Error('Source redirected to a private or local address');
      const server = await response?.serverAddr();
      if (!server || !isPublicInternetAddress(server.ipAddress))
        throw new Error('Source connected to a private, reserved, or local address');
      const [title, text] = await Promise.all([
        page.title().catch(() => ''),
        page
          .locator('body')
          .innerText({ timeout: 8_000 })
          .catch(() => '')
      ]);
      return {
        requestedUrl,
        url: page.url(),
        title,
        text: text.slice(0, options.maxCharactersPerPage),
        ...(options.scripts ? { renderedWithScripts: true } : {})
      };
    } catch (cause) {
      return {
        requestedUrl,
        error: cause instanceof Error ? cause.message.slice(0, 500) : 'Source read failed'
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async #streamState(session: Session): Promise<BrowserStreamState> {
    return {
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      holder: session.holder,
      width: BROWSER_VIEWPORT.width,
      height: BROWSER_VIEWPORT.height,
      transport: 'chromium_screencast',
      botWall: session.walls.latest()
    };
  }

  async #notifyStreamState(session: Session): Promise<void> {
    if (!session.stream) return;
    const state = await this.#streamState(session);
    for (const subscriber of session.stream.subscribers) subscriber.state(state);
  }

  async #startStream(
    session: Session,
    subscribers: Set<BrowserStreamSubscriber> = new Set()
  ): Promise<void> {
    const cdp = await session.context.newCDPSession(session.page);
    const stream: BrowserStream = { cdp, subscribers };
    session.stream = stream;
    cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
      void (async () => {
        try {
          if (session.holder === 'secure_input') return;
          const state = await this.#streamState(session);
          const image = Buffer.from(frame.data, 'base64');
          for (const current of stream.subscribers) current.frame(image, state);
        } finally {
          await cdp
            .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
            .catch(() => undefined);
        }
      })();
    });
    try {
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 72,
        maxWidth: BROWSER_VIEWPORT.width,
        maxHeight: BROWSER_VIEWPORT.height,
        everyNthFrame: 1
      });
    } catch (error) {
      delete session.stream;
      await cdp.detach().catch(() => undefined);
      throw error;
    }
  }

  async #retargetStream(session: Session): Promise<void> {
    const previous = session.stream;
    if (!previous) return;
    delete session.stream;
    await previous.cdp.send('Page.stopScreencast').catch(() => undefined);
    await previous.cdp.detach().catch(() => undefined);
    await this.#startStream(session, previous.subscribers);
    await this.#notifyStreamState(session);
  }

  async subscribeStream(
    workspaceId: string,
    root: string,
    subscriber: BrowserStreamSubscriber
  ): Promise<() => Promise<void>> {
    const session = await this.ensure(workspaceId, root);
    if (!session.stream) await this.#startStream(session);
    const stream = session.stream;
    if (!stream) throw new Error('Browser stream did not start');
    stream.subscribers.add(subscriber);
    subscriber.state(await this.#streamState(session));
    return async () => {
      const current = session.stream;
      if (!current) return;
      current.subscribers.delete(subscriber);
      if (current.subscribers.size > 0) return;
      delete session.stream;
      await current.cdp.send('Page.stopScreencast').catch(() => undefined);
      await current.cdp.detach().catch(() => undefined);
    };
  }

  async preflight(
    workspaceId: string,
    root: string,
    action: BrowserAction,
    actor: 'agent' | 'user'
  ): Promise<BrowserActionPreflight> {
    const session = await this.ensure(workspaceId, root);
    if (session.holder !== actor && !(session.holder === 'secure_input' && actor === 'user')) {
      throw new Error(`Browser control is held by ${session.holder}`);
    }
    if (action.type !== 'batch') return this.#classify(session, action);
    // A step later in the batch may target a control an earlier step reveals, so it cannot be
    // resolved yet. Those are classified again at the moment they run; what can be judged now is
    // judged now, so the owner is asked once, up front, for the whole batch.
    const steps = await Promise.all(
      action.actions.map(async (primitive, index) => ({
        index,
        preflight: await this.#classify(session, primitive, { timeout: 2_000, tolerant: true })
      }))
    );
    return combineBatchPreflight(steps);
  }

  async #classify(
    session: Session,
    action: BrowserAction | BrowserPrimitiveAction,
    options: { timeout: number; tolerant: boolean } = { timeout: 20_000, tolerant: false }
  ): Promise<BrowserActionPreflight> {
    if (!ELEMENT_POLICY_ACTIONS.includes(action.type)) return classifyBrowserAction(action);
    const targeted = action as Extract<
      BrowserAction,
      { type: 'click' | 'double_click' | 'type' | 'select_option' }
    >;
    const page = resolveTab(session, targeted.tabId);
    const target = await resolveBrowserTarget(page, targeted.selector);
    const read = target.evaluate(
      (target) => {
        const control = target as HTMLInputElement | HTMLButtonElement;
        const form = target.closest('form');
        return {
          tag: target.tagName.toLowerCase(),
          type: String(control.type ?? target.getAttribute('type') ?? '').toLowerCase(),
          name:
            target.getAttribute('aria-label') ??
            target.getAttribute('placeholder') ??
            (target as HTMLElement).innerText?.trim().slice(0, 160) ??
            '',
          autocomplete: target.getAttribute('autocomplete') ?? '',
          formAction: form?.action ?? '',
          inForm: Boolean(form)
        };
      },
      undefined,
      { timeout: options.timeout }
    );
    // A control that has not appeared yet is an answer only inside a batch, where the step is
    // classified again when it runs. On its own it is a failure the caller has to hear about,
    // because classifying an unresolvable target as harmless is how an unapproved submit lands.
    const element = options.tolerant ? await read.catch(() => undefined) : await read;
    return classifyBrowserAction(action, element);
  }

  /** The gate every agent action passes, whether it arrived on its own or inside a batch. */
  #enforce(policy: BrowserActionPreflight, consequentialApproved: boolean, where: string): void {
    if (policy.sensitiveInput)
      throw new Error(`Secure input takeover is required for this browser field${where}`);
    if (policy.consequential && !consequentialApproved)
      throw new Error(`A browser consequential-action approval capability is required${where}`);
  }

  async act(
    workspaceId: string,
    root: string,
    action: BrowserAction,
    actor: 'agent' | 'user',
    consequentialApproved = false
  ) {
    const session = await this.ensure(workspaceId, root);
    if (session.holder !== actor && !(session.holder === 'secure_input' && actor === 'user')) {
      throw new Error(`Browser control is held by ${session.holder}`);
    }
    const startedDownloads = session.downloads.length;
    if (action.type === 'batch') {
      const steps: Array<{
        index: number;
        type: BrowserPrimitiveAction['type'];
        ok: boolean;
        url?: string;
        error?: string;
      }> = [];
      for (const [index, primitive] of action.actions.entries()) {
        try {
          if (actor === 'agent') {
            await this.#guardStep(session, primitive);
            this.#enforce(
              await this.#classify(session, primitive),
              consequentialApproved,
              ` (batch step ${index + 1}, ${primitive.type})`
            );
          }
          const result = await this.#perform(session, root, primitive);
          steps.push({ index, type: primitive.type, ok: true, url: result.url });
        } catch (cause) {
          steps.push({
            index,
            type: primitive.type,
            ok: false,
            error: cause instanceof Error ? cause.message.slice(0, 400) : 'Browser step failed'
          });
          // Stopping here rather than pressing on: the steps after a failed one were written
          // against a page state that never happened.
          break;
        }
      }
      if (session.pendingDownloads.size) await this.#settleDownloads(session);
      return {
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        tabId: tabIdFor(session, session.page),
        steps,
        completed: steps.filter((step) => step.ok).length,
        downloads: session.downloads.slice(startedDownloads)
      };
    }
    if (actor === 'agent') {
      await this.#guardStep(session, action);
      this.#enforce(await this.#classify(session, action), consequentialApproved, '');
    }
    const performed = await this.#perform(session, root, action);
    if (DOWNLOAD_TRIGGERING_ACTIONS.includes(action.type) || session.pendingDownloads.size)
      await this.#settleDownloads(session);
    return { ...performed, downloads: session.downloads.slice(startedDownloads) };
  }

  /**
   * The wall check every agent step passes: the tab it lands on, and the site it is about to open.
   * Both halves are needed - one stops the agent working through a challenge page, the other stops
   * it opening the same site in a fresh tab, which is the retry the challenge is asking for.
   */
  async #guardStep(session: Session, action: BrowserPrimitiveAction): Promise<void> {
    for (const destination of stepDestinations(action)) {
      this.#assertHostOpen(session, destination);
      await assertAgentReachableUrl(destination);
    }
    // A fresh tab has no page of its own to review yet.
    if (action.type === 'new_tab') return;
    await this.#assertNoWall(
      session,
      resolveTab(session, 'tabId' in action ? action.tabId : undefined)
    );
  }

  async #perform(
    session: Session,
    root: string,
    action: BrowserPrimitiveAction
  ): Promise<{
    url: string;
    title: string;
    tabId: string | null;
    elements?: BrowserSnapshotElement[];
    text?: string;
    waited?: string;
  }> {
    const page = resolveTab(session, 'tabId' in action ? action.tabId : undefined);
    let acted = page;
    switch (action.type) {
      case 'navigate': {
        const response = await page.goto(action.url, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000
        });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
      case 'click':
        await (await resolveBrowserTarget(page, action.selector)).click({ timeout: 20_000 });
        break;
      case 'double_click':
        await (await resolveBrowserTarget(page, action.selector)).dblclick({ timeout: 20_000 });
        break;
      case 'hover':
        await (await resolveBrowserTarget(page, action.selector)).hover({ timeout: 20_000 });
        break;
      case 'click_at':
        await page.mouse.click(action.x, action.y);
        break;
      case 'type': {
        const target = await resolveBrowserTarget(page, action.selector);
        const descriptor = await target.evaluate(
          (element) => ({
            tag: element.tagName.toLowerCase(),
            role: (element.getAttribute('role') ?? '').toLowerCase(),
            ariaAutocomplete: element.getAttribute('aria-autocomplete') ?? '',
            hasList: element.hasAttribute('list'),
            contentEditable: (element as HTMLElement).isContentEditable
          }),
          undefined,
          { timeout: 20_000 }
        );
        // fill() throws on a <select>; the option text or value is what the agent means.
        if (descriptor.tag === 'select') {
          await target.selectOption(action.text, { timeout: 20_000 });
          break;
        }
        const strategy = action.mode === 'auto' ? typeStrategy(descriptor) : action.mode;
        if (strategy === 'fill') {
          await target.fill(action.text, { timeout: 20_000 });
          break;
        }
        // Clear first: pressSequentially appends, and a typeahead that already holds a stale
        // value matches nothing once the new text is concatenated onto it.
        await target.fill('', { timeout: 20_000 }).catch(() => undefined);
        await target.pressSequentially(action.text, { delay: 30, timeout: 60_000 });
        break;
      }
      case 'wait_for': {
        const waited = await this.#waitFor(page, action);
        return {
          url: page.url(),
          title: await page.title().catch(() => ''),
          tabId: tabIdFor(session, page),
          waited
        };
      }
      case 'select_option':
        await (
          await resolveBrowserTarget(page, action.selector)
        ).selectOption(action.values, {
          timeout: 20_000
        });
        break;
      case 'upload': {
        // Every path goes through the file API's own boundary check, so an upload can only
        // ever attach a file the user could already read through the file browser - and what the
        // browser is handed is a runner-owned copy, because the browser opens the name it was
        // given when the form is submitted rather than now.
        const files = await Promise.all(
          action.paths.map((requested) =>
            stageUserFileForUpload(root, requested, this.options.maxFileBytes)
          )
        );
        const target = await resolveBrowserTarget(page, action.selector);
        const isFileInput = await target
          .evaluate(
            (element) => element instanceof HTMLInputElement && element.type === 'file',
            undefined,
            { timeout: 20_000 }
          )
          .catch(() => false);
        if (isFileInput) {
          await target.setInputFiles(files, { timeout: 20_000 });
          break;
        }
        // Most sites hide the real input behind a styled button or drop zone, and the chooser
        // that button opens is then the only way in.
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 20_000 }),
          target.click({ timeout: 20_000 })
        ]);
        await chooser.setFiles(files);
        break;
      }
      case 'text_input':
        await page.keyboard.insertText(action.text);
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll': {
        // A wheel event lands under the pointer, which starts at the top-left corner, so the
        // pointer is parked over the requested container — or the middle of the page — first.
        if (action.selector)
          await (await resolveBrowserTarget(page, action.selector)).hover({ timeout: 20_000 });
        else {
          const viewport = page.viewportSize();
          await page.mouse.move(
            (viewport?.width ?? BROWSER_VIEWPORT.width) / 2,
            (viewport?.height ?? BROWSER_VIEWPORT.height) / 2
          );
        }
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      }
      case 'new_tab': {
        const next = await session.context.newPage();
        acted = next;
        // A background tab is how the posting stays open while the form is filled in another,
        // so `activate: false` genuinely leaves the driven tab where it was.
        if (action.activate) {
          session.page = next;
          await this.#retargetStream(session).catch(() => undefined);
        }
        if (action.url) {
          const response = await next.goto(action.url, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000
          });
          await this.#assertNavigationClean(session, next, response);
        }
        break;
      }
      case 'select_tab': {
        const selected = resolveTab(session, action.tabId);
        session.page = selected;
        acted = selected;
        await selected.bringToFront();
        await this.#retargetStream(session);
        break;
      }
      case 'inspect_tab': {
        // Reads a tab without making it active, so the agent can check a background page
        // without stealing focus from the one a human may be watching.
        const inspected = resolveTab(session, action.tabId);
        this.#assertReadablePage(inspected, session.holder === 'agent' ? 'agent' : 'user');
        return {
          url: inspected.url(),
          title: await inspected.title().catch(() => ''),
          tabId: action.tabId,
          elements: await this.#scanPage(inspected),
          text: (
            await inspected
              .locator('body')
              .innerText({ timeout: 5_000 })
              .catch(() => '')
          ).slice(0, BROWSER_SNAPSHOT_TEXT_LIMIT)
        };
      }
      case 'close_tab': {
        const closing = resolveTab(session, action.tabId);
        const open = [...session.tabs.values()].filter((page) => !page.isClosed());
        if (open.length === 1) throw new Error('The final browser tab cannot be closed');
        const wasActive = closing === session.page;
        await closing.close();
        if (wasActive) {
          const remaining = [...session.tabs.values()].find((page) => !page.isClosed());
          if (remaining) {
            session.page = remaining;
            await remaining.bringToFront();
          }
        }
        await this.#retargetStream(session);
        // The closed page cannot describe itself, so the result describes where control landed.
        acted = session.page;
        break;
      }
      case 'dialog': {
        const dialog = session.pendingDialog;
        if (!dialog) throw new Error('No page dialog is waiting for a response');
        delete session.pendingDialog;
        if (action.response === 'accept') await dialog.accept(action.promptText);
        else await dialog.dismiss();
        break;
      }
      case 'back': {
        const response = await page.goBack({ waitUntil: 'domcontentloaded' });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
      case 'reload': {
        const response = await page.reload({ waitUntil: 'domcontentloaded' });
        await this.#assertNavigationClean(session, page, response);
        break;
      }
    }
    return {
      url: acted.url(),
      title: await acted.title().catch(() => ''),
      tabId: tabIdFor(session, acted)
    };
  }

  /**
   * Condition-based waiting. A fixed sleep is either a flake or dead time, and without any wait
   * at all a snapshot taken straight after `navigate` on a single-page application returns the
   * empty shell — which is what the agent then tries to fill in.
   */
  async #waitFor(
    page: Page,
    action: Extract<BrowserPrimitiveAction, { type: 'wait_for' }>
  ): Promise<string> {
    const timeout = action.timeoutMs;
    if (action.selector) {
      await (
        await resolveBrowserTarget(page, action.selector)
      ).waitFor({
        state: action.state,
        timeout
      });
      return `${action.selector} is ${action.state}`;
    }
    if (action.text) {
      await page.getByText(action.text).first().waitFor({ state: 'visible', timeout });
      return `text “${action.text}” is visible`;
    }
    if (action.urlIncludes) {
      const fragment = action.urlIncludes;
      await page.waitForURL((url) => url.href.includes(fragment), { timeout });
      return `url contains “${fragment}”`;
    }
    await page.waitForLoadState('networkidle', { timeout });
    return 'network is idle';
  }

  /**
   * Where the browser actually ended up, and whether there is a challenge on it. Checking the
   * landed address rather than only the requested one is what closes the two ways a public URL
   * reaches a private host anyway: a redirect chain, and a name that resolves to something else on
   * the second lookup - the browser's - than it did on the first.
   *
   * Only while the agent is driving. The owner reaching their own router or a service on this box
   * from their own takeover session is not the threat this exists for, and refusing it would make
   * the browser useless for the one person entitled to use it that way.
   */
  async #assertNavigationClean(
    session: Session,
    page: Page,
    response: PageResponse | null
  ): Promise<void> {
    if (session.holder === 'agent') {
      if (!agentReachablePage(page.url())) throw agentDestinationRefused(page.url());
      // Absent for a page answered from the browser's own cache, where nothing left the machine.
      const server = response ? await response.serverAddr().catch(() => null) : null;
      if (server && !isPublicInternetAddress(server.ipAddress))
        throw new Error(
          `The browser connected to ${server.ipAddress}, which is not an address on the public internet`
        );
    }
    const wall = detectBotWall({
      url: page.url(),
      title: await page.title().catch(() => ''),
      frameUrls: page.frames().map((frame) => frame.url()),
      status: response?.status() ?? null,
      headers: response?.headers() ?? {}
    });
    if (!wall) return;
    throw new BotWallError(this.#raiseWall(session, page, wall));
  }

  /**
   * Prints the page the agent is looking at, after the network settles, which is the only route
   * from an authored HTML document to a PDF with real page breaks, headers and margins.
   */
  async printPdf(
    workspaceId: string,
    root: string,
    input: {
      path: string;
      format: string;
      landscape: boolean;
      printBackground: boolean;
      tabId?: string | undefined;
    },
    actor: 'agent' | 'user'
  ) {
    const session = await this.ensure(workspaceId, root);
    if (session.holder !== actor) throw new Error(`Browser control is held by ${session.holder}`);
    const page = resolveTab(session, input.tabId);
    if (actor === 'agent') await this.#assertNoWall(session, page);
    this.#assertReadablePage(page, actor);
    const relativePath = assertUserDataPath(root, input.path);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    // The bytes come back here and are written through the file API rather than by handing the
    // browser a path to open on its own. The browser would resolve that name a second time, after
    // these checks, which is a window the agent's account can put a symbolic link into.
    const pdf = await page.pdf({
      format: input.format,
      landscape: input.landscape,
      printBackground: input.printBackground
    });
    await writeWorkspaceFile(root, relativePath, pdf, this.options.maxFileBytes);
    return { path: relativePath, url: page.url(), title: await page.title().catch(() => '') };
  }

  async setHolder(workspaceId: string, root: string, holder: 'agent' | 'user' | 'secure_input') {
    const session = await this.ensure(workspaceId, root);
    session.holder = holder;
    // Handing the browser back is the owner saying the challenge is dealt with, and they are the
    // only one who can say it: nothing the model does clears a wall that has not passed by itself.
    if (holder === 'agent') session.walls.clearAll();
    await this.#notifyStreamState(session);
    return { holder };
  }

  async close(workspaceId: string): Promise<void> {
    // The search backoff belongs to the workspace rather than to the session, so closing the
    // browser is the one moment it is unambiguously stale: whatever the engine decided, it decided
    // it about work that is now over.
    this.#searchWalls.delete(workspaceId);
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    await session.context.close();
    await clearStagedUploads(session.root);
  }
}
