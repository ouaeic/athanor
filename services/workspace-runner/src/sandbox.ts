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
  /**
   * Whether this box draws a filesystem boundary as well as an identity one.
   *
   * It lives on the sandbox rather than in each caller's options because it is a fact about the
   * host - the kernel has Landlock and the installer measured it - and not about any one command.
   * That is also what makes it reach both execution paths: the foreground route and the background
   * one each hand `prepareInvocation` this same object, and a boolean threaded through their two
   * separate option bags would have had to be added twice and would have been added once.
   *
   * Optional, and absent means unconfined. That is the safe direction for the omission to point
   * and the only direction it can point: nothing here can turn a boundary on by accident, and a
   * sandbox built without this field behaves exactly as every sandbox did before it existed. The
   * two constructors below always set it, and `resolveAgentSandbox` is the only one production
   * uses.
   */
  confineFilesystem?: boolean;
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

export const agentSandbox = (helper: string, confineFilesystem: boolean): AgentSandbox => ({
  elevate: SUDO_EXECUTABLE,
  helper,
  confineFilesystem
});

/**
 * Resolves the configured helper, refusing to start rather than silently running agent commands
 * as the runner's own account. A box that cannot sandbox has to say so.
 */
export const resolveAgentSandbox = async (
  helper: string | undefined,
  confineFilesystem = false
): Promise<AgentSandbox | undefined> => {
  if (!helper) return undefined;
  try {
    await access(helper, constants.X_OK);
  } catch {
    throw new Error(
      `AGENT_SANDBOX_HELPER points at ${helper}, which is not executable. Agent commands would run as the runner's own account, so the runner will not start.`
    );
  }
  return agentSandbox(helper, confineFilesystem);
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

/**
 * The word the helper reads where a root would go when there is no confinement to ask for. A word
 * rather than an omission because the helper's grammar is positional: were the root left out, the
 * first `NAME=VALUE` of the environment would land in its place and be read as one.
 */
const NO_CONFINEMENT_ROOT = '-';

/**
 * `confinementRoot` is the workspace the command may write in, or `null` for a command that must
 * not be confined at all. It is required rather than optional on purpose: this tree has four times
 * shipped a bound that a production call site walked straight past, and an optional argument is how
 * that happens. The only `null` in the runner is the workspace delete, which exists to remove the
 * very directory a ruleset would protect.
 *
 * Passing a root is a request, not a guarantee. A box whose installer found no Landlock says so on
 * the sandbox, and the helper is then asked for `open` and the command runs exactly as it did
 * before - which is the difference between a ladder and an outage.
 */
export const sandboxedInvocation = (
  invocation: Invocation,
  env: Record<string, string>,
  sandbox: AgentSandbox,
  isolateNetwork: boolean,
  confinementRoot: string | null
): Invocation => {
  assertSandboxableCommand(invocation);
  const confined = sandbox.confineFilesystem === true && confinementRoot !== null;
  return {
    executable: sandbox.elevate,
    args: [
      '-n',
      sandbox.helper,
      'run',
      isolateNetwork ? 'isolated' : 'network',
      confined ? 'confine' : 'open',
      confined ? confinementRoot : NO_CONFINEMENT_ROOT,
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
 *
 * It takes no confinement root and never will. This is the owner at their own computer, and a
 * ruleset here would stop them reading their own files from their own terminal while the file
 * browser hands them the same files two clicks away - a boundary paid for in ease of use and
 * bought nothing with. The helper's `shell` mode has no confine word for the same reason.
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
