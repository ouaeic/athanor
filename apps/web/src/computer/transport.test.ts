import { afterEach, describe, expect, it, vi } from 'vitest';
import { jpegPayload, socketAddress } from './transport.js';

afterEach(() => vi.unstubAllGlobals());

describe('computer capability transport', () => {
  it('keeps the runner gateway prefix without putting credentials in the URL', () => {
    vi.stubGlobal('window', {
      location: {
        href: 'https://owner.example/',
        origin: 'https://owner.example',
        host: 'owner.example',
        protocol: 'https:'
      }
    });
    expect(socketAddress('https://owner.example/runner/', '/v1/workspaces/example/terminal')).toBe(
      'wss://owner.example/runner/v1/workspaces/example/terminal'
    );
    expect(socketAddress('http://localhost:4300', '/v1/workspaces/example/browser/stream')).toBe(
      'ws://localhost:4300/v1/workspaces/example/browser/stream'
    );
  });

  it('reads the actual JPEG header and refuses frames from a previous generation', () => {
    const buffer = new ArrayBuffer(24);
    const view = new DataView(buffer);
    view.setUint8(0, 0x11);
    view.setUint16(1, 12);
    view.setUint16(3, 34);
    view.setUint16(5, 800);
    view.setUint16(7, 600);
    view.setUint32(9, 42);
    new Uint8Array(buffer).set([255, 216, 255], 21);
    const frame = jpegPayload(buffer, 42);
    expect(frame).toEqual({
      data: new Uint8Array([255, 216, 255]),
      x: 12,
      y: 34,
      width: 800,
      height: 600
    });
    expect(jpegPayload(buffer, 43)).toBeNull();
    expect(jpegPayload(buffer.slice(0, 20), 42)).toBeNull();
    view.setUint8(0, 0x10);
    expect(jpegPayload(buffer, 42)).toBeNull();
  });
});
