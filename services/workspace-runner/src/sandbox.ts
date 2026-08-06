import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { Invocation } from './limits.js';

/**
 * The privileged half of the agent sandbox. Running a command as a different Unix account needs
 * privilege the runner deliberately does not have, so it asks a root-owned helper for it through
 * sudo. The helper only ever removes privilege, which is why it can accept a command line the
 * agent influenced.
 */
export interface AgentSandbox {
  /** The set-user-ID binary that reaches the helper. Only the runner's account may use it. */
  elevate: string;
  /** Absolute path of the root-owned helper, outside every directory on the agent's PATH. */
  helper: string;
}

const SUDO_EXECUTABLE = '/usr/bin/sudo';

/**
 * The environment is handed over as arguments because sudo resets it, and reconstructing it
 * through sudoers `env_keep` would put the same values in a file the runner does not own. None
 * of them is secret: the runner sets PATH, HOME and LANG, and everything else has already been
 * filtered down to locale and terminal settings the agent asked for.
 */
const environmentArguments = (env: Record<string, string>): string[] =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);

export const agentSandbox = (helper: string): AgentSandbox => ({
  elevate: SUDO_EXECUTABLE,
  helper
});

/**
 * Resolves the configured helper, refusing to start rather than silently running agent commands
 * as the runner's own account. A box that cannot sandbox has to say so.
 */
export const resolveAgentSandbox = async (
  helper: string | undefined
): Promise<AgentSandbox | undefined> => {
  if (!helper) return undefined;
  try {
    await access(helper, constants.X_OK);
  } catch {
    throw new Error(
      `AGENT_SANDBOX_HELPER points at ${helper}, which is not executable. Agent commands would run as the runner's own account, so the runner will not start.`
    );
  }
  return agentSandbox(helper);
};

/**
 * `env -i` reads leading `NAME=VALUE` arguments as assignments and stops at the first argument
 * without an equals sign, so an executable path containing one would be swallowed as an
 * assignment. No real program path has one, and refusing is cheaper than a second delimiter.
 */
export const assertSandboxableCommand = (invocation: Invocation): void => {
  if (invocation.executable.includes('='))
    throw new Error('An executable path may not contain an equals sign');
};

export const sandboxedInvocation = (
  invocation: Invocation,
  env: Record<string, string>,
  sandbox: AgentSandbox,
  isolateNetwork: boolean
): Invocation => {
  assertSandboxableCommand(invocation);
  return {
    executable: sandbox.elevate,
    args: [
      '-n',
      sandbox.helper,
      'run',
      isolateNetwork ? 'isolated' : 'network',
      ...environmentArguments(env),
      invocation.executable,
      ...invocation.args
    ]
  };
};

/**
 * The owner's interactive terminal takes a different helper mode for one reason: the sudoers
 * policy gives that mode a pseudo-terminal. Without one the shell has no controlling terminal of
 * its own and loses job control, so ^Z and ^C stop behaving like a terminal.
 */
export const sandboxedShell = (
  invocation: Invocation,
  env: Record<string, string>,
  sandbox: AgentSandbox
): Invocation => {
  assertSandboxableCommand(invocation);
  return {
    executable: sandbox.elevate,
    args: [
      '-n',
      sandbox.helper,
      'shell',
      ...environmentArguments(env),
      invocation.executable,
      ...invocation.args
    ]
  };
};
