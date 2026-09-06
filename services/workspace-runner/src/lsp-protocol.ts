import type { Readable, Writable } from 'node:stream';

export const LSP_MESSAGE_BYTES = 8 * 1024 * 1024;
type Packet = {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** Byte framing keeps split multibyte characters from changing Content-Length. */
export class LspFramer {
  #buffer = Buffer.alloc(0);
  push(chunk: Buffer): Packet[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: Packet[] = [];
    for (;;) {
      const boundary = this.#buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (this.#buffer.length > 8192) throw new Error('Language server header exceeds its limit');
        return messages;
      }
      if (boundary > 8192) throw new Error('Language server header exceeds its limit');
      const headers = this.#buffer.subarray(0, boundary).toString('ascii');
      const lengths = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
      const length = Number(lengths[0]?.[1]);
      if (
        lengths.length !== 1 ||
        !Number.isSafeInteger(length) ||
        length < 2 ||
        length > LSP_MESSAGE_BYTES
      )
        throw new Error('Invalid language server Content-Length');
      if (this.#buffer.length < boundary + 4 + length) return messages;
      const packet: unknown = JSON.parse(
        this.#buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8')
      );
      if (
        !packet ||
        typeof packet !== 'object' ||
        !('jsonrpc' in packet) ||
        packet.jsonrpc !== '2.0'
      )
        throw new Error('Invalid language server message');
      messages.push(packet as Packet);
      this.#buffer = this.#buffer.subarray(boundary + 4 + length);
    }
  }
}

export class LspConnection {
  #nextId = 0;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  #closed: Error | undefined;
  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onRequest: (method: string, params: unknown) => unknown,
    private readonly onFailure: () => void,
    private readonly timeoutMs = 20_000
  ) {
    const framer = new LspFramer();
    input.on('data', (chunk: Buffer) => {
      try {
        for (const packet of framer.push(chunk)) this.#receive(packet);
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
        this.onFailure();
      }
    });
    input.on('end', () => {
      this.close(new Error('Language server disconnected; start a new approved session'));
      this.onFailure();
    });
    input.on('error', (error) => {
      this.close(error);
      this.onFailure();
    });
    output.on('error', (error) => {
      this.close(error);
      this.onFailure();
    });
  }
  get closed(): boolean {
    return this.#closed !== undefined;
  }
  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#pending.size >= 16)
      return Promise.reject(new Error('Language server request capacity reached'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new Error(`Language server timed out during ${method}`));
      }, this.timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  close(error = new Error('Language server session stopped')): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
  #write(packet: Packet): void {
    if (this.#closed) throw this.#closed;
    const body = Buffer.from(JSON.stringify(packet));
    if (body.length > LSP_MESSAGE_BYTES || this.output.writableLength > LSP_MESSAGE_BYTES)
      throw new Error('Language server output queue exceeds its limit');
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  #receive(packet: Packet): void {
    if (packet.method) {
      if (packet.id !== undefined) {
        let result: unknown;
        try {
          result = this.onRequest(packet.method, packet.params);
        } catch {
          this.#write({
            jsonrpc: '2.0',
            id: packet.id,
            error: { code: -32601, message: 'Unsupported language server request' }
          });
          return;
        }
        this.#write({ jsonrpc: '2.0', id: packet.id, result: result ?? null });
      } else this.onNotification(packet.method, packet.params);
      return;
    }
    if (typeof packet.id !== 'number') return;
    const pending = this.#pending.get(packet.id);
    if (!pending) return;
    this.#pending.delete(packet.id);
    clearTimeout(pending.timer);
    if (packet.error)
      pending.reject(
        new Error(String(packet.error.message ?? 'Language server request failed').slice(0, 2000))
      );
    else pending.resolve(packet.result);
  }
}
