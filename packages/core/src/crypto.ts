import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedEnvelope {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
  aad?: string;
}

export const decodeMasterKey = (encoded: string): Buffer => {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('DATA_MASTER_KEY must be exactly 32 bytes in base64');
  return key;
};

export const generateDataKey = (): Buffer => randomBytes(32);

export const encryptBytes = (
  plaintext: Uint8Array,
  key: Uint8Array,
  aad?: string
): EncryptedEnvelope => {
  if (key.byteLength !== 32) throw new Error('AES-256-GCM requires a 32 byte key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    ...(aad ? { aad } : {})
  };
};

/**
 * The GCM tag proves the ciphertext and the AAD stored beside it were produced together. It does
 * not prove that AAD is the one this caller meant, so a row moved from one user, task or workspace
 * to another decrypts perfectly well unless somebody compares. `expectedAad` is that comparison,
 * and it is the only thing standing between database write access and reading another account's
 * provider credential.
 *
 * An envelope with no AAD at all is accepted, because it predates the binding and its bytes are
 * still the owner's data. That is not a hole a mover can walk through: stripping the field off an
 * envelope that was written with one makes the tag fail, so the only envelopes that reach this
 * branch are ones whose original context was never recorded anywhere.
 */
const assertAad = (envelope: EncryptedEnvelope, expectedAad?: string): void => {
  if (expectedAad === undefined || envelope.aad === undefined) return;
  if (envelope.aad !== expectedAad) throw new Error('Encrypted envelope context mismatch');
};

export const decryptBytes = (
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  expectedAad?: string
): Buffer => {
  if (envelope.v !== VERSION)
    throw new Error(`Unsupported encrypted envelope version ${envelope.v}`);
  assertAad(envelope, expectedAad);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), {
    authTagLength: TAG_BYTES
  });
  if (envelope.aad) decipher.setAAD(Buffer.from(envelope.aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);
};

export const encryptJson = (value: unknown, key: Uint8Array, aad?: string): EncryptedEnvelope =>
  encryptBytes(Buffer.from(JSON.stringify(value), 'utf8'), key, aad);

export const decryptJson = <T>(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  expectedAad?: string
): T => JSON.parse(decryptBytes(envelope, key, expectedAad).toString('utf8')) as T;

export const wrapDataKey = (dataKey: Uint8Array, masterKey: Uint8Array, keyId: string): string =>
  Buffer.from(JSON.stringify(encryptBytes(dataKey, masterKey, `workspace-key:${keyId}`))).toString(
    'base64url'
  );

export const unwrapDataKey = (wrapped: string, masterKey: Uint8Array, keyId: string): Buffer => {
  const envelope = JSON.parse(
    Buffer.from(wrapped, 'base64url').toString('utf8')
  ) as EncryptedEnvelope;
  // A wrapped key has always carried its context, so unlike stored ciphertext it may insist on one.
  if (envelope.aad === undefined) throw new Error('Wrapped key context mismatch');
  return decryptBytes(envelope, masterKey, `workspace-key:${keyId}`);
};

export const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const RECOVERY_SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Deliberately expensive - roughly 32 MB and a tenth of a second - because an eighteen-byte code is
 * the whole of account recovery. The async form is not a stylistic preference: the synchronous one
 * runs that tenth of a second on the event loop, where a public route calls it, and every other
 * request on the server waits behind it.
 */
const derive = (code: string, salt: Buffer, length: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(code.normalize('NFKC'), salt, length, RECOVERY_SCRYPT, (error, derived) =>
      error ? reject(error) : resolve(derived)
    );
  });

export const hashRecoveryCode = async (code: string, salt = randomBytes(16)): Promise<string> => {
  const result = await derive(code, salt, 32);
  return `${salt.toString('base64url')}.${result.toString('base64url')}`;
};

export const verifyRecoveryCode = async (code: string, encoded: string): Promise<boolean> => {
  const [saltEncoded, expectedEncoded] = encoded.split('.');
  if (!saltEncoded || !expectedEncoded) return false;
  const salt = Buffer.from(saltEncoded, 'base64url');
  const expected = Buffer.from(expectedEncoded, 'base64url');
  const actual = await derive(code, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
