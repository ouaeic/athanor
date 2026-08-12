const SHELL = 'athanor-shell-v4';
const SHARE_CACHE = 'athanor-shares-v1';
const SHARE_PREFIX = '/__athanor-share/';
/** Written by the build: the entry chunk and everything it statically imports, by hashed name. */
const ASSET_MANIFEST = '/asset-manifest.json';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/brand/athanor-icon-512.png',
  '/brand/athanor-icon-192.png'
];
const MAX_SHARE_FILES = 20;
const MAX_SHARE_FILE_BYTES = 49 * 1024 * 1024;
const SHARE_LIFETIME_MS = 60 * 60 * 1000;

const purgeExpiredShares = async () => {
  const cache = await caches.open(SHARE_CACHE);
  const requests = await cache.keys();
  const manifests = requests.filter((request) => request.url.endsWith('/manifest'));
  for (const request of manifests) {
    const response = await cache.match(request);
    const manifest = await response?.json().catch(() => undefined);
    if (typeof manifest?.expiresAt === 'number' && manifest.expiresAt > Date.now()) continue;
    const prefix = request.url.slice(0, -'manifest'.length);
    await Promise.all(
      requests
        .filter((candidate) => candidate.url.startsWith(prefix))
        .map((candidate) => cache.delete(candidate))
    );
  }
};

/**
 * The shell, and the module graph the shell is useless without.
 *
 * Precaching `/index.html` alone was worse than precaching nothing: offline, the page came back and
 * every `<script type="module">` in it missed, and the miss was answered with `index.html` — an
 * HTML body for a JavaScript request, which the browser refuses on MIME type, so the reload was a
 * blank screen rather than a degraded one. The build writes the hashed names because a worker
 * cannot guess them, and each is added on its own so one renamed file cannot void the whole install.
 */
const precache = async () => {
  const cache = await caches.open(SHELL);
  await Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => undefined)));
  const manifest = await fetch(ASSET_MANIFEST)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const eager = Array.isArray(manifest?.eager) ? manifest.eager : [];
  await Promise.all(eager.map((url) => cache.add(url).catch(() => undefined)));
};

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL && key !== SHARE_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => purgeExpiredShares())
  );
  self.clients.claim();
});

const receiveShare = async (request) => {
  const form = await request.formData();
  const id = crypto.randomUUID();
  const cache = await caches.open(SHARE_CACHE);
  const files = [];
  for (const item of form.getAll('files').slice(0, MAX_SHARE_FILES)) {
    if (!(item instanceof File) || item.size === 0 || item.size > MAX_SHARE_FILE_BYTES) continue;
    const url = `${SHARE_PREFIX}${id}/${files.length}`;
    await cache.put(
      url,
      new Response(item, { headers: { 'content-type': item.type || 'application/octet-stream' } })
    );
    files.push({ name: item.name || `shared-${files.length + 1}`, type: item.type, url });
  }
  const stringValue = (name) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.slice(0, 20_000) : '';
  };
  await cache.put(
    `${SHARE_PREFIX}${id}/manifest`,
    new Response(
      JSON.stringify({
        title: stringValue('title'),
        text: stringValue('text'),
        url: stringValue('url'),
        files,
        expiresAt: Date.now() + SHARE_LIFETIME_MS
      }),
      { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
    )
  );
  return Response.redirect(`/?share=${encodeURIComponent(id)}`, 303);
};

/**
 * A hashed file never changes under its own name, so the cached copy is always the right answer and
 * the network is only consulted for one this device has never seen.
 */
const cachedAsset = async (request) => {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL);
    await cache.put(request, response.clone());
  }
  return response;
};

/**
 * The hashed files a shell names, which is the only part of a page that says which build it is.
 *
 * Byte-comparing the two documents would report a deploy for a changed `<title>`, and
 * `/asset-manifest.json` describes only the build that is live — never the one this device is
 * looking at, which is the half of the comparison that is hard to come by. Both bodies are already
 * in hand at the instant below, and a hashed name is immutable, so a set that differs is different
 * software and a set that matches is the same software however the HTML around it was rewritten.
 */
const buildAssets = (html) =>
  [...new Set([...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]))]
    .sort()
    .join(' ');

/**
 * Whether the page on screen is a release the box has since replaced.
 *
 * Held only for as long as this worker is alive, which is long enough: it exists to answer the one
 * window that opened onto the stale shell, and that window asks within a moment of starting. A
 * worker that has been recycled since has nothing to say, and the next launch is the new release
 * anyway, so the answer it would have given no longer applies.
 */
let supersededShell = false;

const tellWindows = async () => {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ source: 'athanor-shell-superseded' });
};

/**
 * The cost of the trade below, made visible.
 *
 * Serving from disk and refreshing behind it means exactly one launch per update shows the previous
 * release. That is a good trade and it stays; what is not acceptable is that the only way to notice
 * it was to already know what had changed — somebody who had just deployed read the old logo as a
 * failed deploy. Nothing is claimed unless both sides name a build: the dev server names none, and
 * an error page or a captive portal standing in for the shell names none either, and neither is
 * evidence that anything was deployed.
 */
const compareShells = async (served, fresh) => {
  const before = buildAssets(served);
  const after = buildAssets(fresh);
  if (!before || !after) return;
  supersededShell = before !== after;
  if (supersededShell) await tellWindows();
};

/**
 * Everything else: the network decides, and what came back is kept so the next flight has it.
 *
 * Only a page request may be answered with the app shell. Answering a module, a stylesheet or an
 * image with `index.html` is the failure this replaces. A miss with no cached copy is left to fail
 * as it would with no worker installed, which is the honest outcome.
 */
const cachedDocument = async (request, isNavigation, keepAlive) => {
  const url = new URL(request.url);
  /*
   * The app's own root answers from cache first, and refreshes behind it.
   *
   * Every launch used to block on a full round trip to the box before any HTML existed at all, and
   * then show the splash while the app made a second one - on a product whose promise is that you
   * sign in once and never wait for it again. The shell is a hashed-asset bootstrap: the copy on
   * disk is always a valid app, and the assets it names are immutable, so serving it immediately
   * and fetching the new one behind it costs nothing but is the whole difference between an icon
   * that opens and an icon that loads.
   *
   * Scoped to `/` for the same reason the write below is: the box serves published previews from
   * this origin, and answering one of those from the shell would open athanor instead of the
   * owner's site.
   */
  if (isNavigation && url.pathname === '/') {
    const shell = await caches.match('/index.html');
    if (shell) {
      // Copied before the page is handed the original, because a body may only be read once and
      // the document about to be run is one half of the comparison.
      const served = shell.clone();
      /*
       * The verdict is about the document being handed over here, so the last one is dropped before
       * this page can be handed it by mistake.
       *
       * A window asks the moment it can hear an answer, and its own refresh is a round trip to the
       * box - so the ask routinely arrives first. Without this, the page that has just reloaded
       * onto the new release is told, from the same live worker, that it is the old one: the offer
       * comes back on a screen that is already current and the reload it asks for leads here again.
       */
      supersededShell = false;
      keepAlive(
        fetch(request)
          .then(async (fresh) => {
            if (!fresh.ok) return;
            const cache = await caches.open(SHELL);
            await cache.put('/index.html', fresh.clone());
            await compareShells(await served.text(), await fresh.text());
          })
          .catch(() => undefined)
      );
      return shell;
    }
  }
  try {
    const response = await fetch(request);
    // The shell is refreshed on every visit so that offline shows the deployment whose assets this
    // device actually has, rather than whichever one happened to be live when the worker installed.
    // Only the app's own root is the app. Any navigation used to be written over the shell, so
    // opening a published preview - which the box serves from the same origin under
    // /__athanor/preview/ - replaced the cached athanor with somebody's static site, and every
    // later offline launch opened that instead.
    if (isNavigation && response.ok && url.pathname === '/') {
      const cache = await caches.open(SHELL);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch (cause) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (!isNavigation) throw cause;
    const shell = await caches.match('/index.html');
    if (shell) return shell;
    throw cause;
  }
};

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method === 'GET' && url.pathname.startsWith(SHARE_PREFIX)) {
    event.respondWith(
      caches
        .open(SHARE_CACHE)
        .then((cache) => cache.match(event.request))
        .then((hit) => hit || new Response('', { status: 404 }))
    );
    return;
  }
  // Previews are other people's pages served from this origin. They are not the app, they must not
  // be answered with the app shell when the network is gone, and nothing about them belongs in a
  // cache keyed to this install.
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/v1/') ||
    url.pathname.startsWith('/__athanor/preview/')
  )
    return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(cachedAsset(event.request));
    return;
  }
  event.respondWith(
    cachedDocument(
      event.request,
      event.request.mode === 'navigate' || event.request.destination === 'document',
      // The revalidation outlives the response it is not part of, so it is held open by the event
      // rather than left to be killed when the worker goes idle a moment after answering.
      (work) => event.waitUntil(work)
    )
  );
});

/*
 * The launch this exists for is also the one hardest to tell.
 *
 * The refresh behind the shell is a round trip to a box that is often on the same network, and the
 * page it is racing has a module graph to evaluate before anything in it is listening — so the
 * comparison regularly finishes first and the broadcast lands on an empty room. The window asks the
 * moment it can hear an answer, and this is the answer.
 */
self.addEventListener('message', (event) => {
  if (event.data?.source !== 'athanor-shell-check' || !supersededShell) return;
  event.source?.postMessage({ source: 'athanor-shell-superseded' });
});

const ICON = '/brand/athanor-icon-192.png';

/**
 * Field-for-field the payload built by services/notifications/src/payload.ts. A device keeps its
 * installed worker until the next visit, so an older copy of this file has to survive a newer
 * payload: anything missing falls back to something truthful rather than to a blank notification.
 */
const readPayload = (event) => {
  let incoming = {};
  try {
    incoming = event.data.json() ?? {};
  } catch {
    // A payload that will not parse is still a real event; it just cannot be described.
  }
  return {
    kind: incoming.kind || 'task_finished',
    title: incoming.title || 'athanor',
    body: incoming.body || 'Something needs your attention.',
    url: incoming.url || '/',
    tag: incoming.tag || 'athanor-update',
    approvalId: incoming.approvalId || null,
    actions: Array.isArray(incoming.actions) ? incoming.actions.slice(0, 2) : [],
    requireInteraction: incoming.requireInteraction === true
  };
};

const focusedWindows = async () => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.filter((client) => client.focused || client.visibilityState === 'visible');
};

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    (async () => {
      /*
       * Do not raise a notification over the screen it is describing. The server already skips an
       * owner it can see is active, but that judgement is a second or two stale, so the phone can
       * still be woken for a conversation the owner is watching. This is the check that cannot be
       * stale. The open windows are told instead, so the app refreshes at once rather than on its
       * next poll — and the server only *holds* a suppressed approval, so it arrives on the lock
       * screen the moment the owner looks away.
       */
      const open = await focusedWindows();
      if (open.length) {
        for (const client of open) client.postMessage({ source: 'athanor-push', payload });
        return;
      }
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: ICON,
        badge: ICON,
        tag: payload.tag,
        renotify: true,
        requireInteraction: payload.requireInteraction,
        actions: payload.actions,
        data: { url: payload.url, kind: payload.kind, approvalId: payload.approvalId }
      });
    })()
  );
});

const openApp = async (url) => {
  const target = new URL(url || '/', self.location.origin).href;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
  if (existing) {
    await existing.navigate(target);
    return existing.focus();
  }
  return self.clients.openWindow(target);
};

/**
 * Answers an approval from the lock screen.
 *
 * Safe to do without opening the app because the approval the server resolves is already bound to
 * the exact arguments the owner was shown: the id names one request, and the worker re-checks the
 * preview hash before it acts, so a stale button or an altered action cannot be approved by
 * accident. The button only carries the decision — never the thing being decided.
 */
const answerApproval = async (approvalId, decision) => {
  try {
    const response = await fetch(`/v1/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: '{}'
    });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => ({}));
    return { ok: false, code: body?.error?.code || 'request_failed', status: response.status };
  } catch {
    return { ok: false, code: 'offline', status: 0 };
  }
};

const answerResult = (decision, outcome) => {
  if (outcome.ok)
    return decision === 'approve'
      ? 'Approved. athanor is carrying on with it.'
      : 'Denied. athanor will not do that.';
  if (outcome.code === 'approval_unavailable')
    return 'Already answered, or it expired while it waited. Open athanor to see where the task stands.';
  if (outcome.status === 401 || outcome.code === 'authentication_required')
    return 'This device is signed out. Open athanor to answer it.';
  if (outcome.code === 'offline') return 'Could not reach your athanor. Open it to answer.';
  return 'That did not go through. Open athanor to answer it.';
};

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const decision = event.action === 'approve' || event.action === 'deny' ? event.action : null;
  if (!decision || !data.approvalId) {
    event.waitUntil(openApp(data.url));
    return;
  }
  event.waitUntil(
    (async () => {
      const outcome = await answerApproval(data.approvalId, decision);
      // A button that appears to do nothing is worse than no button, so the answer always reports
      // back — including when it was refused, expired, or never left the device.
      await self.registration.showNotification(
        outcome.ok ? 'athanor' : 'That approval was not answered',
        {
          body: answerResult(decision, outcome),
          icon: ICON,
          badge: ICON,
          tag: `approval-result-${data.approvalId}`,
          data: { url: data.url }
        }
      );
      if (!outcome.ok) await openApp(data.url);
    })()
  );
});
