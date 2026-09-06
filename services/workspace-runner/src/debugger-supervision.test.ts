import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sandboxedInvocation, sandboxSpecDirectory } from './sandbox.js';
import {
  assertMissionWorkspaceOpen,
  createMissionLease,
  discardMissionInvocation,
  recoverMissionProcesses,
  stopSupervisedInvocation
} from './mission-processes.js';
import { ensureWorkspace } from './files.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = await mkdtemp('/tmp/dap-lease-');
  roots.push(parent);
  const root = path.join(parent, randomUUID());
  await ensureWorkspace(root);
  const specDirectory = sandboxSpecDirectory(parent);
  await mkdir(specDirectory, { recursive: true });
  const helper = path.join(parent, 'helper');
  await writeFile(
    helper,
    '#!/bin/sh\nprintf \'{"namespaceAlive":false,"supervisorAlive":false,"groupAlive":false}\\n\'\n'
  );
  await chmod(helper, 0o755);
  const sandbox = {
    elevate: helper,
    helper,
    specDirectory,
    confineFilesystem: true,
    processIsolation: true
  };
  return { root, sandbox, file: path.join(specDirectory, 'aabbcc.lease') };
}
it('forces a measured process lease for an ordinary debugger workspace without changing ordinary command modes', async () => {
  const { root, sandbox } = await fixture();
  const args: Parameters<typeof sandboxedInvocation> = [
    { executable: '/bin/true', args: [] },
    {},
    sandbox,
    true,
    root,
    path.join(root, 'workspace')
  ];
  const ordinary = await sandboxedInvocation(...args);
  expect(ordinary.args).toContain('confine');
  expect(ordinary.processTreeLease).toBeUndefined();
  const supervised = await sandboxedInvocation(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    true
  );
  expect(supervised.args).toContain('mission');
  expect(supervised.processTreeLease).toBeTruthy();
  expect(JSON.parse(await readFile(supervised.processTreeLease!, 'utf8')) as unknown).toMatchObject(
    { purpose: 'session', workspaceRoot: root }
  );
  await discardMissionInvocation(supervised);
  await expect(
    sandboxedInvocation(
      args[0],
      {},
      { ...sandbox, processIsolation: false },
      true,
      root,
      args[5],
      true
    )
  ).rejects.toThrow('measured native');
});
it('stops one finite lease without freezing unrelated work, and thaws only proven ordinary-session recovery', async () => {
  const { root, sandbox, file } = await fixture();
  await createMissionLease(root, file, sandbox, 'session');
  const lease = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  await stopSupervisedInvocation({ processTreeLease: file });
  expect(() => assertMissionWorkspaceOpen(root)).not.toThrow();
  await createMissionLease(root, file, sandbox, 'session');
  await writeFile(file, JSON.stringify({ ...lease, phase: 'reaped' }));
  expect(await recoverMissionProcesses(sandbox)).toBe(true);
  expect(() => assertMissionWorkspaceOpen(root)).not.toThrow();
  await createMissionLease(root, file, sandbox, 'mission');
  await writeFile(file, JSON.stringify({ ...lease, purpose: 'mission', phase: 'reaped' }));
  expect(await recoverMissionProcesses(sandbox)).toBe(true);
  expect(() => assertMissionWorkspaceOpen(root)).toThrow('scope is closed');
});
