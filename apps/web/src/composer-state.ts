/**
 * What the message box does with a keystroke, decided away from the box itself.
 *
 * The composer is the one control in athanor that is used every session and by every route in, and
 * its behaviour was thirty lines inside a two-thousand-line component: whether Enter sends, what
 * the message actually says once its files are attached, and which of the four things that can be
 * wrong the owner is told about. All of that is decided here so it can be exercised.
 */
import { withAttachments, type Attachment } from './attachments.js';
import { modelDisplayName, type NamedModel } from './model-names.js';
import { securityModeCopy } from './security-mode.js';
import type { SecurityMode } from './types.js';

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
      // athanor is already trying: the client asks the box to start a computer that is asleep or
      // failed, on load and every five minutes. Saying "check the server" while that is happening
      // sent the owner off to look at something being handled, and there was nothing on the other
      // screen to do anyway - which is how a computer that failed to start once became permanent.
      //
      // It used to promise a button on the other screen. That button is drawn only for a computer
      // that has failed or is hibernating, and the state this fires in most often - a first sign-in,
      // no workspace at all yet - is neither, so the destination was empty. Settings says what the
      // computer is doing, which is true in every case this can fire in.
      message: 'Starting the agent computer. Nothing can run until it is up.',
      actionLabel: 'Open Settings'
    };
  if (!input.providerConfigured)
    return {
      code: 'provider_missing',
      // Where the key goes is said where the key is entered. Here it was a second sentence
      // explaining a reassurance nobody had asked for yet, next to a button that says the rest.
      message: 'No AI provider is connected yet.',
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
 * The two are offered in one list, so one set of option values has to carry two different kinds of
 * answer. The `auto:` prefix is the encoding, and it is decided here rather than inside the markup
 * because a mis-parse silently pins a conversation to a model called "auto:best".
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
 * What the one chip on the tool row says about how this turn will be answered.
 *
 * It stands in for two full-width `<select>`s and a permanent disclaimer footer that between them
 * took 62px of a 375px phone - a third of the composer - to state three things an owner changes a
 * few times a year. The label is the shortest true sentence and nothing more: the mode always,
 * because it governs what happens without asking, and a model name only when the owner pinned one.
 * Printing a name under automatic routing would be a promise the router does not make - it picks
 * per turn - and a chip that says "Balanced" and nothing else is the honest answer there.
 */
export const composerContextLabel = (input: {
  providerConfigured: boolean;
  securityMode: SecurityMode;
  modelChoice: ModelChoice;
  models: readonly NamedModel[];
}): string => {
  if (!input.providerConfigured) return 'Connect AI';
  const mode = securityModeCopy[input.securityMode].label;
  if (input.modelChoice.automatic) return mode;
  // A pinned id the catalogue has never heard of still resolves to its tail; only a pin with no id
  // at all leaves nothing to say, and a trailing "Balanced · " would be worse than saying less.
  const name = modelDisplayName(input.models, input.modelChoice.modelId);
  return name ? `${mode} · ${name}` : mode;
};

/** Everything the sheet needs from the catalogue: a name, and whether it can answer. */
export interface SheetModel {
  id: string;
  displayName: string;
  availability: string;
}

export interface ModelSheetOption {
  /** The same encoding `modelChoiceFromValue` reads, so the sheet and the ranking cannot disagree. */
  value: string;
  label: string;
  /** Why this one cannot answer, in the terms this box is configured with. Empty when it can. */
  note: string;
  disabled: boolean;
}

export interface ModelSheetGroup {
  label: string;
  options: ModelSheetOption[];
}

/**
 * The model list as the sheet draws it, with the reasons attached.
 *
 * This was `<optgroup>` markup with the availability wording inlined three times, which is why a
 * model held back for a licence review and one with no private route read the same in a privacy
 * build. A model that cannot answer is still listed, disabled, with the reason beside it: dropping
 * it silently is what makes an owner think athanor has lost their model.
 */
export const modelSheetGroups = (input: {
  models: readonly SheetModel[];
  unavailableModels: readonly SheetModel[];
  enforceZeroDataRetention: boolean;
}): ModelSheetGroup[] => {
  const empty = input.models.length === 0;
  const groups: ModelSheetGroup[] = [
    {
      label: 'Automatic',
      options: [
        {
          value: 'auto:balanced',
          label: empty ? 'No model available' : 'Recommended',
          note: '',
          disabled: empty
        },
        { value: 'auto:fast', label: 'Faster', note: '', disabled: empty },
        { value: 'auto:best', label: 'Higher quality', note: '', disabled: empty }
      ]
    }
  ];
  if (!empty)
    groups.push({
      label: 'Choose a specific model',
      options: input.models.map((model) => ({
        value: model.id,
        label: model.displayName,
        note: '',
        disabled: false
      }))
    });
  if (input.unavailableModels.length)
    groups.push({
      label: input.enforceZeroDataRetention
        ? 'Unavailable · no verified private route'
        : 'Currently unavailable',
      options: input.unavailableModels.map((model) => ({
        value: model.id,
        label: model.displayName,
        note:
          model.availability === 'review'
            ? 'licence review required'
            : input.enforceZeroDataRetention
              ? 'private route unavailable'
              : 'provider unavailable',
        disabled: true
      }))
    });
  return groups;
};

/**
 * Where inference goes, and where a search goes when that is somewhere else.
 *
 * This sentence used to be printed under the composer for ever, which is how a fact worth a glance
 * on the day it changes became wallpaper. It is one line inside the sheet that changes it, on the
 * control that changes it.
 */
export const privacyLine = (input: {
  enforceZeroDataRetention: boolean;
  webSearchNote?: string;
}): string => {
  const route = input.enforceZeroDataRetention
    ? 'Private AI routes only'
    : 'Provider data policy applies';
  return input.webSearchNote ? `${route} · ${input.webSearchNote}` : route;
};

export interface ComposerMenuItem {
  action: 'attach' | 'photo' | 'schedule' | 'folder';
  label: string;
  disabled: boolean;
}

/**
 * What the single `+` offers, which is everything that used to be its own permanent icon.
 *
 * Four to six buttons sat on the tool row and two of them were already hidden below 430px, so the
 * phone had a different set of capabilities from the laptop with nothing on screen saying so. One
 * button, one list, the same list everywhere - except the folder import, which only the native
 * client can actually perform and so is only offered where it works.
 *
 * The microphone is deliberately not in here. It stays on the row because voice is the one input a
 * phone is better at than a laptop, and burying it two taps deep on the device it suits best would
 * be the wrong trade.
 */
export const composerMenuItems = (input: {
  workspaceAvailable: boolean;
  busy: boolean;
  canImportFolder: boolean;
}): ComposerMenuItem[] => [
  // Attaching stays available with the computer down: the upload is this server's business, and a
  // file put on a draft now is one the owner does not have to find again once the box is back.
  { action: 'attach', label: 'Attach files', disabled: false },
  { action: 'photo', label: 'Take a photo', disabled: !input.workspaceAvailable || input.busy },
  { action: 'schedule', label: 'Schedule this work', disabled: !input.workspaceAvailable },
  ...(input.canImportFolder
    ? [{ action: 'folder' as const, label: 'Import a local folder', disabled: false }]
    : [])
];

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
