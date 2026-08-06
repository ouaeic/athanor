/**
 * Minimal HTTP/1.x request-head parsing for the :80 listener.
 *
 * :80 exists for exactly two reasons - ACME HTTP-01 as a fallback when TLS-ALPN-01 will not
 * cooperate, and HTTP->HTTPS redirects. It is not a general HTTP proxy: the relay reads only enough
 * to find the Host header, then forwards the raw bytes it consumed to the box unchanged.
 */

export const MAX_HTTP_HEAD_BYTES = 8192;

export interface HttpRequestHead {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly host: string | null;
  /** Byte length of the head including the terminating blank line. */
  readonly headLength: number;
}

export type HttpHeadResult =
  | { readonly status: 'need-more' }
  | { readonly status: 'ok'; readonly head: HttpRequestHead }
  | { readonly status: 'invalid'; readonly reason: string };

const REQUEST_LINE = /^([A-Z]{3,10}) (\S{1,2048}) (HTTP\/1\.[01])$/;

export const parseHttpHead = (buffered: Buffer): HttpHeadResult => {
  const terminator = buffered.indexOf('\r\n\r\n');
  if (terminator === -1) {
    if (buffered.length >= MAX_HTTP_HEAD_BYTES) {
      return { status: 'invalid', reason: 'request head too large' };
    }
    // A TLS ClientHello arriving on :80 is a common misconfiguration; fail it fast rather than
    // waiting for a CRLFCRLF that will never come.
    if (buffered.length > 0 && buffered.readUInt8(0) === 0x16) {
      return { status: 'invalid', reason: 'TLS handshake on the plaintext port' };
    }
    return { status: 'need-more' };
  }

  const headLength = terminator + 4;
  const text = buffered.toString('latin1', 0, terminator);
  const lines = text.split('\r\n');
  const requestLine = REQUEST_LINE.exec(lines[0] ?? '');
  if (requestLine === null) return { status: 'invalid', reason: 'malformed request line' };

  let host: string | null = null;
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator === -1) return { status: 'invalid', reason: 'malformed header line' };
    if (line.slice(0, separator).trim().toLowerCase() !== 'host') continue;
    // Only the first Host header counts; a second one is request smuggling bait.
    if (host !== null) return { status: 'invalid', reason: 'duplicate Host header' };
    host = line
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '');
  }

  return {
    status: 'ok',
    head: {
      method: requestLine[1] ?? '',
      target: requestLine[2] ?? '',
      version: requestLine[3] ?? '',
      host,
      headLength
    }
  };
};
