/** Shared approval facts and presentation bounds; no authority is derived here. */
import { type SecurityMode } from '@athanor/contracts';
import { type ResolvedMediaModel } from './media.js';
import { textValue } from './values.js';

export interface ApprovalContext {
  nativeInput?: {
    model: string;
    reservationUsd: number;
    sha256: string;
  };
  mediaCommittedUsd?: number;
  mediaModel?: ResolvedMediaModel;
  existingSkill?: {
    version: number;
    enabled: boolean;
    useCount: number;
    updatedAt: string;
  };
  undoPoint?: {
    id: string | null;
    uncovered?: readonly string[];
  };
  taintSources?: readonly string[];
  knownOrigins?: readonly string[];
  knownAddresses?: readonly string[];
  ownerText?: string;
  selfOrigins?: readonly string[];
  spentNoveltyBytes?: number;
}

export interface ApprovalRequirement {
  sideEffect: 'workspace_write' | 'external_reversible' | 'external_consequential';
  action: string;
  preview: string;
}

export const APPROVAL_RANK: Record<ApprovalRequirement['sideEffect'], number> = {
  workspace_write: 0,
  external_reversible: 1,
  external_consequential: 2
};

export const SECURITY_MODE_FLOOR: Record<
  SecurityMode,
  {
    readonly asksBeforeEveryChange: boolean;
    readonly asksBeforeReachingTheInternet: boolean;
    readonly asksBeforeInstallingSoftware: boolean;
    readonly sentence: string;
  }
> = {
  review: {
    asksBeforeEveryChange: true,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    sentence:
      'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.'
  },
  balanced: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: true,
    asksBeforeInstallingSoftware: true,
    sentence:
      'A command reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about; the built-in web tools read without asking.'
  },
  autonomous: {
    asksBeforeEveryChange: false,
    asksBeforeReachingTheInternet: false,
    asksBeforeInstallingSoftware: false,
    sentence:
      'Only what this computer cannot take back for you — publishing, sending, spending, destroying data, signing or accepting terms in your name, a startup file, hook, schedule, service or tool configuration it would run on its own afterwards, and a control on a screen that nothing could identify.'
  }
};

export const DEFERRED_EXECUTION_ACTION = 'Change a file this computer runs on its own';

const CARD_NAMED_OBJECTS = 6;

export const namedObjects = (values: readonly string[]): string => {
  const distinct = [...new Set(values.filter(Boolean))];
  const hidden = distinct.length - CARD_NAMED_OBJECTS;
  const shown = distinct.slice(0, CARD_NAMED_OBJECTS).join(', ');
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
};

const CARD_COMMAND_CHARS = 400;

export const shellInvocation = (args: Record<string, unknown>): string => {
  const invocation = [
    [
      textValue(args.executable).split('/').pop() ?? '',
      ...(Array.isArray(args.args) ? args.args.map(String) : [])
    ]
      .filter(Boolean)
      .join(' '),
    ...(textValue(args.stdin) ? [textValue(args.stdin)] : [])
  ]
    .filter(Boolean)
    .join(' << ');
  return invocation.length > CARD_COMMAND_CHARS
    ? `${invocation.slice(0, CARD_COMMAND_CHARS)}… and ${invocation.length - CARD_COMMAND_CHARS} more characters`
    : invocation;
};
