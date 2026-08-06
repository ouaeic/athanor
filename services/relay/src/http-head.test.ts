import { describe, expect, it } from 'vitest';
import { MAX_HTTP_HEAD_BYTES, parseHttpHead } from './http-head.js';

const head = (text: string): Buffer => Buffer.from(text, 'latin1');

describe('parseHttpHead', () => {
  it('reads the request line and Host', () => {
    const result = parseHttpHead(
      head('GET /.well-known/acme-challenge/tok HTTP/1.1\r\nHost: abc.relay.example\r\n\r\n')
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.head.method).toBe('GET');
    expect(result.head.target).toBe('/.well-known/acme-challenge/tok');
    expect(result.head.host).toBe('abc.relay.example');
  });

  it('lowercases the host and drops the port', () => {
    const result = parseHttpHead(head('GET / HTTP/1.1\r\nHOST: ABC.Relay.Example:8080\r\n\r\n'));
    expect(result.status === 'ok' && result.head.host).toBe('abc.relay.example');
  });

  it('waits for the full head rather than routing on a partial one', () => {
    expect(parseHttpHead(head('GET / HTTP/1.1\r\nHost: abc.relay')).status).toBe('need-more');
    expect(parseHttpHead(head('')).status).toBe('need-more');
  });

  it('reports the head length so the bytes can be replayed to the box unchanged', () => {
    const raw = 'GET / HTTP/1.1\r\nHost: abc.relay.example\r\n\r\n';
    const result = parseHttpHead(head(raw));
    expect(result.status === 'ok' && result.head.headLength).toBe(raw.length);
  });

  it('refuses a second Host header instead of picking one', () => {
    // Two Host headers is request smuggling bait: the relay and the box could disagree on the
    // route. Refusing is the only answer that cannot be split.
    const result = parseHttpHead(
      head('GET / HTTP/1.1\r\nHost: abc.relay.example\r\nHost: evil.example\r\n\r\n')
    );
    expect(result.status).toBe('invalid');
  });

  it('refuses a head larger than the cap instead of buffering for it', () => {
    const padding = 'X-Pad: '.padEnd(MAX_HTTP_HEAD_BYTES + 16, 'a');
    const result = parseHttpHead(head(`GET / HTTP/1.1\r\n${padding}`));
    expect(result.status).toBe('invalid');
  });

  it('fails fast on TLS arriving at the plaintext port', () => {
    const result = parseHttpHead(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01]));
    expect(result.status === 'invalid' && result.reason).toContain('TLS handshake');
  });

  it('rejects a malformed request line or header line', () => {
    expect(parseHttpHead(head('nonsense\r\n\r\n')).status).toBe('invalid');
    expect(parseHttpHead(head('GET / HTTP/2.0\r\nHost: a\r\n\r\n')).status).toBe('invalid');
    expect(parseHttpHead(head('GET / HTTP/1.1\r\nnot-a-header\r\n\r\n')).status).toBe('invalid');
  });

  it('reports a missing Host rather than inventing one', () => {
    const result = parseHttpHead(head('GET / HTTP/1.0\r\n\r\n'));
    expect(result.status === 'ok' && result.head.host).toBeNull();
  });
});
