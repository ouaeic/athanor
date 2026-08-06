export type SubscriptionAgent = 'codex' | 'claude' | 'opencode';

interface SubscriptionAgentRun {
  agent: SubscriptionAgent;
  prompt: string;
  sessionId?: string;
  maxTurns: number;
}

const CLAUDE_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';

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
