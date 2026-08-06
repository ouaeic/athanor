import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

export interface CommandLimits {
  memoryBytes: number;
  fileBytes: number;
  processes: number;
  openFiles: number;
}

const GIB = 1024 ** 3;

/**
 * Half the box, floored at 1 GiB. A single agent command has no business taking memory the
 * database and the API also need, but a fixed number would either strangle a build on a large
 * server or be larger than the whole of a small one.
 */
export const defaultMemoryLimitBytes = (totalMemoryBytes: number): number =>
  Math.max(GIB, Math.floor(totalMemoryBytes / 2));

export const commandLimits = (
  config: {
    COMMAND_MEMORY_LIMIT_BYTES?: number | undefined;
    COMMAND_FILE_LIMIT_BYTES: number;
    COMMAND_PROCESS_LIMIT: number;
    COMMAND_OPEN_FILE_LIMIT: number;
  },
  totalMemoryBytes: number
): CommandLimits => ({
  memoryBytes: config.COMMAND_MEMORY_LIMIT_BYTES ?? defaultMemoryLimitBytes(totalMemoryBytes),
  fileBytes: config.COMMAND_FILE_LIMIT_BYTES,
  processes: config.COMMAND_PROCESS_LIMIT,
  openFiles: config.COMMAND_OPEN_FILE_LIMIT
});

/**
 * RLIMIT_DATA rather than RLIMIT_AS: since Linux 4.7 it also covers anonymous mmap, so it bounds
 * the memory a command actually commits. RLIMIT_AS would additionally count the multi-gigabyte
 * address-space reservations V8 and the Go runtime make before they allocate anything, and would
 * kill node and every Go binary on the box on sight.
 *
 * RLIMIT_NPROC counts every process of the runner's user, so it is deliberately well above what
 * ordinary work needs: it exists to make a fork bomb fail inside the offending command while the
 * runner itself, whose own limit is the higher one systemd sets, can still fork.
 */
export const commandLimitArguments = (limits: CommandLimits): string[] => [
  '--core=0',
  `--data=${limits.memoryBytes}`,
  `--fsize=${limits.fileBytes}`,
  `--nproc=${limits.processes}`,
  `--nofile=${limits.openFiles}`
];

export interface Invocation {
  executable: string;
  args: string[];
}

export const limitedInvocation = (
  invocation: Invocation,
  limits: CommandLimits | undefined,
  limiter: string | undefined
): Invocation =>
  limits && limiter
    ? {
        executable: limiter,
        args: [...commandLimitArguments(limits), '--', invocation.executable, ...invocation.args]
      }
    : invocation;

/**
 * prlimit ships with util-linux, which is an essential package on Debian and Ubuntu, so the
 * limiter is present on a stock host without anything extra being installed. Development machines
 * that are not Linux have no equivalent, and there the runner deliberately runs unlimited rather
 * than refusing to start.
 */
export const resolveCommandLimiter = async (candidate: string): Promise<string | undefined> => {
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
};
