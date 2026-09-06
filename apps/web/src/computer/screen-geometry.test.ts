import { describe, expect, it } from 'vitest';
import { remotePoint } from './screen-geometry';

describe('scaled remote screen pointer coordinates', () => {
  it('reaches the entire desktop at its actual dimensions', () => {
    expect(
      remotePoint(
        { x: 810, y: 620 },
        { left: 10, top: 20, width: 800, height: 600 },
        { width: 2560, height: 1920 }
      )
    ).toEqual({ x: 2559, y: 1919 });
    expect(
      remotePoint(
        { x: 410, y: 320 },
        { left: 10, top: 20, width: 800, height: 600 },
        { width: 2560, height: 1920 }
      )
    ).toEqual({ x: 1280, y: 960 });
  });
  it('clamps out-of-bounds input to the visible stream', () => {
    expect(
      remotePoint(
        { x: -10, y: 900 },
        { left: 10, top: 20, width: 320, height: 200 },
        { width: 640, height: 400 }
      )
    ).toEqual({ x: 0, y: 399 });
  });
});
