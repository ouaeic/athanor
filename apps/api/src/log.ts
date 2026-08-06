import { AthanorError, redactText } from '@athanor/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogThreshold = LogLevel | 'silent';

const levelRank: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

/**
 * Server logs exist so the owner can tie a failure report back to what the process did, and for
 * nothing else. Prompts, messages, titles, file contents, keys, tokens and cookies must never
 * reach a log line, so the field set is an allowlist rather than a denylist: a name nobody put
 * here is dropped instead of printed, which makes an accidental leak a missing field rather than
 * a disclosure. Everything on the list is a random identifier, a code the server itself chose, or
 * a number.
 */
const loggableFields = new Set([
  'approvalId',
  'attempt',
  'code',
  'count',
  'driver',
  'delayMs',
  'durationMs',
  'frames',
  /** What a throw was, when it carried no frames to read. */
  'thrown',
  'kind',
  /** The box's relay address: derived from its own public key, and public in certificate logs. */
  'label',
  'method',
  'modelId',
  'outcome',
  'port',
  'privacyRoute',
  'requestId',
  'resourceClass',
  'route',
  'scheduleId',
  'service',
  'status',
  'statusCode',
  'taskId',
  'userId',
  'workspaceId'
]);

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Objects and arrays are refused outright: nothing structured on a failure path is worth the risk
 * that one of its branches carries user data. Strings still pass through the shared secret
 * scrubber, so a value that turns out to embed an API key is neutered rather than published.
 */
const safeValue = (value: LogValue): LogValue => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  // Types are a promise, not a guarantee: a logger that throws on an unexpected value would
  // silence the very failure it was called to record.
  if (typeof value !== 'string') return undefined;
  return redactText(value).slice(0, 300);
};

export const loggableEntries = (fields: LogFields): Record<string, string | number | boolean> => {
  const entries: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!loggableFields.has(key)) continue;
    const value = safeValue(raw);
    if (value === undefined || value === null) continue;
    entries[key] = value;
  }
  return entries;
};

/**
 * A stack trace names code locations, never the data that flowed through them, so the frames are
 * the one part of a thrown value that is safe to keep. The message is not: a validation or driver
 * error routinely quotes the offending value back.
 */
const errorFrames = (error: unknown): string | undefined => {
  const stack = error instanceof Error ? error.stack : undefined;
  if (!stack) return undefined;
  // Matched on shape rather than on the leading "at ", so a multi-line message cannot pass one of
  // its own lines off as a frame: a real V8 frame always ends in a file position.
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^at\s\S.*:\d+:\d+\)?$/.test(line))
    .slice(0, 3);
  return frames.length ? frames.join(' | ') : undefined;
};

/**
 * The identity of a failure without its wording: an Athanor code where one exists, otherwise a
 * driver's SQLSTATE or a system errno, otherwise the class name.
 */
export const errorFields = (error: unknown): LogFields => {
  const carried = (error as { code?: unknown } | null)?.code;
  const code =
    error instanceof AthanorError
      ? error.code
      : typeof carried === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(carried)
        ? carried
        : error instanceof Error
          ? error.name
          : 'non_error_throw';
  const frames = errorFrames(error);
  // What was thrown, when it left no frames to read.
  //
  // A throw with no usable stack logs a bare code and nothing else - `{"code":"TypeError"}` and not
  // one word about where it came from - which is the least diagnosable line this logger can emit
  // and turns up exactly when something unusual happened. Naming the shape is the difference
  // between "something threw a TypeError somewhere in the API" and knowing it was not an Error at
  // all, which is the fact that explains the missing frames.
  const shape = frames
    ? undefined
    : error === null || error === undefined
      ? String(error)
      : error instanceof Error
        ? 'Error without a stack'
        : (Object.getPrototypeOf(error) as { constructor?: { name?: unknown } } | null)?.constructor
              ?.name === 'Object'
          ? 'plain object'
          : typeof error;
  return { code, ...(frames ? { frames } : {}), ...(shape ? { thrown: shape } : {}) };
};

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogThreshold;
  service?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * One JSON object per line on stdout, which is what journald stores and `athanor logs` replays.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const threshold = levelRank[options.level];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (levelRank[level] < threshold) return;
    write(
      JSON.stringify({
        time: now().toISOString(),
        level,
        ...(options.service ? { service: options.service } : {}),
        event,
        ...loggableEntries(fields)
      })
    );
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields)
  };
};

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export interface ProcessGuardTarget {
  on(event: string, listener: (value: unknown) => void): unknown;
  exit(code: number): void;
}

/**
 * Node's default for an unobserved rejection is to rethrow it and kill the process, which turns a
 * single failed sweep into an outage the owner sees only as a systemd restart. Logging it and
 * carrying on is the right trade for a personal server: the request that raised it is already
 * lost, and the alternative loses every other one too. An uncaught exception is different - the
 * process state is no longer trustworthy - so that one still exits, but with a line explaining
 * why first.
 */
export const installProcessGuards = (
  logger: Logger,
  target: ProcessGuardTarget = process
): void => {
  target.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', errorFields(reason));
  });
  target.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', errorFields(error));
    target.exit(1);
  });
};
