/**
 * The viewer's half of the cryptography, against the box's half.
 *
 * The envelope here is made with the same primitives `@athanor/core`'s `encryptBytes` uses - Node's
 * AES-256-GCM, a 12-byte IV, a 16-byte tag, base64 fields, an AAD - rather than by importing that
 * package, which the web client does not depend on. What is under test is the seam: WebCrypto wants
 * tag-on-the-end and AAD-as-bytes, and the gzip has to come off, and a wrong key or a moved row has
 * to be one named error rather than a parse failure somewhere downstream.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ShareBlob, ShareSnapshot } from '@athanor/contracts';
import {
  ShareKeyError,
  artifactAad,
  decryptEnvelope,
  openArtifact,
  openSnapshot,
  parseShareFragment,
  parseShareToken,
  snapshotAad
} from './share-crypto.js';

const seal = (plaintext: Uint8Array, key: Buffer, aad: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    aad
  };
};

const token = 'AbCdEfGhIjKlMnOpQrStUv';
const hash = createHash('sha256').update(token).digest('hex');

const snapshot: ShareSnapshot = {
  v: 1,
  title: 'Quarterly numbers',
  createdAt: '2026-09-03T10:00:00.000Z',
  events: [{ kind: 'user_message', at: '2026-09-03T09:59:00.000Z', text: 'Summarise **this**' }],
  artifacts: [{ n: 0, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: 'x' }]
};

describe('the key in the fragment', () => {
  it('reads exactly the shape the box writes and nothing looser', () => {
    const key = randomBytes(32);
    const fragment = `#1.${key.toString('base64url')}`;
    expect(Buffer.from(parseShareFragment(fragment)!).equals(key)).toBe(true);
    expect(parseShareFragment('')).toBeNull();
    expect(parseShareFragment(`#2.${key.toString('base64url')}`)).toBeNull();
    expect(parseShareFragment(`#1.${key.toString('base64url').slice(1)}`)).toBeNull();
    expect(parseShareFragment(`#1.${randomBytes(16).toString('base64url')}`)).toBeNull();
  });

  it('reads the segment out of the page path and refuses any other page', () => {
    expect(parseShareToken(`/v1/shares/${token}`)).toBe(token);
    expect(parseShareToken(`/v1/shares/${token}/`)).toBe(token);
    expect(parseShareToken(`/v1/shares/${token}/blob`)).toBeNull();
    expect(parseShareToken('/v1/shares/0f2b1c9e-8a7d-4c3b-9e1f-2a3b4c5d6e7f')).toBeNull();
    expect(parseShareToken('/')).toBeNull();
  });
});

describe('opening what the box sealed', () => {
  it('decrypts, inflates and parses a snapshot under the AAD the link implies', async () => {
    const key = randomBytes(32);
    const envelope = seal(gzipSync(Buffer.from(JSON.stringify(snapshot))), key, `share:${hash}`);
    const blob: ShareBlob = { version: 1, envelope, manifest: [] };
    expect(await snapshotAad(token)).toBe(`share:${hash}`);
    await expect(openSnapshot(blob, token, new Uint8Array(key))).resolves.toEqual(snapshot);
  });

  it('names a wrong key, a wrong link and a moved envelope the same way', async () => {
    const key = randomBytes(32);
    const envelope = seal(gzipSync(Buffer.from(JSON.stringify(snapshot))), key, `share:${hash}`);
    const blob: ShareBlob = { version: 1, envelope, manifest: [] };
    await expect(openSnapshot(blob, token, new Uint8Array(randomBytes(32)))).rejects.toBeInstanceOf(
      ShareKeyError
    );
    // The right key on another link's segment: the AAD names the link, so it does not open.
    await expect(
      openSnapshot(blob, 'ZyXwVuTsRqPoNmLkJiHgFe', new Uint8Array(key))
    ).rejects.toBeInstanceOf(ShareKeyError);
    // An envelope whose claimed AAD was rewritten to match: the tag was made over the original.
    const moved = {
      ...envelope,
      aad: `share:${createHash('sha256').update('other').digest('hex')}`
    };
    await expect(
      decryptEnvelope(moved, Buffer.from(envelope.ciphertext, 'base64'), key, moved.aad)
    ).rejects.toBeInstanceOf(ShareKeyError);
  });

  it('opens an artifact only under the AAD of its own index', async () => {
    const key = randomBytes(32);
    const bytes = Buffer.from('hello');
    const sealed = seal(bytes, key, `share:${hash}:artifact:1`);
    const { ciphertext, ...meta } = sealed;
    expect(await artifactAad(token, 1)).toBe(`share:${hash}:artifact:1`);
    const opened = await openArtifact(meta, Buffer.from(ciphertext, 'base64'), token, key, 1);
    expect(Buffer.from(opened).toString('utf8')).toBe('hello');
    await expect(
      openArtifact(meta, Buffer.from(ciphertext, 'base64'), token, key, 0)
    ).rejects.toBeInstanceOf(ShareKeyError);
  });
});
