import { constants } from 'node:fs';
import { lstat, open, opendir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { assertUserDataPath, withWorkspaceDirectory } from './files.js';

const alreadyCompressed = /\.(?:gz|bz2|xz|zip|zst|bam|cram|png|jpe?g|mp4|webm|parquet)$/i;

/** Stream the actual tree; memory holds ZIP metadata, never the files or a temporary archive. */
export const directoryArchive = async (root: string, requested: string): Promise<Readable> => {
  const relative = assertUserDataPath(root, requested);
  await withWorkspaceDirectory(root, relative, false, async () => {});
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const lifetime = new AbortController();
  let active: Readable | undefined;
  zip.on('error', (error: Error) => output.destroy(error));
  output.once('close', () => {
    lifetime.abort();
    active?.destroy(new Error('Directory download closed'));
  });
  const check = () => lifetime.signal.throwIfAborted();
  const drain = async () => {
    check();
    // The ZIP writer emits directory records synchronously, so those also respect backpressure.
    if ((output as Readable & { writableNeedDrain: boolean }).writableNeedDrain)
      await once(output, 'drain', { signal: lifetime.signal });
  };
  const visit = async (directory: string, name: string): Promise<void> => {
    check();
    await withWorkspaceDirectory(root, directory, false, async (anchored, held) => {
      const before = held ? await held.stat() : await lstat(anchored);
      zip.addEmptyDirectory(name, { mode: before.mode, mtime: before.mtime });
      await drain();
      for await (const entry of await opendir(anchored, { bufferSize: 32 })) {
        check();
        if (entry.name.includes('\\'))
          throw new Error('ZIP cannot preserve a filename containing a backslash');
        const filePath = path.join(anchored, entry.name);
        const member = `${name}/${entry.name}`;
        const stat = await lstat(filePath);
        if (stat.isDirectory()) await visit(path.join(directory, entry.name), member);
        else if (stat.isSymbolicLink()) {
          // Preserve the link itself without opening its target, including links outside this tree.
          zip.addBuffer(Buffer.from(await readlink(filePath)), member, {
            mode: stat.mode,
            mtime: stat.mtime,
            compress: false
          });
        } else if (stat.isFile()) {
          const handle = await open(
            filePath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
              throw new Error('A directory member changed while opening the download');
            const stream = Readable.from(
              (async function* () {
                const bytes = handle.createReadStream({
                  autoClose: false,
                  start: 0,
                  end: Math.max(0, opened.size - 1)
                });
                try {
                  if (opened.size)
                    for await (const chunk of bytes) {
                      check();
                      yield chunk;
                    }
                  else bytes.destroy();
                  const after = await handle.stat();
                  if (
                    after.size !== opened.size ||
                    after.mtimeMs !== opened.mtimeMs ||
                    after.ctimeMs !== opened.ctimeMs
                  )
                    throw new Error(
                      'A file changed during download. Retry after its writer has finished.'
                    );
                } finally {
                  bytes.destroy();
                }
              })()
            );
            active = stream;
            const done = finished(stream, { cleanup: true });
            zip.addReadStream(stream, member, {
              size: opened.size,
              mode: opened.mode,
              mtime: opened.mtime,
              compressionLevel: alreadyCompressed.test(entry.name) ? 0 : 1
            });
            await done;
          } finally {
            active = undefined;
            await handle.close();
          }
        } else throw new Error(`ZIP cannot include this special file: ${member}`);
        await drain();
      }
      const after = held ? await held.stat() : await lstat(anchored);
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error(
          'The directory changed during download. Retry after its writer has finished.'
        );
    });
  };
  void visit(relative, path.basename(relative))
    .then(() => {
      check();
      zip.end();
    })
    .catch((error: unknown) => {
      output.destroy(error instanceof Error ? error : new Error('Directory archive failed'));
    });
  return output;
};
