/**
 * TLS ClientHello reassembly and SNI/ALPN extraction.
 *
 * The single most common bug in naive SNI proxies is parsing only the first TCP segment. A
 * ClientHello routinely spans multiple TLS records and multiple TCP segments once you have large
 * key shares, post-quantum groups or GREASE padding - and it fails intermittently, for some clients
 * only, which is the worst possible failure mode. So: buffer whole records, concatenate their
 * fragments, and only parse once a complete handshake message is present.
 */

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const EXTENSION_ALPN = 0x0010;
const SNI_TYPE_HOST_NAME = 0x00;

/** Hard ceiling on buffered pre-authentication bytes per connection. */
export const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

export interface ClientHelloInfo {
  readonly serverName: string | null;
  readonly alpnProtocols: readonly string[];
}

export type ClientHelloResult =
  | { readonly status: 'need-more' }
  | { readonly status: 'ok'; readonly info: ClientHelloInfo }
  | { readonly status: 'invalid'; readonly reason: string };

class Reader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  skip(count: number): void {
    if (count < 0 || this.remaining < count) throw new RangeError('short read');
    this.offset += count;
  }

  u8(): number {
    if (this.remaining < 1) throw new RangeError('short read');
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    if (this.remaining < 2) throw new RangeError('short read');
    const value = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  bytes(count: number): Buffer {
    if (count < 0 || this.remaining < count) throw new RangeError('short read');
    const slice = this.buf.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  /** Reads a vector with an 8- or 16-bit length prefix. */
  vector(prefixBytes: 1 | 2): Buffer {
    return this.bytes(prefixBytes === 1 ? this.u8() : this.u16());
  }
}

/**
 * Concatenates the fragments of the complete handshake records at the head of `buffered`.
 *
 * Collection stops at the first non-handshake record rather than failing: a TLS 1.3 client sends a
 * dummy ChangeCipherSpec immediately after its ClientHello for middlebox compatibility (RFC 8446
 * D.4), and with 0-RTT it may follow that with early application data. Those records can share a
 * TCP segment with the ClientHello, and treating them as corruption would refuse real clients
 * intermittently, depending only on how the sender happened to coalesce its writes.
 */
const collectHandshakeFragments = (
  buffered: Buffer
): { readonly complete: boolean; readonly body: Buffer } | { readonly invalid: string } => {
  const fragments: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= buffered.length) {
    if (buffered.readUInt8(offset) !== RECORD_HANDSHAKE) break;
    const length = buffered.readUInt16BE(offset + 3);
    if (length === 0 || length > 16384 + 256) return { invalid: 'implausible record length' };
    if (offset + 5 + length > buffered.length) break;
    fragments.push(buffered.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  if (fragments.length === 0) return { complete: false, body: Buffer.alloc(0) };
  return { complete: true, body: Buffer.concat(fragments) };
};

const parseExtensions = (reader: Reader): ClientHelloInfo => {
  let serverName: string | null = null;
  const alpnProtocols: string[] = [];
  const extensions = new Reader(reader.vector(2));
  while (extensions.remaining >= 4) {
    const type = extensions.u16();
    const body = new Reader(extensions.vector(2));
    if (type === EXTENSION_SERVER_NAME && serverName === null) {
      const list = new Reader(body.vector(2));
      while (list.remaining >= 3) {
        const nameType = list.u8();
        const name = list.vector(2);
        // Only host_name is defined, and only the first one is meaningful (RFC 6066 3).
        if (nameType === SNI_TYPE_HOST_NAME) {
          serverName = name.toString('ascii').toLowerCase();
          break;
        }
      }
    } else if (type === EXTENSION_ALPN) {
      const list = new Reader(body.vector(2));
      while (list.remaining >= 1) {
        alpnProtocols.push(list.vector(1).toString('ascii'));
      }
    }
  }
  return { serverName, alpnProtocols };
};

export const parseClientHello = (buffered: Buffer): ClientHelloResult => {
  if (buffered.length === 0) return { status: 'need-more' };
  if (buffered.readUInt8(0) !== RECORD_HANDSHAKE) {
    return { status: 'invalid', reason: 'not a TLS handshake record' };
  }

  const collected = collectHandshakeFragments(buffered);
  if ('invalid' in collected) return { status: 'invalid', reason: collected.invalid };
  if (!collected.complete) return { status: 'need-more' };

  const body = collected.body;
  if (body.length < 4) return { status: 'need-more' };
  if (body.readUInt8(0) !== HANDSHAKE_CLIENT_HELLO) {
    return { status: 'invalid', reason: 'first handshake message is not a ClientHello' };
  }
  const handshakeLength = body.readUIntBE(1, 3);
  if (body.length < 4 + handshakeLength) return { status: 'need-more' };

  try {
    const reader = new Reader(body.subarray(4, 4 + handshakeLength));
    reader.skip(2); // legacy_version
    reader.skip(32); // random
    reader.vector(1); // legacy_session_id
    reader.vector(2); // cipher_suites
    reader.vector(1); // legacy_compression_methods
    if (reader.remaining < 2) {
      // A ClientHello with no extensions at all: valid TLS, but unroutable here.
      return { status: 'ok', info: { serverName: null, alpnProtocols: [] } };
    }
    return { status: 'ok', info: parseExtensions(reader) };
  } catch {
    return { status: 'invalid', reason: 'malformed ClientHello' };
  }
};
