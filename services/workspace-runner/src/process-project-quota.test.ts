import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureWorkspace } from './files.js';
import { ProcessManager } from './processes.js';
import { newServiceRecord, ServiceRegistry, SERVICE_LIMIT_PER_WORKSPACE } from './services.js';

it('shares persistent admission across project roots and serializes the final available slot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-project-quota-'));
  const manager = new ProcessManager(30);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const id of ids) await ensureWorkspace(path.join(root, id));
    const registry = new ServiceRegistry(path.join(root, ids[0]!));
    expect(SERVICE_LIMIT_PER_WORKSPACE).toBeGreaterThan(1);
    for (let i = 0; i < SERVICE_LIMIT_PER_WORKSPACE - 1; i++) {
      const record = newServiceRecord({
        workspaceId: ids[0]!,
        owner: 'earlier-task',
        name: `analysis-${i}`,
        kind: 'job',
        launch: {
          executable: '/bin/sh',
          args: ['-c', 'sleep 30'],
          cwd: 'workspace',
          env: {},
          network: false,
          maxOutputBytes: 4096
        },
        deadlineAt: new Date(Date.now() + 60000).toISOString()
      });
      record.state = 'interrupted';
      await registry.put(record, true);
    }
    expect(await manager.resumeWorkspace(path.join(root, ids[0]!), ids[0]!, false)).toBe(0);
    const outcomes = await Promise.allSettled(
      ids
        .slice(1)
        .map((id) =>
          manager.start(
            path.join(root, id),
            id,
            'new-task',
            { executable: '/bin/sh', args: ['-c', 'sleep 30'], service: 'preview' },
            5,
            false
          )
        )
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refusal = outcomes.find((result) => result.status === 'rejected');
    expect(refusal?.status === 'rejected' ? String(refusal.reason) : '').toContain(
      'persistent processes'
    );
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
