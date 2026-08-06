import type { Writable } from 'node:stream';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  child(fields: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level: LogLevel;
  stream?: Writable;
  base?: LogFields;
}

/**
 * NDJSON on stdout, keyed by `cid` and `label`.
 *
 * There is deliberately no IP field here. Client addresses are only ever logged when the operator
 * turns on `logClientIps`, and then only on the bind record - the relay learns the home address of
 * every box and every device its owner connects from, and retaining that by default would be a
 * meaningful privacy regression for a component whose pitch is that it cannot see anything.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const stream = options.stream ?? process.stdout;
  const threshold = LEVEL_ORDER[options.level];
  const base = options.base ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      msg: message,
      ...base
    };
    if (fields !== undefined) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) record[key] = value;
      }
    }
    stream.write(`${JSON.stringify(record)}\n`);
  };

  const make = (bound: LogFields): Logger => ({
    child: (fields: LogFields): Logger => make({ ...bound, ...fields }),
    debug: (message, fields) => emit('debug', message, { ...bound, ...fields }),
    info: (message, fields) => emit('info', message, { ...bound, ...fields }),
    warn: (message, fields) => emit('warn', message, { ...bound, ...fields }),
    error: (message, fields) => emit('error', message, { ...bound, ...fields })
  });

  return make({});
};

export const silentLogger: Logger = {
  child: (): Logger => silentLogger,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
};
