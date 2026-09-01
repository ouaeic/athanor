import { z } from 'zod';

const Config = z.object({
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().positive().default(4300),
  RUNNER_SHARED_SECRET: z.string().min(32),
  WORKSPACE_ROOT: z.string().default('.athanor/workspaces'),
  TAR_EXECUTABLE: z.string().default('/usr/bin/tar'),
  SNAPSHOT_EXECUTABLE: z.string().default('/usr/local/lib/athanor/athanor-snapshot'),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  // On by default: run the browser on the workspace's own X server rather than headless. Headless
  // Chromium tells every site it has no hover and a coarse pointer, so responsive pages serve it
  // a phone layout while its user agent says desktop - which changes what the agent can even see
  // to click. On a host with no desktop runtime, or with this off, it falls back to headless.
  BROWSER_USE_DESKTOP_DISPLAY: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  DESKTOP_BRIDGE_EXECUTABLE: z.string().optional(),
  DESKTOP_SESSION_EXECUTABLE: z.string().optional(),
  SYSTEM_PACKAGE_HELPER: z.string().optional(),
  // Root-owned, outside every directory on the agent's PATH. Left unset - a developer's laptop,
  // where there is no second account to drop to - agent commands run as the runner's own user
  // and the runner says so rather than pretending otherwise.
  AGENT_SANDBOX_HELPER: z.string().optional(),
  // The FOREGROUND ceiling, and the only one of the two that is about this process rather than
  // about the work. A foreground command holds an HTTP request open in the worker for its whole
  // run and blocks the turn behind it, so the hour here is chosen to sit just inside
  // `TOOL_REQUEST_TIMEOUT_MS` in apps/worker/src/runner-client.ts, which is 3,900 s. What would
  // change it: moving that number too, in the same commit. A run that wants longer than this does
  // not want to be in the foreground at all, and `execute` says so by name rather than clamping.
  MAX_EXECUTION_SECONDS: z.coerce.number().int().positive().default(3600),
  /*
   * The BACKGROUND ceiling. Nothing holds a request open on that path - the start call returns a
   * session id - so the hour it used to share with the foreground was never about a resource, and
   * it was the number that made a six-hour alignment or a variant-calling run impossible to ask
   * for. CHOSEN as a day, to agree exactly with the 86,400 the request schemas on both paths have
   * always accepted and no caller could ever reach: a ceiling the declaration allows and the
   * enforcement refuses is the worst of both, and this is the half that was wrong.
   *
   * A day rather than none at all because a background session with no deadline is a service, and
   * a service is a different thing with its own record, its own restart policy and its own way for
   * the owner to see it. What would change it: a job that legitimately runs longer than a day,
   * which on this box is a reason to declare a service, not to raise this.
   */
  MAX_BACKGROUND_SECONDS: z.coerce.number().int().positive().default(86_400),
  // prlimit is part of util-linux, an essential package, so it is present on every stock
  // Debian and Ubuntu host without anything being installed for athanor's benefit.
  RESOURCE_LIMIT_EXECUTABLE: z.string().default('/usr/bin/prlimit'),
  // A bare name rather than a path, which is the one spelling everything else in athanor uses for
  // this: the installer puts a compatibility command on PATH where the release only packages the
  // older ImageMagick, and the toolchain probe and the skills both name it this way. The package
  // table already installs it for image work, so a photograph the owner wants looked at is
  // converted by the toolchain that is on the box rather than by a dependency added for one format.
  IMAGE_CONVERT_EXECUTABLE: z.string().default('magick'),
  // Left unset the ceiling is derived from the host's own memory, because a number that suits a
  // 32 GiB server would be larger than the whole of a 2 GiB one.
  COMMAND_MEMORY_LIMIT_BYTES: z.coerce.number().int().positive().optional(),
  // There is deliberately no COMMAND_FILE_LIMIT_BYTES. It was 4 GiB, it was the first ceiling the
  // owner's own work reached, and it killed mutely; limits.ts states why a per-file rlimit was the
  // wrong instrument and what the host-disk floor covers instead. A host that still has the key in
  // its runner.env is unaffected - unknown keys are stripped here - rather than refused a start.
  COMMAND_PROCESS_LIMIT: z.coerce.number().int().positive().default(1024),
  COMMAND_OPEN_FILE_LIMIT: z.coerce.number().int().positive().default(4096),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  // Turn checkpoints. Both tools are probed by using them, never by assuming a mount is what it
  // looks like, so a path that does not exist on this host simply means that mechanism is not
  // offered. dpkg's database is read to tell the owner which packages a rewind will not remove.
  CHECKPOINT_BTRFS_EXECUTABLE: z.string().default('/usr/bin/btrfs'),
  CHECKPOINT_ZFS_EXECUTABLE: z.string().default('/usr/sbin/zfs'),
  CHECKPOINT_PACKAGE_MANIFEST: z.string().default('/var/lib/dpkg/status'),
  // Off by default: the profile holds the session cookie for every site the owner has signed into,
  // and rewinding a morning's work should not sign them out of all of them.
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  CHECKPOINT_RETAIN_TURNS: z.coerce.number().int().min(1).max(500).default(20),
  CHECKPOINT_RETAIN_DAILY_DAYS: z.coerce.number().int().min(0).max(3650).default(14),
  CHECKPOINT_MAX_FILES: z.coerce.number().int().min(1000).default(250_000),
  // A file this large is a disk image or a dataset. Holding a second copy of one per turn is not a
  // cheap checkpoint, so it is left out and the preview says so rather than pretending otherwise.
  CHECKPOINT_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 ** 3),
  // Every loopback port this installation already serves something private on. Publishing a
  // preview points the public internet at a loopback port, so these are told to the runner rather
  // than guessed: the API, the preview gateway and the database are configurable, and the runner's
  // own port is added to whatever arrives here. One spelling across both processes and the
  // installer: this was named the other way round here for a while, three lines from the API's
  // version of the same idea, which is a trap for whoever next moves a port.
  RESERVED_PREVIEW_PORTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((port) => Number.isInteger(port) && port > 0)
    ),
  // Off by default because a command in its own network namespace cannot be reached over
  // loopback either, and that is how a published preview serves the port a command is listening
  // on. Turning it on needs the sandbox helper: an unprivileged process cannot create a network
  // namespace, so without it the setting used to make every command fail instead of isolating.
  ISOLATE_AGENT_NETWORK: z
    .string()
    .default('false')
    .transform((value) => value === 'true')
});

export type RunnerConfig = z.infer<typeof Config>;

/**
 * Secrets are read once and removed from the environment. An agent command that reaches the
 * runner's process - through /proc, a core file, or anything that reads it back - must not find
 * the capability signing key there: with it, a command mints its own tokens for any workspace.
 */
const SECRET_KEYS = ['RUNNER_SHARED_SECRET'] as const;

export const loadConfig = (): RunnerConfig => {
  const config = Config.parse(process.env);
  for (const key of SECRET_KEYS) delete process.env[key];
  if (config.ISOLATE_AGENT_NETWORK && !config.AGENT_SANDBOX_HELPER) {
    throw new Error(
      'ISOLATE_AGENT_NETWORK is on but AGENT_SANDBOX_HELPER is unset. Creating a network namespace needs privilege the runner does not have, so every command would fail rather than run isolated.'
    );
  }
  return config;
};
