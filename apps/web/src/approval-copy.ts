/**
 * The three facts on an approval card, said the way the owner reads them.
 *
 * The card printed the stored enum ("connector_write") and an absolute timestamp ("expires
 * 8/2/2026, 1:14:22 AM"). Neither is what someone deciding whether to get up and answer it needs:
 * the useful form is what the agent is about to do, and how long is left.
 */
import { agentWording } from './approval-facts.js';
import type { ContextNote } from './provenance.js';
import type { Approval } from './types.js';

/**
 * What the agent is about to touch, taken from the tool the approval is bound to.
 *
 * The tool is the specific answer and the reversibility class below is the general one, and the
 * card says both. This table covers every tool that can raise an approval — a claim this comment
 * made for a long time while missing two of them, so both `approval-copy.test.ts` and
 * `scripts/check-repository.mjs` now read the tool names out of the worker's own approval floor
 * and hold this table against them. The repository check is the one that matters: a new branch in
 * `apps/worker/src/approval-policy.ts` fails the build rather than one client's test suite. The
 * two that were missing are the two whose subject is not the workspace: `audio_read`, which asks
 * about provider spend, and `parallel_web_read`, which asks about addresses data leaves by.
 *
 * Anything a newer box raises that this client has never heard of still falls through to the class.
 */
export const approvalToolPhrases: Record<string, string> = {
  shell: 'Runs a command on your computer',
  file_write: 'Changes a file on your computer',
  file_patch: 'Changes a file on your computer',
  print_pdf: 'Writes a PDF to your computer',
  desktop_launch: 'Opens an application on your computer',
  desktop_action: 'Uses an application on your computer',
  browser_action: 'Acts on a website',
  parallel_web_read: 'Opens addresses on the public internet',
  connector_action: 'Uses a connected account',
  publish_site: 'Puts something on the public internet',
  publish_preview: 'Creates a private preview link',
  publish_artifact: 'Publishes a file into this conversation',
  generate_media: 'Spends money at a provider',
  audio_read: 'Spends money at a provider to read a recording',
  coding_agent: 'Hands work to a coding agent',
  memory: 'Changes what athanor remembers',
  skill: 'Changes a saved skill',
  schedule: 'Changes scheduled work'
};

/**
 * How far the effect reaches, which is the only thing the box records about every approval.
 *
 * Written as a clause rather than as a sentence because it is always said, and said after the tool
 * phrase whenever there is one. It used to be the alternative to that phrase: `approvalReach`
 * returned the tool phrase when it had one and only fell back to this, so `sideEffect` — the single
 * fact the box records about every approval — was thrown away for sixteen of the eighteen tools
 * that can raise one. A `desktop_action` that may not be undoable and a `desktop_action` that can
 * be undone read as the same six words, on the one control where the difference is the decision.
 *
 * These are the three values the worker actually writes. The table this replaced was keyed on
 * `read`/`write`/`connector_write` and so on — none of which are ever stored — so every card in the
 * product fell through to the fallback and told the owner "External consequential".
 */
const reachClauses: Record<string, string> = {
  workspace_write: 'changes your computer',
  external_reversible: 'reaches outside your computer',
  external_consequential: 'reaches outside your computer, and may not be undoable'
};

/** An effect or tool this client does not know about still has to read as English, not as a column. */
const humanise = (value: string): string => value.replaceAll('_', ' ');

const sentence = (value: string): string => value.replace(/^./, (first) => first.toUpperCase());

export const approvalReach = (approval: {
  sideEffect: string;
  preview: Approval['preview'];
}): string => {
  const tool = typeof approval.preview === 'string' ? undefined : approval.preview.tool;
  const phrase = tool ? approvalToolPhrases[tool] : undefined;
  const reach = reachClauses[approval.sideEffect] ?? humanise(approval.sideEffect);
  // The separator the rest of this card already speaks: the eyebrow above joins its clauses the
  // same way, so a screen reader is not being handed a new punctuation habit here.
  return phrase ? `${phrase} · ${reach}` : sentence(reach);
};

export const expiryPhrase = (expiresAt: string, now = Date.now()): string => {
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return 'no time limit';
  if (remaining <= 0) return 'expired';
  if (remaining < 60_000) return `expires in ${Math.max(1, Math.round(remaining / 1_000))}s`;
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
};

/**
 * How long is left, and which way it fails if the owner never answers.
 *
 * A lapse is neither a block nor a denial. The worker treats an unanswered request as expired,
 * skips the action and carries the turn on — "Approval request expired without an answer, so the
 * action was not run" — and the only trace of it is one line in one transcript. The countdown is on
 * this card so the owner can decide whether to get up and answer it, and that decision needs the
 * consequence: a card saying only "expires in 23 hours" is read as "this waits for me".
 */
export const expiryNote = (expiresAt: string, now = Date.now()): string => {
  const phrase = expiryPhrase(expiresAt, now);
  if (phrase === 'no time limit') return phrase;
  return phrase === 'expired'
    ? 'expired · it was not run, and athanor carried on without it'
    : `${phrase} · if it lapses it is not run, and athanor carries on without it`;
};

/**
 * Where the instruction behind this request came from, from the row rather than from the timeline.
 *
 * Two answers to one question, and the recorded one wins. `origin` is written onto the approval by
 * the turn that raised it, so it is the only answer available for a request raised in a
 * conversation the owner is not looking at — which `nextApproval` deliberately makes the ordinary
 * case. The trajectory-derived note can only be computed for the conversation on screen, so the
 * card was silent about provenance for exactly the requests whose provenance is hardest to
 * remember. A repeat origin across tasks is the residual attack this whole separation exists to
 * make visible, and it is only visible if every card that has one says so.
 *
 * Put through `agentWording` for the same reason the facts are: the origin is derived from content
 * that came from outside, and a host with a bidirectional override in it renders as another host.
 */
export const approvalProvenance = (
  approval: Approval,
  context: ContextNote | undefined
): ContextNote | undefined => {
  const origin = agentWording(approval.origin ?? '', 120);
  return origin
    ? {
        exposed: true,
        text: `This request was raised on a turn that had read content from ${origin}. Whoever wrote that could be the one asking for this.`
      }
    : context;
};

/**
 * What the polite region says when a request arrives, and — mostly — that it says nothing.
 *
 * The card used to be `role="alertdialog" aria-live="assertive"`, and it re-renders every twenty
 * seconds to move its countdown. An assertive region re-reads whatever changed inside it, so a
 * screen reader interrupted the owner with "expires in 43s", then "expires in 23s", over the top of
 * the command they were trying to read — loudest in the last minute, when reading it matters most.
 *
 * So: once per request, and the sentence carries no number. Returning `undefined` for a request
 * already announced is the whole policy, and it is why the countdown can go on moving on screen.
 */
export const approvalAnnouncement = (input: {
  approval: Approval | undefined;
  /** How many are queued behind this one, which is worth hearing once and never again. */
  waiting: number;
  announcedId: string | undefined;
}): { id: string; message: string } | undefined => {
  const approval = input.approval;
  if (!approval || approval.id === input.announcedId) return undefined;
  return {
    id: approval.id,
    message: `Your confirmation is required. ${approvalReach(approval)}.${
      input.waiting > 1 ? ` ${input.waiting} waiting.` : ''
    }`
  };
};

/**
 * Which request the card is showing.
 *
 * The queue is never filtered to the open conversation — an agent that keeps working after you
 * leave means the request you must answer is usually not the one you are looking at — but when one
 * of them belongs to the conversation on screen, that is the one to put in front of the owner.
 */
export const nextApproval = (
  approvals: Approval[],
  openTaskId: string | undefined
): Approval | undefined =>
  approvals.find((approval) => approval.taskId === openTaskId) ?? approvals[0];

/**
 * Folding the files this card has managed to read back into the changes it is about to show.
 *
 * `file_write` carries only the new contents, so the current file has to be fetched to diff
 * against. Until every side of every change is known the card keeps showing the written preview: a
 * diff that briefly claims "new file" about a file being rewritten is worse than prose, and it is
 * shown at the exact moment the owner is deciding whether to allow the write.
 *
 * `null` in `fetched` records a path that was looked up and does not exist yet, which is a new file
 * rather than an empty one; a missing key means the lookup has not come back.
 */
export const approvalDiffState = <T extends { path: string; before?: string }>(
  changes: T[],
  fetched: Record<string, string | null>
): { changes: T[]; ready: boolean } => {
  const missing = changes.filter((change) => change.before === undefined);
  return {
    ready: missing.every((change) => change.path in fetched),
    changes: changes.map((change) => {
      const current = fetched[change.path];
      return change.before === undefined && typeof current === 'string'
        ? { ...change, before: current }
        : change;
    })
  };
};

/*
 * Mirrors APPROVAL_NOTE_MAX_CHARS, approvalNoteText and approvalDenialMessage in
 * @athanor/contracts. Copied rather than imported for the reason `usage-model.ts` and
 * `approval-facts.ts` both give: every other use of that package in this client is `import type`,
 * and pulling a runtime value in would drag the whole schema library into the first paint - which
 * this card cannot afford, being one of the few things that must already be built when a request
 * arrives. `approval-copy.test.ts` imports the real ones and holds this against them across a
 * table of inputs, so the copy cannot drift in silence.
 */
const APPROVAL_NOTE_MAX_CHARS = 600;
const NOTE_UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

const noteText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(NOTE_UNSAFE, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > APPROVAL_NOTE_MAX_CHARS
    ? `${clean.slice(0, APPROVAL_NOTE_MAX_CHARS)}…`
    : clean;
};

const toolWord = (value: string | null | undefined): string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : '';

/**
 * What the owner said when they refused, addressed to the agent, or nothing when they said nothing.
 *
 * A denial used to tell the agent only *that* it had been refused, so what it did next was try a
 * neighbouring version of the refused thing and the owner answered the same question twice. The
 * reason is what turns a wall into steering, and it goes back on the channel that already exists
 * for the owner's own words - a message to the conversation, marked as a correction so the paused
 * turn takes it at its next step boundary rather than after it has already tried something else.
 *
 * Empty means send nothing: a denial with the box untouched must cost exactly the one request a
 * denial cost before this field existed.
 */
export const approvalDenialMessage = (approval: Approval, note: string | null | undefined) => {
  const text = noteText(note);
  if (!text) return '';
  const tool = toolWord(typeof approval.preview === 'string' ? undefined : approval.preview.tool);
  return `I did not approve that ${tool ? `${tool} ` : ''}request. Here is why:\n\n${text}`;
};

/**
 * How much the box holds, so the browser stops the typing rather than the note being cut later.
 *
 * The clamp above still runs - a paste is not typing, and the sanitiser can only shorten - but a
 * `maxLength` is the difference between an owner who can see they have reached the end and one who
 * finds out afterwards that half their sentence was thrown away.
 */
export const approvalNoteLimit = APPROVAL_NOTE_MAX_CHARS;

/** The tools whose request can only really be judged by looking at the screen it is about. */
const computerTools = new Set(['browser_action', 'desktop_action', 'desktop_launch']);

/**
 * Whether this card should offer the computer.
 *
 * Two cases, and they are the same tools: a secure-input handoff cannot be answered from the card
 * at all — the agent is asking the owner to type something into a page it must not see — and a
 * click on an unnamed control is a question about a screen the owner cannot see from here. The tool
 * the approval is bound to says both. It used to be seven phrases matched against the preview
 * prose, so rewording one sentence in the worker silently removed the only route to the pane the
 * owner was being sent to, and an ordinary browser approval never offered it at all.
 */
export const needsComputer = (approval: Approval): boolean =>
  typeof approval.preview !== 'string' && computerTools.has(approval.preview.tool ?? '');
