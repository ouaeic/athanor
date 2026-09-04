import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The share viewer: the page a `/v1/shares/<id>#<key>` link opens, built on its own.
 *
 * A separate configuration rather than a second entry in `vite.config.ts`, for two reasons that
 * are really one. The app's build measures its first paint and its first reply from the app's own
 * entry and writes the eager set into a manifest the service worker precaches; a second entry in
 * that graph would share hashed vendor chunks with it, and the viewer page - served by the API
 * from `/v1/shares/assets/` because that is the one prefix the service worker hands to the network
 * - would then reference chunks that live under `/assets/` and are not the API's to serve. Built
 * here, the viewer is one script and one stylesheet with fixed names, nothing shared, nothing
 * hashed: the API reads the two files, stamps their digest into the page, and serves them.
 *
 * `inlineDynamicImports` is what keeps it one file. The viewer has no dynamic import of its own
 * today; the setting is here so that a dependency that grows one cannot quietly turn the viewer
 * into a set of chunks the page does not know how to name.
 */
export default defineConfig({
  plugins: [react()],
  // The app's icons, manifest and service worker belong to the app's build; the viewer's directory
  // holds the two files the API serves and nothing that could be mistaken for a third.
  publicDir: false,
  build: {
    outDir: 'dist/share',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: { share: 'src/share-viewer/main.tsx' },
      output: {
        entryFileNames: 'share.js',
        assetFileNames: 'share[extname]',
        inlineDynamicImports: true
      }
    }
  }
});
