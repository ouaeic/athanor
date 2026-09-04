/**
 * Opening a share in the browser: the key from the fragment, the envelope from the box.
 *
 * Nothing here talks to a server. It is the half of the viewer that can be tested outside a
 * browser, against the same shapes `@athanor/core`'s `encryptBytes` writes: a base64 IV, tag and
 * ciphertext, sealed with AES-256-GCM under an AAD that names the link. WebCrypto wants the tag on
 * the end of the ciphertext rather than beside it, and wants the AAD as bytes; the gzip that the
 * box put round the snapshot comes off through `DecompressionStream`. Every function is pure over
 * its arguments, so a wrong key is a thrown `ShareKeyError` and nothing else.
 */
import type { ShareBlob, ShareSnapshot } from '@athanor/contracts';

/** The public half of an envelope: everything but the bytes. */
export interface EnvelopeMeta {
  v: number;
  iv: string;
  tag: string;
  aad?: string | undefined;
}

/** The key could not open what it was given: wrong key, wrong link, or an envelope moved between rows. */
export class ShareKeyError extends Error {
  constructor(message = 'This link is incomplete') {
    super(message);
    this.name = 'ShareKeyError';
  }
}

const decodeBase64 = (value: string, urlSafe: boolean): Uint8Array => {
  const normalised = urlSafe ? value.replace(/-/g, '+').replace(/_/g, '/') : value;
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const base64ToBytes = (value: string): Uint8Array => decodeBase64(value, false);
export const base64UrlToBytes = (value: string): Uint8Array => decodeBase64(value, true);

/**
 * The fragment as the box wrote it: `#1.<base64url key>`. The leading `1` is the format version;
 * a fragment of any other shape is not a key, and the page says so rather than trying it.
 */
export const parseShareFragment = (hash: string): Uint8Array | null => {
  const match = /^#1\.([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!match) return null;
  const key = base64UrlToBytes(match[1]!);
  return key.byteLength === 32 ? key : null;
};

/** The lookup segment out of the page's own path, or null if this page is not a share. */
export const parseShareToken = (pathname: string): string | null =>
  /^\/v1\/shares\/([A-Za-z0-9_-]{22})\/?$/.exec(pathname)?.[1] ?? null;

const encoder = new TextEncoder();

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** The AAD the box seals a snapshot under: the hash of the segment, not the segment. */
export const snapshotAad = async (token: string): Promise<string> =>
  `share:${await sha256Hex(token)}`;
export const artifactAad = async (token: string, n: number): Promise<string> =>
  `share:${await sha256Hex(token)}:artifact:${n}`;

/**
 * AES-256-GCM over one envelope. The AAD the envelope claims is compared with the one this link
 * implies before anything is decrypted, so a row moved between links fails here by name and not
 * only by tag; the tag check then proves the bytes and that AAD were sealed together.
 */
export const decryptEnvelope = async (
  meta: EnvelopeMeta,
  ciphertext: Uint8Array,
  key: Uint8Array,
  expectedAad: string
): Promise<Uint8Array> => {
  if (meta.v !== 1 || meta.aad !== expectedAad) throw new ShareKeyError();
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'decrypt'
  ]);
  const tag = base64ToBytes(meta.tag);
  const sealed = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.byteLength);
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(meta.iv) as BufferSource,
        additionalData: encoder.encode(expectedAad),
        tagLength: 128
      },
      cryptoKey,
      sealed
    );
    return new Uint8Array(opened);
  } catch {
    throw new ShareKeyError();
  }
};

export const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** The snapshot, opened: decrypt, inflate, parse. The shape is checked lightly; the box wrote it. */
export const openSnapshot = async (
  blob: ShareBlob,
  token: string,
  key: Uint8Array
): Promise<ShareSnapshot> => {
  const { ciphertext, ...meta } = blob.envelope;
  const opened = await decryptEnvelope(
    meta,
    base64ToBytes(ciphertext),
    key,
    await snapshotAad(token)
  );
  const parsed = JSON.parse(new TextDecoder().decode(await gunzip(opened))) as ShareSnapshot;
  if (parsed.v !== 1 || !Array.isArray(parsed.events) || !Array.isArray(parsed.artifacts))
    throw new ShareKeyError('This link opened to something that is not a conversation');
  return parsed;
};

/** One artifact's bytes, opened under the AAD that names its index on this link. */
export const openArtifact = async (
  meta: EnvelopeMeta,
  ciphertext: Uint8Array,
  token: string,
  key: Uint8Array,
  n: number
): Promise<Uint8Array> => decryptEnvelope(meta, ciphertext, key, await artifactAad(token, n));
