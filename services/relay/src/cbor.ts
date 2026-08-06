/**
 * A deliberately tiny, deterministic CBOR subset (RFC 8949 core deterministic encoding).
 *
 * Only what the bind frame needs: unsigned integers, byte strings, text strings, booleans, null,
 * arrays and string-keyed maps. Hand-rolling this rather than taking a dependency keeps the relay
 * dependency-light and, more importantly, keeps the decoder's behaviour on hostile input something
 * we can actually read in one sitting - the box runs this decoder against bytes from a relay it
 * may not fully trust.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | { readonly [key: string]: CborValue };

const MAJOR_UINT = 0;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_SIMPLE = 7;

const head = (major: number, argument: number): Buffer => {
  if (!Number.isSafeInteger(argument) || argument < 0) {
    throw new Error('cbor: argument must be a non-negative safe integer');
  }
  const base = major << 5;
  if (argument < 24) return Buffer.from([base | argument]);
  if (argument <= 0xff) return Buffer.from([base | 24, argument]);
  if (argument <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = base | 25;
    b.writeUInt16BE(argument, 1);
    return b;
  }
  if (argument <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = base | 26;
    b.writeUInt32BE(argument, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = base | 27;
  b.writeBigUInt64BE(BigInt(argument), 1);
  return b;
};

/**
 * Deterministic map key ordering per RFC 8949 4.2.1: shorter encoded key first, then bytewise.
 * Determinism matters because the bind frame is the one place where a future signature or a test
 * fixture would otherwise depend on JavaScript object property order.
 */
const compareKeys = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return a.length - b.length;
  return Buffer.compare(a, b);
};

export const encodeCbor = (value: CborValue): Buffer => {
  if (value === null) return Buffer.from([(MAJOR_SIMPLE << 5) | 22]);
  if (typeof value === 'boolean') {
    return Buffer.from([(MAJOR_SIMPLE << 5) | (value ? 21 : 20)]);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('cbor: only non-negative safe integers are supported');
    }
    return head(MAJOR_UINT, value);
  }
  if (typeof value === 'string') {
    const utf8 = Buffer.from(value, 'utf8');
    return Buffer.concat([head(MAJOR_TEXT, utf8.length), utf8]);
  }
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(MAJOR_BYTES, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => encodeCbor(item as CborValue));
    return Buffer.concat([head(MAJOR_ARRAY, value.length), ...items]);
  }
  const record = value as { readonly [key: string]: CborValue };
  const entries = Object.keys(record).map((key) => {
    const encodedKey = encodeCbor(key);
    // Object.keys never yields undefined for its own keys; the cast keeps noUncheckedIndexedAccess quiet.
    return { encodedKey, encodedValue: encodeCbor(record[key] as CborValue) };
  });
  entries.sort((a, b) => compareKeys(a.encodedKey, b.encodedKey));
  return Buffer.concat([
    head(MAJOR_MAP, entries.length),
    ...entries.flatMap((entry) => [entry.encodedKey, entry.encodedValue])
  ]);
};

interface Cursor {
  readonly buf: Buffer;
  offset: number;
  depth: number;
}

const MAX_DEPTH = 8;

const need = (cursor: Cursor, count: number): void => {
  if (cursor.offset + count > cursor.buf.length) throw new Error('cbor: truncated input');
};

const readArgument = (cursor: Cursor, additional: number): number => {
  if (additional < 24) return additional;
  if (additional === 24) {
    need(cursor, 1);
    const v = cursor.buf.readUInt8(cursor.offset);
    cursor.offset += 1;
    return v;
  }
  if (additional === 25) {
    need(cursor, 2);
    const v = cursor.buf.readUInt16BE(cursor.offset);
    cursor.offset += 2;
    return v;
  }
  if (additional === 26) {
    need(cursor, 4);
    const v = cursor.buf.readUInt32BE(cursor.offset);
    cursor.offset += 4;
    return v;
  }
  if (additional === 27) {
    need(cursor, 8);
    const v = cursor.buf.readBigUInt64BE(cursor.offset);
    cursor.offset += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer out of range');
    return Number(v);
  }
  throw new Error('cbor: indefinite lengths are not supported');
};

const decodeValue = (cursor: Cursor): CborValue => {
  if (cursor.depth > MAX_DEPTH) throw new Error('cbor: nesting too deep');
  need(cursor, 1);
  const initial = cursor.buf.readUInt8(cursor.offset);
  cursor.offset += 1;
  const major = initial >> 5;
  const additional = initial & 0x1f;

  switch (major) {
    case MAJOR_UINT:
      return readArgument(cursor, additional);
    case MAJOR_BYTES: {
      const length = readArgument(cursor, additional);
      need(cursor, length);
      const bytes = Buffer.from(cursor.buf.subarray(cursor.offset, cursor.offset + length));
      cursor.offset += length;
      return bytes;
    }
    case MAJOR_TEXT: {
      const length = readArgument(cursor, additional);
      need(cursor, length);
      const text = cursor.buf.toString('utf8', cursor.offset, cursor.offset + length);
      cursor.offset += length;
      return text;
    }
    case MAJOR_ARRAY: {
      const length = readArgument(cursor, additional);
      const items: CborValue[] = [];
      cursor.depth += 1;
      for (let i = 0; i < length; i += 1) items.push(decodeValue(cursor));
      cursor.depth -= 1;
      return items;
    }
    case MAJOR_MAP: {
      const length = readArgument(cursor, additional);
      const record: Record<string, CborValue> = {};
      cursor.depth += 1;
      for (let i = 0; i < length; i += 1) {
        const key = decodeValue(cursor);
        if (typeof key !== 'string') throw new Error('cbor: map keys must be text strings');
        record[key] = decodeValue(cursor);
      }
      cursor.depth -= 1;
      return record;
    }
    case MAJOR_SIMPLE: {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new Error('cbor: unsupported simple value');
    }
    default:
      throw new Error('cbor: unsupported major type');
  }
};

export const decodeCbor = (input: Uint8Array): CborValue => {
  const cursor: Cursor = { buf: Buffer.from(input), offset: 0, depth: 0 };
  const value = decodeValue(cursor);
  if (cursor.offset !== cursor.buf.length) throw new Error('cbor: trailing bytes');
  return value;
};
