import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { AUDIO_READ_MAX_SECONDS } from '@athanor/contracts';
import { agentSearchPath } from './execution.js';
import { resolveExecutable } from './command-policy.js';
import { assertOpenedInPlace, resolveInside, WorkspaceFileError } from './files.js';
import { awaitChildExit, killProcessTree } from './subprocess.js';

/**
 * What a recording on this computer actually is, and a bounded, uploadable slice of it.
 *
 * Nothing here transcribes anything. This is the half of listening that belongs on the owner's own
 * machine: what the file is, how long it runs, and one window of it re-encoded small enough to
 * cross a wire. The provider call happens in the worker, on bytes that were already cut to the
 * length the owner is about to be billed for - which is the only order that lets the cost be stated
 * before it is incurred rather than after.
 */

/**
 * The upload ceiling, well under what a transcription endpoint will take. At the bitrate below a
 * full window weighs about eleven megabytes, so reaching this means the encode went wrong rather
 * than that the recording was long, and a refusal is the honest answer.
 */
const MAX_PREPARED_BYTES = 24 * 1024 * 1024;

const PROBE_TIMEOUT_MS = 30_000;

/** Generous: a ninety-minute window is re-encoded far faster than real time, but not instantly. */
const ENCODE_TIMEOUT_MS = 15 * 60_000;

export interface AudioSource {
  /** Absent when the container declares no duration, which a stream-copied recording can do. */
  durationSeconds: number | null;
  container: string | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  /** False when the file has no audio stream at all, which is the one refusal worth its own words. */
  hasAudio: boolean;
}

export interface PreparedAudio {
  bytes: Buffer;
  /** The container the bytes are in, in the vocabulary a transcription request uses. */
  format: 'ogg';
  source: AudioSource;
  startSeconds: number;
  /** What was actually cut, measured from the encoder's own output rather than from the request. */
  preparedSeconds: number;
  /** True when the recording continues past this window, so the caller can say where to resume. */
  more: boolean;
}

/**
 * ffprobe's JSON, read for the five facts that decide anything.
 *
 * Split out from the call so the parsing is testable without a media file: every field here is
 * optional in the real output - a stream-copied recording declares no duration, a raw stream
 * declares no container - and the difference between "no audio track" and "a track ffprobe could
 * not measure" is the difference between refusing and carrying on.
 */
export const parseAudioProbe = (json: string): AudioSource => {
  const parsed = JSON.parse(json) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
  };
  const track = (parsed.streams ?? []).find((stream) => stream.codec_type === 'audio');
  const number = (value: string | number | undefined): number | null => {
    const parsedValue = typeof value === 'string' ? Number.parseFloat(value) : value;
    return typeof parsedValue === 'number' && Number.isFinite(parsedValue) && parsedValue > 0
      ? parsedValue
      : null;
  };
  return {
    durationSeconds: number(parsed.format?.duration) ?? number(track?.duration),
    container: parsed.format?.format_name ?? null,
    codec: track?.codec_name ?? null,
    sampleRate: number(track?.sample_rate),
    channels: track?.channels ?? null,
    hasAudio: track !== undefined
  };
};

/**
 * The window this call will prepare, from what was asked and what the file holds.
 *
 * A request for more than the ceiling is cut to it rather than refused: a two-hour recording is a
 * normal thing for an owner to point at, and the useful answer is the first ninety minutes plus the
 * sentence saying where the rest starts. An end before the start is the same as no end at all.
 */
export const audioWindow = (
  requested: { startSeconds?: number | undefined; endSeconds?: number | undefined },
  durationSeconds: number | null
): { startSeconds: number; seconds: number } => {
  const start = Math.max(0, Math.floor(requested.startSeconds ?? 0));
  const remaining = durationSeconds === null ? null : Math.max(0, durationSeconds - start);
  const asked =
    requested.endSeconds !== undefined && requested.endSeconds > start
      ? Math.floor(requested.endSeconds) - start
      : (remaining ?? AUDIO_READ_MAX_SECONDS);
  return {
    startSeconds: start,
    seconds: Math.min(AUDIO_READ_MAX_SECONDS, Math.max(1, Math.ceil(asked)))
  };
};

/**
 * Mono, sixteen kilohertz, sixteen kilobits of Opus.
 *
 * Speech recognition resamples to sixteen kilohertz and mixes to mono whatever it is handed, so
 * sending a stereo forty-eight kilohertz phone recording ships several times the bytes for a
 * transcript that cannot differ. Opus is the codec every freely-licensed ffmpeg build carries -
 * which matters, because the distribution table offers `ffmpeg-free` on one of the four families
 * athanor installs on - and Ogg is a container the transcription request already names.
 *
 * `-ss` before `-i` seeks the input rather than decoding and discarding everything before the mark,
 * which is the difference between a few seconds and several minutes on an hour-long file. `-vn`
 * with an explicit audio map is what makes the audio track of a screen recording work: the video is
 * simply not read.
 */
export const encodeArguments = (input: {
  file: string;
  startSeconds: number;
  seconds: number;
}): string[] => [
  '-nostdin',
  '-v',
  'error',
  '-ss',
  String(input.startSeconds),
  '-i',
  input.file,
  '-t',
  String(input.seconds),
  '-vn',
  '-map',
  '0:a:0',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'libopus',
  '-b:a',
  '16k',
  '-f',
  'ogg',
  'pipe:1'
];

interface RunResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
}

/**
 * One child, reading the recording through an inherited descriptor rather than through its name.
 *
 * The descriptor is opened here with `O_NOFOLLOW` and proved to be the file the path named before
 * anything is spawned, and the child is then given that descriptor as `/dev/fd/3`. Handing ffmpeg
 * the path instead would reopen it, minutes later on a long encode, in a tree the agent's own shell
 * can write - which is the swap `assertOpenedInPlace` exists to refuse everywhere else.
 */
const run = async (
  executable: string,
  args: string[],
  file: number,
  timeoutMs: number,
  maxBytes: number
): Promise<RunResult> => {
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe', file],
    shell: false,
    detached: true
  });
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) {
      overflowed = true;
      killProcessTree(child, 'SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(0, 4_000);
  });
  const timer = setTimeout(() => killProcessTree(child, 'SIGKILL'), timeoutMs);
  timer.unref();
  let exitCode: number | null;
  try {
    ({ exitCode } = await awaitChildExit(child));
  } finally {
    clearTimeout(timer);
  }
  if (overflowed)
    throw new WorkspaceFileError(
      'The prepared audio grew past the upload limit before the recording ended',
      413
    );
  return { stdout: Buffer.concat(chunks), stderr, exitCode };
};

const missing = (name: string): WorkspaceFileError =>
  new WorkspaceFileError(
    `This computer has no ${name}, so a recording cannot be read. Installing the media capability - apt-get install -y ffmpeg, or the equivalent for this distribution - is what provides it.`,
    503
  );

/**
 * A recording in the workspace, measured and cut to one uploadable window.
 *
 * Both refusals it can produce are ones the agent can act on: a file with no audio track in it, and
 * a computer with no ffmpeg on it. Everything else - a container ffmpeg does not know, a truncated
 * download - arrives as the encoder's own first line of standard error, which says more about the
 * file than any sentence written here could.
 */
export const prepareAudio = async (
  root: string,
  requested: string,
  window: { startSeconds?: number | undefined; endSeconds?: number | undefined }
): Promise<PreparedAudio> => {
  const searchPath = agentSearchPath(root);
  const [ffprobe, ffmpeg] = await Promise.all([
    resolveExecutable('ffprobe', searchPath, root),
    resolveExecutable('ffmpeg', searchPath, root)
  ]);
  if (!ffprobe || !ffmpeg) throw missing(ffprobe ? 'ffmpeg' : 'ffprobe');
  const target = resolveInside(root, requested);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertOpenedInPlace(root, target, handle);
    if (!(await handle.stat()).isFile())
      throw new WorkspaceFileError('That path is not a regular file', 400);
    const probed = await run(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/dev/fd/3'],
      handle.fd,
      PROBE_TIMEOUT_MS,
      4 * 1024 * 1024
    );
    if (probed.exitCode !== 0)
      throw new WorkspaceFileError(
        `That file could not be read as a recording: ${probed.stderr.split('\n')[0] || 'the container was not recognised'}`,
        415
      );
    const source = parseAudioProbe(probed.stdout.toString('utf8'));
    if (!source.hasAudio)
      throw new WorkspaceFileError(
        'That file holds no audio track, so there is nothing in it to listen to',
        415
      );
    const cut = audioWindow(window, source.durationSeconds);
    const encoded = await run(
      ffmpeg,
      encodeArguments({ file: '/dev/fd/3', ...cut }),
      handle.fd,
      ENCODE_TIMEOUT_MS,
      MAX_PREPARED_BYTES
    );
    if (encoded.exitCode !== 0 || !encoded.stdout.length)
      throw new WorkspaceFileError(
        `That recording could not be converted for reading: ${encoded.stderr.split('\n')[0] || 'the encoder produced nothing'}`,
        415
      );
    // What the file holds, not what was asked for: a window that runs past the end of a recording
    // produces a shorter encode, and the caller is billed for - and told about - the shorter one.
    const preparedSeconds =
      source.durationSeconds === null
        ? cut.seconds
        : Math.max(0, Math.min(cut.seconds, source.durationSeconds - cut.startSeconds));
    return {
      bytes: encoded.stdout,
      format: 'ogg',
      source,
      startSeconds: cut.startSeconds,
      preparedSeconds,
      more:
        source.durationSeconds !== null &&
        source.durationSeconds > cut.startSeconds + preparedSeconds + 1
    };
  } finally {
    await handle.close();
  }
};
