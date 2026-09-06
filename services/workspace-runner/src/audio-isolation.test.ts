import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { audioInputOptions, inspectAudioSource, prepareAudio } from './audio.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-audio-isolation-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(bin), mkdir(path.join(root, 'workspace'))]);
  for (const name of ['ffmpeg', 'ffprobe']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    expect(found.status, `${name} must be available for decoder isolation proofs`).toBe(0);
    expect(found.stdout.trim()).not.toBe('');
    await symlink(found.stdout.trim(), path.join(bin, name));
  }
  return { root, bin };
};
const tone = (bin: string, file: string, options: string[] = []) => {
  const generated = spawnSync(
    path.join(bin, 'ffmpeg'),
    ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', ...options, file],
    { encoding: 'utf8' }
  );
  expect(generated.status, generated.stderr).toBe(0);
};
const playlist = (reference: string) =>
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\n${reference}\n#EXT-X-ENDLIST\n`;
const probePlaylist = async (bin: string, file: string, options = audioInputOptions()) => {
  const handle = await open(file, 'r');
  try {
    const child = spawn(
      path.join(bin, 'ffprobe'),
      ['-v', 'error', ...options, '-f', 'hls', '-print_format', 'json', '-show_streams', 'fd:'],
      { stdio: ['ignore', 'pipe', 'pipe', handle.fd] }
    );
    if (!child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      throw new Error('Missing decoder output pipes');
    }
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes: Buffer) => {
      stdout += bytes.toString();
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await handle.close();
  }
};

describe('recording decoder source confinement', () => {
  it.each(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'mp4'])(
    'preserves a real seeked %s window and its original receipt',
    async (extension) => {
      const { root, bin } = await fixture();
      const relative = `workspace/recording.${extension}`;
      const file = path.join(root, relative);
      tone(
        bin,
        file,
        extension === 'mp4'
          ? [
              '-f',
              'lavfi',
              '-i',
              'color=c=black:s=16x16:r=1:d=2',
              '-map',
              '0:a',
              '-map',
              '1:v',
              '-c:a',
              'aac',
              '-c:v',
              'mpeg4'
            ]
          : []
      );
      if (extension === 'm4a' || extension === 'mp4') {
        const bytes = await readFile(file);
        expect(bytes.indexOf('mdat')).toBeGreaterThan(0);
        expect(bytes.indexOf('moov')).toBeGreaterThan(bytes.indexOf('mdat'));
      }
      const receipt = await inspectAudioSource(root, relative);
      const reading = prepareAudio(
        root,
        relative,
        {
          startSeconds: 1,
          endSeconds: 2,
          expectedSourceSha256: receipt.sourceSha256
        },
        bin
      );
      await expect(reading).resolves.toMatchObject({ startSeconds: 1, sourceReceipt: receipt });
      const prepared = await reading;
      expect(prepared.sourceReceipt).toEqual(receipt);
      expect(prepared.startSeconds).toBe(1);
      expect(prepared.preparedSeconds).toBeGreaterThan(0);
      expect(prepared.preparedSeconds).toBeLessThanOrEqual(1);
      expect(prepared.bytes.subarray(0, 4).toString()).toBe('OggS');
    },
    15_000
  );

  it('blocks secondary files even when the demuxer is explicitly selected', async () => {
    const { root, bin } = await fixture();
    const outside = path.join(root, 'outside.ts');
    tone(bin, outside, ['-c:a', 'aac', '-f', 'mpegts']);
    const source = path.join(root, 'workspace', 'disguised.wav');
    await writeFile(source, playlist(pathToFileURL(outside).href));
    // Selecting HLS bypasses filename heuristics, so this measures the protocol boundary itself.
    const permissive = audioInputOptions();
    permissive[permissive.indexOf('-protocol_whitelist') + 1] = 'fd,file';
    const control = await probePlaylist(bin, source, permissive);
    expect(control.code, control.stderr).toBe(0);
    expect(control.stdout).toContain('"codec_type": "audio"');
    const confined = await probePlaylist(bin, source);
    expect(confined.code).not.toBe(0);
    expect(confined.stderr).toContain("Protocol 'file' not on whitelist 'fd'");
    expect(confined.stdout).not.toContain('"codec_type": "audio"');
  });

  it('refuses a network reference before making a loopback request', async () => {
    const { root, bin } = await fixture();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const source = path.join(root, 'workspace', 'disguised.mp3');
      await writeFile(source, playlist(`http://127.0.0.1:${address.port}/outside.ts`));
      const result = await probePlaylist(bin, source);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Protocol 'http' not on whitelist 'fd'");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
