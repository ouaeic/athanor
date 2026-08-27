import { useEffect, useState } from 'react';
import { workspaceStatusLabel } from './workspace-status.js';
import {
  BellRing,
  BookOpenText,
  Check,
  CircleDollarSign,
  CloudCog,
  Code2,
  Copy,
  Download,
  KeyRound,
  LockKeyhole,
  Pin,
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  Save,
  Scale,
  ScrollText,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react';
import {
  disableNotifications,
  enableNotifications,
  notificationState,
  type NotificationState
} from './notifications.js';
import { Connectors } from './Connectors.js';
import { CopyButton } from './Markdown.js';
import { recoveryFile } from './account-recovery.js';
import { Dialog } from './Dialog.js';
import { useUndo } from './Undo.js';
import {
  accountDeletionArmed,
  passkeyLabel,
  passkeyRemovable,
  securityActionMessage,
  withStepUp,
  type PasskeySummary
} from './account-security.js';
import { api, type MemoryItem, type ProviderSettings } from './api.js';
import type {
  MediaModalityState,
  MediaModelChoice,
  MediaModelOption,
  MediaModelSelection,
  MediaSettings
} from '@athanor/contracts';
import { buildLabel, type BuildIdentity } from '@athanor/contracts';
import { webSearchSummary } from './web-search-route.js';
import {
  anyCapInForce,
  BASE_MONTHLY_CEILING_USD,
  spendLimitsDraft,
  spendLimitsPatch,
  suggestedMonthlyCeilingUsd,
  type SpendLimitsDraft
} from './usage-model.js';
import { securityModeCopy, securityModeNotice, securityModes } from './security-mode.js';
import { alwaysAsks, balancedVsAutonomous } from './asking-rules.js';
import {
  apiTokenRequest,
  apiTokenScopeCopy,
  apiTokenSummary,
  emptyApiTokenDraft,
  toggleApiTokenScope,
  MAX_TOKEN_DAYS,
  MIN_TOKEN_DAYS,
  type ApiTokenDraft
} from './api-token-scopes.js';
import {
  defaultNotificationSettings,
  notificationKindCopy,
  notificationSettingsDraft,
  notificationSettingsPatch,
  notificationSettingsSummary,
  type NotificationSettings,
  type NotificationSettingsDraft
} from './notification-settings.js';
import type {
  ApiToken,
  Bootstrap,
  SecurityMode,
  Task,
  TaskEvent,
  User,
  RelayReport,
  Workspace,
  WorkspaceMemory,
  WorkspaceSnapshot,
  WorkspaceSkill
} from './types.js';
import { formatBytes } from './timeline-state.js';
import { backupLine, type BackupStatus } from './backup-evidence.js';
import { UsagePane } from './UsagePane.js';
import { relayAddress, relayHostProblem, relayQuotaNote, relayStatusLine } from './relay-state.js';
import { ApiFailure } from './api-failure.js';
import {
  DOWNLOAD_UNAVAILABLE_FILE,
  DOWNLOAD_UNAVAILABLE_RECOVERY_CODE,
  nativeBridge
} from './native.js';
import {
  nativeNotificationsEnabled,
  setNativeNotificationsEnabled
} from './native-notifications.js';
import {
  backupTimerLine,
  enrollmentLine,
  enrollmentRevocable,
  memoryExpiryField,
  memoryPatch,
  memoryProvenance,
  memoryScope,
  modelDetailLine,
  modelOpennessLine,
  providerModelFields,
  timerStateKnown,
  updateTimerLine,
  workspaceDeletionArmed,
  type TimerState
} from './settings-facts.js';
import type { ModelRelease } from '@athanor/contracts';
/*
  Three whole surfaces, built as their own modules and mounted here.

  They are the queue of what the box has stopped being sure of, the cross-conversation record of
  what it was allowed to do, and — on a packaged client only — which server this app is talking to.
  All three cost the eager graph nothing, because this whole screen is already behind `lazy()` in
  `App.tsx` and they ride in its chunk.

  Imported statically rather than behind a second `lazy()`, deliberately and measured. Every one of
  this dialog's four pages is mounted the moment it opens — they are switched with `hidden`, not
  unmounted — so a second boundary would fetch all three anyway, one round trip later and three
  requests instead of one. Both shapes were built against the same tree: `lazy()` moved the eager
  graph by +19 bytes gzip and these imports by +44, all of it rolldown's own cross-chunk
  bookkeeping in the entry chunk rather than any code from here. Twenty-five bytes is not worth a
  waterfall.
*/
import { MemoryReview } from './MemoryReview.js';
import { DecisionsLog } from './DecisionsLog.js';
import { ConnectionRow } from './ConnectionRow.js';

/*
  Four pages, each named after something the owner already wants to do. The previous six spent a
  whole navigation slot on one token field, filed "tell me when this finishes" under Security, and
  put the only filesystem undo below the licence line.

  The ids are the stored names the rest of the app opens a page by; the words in `pages` below are
  what the owner reads, and they are not the same thing. "AI" and "Agent" named the technology
  rather than the errand, so the two most-visited destinations on this screen — the spending caps
  and the question of what the machine may do unattended — were both behind a label that did not
  mention them.
*/
export type SettingsPage = 'ai' | 'agent' | 'devices' | 'server';

const skillTemplate =
  '## When to use\n\nDescribe the trigger.\n\n## Procedure\n\n1. Describe the reliable steps.\n\n## Pitfalls\n\n- Describe common failures.\n\n## Verification\n\n- Describe how to prove the result.\n';

/**
 * The media catalogue, asked for only when this screen is open on the page that shows it.
 *
 * It is not on the bootstrap and not on the provider read, because building it costs the owner's
 * provider two requests and nothing outside this section has ever needed it. The server holds the
 * answer for five minutes, so opening Settings twice in a row is one round trip, not two.
 */
const mediaSettingsRequest = async (selection?: MediaModelSelection): Promise<MediaSettings> => {
  const response = await fetch('/v1/media/models', {
    credentials: 'include',
    signal: AbortSignal.timeout(45_000),
    ...(selection
      ? {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify(selection)
        }
      : {})
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `The media catalogue answered ${response.status}`);
  }
  return (await response.json()) as MediaSettings;
};

const loadMediaSettings = (): Promise<MediaSettings> => mediaSettingsRequest();

/**
 * The two routes this screen reaches that `api.ts` has no method for.
 *
 * Written the way `mediaSettingsRequest` above already is, and for the same reason: both are asked
 * for from this one screen and from nowhere else, so neither earns a place on the shared surface
 * every other module pays to import. The failure is raised as an `ApiFailure` rather than a bare
 * `Error` because `withStepUp` reads `code` off it — a route that asks for a passkey has to be able
 * to say so, and `DELETE /v1/workspaces/:id` is one.
 */
const settingsRequest = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'include',
    signal: AbortSignal.timeout(45_000),
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    throw new ApiFailure(
      body.error?.code ?? 'request_failed',
      body.error?.message ?? `Request failed (${response.status})`,
      response.status,
      body.error?.requestId
    );
  }
  return (await response.json()) as T;
};

/**
 * The whole catalogue record, asked for when the owner opens the disclosure and never before.
 *
 * It is not on the bootstrap on purpose — `types.ts` records that shipping it put 424 kB in front
 * of first paint — and this is the other door that comment implies and that nothing had built. It
 * costs one request on an explicit press, on a box the owner owns.
 */
const loadModelCatalogue = (): Promise<ModelRelease[]> =>
  settingsRequest<ModelRelease[]>('/v1/models');

/**
 * Remove this computer without removing the account it belongs to.
 *
 * The route has always been here, with its own step-up and its own typed-name confirmation, and
 * nothing called it: the only path that removed a workspace was deleting the entire account and
 * enrolling a passkey again from a pairing code.
 */
const deleteWorkspaceRequest = (workspaceId: string, confirmName: string): Promise<unknown> =>
  settingsRequest(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
    headers: { 'idempotency-key': crypto.randomUUID() }
  });

/**
 * Money, to as many places as it actually has and never fewer than two.
 *
 * Rounding to cents is wrong on this screen specifically: the reviewed image route is $0.014, and
 * an owner comparing it against a route ten times the price would read both of them as "$0.01" and
 * "$0.14" - a difference of one character, for a decision about their own bill.
 */
const usd = (value: number): string => `$${value.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')}`;

/**
 * What one media route costs, in the unit its provider bills it in.
 *
 * A price athanor could not read is said as that and never as zero. This is the sentence the owner
 * reads before they pick, and the same fact - `priceSource: 'unknown'` - is what makes the agent
 * raise an approval card on every single generation from that route, so the warning here and the
 * behaviour there are the same fact rather than two.
 */
const mediaPriceLabel = (option: MediaModelOption): string => {
  if (option.modality === 'audio')
    return option.usdPerMillionCharacters === null
      ? 'price not published'
      : `${usd(option.usdPerMillionCharacters)} per million characters`;
  if (option.modality === 'transcription')
    return option.usdPerMinute === null
      ? 'price not published'
      : `${usd(option.usdPerMinute)} a minute`;
  return option.usdPerImage === null
    ? 'price not published'
    : `${usd(option.usdPerImage)} an image`;
};

/**
 * The same three automatic modes, the same encoding and the same words as the composer's model
 * sheet, because an owner should not have to learn a second vocabulary for the same decision.
 */
const mediaSelectValue = (choice: MediaModelChoice): string =>
  choice.automatic ? `auto:${choice.preference}` : choice.modelId;

const mediaChoiceFromValue = (value: string): MediaModelChoice =>
  value.startsWith('auto:')
    ? {
        automatic: true,
        preference:
          (['fast', 'balanced', 'best'] as const).find(
            (candidate) => candidate === value.slice('auto:'.length)
          ) ?? 'balanced',
        modelId: ''
      }
    : { automatic: false, preference: 'balanced', modelId: value };

const mediaModalityLabel: Record<string, string> = {
  image: 'Images',
  audio: 'Speech',
  // The one that reads rather than makes: it is what turns a voice note into a message and a
  // meeting recording into something the computer can work on.
  transcription: 'Reading recordings',
  video: 'Video'
};

/**
 * One modality's control, or the sentence that says why there is not one.
 *
 * A modality with nothing behind it renders its reason where the select would be, rather than an
 * empty dropdown. Video is always that case and always will be until there is a request shape to
 * point it at; an image or speech list can also be empty, when the owner's provider offers no
 * generator with a verified private endpoint and they have asked for private routes only.
 */
function MediaModalityRow({
  entry,
  choice,
  onChoose
}: {
  entry: MediaModalityState;
  choice: MediaModelChoice;
  onChoose: (choice: MediaModelChoice) => void;
}) {
  if (!entry.available)
    return (
      <p className="web-search-route">
        <span>{mediaModalityLabel[entry.modality] ?? entry.modality}: not available</span>
        {entry.reason ? <small>{entry.reason}</small> : null}
      </p>
    );
  return (
    <label>
      {mediaModalityLabel[entry.modality] ?? entry.modality}
      <select
        value={mediaSelectValue(choice)}
        onChange={(event) => onChoose(mediaChoiceFromValue(event.target.value))}
      >
        <optgroup label="Automatic">
          <option value="auto:balanced">Recommended</option>
          <option value="auto:fast">Faster</option>
          <option value="auto:best">Higher quality</option>
        </optgroup>
        <optgroup label="Choose a specific model">
          {entry.options.map((option) => (
            // A model that cannot be chosen is still listed with the reason beside it, the way the
            // composer lists one held back for a licence review: dropping it silently is what makes
            // an owner think athanor has lost their model.
            <option key={option.id} value={option.id} disabled={Boolean(option.unavailableReason)}>
              {option.displayName} · {mediaPriceLabel(option)}
              {option.unavailableReason ? ` · ${option.unavailableReason}` : ''}
            </option>
          ))}
        </optgroup>
      </select>
      {entry.effective ? (
        <small>
          Uses {entry.effective.displayName}, {mediaPriceLabel(entry.effective)}
          {entry.effective.priceSource === 'measured'
            ? ' — a price athanor measured on this route.'
            : entry.effective.priceSource === 'unknown'
              ? ' — so every generation on it asks you first.'
              : '.'}
        </small>
      ) : null}
    </label>
  );
}

/**
 * What the connect form sends about money, from what is in the field.
 *
 * An empty field is not an absent answer: it is the owner declining a ceiling, which is theirs to
 * decline on their own computer, and it is sent as an explicit null so the server records that the
 * question was asked and never puts it in front of them again. Only a value that is not a number at
 * all is withheld, because a saved key is worth more than a refused form.
 */
export const spendCeilingRequest = (
  draft: string,
  timeZone: string
): { monthlyCapUsd: number | null; timeZone?: string } | undefined => {
  const trimmed = draft.trim();
  const zone = timeZone.trim() ? { timeZone: timeZone.trim() } : {};
  if (!trimmed) return { monthlyCapUsd: null, ...zone };
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { monthlyCapUsd: amount, ...zone };
};

/**
 * The one question about money worth asking while a key is being pasted.
 *
 * Every cap ships unset, and a cap that is unset refuses nothing - so on a box nobody has been
 * through the settings of, the whole spending guard is inert. This is the moment to fix that: it is
 * the first moment spending is possible at all, and the owner is already thinking about a bill.
 * It is one field in the form they are in, not a wizard and not a page they have to find.
 */
export function SpendCeilingField({
  value,
  onChange
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="form-grid">
      <label>
        Stop at, per month (USD)
        <small>
          A quarter of it is the most any one day may spend, which is what stops a run that goes
          wrong overnight. Leave it blank for no ceiling. Both are yours to change under Spending
          caps.
        </small>
        <input
          inputMode="decimal"
          placeholder="No ceiling"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

/**
 * How much the configured model holds, in one field both provider branches use.
 *
 * Its own component because what it shows is the thing the form used to lose. The value was
 * write-only for as long as this screen has existed — saved into the catalogue, never returned,
 * re-initialised to 128,000 on every open — so the next save of anything wrote that default back
 * over whatever the owner had typed. A field with a name can be rendered in a test with a number in
 * it, which is the only way that regression stays fixed.
 */
export function ContextWindowField({
  value,
  onChange,
  hint
}: {
  value: number;
  onChange: (next: number) => void;
  hint?: string;
}) {
  return (
    <label>
      Context window {hint ? <small>{hint}</small> : null}
      <input
        type="number"
        min={4096}
        max={10_000_000}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** How many of the agent's own memory rows are fetched at a time. */
const REMEMBERED_PAGE = 20;

/**
 * The most the route will put in one answer.
 *
 * It has no cursor, so a page is the whole list from the top and the ceiling is real: asking past
 * it is a rejected request, not a longer list. Offering "Show older" here anyway would be a control
 * that does nothing, which is worse than the ceiling itself.
 */
const REMEMBERED_MAX = 200;

/** The store's tiers are named for how a row was written; these are what the owner reads. */
const rememberedKindLabel: Record<MemoryItem['kind'], string> = {
  source: 'Your words',
  episode: 'Conversation',
  fact: 'Fact',
  procedure: 'Procedure'
};

/**
 * The durable facts: what put each one here, how long it lasts, and the way to change one word.
 *
 * This list was add-and-delete, and it printed the *scope* of a row where a reader looks for its
 * provenance — so a fact the agent decided about the owner and a fact the owner typed read
 * identically, and correcting either meant deleting it and retyping it, losing `createdAt` and any
 * expiry with it. Skills, the parallel construct one section below, got the open-into-the-editor
 * treatment long ago; this is the same move against the list that is read back into every task.
 */
export function MemoryList({
  items,
  editingId,
  onEdit,
  onForget,
  onOpenTask
}: {
  items: WorkspaceMemory[];
  /** Which row is in the editor above, so the list says where the form's contents came from. */
  editingId?: string | undefined;
  onEdit: (item: WorkspaceMemory) => void;
  onForget: (item: WorkspaceMemory) => void;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  return (
    <div className="settings-list">
      {items.map((item) => (
        <div key={item.id}>
          <button
            className="settings-list-open"
            title="Open this memory to change it"
            onClick={() => onEdit(item)}
          >
            <strong>
              {memoryScope(item)}
              {item.status === 'expired' ? ' · expired' : ''}
              {item.id === editingId ? ' · being edited above' : ''}
            </strong>
            <small>{item.content}</small>
            <small>
              {memoryProvenance(item)}
              {item.validUntil
                ? ` · ${item.status === 'expired' ? 'stopped being used' : 'used until'} ${new Date(
                    item.validUntil
                  ).toLocaleString()}`
                : ' · no expiry'}
            </small>
          </button>
          <span className="settings-row-actions">
            {/* The conversation that decided this, when there was one. Judging a fact the owner
                disagrees with used to mean deleting it blind: the id has been served and typed
                since the list existed and was read by nothing. */}
            {item.sourceTaskId && onOpenTask ? (
              <button
                className="icon-btn"
                aria-label="Open the conversation that wrote this"
                title="Open the conversation that wrote this"
                onClick={() => onOpenTask(item.sourceTaskId as string)}
              >
                <ScrollText />
              </button>
            ) : null}
            <button className="icon-btn" aria-label="Delete memory" onClick={() => onForget(item)}>
              <Trash2 />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The learned procedures, with the two things that decide whether one survives.
 *
 * Skills are demoted on a timer — stale at thirty days unused, archived at ninety — and every task
 * start runs the curation that does it, dropping anything not active and not pinned from the index
 * the model sees. The row printed the resulting status word and offered nothing, so the only way to
 * keep a procedure used every six weeks was to re-open it in the editor and press Save, which
 * resets the status through the upsert: an accident, not a control, and nothing said it worked.
 */
export function SkillList({
  items,
  busy,
  onOpen,
  onSetState,
  onDelete
}: {
  items: WorkspaceSkill[];
  busy: boolean;
  onOpen: (item: WorkspaceSkill) => void;
  onSetState: (
    item: WorkspaceSkill,
    patch: { pinned?: boolean; status?: 'active' | 'stale' | 'archived' }
  ) => void;
  onDelete: (item: WorkspaceSkill) => void;
}) {
  return (
    <div className="settings-list">
      {items.map((item) => (
        <div key={item.id}>
          {/* Saving by name is an upsert, so opening a skill into the editor above is the whole
              edit path. The list was previously delete-only: the agent could write a procedure
              the owner could read no part of and fix no part of. */}
          <button
            className="settings-list-open"
            title={`Open the ${item.name} skill`}
            onClick={() => onOpen(item)}
          >
            <strong>
              {item.name}
              {item.pinned ? ' · pinned' : ''}
            </strong>
            <small>
              {item.description}
              {item.status === 'active' ? '' : ` · ${item.status}`}
              {item.useCount > 0
                ? ` · used ${item.useCount} ${item.useCount === 1 ? 'time' : 'times'}`
                : ' · never used yet'}
            </small>
            {item.status === 'active' ? null : (
              <small>
                Retired for not being used, so the agent no longer sees it. Making it active puts it
                back; pinning it keeps it there.
              </small>
            )}
          </button>
          <span className="settings-row-actions">
            {item.status === 'active' ? null : (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => onSetState(item, { status: 'active' })}
              >
                Make active
              </button>
            )}
            <button
              className="icon-btn"
              aria-label={
                item.pinned ? `Unpin the ${item.name} skill` : `Pin the ${item.name} skill`
              }
              title={
                item.pinned
                  ? 'Pinned: never retired for going unused'
                  : 'Pin it so it is never retired for going unused'
              }
              aria-pressed={item.pinned}
              disabled={busy}
              onClick={() => onSetState(item, { pinned: !item.pinned })}
            >
              <Pin />
            </button>
            <button
              className="icon-btn"
              aria-label={`Delete the ${item.name} skill`}
              onClick={() => onDelete(item)}
            >
              <Trash2 />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What the computer wrote down for itself as work finished, and the way to take any of it back.
 *
 * The second press lives in the row. Deleting this is the owner acting on their own record on their
 * own machine - it is not the approval floor and must not wear its clothes, so there is no dialog
 * and nothing to read twice; the first press only arms the second so a stray tap costs nothing.
 */
export function RememberedList({
  items,
  more,
  onShowOlder,
  onForget
}: {
  items: MemoryItem[];
  /** True while the server may still be holding older rows than the ones asked for. */
  more: boolean;
  onShowOlder: () => void;
  onForget: (item: MemoryItem) => void;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <p className="memory-observed-note">
        Written down on its own as work finished, newest first.{' '}
        {more ? (
          <button type="button" className="memory-observed-more" onClick={onShowOlder}>
            Show older
          </button>
        ) : null}
      </p>
      <div className="settings-list">
        {items.map((item) => (
          <div key={item.id}>
            <span>
              <strong>
                {rememberedKindLabel[item.kind]}
                {item.status === 'active' ? '' : ` · ${item.status}`}
              </strong>
              <small>{item.excerpt}</small>
              <small>{new Date(item.observedAt).toLocaleString()}</small>
            </span>
            {armed === item.id ? (
              <div className="settings-row-actions">
                <button
                  className="danger"
                  onClick={() => {
                    setArmed(null);
                    onForget(item);
                  }}
                >
                  Delete for good
                </button>
                <button className="icon-btn" aria-label="Keep it" onClick={() => setArmed(null)}>
                  <X />
                </button>
              </div>
            ) : (
              <button
                className="icon-btn"
                aria-label="Delete what was remembered"
                onClick={() => setArmed(item.id)}
              >
                <Trash2 />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function SelfHostedSettings({
  user,
  workspace,
  tasks,
  conversationEvents,
  legal,
  initialPage = 'ai',
  onOpenTerminal,
  onOpenTask,
  onClose,
  onLogout
}: {
  user: User;
  workspace: Workspace | undefined;
  /** Only the spend report needs these, to name and open the conversations that cost the most. */
  tasks: Task[];
  /** Also only the spend report: the token figures live in the open conversation's own events. */
  conversationEvents?: TaskEvent[];
  legal: Bootstrap['legal'];
  initialPage?: SettingsPage;
  onOpenTerminal: () => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  /*
   * The mode new conversations start in, held here so the radio group reflects the server's answer
   * rather than the press. The prop is a bootstrap snapshot the parent only re-reads when this
   * dialog closes, so a value written back optimistically would survive a refusal and read as
   * saved.
   */
  const [defaultMode, setDefaultMode] = useState<SecurityMode>(
    workspace?.securityMode ?? 'balanced'
  );
  const undo = useUndo();
  const [provider, setProvider] = useState<ProviderSettings>();
  const [providerKind, setProviderKind] = useState<
    'openrouter' | 'ollama-cloud' | 'openai-compatible'
  >('openrouter');
  const [providerUrl, setProviderUrl] = useState('https://openrouter.ai/api/v1');
  const [providerKey, setProviderKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [contextTokens, setContextTokens] = useState(128_000);
  const [vision, setVision] = useState(false);
  const [zdr, setZdr] = useState(true);
  const [memories, setMemories] = useState<WorkspaceMemory[]>([]);
  const [memory, setMemory] = useState('');
  const [memoryTarget, setMemoryTarget] = useState<'workspace' | 'user'>('workspace');
  /*
   * The expiry the add form never offered.
   *
   * `POST …/memories` has accepted `validUntil` all along and the client method already declared
   * it; the one call site omitted it, so every memory an owner wrote was permanent by construction
   * while the agent's own tool could write an expiring one — and the runtime prompt tells the model
   * an expiring fact saves without an approval, which makes it the cheap path the agent is pushed
   * toward and the owner could not take.
   */
  const [memoryExpiry, setMemoryExpiry] = useState('');
  /** Which stored fact the form above is editing, or nothing, in which case Save adds a new one. */
  const [editingMemoryId, setEditingMemoryId] = useState('');
  const [remembered, setRemembered] = useState<MemoryItem[]>([]);
  /* This list has no end - a row lands every time a turn finishes - so it is asked for a page at a
     time and grows only when the owner asks it to. */
  const [rememberedLimit, setRememberedLimit] = useState(REMEMBERED_PAGE);
  /* Whether the last answer filled the page it asked for, which is the only sign this server has
     more. Deriving it from the length on screen instead made deleting one row - which is what this
     list is for - look like reaching the end of the list. */
  const [rememberedMore, setRememberedMore] = useState(false);
  const [spendLimitsForm, setSpendLimitsForm] = useState<SpendLimitsDraft>({
    dailyCapUsd: '',
    monthlyCapUsd: '',
    defaultTaskCapUsd: '',
    warnAtPercent: '80',
    // The owner's own zone is the only sensible default for "today"; the server accepts any IANA id.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  });
  /* Replaced below by a figure sized from what this box has actually spent, once that is known. A
     prefilled number is the difference between a question and a chore, so there is one from the
     first paint rather than an empty field while a request is in flight. */
  const [ceilingDraft, setCeilingDraft] = useState(String(BASE_MONTHLY_CEILING_USD));
  /*
   * Whether this box has ever had an answer about money, which is what decides whether the question
   * is asked at all. It starts as answered so the field cannot flash up on a box that settled this
   * years ago, and the server's own timestamp is what settles it: limits nobody has saved come back
   * stamped at the epoch, which is how a default is told from a choice that happens to match one.
   */
  const [capsAnswered, setCapsAnswered] = useState(true);
  /**
   * Whether any ceiling is actually in force, which is not what the fields say.
   *
   * Read from what the server last confirmed rather than from the form, because a half-edited field
   * is not a change to the machine: clearing the daily box must not make this page announce that
   * nothing stops a run while the old cap is still stopping one.
   */
  const [capsInForce, setCapsInForce] = useState(true);
  const [relay, setRelay] = useState<RelayReport | null>();
  const [diagnostics, setDiagnostics] = useState<{
    certificate: { failedAt: string; reason: string } | null;
    dynamicDns: { failedAt: string; reason: string } | null;
    backup?: BackupStatus | null;
    build?: BuildIdentity;
    /*
     * Whether the two timers the box runs on its own are enabled, which is the question the
     * Updates and Backups rows below claimed to answer and could not: they were static copy. Both
     * are declared here rather than on `api.instanceDiagnostics`'s return type because they are
     * read by this screen alone, and both are optional because a box older than the field — or a
     * host that is not Linux, where `systemctl is-enabled` has no answer — sends `'unknown'` or
     * nothing at all, and "we could not tell" is a third state the rows have to say out loud.
     */
    autoUpdate?: TimerState;
    backupTimer?: TimerState;
  }>();
  const [relayHost, setRelayHost] = useState('');
  const [relayToken, setRelayToken] = useState('');
  const [brief, setBrief] = useState('');
  /** The last value the server confirmed, so Save is inert until something actually changed. */
  const [savedBrief, setSavedBrief] = useState('');
  const [briefPath, setBriefPath] = useState('workspace/ATHANOR.md');
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [skillName, setSkillName] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillContent, setSkillContent] = useState(skillTemplate);
  /** Whether the security lists could not be read, as opposed to being genuinely empty. */
  const [securityUnavailable, setSecurityUnavailable] = useState(false);
  /** Whether the recovery points could not be read, as opposed to there being none. */
  const [snapshotsUnavailable, setSnapshotsUnavailable] = useState(false);
  const [sessions, setSessions] = useState<
    Array<{ id: string; deviceLabel: string; lastSeenAt: string; current: boolean }>
  >([]);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokenDraft, setTokenDraft] = useState<ApiTokenDraft>(emptyApiTokenDraft);
  const [issuedToken, setIssuedToken] = useState('');
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [snapshotName, setSnapshotName] = useState('');
  const [restoreSnapshotId, setRestoreSnapshotId] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [pushState, setPushState] = useState<NotificationState>('checking');
  /** Undefined until asked, null on a server that cannot store them, so the block stays hidden. */
  const [pushSettings, setPushSettings] = useState<NotificationSettings | null>();
  const [pushDraft, setPushDraft] = useState<NotificationSettingsDraft>(
    notificationSettingsDraft(defaultNotificationSettings())
  );
  const [reissuedRecoveryCode, setReissuedRecoveryCode] = useState('');
  /**
   * Said inside the recovery card rather than in the page banner far above it.
   *
   * The banner is under the nav at the top of a settings page that scrolls; the code is halfway
   * down it. A message about a string that is displayed once, and that the owner is about to
   * dismiss with "I have saved it", has to be beside the button that failed.
   */
  const [recoveryCodeSaveError, setRecoveryCodeSaveError] = useState('');
  const [enrollment, setEnrollment] = useState<{
    id: string;
    expiresAt: string;
    uri: string;
    webUri: string;
  }>();
  const [enrollmentQr, setEnrollmentQr] = useState('');
  /** What the new device will be called in the sessions list, rather than the hardcoded literal. */
  const [enrollmentLabelDraft, setEnrollmentLabelDraft] = useState('');
  /** Every link minted in the last week and what became of it; undefined until the route answers. */
  const [enrollments, setEnrollments] = useState<
    Array<{
      id: string;
      label: string;
      createdAt: string;
      expiresAt: string;
      status: 'pending' | 'used' | 'expired' | 'revoked';
    }>
  >();
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountConfirmation, setDeleteAccountConfirmation] = useState('');
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [deleteWorkspaceConfirmation, setDeleteWorkspaceConfirmation] = useState('');
  /** Undefined until the disclosure is opened, null when the catalogue could not be read. */
  const [catalogue, setCatalogue] = useState<ModelRelease[] | null>();
  /*
   * Whether this installation may raise an OS notification, which is a local answer to a local
   * question: a packaged shell has no push subscription for the server to consult.
   */
  const [nativeNotifications, setNativeNotifications] = useState(nativeNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [media, setMedia] = useState<MediaSettings | null>();
  const [mediaSelection, setMediaSelection] = useState<MediaModelSelection>({});

  /**
   * The saved credential, and the two fields the form used to forget it had.
   *
   * `contextTokens` and the vision capability were written by the save and restored by nothing, so
   * the form re-initialised to 128k and no vision on every open. The next save of anything — a key
   * rotation, a change of privacy route, a media model — wrote those defaults straight back over a
   * 200k vision model, with no error and no sign until an image was refused weeks later. The route
   * returns all three now, and `providerModelFields` is what puts them back.
   */
  const loadProvider = () =>
    void api
      .provider()
      .then((value) => {
        setProvider(value);
        setProviderKind(value.provider);
        setProviderUrl(value.baseUrl);
        setModelId(value.modelId ?? '');
        setZdr(value.enforceZeroDataRetention);
        const fields = providerModelFields(value);
        setContextTokens(fields.contextTokens);
        setVision(fields.vision);
      })
      .catch(() => setProvider(undefined));
  /**
   * Undefined until asked, null when the catalogue could not be read - which is a different thing
   * from a provider that offers nothing, and is said differently.
   */
  const loadMedia = () =>
    void loadMediaSettings()
      .then((value) => {
        setMedia(value);
        setMediaSelection(
          Object.fromEntries(
            value.modalities
              .filter((entry) => entry.modality !== 'video')
              .map((entry) => [entry.modality, entry.choice])
          ) as MediaModelSelection
        );
      })
      .catch(() => setMedia(null));
  const loadRemembered = (limit: number) => {
    if (!workspace) return;
    const asked = Math.min(limit, REMEMBERED_MAX);
    setRememberedLimit(asked);
    void api
      .memoryItems(workspace.id, asked)
      // A server from before this route existed answers 404, and the list is simply absent.
      .then((items) => {
        setRemembered(items);
        setRememberedMore(items.length >= asked && asked < REMEMBERED_MAX);
      })
      .catch(() => undefined);
  };
  const loadKnowledge = () => {
    if (!workspace) return;
    void Promise.all([api.memories(workspace.id), api.skills(workspace.id)])
      .then(([nextMemories, nextSkills]) => {
        setMemories(nextMemories);
        setSkills(nextSkills);
      })
      .catch(() => undefined);
    loadRemembered(rememberedLimit);
  };
  const loadSpendLimits = () =>
    /* The summary is best-effort beside the caps themselves: losing it costs a better-sized
       suggestion, and refusing to load the caps over that would cost the whole section. */
    void Promise.all([api.spendLimits(), api.spend().catch(() => null)])
      .then(([limits, summary]) => {
        setSpendLimitsForm(spendLimitsDraft(limits));
        setCapsAnswered(Date.parse(limits.updatedAt) > 0);
        setCapsInForce(anyCapInForce(limits));
        /*
         * The figure offered is sized from this box rather than fixed.
         *
         * A flat fifty in front of an owner whose box has already spent four hundred this month is
         * a ceiling the month has crossed: accept it and the next turn is refused for money that
         * went before the question was asked, which reads as the product breaking. The rule lives
         * in `suggestedMonthlyCeilingUsd`, next to the day-cap share it has to leave room for.
         */
        if (!summary) return;
        const spent = (name: 'daily' | 'monthly'): number =>
          summary.windows.find((window) => window.name === name)?.spentUsd ?? 0;
        setCeilingDraft(
          String(
            suggestedMonthlyCeilingUsd({ monthlyUsd: spent('monthly'), dailyUsd: spent('daily') })
          )
        );
      })
      // A server without the caps route keeps the local defaults, which are what it enforces.
      .catch(() => undefined);
  const loadBrief = () => {
    if (!workspace) return;
    void api
      .workspaceBrief(workspace.id)
      .then((value) => {
        setBrief(value.markdown);
        setSavedBrief(value.markdown);
        setBriefPath(value.path);
      })
      // A computer that is still starting has no filesystem to read yet; the placeholder stands.
      .catch(() => undefined);
  };
  const loadSecurity = () => {
    void Promise.all([api.sessions(), api.passkeys(), api.apiTokens()])
      .then(([nextSessions, nextPasskeys, nextTokens]) => {
        setSessions(nextSessions);
        setPasskeys(nextPasskeys);
        setTokens(nextTokens);
        setSecurityUnavailable(false);
      })
      /*
       * Said out loud, because silence here is a lie with consequences.
       *
       * The three lists keep their initial empty value when this fails, and the screen then reads
       * "no signed-in devices, no passkeys, no API tokens" - which on a security page is not a
       * blank state, it is an all-clear the owner did not earn. Nothing was revoked; this device
       * could not ask.
       */
      .catch(() => setSecurityUnavailable(true));
  };
  /**
   * The pairing links that are still out there.
   *
   * The route lists only the last seven days, so an empty list is "none this week" and not "you
   * have never made one" — which is why the block below says that rather than "no device links".
   */
  const loadEnrollments = () =>
    void api
      .enrollments()
      .then(setEnrollments)
      // A server without the list route keeps the create button and the card, which is what it had.
      .catch(() => setEnrollments(undefined));
  const loadSnapshots = () => {
    if (!workspace) return;
    void api
      .workspaceSnapshots(workspace.id)
      .then((next) => {
        setSnapshots(next);
        setSnapshotsUnavailable(false);
      })
      // "No recovery points" is a claim about the machine; an unread list is a claim about this
      // device. Told apart, because the first one would send somebody looking for a backup they
      // actually have.
      .catch(() => setSnapshotsUnavailable(true));
  };

  useEffect(() => {
    loadProvider();
    loadMedia();
    loadSpendLimits();
    loadKnowledge();
    loadBrief();
    loadSecurity();
    loadEnrollments();
    loadSnapshots();
  }, [workspace?.id]);
  useEffect(() => {
    if (workspace) setDefaultMode(workspace.securityMode);
  }, [workspace?.securityMode]);
  useEffect(() => {
    // Null means this server has no relay route at all, which is a different thing from "off" and
    // is why the whole block is absent rather than showing controls that could not work.
    void api
      .relay()
      .then(setRelay)
      .catch(() => setRelay(null));
  }, []);
  useEffect(() => {
    void api
      .instanceDiagnostics()
      .then(setDiagnostics)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void notificationState()
      .then(setPushState)
      .catch(() => setPushState('unavailable'));
    void api
      .notificationSettings()
      .then((settings) => {
        setPushSettings(settings);
        if (settings) setPushDraft(notificationSettingsDraft(settings));
      })
      .catch(() => setPushSettings(null));
  }, []);

  /*
   * Every write on this screen goes through here, which is why the step-up confirmation lives here
   * too rather than being remembered at each control - it was missed at two of them, and the two
   * that were missed both passed their tests because dev sign-in stamps `step_up_at` at session
   * creation, the one condition that never holds while the screen is in use.
   *
   * Bodies are re-run whole on the retry, so each one is a single request plus the local state that
   * follows it.
   */
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await withStepUp(operation, api.stepUp);
    } catch (cause) {
      setError(securityActionMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /**
   * No passkey on this one, matching the route.
   *
   * Choosing which model draws a picture moves no credential and authorises no spend: every
   * generation still meets the cumulative media approval, and a route whose price the provider does
   * not publish raises that card every single time rather than once in a while. A fingerprint in
   * front of a dropdown would cost the owner something and buy them nothing.
   */
  const saveMedia = () =>
    act(async () => {
      const saved = await mediaSettingsRequest(mediaSelection);
      setMedia(saved);
      setNotice('Saved. New generations use these models.');
    });

  const saveProvider = () =>
    act(async () => {
      await api.stepUp();
      // The ceiling rides with the key rather than following it: one request, so a box can never
      // end up holding a working credential and no answer about what it may spend.
      const ceiling = capsAnswered
        ? undefined
        : spendCeilingRequest(ceilingDraft, spendLimitsForm.timeZone);
      const capabilities: Array<'chat' | 'vision' | 'tools' | 'reasoning' | 'embedding'> = [
        'chat',
        'tools',
        'reasoning',
        ...(vision ? (['vision'] as const) : [])
      ];
      const modalities: Array<'text' | 'image' | 'audio' | 'video'> = [
        'text',
        ...(vision ? (['image'] as const) : [])
      ];
      const body = {
        provider: providerKind,
        // Sent only when there is one to send. A blank model id used to be impossible - the field
        // was required for every provider but OpenRouter - and Ollama Cloud no longer requires it,
        // so an empty string would now reach a route that rejects empty strings.
        ...(providerKind !== 'openrouter' && modelId.trim() ? { modelId: modelId.trim() } : {}),
        ...(providerKind === 'openai-compatible' ? { baseUrl: providerUrl } : {}),
        ...(providerKey ? { apiKey: providerKey } : {}),
        enforceZeroDataRetention: zdr,
        contextTokens,
        capabilities,
        modalities,
        ...(ceiling ? { spendCeiling: ceiling } : {})
      };
      const saved = await api.saveProvider(body);
      setProvider(saved);
      setProviderKey('');
      // Whatever was just seeded is what the caps below have to show, and the question is answered
      // from here on.
      if (ceiling) loadSpendLimits();
      /*
       * Two sentences because two different things were checked.
       *
       * "Provider verified and saved" was said either way, and for a directly configured endpoint
       * it was a claim nobody made: the server asks that endpoint for its model list with the key
       * and requires the chosen model to be in it, which a public catalogue route will answer for
       * an unusable key. The OpenRouter path now calls a route the provider gates, so there the
       * word verified is earned; here it is replaced by what actually happened.
       */
      const stored =
        providerKind === 'openrouter'
          ? 'Key checked with the provider and saved. It is encrypted and will not be shown again.'
          : providerKind === 'ollama-cloud'
            ? // The endpoint answered the models route with this key attached, and a rejected key
              // is refused there before anything is written, so "accepted" is what happened. What
              // did not happen is a completion, which is the only thing that proves quota.
              'Saved and encrypted. Every model this subscription lists is now in the model picker. Nothing was run against it, so cost and quota are unchecked.'
            : `Saved and encrypted. The endpoint listed ${modelId} for this key. Nothing was run against it, so cost and quota are unchecked.`;
      setNotice(
        ceiling?.monthlyCapUsd
          ? `${stored} Spending stops at $${ceiling.monthlyCapUsd} a month.`
          : stored
      );
      // The catalogue this screen offers below belongs to the credential that just changed.
      loadMedia();
    });

  /*
   * No passkey on this one, matching the route: the server dropped step-up from
   * `PATCH /v1/workspaces/:id/security-mode` because a fingerprint on the setting whose entire
   * purpose is to be interrupted less made Autonomous unreachable in practice. Step-up still guards
   * what changing a setting back cannot undo — the provider credential above, and raising a
   * spending ceiling.
   */
  const chooseDefaultMode = (mode: SecurityMode) =>
    act(async () => {
      if (!workspace || mode === defaultMode) return;
      const saved = await api.updateWorkspaceSecurityMode(workspace.id, mode);
      setDefaultMode(saved.securityMode);
      setNotice(securityModeNotice(saved.securityMode, 'workspace'));
    });

  /*
   * The whole of what the box holds about its owner, and it went nowhere on a packaged client.
   *
   * A step-up passkey ceremony, a round trip that assembles every row, and then an anchor click
   * WKWebView and WebKitGTK discard without a word — so the owner authenticated, waited, and was
   * shown nothing at all. `act` clears the error before running this, so setting one here survives:
   * a failure that only this operation can name is worth more than the generic sentence a throw
   * would land in.
   */
  const exportData = () =>
    act(async () => {
      await api.stepUp();
      const data = await api.privacyExport();
      const written = await nativeBridge.saveFile(
        `athanor-export-${new Date().toISOString().slice(0, 10)}.json`,
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      if (!written) setError(DOWNLOAD_UNAVAILABLE_FILE);
    });

  const webSearch = webSearchSummary(provider?.webSearch);
  // Read at render rather than ticked: the panel is opened, read and closed, and a backup taken
  // yesterday is still yesterday's a minute later.
  //
  // Nothing at all until the box has answered, which is a different fact from the box answering
  // that it has nothing. The row says "no backup yet" on the second, and a request still in flight
  // - or one that failed, which leaves this undefined for as long as the panel is open - would
  // otherwise tell a server with a year of good copies that it has never taken one.
  const backupEvidence = diagnostics ? backupLine(diagnostics.backup ?? null, Date.now()) : null;

  const pages: Array<{ id: SettingsPage; label: string }> = [
    { id: 'ai', label: 'Model & spending' },
    { id: 'agent', label: 'What it may do' },
    // "Alerts" rather than "sign-in" alone: the passkey rows plainly are sign-in, and the one
    // errand an owner of an unattended computer is most likely to come looking for on this page is
    // "tell me when this finishes", which no nav label contained.
    { id: 'devices', label: 'Devices & alerts' },
    { id: 'server', label: 'This server' }
  ];

  return (
    <Dialog
      className="modal settings-modal self-hosted-settings"
      labelledBy="settings-title"
      onClose={onClose}
    >
      <button className="modal-close" aria-label="Close settings" onClick={onClose}>
        <X />
      </button>
      <h2 id="settings-title">Settings</h2>
      <nav className="settings-nav" aria-label="Settings sections">
        {pages.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? 'active' : ''}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => setPage(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="inline-notice" role="status">
          {notice}
        </div>
      )}

      <div className="settings-section" hidden={page !== 'ai'}>
        <div className="section-heading">
          <CloudCog />
          <div>
            <strong>{provider?.configured ? 'AI is ready' : 'Connect a model provider'}</strong>
            <span>
              Your key goes from this server straight to the provider. Nothing in between.
            </span>
          </div>
        </div>
        {provider?.configured && (
          <div className="privacy-boundary">
            <Check />
            <span>
              <strong>
                {provider.provider === 'openrouter'
                  ? 'OpenRouter'
                  : provider.provider === 'ollama-cloud'
                    ? 'Ollama Cloud'
                    : 'Compatible endpoint'}
              </strong>
              {' · '}
              {provider.source === 'encrypted_database'
                ? 'encrypted in athanor'
                : 'configured by the server operator'}
              {provider.modelId ? ` · ${provider.modelId}` : ''}
            </span>
          </div>
        )}
        <div className="form-grid two">
          <label>
            Provider
            <select
              value={providerKind}
              onChange={(event) => {
                const next = event.target.value as typeof providerKind;
                setProviderKind(next);
                setProviderUrl(
                  next === 'openrouter'
                    ? 'https://openrouter.ai/api/v1'
                    : next === 'ollama-cloud'
                      ? 'https://ollama.com/v1'
                      : 'https://your-provider.example/v1'
                );
              }}
            >
              <option value="openrouter">OpenRouter</option>
              <option value="ollama-cloud">Ollama Cloud</option>
              <option value="openai-compatible">OpenAI-compatible endpoint</option>
            </select>
          </label>
          {providerKind === 'openai-compatible' && (
            <label>
              API base URL
              <input value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} />
            </label>
          )}
          <label>
            API key{' '}
            {provider?.hasApiKey && provider.provider === providerKind
              ? '(leave blank to keep the saved key)'
              : ''}
            <input
              type="password"
              autoComplete="off"
              value={providerKey}
              onChange={(event) => setProviderKey(event.target.value)}
              placeholder={
                provider?.hasApiKey && provider.provider === providerKind
                  ? 'Key already stored'
                  : 'Paste key'
              }
            />
          </label>
          {providerKind === 'openai-compatible' && (
            <>
              <label>
                Model ID
                <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
              </label>
              <ContextWindowField value={contextTokens} onChange={setContextTokens} />
            </>
          )}
          {/*
            Ollama Cloud asks for nothing but the key now.

            It used to require a model ID and a context window typed by hand, which made a
            subscription that reaches a whole catalogue behave like a single endpoint serving one
            model: reaching a second one meant coming back here and retyping. The save route reads
            the account's own model list and writes all of them, taking each context window from
            what the endpoint published, so both fields were asking the owner for something the
            provider already knew.
          */}
          {providerKind === 'ollama-cloud' && (
            <ContextWindowField
              value={contextTokens}
              onChange={setContextTokens}
              hint="only for models that do not publish one"
            />
          )}
        </div>
        {capsAnswered ? null : (
          <SpendCeilingField value={ceilingDraft} onChange={setCeilingDraft} />
        )}
        <label className="toggle-line">
          <input
            aria-label="Block providers that may retain or train on my data"
            type="checkbox"
            checked={zdr}
            onChange={(event) => setZdr(event.target.checked)}
          />
          <span>
            <strong>Block providers that may retain or train on my data</strong>
            <small>
              {providerKind === 'openrouter'
                ? zdr
                  ? 'Every request goes to an endpoint that keeps nothing. Models that cannot promise that stay in the list but cannot be chosen.'
                  : 'Any endpoint may be used, and whatever that provider does with your prompts, files and generated media is what happens to them. athanor itself still keeps no copy.'
                : providerKind === 'ollama-cloud'
                  ? 'Ollama says Cloud prompts and answers are handled in passing, never logged and never trained on. Their own service records still exist.'
                  : 'A compatible endpoint has no standard way to promise this, so what applies is whatever its operator says applies.'}
            </small>
          </span>
        </label>
        {/*
          The toggle above is about what a provider keeps of an inference request. This is the other
          half of the same question and the one the box decides on its own: a search query is often
          the most revealing sentence in a conversation, and the provider's zero-retention promise
          explicitly does not cover the tools it runs. The verdict is not computed here - it is the
          server's answer, from the one resolver that also decides what goes on the wire - so this
          page and the agent can never hold two opinions about where a query went.
        */}
        {webSearch ? (
          <p className="web-search-route">
            <span>{webSearch.disclosure}</span>
            {webSearch.reason ? <small>{webSearch.reason}</small> : null}
          </p>
        ) : null}
        {providerKind === 'openai-compatible' && (
          <label className="toggle-line">
            <input
              aria-label="This model supports images"
              type="checkbox"
              checked={vision}
              onChange={(event) => setVision(event.target.checked)}
            />
            <span>
              <strong>This model supports images</strong>
              <small>Only enable capabilities the endpoint actually supports.</small>
            </span>
          </label>
        )}
        <div className="modal-actions">
          {provider?.source === 'encrypted_database' && (
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.stepUp();
                  await api.deleteProvider();
                  loadProvider();
                })
              }
            >
              <Trash2 /> Remove saved provider
            </button>
          )}
          <button
            disabled={
              busy ||
              (['openrouter', 'ollama-cloud'].includes(providerKind) &&
                !providerKey &&
                !(provider?.hasApiKey && provider.provider === providerKind)) ||
              (providerKind === 'openai-compatible' && (!modelId || !providerUrl))
            }
            onClick={() => void saveProvider()}
          >
            <ShieldCheck /> {busy ? 'Verifying…' : 'Verify and save'}
          </button>
        </div>
        {/*
          What each chat model costs, holds, is licensed under and how open it is.

          The catalogue carries all of it and nothing anywhere read a single field: the media picker
          above prints a price beside every option, and the chat picker — on a product that is
          itself AGPL and grades its models on openness — printed none. It is asked for on the press
          rather than with the page because the whole record is what `types.ts` says put 424 kB in
          front of first paint when it rode the bootstrap; one request on an explicit press is the
          other door that comment implies.
        */}
        {catalogue === undefined ? (
          <button
            className="secondary"
            onClick={() =>
              void loadModelCatalogue()
                .then(setCatalogue)
                .catch(() => setCatalogue(null))
            }
          >
            <Scale /> What each model costs
          </button>
        ) : catalogue === null ? (
          <p className="web-search-route">
            <span>The model catalogue could not be read from this server just now.</span>
            <small>Nothing changed. Reopen this page to try again.</small>
          </p>
        ) : (
          <div className="settings-list">
            {catalogue.map((model) => (
              <div key={model.id}>
                <span>
                  <strong>
                    {model.displayName}
                    {model.availability === 'available' ? '' : ` · ${model.availability}`}
                  </strong>
                  <small>{modelDetailLine(model)}</small>
                  <small>{modelOpennessLine(model)}</small>
                </span>
              </div>
            ))}
          </div>
        )}
        <hr />
        {/*
          Which model makes a picture, and which one speaks.

          Both were constants compiled into the worker until now, so an owner paying a provider for
          a catalogue of generators had a choice of one of each and no way to see either. The
          vocabulary is the composer's, deliberately: Recommended, Faster and Higher quality mean
          here what they mean there. What is different, and is said out loud below rather than
          implied, is what those words stand on. The chat modes rank on measured benchmarks; no
          benchmark measures an image model anywhere in the provider feed, so these three read the
          only column that exists, which is price.
        */}
        <div className="section-heading compact">
          <CloudCog />
          <div>
            <strong>Image and speech models</strong>
            <span>
              What generate_media uses, and what each one costs. Your provider bills these apart
              from chat, per image and per character rather than per token.
            </span>
          </div>
        </div>
        {media === null ? (
          <p className="web-search-route">
            <span>The media catalogue could not be read from your provider just now.</span>
            <small>
              Generation still works and uses the reviewed routes. Reopen this page to try again.
            </small>
          </p>
        ) : media === undefined ? (
          <p className="web-search-route">
            <span>Asking your provider what it can generate…</span>
          </p>
        ) : (
          <>
            {media.modalities.map((entry) => (
              <MediaModalityRow
                key={entry.modality}
                entry={entry}
                choice={
                  mediaSelection[entry.modality as 'image' | 'audio' | 'transcription'] ??
                  entry.choice
                }
                onChoose={(choice) =>
                  setMediaSelection({ ...mediaSelection, [entry.modality]: choice })
                }
              />
            ))}
            <p className="web-search-route">
              <span>
                Recommended, Faster and Higher quality order these by price and nothing else.
              </span>
              <small>
                Nothing in your provider’s catalogue measures how good a generated image or voice
                is, so athanor does not pretend to rank them on it. Above{' '}
                {usd(media.approvalThresholdUsd)} of generated media in one conversation, every
                further generation asks you first — and a model whose price your provider does not
                publish asks every time, because there is no figure to weigh against that.
              </small>
            </p>
            <div className="modal-actions">
              <button disabled={busy || !provider?.configured} onClick={() => void saveMedia()}>
                <Save /> Save media models
              </button>
            </div>
          </>
        )}
        <hr />
        <div className="section-heading compact">
          <CircleDollarSign />
          <div>
            <strong>Spending caps</strong>
            <span>
              Your provider bills you directly. These are the amounts athanor stops at. Leave a
              field blank for no cap.
            </span>
          </div>
        </div>
        <div className="form-grid two">
          <label>
            Daily cap (USD)
            <input
              inputMode="decimal"
              placeholder="No cap"
              value={spendLimitsForm.dailyCapUsd}
              onChange={(event) =>
                setSpendLimitsForm({ ...spendLimitsForm, dailyCapUsd: event.target.value })
              }
            />
          </label>
          <label>
            Monthly cap (USD)
            <input
              inputMode="decimal"
              placeholder="No cap"
              value={spendLimitsForm.monthlyCapUsd}
              onChange={(event) =>
                setSpendLimitsForm({ ...spendLimitsForm, monthlyCapUsd: event.target.value })
              }
            />
          </label>
          <label>
            Per-conversation cap (USD)
            <input
              inputMode="decimal"
              placeholder="No cap"
              value={spendLimitsForm.defaultTaskCapUsd}
              onChange={(event) =>
                setSpendLimitsForm({ ...spendLimitsForm, defaultTaskCapUsd: event.target.value })
              }
            />
          </label>
          {/*
            The one brake that acts before an expensive route is chosen rather than after the money
            is gone. Every field above stops work once a total has been reached; these two decide
            what may be picked in the first place, which is what a 3 a.m. scheduled run needs — it
            has nothing else stopping it from taking the priciest route in the catalogue.

            They are rates, not amounts, and the copy says so: an owner who reads "$5" here as five
            dollars of spending has set a ceiling that admits almost every model there is.
          */}
          <label>
            Price ceiling, input (USD per million tokens)
            <small>the most it may pay for a model’s input rate — not an amount it may spend</small>
            <input
              inputMode="decimal"
              placeholder="No ceiling"
              value={spendLimitsForm.maxInputUsdPerMillionTokens ?? ''}
              onChange={(event) =>
                setSpendLimitsForm({
                  ...spendLimitsForm,
                  maxInputUsdPerMillionTokens: event.target.value
                })
              }
            />
          </label>
          <label>
            Price ceiling, output (USD per million tokens)
            <small>models that publish a higher rate than either are not offered at all</small>
            <input
              inputMode="decimal"
              placeholder="No ceiling"
              value={spendLimitsForm.maxOutputUsdPerMillionTokens ?? ''}
              onChange={(event) =>
                setSpendLimitsForm({
                  ...spendLimitsForm,
                  maxOutputUsdPerMillionTokens: event.target.value
                })
              }
            />
          </label>
          <label>
            Warn at (%)
            <input
              inputMode="numeric"
              value={spendLimitsForm.warnAtPercent}
              onChange={(event) =>
                setSpendLimitsForm({ ...spendLimitsForm, warnAtPercent: event.target.value })
              }
            />
          </label>
          <label>
            Your time zone <small>the day and month roll over here</small>
            <input
              value={spendLimitsForm.timeZone}
              placeholder="Europe/London"
              onChange={(event) =>
                setSpendLimitsForm({ ...spendLimitsForm, timeZone: event.target.value })
              }
            />
          </label>
        </div>
        {/* The blank fields above are already the answer, but a blank field reads as a thing not
            filled in rather than as a ceiling that does not exist. This is the same fact stated as
            what the box does, which is the part worth knowing. */}
        {!capsInForce && <p className="spend-note">No ceiling is set. Nothing here stops a run.</p>}
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const patch = spendLimitsPatch(spendLimitsForm);
              if (!patch.ok) throw new Error(patch.message);
              const saved = await api.updateSpendLimits(patch.body);
              setSpendLimitsForm(spendLimitsDraft(saved));
              setCapsAnswered(Date.parse(saved.updatedAt) > 0);
              setCapsInForce(anyCapInForce(saved));
              setNotice(
                anyCapInForce(saved)
                  ? 'Spending caps saved. Work stops before it crosses them.'
                  : 'Saved. No ceiling: nothing here stops a run.'
              );
            })
          }
        >
          <Save /> Save caps
        </button>
        {/*
          What was spent, against the caps it was spent under. This was a seventh top-level pane
          next to Files and the screen — a report standing where a place should be, and half a
          window away from the only numbers that give it meaning.
        */}
        {workspace && (
          <UsagePane
            workspace={workspace}
            tasks={tasks}
            {...(conversationEvents ? { conversationEvents } : {})}
            onOpenTask={onOpenTask}
          />
        )}
        <hr />
        <div className="section-heading compact">
          <Code2 />
          <div>
            <strong>Coding agents you already pay for</strong>
            {/*
              One sentence and one button. This was three two-sentence rows above the same button,
              each naming a product by brand and repeating "ask athanor to install it, then run its
              login command" - which is the same instruction three times, and is the terminal's job
              to know rather than this page's. Which CLIs exist changes faster than this screen does.
            */}
            <span>
              Sign a coding CLI in on this computer and athanor hands repository work to it. Its
              tokens never enter a conversation, and its sessions and output stay on this machine.
            </span>
          </div>
        </div>
        <button className="secondary" onClick={onOpenTerminal}>
          Open Terminal
        </button>
      </div>

      <div className="settings-section knowledge-settings" hidden={page !== 'agent'}>
        <div className="section-heading">
          <ShieldCheck />
          <div>
            <strong>How much it asks</strong>
            {/*
              A control, not a description of one. These three were printed here as read-only rows
              ending in "set per conversation from the shield in the composer" — and that shield
              sets the open conversation's mode, so the workspace default this page was describing
              could not be changed from anywhere at all once a conversation existed. The words are
              still the composer's own table, so the two places cannot describe the same three
              settings differently.
            */}
            {/* "Its shield" was the developer's name for the chip. What the owner sees on it is the
                mode word, or "Connect AI" and a dot when there is no provider - never a shield. */}
            <span>
              This is where new conversations start. To change the one you are in, tap the mode next
              to the message box.
            </span>
          </div>
        </div>
        <fieldset className="security-modes">
          <legend>New conversations start in</legend>
          {securityModes.map((mode) => (
            <label key={mode} className={mode === defaultMode ? 'chosen' : ''}>
              <input
                type="radio"
                name="workspace-default-security-mode"
                value={mode}
                checked={mode === defaultMode}
                disabled={!workspace || busy}
                onChange={() => void chooseDefaultMode(mode)}
              />
              <strong>{securityModeCopy[mode].label}</strong>
              <small>{securityModeCopy[mode].description}</small>
            </label>
          ))}
        </fieldset>
        <div className="section-heading compact">
          <LockKeyhole />
          <div>
            <strong>Always asks, whatever the mode</strong>
            <span>Nothing on this page switches these off.</span>
          </div>
        </div>
        <div className="settings-list">
          {alwaysAsks.map((rule) => (
            <div key={rule.what}>
              <span>
                <strong>{rule.what}</strong>
                <small>{rule.detail}</small>
              </span>
            </div>
          ))}
        </div>
        <div className="section-heading compact">
          <Scale />
          <div>
            <strong>Where Balanced and Autonomous differ</strong>
            {/* Two rules, and this is all of them: nothing else in the classifier reads the choice
                between those two modes. Said out loud so the list can be finished. */}
            <span>Everything else is decided the same way in both.</span>
          </div>
        </div>
        <div className="settings-list">
          {balancedVsAutonomous.map((rule) => (
            <div key={rule.what}>
              <span>
                <strong>{rule.what}</strong>
                <small>{rule.detail}</small>
              </span>
            </div>
          ))}
        </div>
        {/* Moved here from the page about models and spending, where four statements about
            approvals, sandboxing and confinement sat under a heading naming neither. This is the
            page called "What it may do", and the two lists above are the rest of the answer. */}
        <div className="privacy-boundary">
          <LockKeyhole />
          <span>
            <strong>Handed-off work follows the same rules</strong>
            {' · '}athanor shows the specialist mission for approval, bounds its runtime, keeps it
            in the workspace, and returns one compact result to the main conversation. Strict
            zero-retention tasks never route through subscription CLIs because their publisher
            policies are separate.
          </span>
        </div>
        <hr />
        <div className="section-heading">
          <ScrollText />
          <div>
            <strong>Standing instructions</strong>
            <span>
              A file on the agent computer, read at the start of every conversation. House rules,
              names, conventions—whatever the agent should never have to be told twice.
            </span>
          </div>
        </div>
        <label className="brief-editor">
          <span className="brief-path">{briefPath}</span>
          <textarea
            value={brief}
            rows={7}
            maxLength={50_000}
            spellCheck={false}
            placeholder={
              '# Standing instructions\n\n- Always write to workspace/results.\n- Ask before touching anything outside this computer.\n'
            }
            onChange={(event) => setBrief(event.target.value)}
          />
        </label>
        <button
          disabled={!workspace || busy || brief === savedBrief}
          onClick={() =>
            void act(async () => {
              if (!workspace) return;
              const saved = await api.updateWorkspaceBrief(workspace.id, brief);
              setBrief(saved.markdown);
              setSavedBrief(saved.markdown);
              setBriefPath(saved.path);
              setNotice('Standing instructions saved. The next conversation reads them.');
            })
          }
        >
          <Save /> Save instructions
        </button>
        <hr />
        <div className="section-heading">
          <BookOpenText />
          <div>
            <strong>What the agent remembers</strong>
            <span>
              Facts it should keep, and the procedures it has learned. Everything here is encrypted
              on your server.
            </span>
          </div>
        </div>
        <div className="form-grid two">
          <label>
            Scope
            {/* Which of the two lists a fact belongs to is decided when it is written and cannot be
                patched: the route takes `content` and `validUntil` and nothing else, so a row being
                edited holds its scope rather than offering a move the server would refuse. */}
            <select
              value={memoryTarget}
              disabled={Boolean(editingMemoryId)}
              onChange={(event) => setMemoryTarget(event.target.value as typeof memoryTarget)}
            >
              <option value="workspace">This computer</option>
              <option value="user">Me everywhere</option>
            </select>
          </label>
          <label>
            Durable fact or preference
            <input value={memory} onChange={(event) => setMemory(event.target.value)} />
          </label>
          <label>
            Stop using it on <small>leave blank to keep it for good</small>
            <input
              type="datetime-local"
              value={memoryExpiry}
              onChange={(event) => setMemoryExpiry(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button
            disabled={!workspace || !memory.trim() || busy}
            onClick={() =>
              void act(async () => {
                if (!workspace) return;
                const patch = memoryPatch({ content: memory, expiry: memoryExpiry });
                if (!patch.ok) throw new Error(patch.message);
                if (editingMemoryId) {
                  await api.updateMemory(workspace.id, editingMemoryId, patch.body);
                  setNotice('Memory updated. The next conversation reads the new wording.');
                } else {
                  await api.addMemory(workspace.id, {
                    target: memoryTarget,
                    content: patch.body.content,
                    // Omitted rather than sent as null: `POST` has no expiry to clear, and the
                    // route's own default is the permanent one.
                    ...(patch.body.validUntil ? { validUntil: patch.body.validUntil } : {})
                  });
                }
                setMemory('');
                setMemoryExpiry('');
                setEditingMemoryId('');
                loadKnowledge();
              })
            }
          >
            <Plus /> {editingMemoryId ? 'Save memory' : 'Add memory'}
          </button>
          {editingMemoryId ? (
            <button
              className="secondary"
              onClick={() => {
                setEditingMemoryId('');
                setMemory('');
                setMemoryExpiry('');
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <MemoryList
          items={memories}
          editingId={editingMemoryId || undefined}
          onEdit={(item) => {
            setEditingMemoryId(item.id);
            setMemory(item.content);
            setMemoryTarget(item.target);
            setMemoryExpiry(memoryExpiryField(item.validUntil));
          }}
          onOpenTask={onOpenTask}
          onForget={(item) => {
            if (!workspace) return;
            if (item.id === editingMemoryId) {
              setEditingMemoryId('');
              setMemory('');
              setMemoryExpiry('');
            }
            setMemories((current) => current.filter((entry) => entry.id !== item.id));
            undo({
              message: 'Memory deleted',
              commit: () => api.deleteMemory(workspace.id, item.id),
              restore: loadKnowledge
            });
          }}
        />
        {/*
          What the box has stopped being sure of, above the list of what it still believes.

          The queue is built at three layers — a stale-procedure query, a verify, a retract — and
          until now reached nothing: the only production caller discarded its result. It reads its
          own list and owns its own failure sentence, so nothing is threaded through it.
        */}
        {workspace ? <MemoryReview workspaceId={workspace.id} onOpenTask={onOpenTask} /> : null}
        <RememberedList
          items={remembered}
          more={rememberedMore}
          onShowOlder={() => loadRemembered(rememberedLimit + REMEMBERED_PAGE)}
          onForget={(item) =>
            void act(async () => {
              if (!workspace) return;
              await api.deleteMemoryItem(workspace.id, item.id);
              setRemembered((current) => current.filter((entry) => entry.id !== item.id));
            })
          }
        />
        <hr />
        <div className="section-heading compact">
          <Code2 />
          <div>
            <strong>Learned skills</strong>
            <span>
              A named procedure the agent reaches for when it fits. Open one to read or change it.
            </span>
          </div>
        </div>
        <div className="form-grid two">
          <label>
            Skill name
            <input
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
              placeholder="release-a-website"
            />
          </label>
          <label>
            When to use it
            <input
              value={skillDescription}
              onChange={(event) => setSkillDescription(event.target.value)}
            />
          </label>
        </div>
        <label>
          Procedure
          <textarea
            rows={10}
            value={skillContent}
            onChange={(event) => setSkillContent(event.target.value)}
          />
        </label>
        <button
          disabled={!workspace || !skillName || !skillDescription || busy}
          onClick={() =>
            void act(async () => {
              if (!workspace) return;
              await api.saveSkill(workspace.id, {
                name: skillName,
                description: skillDescription,
                content: skillContent
              });
              setSkillName('');
              setSkillDescription('');
              setSkillContent(skillTemplate);
              loadKnowledge();
            })
          }
        >
          <Plus /> {skills.some((item) => item.name === skillName) ? 'Update' : 'Save'} skill
        </button>
        <SkillList
          items={skills}
          busy={busy}
          onOpen={(item) => {
            setSkillName(item.name);
            setSkillDescription(item.description);
            setSkillContent(item.content);
          }}
          onSetState={(item, patch) =>
            void act(async () => {
              if (!workspace) return;
              const saved = await api.setSkillState(workspace.id, item.id, patch);
              setSkills((current) =>
                current.map((entry) => (entry.id === saved.id ? saved : entry))
              );
              setNotice(
                patch.status === 'active'
                  ? `“${item.name}” is active again. Pin it if you want it kept through the next curation.`
                  : saved.pinned
                    ? `“${item.name}” is pinned. It is no longer retired for going unused.`
                    : `“${item.name}” is unpinned. Thirty days unused makes it stale, ninety archives it.`
              );
            })
          }
          onDelete={(item) => {
            if (!workspace) return;
            setSkills((current) => current.filter((entry) => entry.id !== item.id));
            undo({
              message: `Deleted the “${item.name}” skill`,
              commit: () => api.deleteSkill(workspace.id, item.id),
              restore: loadKnowledge
            });
          }}
        />
        {/*
          The record of what the box was allowed to do, across every conversation rather than one.

          Approvals are answered in the conversation they arise in and were readable nowhere
          afterwards: the route has taken a status filter and a cursor all along, and the four
          statuses — including the one nobody chose, an approval that simply lapsed — had no reader.
        */}
        <hr />
        <DecisionsLog onOpenTask={onOpenTask} />
      </div>

      <div className="settings-section" hidden={page !== 'agent'}>
        <Connectors
          ownerName={user.displayName}
          busy={busy}
          act={act}
          setNotice={setNotice}
          setError={setError}
        />
      </div>

      <div className="settings-section" hidden={page !== 'devices'}>
        <div className="section-heading">
          <QrCode />
          <div>
            <strong>Add another device</strong>
            {/* What the button makes, not how to use a thing that does not exist yet: the
                instruction to scan lives on the card that holds the code. */}
            <span>
              A one-time link for a second phone or laptop. It works once and expires ten minutes
              after you make it.
            </span>
          </div>
        </div>
        {enrollment ? (
          <div className="enrollment-card">
            {enrollmentQr && <img src={enrollmentQr} alt="Device enrollment code" />}
            <span>Scan this from the new device, or paste the link into its sign-in screen.</span>
            <code>{enrollment.webUri}</code>
            <span>Expires {new Date(enrollment.expiresAt).toLocaleTimeString()} · single use</span>
            <div className="enrollment-actions">
              <CopyButton value={enrollment.webUri} label="Copy link" />
              <button
                onClick={() =>
                  void act(async () => {
                    await api.revokeEnrollment(enrollment.id);
                    setEnrollment(undefined);
                    setEnrollmentQr('');
                    loadEnrollments();
                  })
                }
              >
                <X /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <label>
              What to call it
              {/* The one call site sent the literal 'New device', so every device in the sessions
                  list arrived with the same name and the list could not be read. The route has
                  always taken a label. */}
              <input
                value={enrollmentLabelDraft}
                maxLength={60}
                placeholder="Kitchen laptop"
                onChange={(event) => setEnrollmentLabelDraft(event.target.value)}
              />
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.stepUp();
                  const created = await api.createEnrollment(
                    enrollmentLabelDraft.trim() || 'New device'
                  );
                  setEnrollment(created);
                  setEnrollmentLabelDraft('');
                  loadEnrollments();
                  // Loaded on demand: the encoder is only needed on this one screen.
                  const { toDataURL } = await import('qrcode');
                  setEnrollmentQr(
                    await toDataURL(created.webUri, {
                      errorCorrectionLevel: 'M',
                      margin: 2,
                      width: 240,
                      color: { dark: '#e7e9ea', light: '#0c0d0e' }
                    })
                  );
                })
              }
            >
              <QrCode /> Show device code
            </button>
          </>
        )}
        {/*
          The links that are still out there, and the kill switch for each.

          Minting one and revoking one were both reachable and the list between them was not: the
          card holding a live invitation lived in component state, so navigating away, reloading or
          closing Settings left a working grant to this account with no door — possibly with its
          link sitting on a photographed screen. The server has listed them all along.
        */}
        {enrollments?.length ? (
          <div className="settings-list">
            {enrollments.map((grant) => (
              <div key={grant.id}>
                <span>
                  <strong>{grant.label}</strong>
                  <small>{enrollmentLine(grant)}</small>
                </span>
                {enrollmentRevocable(grant) && (
                  <button
                    className="icon-btn"
                    aria-label={`Cancel the link for ${grant.label}`}
                    title="Cancel this link"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.revokeEnrollment(grant.id);
                        if (enrollment?.id === grant.id) {
                          setEnrollment(undefined);
                          setEnrollmentQr('');
                        }
                        setNotice('That link no longer works. Nothing was signed out.');
                        loadEnrollments();
                      })
                    }
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}
        {enrollments?.length === 0 ? (
          // "None this week", not "you have never made one": the route lists the last seven days.
          <p className="settings-summary">No device links made in the last week.</p>
        ) : null}

        <div className="section-heading">
          <LockKeyhole />
          <div>
            <strong>Passkeys and devices</strong>
            <span>Every browser is independently revocable. No password is stored.</span>
          </div>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api.stepUp();
              await api.addPasskey();
              loadSecurity();
            })
          }
        >
          <KeyRound /> Add this device
        </button>
        {securityUnavailable && (
          <p className="settings-unavailable">
            Your devices, passkeys and API tokens could not be read just now. Nothing was revoked —
            this is not a list of what exists.
          </p>
        )}
        <div className="settings-list">
          {sessions.map((item) => (
            <div key={item.id}>
              <span>
                <strong>{item.deviceLabel}</strong>
                <small>
                  {item.current ? 'Current device · ' : ''}
                  last used {new Date(item.lastSeenAt).toLocaleString()}
                </small>
              </span>
              {!item.current && (
                <button
                  className="icon-btn"
                  aria-label={`Sign out ${item.deviceLabel}`}
                  disabled={busy}
                  /*
                   * Confirmed here rather than in the commit below, which is the whole reason this
                   * row could not be relied on: the revoke runs when the undo window closes, so a
                   * refusal arrived seconds after the row had already gone from the list, and a
                   * passkey sheet raised then would appear with nothing on screen asking for it.
                   * Prompting on the press keeps the ceremony attached to the gesture that wanted
                   * it, and the row is only removed once the server will accept the removal. The
                   * token revoke beside this one (`Revoke the … token`) already works this way.
                   */
                  onClick={() =>
                    void act(async () => {
                      await api.stepUp();
                      setSessions((current) => current.filter((entry) => entry.id !== item.id));
                      undo({
                        message: `Signed out ${item.deviceLabel}`,
                        commit: () => api.revokeSession(item.id),
                        restore: loadSecurity
                      });
                    })
                  }
                >
                  <Trash2 />
                </button>
              )}
            </div>
          ))}
          {passkeys.map((item) => (
            <div key={item.id}>
              <span>
                <strong>{passkeyLabel(item)}</strong>
                <small>
                  {item.backedUp ? 'Synced backup available' : 'Device-bound'}
                  {passkeyRemovable(passkeys, item.id)
                    ? ''
                    : ' · the only sign-in method left, so it cannot be removed'}
                </small>
              </span>
              {passkeyRemovable(passkeys, item.id) && (
                <button
                  className="icon-btn"
                  aria-label={`Remove ${passkeyLabel(item)}`}
                  title="Remove this passkey"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.stepUp();
                      await api.revokePasskey(item.id);
                      setNotice('That passkey can no longer sign in to this account.');
                      loadSecurity();
                    })
                  }
                >
                  <Trash2 />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="section-heading">
          <KeyRound />
          <div>
            <strong>Recovery code</strong>
            <span>
              The one way back in if every passkey is gone. A new one retires the old immediately.
            </span>
          </div>
        </div>
        {reissuedRecoveryCode ? (
          <div className="enrollment-card">
            <code>{reissuedRecoveryCode}</code>
            <span>Shown once. The previous code no longer works.</span>
            <div className="enrollment-actions">
              <CopyButton value={reissuedRecoveryCode} label="Copy code" />
              {/*
                The same repair as the first-sign-in screen, on the same string, through the same
                bridge and saying the same sentence — and it matters more here, because pressing
                "Issue a new recovery code" has already retired whatever the owner had written down.
                A raw anchor on a packaged client discards the click without a word, and the next
                control along is "I have saved it".
              */}
              <button
                className="secondary"
                onClick={() => {
                  setRecoveryCodeSaveError('');
                  const file = recoveryFile(reissuedRecoveryCode);
                  void nativeBridge
                    .saveFile(file.name, new Blob([file.text], { type: file.type }))
                    .then((written) => {
                      if (!written) setRecoveryCodeSaveError(DOWNLOAD_UNAVAILABLE_RECOVERY_CODE);
                    });
                }}
              >
                <Download /> Download
              </button>
              <button onClick={() => setReissuedRecoveryCode('')}>
                <Check /> I have saved it
              </button>
            </div>
            {recoveryCodeSaveError ? (
              <div className="form-error" role="alert">
                {recoveryCodeSaveError}
              </div>
            ) : null}
          </div>
        ) : (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api.stepUp();
                const { recoveryCode } = await api.reissueRecoveryCode();
                setReissuedRecoveryCode(recoveryCode);
                setNotice('New recovery code issued. The previous one stopped working just now.');
              })
            }
          >
            <RotateCcw /> Issue a new recovery code
          </button>
        )}

        {/*
          Last on the page, under the three sign-in blocks it is named for. Quiet hours sat second
          here, above passkeys and above the recovery code, so somebody arriving to revoke a browser
          or reissue their code scrolled past a form about when to be woken up to reach either.
        */}
        <div className="section-heading">
          <BellRing />
          <div>
            <strong>Notifications on this device</strong>
            {/*
              The packaged app is a different device with a different answer, and this section used
              to give it the browser's one.

              `notificationState()` returns 'unsupported' in a WKWebView or a WebView2 because
              `PushManager` genuinely is not there — so an installed athanor was told "this browser
              cannot receive push notifications" and had its only button disabled, while the poll
              behind the screen went on asking the operating system for permission with no user
              gesture behind it. The owner was told it was impossible, never asked, and then got a
              system prompt at a moment they did not choose. A packaged shell needs no push
              subscription: it raises the notification itself, from a poll it is already running.
            */}
            <span>
              {nativeBridge.available()
                ? nativeNotifications
                  ? 'This app can interrupt you through the operating system. It raises them itself — there is no push service in between and nothing leaves this box.'
                  : 'This app can tell you through the operating system when work finishes or needs you. Turning it on asks your system for permission, once, on the press.'
                : pushState === 'checking'
                  ? 'Checking whether this device can be told.'
                  : pushState === 'unsupported'
                    ? 'This browser cannot receive push notifications.'
                    : pushState === 'unregistered'
                      ? // The default install: no browser will run a service worker for an origin
                        // whose certificate it does not trust, and without one there is nothing to
                        // deliver a notification to. This used to wait on a promise that never
                        // settles, so the section sat on "checking" for ever with a dead button.
                        'No browser accepts notifications from a server using a self-signed certificate. On the server: sudo athanor certificate enable --agree-tos --email you@example.com'
                      : pushState === 'unavailable'
                        ? 'The server has no push key configured, so notifications are off.'
                        : pushState === 'denied'
                          ? 'This browser blocked notifications. Allow them in site settings first.'
                          : 'Tell me when a long task finishes or needs approval, even with athanor closed.'}
            </span>
          </div>
        </div>
        {nativeBridge.available() ? (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (nativeNotifications) {
                  setNativeNotificationsEnabled(false);
                  setNativeNotifications(false);
                  setNotice('This app will not interrupt you. athanor still shows notices in-app.');
                  return;
                }
                /*
                 * The permission prompt, attached to the press that asked for it.
                 *
                 * `notify` asks the OS only when it has not already been granted, and raising one
                 * here is the round trip rather than a flourish: a preference stored without ever
                 * having raised a notification is exactly the kind of switch this sweep exists to
                 * remove. If the system refuses, nothing is stored and the refusal is said.
                 */
                const raised = await nativeBridge.notify(
                  'athanor',
                  'Notifications are on. This is what one looks like.'
                );
                if (!raised)
                  throw new Error(
                    'Your system did not allow the notification. Allow athanor to notify you in your system settings, then try again.'
                  );
                setNativeNotificationsEnabled(true);
                setNativeNotifications(true);
                setNotice(
                  'On. The rules below decide which of them are worth interrupting you for.'
                );
              })
            }
          >
            <BellRing />
            {nativeNotifications ? 'Turn off notifications' : 'Turn on notifications'}
          </button>
        ) : (
          <button
            disabled={
              busy ||
              ['checking', 'unsupported', 'unregistered', 'unavailable', 'denied'].includes(
                pushState
              )
            }
            onClick={() =>
              void act(async () => {
                setPushState(
                  pushState === 'enabled'
                    ? await disableNotifications()
                    : await enableNotifications()
                );
              })
            }
          >
            <BellRing />
            {pushState === 'enabled' ? 'Turn off notifications' : 'Turn on notifications'}
          </button>
        )}
        {pushSettings && (
          <>
            {/* Only the kinds this box stores: see notificationSettingsFromResponse. */}
            <div className="notification-kinds">
              {pushDraft.supported.map((kind) => (
                <label key={kind} className="toggle-row">
                  <input
                    type="checkbox"
                    checked={pushDraft.kinds[kind]}
                    onChange={(event) =>
                      setPushDraft({
                        ...pushDraft,
                        kinds: { ...pushDraft.kinds, [kind]: event.target.checked }
                      })
                    }
                  />
                  <strong>{notificationKindCopy[kind].label}</strong>
                  <small>{notificationKindCopy[kind].detail}</small>
                </label>
              ))}
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={pushDraft.quietHoursEnabled}
                onChange={(event) =>
                  setPushDraft({ ...pushDraft, quietHoursEnabled: event.target.checked })
                }
              />
              <strong>Quiet hours</strong>
              <small>
                Held on the server, not just silenced on this device, and read in the same time zone
                your spending day rolls over in ({pushSettings.timeZone}).
              </small>
            </label>
            {pushDraft.quietHoursEnabled && (
              <>
                <div className="form-grid two">
                  <label>
                    From
                    <input
                      type="time"
                      value={pushDraft.quietHoursStart}
                      onChange={(event) =>
                        setPushDraft({ ...pushDraft, quietHoursStart: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Until
                    <input
                      type="time"
                      value={pushDraft.quietHoursEnd}
                      onChange={(event) =>
                        setPushDraft({ ...pushDraft, quietHoursEnd: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={pushDraft.quietHoursAllowApprovals}
                    onChange={(event) =>
                      setPushDraft({
                        ...pushDraft,
                        quietHoursAllowApprovals: event.target.checked
                      })
                    }
                  />
                  <strong>Let approvals through anyway</strong>
                  <small>
                    An approval is the one message where silence has a cost: the work waits until
                    you answer it.
                  </small>
                </label>
              </>
            )}
            <p className="settings-summary">
              {notificationSettingsSummary(pushDraft, pushSettings.timeZone)}
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const patch = notificationSettingsPatch(pushDraft);
                  if (!patch.ok) throw new Error(patch.message);
                  const saved = await api.updateNotificationSettings(patch.body);
                  setPushSettings(saved);
                  setPushDraft(notificationSettingsDraft(saved));
                  setNotice('Saved. The server decides what to send before your device sees it.');
                })
              }
            >
              <Save /> Save notification rules
            </button>
          </>
        )}

        <div className="modal-actions">
          <button onClick={() => void exportData()} disabled={busy}>
            <Download /> Export my data
          </button>
          <button className="secondary" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>

      <div className="settings-section" hidden={page !== 'devices'}>
        <div className="section-heading">
          <Code2 />
          <div>
            {/* There is no athanor CLI to name here any more: the token is for the HTTP API. */}
            <strong>API access</strong>
            <span>Create a revocable token for your own scripts and clients.</span>
          </div>
        </div>
        <label>
          Token label
          <input
            value={tokenDraft.label}
            placeholder="Backup script"
            onChange={(event) => setTokenDraft({ ...tokenDraft, label: event.target.value })}
          />
        </label>
        {/*
          Thirteen scopes are enforced on the server and seven used to be issuable, so the routes
          behind the other six could not be reached by any token this box could create. They are
          all here now, each said as what it lets a script do rather than as its enum.
        */}
        <fieldset className="token-scopes">
          <legend>What this token may do</legend>
          {apiTokenScopeCopy.map((item) => (
            <label key={item.scope}>
              <input
                type="checkbox"
                checked={tokenDraft.scopes.includes(item.scope)}
                onChange={() =>
                  setTokenDraft({
                    ...tokenDraft,
                    scopes: toggleApiTokenScope(tokenDraft.scopes, item.scope)
                  })
                }
              />
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </label>
          ))}
        </fieldset>
        <label>
          Expires in <small>days, up to {MAX_TOKEN_DAYS}</small>
          <input
            type="number"
            min={MIN_TOKEN_DAYS}
            max={MAX_TOKEN_DAYS}
            value={tokenDraft.expiresInDays}
            onChange={(event) =>
              setTokenDraft({ ...tokenDraft, expiresInDays: event.target.value })
            }
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const request = apiTokenRequest(tokenDraft);
              if (!request.ok) throw new Error(request.message);
              await api.stepUp();
              const result = await api.createApiToken(request.body);
              setIssuedToken(result.token);
              setTokenDraft(emptyApiTokenDraft());
              loadSecurity();
            })
          }
        >
          <Plus /> Create token
        </button>
        {issuedToken && (
          <div className="privacy-boundary">
            <code>{issuedToken}</code>
            <button
              className="icon-btn"
              aria-label="Copy token"
              onClick={() => void navigator.clipboard.writeText(issuedToken)}
            >
              <Copy />
            </button>
          </div>
        )}
        <div className="settings-list">
          {tokens.map((item) => (
            <div key={item.id}>
              <span>
                <strong>{item.label}</strong>
                <small>
                  {item.prefix}… · {apiTokenSummary(item)}
                </small>
              </span>
              <button
                className="icon-btn"
                aria-label={`Revoke the ${item.label} token`}
                onClick={() =>
                  void act(async () => {
                    await api.stepUp();
                    setTokens((current) => current.filter((entry) => entry.id !== item.id));
                    undo({
                      message: `Revoked “${item.label}”`,
                      commit: () => api.revokeApiToken(item.id),
                      restore: loadSecurity
                    });
                  })
                }
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-section" hidden={page !== 'server'}>
        {/*
          First, because it is the only thing on this page somebody arrives in a hurry to reach.
          Recovery points used to sit between the relay and the licence line: the relay is off for
          almost every owner and its own copy opens "you probably do not need this", so the one
          undo for the whole filesystem was behind a block written to be skipped.
        */}
        <div className="section-heading recovery-heading">
          <Save />
          <div>
            <strong>Recovery points</strong>
            <span>
              A local copy of working files, published results, and the browser profile. Linked or
              mounted bulk storage and account history are not copied. Large local datasets need
              enough free disk space for another copy.
            </span>
          </div>
        </div>
        <div className="recovery-create">
          <input
            value={snapshotName}
            maxLength={80}
            placeholder="Before the next major change"
            onChange={(event) => setSnapshotName(event.target.value)}
          />
          <button
            disabled={!workspace || !snapshotName.trim() || busy}
            onClick={() =>
              void act(async () => {
                if (!workspace) return;
                await api.stepUp();
                await api.createWorkspaceSnapshot(workspace.id, snapshotName.trim());
                setSnapshotName('');
                setNotice('Recovery point created and verified.');
                loadSnapshots();
              })
            }
          >
            <Save /> Create
          </button>
        </div>
        <div className="settings-list recovery-list">
          {snapshotsUnavailable && (
            <div>
              <span>
                <strong>The recovery points could not be read</strong>
                <small>Nothing was removed — this device could not reach the server.</small>
              </span>
            </div>
          )}
          {!snapshots.length && !snapshotsUnavailable && (
            <div>
              <span>
                <strong>No recovery points</strong>
                <small>Use an off-host athanor backup for disaster recovery.</small>
              </span>
            </div>
          )}
          {snapshots.map((snapshot) => (
            <div key={snapshot.id}>
              <span>
                <strong>{snapshot.name}</strong>
                <small>
                  {snapshot.status} · {formatBytes(snapshot.sizeBytes)} ·{' '}
                  {new Date(snapshot.createdAt).toLocaleString()}
                </small>
              </span>
              <span className="settings-row-actions">
                {snapshot.status === 'ready' && (
                  <button
                    className="icon-btn"
                    aria-label={`Restore ${snapshot.name}`}
                    title="Restore"
                    onClick={() => {
                      setRestoreSnapshotId(snapshot.id);
                      setRestoreConfirmation('');
                    }}
                  >
                    <RotateCcw />
                  </button>
                )}
                <button
                  className="icon-btn"
                  aria-label={`Delete ${snapshot.name}`}
                  title="Delete"
                  disabled={busy}
                  onClick={() => {
                    if (!workspace) return;
                    void act(async () => {
                      await api.stepUp();
                      setSnapshots((current) =>
                        current.filter((entry) => entry.id !== snapshot.id)
                      );
                      undo({
                        message: `Deleted “${snapshot.name}”`,
                        commit: () => api.deleteWorkspaceSnapshot(workspace.id, snapshot.id),
                        restore: loadSnapshots
                      });
                    });
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            </div>
          ))}
        </div>
        {restoreSnapshotId && workspace && (
          <div className="restore-confirmation">
            <strong>Restore this recovery point?</strong>
            <span>
              Current files and browser state will first be saved as a new safety point. Enter{' '}
              <code>{workspace.name}</code> to continue.
            </span>
            <input
              value={restoreConfirmation}
              onChange={(event) => setRestoreConfirmation(event.target.value)}
            />
            <span className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  setRestoreSnapshotId('');
                  setRestoreConfirmation('');
                }}
              >
                Cancel
              </button>
              <button
                disabled={busy || restoreConfirmation !== workspace.name}
                onClick={() =>
                  void act(async () => {
                    await api.stepUp();
                    await api.restoreWorkspaceSnapshot(
                      workspace.id,
                      restoreSnapshotId,
                      restoreConfirmation
                    );
                    setRestoreSnapshotId('');
                    setRestoreConfirmation('');
                    setNotice('Files and browser state restored. A safety point was retained.');
                    loadSnapshots();
                  })
                }
              >
                <RotateCcw /> Restore
              </button>
            </span>
          </div>
        )}
        {/*
          The relay is off, and for most owners that is the right answer. A box on a public address,
          or one with a dynamic-DNS name, is reached directly; this exists for a box behind
          carrier-grade NAT. Turning it on is two deliberate acts because it puts a third party in
          the path of every connection, and there is no default relay to fall into.
        */}
        {relay && (
          <>
            <div className="section-heading">
              <Radio />
              <div>
                <strong>Reaching this box from outside</strong>
                {/*
                  The caveats are stated here rather than linked. /docs/relay.md is not a route this
                  server has: nginx answers any unmatched path with the app, so the link opened
                  athanor again in a new tab, which reads as the page having failed to load. And
                  they are exactly the things somebody should know before turning it on.
                */}
                <span>
                  You probably do not need this. Use it only when your connection gives the box no
                  address of its own — a relay you name and enroll with carries the traffic instead.
                  Whoever runs that relay controls the name it gives you and can see the traffic
                  arrive, and this server&rsquo;s certificate does not cover the relay&rsquo;s
                  label, so a browser reaching you that way is trusting the relay operator too.
                </span>
              </div>
            </div>
            <div className={`relay-status ${relayStatusLine(relay).tone}`}>
              <span className="relay-dot" />
              <span>
                <strong>{relayStatusLine(relay).text}</strong>
                {relayQuotaNote(relay) && <small>{relayQuotaNote(relay)}</small>}
                {/* In every state, not only while it is off. The one moment the reason matters is
                    when the relay is on and failing, which is precisely when this hid it. */}
                {relay.status.lastError && <small>{relay.status.lastError}</small>}
              </span>
              {relay.label && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.stepUp();
                      setRelay(await api.setRelayEnabled(!relay.enabled));
                      setNotice(
                        relay.enabled
                          ? 'Relay switched off. This box no longer advertises that address.'
                          : 'Relay switched on.'
                      );
                    })
                  }
                >
                  {relay.enabled ? 'Turn off' : 'Turn on'}
                </button>
              )}
            </div>
            {relayAddress(relay) && (
              <div className="relay-address">
                <code>{relayAddress(relay)}</code>
                <CopyButton value={relayAddress(relay) ?? ''} label="Copy address" />
              </div>
            )}
            {relay.label ? (
              <div className="settings-list relay-list">
                <div>
                  <span>
                    <strong>{relay.host}</strong>
                    <small>
                      Enrolled{' '}
                      {relay.enrolledAt ? new Date(relay.enrolledAt).toLocaleDateString() : ''}
                      {relay.address ? ` · dialled at ${relay.address}:${relay.port}` : ''}
                    </small>
                  </span>
                  <span className="settings-row-actions">
                    <button
                      className="icon-btn"
                      aria-label="Forget this relay"
                      title="Forget this relay"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.stepUp();
                          setRelay(await api.forgetRelay());
                          setNotice(
                            'Relay forgotten. This box keeps its identity key, so enrolling again keeps the same address.'
                          );
                        })
                      }
                    >
                      <Trash2 />
                    </button>
                  </span>
                </div>
              </div>
            ) : (
              <div className="relay-enroll">
                <label>
                  Relay hostname
                  <input
                    value={relayHost}
                    placeholder="relay.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setRelayHost(event.target.value)}
                  />
                </label>
                <label>
                  Enrollment token
                  <input
                    value={relayToken}
                    placeholder="Given to you by the relay"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setRelayToken(event.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !relayHost.trim() || relayToken.trim().length < 8}
                  onClick={() =>
                    void act(async () => {
                      // Said here rather than after a round trip: the token is single-use on most
                      // relays, and spending one on a typo costs the owner a second one.
                      const problem = relayHostProblem(relayHost);
                      if (problem) throw new Error(problem);
                      await api.stepUp();
                      const enrolled = await api.enrollRelay({
                        host: relayHost.trim().toLowerCase(),
                        token: relayToken.trim()
                      });
                      setRelay(enrolled);
                      setRelayHost('');
                      setRelayToken('');
                      setNotice(
                        enrolled.hostname
                          ? `Enrolled. This box is reachable at ${enrolled.hostname}.`
                          : 'Enrolled with the relay.'
                      );
                    })
                  }
                >
                  <Radio /> Enroll
                </button>
              </div>
            )}
          </>
        )}
        <div className="section-heading">
          <Server />
          <div>
            <strong>This installation</strong>
            <span>Nobody bills you for athanor. Your server and your model provider do.</span>
          </div>
        </div>
        {/*
          What the box already wrote down about itself, said a month before it becomes an outage.
          The certificate helper begins renewing about thirty days out and records why it failed;
          nothing read that file, so the app stayed silent and perfectly usable right up to the
          morning every device refused at once, with a shell as the only way to find out why.
        */}
        {(diagnostics?.certificate || diagnostics?.dynamicDns) && (
          <div className="usage-warning critical" role="alert">
            <strong>This server needs attention</strong>
            {diagnostics.certificate && (
              <p>
                Renewing the HTTPS certificate has been failing since{' '}
                {new Date(diagnostics.certificate.failedAt).toLocaleDateString()}. Until it succeeds
                this stays reachable, and when the current certificate expires every device will
                refuse to connect. On the server: <code>sudo athanor certificate renew</code>.
                {diagnostics.certificate.reason ? ` (${diagnostics.certificate.reason})` : ''}
              </p>
            )}
            {diagnostics.dynamicDns && (
              <p>
                Publishing this server&rsquo;s address has been failing since{' '}
                {new Date(diagnostics.dynamicDns.failedAt).toLocaleDateString()}, so if its address
                changes, clients will not find it. On the server:{' '}
                <code>sudo athanor ddns configure</code>.
                {diagnostics.dynamicDns.reason ? ` (${diagnostics.dynamicDns.reason})` : ''}
              </p>
            )}
          </div>
        )}
        <div className="settings-list">
          <div>
            <span>
              <strong>Agent computer</strong>
              {/* One byte formatter everywhere: rounding to whole GiB here made a new box read
                  "0 GiB used" while the sidebar quoted the same files to one decimal. */}
              <small>
                {workspace ? workspaceStatusLabel(workspace.status) : 'Starting'}
                {workspace ? ` · ${formatBytes(workspace.storageBytes)} used` : ''}
              </small>
            </span>
            {/*
              The way back from "Needs attention".

              A computer that failed to start stayed failed: every message was answered "Workspace
              is not running" and no screen offered anything to do about it, which is reachable on a
              first sign-in if the runner is slow to answer while the box is being provisioned. The
              call is the same one a sleeping computer is woken with — it was simply never offered
              for this state.
            */}
            {!workspace ? (
              // No workspace at all is the state the composer's block sends people here from, and
              // this row answered it with a status word and nothing else. One instruction, the same
              // one the empty panel gives, so the two screens do not disagree.
              <small>
                This device cannot see the agent computer. On the server:{' '}
                <code>sudo athanor doctor</code>.
              </small>
            ) : (
              ['failed', 'hibernated'].includes(workspace.status) && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.workspaceAction(workspace.id, 'resume');
                      setNotice(
                        'Starting the agent computer. It is usable again in a few seconds.'
                      );
                    })
                  }
                >
                  <RotateCcw /> Start it again
                </button>
              )
            )}
          </div>
          <div>
            <span>
              <strong>License</strong>
              {/* True either way. The source of this build is on the machine serving this page,
                  which is what the licence actually guarantees; the link is an extra when the
                  server knows where it came from, and the row used to promise it unconditionally
                  while showing nothing. */}
              <small>
                GNU AGPL-3.0-only ·{' '}
                {legal.sourceUrl
                  ? 'source is always available'
                  : 'the source of this build is in /opt/athanor on this server'}
              </small>
            </span>
            {legal.sourceUrl && (
              <a href={legal.sourceUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
          </div>
          {/*
            What the machine did, not what it intends to do.

            This row used to open "A backup is taken daily, at a randomised hour, when nothing is
            running" — an assertion about a timer standing in for evidence from the box, on the one
            subject where being wrong cannot be repaired afterwards. Two ordinary paths made it
            false in silence: the daily run stands down when the worker is busy and exits cleanly,
            and a run that fails leaves nothing behind at all, because a copy with no checksum
            manifest cannot restore anything and is pruned as wreckage. Either way the sentence
            stayed on the screen. It now says when the last copy was actually taken and how big it
            is, and when the last run did not produce one it says that instead, with the reason.
          */}
          {backupEvidence && (
            <div>
              <span>
                <strong>Backups</strong>
                <small className={backupEvidence.attention ? 'settings-attention' : undefined}>
                  {backupEvidence.text}
                </small>
                {/*
                  Evidence, then schedule. The line above reports the last copy that was actually
                  taken, which an owner assuming backups are automatic reads as proof of a timer —
                  and a box whose timer was never enabled looks identical to one whose timer ran
                  yesterday. This is the other half, and it is the box's own answer.
                */}
                <small
                  className={
                    timerStateKnown(diagnostics?.backupTimer) &&
                    diagnostics?.backupTimer === 'off' &&
                    backupEvidence.attention
                      ? 'settings-attention'
                      : undefined
                  }
                >
                  {backupTimerLine(diagnostics?.backupTimer)}
                </small>
              </span>
            </div>
          )}
          <div>
            <span>
              <strong>Updates</strong>
              {/*
                What the box does on its own, read off the box rather than assumed.

                This row was static copy that told every owner to run `sudo athanor auto-update on`
                — including the ones who already had, who were being instructed to enable something
                already enabled and given no way to find out. The diagnostics route carried no timer
                state at all, which is what made a description stand in for a reading. It carries
                two now, and the third answer, "this host cannot say", is said as itself rather than
                collapsed into "off".
              */}
              <small>
                {/*
                  Which build is running, beside the command that changes it. An owner who runs
                  `sudo athanor update` had no way to see whether anything moved, and a bug report
                  had to start with a guess. One line where it is about something, not a panel.
                */}
                {diagnostics?.build ? (
                  <>
                    Running <code>{buildLabel(diagnostics.build)}</code>.{' '}
                  </>
                ) : null}
                {updateTimerLine(diagnostics?.autoUpdate)}
              </small>
              <small>
                Also on the server: <code>sudo athanor rollback</code> to undo a release that
                installed cleanly and still went wrong, <code>sudo athanor backup</code> for a copy
                on demand, and <code>sudo athanor doctor</code> for the full report.
              </small>
            </span>
          </div>
        </div>
        {/*
          Which box this app is talking to, on the packaged client only.

          It renders nothing in a browser — every route it calls is served by the shell's own
          loopback gateway — so mounting it here costs a browser owner nothing at all. On a
          packaged client it is the one thing this page could not previously say: which server the
          window is pointed at, and how to point it at a different one.
        */}
        <ConnectionRow serverBuild={diagnostics?.build} />
        <div className="privacy-boundary">
          <ShieldCheck />
          <span>
            athanor excludes prompts, files, screenshots, terminal output, and credentials from
            operational logs. External providers still apply their own policies.
          </span>
        </div>

        <div className="section-heading danger-heading">
          <TriangleAlert />
          <div>
            <strong>Leaving</strong>
            <span>
              Take everything with you, or remove the account entirely. Both are yours to do without
              asking anyone.
            </span>
          </div>
        </div>
        <button
          disabled={!workspace || busy}
          onClick={() =>
            void act(async () => {
              if (!workspace) return;
              await api.stepUp();
              /*
               * A sixth raw anchor, found while closing the five the wave-9 gate listed:
               * `api.downloadWorkspaceExport` builds one and returns void, and the line under it
               * then asserts "The archive is downloading" — which on a packaged client is a
               * sentence about something that did not happen. Handed to the same URL through the
               * same bridge instead, so the notice is only written when the shell took the file.
               * Still an anchor on a URL rather than a buffered blob, deliberately: a workspace
               * archive is arbitrarily large and the response carries its own content-disposition,
               * which is the reason the api.ts method gave for not fetching it into the tab.
               */
              if (
                await nativeBridge.saveFromUrl(
                  `athanor-workspace-${workspace.id}.tar.gz`,
                  `/v1/workspaces/${workspace.id}/export`
                )
              )
                setNotice('The archive is downloading. It contains working files and results.');
              else setError(DOWNLOAD_UNAVAILABLE_FILE);
            })
          }
        >
          <Download /> Download the agent computer
        </button>
        {/*
          Wipe the computer without wiping the account.

          The route has always been here — step-up, a typed name, the runner torn down and the row
          removed — and nothing called it, so the only way to start clean was to delete the whole
          account and enrol a passkey again from a pairing code. Two irreversible controls now sit
          together, which is the reason each of them names exactly what it takes.
        */}
        {workspace &&
          (deleteWorkspaceOpen ? (
            <div className="restore-confirmation danger-confirmation">
              <strong>Delete this computer and everything on it?</strong>
              <span>
                Working files, published results and the browser profile are removed, and the
                computer is torn down. Your account, conversations, memory and skills stay. Nothing
                on the computer can be restored afterwards — take a recovery point or download it
                first if you want a copy. Type <code>{workspace.name}</code> to continue.
              </span>
              <input
                value={deleteWorkspaceConfirmation}
                aria-label="Confirm the computer’s name"
                autoComplete="off"
                onChange={(event) => setDeleteWorkspaceConfirmation(event.target.value)}
              />
              <span className="modal-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setDeleteWorkspaceOpen(false);
                    setDeleteWorkspaceConfirmation('');
                  }}
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  disabled={
                    busy || !workspaceDeletionArmed(deleteWorkspaceConfirmation, workspace.name)
                  }
                  onClick={() =>
                    void act(async () => {
                      await api.stepUp();
                      await deleteWorkspaceRequest(
                        workspace.id,
                        deleteWorkspaceConfirmation.trim()
                      );
                      setDeleteWorkspaceOpen(false);
                      setDeleteWorkspaceConfirmation('');
                      setNotice(
                        'The computer is gone. athanor provisions a fresh one the next time you send a message.'
                      );
                    })
                  }
                >
                  <Trash2 /> Delete this computer
                </button>
              </span>
            </div>
          ) : (
            <button className="danger" onClick={() => setDeleteWorkspaceOpen(true)}>
              <Trash2 /> Delete this computer
            </button>
          ))}
        {deleteAccountOpen ? (
          <div className="restore-confirmation danger-confirmation">
            <strong>Delete this account and everything in it?</strong>
            <span>
              Conversations, memory, skills, connectors, recovery points and the agent computer's
              files are all removed. Nothing here can be restored afterwards. Type{' '}
              <code>{user.username}</code> to continue.
            </span>
            <input
              value={deleteAccountConfirmation}
              aria-label="Confirm your username"
              autoComplete="off"
              onChange={(event) => setDeleteAccountConfirmation(event.target.value)}
            />
            <span className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  setDeleteAccountOpen(false);
                  setDeleteAccountConfirmation('');
                }}
              >
                Cancel
              </button>
              <button
                className="danger"
                disabled={busy || !accountDeletionArmed(deleteAccountConfirmation, user.username)}
                onClick={() =>
                  void act(async () => {
                    await api.stepUp();
                    await api.deleteAccount(deleteAccountConfirmation.trim());
                    onLogout();
                  })
                }
              >
                <Trash2 /> Delete permanently
              </button>
            </span>
          </div>
        ) : (
          <button className="danger" onClick={() => setDeleteAccountOpen(true)}>
            <Trash2 /> Delete this account
          </button>
        )}
      </div>
    </Dialog>
  );
}
