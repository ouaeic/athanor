import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorkspaces } from './project-workspaces.js';
import { ensureWorkspace, workspacePath } from './files.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garden-project-test-'));
  roots.push(root);
  const sourceWorkspaceId = randomUUID(),
    workspaceId = randomUUID(),
    taskId = randomUUID();
  const source = workspacePath(root, sourceWorkspaceId);
  await ensureWorkspace(source);
  await mkdir(path.join(source, 'workspace', 'project-b'));
  await mkdir(path.join(source, 'workspace', 'unrelated-a'));
  await writeFile(path.join(source, 'workspace', 'project-b', 'main.py'), 'print("B")\n');
  await writeFile(path.join(source, 'workspace', 'unrelated-a', 'large-result.txt'), 'A');
  await writeFile(path.join(source, '.home', 'private-session'), 'source-only');
  return {
    root,
    source,
    sourceWorkspaceId,
    workspaceId,
    taskId,
    input: { taskId, workspaceId, kind: 'legacy' as const, paths: ['workspace/project-b'] }
  };
}
describe('independent project preparation', () => {
  it('copies selected real sources and gives files and browser/home state independent roots', async () => {
    const f = await fixture(),
      manager = new ProjectWorkspaces(f.root, { ownedWriters: () => [] });
    const receipt = await manager.prepare(f.sourceWorkspaceId, f.input);
    expect(Object.keys(receipt.files)).toEqual(['workspace/project-b/main.py']);
    expect(receipt.status).toBe('ready');
    const target = workspacePath(f.root, f.workspaceId);
    expect(await readFile(path.join(target, 'workspace/project-b/main.py'), 'utf8')).toContain('B');
    await writeFile(path.join(target, 'workspace/project-b/main.py'), 'new B');
    expect(await readFile(path.join(f.source, 'workspace/project-b/main.py'), 'utf8')).toContain(
      'print'
    );
    await expect(readFile(path.join(target, '.home/private-session'))).rejects.toThrow();
    await expect(
      readFile(path.join(target, 'workspace/unrelated-a/large-result.txt'))
    ).rejects.toThrow();
    expect(await manager.prepare(f.sourceWorkspaceId, f.input)).toEqual(receipt);
  });
  it('does not wait for unrelated writers, but retains this task’s active analysis identity', async () => {
    const f = await fixture();
    let owner = 'another-task';
    const manager = new ProjectWorkspaces(f.root, {
      ownedWriters: (_workspace, task) => (owner === task ? [{ id: 'analysis', kind: 'job' }] : [])
    });
    expect((await manager.prepare(f.sourceWorkspaceId, f.input)).status).toBe('ready');
    owner = f.taskId;
    const second = { ...f.input, workspaceId: randomUUID() };
    expect(await manager.prepare(f.sourceWorkspaceId, second)).toMatchObject({
      status: 'shared',
      handles: [{ id: 'analysis', kind: 'job' }]
    });
    await expect(
      readFile(path.join(workspacePath(f.root, second.workspaceId), '.athanor/project-source.json'))
    ).rejects.toThrow();
    expect(
      await readFile(path.join(f.source, 'workspace/unrelated-a/large-result.txt'), 'utf8')
    ).toBe('A');
  });
  it('refuses links and unowned destinations and cleans only its unpublished staging root', async () => {
    const f = await fixture(),
      manager = new ProjectWorkspaces(f.root, { ownedWriters: () => [] });
    await symlink(
      path.join(f.source, '.home/private-session'),
      path.join(f.source, 'workspace/project-b/link')
    );
    await expect(manager.prepare(f.sourceWorkspaceId, f.input)).rejects.toThrow();
    expect((await readdir(f.root)).filter((name) => name.startsWith('.project-'))).toEqual([]);
    expect(await readFile(path.join(f.source, '.home/private-session'), 'utf8')).toBe(
      'source-only'
    );
    await mkdir(workspacePath(f.root, f.workspaceId));
    await expect(manager.prepare(f.sourceWorkspaceId, f.input)).rejects.toThrow(
      'destination already exists'
    );
  });
  it('refuses a changed source after a lost reply instead of activating an outdated copy', async () => {
    const f = await fixture(),
      manager = new ProjectWorkspaces(f.root, { ownedWriters: () => [] });
    await manager.prepare(f.sourceWorkspaceId, f.input);
    await writeFile(path.join(f.source, 'workspace/project-b/main.py'), 'changed source');
    await expect(manager.prepare(f.sourceWorkspaceId, f.input)).rejects.toThrow('source changed');
  });
  it('observes cancellation before publication and removes only matching marked staging roots', async () => {
    const f = await fixture(),
      manager = new ProjectWorkspaces(f.root, { ownedWriters: () => [] });
    const owned = path.join(f.root, `.project-${f.workspaceId}-${randomUUID()}`);
    const unowned = path.join(f.root, `.project-${f.workspaceId}-${randomUUID()}`);
    await mkdir(owned);
    await mkdir(unowned);
    await writeFile(
      path.join(owned, 'project-stage.json'),
      JSON.stringify({ workspaceId: f.workspaceId })
    );
    await writeFile(
      path.join(unowned, 'project-stage.json'),
      JSON.stringify({ workspaceId: randomUUID() })
    );
    const pending = manager.prepare(f.sourceWorkspaceId, f.input);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await manager.cancelWorkspace(f.workspaceId);
    await rejected;
    await expect(readFile(path.join(owned, 'project-stage.json'))).rejects.toThrow();
    expect(await readFile(path.join(unowned, 'project-stage.json'), 'utf8')).toContain(
      'workspaceId'
    );
    expect(() => manager.prepare(f.sourceWorkspaceId, f.input)).toThrow('cancelled');
    await expect(
      readFile(path.join(workspacePath(f.root, f.workspaceId), '.athanor/project-source.json'))
    ).rejects.toThrow();
  });
  it('binds replay to the exact source selection instead of accepting a reused target id', async () => {
    const f = await fixture(),
      manager = new ProjectWorkspaces(f.root, { ownedWriters: () => [] });
    await manager.prepare(f.sourceWorkspaceId, f.input);
    await expect(
      manager.prepare(f.sourceWorkspaceId, { ...f.input, paths: ['workspace/unrelated-a'] })
    ).rejects.toThrow('identity changed');
  });
});
