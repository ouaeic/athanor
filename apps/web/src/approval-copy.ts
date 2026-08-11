/**
 * The three facts on an approval card, said the way the owner reads them.
 *
 * The card printed the stored enum ("connector_write") and an absolute timestamp ("expires
 * 8/2/2026, 1:14:22 AM"). Neither is what someone deciding whether to get up and answer it needs:
 * the useful form is what the agent is about to do, and how long is left.
 */
import type { Approval } from './types.js';

/**
 * What the agent is about to touch, taken from the tool the approval is bound to.
 *
 * The tool is the specific answer and the reversibility class below is the general one. This table
 * covers every tool that can raise an approval; anything else falls through to the class.
 */
const toolPhrases: Record<string, string> = {
  shell: 'Runs a command on your computer',
  file_write: 'Changes a file on your computer',
  file_patch: 'Changes a file on your computer',
  print_pdf: 'Writes a PDF to your computer',
  desktop_launch: 'Opens an application on your computer',
  desktop_action: 'Uses an application on your computer',
  browser_action: 'Acts on a website',
  connector_action: 'Uses a connected account',
  publish_site: 'Puts something on the public internet',
  publish_preview: 'Creates a private preview link',
  publish_artifact: 'Publishes a file into this conversation',
  generate_media: 'Spends money at a provider',
  coding_agent: 'Hands work to a coding agent',
  memory: 'Changes what athanor remembers',
  skill: 'Changes a saved skill',
  schedule: 'Changes scheduled work'
};

/**
 * How far the effect reaches, which is the only thing the box records about every approval.
 *
 * These are the three values the worker actually writes. The table this replaced was keyed on
 * `read`/`write`/`connector_write` and so on — none of which are ever stored — so every card in the
 * product fell through to the fallback and told the owner "External consequential".
 */
const reachPhrases: Record<string, string> = {
  workspace_write: 'Changes your computer',
  external_reversible: 'Reaches outside your computer',
  external_consequential: 'Reaches outside your computer, and may not be undoable'
};

/** An effect or tool this client does not know about still has to read as English, not as a column. */
const humanise = (value: string): string =>
  value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());

export const approvalReach = (approval: {
  sideEffect: string;
  preview: Approval['preview'];
}): string => {
  const tool = typeof approval.preview === 'string' ? undefined : approval.preview.tool;
  return (
    (tool ? toolPhrases[tool] : undefined) ??
    reachPhrases[approval.sideEffect] ??
    humanise(approval.sideEffect)
  );
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
