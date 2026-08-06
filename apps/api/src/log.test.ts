import { describe, expect, test } from 'vitest';
import { AthanorError } from '@athanor/core';
import { createLogger, errorFields, installProcessGuards, type Logger } from './log.js';

const capture = (level: Parameters<typeof createLogger>[0]['level'] = 'info') => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level,
    service: 'api',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-07-31T12:00:00.000Z')
  });
  return { logger, lines };
};

describe('server logging', () => {
  test('writes one identifying line per event', () => {
    const { logger, lines } = capture();
    logger.info('schedule.dispatched', {
      scheduleId: 'a2b1',
      taskId: 'c3d4',
      durationMs: 42
    });
    expect(lines).toEqual([
      {
        time: '2026-07-31T12:00:00.000Z',
        level: 'info',
        service: 'api',
        event: 'schedule.dispatched',
        scheduleId: 'a2b1',
        taskId: 'c3d4',
        durationMs: 42
      }
    ]);
  });

  test('drops every field that is not on the allowlist', () => {
    const { logger, lines } = capture();
    logger.error('http.error', {
      code: 'request_failed',
      requestId: 'req-9',
      prompt: 'summarise my divorce papers',
      message: 'the assistant replied',
      title: 'Private task',
      apiKey: 'sk-live-000111222333444555666',
      cookie: 'athanor_session=abcdef'
    });
    expect(lines[0]).toEqual({
      time: '2026-07-31T12:00:00.000Z',
      level: 'error',
      service: 'api',
      event: 'http.error',
      code: 'request_failed',
      requestId: 'req-9'
    });
    expect(JSON.stringify(lines[0])).not.toContain('divorce');
    expect(JSON.stringify(lines[0])).not.toContain('sk-live');
  });

  test('scrubs a secret that reaches an allowlisted field anyway', () => {
    const { logger, lines } = capture();
    logger.warn('connector.failed', { code: 'Bearer sk-live-000111222333444555666' });
    expect(lines[0]!.code).not.toContain('sk-live');
    expect(lines[0]!.code).toContain('[REDACTED]');
  });

  test('refuses structured values outright', () => {
    const { logger, lines } = capture();
    logger.info('task.action', {
      taskId: 'c3d4',
      // Objects are not part of the field type; a caller that reaches for one gets nothing.
      code: { toString: () => 'leaked' } as unknown as string
    });
    expect(lines[0]).not.toHaveProperty('code');
  });

  test('honours the configured threshold', () => {
    const { logger, lines } = capture('warn');
    logger.debug('http.request', { route: '/v1/tasks' });
    logger.info('api.ready', { port: 4100 });
    logger.warn('maintenance.failed', { code: 'ECONNREFUSED' });
    expect(lines.map((line) => line.event)).toEqual(['maintenance.failed']);
  });

  test('says nothing at all when silenced', () => {
    const { logger, lines } = capture('silent');
    logger.error('process.uncaught_exception', { code: 'Error' });
    expect(lines).toHaveLength(0);
  });
});

describe('error identity in logs', () => {
  test('keeps the Athanor code and the frames but never the wording', () => {
    const error = new AthanorError('quota_exceeded', 'Task "Email the board" needs 40 credits');
    const fields = errorFields(error);
    expect(fields.code).toBe('quota_exceeded');
    expect(String(fields.frames)).toContain('at ');
    expect(JSON.stringify(fields)).not.toContain('Email the board');
  });

  test('will not accept a line of the message as a stack frame', () => {
    const error = new Error('at the board meeting we discussed acquiring Northwind');
    expect(String(errorFields(error).frames)).not.toContain('Northwind');
  });

  test('falls back to a driver code, then to the class name', () => {
    const driverError = Object.assign(new Error('terminating connection'), { code: '57P01' });
    expect(errorFields(driverError).code).toBe('57P01');
    expect(errorFields(new TypeError('x is not a function')).code).toBe('TypeError');
    expect(errorFields('a thrown string').code).toBe('non_error_throw');
  });
});

describe('process guards', () => {
  const guardTarget = () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const exits: number[] = [];
    return {
      listeners,
      exits,
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
      },
      exit: (code: number) => {
        exits.push(code);
      }
    };
  };

  test('logs an unhandled rejection and keeps the process alive', () => {
    const { logger, lines } = capture();
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('unhandledRejection')!(new AthanorError('workspace_missing', 'gone'));
    expect(lines[0]).toMatchObject({
      event: 'process.unhandled_rejection',
      code: 'workspace_missing'
    });
    expect(target.exits).toEqual([]);
  });

  test('logs an uncaught exception before letting the process go', () => {
    const { logger, lines } = capture();
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('uncaughtException')!(new Error('boom'));
    expect(lines[0]).toMatchObject({ event: 'process.uncaught_exception', code: 'Error' });
    expect(target.exits).toEqual([1]);
  });

  test('accepts any logger shape the server passes it', () => {
    const seen: string[] = [];
    const logger: Logger = {
      debug: (event) => seen.push(event),
      info: (event) => seen.push(event),
      warn: (event) => seen.push(event),
      error: (event) => seen.push(event)
    };
    const target = guardTarget();
    installProcessGuards(logger, target);
    target.listeners.get('unhandledRejection')!(new Error('boom'));
    expect(seen).toEqual(['process.unhandled_rejection']);
  });
});

describe('a throw that leaves no frames', () => {
  /*
   * The least diagnosable line this logger can emit is a bare code: `{"code":"TypeError"}` and not
   * one word about where it came from. It happens when the thrown value is not an Error, which is
   * exactly the unusual case worth knowing about - and the silence was indistinguishable from an
   * ordinary failure.
   */
  test('names what was thrown when there is no stack to read', () => {
    expect(errorFields({ code: 'TypeError' })).toMatchObject({
      code: 'TypeError',
      thrown: 'plain object'
    });
    expect(errorFields('a bare string')).toMatchObject({ thrown: 'string' });
    expect(errorFields(null)).toMatchObject({ thrown: 'null' });
  });

  test('says nothing extra when the frames are there', () => {
    const fields = errorFields(new Error('ordinary'));
    expect(fields.frames).toBeTruthy();
    expect(fields).not.toHaveProperty('thrown');
  });
});
