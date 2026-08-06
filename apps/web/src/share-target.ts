const SHARE_CACHE = 'athanor-shares-v1';
const SHARE_PREFIX = '/__athanor-share/';

interface SharedFile {
  name: string;
  type: string;
  url: string;
}

interface SharedManifest {
  title?: string;
  text?: string;
  url?: string;
  files: SharedFile[];
  expiresAt?: number;
}

export interface SharedPayload {
  text: string;
  files: File[];
}

export const consumeSharedPayload = async (id: string): Promise<SharedPayload | undefined> => {
  if (!('caches' in window) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const cache = await caches.open(SHARE_CACHE);
  const manifestUrl = `${SHARE_PREFIX}${id}/manifest`;
  const response = await cache.match(manifestUrl);
  if (!response) return undefined;
  const manifest = (await response.json()) as SharedManifest;
  if (!manifest.expiresAt || manifest.expiresAt <= Date.now()) {
    for (const request of await cache.keys()) {
      if (new URL(request.url).pathname.startsWith(`${SHARE_PREFIX}${id}/`))
        await cache.delete(request);
    }
    return undefined;
  }
  const files: File[] = [];
  for (const item of manifest.files ?? []) {
    if (!item.url.startsWith(`${SHARE_PREFIX}${id}/`)) continue;
    const fileResponse = await cache.match(item.url);
    if (!fileResponse) continue;
    files.push(
      new File([await fileResponse.blob()], item.name, {
        type: item.type || fileResponse.headers.get('content-type') || 'application/octet-stream'
      })
    );
    await cache.delete(item.url);
  }
  await cache.delete(manifestUrl);
  const text = [manifest.title, manifest.text, manifest.url].filter(Boolean).join('\n');
  return { text, files };
};
