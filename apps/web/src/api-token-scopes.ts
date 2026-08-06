/**
 * What an API token may do, said in the owner's words, and what the form does with their answers.
 *
 * Every scope declared and enforced on the server is offered here. The form used to hard-code
 * seven and an expiry of ninety days, so the rest — approvals, usage, connectors — could not be
 * granted by any token this box was able to issue, and the routes behind them were unreachable to
 * every script the owner wrote. A setting that is enforced but not settable is not a setting.
 *
 * The list is written out here rather than imported: `ApiTokenScope` is a Zod enum, and pulling the
 * schema runtime into the browser to render the checkboxes would cost the first paint more
 * than the whole feature is worth. `api-token-scopes.test.ts` imports the enum instead and fails if
 * this table and the server's list ever disagree, which is the drift the import was meant to stop.
 */
import type { ApiTokenScope } from './types.js';

export interface ApiTokenScopeCopy {
  scope: ApiTokenScope;
  /** What granting it lets a script do. Never the scope string. */
  label: string;
  /** The part an owner needs before ticking it, especially where it can act rather than read. */
  detail: string;
}

export const apiTokenScopeCopy: readonly ApiTokenScopeCopy[] = [
  {
    scope: 'workspaces:read',
    label: 'See this computer',
    detail: 'Its name, status, disk use and published links.'
  },
  {
    scope: 'workspaces:write',
    label: 'Change this computer',
    detail: 'Publish and revoke links, and drive the browser, desktop and terminal.'
  },
  {
    scope: 'tasks:read',
    label: 'Read conversations',
    detail: 'Conversations, their transcripts and their schedules.'
  },
  {
    scope: 'tasks:write',
    label: 'Start conversations',
    detail: 'Start work, send messages and create schedules. This spends money on your provider.'
  },
  { scope: 'files:read', label: 'Read files', detail: 'Download anything in the agent’s files.' },
  {
    scope: 'files:write',
    label: 'Write files',
    detail: 'Upload, overwrite and delete the agent’s files.'
  },
  {
    scope: 'approvals:read',
    label: 'See what is waiting for approval',
    detail: 'The queue of actions the agent has stopped to ask about.'
  },
  {
    scope: 'approvals:write',
    label: 'Answer approvals',
    detail:
      'Approve or refuse on your behalf. A script holding this decides the things athanor stops to ask you about.'
  },
  {
    scope: 'models:read',
    label: 'List models',
    detail: 'Which models this box will route to, and which it will not.'
  },
  {
    scope: 'usage:read',
    label: 'Read spending',
    detail: 'What has been spent, and the caps it was spent under. Changing a cap stays with you.'
  },
  {
    scope: 'connectors:read',
    label: 'List connected accounts',
    detail: 'Which mailboxes and services are connected. Never their credentials.'
  }
];

/**
 * What a new token starts with: everything that only reads, plus the two writes a script normally
 * exists to do. Answering approvals and changing the machine are deliberate ticks, because each
 * of them acts in the world without the owner present.
 */
export const defaultApiTokenScopes: readonly ApiTokenScope[] = [
  'workspaces:read',
  'tasks:read',
  'tasks:write',
  'files:read',
  'files:write',
  'models:read'
];

export const MIN_TOKEN_DAYS = 1;
export const MAX_TOKEN_DAYS = 365;

export interface ApiTokenDraft {
  label: string;
  scopes: readonly ApiTokenScope[];
  /** Held as text because it is typed; the server takes an integer between 1 and 365. */
  expiresInDays: string;
}

export const emptyApiTokenDraft = (): ApiTokenDraft => ({
  label: '',
  scopes: [...defaultApiTokenScopes],
  expiresInDays: '90'
});

/** Ticking a scope on or off, kept in the declared order so the request reads like the form. */
export const toggleApiTokenScope = (
  scopes: readonly ApiTokenScope[],
  scope: ApiTokenScope
): ApiTokenScope[] => {
  const next = new Set(scopes);
  if (next.has(scope)) next.delete(scope);
  else next.add(scope);
  return apiTokenScopeCopy.map((item) => item.scope).filter((item) => next.has(item));
};

/**
 * The request, or the reason there is not one.
 *
 * Refused here rather than at the server, because the server's answer to an empty scope list is a
 * validation error naming a Zod path, and the owner asked a question in a form.
 */
export const apiTokenRequest = (
  draft: ApiTokenDraft
):
  | { ok: true; body: { label: string; scopes: ApiTokenScope[]; expiresInDays: number } }
  | { ok: false; message: string } => {
  const label = draft.label.trim();
  if (!label)
    return { ok: false, message: 'Give the token a label so you can tell it apart later.' };
  if (!draft.scopes.length)
    return { ok: false, message: 'Choose at least one thing this token may do.' };
  const days = Number(draft.expiresInDays);
  if (!Number.isInteger(days) || days < MIN_TOKEN_DAYS || days > MAX_TOKEN_DAYS)
    return {
      ok: false,
      message: `A token expires between ${MIN_TOKEN_DAYS} and ${MAX_TOKEN_DAYS} days from now.`
    };
  return { ok: true, body: { label, scopes: [...draft.scopes], expiresInDays: days } };
};

/** The line under an issued token's name: what it can reach, and when it stops working. */
export const apiTokenSummary = (token: {
  scopes: readonly ApiTokenScope[];
  expiresAt: string;
}): string => {
  const labels = apiTokenScopeCopy
    .filter((item) => token.scopes.includes(item.scope))
    .map((item) => item.label);
  const expires = new Date(token.expiresAt);
  const when = Number.isNaN(expires.getTime())
    ? 'no expiry recorded'
    : `expires ${expires.toLocaleDateString()}`;
  return `${labels.length ? labels.join(' · ') : 'nothing'} · ${when}`;
};
