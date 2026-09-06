import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNativeClient } from './client.js';
import type * as ClientModule from './client.js';
import { nativeCapabilities } from './native.js';
import { stepUp } from './auth.js';
import { download } from './management.js';

vi.mock('./client.js', async (original) => ({
  ...(await original<typeof ClientModule>()),
  isNativeClient: vi.fn()
}));
vi.mock('./native.js', () => ({ nativeCapabilities: vi.fn() }));
vi.mock('./auth.js', () => ({ stepUp: vi.fn() }));

describe('download delivery capabilities', () => {
  const fetcher = vi.fn();
  const click = vi.fn();
  const revoke = vi.fn();
  const anchor = { href: '', download: '', click };
  const createElement = vi.fn(() => anchor);
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('document', { createElement });
    createElement.mockReturnValue(anchor);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
    fetcher.mockResolvedValue(new Response('content'));
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses unsupported native downloads before authentication, content reads or browser delivery', async () => {
    vi.mocked(isNativeClient).mockReturnValue(true);
    vi.mocked(nativeCapabilities).mockResolvedValue({
      downloads: false,
      folderPicker: false,
      notifications: true,
      deepLinkEvents: false
    });
    const pending = download('/v1/privacy/export', 'account.json', true);
    await expect(pending).rejects.toMatchObject({ code: 'downloads_unsupported' });
    await expect(pending).rejects.toThrow('web browser');
    expect(nativeCapabilities).toHaveBeenCalledOnce();
    expect(stepUp).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
  });

  it('fails closed when native support is missing or cannot be checked', async () => {
    vi.mocked(isNativeClient).mockReturnValue(true);
    vi.mocked(nativeCapabilities)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Bridge lost'));
    await expect(download('/v1/artifacts/file/content', 'result.txt')).rejects.toMatchObject({
      code: 'downloads_unsupported'
    });
    await expect(download('/v1/artifacts/file/content', 'result.txt')).rejects.toMatchObject({
      code: 'download_support_unavailable'
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('delivers supported native files and releases their temporary URL', async () => {
    vi.mocked(isNativeClient).mockReturnValue(true);
    vi.mocked(nativeCapabilities).mockResolvedValue({
      downloads: true,
      folderPicker: true,
      notifications: true,
      deepLinkEvents: true
    });
    await download('/v1/artifacts/file/content', 'result.txt');
    expect(fetcher).toHaveBeenCalledWith('/v1/artifacts/file/content', { credentials: 'include' });
    expect(anchor.download).toBe('result.txt');
    expect(anchor.href).toBe('blob:download');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(revoke).toHaveBeenCalledWith('blob:download');
  });

  it('preserves browser exports with verification and exposes failed content reads', async () => {
    vi.mocked(isNativeClient).mockReturnValue(false);
    await download('/v1/privacy/export', 'account.json', true);
    expect(nativeCapabilities).not.toHaveBeenCalled();
    expect(stepUp).toHaveBeenCalledOnce();
    expect(vi.mocked(stepUp).mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder[0]!
    );
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'file_missing', message: 'File is unavailable' } }),
        { status: 404 }
      )
    );
    await expect(download('/v1/artifacts/missing/content', 'missing.txt')).rejects.toMatchObject({
      code: 'file_missing'
    });
    expect(click).toHaveBeenCalledOnce();
  });
});
