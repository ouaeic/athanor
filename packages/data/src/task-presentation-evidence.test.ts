import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { TaskStore, TaskSignals } from './store/tasks.js';

it('reads only bounded named receipts from the same task', async () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  try {
    await database.query(
      'CREATE TABLE task_events(id uuid,task_id uuid,sequence integer,kind text,summary text,payload_ciphertext jsonb,created_at timestamptz DEFAULT now())'
    );
    const task = randomUUID();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (let index = 0; index < ids.length; index++)
      await database.query(
        'INSERT INTO task_events(id,task_id,sequence,kind,summary,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          ids[index],
          index === 1 ? randomUUID() : task,
          index + 1,
          index === 2 ? 'user_message' : 'tool_result',
          'Evidence',
          JSON.stringify({
            v: 1,
            iv: 'iv',
            tag: 'tag',
            ciphertext: index === 3 ? 'x'.repeat(262_144) : 'sealed'
          })
        ]
      );
    const store = new TaskStore(database, new TaskSignals(database));
    const records = await store.listTaskEvidenceByIds(task, ids);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(ids[0]);
    expect(await store.listTaskEvidenceByIds(task, [])).toEqual([]);
    await expect(
      store.listTaskEvidenceByIds(
        task,
        Array.from({ length: 65 }, () => randomUUID())
      )
    ).rejects.toThrow('Too many');
  } finally {
    await database.close();
  }
});
