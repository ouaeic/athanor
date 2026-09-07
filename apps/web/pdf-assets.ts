import type { Plugin } from 'vite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function pdfAssets(): Plugin {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const assets = new Map<string, string>();
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (name.isFile())
        assets.set(`pdfjs/${directory}/${name.name}`, path.join(root, directory, name.name));
    }
  }
  return {
    name: 'garden-pdf-assets',
    generateBundle() {
      for (const [fileName, source] of assets)
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = assets.get(((request.url ?? '').split('?')[0] ?? '').replace(/^\//, ''));
        if (!asset) return next();
        response.setHeader(
          'Content-Type',
          asset.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
        );
        response.end(readFileSync(asset));
      });
    }
  };
}
