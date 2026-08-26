export type SubscriptionAgent = 'codex' | 'claude' | 'opencode';

interface SubscriptionAgentRun {
  agent: SubscriptionAgent;
  prompt: string;
  sessionId?: string;
  maxTurns: number;
}

const CLAUDE_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

/** Every specialist this computer can hand a repository task to, in the order the schema offers. */
export const SUBSCRIPTION_AGENTS: readonly SubscriptionAgent[] = ['codex', 'claude', 'opencode'];

/**
 * The specialists whose CLI takes a turn bound.
 *
 * `coding_agent.maxTurns` is declared for all three and `buildSubscriptionAgentArgs` emits it on
 * one branch, so a model that bounded a risky refactor at three turns bounded nothing and the only
 * remaining stop was `timeoutSeconds`, up to an hour of somebody's subscription. Codex `exec` and
 * OpenCode `run` publish no equivalent flag, and inventing one would fail the run outright - so the
 * honest repair is for the schema to say who honours the field, and for that sentence to be
 * derived from this list rather than written a second time beside it.
 */
export const SUBSCRIPTION_AGENTS_HONOURING_MAX_TURNS: readonly SubscriptionAgent[] = ['claude'];

export const subscriptionAgentName = (agent: SubscriptionAgent): string => {
  if (agent === 'codex') return 'Codex';
  if (agent === 'claude') return 'Claude Code';
  return 'OpenCode';
};

export const subscriptionAgentExecutable = (agent: SubscriptionAgent): string => {
  if (agent === 'codex') return 'codex';
  if (agent === 'claude') return 'claude';
  return 'opencode';
};

export const subscriptionAgentPackage = (agent: SubscriptionAgent): string => {
  if (agent === 'codex') return '@openai/codex@latest';
  if (agent === 'claude') return '@anthropic-ai/claude-code@latest';
  return 'opencode-ai@latest';
};

export const subscriptionAgentLoginCommand = (agent: SubscriptionAgent): string => {
  if (agent === 'codex') return 'codex login';
  if (agent === 'claude') return 'claude';
  return 'opencode auth login';
};

export const subscriptionAgentStatusArgs = (agent: SubscriptionAgent): string[] => {
  if (agent === 'codex') return ['login', 'status'];
  if (agent === 'claude') return ['auth', 'status'];
  return ['auth', 'list'];
};

export const subscriptionAgentRunEnvironment = (
  agent: SubscriptionAgent
): Record<string, string> => {
  if (agent !== 'opencode') return {};
  return {
    OPENCODE_AUTO_SHARE: 'false',
    OPENCODE_PERMISSION: JSON.stringify({
      '*': 'allow',
      external_directory: 'deny',
      doom_loop: 'deny',
      question: 'deny',
      read: {
        '*': 'allow',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow'
      },
      bash: {
        '*': 'allow',
        'sudo *': 'deny',
        'su *': 'deny',
        'doas *': 'deny',
        'git push *': 'deny',
        'rm -rf *': 'deny',
        'rm -fr *': 'deny'
      }
    })
  };
};

export const buildSubscriptionAgentArgs = ({
  agent,
  prompt,
  sessionId,
  maxTurns
}: SubscriptionAgentRun): string[] => {
  if (agent === 'codex')
    return [
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      ...(sessionId ? ['resume', sessionId] : []),
      prompt
    ];

  if (agent === 'opencode')
    return [
      '--pure',
      'run',
      '--format',
      'json',
      '--auto',
      ...(sessionId ? ['--session', sessionId] : []),
      prompt
    ];

  return [
    '-p',
    ...(sessionId ? ['--resume', sessionId] : []),
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--permission-mode',
    'acceptEdits',
    '--tools',
    CLAUDE_TOOLS,
    '--allowedTools',
    CLAUDE_TOOLS,
    '--strict-mcp-config'
  ];
};
