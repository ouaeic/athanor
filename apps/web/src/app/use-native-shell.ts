import { useEffect, useState } from 'react';
import { nativeBridge } from '../native.js';

/**
 * Whether the packaged shell can hand this window a folder, asked once and answered from build
 * facts rather than guessed.
 *
 * The in-page deep-link listener that used to sit beside this is gone. It read
 * `window.__TAURI__.deepLink`, which does not exist in this app — `withGlobalTauri` is false and no
 * deep-link plugin is bundled — so it could never fire, and the shell now says as much
 * (`deepLinkEvents: false`) rather than leaving the page to find out by never being called. Deep
 * links themselves still work: the shell navigates the window to `origin/?task=<id>` and the
 * bootstrap reads that query. What it costs is a document reload, which is a fact about the shell.
 */
export const useNativeFolderPicker = (): boolean => {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!nativeBridge.available()) return;
    void nativeBridge
      .capabilities()
      .then((capabilities) => setAvailable(capabilities.folderPicker))
      .catch(() => setAvailable(false));
  }, []);
  return available;
};
