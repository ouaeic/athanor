import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The service worker ships as a plain file to `/sw.js`, so it cannot be imported. It is instead
 * evaluated against a stand-in worker scope, which is the only way to hold it to the two things it
 * is now responsible for: never waking a device whose owner is already looking at the screen, and
 * never leaving an approval button that silently does nothing.
 */
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

interface WorkerClient {
  url: string;
  focused: boolean;
  visibilityState: 'visible' | 'hidden';
  navigate(url: string): Promise<void>;
  focus(): Promise<void>;
  postMessage(message: unknown): void;
}

interface ShownNotification {
  title: string;
  options: Record<string, unknown>;
}

interface WorkerEvent {
  waitUntil(promise: Promise<unknown>): void;
}

type Listener = (event: unknown) => void;

// The Cache API keys on the resolved request URL, so '/index.html' and the absolute form of it are
// the same entry. Keeping that true here is what makes a precache hit a hit.
const keyOf = (request: { url?: string } | string): string =>
  new URL(typeof request === 'string' ? request : (request.url ?? ''), 'https://box.example').href;

/** Enough of the Cache API to hold the worker to what it stores and what it answers with. */
const cacheStorage = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, entries);
    return {
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      match: async (request: { url?: string } | string) => entries.get(keyOf(request)),
      add: async (request: { url?: string } | string) => {
        const response = await fetcher(keyOf(request), {});
        if (!response.ok) throw new Error(`add failed: ${keyOf(request)}`);
        entries.set(keyOf(request), response);
      },
      put: async (request: { url?: string } | string, response: Response) => {
        entries.set(keyOf(request), response);
      },
      delete: async (request: { url?: string } | string) => entries.delete(keyOf(request))
    };
  };
  return {
    stores,
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: { url?: string } | string) => {
        for (const entries of stores.values())
          if (entries.has(keyOf(request))) return entries.get(keyOf(request));
        return undefined;
      }
    }
  };
};

const worker = (options: {
  clients?: Array<Partial<WorkerClient>>;
  respond?: (url: string, init: RequestInit) => Promise<Response>;
}) => {
  const listeners = new Map<string, Listener>();
  const shown: ShownNotification[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const messages: unknown[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const windows: WorkerClient[] = (options.clients ?? []).map((client) => ({
    url: 'https://box.example/',
    focused: false,
    visibilityState: 'hidden',
    navigate: async (url: string) => {
      navigated.push(url);
    },
    focus: async () => undefined,
    postMessage: (message: unknown) => {
      messages.push(message);
    },
    ...client
  }));

  const scope = {
    addEventListener: (type: string, handler: Listener) => listeners.set(type, handler),
    skipWaiting: () => undefined,
    location: { origin: 'https://box.example' },
    clients: {
      matchAll: async () => windows,
      claim: async () => undefined,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      }
    },
    registration: {
      showNotification: async (title: string, notificationOptions: Record<string, unknown>) => {
        shown.push({ title, options: notificationOptions });
      }
    }
  };

  const fetchStub = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return options.respond
      ? options.respond(url, init)
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const storage = cacheStorage(fetchStub);

  // The worker file is the artefact that ships; importing a copy of it would test the copy.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const install = new Function('self', 'caches', 'crypto', 'fetch', source) as (
    workerScope: unknown,
    workerCaches: unknown,
    workerCrypto: unknown,
    workerFetch: unknown
  ) => void;
  install(
    scope,
    storage.caches,
    { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    fetchStub
  );

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Array<Promise<unknown>> = [];
    const full = { ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
    listeners.get(type)?.(full as unknown as WorkerEvent);
    await Promise.all(pending);
  };

  /** What `respondWith` was handed, which is the only thing the page ever sees. */
  const respond = async (request: Record<string, unknown>): Promise<Response | Error> => {
    let answered: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request,
      waitUntil: () => undefined,
      respondWith: (value: Promise<Response>) => {
        answered = value;
      }
    } as unknown as WorkerEvent);
    if (!answered) throw new Error('the worker did not answer this request');
    return answered.catch((cause: Error) => cause);
  };

  return { dispatch, respond, storage, shown, opened, navigated, messages, requests };
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  kind: 'task_finished',
  title: 'Reconcile the March invoices',
  body: 'Finished in 6 min · $0.31.',
  url: '/?task=task-1',
  tag: 'task-1',
  ...overrides
});

const pushEvent = (value: unknown) => ({ data: { json: () => value } });

describe('offline shell', () => {
  const MANIFEST = { eager: ['/assets/index-abc.js', '/assets/index-abc.css'] };

  /** A deployment that answers everything until the test cuts the network. */
  const deployment = () => {
    const state = { online: true };
    const sw = worker({
      respond: async (url) => {
        if (!state.online) throw new TypeError('Failed to fetch');
        if (url === '/asset-manifest.json')
          return new Response(JSON.stringify(MANIFEST), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        if (url.endsWith('.js'))
          return new Response('export default 1', {
            status: 200,
            headers: { 'content-type': 'text/javascript' }
          });
        return new Response('<!doctype html><title>athanor</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
    });
    return { sw, state };
  };

  const get = (url: string, extra: Record<string, unknown> = {}) => ({
    method: 'GET',
    url,
    mode: 'no-cors',
    destination: 'script',
    ...extra
  });

  it('precaches the hashed module graph the build wrote down, not just the page', async () => {
    const { sw } = deployment();
    await sw.dispatch('install', {});
    const shell = [...(sw.storage.stores.get('athanor-shell-v4')?.keys() ?? [])];
    expect(shell).toContain('https://box.example/index.html');
    expect(shell).toContain('https://box.example/assets/index-abc.js');
    expect(shell).toContain('https://box.example/assets/index-abc.css');
  });

  it('serves a module from the cache when the box is unreachable', async () => {
    const { sw, state } = deployment();
    await sw.dispatch('install', {});
    state.online = false;
    const answer = await sw.respond(get('https://box.example/assets/index-abc.js'));
    expect(answer).toBeInstanceOf(Response);
    expect((answer as Response).headers.get('content-type')).toBe('text/javascript');
  });

  it('never answers a module request with the page, which is a blank screen not a fallback', async () => {
    const { sw, state } = deployment();
    await sw.dispatch('install', {});
    state.online = false;
    const answer = await sw.respond(get('https://box.example/assets/index-never-seen.js'));
    expect(answer).toBeInstanceOf(Error);
  });

  it('answers an offline reload with the shell it last saw the box serve', async () => {
    const { sw, state } = deployment();
    await sw.dispatch('install', {});
    const navigation = get('https://box.example/?task=task-1', {
      mode: 'navigate',
      destination: 'document'
    });
    await sw.respond(navigation);
    state.online = false;
    const answer = await sw.respond(navigation);
    expect(answer).toBeInstanceOf(Response);
    expect(await (answer as Response).text()).toContain('<!doctype html>');
  });

  it('leaves the API alone: a request to /v1 is never answered from a cache', async () => {
    const { sw } = deployment();
    await sw.dispatch('install', {});
    await expect(sw.respond(get('https://box.example/v1/bootstrap'))).rejects.toThrow(
      'did not answer'
    );
  });
});

describe('push', () => {
  it('raises a notification carrying the real title, body and actions', async () => {
    const sw = worker({});
    await sw.dispatch(
      'push',
      pushEvent(
        payload({
          kind: 'approval_required',
          body: 'Waiting for you: it wants to run a command on your computer.',
          approvalId: 'approval-9',
          requireInteraction: true,
          actions: [
            { action: 'approve', title: 'Approve' },
            { action: 'deny', title: 'Deny' }
          ]
        })
      )
    );
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Reconcile the March invoices');
    expect(sw.shown[0]?.options.body).toBe(
      'Waiting for you: it wants to run a command on your computer.'
    );
    expect(sw.shown[0]?.options.actions).toEqual([
      { action: 'approve', title: 'Approve' },
      { action: 'deny', title: 'Deny' }
    ]);
    expect(sw.shown[0]?.options.requireInteraction).toBe(true);
    expect(sw.shown[0]?.options.data).toEqual({
      url: '/?task=task-1',
      kind: 'approval_required',
      approvalId: 'approval-9'
    });
  });

  it('does not wake a device whose owner is looking at the screen', async () => {
    const sw = worker({ clients: [{ focused: true, visibilityState: 'visible' }] });
    await sw.dispatch('push', pushEvent(payload()));
    expect(sw.shown).toHaveLength(0);
    expect(sw.messages).toHaveLength(1);
    expect((sw.messages[0] as { source: string; payload: { title: string } }).source).toBe(
      'athanor-push'
    );
    expect((sw.messages[0] as { payload: { title: string } }).payload.title).toBe(
      'Reconcile the March invoices'
    );
  });

  it('suppresses a visible-but-unfocused window too, and tells it what happened', async () => {
    const sw = worker({ clients: [{ focused: false, visibilityState: 'visible' }] });
    await sw.dispatch('push', pushEvent(payload({ kind: 'approval_required' })));
    expect(sw.shown).toHaveLength(0);
    expect((sw.messages[0] as { payload: { kind: string } }).payload.kind).toBe(
      'approval_required'
    );
  });

  it('still notifies when every window is hidden', async () => {
    const sw = worker({ clients: [{ focused: false, visibilityState: 'hidden' }] });
    await sw.dispatch('push', pushEvent(payload()));
    expect(sw.shown).toHaveLength(1);
  });

  it('says something truthful when the payload cannot be read', async () => {
    const sw = worker({});
    await sw.dispatch('push', {
      data: {
        json: () => {
          throw new Error('not json');
        }
      }
    });
    expect(sw.shown[0]?.title).toBe('athanor');
    expect(sw.shown[0]?.options.body).toBe('Something needs your attention.');
  });
});

describe('notificationclick', () => {
  const approvalNotification = {
    close: () => undefined,
    data: { url: '/?task=task-1', kind: 'approval_required', approvalId: 'approval-9' }
  };

  it('answers an approval against the approval endpoint without opening the app', async () => {
    const sw = worker({});
    await sw.dispatch('notificationclick', {
      action: 'approve',
      notification: approvalNotification
    });
    expect(sw.requests).toHaveLength(1);
    expect(sw.requests[0]?.url).toBe('/v1/approvals/approval-9/approve');
    expect(sw.requests[0]?.init.method).toBe('POST');
    expect(sw.requests[0]?.init.credentials).toBe('include');
    expect((sw.requests[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe(
      '00000000-0000-4000-8000-000000000000'
    );
    expect(sw.shown[0]?.options.body).toBe('Approved. athanor is carrying on with it.');
    expect(sw.opened).toHaveLength(0);
  });

  it('reports a denial in the owner’s terms', async () => {
    const sw = worker({});
    await sw.dispatch('notificationclick', { action: 'deny', notification: approvalNotification });
    expect(sw.requests[0]?.url).toBe('/v1/approvals/approval-9/deny');
    expect(sw.shown[0]?.options.body).toBe('Denied. athanor will not do that.');
  });

  it('never fails silently: an expired approval says so and opens the conversation', async () => {
    const sw = worker({
      respond: async () =>
        new Response(
          JSON.stringify({
            error: { code: 'approval_unavailable', message: 'Approval is missing' }
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
    });
    await sw.dispatch('notificationclick', {
      action: 'approve',
      notification: approvalNotification
    });
    expect(sw.shown[0]?.title).toBe('That approval was not answered');
    expect(sw.shown[0]?.options.body).toContain('expired');
    expect(sw.opened).toEqual(['https://box.example/?task=task-1']);
  });

  it('tells a signed-out device to sign in rather than shrugging', async () => {
    const sw = worker({
      respond: async () =>
        new Response(JSON.stringify({ error: { code: 'authentication_required' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
    });
    await sw.dispatch('notificationclick', { action: 'deny', notification: approvalNotification });
    expect(sw.shown[0]?.options.body).toBe('This device is signed out. Open athanor to answer it.');
  });

  it('reports a device that could not reach the server at all', async () => {
    const sw = worker({
      respond: async () => {
        throw new Error('offline');
      }
    });
    await sw.dispatch('notificationclick', {
      action: 'approve',
      notification: approvalNotification
    });
    expect(sw.shown[0]?.options.body).toBe('Could not reach your athanor. Open it to answer.');
  });

  it('opens the conversation when the body is tapped rather than a button', async () => {
    const sw = worker({ clients: [{ url: 'https://box.example/' }] });
    await sw.dispatch('notificationclick', { notification: approvalNotification });
    expect(sw.requests).toHaveLength(0);
    expect(sw.navigated).toEqual(['https://box.example/?task=task-1']);
  });
});
