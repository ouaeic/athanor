/**
 * The browser half of `athanor.display.v1`.
 *
 * The runner has always framed the desktop stream: a type byte, a fixed header, then the payload.
 * `services/workspace-runner/src/desktop-stream.ts` writes it and says of its own decoder that "the
 * browser client mirrors this decoder" - and no client ever did. Every binary message was wrapped in
 * a `Blob` labelled `image/jpeg` and handed to an `<img>`, so the first thing a viewer received - a
 * JSON video configuration behind a `0x02` byte - decoded to nothing, and so did every H.264 access
 * unit after it. The pane was black from the first frame and never recovered.
 *
 * This is deliberately pure: it reads bytes and returns a description. Decoding and painting belong
 * to the caller, which is what makes the framing testable without a socket, a canvas or WebCodecs.
 */

export const DISPLAY_PROTOCOL = 'athanor.display.v1';

export const DisplayMessageType = {
  videoConfig: 0x02,
  videoAccessUnit: 0x10,
  jpegFrame: 0x11
} as const;

const VIDEO_AU_HEADER_BYTES = 18;
const JPEG_HEADER_BYTES = 21;

export interface DisplayVideoConfig {
  readonly codec: string;
  readonly format: 'annexb' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly generation: number;
}

export type DisplayMessage =
  | { readonly kind: 'config'; readonly config: DisplayVideoConfig }
  | {
      readonly kind: 'video';
      readonly sequence: number;
      /** Microseconds, as `EncodedVideoChunk` wants them. */
      readonly timestamp: number;
      readonly keyframe: boolean;
      readonly generation: number;
      readonly payload: Uint8Array;
    }
  | {
      readonly kind: 'jpeg';
      readonly width: number;
      readonly height: number;
      readonly generation: number;
      readonly timestamp: number;
      readonly payload: Uint8Array;
    }
  /**
   * Anything this build does not know how to read.
   *
   * Returned rather than thrown on purpose: a viewer that meets a newer message type should skip it
   * and keep painting the ones it understands, not tear down the stream.
   */
  | { readonly kind: 'unknown'; readonly type: number };

/**
 * Reads one binary message.
 *
 * Truncated messages come back as `unknown` rather than throwing, because the alternative is one
 * malformed frame killing a live view - and a socket can always deliver a short read.
 */
export const parseDisplayMessage = (data: ArrayBuffer): DisplayMessage => {
  const bytes = new Uint8Array(data);
  if (bytes.length < 1) return { kind: 'unknown', type: -1 };
  const view = new DataView(data);
  const type = bytes[0] as number;

  if (type === DisplayMessageType.videoConfig) {
    try {
      const config = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as DisplayVideoConfig;
      if (typeof config.codec !== 'string' || !config.codec) return { kind: 'unknown', type };
      return { kind: 'config', config };
    } catch {
      return { kind: 'unknown', type };
    }
  }

  if (type === DisplayMessageType.videoAccessUnit) {
    if (bytes.length <= VIDEO_AU_HEADER_BYTES) return { kind: 'unknown', type };
    return {
      kind: 'video',
      sequence: view.getUint32(1),
      // The wire carries microseconds in 64 bits. A double holds them exactly for the next few
      // hundred years, and WebCodecs wants a number, so the conversion happens here rather than
      // leaking a bigint into the render path.
      timestamp: Number(view.getBigUint64(5)),
      keyframe: bytes[13] === 1,
      generation: view.getUint32(14),
      payload: bytes.subarray(VIDEO_AU_HEADER_BYTES)
    };
  }

  if (type === DisplayMessageType.jpegFrame) {
    if (bytes.length <= JPEG_HEADER_BYTES) return { kind: 'unknown', type };
    return {
      kind: 'jpeg',
      width: view.getUint16(5),
      height: view.getUint16(7),
      generation: view.getUint32(9),
      timestamp: Number(view.getBigUint64(13)),
      payload: bytes.subarray(JPEG_HEADER_BYTES)
    };
  }

  return { kind: 'unknown', type };
};

/**
 * Whether this browser can play the codec the runner announced.
 *
 * Asked before configuring, so a viewer without WebCodecs shows the still and says why rather than
 * painting black and reporting itself healthy - which is what it used to do.
 */
export const canDecodeVideo = (): boolean =>
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === 'function';
