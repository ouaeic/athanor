/**
 * What the box is about to do, read from the request rather than from the sentence about it.
 *
 * An approval card is the one moment where a compromised agent and its owner meet, and until now
 * every word on it was written by the agent. `action` and `preview` come from the model's own
 * `purpose` string for browser, desktop and several other tools, so an agent following an injected
 * instruction wrote its own card: "Continue reading the article" over a click that submits a form.
 * The owner reads the sentence, not the call.
 *
 * The call itself is a different kind of thing. `preview.arguments` is the literal argument object
 * the worker will execute, and it is bound: the approval carries a hash of exactly those arguments
 * and the worker re-checks it before acting, so what this module reads is what will run. Rewording
 * the sentence changes nothing here; changing the call invalidates the approval.
 *
 * So the card says both, and says which is which. The facts come from here. The model's sentence is
 * kept — it is often the only statement of intent, and an honest agent's reason is worth reading —
 * but it is shown as a quotation with its author named, underneath, where it can persuade nobody of
 * anything the arguments do not already say.
 */
import type { Approval } from './types.js';

/** One row of the card: something the harness knows, in the owner's words. */
export interface ApprovalFact {
  label: string;
  value: string;
}

/** Somewhere this request reaches, taken from the address and never from a description of it. */
export interface ApprovalDestination {
  host: string;
  url: string;
  /**
   * How much this address carries past the bare host.
   *
   * The number matters because it is the difference between fetching a page and posting a mailbox:
   * an address is how data leaves a computer without a file ever moving, and the payload lives in
   * the path and the query.
   */
  carriedCharacters: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : fallback;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];

/**
 * Characters that let a sentence say one thing and read as another: bidirectional overrides, which
 * reverse the text after them, and zero-width marks, which hide inside a word.
 *
 * Stripped from everything this module shows, not only the model's wording. That was the split
 * until now and it was the wrong way round: the sentence is the part the card teaches the owner
 * to discount, while the arguments are the part it binds a hash to and asks them to trust. One
 * U+202E inside a shell argument reverses the run of text after it, so the "Runs" row can read
 * as one command while the bytes the worker executes are another - approving what you read has
 * to mean approving what runs. This is the one place in the client
 * where a hostile string is put in front of someone who is about to answer yes or no, and a
 * sentence that renders as "Read an article" while containing something else is the cheapest
 * version of the attack this whole card exists to blunt.
 */
const DIRECTIONAL = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Long enough to judge by, short enough that the buttons stay on screen. */
const CLAMP = 400;

// Stripped before the length is measured, so the limit counts characters the owner can actually see
// and the ellipsis lands where the text really stops.
const clamp = (value: string, limit = CLAMP): string => {
  const visible = value.replace(DIRECTIONAL, '');
  return visible.length > limit ? `${visible.slice(0, limit)}…` : visible;
};

const fact = (label: string, value: string): ApprovalFact[] =>
  value ? [{ label, value: clamp(value) }] : [];

/**
 * The host exactly as written.
 *
 * Deliberately not `hostOf` from the transcript, which drops a leading `www.` so a source chip
 * reads the way a person says it. On this card the host is the thing being decided, and
 * `www.bank.example` is not `bank.example`.
 */
const address = (raw: string): ApprovalDestination | undefined => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return {
      host: url.host,
      url: url.href,
      carriedCharacters: Math.max(0, url.href.length - url.origin.length - 1)
    };
  } catch {
    return undefined;
  }
};

/**
 * Every address anywhere in the arguments, however the tool happens to nest them.
 *
 * A walk rather than a field list, because the address is the part of a request that decides where
 * data goes and there is no tool for which it is safe to miss one: a URL inside a batch step, a URL
 * in a shell argument and a URL in a connector body are the same fact about the same decision.
 */
export const approvalDestinations = (approval: Approval): ApprovalDestination[] => {
  const found = new Map<string, ApprovalDestination>();
  const visit = (value: unknown, depth: number): void => {
    if (found.size >= 6 || depth > 5 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const candidate of value.split(/\s+/)) {
        if (!/^https?:\/\//i.test(candidate)) continue;
        const destination = address(candidate);
        if (destination && !found.has(destination.url)) found.set(destination.url, destination);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const entry = record(value);
    if (!entry) return;
    for (const [key, item] of Object.entries(entry)) {
      // `purpose` is the model's sentence about the call. An address inside it is a claim, not a
      // destination, and putting it on the card would hand the sentence back its authority.
      if (key === 'purpose') continue;
      visit(item, depth + 1);
    }
  };
  visit(structured(approval)?.arguments, 0);
  return [...found.values()];
};

const structured = (
  approval: Approval
): { preview?: string; tool?: string; arguments?: unknown } | undefined =>
  typeof approval.preview === 'string' ? undefined : approval.preview;

/**
 * The request itself, for a tool this client has no rows for.
 *
 * A box can add a tool without the client learning about it, and the honest answer then is the call
 * as it will run rather than nothing at all. It is still the harness's own record — unreadable is
 * better than persuasive.
 */
export const approvalRequestText = (approval: Approval): string => {
  const args = structured(approval)?.arguments;
  if (!record(args)) return '';
  const operative = Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(([key]) => key !== 'purpose')
  );
  return Object.keys(operative).length ? JSON.stringify(operative, null, 2) : '';
};

/**
 * The model's sentence about the call, and nothing else.
 *
 * `approvalPreviewText` falls back to a dump of the arguments when there is no prose, which is a
 * fact rather than a claim and belongs above with the other facts — not inside the quotation
 * attributed to the model.
 */
export const agentSentence = (approval: Approval): string => {
  const preview = structured(approval);
  const claims = [approval.action, typeof approval.preview === 'string' ? approval.preview : ''];
  if (preview && typeof preview.preview === 'string') claims.push(preview.preview);
  return agentWording(
    claims
      .map((value) => value.trim())
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .join('\n')
  );
};

/** A browser or desktop step, said as the thing it does rather than as its enum. */
const stepVerbs: Record<string, string> = {
  navigate: 'Open a page',
  click: 'Click',
  double_click: 'Double-click',
  click_at: 'Click a coordinate',
  type: 'Type',
  press: 'Press a key',
  upload: 'Upload files',
  dialog: 'Answer a page dialog',
  scroll: 'Scroll',
  select: 'Choose from a list',
  invoke: 'Activate a control',
  drag: 'Drag',
  batch: 'Run several steps'
};

const stepVerb = (type: string): string => stepVerbs[type] ?? type.replaceAll('_', ' ');

const browserFacts = (args: Record<string, unknown>): ApprovalFact[] => {
  const action = record(args.action);
  if (!action) return [];
  const type = text(action.type);
  const steps = Array.isArray(action.actions) ? action.actions : [];
  const facts: ApprovalFact[] = [];
  if (type === 'batch') {
    // A batch is many actions wearing one type. What it is has to be the list, not the wrapper.
    facts.push({
      label: `Runs ${steps.length} step${steps.length === 1 ? '' : 's'}`,
      value: clamp(
        steps
          .map((step, index) => `${index + 1}. ${stepVerb(text(record(step)?.type, 'step'))}`)
          .join('  ·  ')
      )
    });
  } else if (type) {
    facts.push({ label: 'Does', value: stepVerb(type) });
  }
  facts.push(...fact('Selector', text(action.selector)));
  facts.push(...fact('Types', text(action.text)));
  facts.push(...fact('Key', text(action.key)));
  facts.push(...fact('Sends files', list(action.paths).join(', ')));
  facts.push(...fact('Answers the dialog with', text(action.response)));
  return facts;
};

const desktopFacts = (args: Record<string, unknown>): ApprovalFact[] => {
  const action = record(args.action);
  const facts = fact('Application', text(args.application) || text(args.name));
  if (!action) return facts;
  facts.push(...fact('Does', action.type ? stepVerb(text(action.type)) : ''));
  facts.push(...fact('Control', text(action.nodeId)));
  facts.push(...fact('Types', text(action.text)));
  facts.push(...fact('Key', text(action.key)));
  return facts;
};

/**
 * The rows for one request.
 *
 * Nothing here reads `purpose`, `reason`, or any other field whose only job is to describe the call
 * to a person — those are the model's, and they appear on the card under the model's name. What is
 * read is what the box will do: the command it will run, the path it will write, the address it
 * will reach, the text it will store.
 */
export const approvalFacts = (approval: Approval): ApprovalFact[] => {
  const preview = structured(approval);
  const args = record(preview?.arguments);
  const tool = text(preview?.tool);
  if (!args) return [];
  switch (tool) {
    case 'shell': {
      const command = [text(args.executable), ...list(args.args)].filter(Boolean).join(' ');
      return [
        ...fact('Runs', command),
        ...fact('In', text(args.cwd, 'workspace')),
        ...fact('Internet access', args.network === true ? 'yes' : 'no'),
        ...fact('Runs in the background', args.background === true ? 'yes' : '')
      ];
    }
    case 'file_write':
    case 'file_patch':
    case 'print_pdf':
      return [
        ...fact('File', text(args.path)),
        ...fact('Files', list(args.paths).join(', ')),
        ...fact('New file', args.createOnly === true ? 'yes' : '')
      ];
    case 'browser_action':
      return browserFacts(args);
    case 'desktop_action':
    case 'desktop_launch':
      return desktopFacts(args);
    case 'connector_action':
      return [
        ...fact('Operation', text(args.action).replaceAll(':', ' · ').replaceAll('.', ' ')),
        ...fact('Connection', text(args.connectorId) || text(args.connector)),
        ...fact('To', list(args.to).join(', ') || text(args.to)),
        ...fact('Subject', text(args.subject)),
        ...fact('Path', text(args.path))
      ];
    case 'publish_site':
    case 'publish_preview':
      return [
        ...fact('Reachable by', tool === 'publish_site' ? 'anyone with the link' : 'you'),
        ...fact('Serves workspace port', text(args.port)),
        ...fact('Label', text(args.label))
      ];
    case 'publish_artifact':
      return [...fact('File', text(args.path)), ...fact('Name', text(args.name))];
    case 'generate_media':
      return [
        ...fact('Kind', text(args.kind)),
        ...fact('Size', [text(args.width), text(args.height)].filter(Boolean).join(' × ')),
        ...fact('Count', text(args.count))
      ];
    case 'coding_agent':
      return [
        ...fact('Agent', text(args.agent)),
        ...fact('Does', text(args.action)),
        ...fact('Working directory', text(args.cwd))
      ];
    case 'memory':
      return [
        ...fact('Does', text(args.action, 'save')),
        ...fact('Scope', text(args.target, 'workspace')),
        ...fact('Until', text(args.validUntil, 'no expiry — it is remembered indefinitely')),
        // The stored text is the operative part of this call: it is read back into later tasks as
        // something athanor believes. Shown in full, up to the clamp, because that is the decision.
        ...fact('Stores', text(args.content))
      ];
    case 'skill':
      return [
        ...fact('Does', text(args.action)),
        ...fact('Skill', text(args.name) || text(args.id)),
        ...fact('Stores', text(args.content))
      ];
    case 'schedule':
      return [
        ...fact('Does', text(args.action)),
        ...fact('Named', text(args.title)),
        ...fact('When', JSON.stringify(args.spec ?? '') === '""' ? '' : JSON.stringify(args.spec)),
        ...fact('Will ask athanor to', text(args.prompt))
      ];
    default:
      return [];
  }
};

/**
 * The model's own wording, made safe to display and honest about its length.
 *
 * Blank lines are collapsed rather than preserved: a preview of four hundred newlines pushes Deny
 * and Approve off a phone screen, and nothing legitimate needs them.
 */
export const agentWording = (value: string, limit = 600): string =>
  clamp(
    value
      .replace(DIRECTIONAL, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    limit
  );
