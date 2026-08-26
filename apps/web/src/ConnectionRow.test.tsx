/**
 * The packaged app's own connection row, and the two ways it could lie.
 *
 * The first is by existing at all in a browser: every route this section calls is served by the
 * shell's loopback gateway, so on a box reached over the web the whole section has to be absent
 * rather than empty. The second is subtler and is the one the product actually shipped — a network
 * preference that could be answered once, from a screen only a broken connection could reach, with
 * the wrong answer removing the screen that asked. Both are asserted here.
 *
 * `fetch` is stubbed rather than a shell started: what is being checked is the seam between this
 * file and `proxy.rs`, which is the address, the method and the body. The Rust half of each route
 * is tested where it lives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConnectionDetails,
  ConnectionRow,
  clientConnection,
  connectionStateLine,
  forgetFailure,
  forgetServer,
  readConnection,
  saveNetworkPreference,
  shellVersionNote,
  type ClientConnection
} from './ConnectionRow.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const calls: Call[] = [];

const answer = (body: unknown, init: ResponseInit = {}): void => {
  vi.stubGlobal('fetch', (input: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), init: requestInit });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers }
      })
    );
  });
};

const only = (): Call => {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
};

/** Every write this file makes sends a JSON string, so anything else is the assertion failing. */
const sentBody = (): unknown => {
  const body = only().init?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(body as string);
};

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

/** Exactly what `client_status` serialises, field for field, camel-cased as `serde` writes it. */
const status = (patch: Partial<ClientConnection> = {}): ClientConnection => ({
  configured: true,
  connected: true,
  identity: 'k51qzi5uqu5dh9ihj4p2v5sl0kkwmi9gkrn7d4d0dv1zj0nfmh',
  endpoints: ['https://box.example.test', 'https://198.51.100.7'],
  error: null,
  networkPreference: 'fixed',
  appVersion: '0.1.1',
  ...patch
});

describe('whether this section exists at all', () => {
  /*
   * The one question that separates the packaged shell from a browser. In a browser there is no
   * pinned server to describe and no gateway to ask, so a greyed-out "Forget this server" would be
   * exactly the sort of control this program exists to remove.
   */
  it('renders nothing whatsoever outside the packaged app', () => {
    vi.stubGlobal('window', {});
    expect(renderToStaticMarkup(<ConnectionRow />)).toBe('');
  });

  it('renders the section inside the packaged app', () => {
    vi.stubGlobal('window', { __TAURI__: { core: { invoke: () => Promise.resolve() } } });
    expect(renderToStaticMarkup(<ConnectionRow />)).toContain('This device');
  });
});

describe('what the shell reports, as this screen is prepared to believe it', () => {
  it('reads the status the gateway actually serialises', () => {
    const parsed = clientConnection({
      configured: true,
      connected: false,
      identity: 'abc',
      endpoints: ['https://box.example.test'],
      error: 'The server connection was interrupted: timed out',
      networkPreference: 'dynamic',
      appVersion: '0.1.1'
    });
    expect(parsed?.networkPreference).toBe('dynamic');
    expect(parsed?.endpoints).toEqual(['https://box.example.test']);
    expect(connectionStateLine(parsed as ClientConnection)).toContain('timed out');
  });

  /*
   * Both fields were added to the report after the shell shipped, and a packaged app updates by
   * being reinstalled. An older shell must read as "this app cannot say" rather than put the word
   * undefined in a row.
   */
  it('survives a shell older than the two newest fields', () => {
    const parsed = clientConnection({
      configured: true,
      connected: true,
      identity: 'abc',
      endpoints: [],
      error: null
    });
    expect(parsed?.networkPreference).toBeNull();
    expect(parsed?.appVersion).toBeNull();
    expect(
      shellVersionNote(parsed?.appVersion ?? null, { version: '0.1.2', commit: null })
    ).toBeNull();
  });

  it('is not fooled by an answer that is not this gateway’s', () => {
    expect(clientConnection('<!doctype html>')).toBeUndefined();
    expect(clientConnection({ connected: true })).toBeUndefined();
  });
});

describe('the three requests this section makes', () => {
  it('asks the gateway for its own status and nothing else', async () => {
    answer(status());
    await readConnection();
    expect(only().url).toBe('/__athanor/client/status');
    expect(only().init?.credentials).toBe('same-origin');
  });

  /* The route parses `{preference}` and its enum is snake_case, which is what these three are. */
  it('saves a network preference the way the route parses one', async () => {
    answer({ saved: true });
    await saveNetworkPreference('dynamic');
    expect(only().url).toBe('/__athanor/client/network-preference');
    expect(only().init?.method).toBe('POST');
    expect(sentBody()).toEqual({ preference: 'dynamic' });
  });

  /*
   * A DELETE, and to the profile rather than to anything on the box. This is the route `ClientState`
   * has always been able to serve and nothing could ask it for, which is why moving the app to
   * another server meant deleting a JSON file out of Application Support by hand.
   */
  it('forgets the server by unpinning the profile on this device', async () => {
    answer({ connected: false });
    await forgetServer();
    expect(only().url).toBe('/__athanor/client/profile');
    expect(only().init?.method).toBe('DELETE');
  });

  /*
   * The gateway's refusals are written for this screen - "Connect an athanor server before saving
   * network preferences" is the whole answer - so they are surfaced rather than replaced with a
   * sentence of our own that says less.
   */
  it('repeats the gateway’s own refusal rather than inventing one', async () => {
    answer(
      { error: { code: 'preference_failed', message: 'Connect an athanor server first' } },
      { status: 400 }
    );
    await expect(saveNetworkPreference('fixed')).rejects.toThrow('Connect an athanor server first');
  });

  /*
   * Two halves can fail a disconnect, and only one of them is the box. The server's own answer to a
   * refused step-up is "Confirm this sensitive action with your passkey", which is an instruction
   * with no control attached to it — the case `securityActionMessage` exists for.
   */
  it('says which half of the disconnect failed', () => {
    expect(forgetFailure({ code: 'step_up_failed', status: 401 })).toContain(
      'Passkey verification did not complete'
    );
    expect(forgetFailure(new Error('The client profile remover stopped unexpectedly'))).toBe(
      'The client profile remover stopped unexpectedly'
    );
  });
});

describe('what the row offers the owner', () => {
  const render = (patch: Partial<ClientConnection> = {}): string =>
    renderToStaticMarkup(
      <ConnectionDetails
        status={status(patch)}
        onPrefer={() => undefined}
        onArm={() => undefined}
        onForget={() => undefined}
      />
    );

  /*
   * The one-way door, closed. The offline screen renders the choice for `Unknown` and `Dynamic` and
   * nothing for `Fixed`, so "my address is fixed" - the plausible wrong answer on a home connection
   * - removed the only screen that could ever ask again.
   */
  it('offers all three answers about the address, including the one already chosen', () => {
    const markup = render({ networkPreference: 'fixed' });
    expect(markup).toContain('Not answered');
    expect(markup).toContain('It can change');
    expect(markup).toContain('It never changes');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('You can change this answer whenever you like.');
    // And it says what the answer actually does, which is not what any of the three sound like:
    // it decides what the connection screen says, not how the app finds the box.
    expect(markup).toContain('no address guidance');
  });

  it('shows which box it is pinned to and where it has found it', () => {
    const markup = render();
    expect(markup).toContain('k51qzi5uqu5dh9ihj4p2v5sl0kkwmi9gkrn7d4d0dv1zj0nfmh');
    expect(markup).toContain('https://198.51.100.7');
    expect(markup).toContain('Refreshed every time the app reconnects');
  });

  /*
   * The passkey is verified by the box, so a server that has stopped answering cannot verify one -
   * and that is precisely when an owner needs to unpin it. Saying so is what keeps the confirmation
   * from becoming a lock on the door it is guarding.
   */
  it('says whether forgetting will be confirmed with a passkey, and why not when it will not', () => {
    expect(render()).toContain('confirm with a passkey');
    const offline = render({ connected: false, error: 'The server connection was interrupted' });
    expect(offline).toContain('cannot be reached, so it cannot confirm this');
    expect(offline).toContain('The server connection was interrupted');
  });

  /* Nothing to forget, nothing to prefer: an unconfigured app is offered neither. */
  it('offers nothing to change when no server is connected', () => {
    const markup = render({ configured: false, connected: false, identity: null, endpoints: [] });
    expect(markup).toContain('No server is connected to this app.');
    expect(markup).not.toContain('Forget');
  });
});

describe('which release each half is on', () => {
  /*
   * The shell has no updater and its own installer pins the server it sets up to the shell's
   * version, so an owner running an old app who uses the in-app installer sets up an old server -
   * and the `sha256sum -c` gate passes, because the script it checks is that old release's own.
   * Neither number was on any screen.
   */
  it('names both versions and what the installer will do when they differ', () => {
    const note = shellVersionNote('0.1.1', { version: '0.2.0', commit: 'a1b2c3d' });
    expect(note).toContain('0.1.1');
    expect(note).toContain('0.2.0 (a1b2c3d)');
    expect(note).toContain('not the newest release');
  });

  it('says so plainly when the two agree, and says only its own when the box is unknown', () => {
    expect(shellVersionNote('0.1.1', { version: '0.1.1', commit: null })).toBe(
      'This app and your server are both on 0.1.1.'
    );
    expect(shellVersionNote('0.1.1')).toBe('This app is version 0.1.1.');
  });
});
