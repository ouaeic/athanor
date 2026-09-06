import { VOICE_FRAME_HEADER_BYTES, VOICE_MAX_FRAME_SAMPLES } from './audio-constants';
const HALF_TAPS = 24;
const PHASES = 512;

/** A bounded low-pass resampler keeps microphone frequencies above Nyquist out of speech PCM. */
export class SpeechResampler {
  private readonly coefficients: Float64Array[];
  private readonly step: number;
  private buffer = new Float32Array(HALF_TAPS);
  private start = -HALF_TAPS;
  private position = 0;

  constructor(inputRate: number, outputRate: number) {
    if (
      ![inputRate, outputRate].every(
        (rate) => Number.isFinite(rate) && rate >= 8000 && rate <= 192000
      )
    )
      throw new Error('Unsupported audio sample rate.');
    this.step = inputRate / outputRate;
    const cutoff = 0.47 * Math.min(1, outputRate / inputRate);
    this.coefficients = Array.from({ length: PHASES }, (_, phase) => {
      const taps = new Float64Array(HALF_TAPS * 2 + 1);
      let sum = 0;
      for (let tap = -HALF_TAPS; tap <= HALF_TAPS; tap++) {
        const distance = tap - phase / PHASES;
        const sinc =
          Math.abs(distance) < 1e-9
            ? 2 * cutoff
            : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        const window =
          0.42 +
          0.5 * Math.cos((Math.PI * distance) / (HALF_TAPS + 1)) +
          0.08 * Math.cos((2 * Math.PI * distance) / (HALF_TAPS + 1));
        taps[tap + HALF_TAPS] = sinc * window;
        sum += sinc * window;
      }
      return taps.map((value) => value / sum);
    });
  }

  push(input: Float32Array): Float32Array {
    if (input.length > 4800) throw new Error('Audio block exceeds its bound.');
    const joined = new Float32Array(this.buffer.length + input.length);
    joined.set(this.buffer);
    joined.set(input, this.buffer.length);
    this.buffer = joined;
    const end = this.start + joined.length;
    const result = new Float32Array(
      Math.max(0, Math.ceil((end - HALF_TAPS - this.position) / this.step))
    );
    let count = 0;
    while (Math.floor(this.position) + HALF_TAPS < end) {
      const base = Math.floor(this.position);
      const phase = Math.min(PHASES - 1, Math.floor((this.position - base) * PHASES));
      const taps = this.coefficients[phase]!;
      let value = 0;
      for (let tap = -HALF_TAPS; tap <= HALF_TAPS; tap++)
        value += (joined[base + tap - this.start] ?? 0) * taps[tap + HALF_TAPS]!;
      result[count++] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      this.position += this.step;
    }
    const discard = Math.max(0, Math.floor(this.position) - HALF_TAPS - this.start);
    this.buffer = joined.slice(discard);
    this.start += discard;
    return result.subarray(0, count);
  }

  finish(): Float32Array {
    return this.push(new Float32Array(HALF_TAPS));
  }
}

export function pcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export function floatPcm(buffer: ArrayBuffer): Float32Array {
  if (buffer.byteLength % 2) throw new Error('Incomplete PCM sample.');
  const view = new DataView(buffer);
  return Float32Array.from(
    { length: buffer.byteLength / 2 },
    (_, index) => view.getInt16(index * 2, true) / 32768
  );
}

export function encodeVoiceFrame(epoch: number, offset: number, pcm: ArrayBuffer): ArrayBuffer {
  if (
    !Number.isInteger(epoch) ||
    epoch < 1 ||
    epoch > 0xffffffff ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 0xffffffff ||
    !pcm.byteLength ||
    pcm.byteLength % 2 ||
    pcm.byteLength > VOICE_MAX_FRAME_SAMPLES * 2
  )
    throw new Error('Invalid voice audio frame.');
  const result = new ArrayBuffer(VOICE_FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(result);
  view.setUint32(0, epoch);
  view.setUint32(4, offset);
  new Uint8Array(result, VOICE_FRAME_HEADER_BYTES).set(new Uint8Array(pcm));
  return result;
}

export function decodeVoiceFrame(frame: ArrayBuffer) {
  if (
    frame.byteLength <= VOICE_FRAME_HEADER_BYTES ||
    frame.byteLength > VOICE_FRAME_HEADER_BYTES + VOICE_MAX_FRAME_SAMPLES * 2 ||
    frame.byteLength % 2
  )
    throw new Error('Invalid voice audio frame.');
  const view = new DataView(frame);
  const epoch = view.getUint32(0);
  if (!epoch) throw new Error('Invalid voice audio epoch.');
  return { epoch, offset: view.getUint32(4), pcm: frame.slice(VOICE_FRAME_HEADER_BYTES) };
}
