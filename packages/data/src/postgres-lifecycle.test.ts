import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  leased: 0,
  discarded: 0,
  failBegin: false,
  failRollback: false,
  operations: [] as string[]
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      on() {}
      async connect() {
        if (state.leased >= 20) throw new Error('pool exhausted');
        state.leased++;
        let released = false;
        return {
          async query(sql: string) {
            state.operations.push(sql);
            if (sql === 'BEGIN' && state.failBegin) throw new Error('begin unavailable');
            if (sql === 'ROLLBACK' && state.failRollback) throw new Error('rollback unavailable');
            return { rows: [], rowCount: 0 };
          },
          release(discard: boolean) {
            if (released) throw new Error('connection released twice');
            released = true;
            state.leased--;
            if (discard) state.discarded++;
          }
        };
      }
      async end() {}
    }
  }
}));

import { createDatabase } from './database.js';

beforeEach(() => {
  state.leased = 0;
  state.discarded = 0;
  state.failBegin = false;
  state.failRollback = false;
  state.operations = [];
});

describe('PostgreSQL transaction connection ownership', () => {
  it('does not exhaust the pool after repeated transaction-start failures', async () => {
    const database = createDatabase({ driver: 'postgres', url: 'postgres://synthetic' });
    const work = vi.fn();
    state.failBegin = true;
    for (let attempt = 0; attempt < 25; attempt++) {
      await expect(database.transaction(work)).rejects.toThrow('begin unavailable');
      expect(state.leased).toBe(0);
    }
    expect(work).not.toHaveBeenCalled();
    state.failBegin = false;
    await database.transaction(async () => 'recovered');
    expect(state.leased).toBe(0);
    expect(state.operations.at(-1)).toBe('COMMIT');
    await database.close();
  });

  it('discards a connection whose rollback failed while preserving the original error', async () => {
    const database = createDatabase({ driver: 'postgres', url: 'postgres://synthetic' });
    state.failRollback = true;
    const cause = new Error('write failed');
    await expect(
      database.transaction(async () => {
        throw cause;
      })
    ).rejects.toBe(cause);
    expect(state.leased).toBe(0);
    expect(state.discarded).toBe(1);
    expect(state.operations).toEqual(['BEGIN', 'ROLLBACK']);
    await database.close();
  });

  it('discards a lost connection when both transaction start and rollback fail', async () => {
    const database = createDatabase({ driver: 'postgres', url: 'postgres://synthetic' });
    state.failBegin = true;
    state.failRollback = true;
    const work = vi.fn();
    await expect(database.transaction(work)).rejects.toThrow('begin unavailable');
    expect(work).not.toHaveBeenCalled();
    expect(state.leased).toBe(0);
    expect(state.discarded).toBe(1);
    await database.close();
  });

  it('returns a confirmed rolled-back connection for reuse', async () => {
    const database = createDatabase({ driver: 'postgres', url: 'postgres://synthetic' });
    await expect(
      database.transaction(async () => {
        throw new Error('caller abandoned work');
      })
    ).rejects.toThrow('caller abandoned work');
    expect(state.leased).toBe(0);
    expect(state.discarded).toBe(0);
    expect(state.operations).toEqual(['BEGIN', 'ROLLBACK']);
    await database.close();
  });
});
