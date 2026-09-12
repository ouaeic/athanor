import type { DraftAttachment } from './model.js';
import { MAX_TASK_SPEND_USD } from './usage-model.js';

export function spendCap(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_TASK_SPEND_USD)
    throw new Error(
      `Enter a spending limit above zero and no more than ${MAX_TASK_SPEND_USD.toLocaleString()} USD.`
    );
  return cap;
}

export async function uploadAttachments(
  files: readonly File[],
  existingCount: number,
  signal: AbortSignal,
  write: (path: string, file: File, signal: AbortSignal) => Promise<unknown>,
  accepted: (attachment: DraftAttachment) => void
): Promise<void> {
  if (existingCount + files.length > 20) throw new Error('Attach up to 20 files to one direction.');
  for (const file of files) {
    signal.throwIfAborted();
    const name = file.name.slice(0, 240) || 'attachment';
    const safeName = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
    const path = `workspace/attachments/${crypto.randomUUID().slice(0, 8)}-${safeName}`;
    await write(path, file, signal);
    // Publish each confirmed write before starting the next file, which may fail or be cancelled.
    accepted({
      path,
      name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/octet-stream'
    });
  }
}

// Base64 expands by a third; this remains below the API's transcription payload limit.
export const MAX_DICTATION_BYTES = 14_000_000;
export const MAX_DICTATION_SECONDS = 300;
export const MAX_DICTATION_MILLISECONDS = MAX_DICTATION_SECONDS * 1000;
export type DictationState = 'idle' | 'requesting' | 'recording' | 'transcribing';
interface DictationOptions {
  getStream: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => MediaRecorder;
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
  onText: (text: string) => void;
  onError: (error: unknown) => void;
  onState: (state: DictationState) => void;
  maxBytes?: number;
  maxMilliseconds?: number;
}
interface Recording {
  controller: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
  bytes: number;
}

export function dictationSession(options: DictationOptions) {
  let current: Recording | null = null;
  let disposed = false;
  const state = (value: DictationState) => {
    if (!disposed) options.onState(value);
  };
  const release = (run: Recording) => {
    clearTimeout(run.timer);
    run.stream?.getTracks().forEach((track) => track.stop());
  };
  const cancel = () => {
    const run = current;
    current = null;
    if (run) {
      run.controller.abort();
      if (run.recorder) {
        run.recorder.onstop = null;
        run.recorder.ondataavailable = null;
        if (run.recorder.state !== 'inactive') run.recorder.stop();
      }
      release(run);
    }
    state('idle');
  };
  const finish = async (run: Recording) => {
    release(run);
    if (current !== run || disposed) return;
    state('transcribing');
    try {
      if (!run.bytes) throw new Error('No audio was recorded. Try dictating again.');
      const result = await options.transcribe(
        new Blob(run.chunks, { type: run.recorder!.mimeType }),
        run.controller.signal
      );
      if (current === run && !disposed) options.onText(result);
    } catch (error) {
      if (current === run && !disposed) options.onError(error);
    } finally {
      if (current === run) {
        current = null;
        state('idle');
      }
    }
  };
  return {
    async start(limits?: { maxMilliseconds: number }) {
      if (current || disposed) return;
      if (limits && !Number.isFinite(limits.maxMilliseconds)) {
        options.onError(
          new Error('The dictation duration limit is invalid. Review the model options again.')
        );
        return;
      }
      const maxMilliseconds = Math.min(
        MAX_DICTATION_MILLISECONDS,
        options.maxMilliseconds ?? MAX_DICTATION_MILLISECONDS,
        limits?.maxMilliseconds ?? MAX_DICTATION_MILLISECONDS
      );
      if (!Number.isFinite(maxMilliseconds) || maxMilliseconds < 1000) {
        options.onError(
          new Error('The dictation duration limit is invalid. Review the model options again.')
        );
        return;
      }
      const run: Recording = { controller: new AbortController(), chunks: [], bytes: 0 };
      current = run;
      state('requesting');
      try {
        const stream = await options.getStream();
        run.stream = stream;
        if (current !== run || disposed) {
          release(run);
          return;
        }
        const recorder = options.createRecorder(stream);
        run.recorder = recorder;
        recorder.ondataavailable = (event) => {
          if (current !== run || disposed || !event.data.size) return;
          if (run.bytes + event.data.size > (options.maxBytes ?? MAX_DICTATION_BYTES)) {
            cancel();
            options.onError(
              new Error('This recording reached the audio size limit. Dictate a shorter message.')
            );
            return;
          }
          run.bytes += event.data.size;
          run.chunks.push(event.data);
        };
        recorder.onerror = () => {
          if (current !== run || disposed) return;
          cancel();
          options.onError(new Error('The microphone could not finish this recording. Try again.'));
        };
        recorder.onstop = () => {
          void finish(run);
        };
        recorder.start(1000);
        state('recording');
        run.timer = setTimeout(() => {
          if (current === run && recorder.state !== 'inactive') recorder.stop();
        }, maxMilliseconds);
      } catch (error) {
        release(run);
        if (current === run && !disposed) {
          current = null;
          state('idle');
          options.onError(error);
        }
      }
    },
    stop() {
      if (current?.recorder?.state === 'recording') current.recorder.stop();
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    }
  };
}

export async function transcriptionPayload(audio: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!audio.size || audio.size > MAX_DICTATION_BYTES)
    throw new Error('Recording size is not supported.');
  const buffer = await audio.arrayBuffer();
  signal.throwIfAborted();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  const format = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  return { data: btoa(binary), format };
}
