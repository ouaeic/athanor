import { ApiError, isNativeClient } from './client.js';

export async function requireDownloadSupport(): Promise<void> {
  if (!isNativeClient()) return;
  const { nativeCapabilities } = await import('./native.js');
  let supported: boolean;
  try {
    supported = (await nativeCapabilities())?.downloads === true;
  } catch {
    throw new ApiError(
      'download_support_unavailable',
      'Download support could not be checked. Reopen garden, or open your workspace in a web browser to save this file.'
    );
  }
  if (!supported)
    throw new ApiError(
      'downloads_unsupported',
      'This app cannot save downloads on this device. Open your garden workspace in a web browser or the desktop app to save this file.'
    );
}
