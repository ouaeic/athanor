import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DapConnection, DapFramer } from './dap-protocol.js';
const encoded = (body: unknown) => {
  const value = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`Content-Length: ${value.length}\r\n\r\n`), value]);
};
describe('debug adapter wire contract', () => {
  it('frames fragmented multibyte packets and rejects duplicate lengths or oversize messages', () => {
    const packet = { seq: 1, type: 'event', event: 'output', body: { output: '🌱' } };
    const bytes = encoded(packet),
      framer = new DapFramer();
    const split = bytes.length - 4;
    expect(framer.push(bytes.subarray(0, split))).toEqual([]);
    expect(framer.push(bytes.subarray(split))).toEqual([packet]);
    expect(() =>
      new DapFramer().push(Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'))
    ).toThrow('Content-Length');
    expect(() => new DapFramer().push(Buffer.from('Content-Length: 999999999\r\n\r\n'))).toThrow(
      'Content-Length'
    );
  });
  it('matches command identity, rejects reverse execution and settles pending requests on disconnect', async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    const frames = new DapFramer();
    const sent: ReturnType<DapFramer['push']> = [];
    output.on('data', (chunk: Buffer) => sent.push(...frames.push(chunk)));
    const failure = vi.fn();
    const connection = new DapConnection(
      input,
      output,
      () => undefined,
      async () => {
        throw Error('runInTerminal refused');
      },
      failure,
      100
    );
    const request = connection.request('initialize', {});
    expect(sent.length).toBe(1);
    input.write(
      encoded({
        seq: 9,
        type: 'response',
        request_seq: sent[0]!.seq,
        command: 'launch',
        success: true
      })
    );
    await expect(request).rejects.toThrow('failed');
    input.write(
      encoded({ seq: 10, type: 'request', command: 'runInTerminal', arguments: { args: ['sh'] } })
    );
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'response', request_seq: 10, success: false })
      )
    );
    const pending = connection.request('stackTrace', {});
    input.end();
    await expect(pending).rejects.toThrow('disconnected');
    expect(failure).toHaveBeenCalledOnce();
  });
});
