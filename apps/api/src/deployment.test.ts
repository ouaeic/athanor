/**
 * What the box in front of the API is configured to do.
 *
 * The server block is deployed verbatim by the installer, and the two things asserted here are
 * invisible from every other test: nothing in the app can tell that its responses crossed the wire
 * uncompressed, or that a phone re-downloaded a bundle it already had. They are checked as text
 * because the alternative is running nginx, and the alternative to checking them at all is finding
 * out from a slow phone.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const nginxConf = async (): Promise<string> =>
  readFile(fileURLToPath(new URL('../../../infra/native/nginx.conf', import.meta.url)), 'utf8');

describe('the native server block', () => {
  test('compresses application responses and the whole API surface', async () => {
    const conf = await nginxConf();
    expect(conf).toMatch(/^\s*gzip on;/m);
    // Ubuntu's default is text/html only, which left 493 kB of first-paint assets uncompressed
    // where 137 kB would do.
    expect(conf).toMatch(/^\s*gzip_types[^;]*application\/javascript/m);
    expect(conf).toMatch(/^\s*gzip_types[^;]*text\/css/m);
    expect(conf).toMatch(/^\s*gzip_types[^;]*application\/json/m);
    // Without this every /v1 response is excluded, because they all arrive through proxy_pass.
    expect(conf).toMatch(/^\s*gzip_proxied any;/m);
    expect(conf).toMatch(/^\s*gzip_vary on;/m);
  });

  test('caches content-hashed assets for a year and stable names for a week', async () => {
    const conf = await nginxConf();
    const hashed = /location \^~ \/assets\/ \{[^}]*\}/s.exec(conf)?.[0];
    expect(hashed).toBeDefined();
    expect(hashed).toContain('expires 1y;');
    expect(hashed).toContain('immutable');
    // sw.js and the icons keep their names for the life of the install, so a year would pin a
    // stale service worker onto every device that ever loaded it.
    const stable = /location ~\* \\\.\(\?:css\|js[^{]*\{[^}]*\}/s.exec(conf)?.[0];
    expect(stable).toBeDefined();
    expect(stable).toContain('expires 7d;');
  });

  /**
   * The share viewer's script and stylesheet are served by the API under `/v1/shares/assets/`,
   * and they are the only paths under `/v1/` that end in an asset extension. nginx picks the
   * longest matching prefix location and then still tries every regex location unless that prefix
   * was declared `^~`, so a plain `location /v1/` hands `share.js` and `share.css` to the
   * stable-asset block above, which answers from the web build on disk - where they are not - with
   * its own 404. The page proxies fine, and a reader watches "Opening…" for ever.
   */
  test('proxies every /v1/ path to the API before a regex location can claim one', async () => {
    const conf = await nginxConf();
    expect(conf).toMatch(/^\s*location \^~ \/v1\/ \{/m);
    expect(conf).not.toMatch(/^\s*location \/v1\/ \{/m);
  });
});
