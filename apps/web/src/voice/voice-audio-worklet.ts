import {
  VOICE_SAMPLE_RATE,
  VOICE_MAX_FRAME_SAMPLES,
  VOICE_PLAYBACK_BUFFER_SECONDS
} from './audio-constants';
import { SpeechResampler, floatPcm, pcm16 } from './audio-dsp';
import type { AudioControl, AudioObservation } from './audio-types';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class GardenVoiceAudio extends AudioWorkletProcessor {
  private alive = true;
  private inputEpoch = 0;
  private inputEnabled = false;
  private capture = new SpeechResampler(sampleRate, VOICE_SAMPLE_RATE);
  private captureChunk = new Float32Array(VOICE_SAMPLE_RATE / 50);
  private captureLength = 0;
  private captureOffset = 0;
  private sequence = 0;
  private outstanding = new Set<number>();
  private meterAt = 0;
  private progressAt = 0;
  private output: {
    epoch: number;
    resampler: SpeechResampler;
    queue: Float32Array[];
    offset: number;
    queued: number;
    received: number;
    rendered: number;
    done: boolean;
  } | null = null;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<AudioControl>) => {
      if (!this.alive) return;
      try {
        this.control(event.data);
      } catch (cause) {
        this.fail(cause instanceof Error ? cause.message : 'Audio processing failed.');
      }
    };
  }

  private emit(message: AudioObservation, transfers: Transferable[] = []) {
    this.port.postMessage(message, transfers);
  }

  private fail(message: string) {
    this.alive = false;
    this.inputEnabled = false;
    this.output = null;
    this.emit({ type: 'error', message });
  }

  private control(message: AudioControl) {
    switch (message.type) {
      case 'input':
        if (message.epoch !== this.inputEpoch || message.enabled !== this.inputEnabled) {
          this.capture = new SpeechResampler(sampleRate, VOICE_SAMPLE_RATE);
          this.captureLength = 0;
          if (message.epoch !== this.inputEpoch) this.captureOffset = 0;
        }
        this.inputEpoch = message.epoch;
        this.inputEnabled = message.enabled;
        return;
      case 'capture_ack':
        this.outstanding.delete(message.sequence);
        return;
      case 'output':
        this.output = {
          epoch: message.epoch,
          resampler: new SpeechResampler(VOICE_SAMPLE_RATE, sampleRate),
          queue: [],
          offset: 0,
          queued: 0,
          received: 0,
          rendered: 0,
          done: false
        };
        return;
      case 'pcm': {
        const output = this.output;
        if (!output || output.epoch !== message.epoch) return;
        if (
          output.done ||
          message.offset !== output.received ||
          message.pcm.byteLength > VOICE_MAX_FRAME_SAMPLES * 2
        )
          throw new Error('Voice playback arrived out of order.');
        const samples = floatPcm(message.pcm);
        if (!samples.length) throw new Error('Voice playback was empty.');
        output.received += samples.length;
        this.enqueue(output, output.resampler.push(samples));
        return;
      }
      case 'done': {
        const output = this.output;
        if (!output || output.epoch !== message.epoch) return;
        if (message.totalSamples !== output.received || output.done)
          throw new Error('Voice playback ended with missing audio.');
        output.done = true;
        this.enqueue(output, output.resampler.finish());
        return;
      }
      case 'flush':
        if (this.output?.epoch === message.epoch) this.output = null;
        return;
      case 'stop':
        this.alive = false;
        this.inputEnabled = false;
        this.output = null;
        this.outstanding.clear();
    }
  }

  private enqueue(output: NonNullable<GardenVoiceAudio['output']>, samples: Float32Array) {
    if (output.queued + samples.length > sampleRate * VOICE_PLAYBACK_BUFFER_SECONDS)
      throw new Error('Speech playback fell behind. The voice session has stopped.');
    if (samples.length) {
      output.queue.push(samples);
      output.queued += samples.length;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.alive) return false;
    const microphone = inputs[0]?.[0];
    if (microphone && this.inputEnabled && this.inputEpoch > 0) {
      let energy = 0;
      for (const value of microphone) energy += value * value;
      if (currentTime - this.meterAt >= 0.1) {
        this.meterAt = currentTime;
        this.emit({ type: 'meter', level: Math.sqrt(energy / Math.max(1, microphone.length)) });
      }
      const captured = this.capture.push(microphone);
      for (const value of captured) {
        this.captureChunk[this.captureLength++] = value;
        if (this.captureLength === this.captureChunk.length) {
          if (this.outstanding.size >= 10) {
            this.fail(
              'The browser could not keep up with microphone audio. The voice session has stopped.'
            );
            return false;
          }
          const pcm = pcm16(this.captureChunk);
          const sequence = ++this.sequence;
          this.outstanding.add(sequence);
          this.emit(
            { type: 'capture', epoch: this.inputEpoch, offset: this.captureOffset, sequence, pcm },
            [pcm]
          );
          this.captureOffset += this.captureLength;
          this.captureLength = 0;
        }
      }
    }
    const speaker = outputs[0]?.[0];
    const output = this.output;
    if (speaker && output) {
      speaker.fill(0);
      let written = 0;
      while (written < speaker.length && output.queue.length) {
        const chunk = output.queue[0]!;
        const take = Math.min(chunk.length - output.offset, speaker.length - written);
        speaker.set(chunk.subarray(output.offset, output.offset + take), written);
        written += take;
        output.rendered += take;
        output.queued -= take;
        output.offset += take;
        if (output.offset === chunk.length) {
          output.queue.shift();
          output.offset = 0;
        }
      }
      if (written && (currentTime - this.progressAt >= 0.05 || (output.done && !output.queued))) {
        this.progressAt = currentTime;
        this.emit({
          type: 'played',
          epoch: output.epoch,
          samples: Math.min(
            output.received,
            Math.floor((output.rendered * VOICE_SAMPLE_RATE) / sampleRate)
          ),
          renderedAt: currentTime + written / sampleRate
        });
      }
    }
    return true;
  }
}

registerProcessor('garden-voice-audio', GardenVoiceAudio);
