import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signCapabilityToken, capabilityAudience } from '@athanor/core';
import { authenticateRunnerRequest } from './auth.js';
import {
  byteRange,
  openDownloadFile,
  registerFileDownloadRoutes,
  sourceBundle
} from './file-downloads.js';

const secret = 'download-test-secret-repeated-to-at-least-32';
const workspaceId = '00000000-0000-4000-8000-000000000001';

const unzip = (bytes: Buffer): Map<string, Buffer> => {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = bytes.readUInt16LE(end + 10);
  expect(count).toBeGreaterThan(0);
  const files = new Map<string, Buffer>();
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const local = bytes.readUInt32LE(cursor + 42);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(data, data + compressedSize);
    files.set(
      bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      bytes.readUInt16LE(cursor + 10) === 8 ? inflateRawSync(content) : content
    );
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return files;
};

describe('streaming source delivery', () => {
  let root = '',
    workspace = '';
  const apps: FastifyInstance[] = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'garden-download-'));
    workspace = path.join(root, workspaceId);
    await mkdir(path.join(workspace, 'workspace/project'), { recursive: true });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(root, { recursive: true, force: true });
  });
  const appFor = () => {
    const app = Fastify();
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerFileDownloadRoutes(app, { WORKSPACE_ROOT: root });
    apps.push(app);
    return app;
  };
  const auth = (url: string, scopes = ['files.read']) => ({
    authorization: `Bearer ${signCapabilityToken({ sub: 'owner', workspaceId, role: 'user', scopes, nonce: randomUUID(), aud: capabilityAudience('GET', url) }, secret, 60)}`
  });

  it('streams a scientific output larger than the reader cap and resumes a bounded byte range', async () => {
    const file = await open(path.join(workspace, 'workspace/project/large.bin'), 'w');
    await file.truncate(80 * 1024 * 1024);
    await file.write(Buffer.from('tail'), 0, 4, 80 * 1024 * 1024 - 4);
    await file.close();
    const app = appFor(),
      url = `/v1/workspaces/${workspaceId}/download?path=project%2Flarge.bin`;
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { ...auth(url), range: 'bytes=-4' }
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('tail');
    expect(response.headers['content-range']).toBe(
      `bytes ${80 * 1024 * 1024 - 4}-${80 * 1024 * 1024 - 1}/${80 * 1024 * 1024}`
    );
    expect(response.headers['accept-ranges']).toBe('bytes');
    const opened = await openDownloadFile(workspace, 'project/large.bin');
    const stream = opened.handle.createReadStream();
    let observed = 0,
      largestChunk = 0;
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Expected binary file bytes');
      observed += chunk.length;
      largestChunk = Math.max(largestChunk, chunk.length);
    }
    expect(observed).toBe(80 * 1024 * 1024);
    expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
  });

  it('refuses invalid ranges and retries the whole changed file for an obsolete If-Range', async () => {
    await writeFile(path.join(workspace, 'workspace/project/a.txt'), 'abcdef');
    const app = appFor(),
      url = `/v1/workspaces/${workspaceId}/download?path=project%2Fa.txt`;
    const invalid = await app.inject({
      method: 'GET',
      url,
      headers: { ...auth(url), range: 'bytes=100-200' }
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */6');
    const changed = await app.inject({
      method: 'GET',
      url,
      headers: { ...auth(url), range: 'bytes=2-', 'if-range': '"obsolete"' }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe('abcdef');
    expect(() => byteRange('bytes=0-1,4-5', 6)).toThrow();
    expect(() => byteRange('bytes=-0', 6)).toThrow();
  });

  it('archives exactly the scoped source files with relative paths and intact binary bytes', async () => {
    const picture = Buffer.from([0, 1, 2, 255, 128]);
    await writeFile(path.join(workspace, 'workspace/project/a.txt'), 'source one');
    await writeFile(path.join(workspace, 'workspace/project/b.bin'), picture);
    await writeFile(path.join(workspace, 'workspace/unrelated-secret.txt'), 'must stay outside');
    const stream = await sourceBundle(workspace, [
      'project/a.txt',
      'workspace/project/b.bin',
      'project/a.txt'
    ]);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Expected binary archive bytes');
      chunks.push(chunk);
    }
    const files = unzip(Buffer.concat(chunks));
    expect([...files.keys()]).toEqual(['project/a.txt', 'project/b.bin']);
    expect(files.get('project/a.txt')?.toString()).toBe('source one');
    expect(files.get('project/b.bin')).toEqual(picture);
  });

  it('bundles declared project roots, including CI source and lockfiles, with run instructions and explicit environment exclusions', async () => {
    await mkdir(path.join(workspace, 'workspace/project/.github/workflows'), { recursive: true });
    await mkdir(path.join(workspace, 'workspace/project/node_modules/pkg'), { recursive: true });
    await writeFile(
      path.join(workspace, 'workspace/project/.github/workflows/test.yml'),
      'ci source'
    );
    await writeFile(path.join(workspace, 'workspace/project/package-lock.json'), 'locked versions');
    await writeFile(
      path.join(workspace, 'workspace/project/node_modules/pkg/index.js'),
      'installed dependency'
    );
    await writeFile(path.join(workspace, 'workspace/unrelated.txt'), 'other task');
    const stream = await sourceBundle(workspace, [], ['project'], 'Run npm ci, then npm start.');
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Expected binary archive bytes');
      chunks.push(chunk);
    }
    const files = unzip(Buffer.concat(chunks));
    expect([...files.keys()].sort()).toEqual([
      'garden-download.txt',
      'project/.github/workflows/test.yml',
      'project/package-lock.json'
    ]);
    expect(files.get('garden-download.txt')?.toString()).toContain('npm ci');
    expect(files.get('garden-download.txt')?.toString()).toContain('project/node_modules');
    expect(files.get('project/package-lock.json')?.toString()).toBe('locked versions');
  });

  it('verifies artifact integrity before releasing any bytes and invalidates its verification cache on a file change', async () => {
    const filename = path.join(workspace, 'workspace/project/report.txt');
    await writeFile(filename, 'trusted artifact');
    const hash = createHash('sha256').update('trusted artifact').digest('hex');
    const app = appFor(),
      url = `/v1/workspaces/${workspaceId}/download?path=project%2Freport.txt&sha256=${hash}`;
    const first = await app.inject({ method: 'GET', url, headers: auth(url) });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('trusted artifact');
    const range = await app.inject({
      method: 'GET',
      url,
      headers: { ...auth(url), range: 'bytes=0-6' }
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('trusted');
    await writeFile(filename, 'changed artifact');
    const corrupted = await app.inject({ method: 'GET', url, headers: auth(url) });
    expect(corrupted.statusCode).toBe(409);
    expect(corrupted.body).not.toContain('changed artifact');
  });

  it('denies workspace escape, credential trees, symlinks, directories, missing members and wrong capabilities', async () => {
    await writeFile(path.join(workspace, 'workspace/project/a.txt'), 'safe');
    await symlink(
      path.join(workspace, 'workspace/project/a.txt'),
      path.join(workspace, 'workspace/project/link')
    );
    for (const asked of ['../escape', '.athanor/browser/Cookies', 'project/link', 'project'])
      await expect(openDownloadFile(workspace, asked)).rejects.toThrow();
    await expect(sourceBundle(workspace, ['project/a.txt', 'project/missing'])).rejects.toThrow();
    const app = appFor(),
      url = `/v1/workspaces/${workspaceId}/download?path=project%2Fa.txt`;
    const response = await app.inject({ method: 'GET', url, headers: auth(url, ['exec']) });
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toBe('safe');
    const other = await app.inject({
      method: 'GET',
      url: url.replace(workspaceId, randomUUID()),
      headers: auth(url)
    });
    expect(other.statusCode).not.toBe(200);
  });
});
