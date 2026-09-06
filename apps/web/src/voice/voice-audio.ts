import workletUrl from './voice-audio-worklet.ts?worker&url';
import { decodeVoiceFrame, encodeVoiceFrame } from './audio-dsp';
import type { AudioControl, AudioObservation } from './audio-types';

export interface VoiceAudioCallbacks {
  onCapture: (frame: ArrayBuffer) => void;
  onPlayed: (epoch: number, samples: number) => void;
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
}
export interface VoiceAudioDependencies {
  getStream: () => Promise<MediaStream>;
  createContext: () => AudioContext;
  createNode: (context: AudioContext) => AudioWorkletNode;
}

export function createVoiceAudio(
  callbacks: VoiceAudioCallbacks,
  dependencies: VoiceAudioDependencies = {
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }),
    createContext: () => new AudioContext({ latencyHint: 'interactive' }),
    createNode: (context) =>
      new AudioWorkletNode(context, 'garden-voice-audio', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1
      })
  },
  captureAfter?: Promise<void>
) {
  let stopped = false;
  let active = false;
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let inputEnabled = false;
  let inputEpoch = 0;
  let outputEpoch = 0;
  let played = 0;
  const pending: Array<{ samples: number; renderedAt: number }> = [];
  let cancelStart: (cause: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelStart = reject;
  });
  // Cancellation may happen before setup reaches its first awaited browser operation.
  void cancelled.catch(() => undefined);
  const control = (message: AudioControl, transfers: Transferable[] = []) => {
    node?.port.postMessage(message, transfers);
  };
  const drain = () => {
    if (!context || stopped || !outputEpoch) return;
    const timestamp = context.getOutputTimestamp?.();
    const audibleAt =
      timestamp?.contextTime && timestamp.contextTime > 0
        ? timestamp.contextTime
        : context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0) - 0.04;
    let changed = false;
    while (pending.length && pending[0]!.renderedAt <= audibleAt) {
      played = Math.max(played, pending.shift()!.samples);
      changed = true;
    }
    if (changed) callbacks.onPlayed(outputEpoch, played);
  };
  const timer = setInterval(drain, 40);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active = false;
    clearInterval(timer);
    clearTimeout(startDeadline);
    cancelStart(new DOMException('Voice start cancelled', 'AbortError'));
    inputEnabled = false;
    const release = (operation: () => void) => {
      try {
        operation();
      } catch {
        // A detached resource must not prevent the remaining microphone/audio handles closing.
      }
    };
    stream?.getTracks().forEach((track) => release(() => track.stop()));
    release(() => source?.disconnect());
    release(() => control({ type: 'stop' }));
    if (node) {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      release(() => node?.disconnect());
      release(() => node?.port.close());
    }
    if (context) {
      context.onstatechange = null;
      release(() => void context?.close().catch(() => undefined));
    }
    pending.length = 0;
    callbacks.onLevel(0);
  };
  const fail = (cause: unknown) => {
    if (stopped) return;
    stop();
    callbacks.onError(
      cause instanceof Error ? cause : new Error('Voice audio could not continue.')
    );
  };
  const startDeadline = setTimeout(
    () => fail(new Error('Microphone setup timed out. Start voice again when you are ready.')),
    30000
  );
  const ready = (async () => {
    try {
      context = dependencies.createContext();
      const resumed = context.resume();
      const acquireStream = () => {
        if (stopped) throw new DOMException('Voice start cancelled', 'AbortError');
        return dependencies.getStream();
      };
      const permission = (
        captureAfter ? Promise.race([captureAfter, cancelled]).then(acquireStream) : acquireStream()
      ).then((result) => {
        stream = result;
        if (stopped) result.getTracks().forEach((track) => track.stop());
        else
          result.getAudioTracks().forEach((track) => {
            track.enabled = false;
            track.addEventListener(
              'ended',
              () => fail(new Error('Microphone access ended. The voice session has stopped.')),
              { once: true }
            );
          });
      });
      await Promise.race([
        Promise.all([resumed, permission, context.audioWorklet.addModule(workletUrl)]),
        cancelled
      ]);
      if (stopped) throw new DOMException('Voice start cancelled', 'AbortError');
      if (context.state !== 'running')
        throw new Error('Audio playback is suspended. Start voice again to enable it.');
      node = dependencies.createNode(context);
      node.onprocessorerror = () =>
        fail(new Error('Audio processing stopped. The voice session has ended.'));
      node.port.onmessage = (event: MessageEvent<AudioObservation>) => {
        if (stopped) return;
        const message = event.data;
        try {
          if (message.type === 'capture') {
            if (inputEnabled && message.epoch === inputEpoch)
              callbacks.onCapture(encodeVoiceFrame(message.epoch, message.offset, message.pcm));
            control({ type: 'capture_ack', sequence: message.sequence });
          } else if (message.type === 'played' && message.epoch === outputEpoch) {
            if (pending.length >= 64) throw new Error('Audio playback timing stopped advancing.');
            pending.push({ samples: message.samples, renderedAt: message.renderedAt });
            drain();
          } else if (message.type === 'meter') callbacks.onLevel(inputEnabled ? message.level : 0);
          else if (message.type === 'error') fail(new Error(message.message));
        } catch (cause) {
          fail(cause);
        }
      };
      source = context.createMediaStreamSource(stream!);
      source.connect(node);
      node.connect(context.destination);
      active = true;
      clearTimeout(startDeadline);
      context.onstatechange = () => {
        if (active && context?.state !== 'running')
          fail(new Error('The browser suspended audio. The voice session has stopped.'));
      };
    } catch (cause) {
      fail(cause);
      throw cause;
    }
  })();
  return {
    ready,
    stop,
    setInput(epoch: number, enabled: boolean) {
      if (stopped) return;
      inputEpoch = epoch;
      inputEnabled = enabled;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      control({ type: 'input', epoch, enabled });
      if (!enabled) callbacks.onLevel(0);
    },
    startOutput(epoch: number) {
      if (stopped) return;
      outputEpoch = epoch;
      played = 0;
      pending.length = 0;
      control({ type: 'output', epoch });
    },
    enqueue(frame: ArrayBuffer) {
      if (stopped) return;
      const decoded = decodeVoiceFrame(frame);
      if (decoded.epoch !== outputEpoch) return;
      control({ type: 'pcm', ...decoded }, [decoded.pcm]);
    },
    done(epoch: number, totalSamples: number) {
      if (!stopped) control({ type: 'done', epoch, totalSamples });
    },
    flush(epoch: number) {
      if (stopped || outputEpoch !== epoch) return 0;
      drain();
      const heard = played;
      outputEpoch = 0;
      pending.length = 0;
      control({ type: 'flush', epoch });
      return heard;
    }
  };
}
