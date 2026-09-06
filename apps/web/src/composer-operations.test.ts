import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dictationSession,
  serialDraftWriter,
  spendCap,
  transcriptionPayload,
  uploadAttachments
} from './composer-operations.js';
import { MAX_TASK_SPEND_USD } from './usage-model.js';
import type { DraftAttachment } from './model.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('durable composer operations', () => {
  it('retains every confirmed attachment when a later upload fails', async () => {
    const accepted: DraftAttachment[] = [];
    const files = [new File(['first'], 'my first.txt'), new File(['second'], 'my second.txt')];
    const failed = new Error('Storage full');
    const write = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockImplementationOnce(() => {
        expect(accepted).toHaveLength(1);
        return Promise.reject(failed);
      });
    await expect(
      uploadAttachments(files, 0, new AbortController().signal, write, (file) =>
        accepted.push(file)
      )
    ).rejects.toBe(failed);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      name: 'my first.txt',
      sizeBytes: 5,
      mimeType: 'application/octet-stream'
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('preserves confirmed files on cancellation and rejects an oversized selection before any upload', async () => {
    const controller = new AbortController();
    const accepted: DraftAttachment[] = [];
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    const write = vi.fn().mockResolvedValue({});
    await expect(
      uploadAttachments(files, 0, controller.signal, write, (file) => {
        accepted.push(file);
        controller.abort();
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(accepted).toHaveLength(1);
    expect(write).toHaveBeenCalledOnce();
    await expect(
      uploadAttachments(files, 19, new AbortController().signal, write, () => undefined)
    ).rejects.toThrow('20 files');
    expect(write).toHaveBeenCalledOnce();
  });

  it('holds draft clearing behind the complete response of an already-started save', async () => {
    const inFlight = deferred<void>();
    let stored = '';
    const write = vi.fn(async (draft: string) => {
      if (draft) await inFlight.promise;
      stored = draft;
    });
    const writer = serialDraftWriter(write);
    const original = writer.save('Important words');
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    const clear = writer.save('');
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    inFlight.resolve();
    await Promise.all([original, clear]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(stored).toBe('');
  });

  it('surfaces failed clearing while allowing an explicit sync retry without replaying the sent task', async () => {
    const unavailable = new Error('Draft server unavailable');
    const write = vi
      .fn<
        (draft: { body: string; attachments: DraftAttachment[] }) => Promise<{ saved: boolean }>
      >()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ saved: true });
    const writer = serialDraftWriter(write);
    await expect(writer.save({ body: '', attachments: [] })).rejects.toBe(unavailable);
    await expect(writer.save({ body: '', attachments: [] })).resolves.toEqual({ saved: true });
    await writer.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      write.mock.calls.every(([draft]) => draft.body === '' && draft.attachments.length === 0)
    ).toBe(true);
  });

  it('validates spending before sending even when native form validation is bypassed', () => {
    expect(spendCap('')).toBeUndefined();
    expect(spendCap('  ')).toBeUndefined();
    expect(spendCap('0.05')).toBe(0.05);
    expect(spendCap(String(MAX_TASK_SPEND_USD))).toBe(MAX_TASK_SPEND_USD);
    for (const input of ['0', '-1', 'NaN', 'Infinity', '1e999', String(MAX_TASK_SPEND_USD + 1)])
      expect(() => spendCap(input)).toThrow();
  });
});

function voiceHarness(
  options: {
    permission?: Promise<MediaStream>;
    transcript?: Promise<string>;
    maxBytes?: number;
    maxMilliseconds?: number;
  } = {}
) {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const fake = {
    state: 'inactive',
    mimeType: 'audio/webm',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start: vi.fn(() => {
      fake.state = 'recording';
    }),
    stop: vi.fn(() => {
      fake.state = 'inactive';
      recorder.onstop?.call(recorder, new Event('stop'));
    })
  };
  const recorder = fake as unknown as MediaRecorder;
  const createRecorder = vi.fn(() => recorder);
  const transcribe = vi
    .fn<(audio: Blob, signal: AbortSignal) => Promise<string>>()
    .mockImplementation(() => options.transcript ?? Promise.resolve('A useful direction.'));
  const onText = vi.fn();
  const onError = vi.fn();
  const onState = vi.fn();
  const session = dictationSession({
    getStream: () => options.permission ?? Promise.resolve(stream),
    createRecorder,
    transcribe,
    onText,
    onError,
    onState,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxMilliseconds === undefined ? {} : { maxMilliseconds: options.maxMilliseconds })
  });
  const emit = (bytes: string): void => {
    recorder.ondataavailable?.call(recorder, { data: new Blob([bytes]) } as BlobEvent);
  };
  return {
    session,
    stopTrack,
    stream,
    recorder,
    stopRecording: fake.stop,
    createRecorder,
    transcribe,
    onText,
    onError,
    onState,
    emit
  };
}

describe('dictation lifetime and bounds', () => {
  afterEach(() => vi.useRealTimers());

  it('closes tracks from a permission request that resolves after the composer unmounts', async () => {
    const permission = deferred<MediaStream>();
    const voice = voiceHarness({ permission: permission.promise });
    const start = voice.session.start();
    voice.session.dispose();
    permission.resolve(voice.stream);
    await start;
    expect(voice.stopTrack).toHaveBeenCalled();
    expect(voice.createRecorder).not.toHaveBeenCalled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.onText).not.toHaveBeenCalled();
  });

  it('cancels recording without starting transcription on stop', async () => {
    const voice = voiceHarness();
    await voice.session.start();
    voice.emit('audio');
    voice.session.cancel();
    await Promise.resolve();
    expect(voice.stopRecording).toHaveBeenCalledOnce();
    expect(voice.stopTrack).toHaveBeenCalled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.onState).toHaveBeenLastCalledWith('idle');
  });

  it('aborts transcription and suppresses its late result when cancelled or unmounted', async () => {
    for (const action of ['cancel', 'dispose'] as const) {
      const transcript = deferred<string>();
      const voice = voiceHarness({ transcript: transcript.promise });
      await voice.session.start();
      voice.emit('audio');
      voice.session.stop();
      expect(voice.transcribe).toHaveBeenCalledOnce();
      const signal = voice.transcribe.mock.calls[0]![1];
      voice.session[action]();
      expect(signal.aborted).toBe(true);
      transcript.resolve('Must not appear in another task.');
      await Promise.resolve();
      expect(voice.onText).not.toHaveBeenCalled();
      expect(voice.onError).not.toHaveBeenCalled();
    }
  });

  it('bounds accumulated audio bytes before allocating or sending a transcription payload', async () => {
    const voice = voiceHarness({ maxBytes: 5 });
    await voice.session.start();
    voice.emit('1234');
    voice.emit('56');
    expect(voice.stopTrack).toHaveBeenCalled();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(voice.onError).toHaveBeenCalledOnce();
    expect(voice.onState).toHaveBeenLastCalledWith('idle');
  });

  it('stops at the recording time limit and transcribes the captured audio once', async () => {
    vi.useFakeTimers();
    const voice = voiceHarness({ maxMilliseconds: 100 });
    await voice.session.start();
    voice.emit('audio');
    await vi.advanceTimersByTimeAsync(100);
    expect(voice.stopRecording).toHaveBeenCalledOnce();
    expect(voice.stopTrack).toHaveBeenCalled();
    expect(voice.transcribe).toHaveBeenCalledOnce();
    expect(voice.onText).toHaveBeenCalledWith('A useful direction.');
    expect(voice.onState).toHaveBeenLastCalledWith('idle');
    voice.session.dispose();
  });

  it('encodes audio losslessly with its format and checks cancellation after reading the blob', async () => {
    const signal = new AbortController();
    const audio = new Blob([new Uint8Array([0, 127, 128, 255])], { type: 'audio/mp4' });
    await expect(transcriptionPayload(audio, signal.signal)).resolves.toEqual({
      data: 'AH+A/w==',
      format: 'm4a'
    });
    const bytes = deferred<ArrayBuffer>();
    const reading = transcriptionPayload(
      { size: 5, type: 'audio/webm', arrayBuffer: () => bytes.promise } as Blob,
      signal.signal
    );
    signal.abort();
    bytes.resolve(new ArrayBuffer(5));
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });
});
