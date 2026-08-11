import { describe, expect, it } from 'vitest';
import {
  isLive,
  processCommand,
  processElapsed,
  processState,
  runningOrder
} from './running-rows.js';
import type { BackgroundProcess } from './types.js';

const START = '2026-08-10T09:00:00.000Z';
const startedMs = Date.parse(START);

const process = (overrides: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  sessionId: 'proc_00000000-0000-4000-8000-000000000001',
  status: 'running',
  command: ['/usr/local/bin/node', 'server.js'],
  startedAt: START,
  ...overrides
});

describe('what a background process is called', () => {
  it('keeps the arguments and drops the path nobody reads', () => {
    expect(processCommand(['/usr/local/bin/node', 'server.js', '--port', '3000'])).toBe(
      'node server.js --port 3000'
    );
  });

  it('leaves a bare command alone', () => {
    expect(processCommand(['pnpm', 'dev'])).toBe('pnpm dev');
  });

  // An argument list is capped at 100 kB per argument on the runner, so a row has to bound itself.
  it('bounds a command too long to be a row', () => {
    const line = processCommand(['node', '-e', 'x'.repeat(400)]);
    expect(line.length).toBeLessThanOrEqual(96);
    expect(line.endsWith('…')).toBe(true);
  });

  it('says something rather than nothing for an empty command', () => {
    expect(processCommand([])).toBe('Unnamed process');
  });
});

describe('how long it has run', () => {
  it('counts up while it is alive', () => {
    expect(processElapsed(process(), startedMs + 8_000)).toBe('8s');
    expect(processElapsed(process(), startedMs + 252_000)).toBe('4m 12s');
    expect(processElapsed(process(), startedMs + 240_000)).toBe('4m');
    expect(processElapsed(process(), startedMs + 7_500_000)).toBe('2h 05m');
  });

  /*
   * A finished session is a fixed span, and the clock passed in must not touch it: an hour spent
   * looking at the panel would otherwise keep growing the runtime of a command that ended at once.
   */
  it('freezes once the process is over, whatever the clock says', () => {
    const finished = process({
      status: 'completed',
      exitCode: 0,
      finishedAt: '2026-08-10T09:00:12.000Z'
    });
    expect(processElapsed(finished, startedMs + 12_000)).toBe('ran 12s');
    expect(processElapsed(finished, startedMs + 3_600_000)).toBe('ran 12s');
  });

  it('says nothing rather than NaN when the timestamp is unreadable', () => {
    expect(processElapsed(process({ startedAt: 'not a date' }), startedMs)).toBe('');
  });
});

describe('what became of a process', () => {
  it('reports the exit code rather than the stored enum', () => {
    expect(processState(process({ status: 'completed', exitCode: 0 }))).toBe('Exited 0');
    expect(processState(process({ status: 'failed', exitCode: 1 }))).toBe('Exited 1');
  });

  it('names the signal when something killed it', () => {
    expect(processState(process({ status: 'failed', exitCode: null, signal: 'SIGSEGV' }))).toBe(
      'Killed by SIGSEGV'
    );
  });

  /*
   * A command that never started - a missing executable - settles as failed with a null exit code
   * and no signal. "Exited null" is the shape of that record, not a fact about the machine.
   */
  it('says a command never started instead of printing a null exit code', () => {
    expect(processState(process({ status: 'failed', exitCode: null }))).toBe('Never started');
  });

  it('keeps the two endings the owner did not cause apart from an exit', () => {
    expect(processState(process({ status: 'timed_out', exitCode: null, signal: 'SIGTERM' }))).toBe(
      'Timed out'
    );
    expect(processState(process({ status: 'stopped', exitCode: null, signal: 'SIGTERM' }))).toBe(
      'Stopped'
    );
  });

  it('marks only a running session as alive', () => {
    expect(isLive(process())).toBe(true);
    expect(isLive(process({ status: 'completed', exitCode: 0 }))).toBe(false);
  });
});

describe('the order the rows are read in', () => {
  it('puts what is running above what has finished, newest first', () => {
    const rows = runningOrder([
      process({ sessionId: 'old-done', status: 'completed', exitCode: 0, startedAt: START }),
      process({ sessionId: 'older-live', startedAt: '2026-08-10T08:00:00.000Z' }),
      process({
        sessionId: 'new-done',
        status: 'failed',
        exitCode: 1,
        startedAt: '2026-08-10T09:30:00.000Z'
      }),
      process({ sessionId: 'newest-live', startedAt: '2026-08-10T09:59:00.000Z' })
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual([
      'newest-live',
      'older-live',
      'new-done',
      'old-done'
    ]);
  });

  it('leaves the array it was given alone', () => {
    const rows = [
      process({ sessionId: 'a', status: 'completed', exitCode: 0 }),
      process({ sessionId: 'b' })
    ];
    runningOrder(rows);
    expect(rows.map((row) => row.sessionId)).toEqual(['a', 'b']);
  });
});
