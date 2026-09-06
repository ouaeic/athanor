import { describe, expect, it } from 'vitest';
import { SpeechResampler, decodeVoiceFrame, encodeVoiceFrame, floatPcm, pcm16 } from './audio-dsp';

function signal(rate: number, frequency: number, length = rate) {
  return Float32Array.from(
    { length },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate)
  );
}
function convert(input: Float32Array, from: number, to: number, size: number) {
  const resampler = new SpeechResampler(from, to);
  const chunks: number[] = [];
  for (let i = 0; i < input.length; i += size)
    chunks.push(...resampler.push(input.subarray(i, i + size)));
  chunks.push(...resampler.finish());
  return chunks;
}
const rms = (values: number[]) =>
  Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length);

describe('streaming speech audio', () => {
  it('preserves speech timing across hardware rates and arbitrary render quantum boundaries', () => {
    const rates = [44100, 48000, 96000];
    expect(rates.length).toBeGreaterThan(0);
    for (const rate of rates) {
      const input = signal(rate, 1000);
      const small = convert(input, rate, 24000, 128);
      const large = convert(input, rate, 24000, 419);
      expect(small.length).toBeGreaterThanOrEqual(23999);
      expect(small.length).toBeLessThanOrEqual(24001);
      expect(large).toEqual(small);
      expect(rms(small.slice(200, -200))).toBeCloseTo(Math.SQRT1_2 / 2, 2);
    }
  });

  it('attenuates frequencies that would fold into speech during downsampling', () => {
    const result = convert(signal(48000, 18000), 48000, 24000, 128);
    expect(rms(result.slice(200, -200))).toBeLessThan(0.002);
  });

  it('reconstructs playback at the device rate without losing samples at packet boundaries', () => {
    const output = convert(signal(24000, 800), 24000, 44100, 480);
    expect(output.length).toBeGreaterThanOrEqual(44099);
    expect(output.length).toBeLessThanOrEqual(44101);
    expect(rms(output.slice(200, -200))).toBeCloseTo(Math.SQRT1_2 / 2, 2);
  });

  it('uses bounded little-endian PCM and exact network epoch/offset framing', () => {
    const pcm = pcm16(new Float32Array([-1, 0, 1]));
    expect([...new Uint8Array(pcm)]).toEqual([0, 128, 0, 0, 255, 127]);
    const decoded = decodeVoiceFrame(encodeVoiceFrame(3, 2400, pcm));
    expect(decoded.epoch).toBe(3);
    expect(decoded.offset).toBe(2400);
    expect([...floatPcm(decoded.pcm)]).toEqual([-1, 0, 32767 / 32768]);
    expect(() => encodeVoiceFrame(0, 0, pcm)).toThrow();
    expect(() => encodeVoiceFrame(1, 0, new ArrayBuffer(4802))).toThrow();
    expect(() => decodeVoiceFrame(new ArrayBuffer(9))).toThrow();
  });
});
