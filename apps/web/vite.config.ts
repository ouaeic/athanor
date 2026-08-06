import { gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * What the browser must download before it can paint the first screen: the entry chunk plus
 * everything it statically imports, gzipped. Lazy chunks are excluded because nothing waits on
 * them. A warning here would be worthless — a bundle regression is only ever noticed if it stops
 * the build — so this fails instead.
 */
const EAGER_BUDGET_BYTES = 145_000;

/**
 * The same walk, twice used: it measures the first paint, and it writes the hashed names down for
 * the service worker, which cannot guess them and precached an index.html it could not run.
 */
const eagerBundleGraph = (): Plugin => ({
  name: 'athanor-eager-bundle-graph',
  apply: 'build',
  generateBundle(_options, bundle) {
    const byFileName = new Map(Object.values(bundle).map((item) => [item.fileName, item]));
    const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry);
    if (entry?.type !== 'chunk') return;

    const eager = new Set<string>();
    const walk = (fileName: string): void => {
      if (eager.has(fileName)) return;
      eager.add(fileName);
      const chunk = byFileName.get(fileName);
      if (chunk?.type !== 'chunk') return;
      for (const imported of chunk.imports) walk(imported);
      for (const css of chunk.viteMetadata?.importedCss ?? []) eager.add(css);
    };
    walk(entry.fileName);

    let total = 0;
    const parts: string[] = [];
    for (const fileName of eager) {
      const item = byFileName.get(fileName);
      const source =
        item?.type === 'chunk' ? item.code : typeof item?.source === 'string' ? item.source : '';
      if (!source) continue;
      const size = gzipSync(source).byteLength;
      total += size;
      parts.push(`${fileName} ${(size / 1000).toFixed(1)} kB`);
    }
    const report = `eager bundle ${(total / 1000).toFixed(1)} kB gzip (budget ${(
      EAGER_BUDGET_BYTES / 1000
    ).toFixed(1)} kB)\n  ${parts.sort().join('\n  ')}`;
    if (total > EAGER_BUDGET_BYTES)
      this.error(
        `${report}\nMove the new weight behind a dynamic import, or raise EAGER_BUDGET_BYTES deliberately.`
      );
    this.info?.(report);

    this.emitFile({
      type: 'asset',
      fileName: 'asset-manifest.json',
      source: `${JSON.stringify(
        { eager: [...eager].sort().map((fileName) => `/${fileName}`) },
        null,
        2
      )}\n`
    });
  }
});

export default defineConfig({
  plugins: [react(), eagerBundleGraph()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: { host: 'localhost', clientPort: 5173 },
    proxy: { '/v1': 'http://127.0.0.1:4100', '/healthz': 'http://127.0.0.1:4100' }
  },
  build: {
    sourcemap: true,
    // These vendors change on their own schedule rather than ours. Splitting them stops a deploy
    // from invalidating React for everyone who already has it, and keeps the eager/lazy split
    // legible in the build report.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-katex', test: /node_modules[\\/](katex|rehype-katex)[\\/]/ },
            {
              name: 'vendor-highlight',
              test: /node_modules[\\/](highlight\.js|rehype-highlight|lowlight)[\\/]/
            }
          ]
        }
      }
    }
  }
});
