import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LspConnection, LspFramer, LSP_MESSAGE_BYTES } from './lsp-protocol.js';

const frame = (packet: unknown) => {
  const body = Buffer.from(JSON.stringify(packet));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};
describe('language server framing and requests', () => {
  it('reassembles split UTF-8 frames and multiple messages without using character length', () => {
    const first = { jsonrpc: '2.0', method: 'note', params: { text: '🌿 café' } };
    const second = { jsonrpc: '2.0', id: 1, result: [] };
    const bytes = Buffer.concat([frame(first), frame(second)]);
    const framer = new LspFramer();
    const messages = [];
    for (const byte of bytes) messages.push(...framer.push(Buffer.from([byte])));
    expect(messages).toEqual([first, second]);
  });
  it('refuses oversized, ambiguous and malformed frames before accepting a payload', () => {
    for (const header of [
      `Content-Length: ${LSP_MESSAGE_BYTES + 1}\r\n\r\n`,
      'Content-Length: 2\r\nContent-Length: 3\r\n\r\n',
      'Content-Length: -1\r\n\r\n'
    ]) {
      expect(() => new LspFramer().push(Buffer.from(header))).toThrow('Content-Length');
    }
    expect(() => new LspFramer().push(Buffer.alloc(8193, 65))).toThrow('header');
  });
  it('matches response IDs, cancels timed-out work and rejects all pending requests on disconnect', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const packets: unknown[] = [];
    const framer = new LspFramer();
    output.on('data', (chunk: Buffer) => packets.push(...framer.push(chunk)));
    const connection = new LspConnection(
      input,
      output,
      () => undefined,
      () => null,
      () => undefined,
      15
    );
    const first = connection.request('first');
    const second = connection.request('second');
    input.write(frame({ jsonrpc: '2.0', id: 2, result: 'second answer' }));
    input.write(frame({ jsonrpc: '2.0', id: 1, result: 'first answer' }));
    await expect(first).resolves.toBe('first answer');
    await expect(second).resolves.toBe('second answer');
    await expect(connection.request('slow')).rejects.toThrow('timed out');
    expect(packets).toContainEqual({
      jsonrpc: '2.0',
      method: '$/cancelRequest',
      params: { id: 3 }
    });
    const pending = connection.request('disconnected');
    connection.close();
    await expect(pending).rejects.toThrow('stopped');
    await expect(connection.request('late')).rejects.toThrow('stopped');
  });
});
