/**
 * What the message box does with a keystroke, decided away from the box itself.
 *
 * The composer is the one control in athanor that is used every session and by every route in, and
 * its behaviour was thirty lines inside a two-thousand-line component: whether Enter sends, what
 * the message actually says once its files are attached, and which of the four things that can be
 * wrong the owner is told about. All of that is decided here so it can be exercised.
 */
import { withAttachments, type Attachment } from './attachments.js';

export type SendBlockCode =
  | 'workspace_unavailable'
  | 'provider_missing'
  | 'private_route_unavailable'
  | 'model_unavailable';

export interface SendBlock {
  code: SendBlockCode;
  message: string;
  /** Every block names the control that repairs it, so the message is never a dead end. */
  actionLabel: string;
}

/**
 * Why a typed message cannot be sent yet, or undefined when it can.
 *
 * Pressing Enter must never be a no-op: the composer asks this before sending and, when it gets an
 * answer back, shows it with its repair action instead of silently discarding the keystroke.
 */
export const sendBlock = (input: {
  workspaceAvailable: boolean;
  providerConfigured: boolean;
  enforceZeroDataRetention: boolean;
  availableModelCount: number;
  modelId: string;
}): SendBlock | undefined => {
  if (!input.workspaceAvailable)
    return {
      code: 'workspace_unavailable',
      message:
        'The agent computer is not responding, so this cannot run yet. Check the server from Settings.',
      actionLabel: 'Open Settings'
    };
  if (!input.providerConfigured)
    return {
      code: 'provider_missing',
      message:
        'Connect an AI provider to send this. Your key goes straight from this server to the provider you choose.',
      actionLabel: 'Connect a provider'
    };
  if (input.availableModelCount === 0)
    return input.enforceZeroDataRetention
      ? {
          code: 'private_route_unavailable',
          message:
            'No model is available under your current privacy setting. Change it, or connect a provider that keeps nothing.',
          actionLabel: 'Review privacy setting'
        }
      : {
          code: 'model_unavailable',
          message: 'Your provider is not offering any usable model right now.',
          actionLabel: 'Open AI settings'
        };
  if (!input.modelId)
    return {
      code: 'model_unavailable',
      message: 'Choose a model before sending.',
      actionLabel: 'Open AI settings'
    };
  return undefined;
};

/**
 * Whether a keystroke in the message box is a send.
 *
 * Enter sends and Shift+Enter is a newline, which is what a chat box does. ⌘Enter sends as well:
 * it is what people arriving from an editor reach for, and holding a modifier should never be the
 * thing that swallows a message.
 */
export const sendsOnKey = (event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean => event.key === 'Enter' && (!event.shiftKey || event.metaKey || event.ctrlKey);

/** A message with nothing but files is a real message: "look at this" is often the whole request. */
export const hasSomethingToSend = (prompt: string, attachments: Attachment[]): boolean =>
  prompt.trim().length > 0 || attachments.some((item) => item.status === 'ready');

export type ComposerSubmission =
  /** Nothing to send, or a send already in flight. The keystroke is simply absorbed. */
  | { kind: 'nothing' }
  /** An upload is still running; sending now would attach a path with no bytes behind it. */
  | { kind: 'wait'; message: string }
  /**
   * Something must be repaired first. The keystroke is never a no-op: the draft is kept and the
   * block is already on screen with the control that repairs it, directly above the composer.
   */
  | { kind: 'blocked'; block: SendBlock }
  | {
      kind: 'send';
      /** What the owner wrote, with the uploaded paths appended as a trailer the transcript reads. */
      text: string;
      /** Kept apart so a failed send can put exactly these back on the tray. */
      attachments: Attachment[];
    };

/**
 * What pressing send does, given everything the composer knows.
 *
 * Order matters and is the point of having this in one place: an upload in flight is reported
 * before a configuration problem, because it clears on its own in a few seconds, and both are
 * reported before anything is cleared from the draft.
 */
export const composerSubmission = (input: {
  prompt: string;
  attachments: Attachment[];
  block: SendBlock | undefined;
  busy: boolean;
}): ComposerSubmission => {
  const typed = input.prompt.trim();
  const ready = input.attachments.filter((item) => item.status === 'ready');
  if ((!typed && !ready.length) || input.busy) return { kind: 'nothing' };
  if (input.attachments.some((item) => item.status === 'uploading'))
    return { kind: 'wait', message: 'One of the attachments is still uploading.' };
  if (input.block) return { kind: 'blocked', block: input.block };
  return {
    kind: 'send',
    text: withAttachments(
      typed,
      ready.map((item) => item.path)
    ),
    attachments: ready
  };
};

/**
 * Which model answers: either a ranking athanor keeps up to date, or one the owner pinned.
 *
 * The two live in one `<select>`, so one option list has to carry two different kinds of answer.
 * The `auto:` prefix is the encoding, and it is decided here rather than inside the markup because
 * a mis-parse silently pins a conversation to a model called "auto:best".
 */
export type ModelPreference = 'fast' | 'balanced' | 'best';

export type ModelChoice =
  | { automatic: true; preference: ModelPreference }
  | { automatic: false; modelId: string };

const modelPreferences = new Set<string>(['fast', 'balanced', 'best']);

export const modelSelectValue = (choice: ModelChoice): string =>
  choice.automatic ? `auto:${choice.preference}` : choice.modelId;

export const modelChoiceFromValue = (value: string): ModelChoice => {
  if (!value.startsWith('auto:')) return { automatic: false, modelId: value };
  const preference = value.slice('auto:'.length);
  return {
    automatic: true,
    preference: modelPreferences.has(preference) ? (preference as ModelPreference) : 'balanced'
  };
};

/**
 * What the empty message box invites, which is the only place the state of the conversation is
 * worth restating: a follow-up sent while the agent is working runs after this turn rather than
 * interrupting it, and that is not obvious from anything else on screen.
 */
export const composerPlaceholder = (input: {
  workspaceAvailable: boolean;
  taskOpen: boolean;
  taskLive: boolean;
}): string => {
  if (!input.workspaceAvailable) return 'The agent computer is unavailable…';
  if (input.taskLive) return 'Add a follow-up — it will run next…';
  return input.taskOpen ? 'Follow up on this conversation…' : 'Ask athanor to do anything…';
};
