/**
 * The sentences and the shapes behind the settings screen, apart from the screen itself.
 *
 * Everything here is a pure function over what a route answered. It lives beside
 * `SelfHostedSettings.tsx` rather than inside it because this package has no DOM in its tests: a
 * fact that can be asserted on its own is a fact that stays true, and three of the items this
 * module exists for were write-only controls nobody could have written a test against while they
 * were expressions inside a 2,600-line component.
 */

import type { ModelRelease } from '@athanor/contracts';
import type { ProviderSettings } from './api.js';
import type { WorkspaceMemory, WorkspaceSkill } from './types.js';

/**
 * What `GET /v1/providers` says about the model the owner configured by hand.
 *
 * Declared here rather than on `ProviderSettings` because a box older than these fields answers
 * without them, and the difference between "this server did not say" and "this model has no vision"
 * is the whole point of the item below.
 */
export interface ConfiguredModelFacts {
  contextTokens?: number;
  capabilities?: Array<'chat' | 'vision' | 'tools' | 'reasoning' | 'embedding'>;
  modalities?: Array<'text' | 'image' | 'audio' | 'video'>;
}

/** The context window a directly configured endpoint gets when nothing has said otherwise. */
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/**
 * The two fields the provider form used to forget, restored from what the server actually holds.
 *
 * These were write-only. `PUT /v1/providers` wrote `contextTokens` and `capabilities` into the
 * model catalogue, `GET /v1/providers` did not return them, and the form re-initialised to
 * `useState(128_000)` / `useState(false)` on every open — so the next save of anything, a key
 * rotation included, silently rewrote a 200k-context vision model back to 128k with no vision. No
 * error was raised; the first symptom was an image refused weeks later.
 *
 * A server that answers without the fields keeps the old defaults, because there is nothing else it
 * could honestly do — but it can no longer be told apart from a real 128k answer, which is why the
 * route was fixed rather than this being guessed from the model id.
 */
export const providerModelFields = (
  settings: ProviderSettings & ConfiguredModelFacts
): { contextTokens: number; vision: boolean } => ({
  contextTokens: settings.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
  // `capabilities` is what the save writes and what the router reads; `modalities` is the same
  // answer said the other way and is only consulted when a box sends one and not the other.
  vision:
    settings.capabilities?.includes('vision') ?? settings.modalities?.includes('image') ?? false
});

/**
 * A stored instant as the `datetime-local` control wants it, in the reader's own zone.
 *
 * The control has no time zone of its own: it shows and returns wall-clock text, so the conversion
 * has to happen on both edges or an expiry set at 6pm reads back as 5pm in London every winter.
 */
export const memoryExpiryField = (iso: string | null): string => {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

/** The same conversion back: wall-clock text in the reader's zone, as an instant. */
export const memoryExpiryIso = (field: string): string | undefined => {
  const trimmed = field.trim();
  if (!trimmed) return undefined;
  const at = new Date(trimmed);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
};

/**
 * What a memory edit sends, or why it will not be sent.
 *
 * `validUntil` is explicitly `null` when the field is empty rather than omitted, because the route
 * tells the two apart: omitting it keeps whatever expiry the row already had, and the owner looking
 * at an empty box has just said there should not be one.
 */
export const memoryPatch = (draft: {
  content: string;
  expiry: string;
}):
  | { ok: true; body: { content: string; validUntil: string | null } }
  | { ok: false; message: string } => {
  const content = draft.content.trim();
  if (!content) return { ok: false, message: 'A memory needs something in it.' };
  const trimmed = draft.expiry.trim();
  if (!trimmed) return { ok: true, body: { content, validUntil: null } };
  const validUntil = memoryExpiryIso(trimmed);
  if (!validUntil) return { ok: false, message: 'That expiry is not a date this box can read.' };
  if (Date.parse(validUntil) <= Date.now())
    return {
      ok: false,
      message: 'That expiry has already passed, so the fact would never be used.'
    };
  return { ok: true, body: { content, validUntil } };
};

/**
 * Who put this line in the box, which is not the same question as who it is about.
 *
 * The row has always printed the *scope* — "You" for a fact that follows the owner between
 * computers — in the position a reader takes for provenance, so a fact the agent decided about the
 * owner and a fact the owner typed read identically. `source` has been served, typed and drawn
 * nowhere since the list existed.
 */
export const memoryProvenance = (memory: Pick<WorkspaceMemory, 'source'>): string =>
  memory.source === 'agent' ? 'the agent decided this' : 'you wrote this';

/** Which computer or person the line applies to, said as a scope rather than as a person. */
export const memoryScope = (memory: Pick<WorkspaceMemory, 'target'>): string =>
  memory.target === 'user' ? 'About you, everywhere' : 'About this computer';

/**
 * The on/off control on a learned procedure: what it says, and what it sends.
 *
 * `enabled` is a real column with a real reader — `apps/worker/src/window.ts:191-194` drops a
 * disabled skill from the index the model is shown, before curation and before pinning are even
 * looked at — and it had no writer anywhere in the product. `PATCH /v1/workspaces/:id/skills/:id`
 * has taken it (`apps/api/src/routes/knowledge.ts:555-570`), the store has written it
 * (`packages/data/src/store/workspaces.ts:592`) and `api.setSkillState` has declared it, while the
 * only prop the row could send was `{ pinned?, status? }`. Meanwhile the approval card for a skill
 * upsert told the owner, in these words, "You had turned X off. Approving this switches it back
 * on." (`apps/worker/src/approval-cards.ts:192-193`) about a state nothing could put a skill into.
 *
 * A value rather than an expression inside the row, because this package has no DOM in its tests:
 * what the control sends is the whole of the hole, and this is the only shape it can be asserted in.
 */
export interface SkillSwitch {
  /** Says what pressing it does, because that is what a label on a toggle is for. */
  label: string;
  title: string;
  patch: { enabled: boolean };
}

export const skillSwitch = (skill: Pick<WorkspaceSkill, 'name' | 'enabled'>): SkillSwitch =>
  skill.enabled
    ? {
        label: `Turn the ${skill.name} skill off`,
        title: 'Keep the procedure, and stop the agent being shown it',
        patch: { enabled: false }
      }
    : {
        label: `Turn the ${skill.name} skill on`,
        title: 'Show the agent this procedure again',
        patch: { enabled: true }
      };

/**
 * What the screen says after a skill's state was changed, decided on the axis that was changed.
 *
 * Read off `saved` rather than off `patch`, because this is said after the route answered and the
 * route's answer is the state. Which sentence, though, is decided by the axis in `patch`: a skill
 * that was turned off while pinned is still pinned, and a notice reading "is pinned" would be true
 * and would answer a question nobody asked. The off sentence carries the upsert, because
 * `saveWorkspaceSkill` forces `enabled=TRUE` on conflict
 * (`packages/data/src/store/workspaces.ts:511`) — the Save button on this same screen included —
 * so "off" is a state the owner's next save silently ends.
 */
export const skillStateNotice = (
  name: string,
  patch: { enabled?: boolean; pinned?: boolean; status?: 'active' | 'stale' | 'archived' },
  saved: Pick<WorkspaceSkill, 'enabled' | 'pinned'>
): string => {
  if (patch.enabled !== undefined)
    return saved.enabled
      ? `“${name}” is on. The agent is shown it again from the next task that starts.`
      : `“${name}” is off. The agent is no longer shown it. The text is kept, and saving a skill of this name switches it back on.`;
  if (patch.status === 'active')
    return `“${name}” is active again. Pin it if you want it kept through the next curation.`;
  return saved.pinned
    ? `“${name}” is pinned. It is no longer retired for going unused.`
    : `“${name}” is unpinned. Thirty days unused makes it stale, ninety archives it.`;
};

/** How a systemd timer's own verdict reads on a screen. */
export type TimerState = 'on' | 'off' | 'unknown';

/**
 * Whether updates install themselves, said from the box rather than assumed.
 *
 * This row was static copy telling every owner to run `sudo athanor auto-update on` — including the
 * ones who already had, who were being told to enable something that was already enabled, and were
 * given no way to find out. The installer leaves this timer off, so the sentence also has to be
 * right for the ordinary case rather than describing an aspiration.
 */
export const updateTimerLine = (state: TimerState | undefined): string => {
  if (state === 'on')
    return 'Weekly automatic updates are on: this box backs itself up first and rolls back if the new release does not serve. To stop that, on the server: sudo athanor auto-update off.';
  if (state === 'off')
    return 'Nothing installs itself. Updates are yours to run: sudo athanor update. To have them install themselves weekly, backing up first and rolling back if the new release does not serve: sudo athanor auto-update on.';
  return 'This box could not say whether the weekly update timer is on — it answers that only on a Linux host running systemd. Updates are yours to run either way: sudo athanor update, or sudo athanor auto-update on for the weekly timer.';
};

/**
 * Whether a next backup is coming, which `backupEvidence` next door cannot answer.
 *
 * The evidence line reports the last copy that was actually taken. An owner who assumes backups are
 * automatic reads that as proof of a schedule, and a box whose timer was never enabled looks
 * identical to one whose timer ran yesterday.
 */
export const backupTimerLine = (state: TimerState | undefined): string => {
  if (state === 'on') return 'The daily backup timer is on, so another copy is due.';
  if (state === 'off')
    return 'No backup timer is running, so a copy happens only when you run sudo athanor backup.';
  return 'This box could not say whether the daily backup timer is on. On the server: sudo athanor backup auto status.';
};

/** Whether the two rows above have anything to report, or only their commands. */
export const timerStateKnown = (state: TimerState | undefined): boolean =>
  state === 'on' || state === 'off';

/**
 * A device link, as its own row: what it was called, what became of it, and when it stops working.
 *
 * Minting one and revoking one were both reachable and the list between them was not, so a link
 * photographed off a screen could not be counted, let alone killed, once the card had gone.
 */
export const enrollmentLine = (grant: {
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'used' | 'expired' | 'revoked';
}): string => {
  const made = new Date(grant.createdAt).toLocaleString();
  if (grant.status === 'pending')
    return `Still open · made ${made} · expires ${new Date(grant.expiresAt).toLocaleTimeString()}`;
  if (grant.status === 'used') return `Redeemed · made ${made}`;
  if (grant.status === 'revoked') return `Cancelled · made ${made}`;
  return `Expired unused · made ${made}`;
};

/** Only an open link can be taken back; the rest of the list is history. */
export const enrollmentRevocable = (grant: { status: string }): boolean =>
  grant.status === 'pending';

/** Money, to as many places as it has, for a rate rather than a bill. */
const rate = (value: number): string =>
  `$${value.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1')}`.replace(/\.00$/, '');

/**
 * One catalogue row as a sentence: what it costs, how much it holds, and what it may be used for.
 *
 * `GET /v1/models` has its own token scope, a complete record of twenty-one fields, and no caller
 * anywhere. The media picker two sections above prints a price beside every option; the chat
 * catalogue — on a product that is itself AGPL and grades its models on openness — printed none.
 */
export const modelDetailLine = (model: ModelRelease): string => {
  const parts: string[] = [];
  const input = model.inputUsdPerMillionTokens;
  const output = model.outputUsdPerMillionTokens;
  parts.push(
    input === null || input === undefined || output === null || output === undefined
      ? 'price not published'
      : `${rate(input)} in / ${rate(output)} out per million tokens`
  );
  parts.push(`${Math.round(model.contextTokens / 1000)}k context`);
  if (model.measuredQuality !== null)
    parts.push(`quality ${Math.round(model.measuredQuality * 100)}/100`);
  if (model.benchmarkRank) parts.push(`ranked #${model.benchmarkRank}`);
  parts.push(model.license);
  parts.push(model.commercialUse ? 'commercial use allowed' : 'no commercial use');
  return parts.join(' · ');
};

/**
 * The openness grade, said as what it means for the owner rather than as its enum.
 *
 * The four grades are the catalogue's own and they are graded deliberately, so they are reported
 * rather than collapsed into "open" and "closed": whether the weights can leave this provider is a
 * different question from whether anyone may study how they were made.
 */
export const modelOpennessLine = (model: Pick<ModelRelease, 'openness'>): string => {
  if (model.openness === 'osaid_open_source')
    return 'Open source — weights and the recipe behind them are public.';
  if (model.openness === 'permissive_open_weight')
    return 'Open weights — downloadable and runnable somewhere other than this provider.';
  if (model.openness === 'restricted_open_weight')
    return 'Open weights, restricted licence — downloadable, with conditions on what you may do with it.';
  return 'Proprietary — reachable only through a provider that hosts it.';
};

/**
 * Whether a typed name arms an irreversible control.
 *
 * The same rule the account deletion and the snapshot restore already use, named separately because
 * the thing being matched is a workspace name rather than a username and getting the two the wrong
 * way round would arm the wrong button.
 */
export const workspaceDeletionArmed = (typed: string, workspaceName: string): boolean =>
  typed.trim().length > 0 && typed.trim() === workspaceName;
