import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.js';

/**
 * Every test in this repository runs on pglite and every installed box runs on postgres, so any
 * behaviour the two drivers do not share is a behaviour the suite can prove and the product does
 * not have. Nesting was one of those. `EmbeddedDatabase.transaction` used to hand the callback the
 * database itself, so a nested call issued a second BEGIN - which PostgreSQL answers with a warning
 * and ignores - and the nested COMMIT then committed the *outer* transaction for real. By the time
 * the outer rollback ran there was no transaction left to undo, and both writes had landed.
 *
 * `PostgresDatabase` has always flattened nesting onto the one transaction it opened, so a test
 * asserting atomicity across a nested write was proving something true of the test driver only.
 * These cases pin the flattened behaviour, which is what both drivers do now.
 */
describe('transaction nesting', () => {
  let database: Database;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await database.exec('CREATE TABLE nesting(note TEXT PRIMARY KEY)');
  });

  afterEach(async () => database.close());

  const notes = async (): Promise<string[]> => {
    const result = await database.query<{ note: string }>('SELECT note FROM nesting ORDER BY note');
    return result.rows.map((row) => row.note);
  };

  it('undoes a write made inside a nested transaction when the outer one rolls back', async () => {
    await expect(
      database.transaction(async (outer) => {
        await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
        await outer.transaction(async (inner) => {
          await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
        });
        throw new Error('the caller changed its mind');
      })
    ).rejects.toThrow('the caller changed its mind');

    expect(await notes()).toEqual([]);
  });

  it('rolls the outer transaction back when the nested callback is what throws', async () => {
    await expect(
      database.transaction(async (outer) => {
        await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
        await outer.transaction(async (inner) => {
          await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
          throw new Error('the nested write is not allowed');
        });
      })
    ).rejects.toThrow('the nested write is not allowed');

    expect(await notes()).toEqual([]);
  });

  it('commits the nested write together with the outer one when nothing throws', async () => {
    await database.transaction(async (outer) => {
      await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
      await outer.transaction(async (inner) => {
        await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
      });
    });

    expect(await notes()).toEqual(['inner', 'outer']);
  });

  /**
   * A transaction handle owns nothing it could close: the pool, the socket and the embedded backend
   * outlive it and belong to everything else in the process. `PostgresDatabase` makes the scoped
   * `close` a no-op for that reason, and a caller that reaches for it on pglite - one of the store's
   * own methods handed a transaction instead of the database, say - must not take the whole
   * database down with it.
   */
  it('leaves the database open when a transaction handle is closed', async () => {
    await database.transaction(async (scoped) => {
      await scoped.close();
      await scoped.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
    });

    expect(await notes()).toEqual(['outer']);
  });
});
