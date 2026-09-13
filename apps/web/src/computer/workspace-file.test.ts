import { afterEach, expect, it, vi } from 'vitest';
import { readWorkspaceFile, saveWorkspaceFile } from './workspace-file';
import type { WorkspaceTextFile } from './workspace-file';

afterEach(() => vi.unstubAllGlobals());
const file: WorkspaceTextFile = {
  path: 'workspace/a & b.py',
  text: 'new\n',
  original: 'old\n',
  sha: 'read-version',
  truncated: false,
  next: null,
  start: 1,
  end: 1,
  binary: false
};

it('binds a save to the exact workspace, path and version that was read', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  await saveWorkspaceFile('isolated-child', file);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fetch.mock.calls[0]!;
  const parsed = new URL(url instanceof Request ? url.url : url, 'http://localhost');
  expect(parsed.pathname).toBe('/v1/workspaces/isolated-child/file');
  expect(parsed.searchParams.get('path')).toBe(file.path);
  expect(parsed.searchParams.get('expectSha256')).toBe('read-version');
  expect(request?.method).toBe('PUT');
  expect(await new Response(request?.body).text()).toBe('new\n');
});

it('refuses partial, binary and unversioned replacement before sending any write', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  for (const patch of [{ truncated: true }, { binary: true }, { sha: null }])
    await expect(saveWorkspaceFile('owner-workspace', { ...file, ...patch })).rejects.toThrow(
      'complete text file'
    );
  expect(fetch).not.toHaveBeenCalled();
});

it('retains window coverage even when the server reaches the final line', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response('last line\n', {
        headers: { 'x-content-sha256': 'whole-file', 'x-end-line': '40', 'x-truncated': 'false' }
      })
    )
  );
  const read = await readWorkspaceFile('workspace', file.path, { start: 40, windowed: true });
  expect(read).toMatchObject({
    start: 40,
    end: 40,
    truncated: true,
    next: null,
    text: 'last line\n'
  });
  await expect(saveWorkspaceFile('workspace', read)).rejects.toThrow('complete text file');
});

it('does not retry a conflicting replacement or turn an unreadable file into editable text', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xfe]), { headers: { 'x-content-sha256': 'bytes' } })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'file_changed', message: 'File changed on disk' } }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
  vi.stubGlobal('fetch', fetch);
  expect(await readWorkspaceFile('workspace', file.path)).toMatchObject({ binary: true, text: '' });
  await expect(saveWorkspaceFile('workspace', file)).rejects.toThrow('File changed on disk');
  expect(fetch).toHaveBeenCalledTimes(2);
});
