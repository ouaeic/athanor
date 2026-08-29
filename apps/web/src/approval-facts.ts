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

/**
 * How much of the END of an over-long sentence survives the cut.
 *
 * A card that names things ends by saying what it did not name - `and 34 more`, `and 143 more
 * characters` - and a cut taken from the end removes exactly that clause. What is left is six paths
 * broken off mid-path with no sign that thirty-four others are in the same call: a smaller claim
 * wearing the shape of a complete one, on the one control where the owner is answering for the
 * whole of it. The worker bounds these lists precisely so the card can say how much it left out
 * (`CARD_NAMED_OBJECTS`, `CARD_COMMAND_CHARS` in `approval-policy.ts`), and the client was removing
 * the half that says so on exactly the calls big enough to need it.
 *
 * Not a hypothetical shape here: forty patches over this repository's forty longest tracked paths
 * is a preview of 678 characters against the 600 below, and the owner saw `…foreground.png, app…`.
 * `path` carries no length limit in `tool-catalogue.ts`; the six longest tracked paths in this
 * repository are 612 characters between them.
 *
 * Eighty characters, and it is a bound on the ELISION rather than a reader of the sentence. The
 * card must not go looking for `and N more` in prose the worker owns - that is the mistake
 * `needsComputer` records at the bottom of `approval-copy.ts`, and a model-written sentence ending
 * in a forged count would be the reward for it. What is claimed here is only that a sentence ends
 * where it ends: the last eighty characters are kept whatever they say, so what survives reads as
 * the end of a sentence rather than as a fragment. The middle is what is spent, which in a list is
 * the part that repeats itself.
 *
 * Eighty is headroom over the clause that actually arrives, not a fit to it. The only closing
 * clause that reaches this clamp is `namedObjects`' own, and `tool-catalogue.ts` caps `file_patch`
 * at forty patches against `CARD_NAMED_OBJECTS` of six, so the widest it can be is `and 34 more` -
 * eleven characters. The wider clause the worker writes, `commandPreview`'s `… and 12345 more
 * characters`, never gets here at all: `CARD_COMMAND_CHARS` cuts that invocation at 400, which
 * leaves the whole preview around 427 and under the 600 below. Both are measured in
 * `approval-facts.test.ts`, one as the sentence this cuts and one as the sentence it never has to.
 */
const KEPT_TAIL = 80;

/**
 * How many addresses the card names, and therefore how many it does not.
 *
 * Read by the walk below and by the `parallel_web_read` row, which is what makes the card honest
 * about the difference: one call may carry twelve URLs, the walk stops at six, and a card showing
 * six of twelve without saying so is a smaller claim wearing the shape of a complete one.
 */
const DESTINATION_LIMIT = 6;

/*
 * Mirrors AUDIO_READ_MAX_SECONDS in @athanor/contracts — ninety minutes, the most one call reads.
 * Copied rather than imported for the reason `usage-model.ts` gives about the two spend ceilings:
 * every other use of that package here is `import type`, and pulling a runtime value in would drag
 * the whole schema library into the first paint to state one number. `approval-facts.test.ts`
 * imports the real constant and holds this against it, so the copy cannot drift in silence.
 */
const AUDIO_READ_MAX_SECONDS = 5_400;

// Stripped before the length is measured, so the limit counts characters the owner can actually see
// and the ellipsis lands where the text really stops. `keptTail` moves that ellipsis into the
// middle: nothing is added to what the owner sees, and the cut is taken out of the part of a
// sentence that says least rather than out of its last clause.
const clamp = (value: string, limit = CLAMP, keptTail = 0): string => {
  const visible = value.replace(DIRECTIONAL, '');
  if (visible.length <= limit) return visible;
  // Never more of the end than the limit leaves room for, so a caller with a short limit gets a
  // short answer rather than one longer than the thing it was cutting.
  const tail = Math.min(keptTail, limit);
  return tail > 0
    ? `${visible.slice(0, limit - tail)}…${visible.slice(-tail)}`
    : `${visible.slice(0, limit)}…`;
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
    if (found.size >= DESTINATION_LIMIT || depth > 5 || value === null || value === undefined)
      return;
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
 * `approvalRequestText` above falls back to a dump of the arguments when there is no prose, which
 * is a fact rather than a claim and belongs there with the other facts — not inside the quotation
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

/*
 * The verb and its fields are siblings, not a nested object.
 *
 * browser_action and desktop_action used to declare a variant per verb and carry the chosen one
 * under `action`; they now declare one property bag with the verb in `action` as a string, which is
 * about five kilobytes cheaper per request. The card reads the same fields it always read - this is
 * only where they sit.
 */
const browserFacts = (args: Record<string, unknown>): ApprovalFact[] => {
  const type = text(args.action);
  const steps = Array.isArray(args.actions) ? args.actions : [];
  const facts: ApprovalFact[] = [];
  if (type === 'batch') {
    // A batch is many actions wearing one name. What it is has to be the list, not the wrapper.
    facts.push({
      label: `Runs ${steps.length} step${steps.length === 1 ? '' : 's'}`,
      value: clamp(
        steps
          .map((step, index) => `${index + 1}. ${stepVerb(text(record(step)?.action, 'step'))}`)
          .join('  ·  ')
      )
    });
  } else if (type) {
    facts.push({ label: 'Does', value: stepVerb(type) });
  }
  facts.push(...fact('Selector', text(args.selector)));
  facts.push(...fact('Types', text(args.text)));
  facts.push(...fact('Key', text(args.key)));
  facts.push(...fact('Sends files', list(args.paths).join(', ')));
  facts.push(...fact('Answers the dialog with', text(args.response)));
  return facts;
};

const desktopFacts = (args: Record<string, unknown>): ApprovalFact[] => {
  const facts = fact('Application', text(args.application) || text(args.name));
  const type = text(args.action);
  facts.push(...fact('Does', type ? stepVerb(type) : ''));
  facts.push(...fact('Control', text(args.nodeId)));
  facts.push(...fact('Types', text(args.text)));
  facts.push(...fact('Key', text(args.key)));
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
    /*
     * The count, because the list below it is not the whole list.
     *
     * A read of twelve public sources raises a card only when the turn has already read untrusted
     * content and one of those addresses is a sink — which is to say, when the question is how much
     * is leaving and by which door. `approvalDestinations` names six of them, so the number of
     * doors is the one fact the card could not otherwise state.
     */
    case 'parallel_web_read': {
      const urls = list(args.urls);
      if (!urls.length) return [];
      return fact(
        'Reads',
        urls.length > DESTINATION_LIMIT
          ? `${urls.length} addresses, of which the first ${DESTINATION_LIMIT} are named below`
          : `${urls.length} address${urls.length === 1 ? '' : 'es'}`
      );
    }
    /*
     * Minutes, because minutes are what this call is billed in.
     *
     * The whole subject of an `audio_read` card is provider spend, and until now the card said so
     * only inside the quotation it attributes to the model — the half it teaches the owner to
     * discount. The window is what the call asks for rather than what the file turns out to hold,
     * so like the worker's own estimate this can only overstate, which is the right direction.
     *
     * The dollar figure is deliberately not lifted out of the sentence below. That sentence is the
     * worker's, but it is interpolated with the model's own `path`, so a path carrying a plausible
     * "about $0.001 …" clause would be read back as the estimate. Matching prose the worker owns is
     * the mistake `needsComputer` records at the bottom of `approval-copy.ts`.
     */
    case 'audio_read': {
      const start = Math.max(0, Number(args.startSeconds) || 0);
      const end = Number(args.endSeconds);
      const seconds = Math.min(
        AUDIO_READ_MAX_SECONDS,
        Number.isFinite(end) && end > start ? end - start : AUDIO_READ_MAX_SECONDS
      );
      return [
        ...fact('Recording', text(args.path)),
        ...fact(
          'Reads',
          `up to ${Math.ceil(seconds / 60)} minutes${start > 0 ? `, starting ${Math.floor(start / 60)} minutes in` : ''}`
        ),
        ...fact('Cost', 'billed by the minute of recording, to your own provider account')
      ];
    }
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
 *
 * `keptTail` is what a card's own sentence is cut with, and `KEPT_TAIL` says why. A caller showing
 * something that is not a sentence passes 0 and gets the plain cut.
 */
export const agentWording = (value: string, limit = 600, keptTail = KEPT_TAIL): string =>
  clamp(
    value
      .replace(DIRECTIONAL, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    limit,
    keptTail
  );
