import { runnerUrlForClient } from '../client.js';

export function socketAddress(advertised: string, path: string): string {
  const url = new URL(runnerUrlForClient(advertised), window.location.href);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export const PAGE_VIEWPORT = { width: 1440, height: 900 };

export function jpegPayload(
  buffer: ArrayBuffer,
  generation: number
): { data: Uint8Array; x: number; y: number; width: number; height: number } | null {
  if (buffer.byteLength < 22) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 0x11 || view.getUint32(9) !== generation) return null;
  return {
    data: new Uint8Array(buffer, 21),
    x: view.getUint16(1),
    y: view.getUint16(3),
    width: view.getUint16(5),
    height: view.getUint16(7)
  };
}
