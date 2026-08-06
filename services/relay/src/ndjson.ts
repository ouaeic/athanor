/**
 * Line-delimited JSON reader with a hard cap on how much a peer can make us buffer.
 *
 * Control traffic is tiny; the cap exists so a peer cannot pin memory by opening a control stream
 * and writing a gigabyte with no newline in it.
 */
export class NdjsonReader {
  private buffer = '';
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = 8192) {
    this.maxLineBytes = maxLineBytes;
  }

  /**
   * Returns the parsed values in this chunk. Throws on an over-long line or invalid JSON so the
   * caller can treat it as a protocol error and tear the session down.
   */
  push(chunk: Buffer): unknown[] {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > this.maxLineBytes) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1 || newline > this.maxLineBytes) {
        throw new Error('control line exceeds maximum length');
      }
    }
    const values: unknown[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) values.push(JSON.parse(line));
      newline = this.buffer.indexOf('\n');
    }
    return values;
  }
}
