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
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  Save,
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
  type PasskeySummary
} from './account-security.js';
import { api, type ProviderSettings } from './api.js';
import { webSearchSummary } from './web-search-route.js';
import { spendLimitsDraft, spendLimitsPatch, type SpendLimitsDraft } from './usage-model.js';
import { securityModeCopy, securityModes } from './security-mode.js';
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
  Task,
  User,
  RelayReport,
  Workspace,
  WorkspaceMemory,
  WorkspaceSnapshot,
  WorkspaceSkill
} from './types.js';
import { formatBytes } from './timeline-state.js';
import { UsagePane } from './UsagePane.js';
import { relayAddress, relayHostProblem, relayQuotaNote, relayStatusLine } from './relay-state.js';

/*
  Four pages, each named after something the owner already wants to do. The previous six spent a
  whole navigation slot on one token field, filed "tell me when this finishes" under Security, and
  put the only filesystem undo below the licence line.
*/
export type SettingsPage = 'ai' | 'agent' | 'devices' | 'server';

const skillTemplate =
  '## When to use\n\nDescribe the trigger.\n\n## Procedure\n\n1. Describe the reliable steps.\n\n## Pitfalls\n\n- Describe common failures.\n\n## Verification\n\n- Describe how to prove the result.\n';

export function SelfHostedSettings({
  user,
  workspace,
  tasks,
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
  legal: Bootstrap['legal'];
  initialPage?: SettingsPage;
  onOpenTerminal: () => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
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
  const [spendLimitsForm, setSpendLimitsForm] = useState<SpendLimitsDraft>({
    dailyCapUsd: '',
    monthlyCapUsd: '',
    defaultTaskCapUsd: '',
    warnAtPercent: '80',
    // The owner's own zone is the only sensible default for "today"; the server accepts any IANA id.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  });
  const [relay, setRelay] = useState<RelayReport | null>();
  const [diagnostics, setDiagnostics] = useState<{
    certificate: { failedAt: string; reason: string } | null;
    dynamicDns: { failedAt: string; reason: string } | null;
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
  const [enrollment, setEnrollment] =
    useState<{ id: string; expiresAt: string; uri: string; webUri: string }>();
  const [enrollmentQr, setEnrollmentQr] = useState('');
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountConfirmation, setDeleteAccountConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadProvider = () =>
    void api
      .provider()
      .then((value) => {
        setProvider(value);
        setProviderKind(value.provider);
        setProviderUrl(value.baseUrl);
        setModelId(value.modelId ?? '');
        setZdr(value.enforceZeroDataRetention);
      })
      .catch(() => setProvider(undefined));
  const loadKnowledge = () => {
    if (!workspace) return;
    void Promise.all([api.memories(workspace.id), api.skills(workspace.id)])
      .then(([nextMemories, nextSkills]) => {
        setMemories(nextMemories);
        setSkills(nextSkills);
      })
      .catch(() => undefined);
  };
  const loadSpendLimits = () =>
    void api
      .spendLimits()
      .then((limits) => setSpendLimitsForm(spendLimitsDraft(limits)))
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
      })
      .catch(() => undefined);
  };
  const loadSnapshots = () => {
    if (!workspace) return;
    void api
      .workspaceSnapshots(workspace.id)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  };

  useEffect(() => {
    loadProvider();
    loadSpendLimits();
    loadKnowledge();
    loadBrief();
    loadSecurity();
    loadSnapshots();
  }, [workspace?.id]);
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

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      setError(securityActionMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = () =>
    act(async () => {
      await api.stepUp();
      const saved = await api.saveProvider({
        provider: providerKind,
        ...(providerKind !== 'openrouter' ? { modelId } : {}),
        ...(providerKind === 'openai-compatible' ? { baseUrl: providerUrl } : {}),
        ...(providerKey ? { apiKey: providerKey } : {}),
        enforceZeroDataRetention: zdr,
        contextTokens,
        capabilities: ['chat', 'tools', 'reasoning', ...(vision ? (['vision'] as const) : [])],
        modalities: ['text', ...(vision ? (['image'] as const) : [])]
      });
      setProvider(saved);
      setProviderKey('');
      setNotice('Provider verified and saved. The key is encrypted and will not be shown again.');
    });

  const exportData = () =>
    act(async () => {
      await api.stepUp();
      const data = await api.privacyExport();
      const href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      );
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `athanor-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(href);
    });

  const pages: Array<{ id: SettingsPage; label: string }> = [
    { id: 'ai', label: 'AI' },
    { id: 'agent', label: 'Agent' },
    { id: 'devices', label: 'Devices & security' },
    { id: 'server', label: 'Server' }
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
          {providerKind !== 'openrouter' && (
            <>
              <label>
                Model ID
                <input value={modelId} onChange={(event) => setModelId(event.target.value)} />
              </label>
              <label>
                Context window
                <input
                  type="number"
                  min={4096}
                  max={10_000_000}
                  value={contextTokens}
                  onChange={(event) => setContextTokens(Number(event.target.value))}
                />
              </label>
            </>
          )}
        </div>
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
        {webSearchSummary(provider?.webSearch).map((line) => (
          <p className="web-search-route" key={line.scope || 'both'}>
            {line.scope ? <strong>{line.scope}</strong> : null}
            <span>{line.disclosure}</span>
            {line.reason ? <small>{line.reason}</small> : null}
          </p>
        ))}
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
              (providerKind !== 'openrouter' && !modelId) ||
              (providerKind === 'openai-compatible' && !providerUrl)
            }
            onClick={() => void saveProvider()}
          >
            <ShieldCheck /> {busy ? 'Verifying…' : 'Verify and save'}
          </button>
        </div>
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
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const patch = spendLimitsPatch(spendLimitsForm);
              if (!patch.ok) throw new Error(patch.message);
              const saved = await api.updateSpendLimits(patch.body);
              setSpendLimitsForm(spendLimitsDraft(saved));
              setNotice('Spending caps saved. Work stops before it crosses them.');
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
        {workspace && <UsagePane workspace={workspace} tasks={tasks} onOpenTask={onOpenTask} />}
        <hr />
        <div className="section-heading compact">
          <Code2 />
          <div>
            <strong>Coding agents you already pay for</strong>
            <span>
              Sign in to Codex, Claude Code or OpenCode with their own CLI and athanor hands
              repository work to them. Your subscription tokens never enter a conversation.
            </span>
          </div>
        </div>
        {/* One button, not three: every row sent the owner to the same terminal, and the three
            copies of it read as three different destinations. */}
        <div className="settings-list coding-agent-list">
          <div>
            <span>
              <strong>OpenAI Codex</strong>
              <small>
                Ask athanor to install Codex, then run <code>codex login</code>. Codex sessions,
                sandbox output, and repository changes stay on this computer.
              </small>
            </span>
          </div>
          <div>
            <span>
              <strong>Anthropic Claude Code</strong>
              <small>
                Ask athanor to install Claude Code, then run <code>claude</code> and choose Claude
                Pro or Max. The official CLI owns its authentication.
              </small>
            </span>
          </div>
          <div>
            <span>
              <strong>OpenCode</strong>
              <small>
                Ask athanor to install OpenCode, then run <code>opencode auth login</code>. OpenCode
                supports ChatGPT Plus, GitHub Copilot, GitLab Duo, and provider keys. Claude Pro/Max
                stays on the official Claude Code path above.
              </small>
            </span>
          </div>
        </div>
        <button className="secondary" onClick={onOpenTerminal}>
          Open Terminal
        </button>
        <div className="privacy-boundary">
          <LockKeyhole />
          <span>
            <strong>One safety policy</strong>
            {' · '}athanor shows the specialist mission for approval, bounds its runtime, keeps it
            in the workspace, and returns one compact result to the main conversation. Strict
            zero-retention tasks never route through subscription CLIs because their publisher
            policies are separate.
          </span>
        </div>
      </div>

      <div className="settings-section knowledge-settings" hidden={page !== 'agent'}>
        <div className="section-heading">
          <ShieldCheck />
          <div>
            <strong>How the agent asks</strong>
            {/* The words come from the table the control itself reads, so this page and the shield
                in the composer cannot describe the same three settings differently. */}
            <span>Set per conversation from the shield in the composer.</span>
          </div>
        </div>
        <div className="settings-list">
          {securityModes.map((mode) => (
            <div key={mode}>
              <span>
                <strong>{securityModeCopy[mode].label}</strong>
                <small>{securityModeCopy[mode].description}</small>
              </span>
            </div>
          ))}
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
            <select
              value={memoryTarget}
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
        </div>
        <button
          disabled={!workspace || !memory.trim() || busy}
          onClick={() =>
            void act(async () => {
              if (!workspace) return;
              await api.addMemory(workspace.id, { target: memoryTarget, content: memory.trim() });
              setMemory('');
              loadKnowledge();
            })
          }
        >
          <Plus /> Add memory
        </button>
        <div className="settings-list">
          {memories.map((item) => (
            <div key={item.id}>
              <span>
                <strong>
                  {item.target === 'user' ? 'You' : 'Computer'}
                  {item.status === 'expired' ? ' · expired' : ''}
                </strong>
                <small>{item.content}</small>
                {item.validUntil && (
                  <small>
                    {item.status === 'expired' ? 'Stopped being used' : 'Used until'}{' '}
                    {new Date(item.validUntil).toLocaleString()}
                  </small>
                )}
              </span>
              <button
                className="icon-btn"
                aria-label="Delete memory"
                onClick={() => {
                  if (!workspace) return;
                  setMemories((current) => current.filter((entry) => entry.id !== item.id));
                  undo({
                    message: 'Memory deleted',
                    commit: () => api.deleteMemory(workspace.id, item.id),
                    restore: loadKnowledge
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
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
        <div className="settings-list">
          {skills.map((item) => (
            <div key={item.id}>
              {/* Saving by name is an upsert, so opening a skill into the editor above is the whole
                  edit path. The list was previously delete-only: the agent could write a procedure
                  the owner could read no part of and fix no part of. */}
              <button
                className="settings-list-open"
                title={`Open the ${item.name} skill`}
                onClick={() => {
                  setSkillName(item.name);
                  setSkillDescription(item.description);
                  setSkillContent(item.content);
                }}
              >
                <strong>{item.name}</strong>
                <small>
                  {item.description}
                  {item.status === 'active' ? '' : ` · ${item.status}`}
                  {item.useCount > 0
                    ? ` · used ${item.useCount} ${item.useCount === 1 ? 'time' : 'times'}`
                    : ' · never used yet'}
                </small>
              </button>
              <button
                className="icon-btn"
                aria-label={`Delete the ${item.name} skill`}
                onClick={() => {
                  if (!workspace) return;
                  setSkills((current) => current.filter((entry) => entry.id !== item.id));
                  undo({
                    message: `Deleted the “${item.name}” skill`,
                    commit: () => api.deleteSkill(workspace.id, item.id),
                    restore: loadKnowledge
                  });
                }}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
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
            <span>
              Scan this from the new device. The link works once, expires in ten minutes, and never
              carries the installer&rsquo;s pairing code.
            </span>
          </div>
        </div>
        {enrollment ? (
          <div className="enrollment-card">
            {enrollmentQr && <img src={enrollmentQr} alt="Device enrollment code" />}
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
                  })
                }
              >
                <X /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api.stepUp();
                const created = await api.createEnrollment('New device');
                setEnrollment(created);
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
        )}

        <div className="section-heading">
          <BellRing />
          <div>
            <strong>Notifications on this device</strong>
            <span>
              {pushState === 'unsupported'
                ? 'This browser cannot receive push notifications.'
                : pushState === 'unavailable'
                  ? 'The server has no push key configured, so notifications are off.'
                  : pushState === 'denied'
                    ? 'This browser blocked notifications. Allow them in site settings first.'
                    : 'Tell me when a long task finishes or needs approval, even with athanor closed.'}
            </span>
          </div>
        </div>
        <button
          disabled={
            busy || ['checking', 'unsupported', 'unavailable', 'denied'].includes(pushState)
          }
          onClick={() =>
            void act(async () => {
              setPushState(
                pushState === 'enabled' ? await disableNotifications() : await enableNotifications()
              );
            })
          }
        >
          <BellRing />
          {pushState === 'enabled' ? 'Turn off notifications' : 'Turn on notifications'}
        </button>
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
                  onClick={() => {
                    setSessions((current) => current.filter((entry) => entry.id !== item.id));
                    undo({
                      message: `Signed out ${item.deviceLabel}`,
                      commit: () => api.revokeSession(item.id),
                      restore: loadSecurity
                    });
                  }}
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
              The one way back in if every passkey is gone. Issuing a new one retires the old
              immediately, so do it if the file you saved is lost, shared, or somewhere you no
              longer trust.
            </span>
          </div>
        </div>
        {reissuedRecoveryCode ? (
          <div className="enrollment-card">
            <code>{reissuedRecoveryCode}</code>
            <span>Shown once. The previous code no longer works.</span>
            <div className="enrollment-actions">
              <CopyButton value={reissuedRecoveryCode} label="Copy code" />
              <button
                className="secondary"
                onClick={() => {
                  const file = recoveryFile(reissuedRecoveryCode);
                  const href = URL.createObjectURL(new Blob([file.text], { type: file.type }));
                  const anchor = document.createElement('a');
                  anchor.href = href;
                  anchor.download = file.name;
                  anchor.click();
                  URL.revokeObjectURL(href);
                }}
              >
                <Download /> Download
              </button>
              <button onClick={() => setReissuedRecoveryCode('')}>
                <Check /> I have saved it
              </button>
            </div>
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
          {!snapshots.length && (
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
                {new Date(diagnostics.certificate.failedAt).toLocaleDateString()}. Until it
                succeeds this stays reachable, and when the current certificate expires every
                device will refuse to connect. On the server:{' '}
                <code>sudo athanor certificate renew</code>.
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
            {workspace && ['failed', 'hibernated'].includes(workspace.status) && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.workspaceAction(workspace.id, 'resume');
                    setNotice('Starting the agent computer. It is usable again in a few seconds.');
                  })
                }
              >
                <RotateCcw /> Start it again
              </button>
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
                {legal.sourceUrl ? 'source is always available' : 'the source of this build is in /opt/athanor on this server'}
              </small>
            </span>
            {legal.sourceUrl && (
              <a href={legal.sourceUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            )}
          </div>
          <div>
            <span>
              <strong>Backups and updates</strong>
              {/*
                What the box does on its own, then what to type if you want to intervene. This read
                as three commands and nothing else, which told an owner that keeping their server
                current was their job and their shell's - when unattended updates back up first,
                verify the new release is serving, and roll themselves back if it is not.
              */}
              <small>
                Updates install themselves weekly, taking a verified backup first and rolling back
                if the new release does not serve. To intervene, on the server:{' '}
                <code>sudo athanor update</code> now, <code>sudo athanor rollback</code> to undo a
                release that installed cleanly and still went wrong, <code>sudo athanor backup</code>{' '}
                for a copy on demand, and <code>sudo athanor doctor</code> for the full report.
              </small>
            </span>
          </div>
        </div>
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
              api.downloadWorkspaceExport(workspace.id);
              setNotice('The archive is downloading. It contains working files and results.');
            })
          }
        >
          <Download /> Download the agent computer
        </button>
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
