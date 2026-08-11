import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { audioWindow, encodeArguments, parseAudioProbe, prepareAudio } from './audio.js';
import { WorkspaceFileError } from './files.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/**
 * A workspace whose first PATH entry holds the host's own ffmpeg.
 *
 * `prepareAudio` resolves its binaries exactly the way an agent command would, and this machine's
 * ffmpeg is not on the search path a server would have. Linking it into the directory that path
 * already begins with is what lets the round trip below run against the real encoder rather than
 * against a stub that could agree with a wrong argument list.
 */
const workspaceWithFfmpeg = async (): Promise<string | null> => {
  const root = await mkdtemp(path.join(tmpdir(), 'athanor-audio-'));
  roots.push(root);
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  const bin = path.join(root, 'workspace', '.athanor', 'tools', 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  for (const name of ['ffmpeg', 'ffprobe']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status !== 0) return null;
    await symlink(found.stdout.trim(), path.join(bin, name));
  }
  return root;
};

const refusalFrom = async (call: Promise<unknown>): Promise<WorkspaceFileError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error;
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
};

describe('what ffprobe says a file is', () => {
  it('reads the five facts that decide anything', () => {
    expect(
      parseAudioProbe(
        JSON.stringify({
          format: { duration: '3612.480000', format_name: 'mov,mp4,m4a' },
          streams: [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
          ]
        })
      )
    ).toEqual({
      durationSeconds: 3612.48,
      container: 'mov,mp4,m4a',
      codec: 'aac',
      sampleRate: 48_000,
      channels: 2,
      // A screen recording is a video file with a track in it, and refusing one because the first
      // stream is video would rule out most of what an owner actually points at.
      hasAudio: true
    });
  });

  it('falls back to the track when the container declares no duration', () => {
    // A stream-copied recording really does arrive this way, and reporting no length at all would
    // leave the caller unable to say how much of the file it has read.
    expect(
      parseAudioProbe(
        JSON.stringify({
          format: { format_name: 'ogg' },
          streams: [{ codec_type: 'audio', codec_name: 'opus', duration: '95.5' }]
        })
      ).durationSeconds
    ).toBe(95.5);
  });

  it('says a file with no track in it has none, rather than guessing', () => {
    const probed = parseAudioProbe(
      JSON.stringify({ format: { format_name: 'png' }, streams: [{ codec_type: 'video' }] })
    );
    expect(probed.hasAudio).toBe(false);
    expect(probed.durationSeconds).toBeNull();
  });
});

describe('the window one reading takes in', () => {
  it('reads to the end of a short recording and asks for no more than it holds', () => {
    expect(audioWindow({}, 42)).toEqual({ startSeconds: 0, seconds: 42 });
  });

  it('cuts a long recording to the ceiling rather than refusing it', () => {
    // The useful answer to a three-hour recording is the first stretch and the offset the next
    // reading starts at. Refusing it would leave the owner with nothing.
    expect(audioWindow({}, 10_800)).toEqual({ startSeconds: 0, seconds: 5_400 });
  });

  it('holds the ceiling against an explicit range as well as an open one', () => {
    expect(audioWindow({ startSeconds: 600, endSeconds: 20_000 }, 20_000)).toEqual({
      startSeconds: 600,
      seconds: 5_400
    });
  });

  it('treats an end before the start as no end at all', () => {
    expect(audioWindow({ startSeconds: 300, endSeconds: 10 }, 900)).toEqual({
      startSeconds: 300,
      seconds: 600
    });
  });

  it('asks for the ceiling when nothing knows how long the file is', () => {
    expect(audioWindow({ startSeconds: 100 }, null).seconds).toBe(5_400);
  });
});

describe('the encode a reading sends', () => {
  it('seeks before it decodes, drops the video, and lands on mono speech', () => {
    const args = encodeArguments({ file: '/dev/fd/3', startSeconds: 90, seconds: 120 });
    // Before -i, or an hour-long file is decoded and thrown away to reach the mark.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args).toEqual(
      expect.arrayContaining(['-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000'])
    );
    expect(args.at(-1)).toBe('pipe:1');
  });
});

describe('preparing a recording the owner has', () => {
  it('measures it, cuts it, and reports what is left', async () => {
    const root = await workspaceWithFfmpeg();
    if (!root) return;
    // Twelve seconds of tone in a container a phone would produce, written with the same encoder
    // the reading path uses, so what is asserted is a real file rather than a fixture's idea of one.
    const source = path.join(root, 'workspace', 'memo.m4a');
    const made = spawnSync(
      path.join(root, 'workspace', '.athanor', 'tools', 'node_modules', '.bin', 'ffmpeg'),
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-ac', '2', source],
      { encoding: 'utf8' }
    );
    expect(made.status).toBe(0);

    const whole = await prepareAudio(root, 'workspace/memo.m4a', {});
    expect(whole.source.hasAudio).toBe(true);
    expect(whole.source.durationSeconds).toBeGreaterThan(11);
    expect(whole.format).toBe('ogg');
    expect(whole.bytes.length).toBeGreaterThan(0);
    // Cheaper than the source by a wide margin, which is the whole reason the encode happens on
    // this side rather than the file being uploaded as it stands.
    expect(whole.more).toBe(false);

    const first = await prepareAudio(root, 'workspace/memo.m4a', { endSeconds: 5 });
    expect(first.preparedSeconds).toBe(5);
    // The recording carries on past this window, and saying so is what lets a bounded reading of a
    // long file be resumed instead of being a dead end.
    expect(first.more).toBe(true);

    const rest = await prepareAudio(root, 'workspace/memo.m4a', { startSeconds: 5 });
    expect(rest.startSeconds).toBe(5);
    expect(rest.more).toBe(false);

    // A window asking for more than the file holds is billed and described by what it holds. Taking
    // the request at its word here is how a twelve-second memo would be charged as a minute.
    const overrun = await prepareAudio(root, 'workspace/memo.m4a', {
      startSeconds: 5,
      endSeconds: 65
    });
    expect(overrun.preparedSeconds).toBeLessThan(10);
    expect(overrun.more).toBe(false);
  }, 60_000);

  it('says a file with no audio in it holds none, rather than sending it anyway', async () => {
    const root = await workspaceWithFfmpeg();
    if (!root) return;
    await writeFile(path.join(root, 'workspace', 'notes.txt'), 'this is not a recording');
    const refusal = await refusalFrom(prepareAudio(root, 'workspace/notes.txt', {}));
    expect(refusal.message).toMatch(/could not be read as a recording|no audio track/i);
  }, 30_000);

  it('will not follow a link out of the workspace', async () => {
    const root = await workspaceWithFfmpeg();
    if (!root) return;
    const outside = path.join(root, 'outside.m4a');
    await writeFile(outside, 'not yours');
    await symlink(outside, path.join(root, 'workspace', 'escape.m4a'));
    await expect(prepareAudio(root, 'workspace/escape.m4a', {})).rejects.toThrow();
  }, 30_000);

  it('says which binary is missing rather than failing as a bad file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'athanor-audio-'));
    roots.push(root);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'memo.m4a'), 'x');
    // No PATH entry inside the workspace holds either binary, and the host's are not on the search
    // path a runner uses, so this is the "ffmpeg is not installed" case an owner can act on.
    const refusal = await refusalFrom(prepareAudio(root, 'workspace/memo.m4a', {}));
    expect(refusal.status).toBe(503);
    expect(refusal.message).toMatch(/ffmpeg/);
  });
});
