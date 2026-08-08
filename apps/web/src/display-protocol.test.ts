import { describe, expect, it } from 'vitest';
import { DisplayMessageType, parseDisplayMessage } from './display-protocol.js';

/** The layout `desktop-stream.ts` writes: `0x10 [u32 seq][u64 captureUs][u8 key][u32 generation]`. */
const videoAccessUnit = (over: {
  sequence?: number;
  captureUs?: bigint;
  keyframe?: boolean;
  generation?: number;
  payload?: number[];
}): ArrayBuffer => {
  const payload = over.payload ?? [0x00, 0x00, 0x00, 0x01, 0x65];
  const buffer = new ArrayBuffer(18 + payload.length);
  const view = new DataView(buffer);
  view.setUint8(0, DisplayMessageType.videoAccessUnit);
  view.setUint32(1, over.sequence ?? 1);
  view.setBigUint64(5, over.captureUs ?? 1_700_000_000_000_000n);
  view.setUint8(13, over.keyframe === false ? 0 : 1);
  view.setUint32(14, over.generation ?? 3);
  new Uint8Array(buffer).set(payload, 18);
  return buffer;
};

describe('reading the desktop stream off the wire', () => {
  /**
   * These are the real first eight bytes of the first two messages, captured from the deployed
   * runner by patching createObjectURL on the live page. The client used to wrap both of them in a
   * Blob labelled image/jpeg and hand them to an <img>, which is why the pane was black: the first
   * message is not an image at all, it is the configuration describing the video that follows.
   */
  it('reads the configuration the runner really sends first', () => {
    const json =
      '{"codec":"avc1.42E020","format":"annexb","width":1280,"height":720,"framerate":15,"generation":3}';
    const body = new TextEncoder().encode(json);
    const buffer = new ArrayBuffer(1 + body.length);
    const bytes = new Uint8Array(buffer);
    bytes[0] = 0x02;
    bytes.set(body, 1);
    // Byte for byte what came off the socket: 02 7b 22 63 6f 64 65 63 -> 0x02 then {"codec
    expect([...bytes.subarray(0, 8)]).toEqual([0x02, 0x7b, 0x22, 0x63, 0x6f, 0x64, 0x65, 0x63]);

    const message = parseDisplayMessage(buffer);
    expect(message.kind).toBe('config');
    if (message.kind !== 'config') throw new Error('unreachable');
    // The string is handed straight to VideoDecoder.configure, so it must survive intact.
    expect(message.config.codec).toBe('avc1.42E020');
    expect(message.config.format).toBe('annexb');
    expect(message.config.width).toBe(1280);
  });

  it('reads an access unit header the way the runner wrote it', () => {
    const message = parseDisplayMessage(
      videoAccessUnit({ sequence: 7, keyframe: true, generation: 3, payload: [1, 2, 3, 4] })
    );
    expect(message.kind).toBe('video');
    if (message.kind !== 'video') throw new Error('unreachable');
    expect(message.sequence).toBe(7);
    expect(message.keyframe).toBe(true);
    expect(message.generation).toBe(3);
    // The payload starts after the 18-byte header - an off-by-one here feeds the decoder a byte of
    // header as if it were video, and nothing paints.
    expect([...message.payload]).toEqual([1, 2, 3, 4]);
  });

  it('carries the capture clock as a number the decoder will take', () => {
    const message = parseDisplayMessage(videoAccessUnit({ captureUs: 1_786_209_513_000_000n }));
    if (message.kind !== 'video') throw new Error('unreachable');
    expect(message.timestamp).toBe(1_786_209_513_000_000);
    expect(Number.isSafeInteger(message.timestamp)).toBe(true);
  });

  it('reads a jpeg frame past its longer header', () => {
    const payload = [0xff, 0xd8, 0xff, 0xe0];
    const buffer = new ArrayBuffer(21 + payload.length);
    const view = new DataView(buffer);
    view.setUint8(0, DisplayMessageType.jpegFrame);
    view.setUint16(5, 1280);
    view.setUint16(7, 720);
    view.setUint32(9, 4);
    view.setBigUint64(13, 99n);
    new Uint8Array(buffer).set(payload, 21);

    const message = parseDisplayMessage(buffer);
    expect(message.kind).toBe('jpeg');
    if (message.kind !== 'jpeg') throw new Error('unreachable');
    expect(message.width).toBe(1280);
    expect(message.height).toBe(720);
    // A real JPEG starts FF D8 - proof the header was skipped by exactly the right amount.
    expect([...message.payload]).toEqual(payload);
  });

  /**
   * The whole class of bug this module exists to end: a message that is not a picture must never be
   * offered to something that paints pictures.
   */
  it('never reports a configuration or a short read as something paintable', () => {
    const config = new Uint8Array([0x02, 0x7b, 0x7d]).buffer;
    expect(parseDisplayMessage(config).kind).not.toBe('jpeg');
    expect(parseDisplayMessage(config).kind).not.toBe('video');

    // Truncated messages are skipped rather than thrown, so one short read cannot kill a live view.
    expect(parseDisplayMessage(new Uint8Array([0x10, 0x00]).buffer).kind).toBe('unknown');
    expect(parseDisplayMessage(new Uint8Array([0x11]).buffer).kind).toBe('unknown');
    expect(parseDisplayMessage(new ArrayBuffer(0)).kind).toBe('unknown');
    // Unparseable JSON behind a config byte is a skip, not a crash.
    expect(parseDisplayMessage(new Uint8Array([0x02, 0x7b, 0x22]).buffer).kind).toBe('unknown');
    // An unfamiliar type from a newer runner is skipped, and says which type it was.
    const future = parseDisplayMessage(new Uint8Array([0x7f, 1, 2, 3]).buffer);
    expect(future).toEqual({ kind: 'unknown', type: 0x7f });
  });
});
