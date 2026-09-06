import type { Readable, Writable } from 'node:stream';

const MAX_BYTES = 2 * 1024 * 1024;
export type DapPacket = {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: unknown;
  body?: unknown;
};
export class DapFramer {
  #buffer = Buffer.alloc(0);
  push(chunk: Buffer): DapPacket[] {
    if (this.#buffer.length + chunk.length > MAX_BYTES + 8192)
      throw Error('Debug adapter input exceeds limit');
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const packets: DapPacket[] = [];
    for (;;) {
      const boundary = this.#buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (this.#buffer.length > 8192) throw Error('Debug adapter header exceeds limit');
        return packets;
      }
      if (boundary > 8192) throw Error('Debug adapter header exceeds limit');
      const matches = [
        ...this.#buffer
          .subarray(0, boundary)
          .toString('ascii')
          .matchAll(/^content-length:\s*(\d+)\s*$/gim)
      ];
      const length = Number(matches[0]?.[1]);
      if (matches.length !== 1 || !Number.isSafeInteger(length) || length < 2 || length > MAX_BYTES)
        throw Error('Invalid debug adapter Content-Length');
      if (this.#buffer.length < boundary + 4 + length) return packets;
      const packet: unknown = JSON.parse(
        this.#buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8')
      );
      if (
        !packet ||
        typeof packet !== 'object' ||
        !('seq' in packet) ||
        typeof packet.seq !== 'number' ||
        !Number.isSafeInteger(packet.seq) ||
        !('type' in packet) ||
        !['request', 'response', 'event'].includes(String(packet.type))
      )
        throw Error('Invalid debug adapter packet');
      packets.push(packet as DapPacket);
      this.#buffer = this.#buffer.subarray(boundary + 4 + length);
    }
  }
}
export class DapConnection {
  #seq = 0;
  #closed: Error | undefined;
  #pending = new Map<
    number,
    {
      command: string;
      resolve: (body: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #reverse = 0;
  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onEvent: (event: string, body: unknown) => void,
    private readonly onRequest: (command: string, args: unknown) => Promise<unknown>,
    private readonly onFailure: (error: Error) => void,
    private readonly timeoutMs = 15_000
  ) {
    const framer = new DapFramer();
    const fail = (error: Error) => {
      if (this.#closed) return;
      this.close(error);
      onFailure(error);
    };
    input.on('data', (chunk: Buffer) => {
      try {
        for (const packet of framer.push(chunk)) this.#receive(packet);
      } catch (error) {
        fail(error instanceof Error ? error : Error(String(error)));
      }
    });
    input.on('end', () => fail(Error('Debug adapter disconnected')));
    input.on('error', fail);
    output.on('error', fail);
  }
  get closed(): boolean {
    return Boolean(this.#closed);
  }
  request(command: string, args?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#pending.size >= 16)
      return Promise.reject(Error('Debug adapter request limit reached'));
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(Error(`Debug adapter timed out during ${command}`));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(seq, { command, resolve, reject, timer });
      try {
        this.#write({ seq, type: 'request', command, arguments: args });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(seq);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  close(error = Error('Debug session stopped')): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
  #write(packet: DapPacket): void {
    if (this.#closed) throw this.#closed;
    const body = Buffer.from(JSON.stringify(packet));
    if (body.length > MAX_BYTES || this.output.writableLength > MAX_BYTES)
      throw Error('Debug adapter queue exceeds limit');
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  #receive(packet: DapPacket): void {
    if (packet.type === 'event') {
      if (typeof packet.event !== 'string') throw Error('Invalid debug adapter event');
      this.onEvent(packet.event, packet.body);
      return;
    }
    if (packet.type === 'request') {
      if (typeof packet.command !== 'string' || this.#reverse >= 4)
        throw Error('Invalid debug adapter reverse request');
      this.#reverse++;
      void this.onRequest(packet.command, packet.arguments)
        .then(
          (body) => {
            if (!this.closed)
              this.#write({
                seq: ++this.#seq,
                type: 'response',
                request_seq: packet.seq,
                command: packet.command!,
                success: true,
                body
              });
          },
          () => {
            if (!this.closed)
              this.#write({
                seq: ++this.#seq,
                type: 'response',
                request_seq: packet.seq,
                command: packet.command!,
                success: false,
                message: 'Reverse request authority refused'
              });
          }
        )
        .catch((error) => {
          this.close();
          this.onFailure(error instanceof Error ? error : Error(String(error)));
        })
        .finally(() => {
          this.#reverse--;
        });
      return;
    }
    const pending = this.#pending.get(packet.request_seq ?? -1);
    if (!pending) return;
    this.#pending.delete(packet.request_seq!);
    clearTimeout(pending.timer);
    if (packet.command !== pending.command || packet.success !== true)
      pending.reject(
        Error(String(packet.message ?? 'Debug adapter request failed').slice(0, 2000))
      );
    else pending.resolve(packet.body);
  }
}
