import { afterEach, expect, it, vi } from 'vitest';
import {
  createVoiceAudio,
  type VoiceAudioCallbacks,
  type VoiceAudioDependencies
} from './voice-audio';
import type { AudioControl, AudioObservation } from './audio-types';
import { decodeVoiceFrame, encodeVoiceFrame } from './audio-dsp';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Track extends EventTarget {
  enabled = true;
  stop = vi.fn();
}
class Port {
  onmessage: ((event: { data: AudioObservation }) => void) | null = null;
  postMessage = vi.fn<(message: AudioControl, transfers?: Transferable[]) => void>();
  close = vi.fn();
  event(data: AudioObservation) {
    this.onmessage?.({ data });
  }
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
function fixture(
  options: {
    permission?: Promise<MediaStream>;
    module?: Promise<void>;
    admission?: Promise<void>;
  } = {}
) {
  vi.useFakeTimers();
  const track = new Track();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track]
  } as unknown as MediaStream;
  const port = new Port();
  const node = {
    port,
    onprocessorerror: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: 'running',
    currentTime: 0,
    baseLatency: 0.01,
    outputLatency: 0.01,
    audibleAt: 0,
    onstatechange: null as (() => void) | null,
    destination: {},
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getOutputTimestamp: () => ({ contextTime: context.audibleAt, performanceTime: 0 }),
    audioWorklet: { addModule: vi.fn(() => options.module ?? Promise.resolve()) },
    createMediaStreamSource: vi.fn(() => source)
  };
  const callbacks: VoiceAudioCallbacks = {
    onCapture: vi.fn(),
    onPlayed: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn()
  };
  const dependencies: VoiceAudioDependencies = {
    getStream: vi.fn(() => options.permission ?? Promise.resolve(stream)),
    createContext: vi.fn(() => context as unknown as AudioContext),
    createNode: vi.fn(() => node as unknown as AudioWorkletNode)
  };
  const audio = createVoiceAudio(callbacks, dependencies, options.admission);
  cleanups.push(audio.stop);
  return { audio, callbacks, dependencies, context, source, node, port, track, stream };
}

it('settles cancellation immediately while the microphone permission is pending and stops every late track', async () => {
  const permission = deferred<MediaStream>();
  const f = fixture({ permission: permission.promise });
  const cancelled = expect(f.audio.ready).rejects.toMatchObject({ name: 'AbortError' });
  f.audio.stop();
  await cancelled;
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.dependencies.createNode).not.toHaveBeenCalled();
  permission.resolve(f.stream);
  await Promise.resolve();
  expect(f.track.stop).toHaveBeenCalledOnce();
  expect(f.callbacks.onError).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds stalled setup and prevents a late worklet load from reconnecting stopped microphone tracks', async () => {
  const module = deferred<void>();
  const f = fixture({ module: module.promise });
  const rejected = expect(f.audio.ready).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(f.track.enabled).toBe(false);
  await vi.advanceTimersByTimeAsync(30001);
  await rejected;
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: expect.stringContaining('timed out') as unknown })
  );
  expect(f.track.stop).toHaveBeenCalledOnce();
  expect(f.context.close).toHaveBeenCalledOnce();
  module.resolve();
  await Promise.resolve();
  expect(f.dependencies.createNode).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('acknowledges every capture block while transmitting only the current enabled input epoch', async () => {
  const f = fixture();
  await f.audio.ready;
  expect(f.track.enabled).toBe(false);
  const pcm = new ArrayBuffer(960);
  f.port.event({ type: 'capture', epoch: 1, offset: 0, sequence: 1, pcm });
  expect(f.callbacks.onCapture).not.toHaveBeenCalled();
  expect(f.port.postMessage).toHaveBeenLastCalledWith({ type: 'capture_ack', sequence: 1 }, []);
  f.audio.setInput(2, true);
  expect(f.track.enabled).toBe(true);
  f.port.event({ type: 'capture', epoch: 1, offset: 0, sequence: 2, pcm });
  f.port.event({ type: 'capture', epoch: 2, offset: 0, sequence: 3, pcm });
  expect(f.callbacks.onCapture).toHaveBeenCalledOnce();
  const frame = vi.mocked(f.callbacks.onCapture).mock.calls[0]![0];
  expect(decodeVoiceFrame(frame)).toMatchObject({ epoch: 2, offset: 0 });
  f.audio.setInput(2, false);
  f.port.event({ type: 'capture', epoch: 2, offset: 480, sequence: 4, pcm });
  expect(f.callbacks.onCapture).toHaveBeenCalledOnce();
  expect(f.track.enabled).toBe(false);
  expect(f.port.postMessage).toHaveBeenLastCalledWith({ type: 'capture_ack', sequence: 4 }, []);
});

it('reports only hardware-audible sample progress, then flushes timing and stale audio epochs', async () => {
  const f = fixture();
  await f.audio.ready;
  f.audio.startOutput(3);
  f.audio.enqueue(encodeVoiceFrame(3, 0, new ArrayBuffer(4800)));
  expect(f.callbacks.onPlayed).not.toHaveBeenCalled();
  f.context.currentTime = 0.2;
  f.context.audibleAt = 0.2;
  f.port.event({ type: 'played', epoch: 3, samples: 480, renderedAt: 0.3 });
  expect(f.callbacks.onPlayed).not.toHaveBeenCalled();
  f.context.currentTime = 0.4;
  f.context.audibleAt = 0.31;
  await vi.advanceTimersByTimeAsync(40);
  expect(f.callbacks.onPlayed).toHaveBeenCalledExactlyOnceWith(3, 480);
  f.port.event({ type: 'played', epoch: 3, samples: 960, renderedAt: 0.5 });
  expect(f.audio.flush(3)).toBe(480);
  f.context.audibleAt = 1;
  await vi.advanceTimersByTimeAsync(80);
  f.port.event({ type: 'played', epoch: 3, samples: 2400, renderedAt: 0.6 });
  expect(f.callbacks.onPlayed).toHaveBeenCalledOnce();
  const controls = f.port.postMessage.mock.calls.length;
  f.audio.enqueue(encodeVoiceFrame(3, 2400, new ArrayBuffer(960)));
  expect(f.port.postMessage.mock.calls).toHaveLength(controls);
  f.audio.startOutput(4);
  f.port.event({ type: 'played', epoch: 3, samples: 2400, renderedAt: 0.6 });
  expect(f.callbacks.onPlayed).toHaveBeenCalledOnce();
});

it('stops bounded timing backlog, processor failures and suspended playback without retaining capture', async () => {
  const f = fixture();
  await f.audio.ready;
  f.audio.setInput(1, true);
  f.audio.startOutput(1);
  for (let i = 0; i < 65; i++)
    f.port.event({ type: 'played', epoch: 1, samples: i + 1, renderedAt: 100 });
  expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: expect.stringContaining('timing stopped') as unknown })
  );
  expect(f.track.stop).toHaveBeenCalledOnce();
  expect(f.port.close).toHaveBeenCalledOnce();
  const suspended = fixture();
  await suspended.audio.ready;
  suspended.context.state = 'suspended';
  suspended.context.onstatechange?.();
  expect(suspended.callbacks.onError).toHaveBeenCalledOnce();
  expect(suspended.track.stop).toHaveBeenCalledOnce();
  const processor = fixture();
  await processor.audio.ready;
  processor.node.onprocessorerror?.();
  expect(processor.callbacks.onError).toHaveBeenCalledOnce();
  expect(processor.track.stop).toHaveBeenCalledOnce();
});

it('completes cleanup despite an already detached browser resource and closes only once', async () => {
  const f = fixture();
  await f.audio.ready;
  f.source.disconnect.mockImplementation(() => {
    throw Error('already detached');
  });
  f.node.disconnect.mockImplementation(() => {
    throw Error('already detached');
  });
  f.audio.stop();
  f.audio.stop();
  expect(f.track.stop).toHaveBeenCalledOnce();
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.port.close).toHaveBeenCalledOnce();
  expect(f.port.onmessage).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('resumes playback in the owner gesture but waits for admission before requesting microphone permission', async () => {
  const admission = deferred<void>();
  const f = fixture({ admission: admission.promise });
  expect(f.context.resume).toHaveBeenCalledOnce();
  expect(f.dependencies.getStream).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(f.dependencies.getStream).not.toHaveBeenCalled();
  admission.resolve();
  await f.audio.ready;
  expect(f.dependencies.getStream).toHaveBeenCalledOnce();
  expect(f.track.enabled).toBe(false);
});

it('cancels admission without ever acquiring a microphone, even when admission arrives late', async () => {
  const admission = deferred<void>();
  const f = fixture({ admission: admission.promise });
  const cancelled = expect(f.audio.ready).rejects.toMatchObject({ name: 'AbortError' });
  f.audio.stop();
  await cancelled;
  admission.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.dependencies.getStream).not.toHaveBeenCalled();
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
