import type { RewindScope, TaskRewindPreview } from './types.js';

/**
 * Two things go back, and they are not the same thing.
 *
 * Editing a message has never restored a file, and the dialog used to say so in a sentence that
 * closed the subject: "files and apps already changed on the agent computer are not rewound". The
 * server can now put the machine back as well, so the choice is the owner's — and a choice about
 * files is only honest if it says what it would do to them before it does it. Everything here
 * reads one `TaskRewindPreview` and turns it into the sentences the dialog shows; nothing here
 * decides anything, so it can be held to its wording in a test.
 */

/**
 * What the dialog is currently proposing: which turn, how far back, and — for an edit — the message
 * as the owner is rewriting it. Declared beside the wording it drives so the dialog, the workbench
 * that opens it and the tests all describe the same object.
 */
export type TrajectoryDraft = { rewind: RewindScope } & (
  | { operation: 'edit'; eventId: string; prompt: string; stopSource: boolean }
  | { operation: 'retry'; eventId: string; stopSource: boolean }
);

/** The sentence the server itself answers a missing checkpoint with, said before the attempt. */
export const NO_CHECKPOINT_REASON =
  'That turn changed nothing on the computer, or its undo point has been cleared.';

const UNREACHABLE_REASON =
  'The computer could not be asked what a rewind would change, so it is not offered.';

const PENDING_REASON = 'Working out what this would change on the computer…';

/** What the dialog knows so far. A preview that failed is a state, not a silent absence. */
export type RewindPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: TaskRewindPreview }
  | { status: 'failed'; message: string };

export interface RewindOffer {
  /** Whether the computer can be put back to this point at all. */
  computerAvailable: boolean;
  /** Why it cannot, in plain words. Empty when it can. */
  computerReason: string;
  /** The checkpoint that would be restored, named so the request restores the previewed one. */
  checkpointId: string | undefined;
  /** When that checkpoint was taken. */
  checkpointAt: string | undefined;
  /** What a computer rewind would do, one clause per kind of change. */
  changes: string[];
  /** What it would leave alone — the part owners get wrong when nobody tells them. */
  caveats: string[];
  /** Conversation after this point, which a conversation rewind leaves behind. */
  droppedEventCount: number;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export const rewindOffer = (preview: TaskRewindPreview | undefined): RewindOffer => {
  if (!preview)
    return {
      computerAvailable: false,
      computerReason: PENDING_REASON,
      checkpointId: undefined,
      checkpointAt: undefined,
      changes: [],
      caveats: [],
      droppedEventCount: 0
    };
  const base = {
    checkpointId: preview.checkpoint?.id,
    checkpointAt: preview.checkpoint?.createdAt,
    droppedEventCount: preview.droppedEventCount
  };
  if (!preview.checkpoint)
    return {
      ...base,
      computerAvailable: false,
      computerReason: NO_CHECKPOINT_REASON,
      changes: [],
      caveats: []
    };
  // A checkpoint with no readable preview means the computer is not answering, and a restore it
  // cannot describe is one it probably cannot perform either. Refusing beats a blind rollback.
  if (!preview.computer)
    return {
      ...base,
      computerAvailable: false,
      computerReason: UNREACHABLE_REASON,
      changes: [],
      caveats: []
    };
  const computer = preview.computer;
  const changes = [
    computer.modifiedCount
      ? `${plural(computer.modifiedCount, 'file goes', 'files go')} back to how they were`
      : '',
    computer.addedCount
      ? `${plural(computer.addedCount, 'file', 'files')} created since then ${computer.addedCount === 1 ? 'is' : 'are'} removed`
      : '',
    computer.deletedCount
      ? `${plural(computer.deletedCount, 'file', 'files')} deleted since then ${computer.deletedCount === 1 ? 'comes' : 'come'} back`
      : ''
  ].filter(Boolean);
  const caveats = [
    computer.packagesInstalled.length
      ? `${plural(computer.packagesInstalled.length, 'package', 'packages')} installed since then stay installed — a rewind does not uninstall anything`
      : '',
    computer.uncovered.length
      ? `${plural(computer.uncovered.length, 'file is', 'files are')} too large for a restore point to hold and stay exactly as they are`
      : '',
    computer.truncated ? 'The lists are shortened; the counts are the totals.' : ''
  ].filter(Boolean);
  return {
    ...base,
    computerAvailable: true,
    computerReason: '',
    changes: changes.length ? changes : ['Nothing on the computer has changed since that point.'],
    caveats
  };
};

/**
 * The three choices, in the order they escalate. Held here rather than in the dialog so the option
 * a person reads and the note underneath it cannot describe different things.
 */
export const rewindScopeChoices: ReadonlyArray<{
  scope: RewindScope;
  label: string;
  hint: string;
}> = [
  {
    scope: 'conversation',
    label: 'The conversation',
    hint: 'Files and apps on the computer stay as they are.'
  },
  {
    scope: 'computer',
    label: 'The computer',
    hint: 'Files go back to this point. The conversation carries on.'
  },
  {
    scope: 'both',
    label: 'Both',
    hint: 'The conversation and the computer go back together.'
  }
];

/**
 * What the dialog's own heading, explanation and confirm button say.
 *
 * Taking only the computer back forks nothing, so calling it a "new version" — which the dialog did
 * whenever the scope was changed after the dialog opened — described the opposite of what the
 * button would do.
 */
export const rewindDialogCopy = (
  operation: 'edit' | 'retry',
  scope: RewindScope,
  busy = false
): { eyebrow: string; title: string; explanation: string; confirm: string } => {
  const computerOnly = scope === 'computer';
  return {
    eyebrow: computerOnly ? 'Take the computer back' : 'New version',
    title: computerOnly
      ? 'Put the computer back'
      : operation === 'edit'
        ? 'Edit and resend'
        : 'Regenerate this answer',
    explanation: computerOnly
      ? 'This conversation is left exactly as it is. Only the files on the agent computer go back.'
      : operation === 'edit'
        ? 'Your original message and everything after it stay in this conversation. The edited version starts as a new one.'
        : 'The answer and everything after it are left out. The message before it runs again as a new version.',
    confirm: busy ? 'Working…' : computerOnly ? 'Put the computer back' : 'Start new version'
  };
};

/**
 * Whether the dialog should offer to stop the conversation it is forking from. Nothing forks when
 * only the computer goes back, so there is no second agent to keep off the same machine.
 */
export const offersStopSource = (scope: RewindScope, taskIsLive: boolean): boolean =>
  scope !== 'computer' && taskIsLive;

/** What this scope actually does, said before it is chosen rather than discovered afterwards. */
export const rewindScopeNote = (scope: RewindScope): string =>
  scope === 'conversation'
    ? 'Conversation state, pending approvals and queued follow-ups after this point are left behind. Files and apps on the agent computer stay exactly as they are now.'
    : scope === 'computer'
      ? 'The agent computer goes back to this point. This conversation carries on where it is, with a line in it recording what happened to the files.'
      : 'The conversation and the agent computer both go back to this point. Anything installed since then stays installed.';

/** What happened, in the same terms the choice was made in. */
export const rewindResultNotice = (
  operation: 'branch' | 'edit' | 'retry',
  scope: RewindScope
): string => {
  if (scope === 'computer')
    return 'The agent computer has been put back to that point. This conversation carries on from where it is.';
  const machine =
    scope === 'both' ? ' The agent computer has been put back to that point as well.' : '';
  if (operation === 'edit')
    return `New version started from your edited message. The original conversation is preserved.${machine}`;
  if (operation === 'retry')
    return `New version started from the message before that answer.${machine}`;
  return `Branch created. The original conversation stays untouched; send a message to take this one somewhere new.${machine}`;
};
