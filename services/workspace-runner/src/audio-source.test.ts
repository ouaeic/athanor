import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SOURCE_HASH_TIMEOUT_MS,
  AUDIO_SOURCE_MAX_BYTES,
  inspectAudioSource,
  prepareAudio
} from './audio.js';

const roots: string[] = [];
const workspace = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-audio-source-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'));
  return root;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const executables = async (root: string, mutate: boolean) => {
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const source = path.join(root, 'workspace', 'memo.wav');
  const probe = { format: { duration: '10' }, streams: [{ codec_type: 'audio' }] };
  await writeFile(
    path.join(bin, 'ffprobe'),
    `#!${process.execPath}\n${mutate ? `require('node:fs').appendFileSync(${JSON.stringify(source)}, 'changed');` : ''}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probe))});\n`
  );
  await writeFile(
    path.join(bin, 'ffmpeg'),
    `#!${process.execPath}\nprocess.stdout.write('OggS fixture');\n`
  );
  await Promise.all(['ffprobe', 'ffmpeg'].map((name) => chmod(path.join(bin, name), 0o700)));
  return bin;
};

describe('original recording approval receipts', () => {
  it('hashes the complete source without loading it into an audio decoder', async () => {
    const root = await workspace();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 37);
    bytes[bytes.length - 1] = 9;
    await writeFile(path.join(root, 'workspace', 'memo.wav'), bytes);
    expect(await inspectAudioSource(root, 'workspace/memo.wav')).toEqual({
      sourceSha256: digest(bytes),
      sourceBytes: bytes.length
    });
  });

  it('refuses a changed source before any decoder runs', async () => {
    const root = await workspace(),
      bin = await executables(root, false);
    const file = path.join(root, 'workspace', 'memo.wav');
    await writeFile(file, 'original');
    const receipt = await inspectAudioSource(root, 'workspace/memo.wav');
    await writeFile(file, 'replacement');
    await expect(
      prepareAudio(root, 'workspace/memo.wav', { expectedSourceSha256: receipt.sourceSha256 }, bin)
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses in-place modification during preparation even when the decoder returns bytes', async () => {
    const root = await workspace(),
      bin = await executables(root, true);
    const file = path.join(root, 'workspace', 'memo.wav');
    await writeFile(file, 'original');
    const receipt = await inspectAudioSource(root, 'workspace/memo.wav');
    await expect(
      prepareAudio(root, 'workspace/memo.wav', { expectedSourceSha256: receipt.sourceSha256 }, bin)
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(file, 'utf8')).toBe('originalchanged');
  });

  it('requires a current decoder when the installed runtime has no fd protocol', async () => {
    const root = await workspace(),
      bin = await executables(root, false);
    await writeFile(path.join(root, 'workspace', 'memo.wav'), 'original');
    await writeFile(
      path.join(bin, 'ffprobe'),
      `#!${process.execPath}\nprocess.stderr.write("Failed to set value '3' for option 'fd': Option not found"); process.exit(1);\n`
    );
    const preparation = prepareAudio(root, 'workspace/memo.wav', {}, bin);
    await expect(preparation).rejects.toMatchObject({ status: 503 });
    await expect(preparation).rejects.toThrow('current FFmpeg build with the fd protocol');
  });

  it('rejects escaped, symlink and non-regular sources', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'outside'), 'outside');
    await symlink(path.join(root, 'outside'), path.join(root, 'workspace', 'link'));
    await expect(inspectAudioSource(root, '../outside')).rejects.toThrow();
    await expect(inspectAudioSource(root, 'workspace/link')).rejects.toThrow();
    await expect(inspectAudioSource(root, 'workspace')).rejects.toThrow('regular file');
  });

  it('refuses empty and oversized sources before reading their bodies', async () => {
    const root = await workspace(),
      file = path.join(root, 'workspace', 'large.wav');
    const handle = await open(file, 'w');
    try {
      await expect(inspectAudioSource(root, 'workspace/large.wav')).rejects.toMatchObject({
        status: 413
      });
      await handle.truncate(AUDIO_SOURCE_MAX_BYTES + 1);
      await expect(inspectAudioSource(root, 'workspace/large.wav')).rejects.toMatchObject({
        status: 413
      });
    } finally {
      await handle.close();
    }
  });

  it('honors cancellation and the hash deadline without returning a partial digest', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'workspace', 'memo.wav'), 'source');
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectAudioSource(root, 'workspace/memo.wav', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(AUDIO_SOURCE_HASH_TIMEOUT_MS + 1);
    await expect(inspectAudioSource(root, 'workspace/memo.wav')).rejects.toMatchObject({
      status: 408
    });
  });

  it('links an actual encoded window to the original recording digest', async () => {
    const root = await workspace(),
      bin = path.join(root, 'bin');
    await mkdir(bin);
    for (const name of ['ffmpeg', 'ffprobe']) {
      const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
      expect(found.status, `${name} is required for the actual recording proof`).toBe(0);
      expect(found.stdout.trim()).not.toBe('');
      await symlink(found.stdout.trim(), path.join(bin, name));
    }
    const file = path.join(root, 'workspace', 'memo.wav');
    expect(
      spawnSync(path.join(bin, 'ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        file
      ]).status
    ).toBe(0);
    const receipt = await inspectAudioSource(root, 'workspace/memo.wav');
    const prepared = await prepareAudio(
      root,
      'workspace/memo.wav',
      { endSeconds: 1, expectedSourceSha256: receipt.sourceSha256 },
      bin
    );
    expect(prepared.sourceReceipt).toEqual(receipt);
    expect(prepared.startSeconds).toBe(0);
    expect(prepared.preparedSeconds).toBe(1);
    expect(prepared.bytes.subarray(0, 4).toString()).toBe('OggS');
    expect(digest(prepared.bytes)).not.toBe(receipt.sourceSha256);
  }, 30_000);
});
