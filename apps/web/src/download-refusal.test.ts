/**
 * What a Download button does on a client that cannot download.
 *
 * There is no DOM in this package's tests, which is exactly right for this one: the defect was
 * never about layout. Five controls built a raw `<a download>` and clicked it, and on the two
 * webviews the packaged clients are built on — WKWebView and WebKitGTK — that click is discarded
 * with no file, no error and no message. The button was a control that lied, and the sharpest of
 * the five hands over the recovery code, which is displayed once and cannot be produced again.
 *
 * So what is asserted here is the decision and the evidence of it: whether the shell was asked at
 * all, whether an anchor was clicked, and what the caller was told. The anchor is a stub, and the
 * fact that a real WKWebView ignores a real one is a fact about that webview that no test in this
 * repository can reach — see the report for what remains unverified without a packaged shell.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Native from './native.js';

/** Every anchor the module under test clicks, in order, with what was on it. */
interface Clicks {
  readonly all: Array<{ href: string; download: string }>;
}

/**
 * A fresh copy of the module with a fresh `lastCapabilities`, because the cache is module state.
 *
 * `resetModules` matters more than it looks: "no shell has said no yet" is the state the recovery
 * screen is actually in, and a test file that carried one test's answer into the next would never
 * be able to see it.
 */
const load = async (
  shell: { downloads: boolean } | null
): Promise<{
  native: typeof Native;
  clicks: Clicks;
  invocations: string[];
  objectUrls: { created: number; revoked: number };
}> => {
  vi.resetModules();
  const clicks: Clicks = { all: [] };
  const invocations: string[] = [];
  const objectUrls = { created: 0, revoked: 0 };
  const invoke = (command: string): Promise<unknown> => {
    invocations.push(command);
    if (command !== 'native_capabilities') return Promise.reject(new Error('unexpected command'));
    return Promise.resolve({ folderPicker: true, downloads: shell?.downloads ?? false });
  };
  vi.stubGlobal('window', shell === null ? {} : { __TAURI__: { core: { invoke } } });
  vi.stubGlobal('document', {
    createElement: () => {
      const anchor = { href: '', download: '', rel: '', click: () => undefined };
      anchor.click = () => {
        clicks.all.push({ href: anchor.href, download: anchor.download });
      };
      return anchor;
    }
  });
  // Subclassed rather than replaced: `new URL(...)` is used elsewhere on the import path, and a
  // plain object here took the whole module down with "URL is not a constructor" before the first
  // assertion ran.
  const url = class extends URL {
    static override createObjectURL(): string {
      objectUrls.created += 1;
      return `blob:athanor/${objectUrls.created}`;
    }
    static override revokeObjectURL(): void {
      objectUrls.revoked += 1;
    }
  };
  vi.stubGlobal('URL', url);
  return { native: await import('./native.js'), clicks, invocations, objectUrls };
};

const file = (): Blob => ({ size: 1, type: 'text/plain' }) as Blob;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handing a file over on a shell that has never been asked', () => {
  /*
   * The recovery-code case, and the reason `saveFile` exists at all. `Auth.tsx` is what the owner
   * sees INSTEAD of the app shell, so App.tsx's capability probe has not run and the cached answer
   * is undefined. The synchronous `save` reads that as "nobody has said no" and waves the click
   * through — correct for App's own menu, catastrophic here.
   */
  it('asks the shell before deciding, rather than assuming a browser', async () => {
    const { native, clicks, invocations } = await load({ downloads: false });
    expect(await native.nativeBridge.saveFile('athanor-recovery-code.txt', file())).toBe(false);
    expect(invocations).toEqual(['native_capabilities']);
    expect(clicks.all).toEqual([]);
  });

  it('asks once and no more, so a second press costs no round trip', async () => {
    const { native, invocations } = await load({ downloads: false });
    await native.nativeBridge.saveFile('a.txt', file());
    await native.nativeBridge.saveFile('b.txt', file());
    await native.nativeBridge.saveFromUrl('c.tar.gz', '/v1/workspaces/w/export');
    expect(invocations).toEqual(['native_capabilities']);
  });

  it('writes the file on a packaged shell that does register downloads', async () => {
    const { native, clicks, objectUrls } = await load({ downloads: true });
    expect(await native.nativeBridge.saveFile('athanor-recovery-code.txt', file())).toBe(true);
    expect(clicks.all).toEqual([{ href: 'blob:athanor/1', download: 'athanor-recovery-code.txt' }]);
    // Released on the way out, exactly as the anchor it replaces did.
    expect(objectUrls).toEqual({ created: 1, revoked: 1 });
  });

  /* No shell at all is the ordinary web browser, where this has always worked and must keep to
     exactly what it did: an anchor click and nothing else, with no invoke to fail on. */
  it('is an ordinary anchor click in a browser, and asks nothing', async () => {
    const { native, clicks, invocations } = await load(null);
    expect(await native.nativeBridge.saveFile('athanor-export-2026-08-27.json', file())).toBe(true);
    expect(clicks.all).toHaveLength(1);
    expect(invocations).toEqual([]);
  });
});

describe('handing over a file the box serves from a URL', () => {
  /*
   * The artifact card and the sent-attachment strip point at a route on this origin. There is no
   * blob, and fetching one only to hand it straight back would pull every artifact down twice.
   */
  it('clicks the route on a shell that can receive it, without buffering the bytes', async () => {
    const { native, clicks, objectUrls } = await load({ downloads: true });
    expect(await native.nativeBridge.saveFromUrl('report.pdf', '/v1/artifacts/a1/content')).toBe(
      true
    );
    expect(clicks.all).toEqual([{ href: '/v1/artifacts/a1/content', download: 'report.pdf' }]);
    expect(objectUrls.created).toBe(0);
  });

  it('refuses rather than clicking into nothing where the shell takes no downloads', async () => {
    const { native, clicks } = await load({ downloads: false });
    expect(await native.nativeBridge.saveFromUrl('report.pdf', '/v1/artifacts/a1/content')).toBe(
      false
    );
    expect(clicks.all).toEqual([]);
  });
});

describe('the synchronous save App.tsx already depends on', () => {
  /*
   * Held to what it did before, because `App.tsx` is not this lane's file and its conversation
   * export calls this one. It reads the cached answer and does not wait: right there, wrong on the
   * screens that run before anything has been cached, which is why `saveFile` is a second door
   * rather than a change to this one.
   */
  it('still refuses once the shell has been asked and said no', async () => {
    const { native, clicks } = await load({ downloads: false });
    await native.nativeBridge.capabilities();
    expect(native.nativeBridge.save('conversation.md', file())).toBe(false);
    expect(clicks.all).toEqual([]);
  });

  it('still writes the file before anything has asked, which is the gap saveFile closes', async () => {
    const { native, clicks } = await load({ downloads: false });
    expect(native.nativeBridge.save('conversation.md', file())).toBe(true);
    expect(clicks.all).toHaveLength(1);
  });
});

describe('what the owner is told when the file cannot be written', () => {
  /*
   * The recovery code is the one string in this product with nothing behind it: it is shown once,
   * using it is the only way back into an account whose passkeys are gone, and the screen that
   * hands it over has a working Copy button two millimetres to the left. The sentence has to name
   * that, and it has to be the same sentence on both screens that show a recovery code — first
   * sign-in and Settings — because they are the same fact about the same kind of string.
   */
  it('sends the owner to the control that does work, and repeats that there is no second showing', async () => {
    const { native } = await load(null);
    expect(native.DOWNLOAD_UNAVAILABLE_RECOVERY_CODE).toContain('cannot save files on this device');
    expect(native.DOWNLOAD_UNAVAILABLE_RECOVERY_CODE).toContain('Copy the code');
    expect(native.DOWNLOAD_UNAVAILABLE_RECOVERY_CODE).toContain('not shown again');
  });

  /* Everything else the box will serve again on request, so the way out is a browser and not the
     clock — which is the opposite of the advice above, and the reason there are two sentences. */
  it('sends the owner to a browser for a file the box still holds', async () => {
    const { native } = await load(null);
    expect(native.DOWNLOAD_UNAVAILABLE_FILE).toContain('cannot save files on this device');
    expect(native.DOWNLOAD_UNAVAILABLE_FILE).toContain('browser');
    expect(native.DOWNLOAD_UNAVAILABLE_FILE).not.toContain('Copy the code');
  });
});

/**
 * The gate, and the only one of these that would have caught the defect where it was written.
 *
 * Everything above proves the bridge decides correctly. None of it can stop a screen going around
 * the bridge, which is precisely what all five of these did — each one a perfectly ordinary two
 * lines that nothing anywhere objected to. A raw `<a download>` in a component is the defect
 * itself, so the source is what gets asserted.
 *
 * Two files are allowed to build one, and both own the decision rather than dodging it:
 * `native.ts`, which is where the single click now lives, and `DownloadLink.tsx`, whose whole
 * purpose is to be an anchor in a browser and a refusal on a shell that takes no downloads.
 *
 * Following it turned up two more the wave-9 list did not have, and neither file is this lane's to
 * write: `api.ts`'s `downloadWorkspaceExport` — whose one caller now goes through the bridge, so
 * what is left there is dead rather than dangerous — and `Inspector.tsx:1320`, the Files pane's
 * preview download, which is live and still silent on a packaged client. The second is named in
 * `STILL_OPEN` below rather than quietly excused, so that closing it fails this test and the entry
 * has to be deleted by the person who closed it.
 */
describe('the source itself, because a screen can always go around the bridge', () => {
  const source = fileURLToPath(new URL('.', import.meta.url));
  const allowed = new Set(['DownloadLink.tsx']);
  /** Real sites, in files this lane may not write. Shrinking this list is the point of it. */
  const STILL_OPEN = ['Inspector.tsx'];
  const components = readdirSync(source).filter(
    (name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx') && !allowed.has(name)
  );

  /** Comments talk about `<a download>` in four of these files; the code is what is being asked. */
  const withoutComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('has components to check at all, so a rename cannot make this pass by scanning nothing', () => {
    expect(components.length).toBeGreaterThan(20);
    expect(components).toContain('Auth.tsx');
    expect(components).toContain('SelfHostedSettings.tsx');
    expect(components).toContain('Timeline.tsx');
    expect(components).toContain('AttachmentTray.tsx');
  });

  it('leaves no component building a download anchor of its own', () => {
    const offenders = components.filter((name) => {
      const text = withoutComments(readFileSync(new URL(name, import.meta.url), 'utf8'));
      return /\.download\s*=/.test(text) || /<a\b[^>]*\sdownload[=\s>]/s.test(text);
    });
    expect(offenders).toEqual(STILL_OPEN);
  });
});
