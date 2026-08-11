/**
 * A background process, said the way the owner of the computer would say it.
 *
 * The runner reports a session as an executable, an argument list, a status, two timestamps and an
 * exit code (services/workspace-runner/src/processes.ts). None of that is a sentence, and the panel
 * that shows it has to answer three questions per row without asking anyone to read a field name:
 * what it is, how long it has been going, and whether it is still going. Kept out of the component
 * because these are the parts worth pinning with tests.
 */
import type { BackgroundProcess } from './types.js';

/** Long enough for `node server.js --port 3000`; short enough not to wrap a narrow panel twice. */
const COMMAND_LIMIT = 96;

/**
 * What the process is.
 *
 * The executable arrives resolved against the workspace's search path, so it is very often an
 * absolute path to something whose last segment is the only part anyone recognises - nobody reads
 * `/usr/local/bin/node` as anything other than "node". Arguments are left exactly as given, because
 * that is where the difference between two `node` processes lives.
 */
export const processCommand = (command: string[]): string => {
  const [executable, ...args] = command;
  if (!executable) return 'Unnamed process';
  const name = executable.split('/').filter(Boolean).pop() ?? executable;
  const line = [name, ...args].join(' ').trim();
  return line.length > COMMAND_LIMIT ? `${line.slice(0, COMMAND_LIMIT - 1)}…` : line;
};

const duration = (milliseconds: number): string => {
  const total = Math.max(0, Math.round(milliseconds / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

/** Whether the machine is still doing this. The one thing on the row that earns the warm colour. */
export const isLive = (process: BackgroundProcess): boolean => process.status === 'running';

/**
 * How long it has run: counting up while it is alive, and a fixed span once it is over.
 *
 * A clock the caller passes in rather than reads, so the same second can be asserted against.
 */
export const processElapsed = (process: BackgroundProcess, nowMs: number): string => {
  const startedAt = Date.parse(process.startedAt);
  if (Number.isNaN(startedAt)) return '';
  const finishedAt = process.finishedAt ? Date.parse(process.finishedAt) : Number.NaN;
  return Number.isNaN(finishedAt)
    ? duration(nowMs - startedAt)
    : `ran ${duration(finishedAt - startedAt)}`;
};

/**
 * What became of it.
 *
 * A finished process says what it exited with, because "completed" and "failed" are the stored enum
 * and neither one tells the owner whether their build passed. The exit code is the fact; the status
 * only decides which fact is worth printing. A session that never started at all - a missing
 * executable, an unexecutable file - settles as failed with a null code and no signal, and saying
 * "Exited null" for that would be worse than useless.
 */
export const processState = (process: BackgroundProcess): string => {
  if (process.status === 'running') return 'Running';
  if (process.status === 'timed_out') return 'Timed out';
  if (process.status === 'stopped') return 'Stopped';
  if (typeof process.exitCode === 'number') return `Exited ${process.exitCode}`;
  if (process.signal) return `Killed by ${process.signal}`;
  return 'Never started';
};

/**
 * Live first, then the most recently started.
 *
 * The runner returns its session table in insertion order, which puts an hour-old finished command
 * above the server that started thirty seconds ago. The pane exists to answer "right now", so what
 * is running has to be at the top of it, and among equals the newest is the one being waited on.
 */
export const runningOrder = (processes: BackgroundProcess[]): BackgroundProcess[] =>
  [...processes].sort((left, right) => {
    if (isLive(left) !== isLive(right)) return isLive(left) ? -1 : 1;
    return (Date.parse(right.startedAt) || 0) - (Date.parse(left.startedAt) || 0);
  });
