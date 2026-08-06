import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionAgentArgs,
  subscriptionAgentExecutable,
  subscriptionAgentLoginCommand,
  subscriptionAgentName,
  subscriptionAgentPackage,
  subscriptionAgentRunEnvironment,
  subscriptionAgentStatusArgs
} from './subscription-agent.js';

describe('subscription coding-agent commands', () => {
  it('builds a bounded, sandboxed Codex exec mission and resume', () => {
    expect(
      buildSubscriptionAgentArgs({
        agent: 'codex',
        prompt: 'Fix the test',
        sessionId: 'thread-id',
        maxTurns: 12
      })
    ).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'resume',
      'thread-id',
      'Fix the test'
    ]);
  });

  it('restricts Claude Code to the disclosed repository tools and disables project MCP', () => {
    const args = buildSubscriptionAgentArgs({
      agent: 'claude',
      prompt: 'Review the repository',
      maxTurns: 7
    });
    expect(args).toContain('stream-json');
    expect(args).toContain('acceptEdits');
    expect(args).toContain('Read,Edit,Write,Glob,Grep,Bash');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('runs OpenCode headlessly without external plugins or access outside the project', () => {
    const args = buildSubscriptionAgentArgs({
      agent: 'opencode',
      prompt: 'Fix the repository',
      sessionId: 'ses_one',
      maxTurns: 12
    });
    expect(args).toEqual([
      '--pure',
      'run',
      '--format',
      'json',
      '--auto',
      '--session',
      'ses_one',
      'Fix the repository'
    ]);
    const environment = subscriptionAgentRunEnvironment('opencode');
    expect(environment.OPENCODE_AUTO_SHARE).toBe('false');
    expect(JSON.parse(environment.OPENCODE_PERMISSION ?? '{}')).toMatchObject({
      external_directory: 'deny',
      question: 'deny'
    });
  });

  it('uses only the official publisher packages and login commands', () => {
    expect(subscriptionAgentName('codex')).toBe('Codex');
    expect(subscriptionAgentExecutable('codex')).toBe('codex');
    expect(subscriptionAgentPackage('codex')).toBe('@openai/codex@latest');
    expect(subscriptionAgentLoginCommand('codex')).toBe('codex login');
    expect(subscriptionAgentStatusArgs('codex')).toEqual(['login', 'status']);
    expect(subscriptionAgentName('claude')).toBe('Claude Code');
    expect(subscriptionAgentExecutable('claude')).toBe('claude');
    expect(subscriptionAgentPackage('claude')).toBe('@anthropic-ai/claude-code@latest');
    expect(subscriptionAgentLoginCommand('claude')).toBe('claude');
    expect(subscriptionAgentStatusArgs('claude')).toEqual(['auth', 'status']);
    expect(subscriptionAgentName('opencode')).toBe('OpenCode');
    expect(subscriptionAgentExecutable('opencode')).toBe('opencode');
    expect(subscriptionAgentPackage('opencode')).toBe('opencode-ai@latest');
    expect(subscriptionAgentLoginCommand('opencode')).toBe('opencode auth login');
    expect(subscriptionAgentStatusArgs('opencode')).toEqual(['auth', 'list']);
  });
});
