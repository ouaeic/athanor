import { describe, expect, it } from 'vitest';
import {
  type EncryptedEnvelope,
  decryptJson,
  encryptJson,
  generateDataKey,
  hashRecoveryCode,
  unwrapDataKey,
  verifyRecoveryCode,
  wrapDataKey
} from './crypto.js';

describe('envelope encryption', () => {
  it('round trips workspace content with authenticated context', async () => {
    const key = generateDataKey();
    const encrypted = encryptJson({ prompt: 'private' }, key, 'task:123');
    expect(decryptJson(encrypted, key, 'task:123')).toEqual({ prompt: 'private' });
  });

  it('refuses a ciphertext moved to another context', () => {
    const key = generateDataKey();
    const encrypted = encryptJson({ token: 'provider-key' }, key, 'inference-provider:user-a');
    expect(() => decryptJson(encrypted, key, 'inference-provider:user-b')).toThrow(
      'Encrypted envelope context mismatch'
    );
  });

  it('still reads a stored envelope that predates context binding', () => {
    const key = generateDataKey();
    const legacy = encryptJson({ prompt: 'written before aad' }, key);
    expect(legacy.aad).toBeUndefined();
    expect(decryptJson(legacy, key, 'task-prompt:workspace-1')).toEqual({
      prompt: 'written before aad'
    });
  });

  it('fails on a stripped context rather than accepting it as legacy', () => {
    const key = generateDataKey();
    const bound = encryptJson({ secret: 1 }, key, 'task-state:one');
    const stripped: EncryptedEnvelope = {
      v: bound.v,
      iv: bound.iv,
      tag: bound.tag,
      ciphertext: bound.ciphertext
    };
    // Removing the field does not turn a bound ciphertext into an unbound one: the tag was
    // computed over the context, so it no longer verifies.
    expect(() => decryptJson(stripped, key, 'task-state:two')).toThrow();
  });

  it('wraps workspace keys to a master key and context', () => {
    const master = generateDataKey();
    const data = generateDataKey();
    const wrapped = wrapDataKey(data, master, 'workspace-1');
    expect(unwrapDataKey(wrapped, master, 'workspace-1')).toEqual(data);
    expect(() => unwrapDataKey(wrapped, master, 'workspace-2')).toThrow();
  });
});

describe('recovery codes', () => {
  it('uses a memory-hard one-way verifier off the event loop', async () => {
    const hash = await hashRecoveryCode('correct horse battery staple');
    expect(await verifyRecoveryCode('correct horse battery staple', hash)).toBe(true);
    expect(await verifyRecoveryCode('incorrect', hash)).toBe(false);
  });

  it('keeps the event loop responsive while a code is verified', async () => {
    const hash = await hashRecoveryCode('a recovery code');
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await verifyRecoveryCode('a recovery code', hash);
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
