import { describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor } from './cbor.js';

describe('encodeCbor', () => {
  it('matches RFC 8949 appendix A vectors', () => {
    expect(encodeCbor(0).toString('hex')).toBe('00');
    expect(encodeCbor(23).toString('hex')).toBe('17');
    expect(encodeCbor(24).toString('hex')).toBe('1818');
    expect(encodeCbor(1000).toString('hex')).toBe('1903e8');
    expect(encodeCbor(1000000).toString('hex')).toBe('1a000f4240');
    expect(encodeCbor('').toString('hex')).toBe('60');
    expect(encodeCbor('IETF').toString('hex')).toBe('6449455446');
    expect(encodeCbor(Buffer.from([1, 2, 3, 4])).toString('hex')).toBe('4401020304');
    expect(encodeCbor([1, 2, 3]).toString('hex')).toBe('83010203');
    expect(encodeCbor(false).toString('hex')).toBe('f4');
    expect(encodeCbor(true).toString('hex')).toBe('f5');
    expect(encodeCbor(null).toString('hex')).toBe('f6');
  });

  it('orders map keys deterministically regardless of insertion order', () => {
    const a = encodeCbor({ bb: 1, a: 2, ccc: 3 });
    const b = encodeCbor({ ccc: 3, bb: 1, a: 2 });
    expect(a.equals(b)).toBe(true);
    // Shorter encoded key first, then bytewise (RFC 8949 4.2.1).
    expect(a.toString('hex')).toBe('a3616102626262016363636303');
  });

  it('refuses values outside the supported subset', () => {
    expect(() => encodeCbor(-1)).toThrow(/non-negative/);
    expect(() => encodeCbor(1.5)).toThrow(/non-negative/);
  });
});

describe('decodeCbor', () => {
  it('round trips a bind-frame shaped map', () => {
    const frame = {
      cid: Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex'),
      l: 'abcdefghijklmnopqrstuvwxyz',
      sni: 'abcdefghijklmnopqrstuvwxyz.relay.example',
      port: 443,
      ip: '203.0.113.9',
      sport: 51234,
      t: 1754006400123
    };
    const decoded = decodeCbor(encodeCbor(frame)) as Record<string, unknown>;
    expect(decoded['l']).toBe(frame.l);
    expect(decoded['port']).toBe(443);
    expect(decoded['t']).toBe(frame.t);
    expect(Buffer.from(decoded['cid'] as Uint8Array).equals(frame.cid)).toBe(true);
  });

  it('rejects hostile input rather than allocating for it', () => {
    // Indefinite-length byte string: legal CBOR, not in our subset.
    expect(() => decodeCbor(Buffer.from([0x5f, 0xff]))).toThrow(/indefinite/);
    // Claims 2^32-1 bytes of payload in a 5 byte buffer.
    expect(() => decodeCbor(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]))).toThrow(/truncated/);
    expect(() => decodeCbor(Buffer.from([0x00, 0x00]))).toThrow(/trailing/);
    expect(() => decodeCbor(Buffer.from([0xa1, 0x01, 0x01]))).toThrow(/text strings/);
  });

  it('refuses deeply nested input', () => {
    let value = encodeCbor(1);
    for (let depth = 0; depth < 12; depth += 1) {
      value = Buffer.concat([Buffer.from([0x81]), value]);
    }
    expect(() => decodeCbor(value)).toThrow(/too deep/);
  });
});
