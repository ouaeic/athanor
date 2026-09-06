import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager } from './processes.js';
import { JOB_LOG_BYTES, ServiceRegistry } from './services.js';

const roots: string[] = [];
const managers: ProcessManager[] = [];
const manager = () => {
  const current = new ProcessManager();
  managers.push(current);
  return current;
};
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-jobs-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'));
  return { root, current: manager() };
};
const command = (script: string) => ({ executable: process.execPath, args: ['-e', script] });
const start = (
  current: ProcessManager,
  root: string,
  script: string,
  extra: Record<string, unknown> = {}
) =>
  current.start(
    root,
    'workspace-1',
    'task-1',
    { ...command(script), job: 'Genome analysis', timeoutSeconds: 60, ...extra },
    120,
    false
  );
const poll = (current: ProcessManager, id: string) =>
  current.action('workspace-1', 'task-1', id, { action: 'poll' });
const settled = async (current: ProcessManager, id: string) => {
  await expect
    .poll(() => poll(current, id).status, { interval: 10, timeout: 10_000 })
    .not.toBe('running');
  await current.flush();
  return poll(current, id);
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((current) => current.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  );
});

describe('durable finite jobs', () => {
  it('persists successful identity and logs without repeating completed work after restart', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('analysis complete')",
      {
        checkpointResume: command(
          "require('node:fs').appendFileSync('runs.txt','unexpected recovery\\n')"
        )
      }
    );
    expect(launched.lifetime).toBe('job');
    expect((await settled(current, launched.sessionId)).status).toBe('completed');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(resumed.listWorkspace('workspace-1')).toHaveLength(1);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'completed',
      stdout: 'analysis complete\n',
      job: { state: 'completed', restarts: 0 }
    });
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe('initial\n');
  });

  it('surfaces an interrupted command without a checkpoint instead of duplicating it', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('working'); setInterval(()=>{},1000)"
    );
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('working');
    expect(current.backgroundWork().commands).toBe(1);
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'interrupted',
      job: { checkpointResumable: false }
    });
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe('initial\n');
    expect(resumed.stopOwner('workspace-1', 'task-1', {}).stopped).toEqual([launched.sessionId]);
    await resumed.flush();
    expect(poll(resumed, launched.sessionId).status).toBe('stopped');
  });

  it('resumes only the declared checkpoint command and keeps the original deadline', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      "require('node:fs').appendFileSync('runs.txt','initial\\n'); console.log('checkpoint saved'); setInterval(()=>{},1000)",
      {
        checkpointResume: command(
          "require('node:fs').appendFileSync('runs.txt','checkpoint\\n'); console.log('resume complete')"
        )
      }
    );
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('checkpoint saved');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(1);
    const result = await settled(resumed, launched.sessionId);
    expect(result).toMatchObject({
      status: 'completed',
      deadlineAt: launched.deadlineAt,
      job: { restarts: 1 }
    });
    expect(result.stdout).toContain('checkpoint saved');
    expect(result.stdout).toContain('resume complete');
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe(
      'initial\ncheckpoint\n'
    );
    await resumed.close();
    const again = manager();
    expect(await again.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(await readFile(path.join(root, 'workspace/runs.txt'), 'utf8')).toBe(
      'initial\ncheckpoint\n'
    );
  });

  it('preserves failure and bounded head/tail logs rather than entering service restart backoff', async () => {
    const { root, current } = await setup();
    const launched = await start(
      current,
      root,
      `process.stdout.write('HEAD'+ 'x'.repeat(${JOB_LOG_BYTES * 4}) + 'TAIL'); process.exitCode=7`
    );
    const result = await settled(current, launched.sessionId);
    expect(result).toMatchObject({ status: 'failed', exitCode: 7 });
    const registry = new ServiceRegistry(root);
    const records = await registry.load();
    expect(records).toHaveLength(1);
    expect(records[0]!.output!.stdout.length).toBeLessThan(JOB_LOG_BYTES * 2);
    expect(records[0]!.output!.stdout).toMatch(/^HEAD[\s\S]*TAIL$/);
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId).status).toBe('failed');
  });

  it('cancels finite jobs while preserving separately declared services', async () => {
    const { root, current } = await setup();
    const job = await start(current, root, 'setInterval(()=>{},1000)');
    const service = await current.start(
      root,
      'workspace-1',
      'task-1',
      { ...command('setInterval(()=>{},1000)'), service: 'Preview server' },
      120,
      false
    );
    expect(current.stopOwner('workspace-1', 'task-1', {})).toMatchObject({
      stopped: [job.sessionId],
      services: ['Preview server']
    });
    expect((await settled(current, job.sessionId)).status).toBe('stopped');
    expect(poll(current, service.sessionId).status).toBe('running');
  });

  it('retains and enforces a finite deadline', async () => {
    const { root, current } = await setup();
    const job = await start(current, root, 'setInterval(()=>{},1000)', { timeoutSeconds: 1 });
    expect(job.deadlineAt).toBeDefined();
    expect((await settled(current, job.sessionId)).status).toBe('timed_out');
    expect(current.backgroundWork().commands).toBe(0);
  });

  it('refuses an unjournalled job before executing any command', async () => {
    const { root, current } = await setup();
    await mkdir(path.join(root, '.athanor/services.json'), { recursive: true });
    await expect(
      start(current, root, "require('node:fs').writeFileSync('must-not-run.txt','wrong')")
    ).rejects.toThrow();
    await expect(readFile(path.join(root, 'workspace/must-not-run.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(current.listWorkspace('workspace-1')).toEqual([]);
  });

  it('refuses ambiguous lifetimes and checkpoint commands without a finite job', async () => {
    const { root, current } = await setup();
    await expect(start(current, root, '', { service: 'server' })).rejects.toThrow(
      'Choose a service or a finite job'
    );
    await expect(
      current.start(
        root,
        'workspace-1',
        'task-1',
        { ...command(''), checkpointResume: command('') },
        120,
        false
      )
    ).rejects.toThrow('requires a finite job');
    expect(current.listWorkspace('workspace-1')).toEqual([]);
  });

  it('applies the workspace boundary again to checkpoint recovery', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      checkpointResume: {
        ...command("require('node:fs').writeFileSync('outside-write','wrong')"),
        cwd: '../outside'
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(poll(resumed, launched.sessionId)).toMatchObject({
      status: 'interrupted',
      job: { restarts: 0 }
    });
    expect(poll(resumed, launched.sessionId).job?.lastExit?.reason).toMatch(
      /workspace|outside|path/i
    );
    expect(resumed.backgroundWork().commands).toBe(0);
  });

  it('permits an owner to retry interrupted checkpoint recovery once after fixing its workspace', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      checkpointResume: {
        ...command("require('node:fs').appendFileSync('resumed.txt','once\\n')"),
        cwd: 'workspace/recovery',
        env: { PYTHONUNBUFFERED: '1' }
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    expect(() => resumed.recoveryPlan('workspace-2', null, launched.sessionId)).toThrow(
      'not found'
    );
    expect(() => resumed.recoveryPlan('workspace-1', 'task-2', launched.sessionId)).toThrow(
      'not found'
    );
    expect(
      resumed.recoveryPlan('workspace-1', null, launched.sessionId).checkpointResume
    ).not.toHaveProperty('env');
    await mkdir(path.join(root, 'workspace/recovery'));
    await Promise.all([
      resumed.resumeJob('workspace-1', null, launched.sessionId),
      resumed.resumeJob('workspace-1', null, launched.sessionId)
    ]);
    expect((await settled(resumed, launched.sessionId)).status).toBe('completed');
    expect(await readFile(path.join(root, 'workspace/recovery/resumed.txt'), 'utf8')).toBe(
      'once\n'
    );
    await expect(resumed.resumeJob('workspace-1', null, launched.sessionId)).rejects.toThrow(
      'Only an interrupted'
    );
  });

  it('refuses checkpoint recovery after the original deadline is spent', async () => {
    const { root, current } = await setup();
    const launched = await start(current, root, "console.log('ready');setInterval(()=>{},1000)", {
      timeoutSeconds: 1,
      checkpointResume: {
        ...command("require('node:fs').writeFileSync('too-late.txt','wrong')"),
        cwd: 'workspace/recovery'
      }
    });
    await expect.poll(() => poll(current, launched.sessionId).stdout).toContain('ready');
    await current.close();
    const resumed = manager();
    expect(await resumed.resumeWorkspace(root, 'workspace-1', false)).toBe(0);
    await mkdir(path.join(root, 'workspace/recovery'));
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Date.parse(launched.deadlineAt!) - Date.now() + 20))
    );
    const expired = await resumed.resumeJob('workspace-1', null, launched.sessionId);
    expect(expired.status).toBe('timed_out');
    expect(expired.job?.restarts).toBe(0);
    await expect(
      readFile(path.join(root, 'workspace/recovery/too-late.txt'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors an explicitly declared multi-day job within the configured owner ceiling', async () => {
    const { root, current } = await setup();
    const launched = await current.start(
      root,
      'workspace-1',
      'task-1',
      {
        ...command('setInterval(()=>{},1000)'),
        job: 'Multi-day assembly',
        timeoutSeconds: 129_600
      },
      172_800,
      false
    );
    expect(Date.parse(launched.deadlineAt!) - Date.parse(launched.startedAt)).toBeGreaterThan(
      129_590_000
    );
    expect(current.backgroundWork().longestRemainingMs).toBeGreaterThan(129_590_000);
    expect(current.stopOwner('workspace-1', 'task-1', {}).stopped).toEqual([launched.sessionId]);
  });
});
