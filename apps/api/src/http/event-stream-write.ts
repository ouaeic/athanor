import type { Writable } from 'node:stream';

/** Wait before producing more frames once the writable buffer is full. */
export async function writeEventFrame(
  output: Writable,
  frame: string,
  signal: AbortSignal,
  timeoutMs = 15_000
): Promise<boolean> {
  if (signal.aborted || output.destroyed || output.writableEnded) return false;
  try {
    if (output.write(frame)) return true;
  } catch {
    return false;
  }
  if (signal.aborted || output.destroyed || output.writableEnded) return false;
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      output.off('drain', drained);
      output.off('close', stopped);
      output.off('error', stopped);
      signal.removeEventListener('abort', stopped);
      resolve(ok);
    };
    const drained = () => finish(true);
    const stopped = () => finish(false);
    const timer = setTimeout(stopped, timeoutMs);
    timer.unref();
    output.once('drain', drained);
    output.once('close', stopped);
    output.once('error', stopped);
    signal.addEventListener('abort', stopped, { once: true });
  });
}
