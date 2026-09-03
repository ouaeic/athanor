import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * A spawn that fails is an error event, and an error event nobody listens for KILLS THIS PROCESS.
 *
 * Measured on the box. A turn asked the desktop to open `gedit`, which is not installed, and the
 * workspace runner died - not the call, the runner - with `Error: spawn gedit ENOENT` under Node's
 * own `throw er; // Unhandled 'error' event`. It came back under `Restart=always` and the turn
 * asked again, five times over, so every other task on the machine lost its runner three times for
 * a missing text editor. `NRestarts=5`.
 *
 * `ChildProcess` is an EventEmitter, and an EventEmitter with no `error` listener rethrows the
 * event as an uncaught exception. Every `spawn` in this service therefore needs one, whether or not
 * the executable is expected to exist: the hot paths spawn the sandbox helper through sudo, and
 * "sudo is missing" should be a failed command, not a dead service.
 *
 * Node still emits `close` after a spawn error, so attaching this changes nothing else - whatever
 * promise the call site already settles on still settles. This only stops the throw and remembers
 * why, so the caller can say something better than "it exited non-zero".
 */
export const captureSpawnFailure = (
  child: ChildProcess
): (() => NodeJS.ErrnoException | undefined) => {
  let failure: NodeJS.ErrnoException | undefined;
  child.once('error', (cause: Error) => {
    failure = cause as NodeJS.ErrnoException;
  });
  return () => failure;
};

/**
 * What to tell the owner about a program that would not start.
 *
 * ENOENT is its own sentence because it is the common one and it has an action in it: the program
 * is not on this computer. Everything else carries the system's own words, which are more use than
 * a paraphrase.
 */
export const spawnFailureMessage = (executable: string, failure: NodeJS.ErrnoException): string => {
  const name = path.basename(executable);
  if (failure.code === 'ENOENT')
    return `${name} is not installed on this computer, so there was nothing to start. Install it first, or use a program that is already here.`;
  if (failure.code === 'EACCES')
    return `${name} is on this computer but this account may not run it.`;
  return `${name} could not be started: ${failure.message}`;
};
