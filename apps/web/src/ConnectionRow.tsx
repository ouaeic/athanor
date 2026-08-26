/**
 * Which box this packaged app is pinned to, and the three things it could never say about it.
 *
 * The shell has answered `GET /__athanor/client/status` since the gateway existed and a grep for
 * that path over the whole repository returned exactly one line: its own registration. So the app
 * knew the server's pinned identity, every address it had learned, whether it was connected and why
 * it was not — and showed none of it. An owner whose box had moved saw a connection screen; an owner
 * who wanted to point the app at a different box had to delete `server-profile.json` by hand.
 *
 * The network preference is the part that was actively wrong. It is writable only from the offline
 * screen, which offers the buttons for `Unknown` and `Dynamic` and nothing at all for `Fixed` — so
 * answering "my address is fixed" once, which is the plausible wrong answer for anyone on a home
 * connection, removed the dynamic-DNS guidance for ever on a client that would now keep failing to
 * find the box with no explanation. All three values are offered here, always, in both directions.
 *
 * Renders nothing at all in a browser. Every route it calls is served by the packaged shell's own
 * loopback gateway and by nothing else, so on a box reached over the web this section is not empty,
 * it is absent — which is the honest answer to "which server is this app pinned to" when the answer
 * is "the one whose address is in your address bar".
 */
import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { api } from './api.js';
import { nativeBridge } from './native.js';
import { securityActionMessage } from './account-security.js';
import { describeFailure } from './failure-text.js';
import { buildLabel, type BuildIdentity } from '@athanor/contracts';
import './connection.css';

/** The three the shell stores, spelled as its own serialisation spells them. */
export type NetworkPreference = 'unknown' | 'dynamic' | 'fixed';

/** What `GET /__athanor/client/status` reports about this device's one server. */
export interface ClientConnection {
  configured: boolean;
  connected: boolean;
  identity: string | null;
  endpoints: string[];
  /** Why it is not connected, and only ever while it is not. Never a stale failure. */
  error: string | null;
  /**
   * Both nullable for the same reason and not for the same one.
   *
   * `networkPreference` is null when no server is configured at all — there is no profile to hold
   * one. `appVersion` is null only when the shell answering is older than the field, which is a
   * case this screen has to survive rather than one it should invent a version number for.
   */
  networkPreference: NetworkPreference | null;
  appVersion: string | null;
}

const preferences: readonly NetworkPreference[] = ['unknown', 'dynamic', 'fixed'];

/**
 * What each answer actually changes, which is one thing and is not what any of them sound like.
 *
 * The preference does not affect how the app finds the box: it follows every address it has learned
 * either way. All it decides is what the connection screen says when the app cannot find it — and
 * `fixed` is the one that says nothing, which is why it was worth being able to take back.
 */
export const networkPreferenceCopy: Record<NetworkPreference, { label: string; means: string }> = {
  unknown: {
    label: 'Not answered',
    means:
      'If the app ever cannot reach your server it will ask whether the address may have changed.'
  },
  dynamic: {
    label: 'It can change',
    means:
      'If the app cannot reach your server, its connection screen explains how to give the box a stable hostname.'
  },
  fixed: {
    label: 'It never changes',
    means:
      'The connection screen will offer no address guidance, so if the server does move the app will only report that it cannot be reached.'
  }
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The status as this screen is prepared to believe it.
 *
 * Written as a guard rather than a cast because the shell answering may be older than this file —
 * `networkPreference` and `appVersion` were both added to the report after it shipped — and an
 * absent field has to read as "this app cannot say" rather than as `undefined` rendered into a row.
 */
export const clientConnection = (value: unknown): ClientConnection | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.configured !== 'boolean') return undefined;
  const preference = text(raw.networkPreference);
  return {
    configured: raw.configured,
    connected: raw.connected === true,
    identity: text(raw.identity),
    endpoints: Array.isArray(raw.endpoints)
      ? raw.endpoints.map(text).filter((entry): entry is string => entry !== null)
      : [],
    error: text(raw.error),
    networkPreference: preferences.includes(preference as NetworkPreference)
      ? (preference as NetworkPreference)
      : null,
    appVersion: text(raw.appVersion)
  };
};

/**
 * Whether this app and the box it installed agree about which release they are on.
 *
 * The shell has no updater, and its own installer pins the server it sets up to the shell's version
 * — so an owner running a year-old app who uses the in-app installer sets up a year-old server, and
 * the installer's `sha256sum -c` gate passes, because the script it checks is that old release's
 * own. Neither number is on any screen. The sentence deliberately does not say which side is
 * behind: it says what the installer will do, which is true in either direction.
 */
export const shellVersionNote = (
  appVersion: string | null,
  serverBuild?: BuildIdentity | null
): string | null => {
  if (!appVersion) return null;
  if (!serverBuild) return `This app is version ${appVersion}.`;
  if (serverBuild.version === appVersion)
    return `This app and your server are both on ${buildLabel(serverBuild)}.`;
  return (
    `This app is version ${appVersion}; your server reports ${buildLabel(serverBuild)}. ` +
    `Installing a server from this app sets up ${appVersion} to match it, not the newest release.`
  );
};

/** One line for the state of the connection itself, which is the row's headline. */
export const connectionStateLine = (status: ClientConnection): string => {
  if (!status.configured) return 'No server is connected to this app.';
  if (status.connected) return 'Connected.';
  return status.error ?? 'Not connected. The app is still trying.';
};

/**
 * Every call this file makes goes to the shell's own gateway, never to the box.
 *
 * `credentials: 'same-origin'` because these are the gateway's routes and not the API's; the three
 * that write insist on an exact `Origin` header, which the browser attaches to a same-origin POST
 * or DELETE and to nothing else. The failure shape is the gateway's own `{error:{code,message}}`,
 * and its messages are written for this screen — "Connect an athanor server before saving network
 * preferences" is the whole answer — so they are surfaced rather than replaced.
 */
const gateway = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`/__athanor/client/${path}`, {
    credentials: 'same-origin',
    ...init
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body as { error?: { message?: unknown } } | undefined)?.error;
    throw new Error(text(error?.message) ?? 'The athanor app could not answer.');
  }
  return body;
};

export const readConnection = async (): Promise<ClientConnection | undefined> =>
  clientConnection(await gateway('status'));

export const saveNetworkPreference = async (preference: NetworkPreference): Promise<void> => {
  await gateway('network-preference', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preference })
  });
};

/**
 * Unpins the server, which is the one thing `ClientState` could do and nothing could ask it to.
 *
 * It removes the profile from this device and nothing else: the box keeps running, keeps its data
 * and keeps every other device paired to it. What the app does next is show its connection screen,
 * which is also how it is pointed at a different server — the same screen, a different ticket.
 */
export const forgetServer = async (): Promise<void> => {
  await gateway('profile', { method: 'DELETE' });
};

/**
 * One sentence for a failed disconnect, from whichever of the two halves failed.
 *
 * A refused passkey is `securityActionMessage`'s subject — it is what turns the server's bare
 * "confirm this sensitive action with your passkey" into something with a next step, that
 * instruction otherwise being an order with no control attached to it. Everything else came from
 * the shell's own gateway, and `describeFailure` already words those, transport included.
 */
export const forgetFailure = (cause: unknown): string => {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  return code.startsWith('step_up')
    ? securityActionMessage(cause)
    : describeFailure(cause, 'This server could not be forgotten.');
};

/**
 * Everything the shell reports, drawn from an answer that is already in hand.
 *
 * Separate from the component that fetches it because what this row says decides whether an owner
 * unpins the only copy of their server's identity, and that is worth asserting directly rather than
 * through a spy on a request.
 */
export function ConnectionDetails({
  status,
  serverBuild,
  busy = false,
  armed = false,
  onPrefer,
  onArm,
  onForget
}: {
  status: ClientConnection;
  serverBuild?: BuildIdentity | null | undefined;
  busy?: boolean;
  armed?: boolean;
  onPrefer: (preference: NetworkPreference) => void;
  onArm: (armed: boolean) => void;
  onForget: () => void;
}) {
  const version = shellVersionNote(status.appVersion, serverBuild);
  return (
    <div className="settings-list connection-list">
      <div>
        <span>
          <strong>{connectionStateLine(status)}</strong>
          {status.identity ? (
            <small>
              Pinned identity <code className="connection-identity">{status.identity}</code>
            </small>
          ) : null}
          {version ? <small>{version}</small> : null}
        </span>
      </div>
      {status.configured ? (
        <div>
          <span>
            <strong>Addresses it has learned</strong>
            {status.endpoints.length ? (
              status.endpoints.map((endpoint) => (
                <small key={endpoint} className="connection-identity">
                  {endpoint}
                </small>
              ))
            ) : (
              <small>None yet — the app has only the address the ticket carried.</small>
            )}
            {/* The shell rewrites this list on every reconnect, so a stale-looking address here is
                a record of where the box has been rather than a setting anybody chose. */}
            <small>
              Refreshed every time the app reconnects, so this is where the box has been.
            </small>
          </span>
        </div>
      ) : null}
      {status.configured ? (
        <div>
          <span>
            <strong>Does your server&apos;s address change?</strong>
            <small>{networkPreferenceCopy[status.networkPreference ?? 'unknown'].means}</small>
            {/* Answerable again, and in both directions. It was answerable once, from a screen only
                a broken connection could reach, and "my address is fixed" removed the screen that
                asked. */}
            <small>You can change this answer whenever you like.</small>
          </span>
          <div className="settings-row-actions">
            {preferences.map((preference) => (
              <button
                key={preference}
                type="button"
                className={preference === status.networkPreference ? '' : 'secondary'}
                aria-pressed={preference === status.networkPreference}
                disabled={busy}
                onClick={() => onPrefer(preference)}
              >
                {networkPreferenceCopy[preference].label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {status.configured ? (
        <div>
          <span>
            <strong>Forget this server</strong>
            <small>
              This app returns to its connection screen, where a ticket for any athanor server can
              be pasted — which is also how you move this app to a different box. Nothing on the
              server is changed or deleted.
            </small>
            {status.connected ? (
              <small>You will be asked to confirm with a passkey first.</small>
            ) : (
              /* No passkey when the box cannot be reached, because the box is what verifies one -
                 and the moment an owner most needs to unpin a server is the moment it has stopped
                 answering. The second press is the whole gate then, and it says so. */
              <small>
                Your server cannot be reached, so it cannot confirm this. Only what is stored on
                this device will be removed.
              </small>
            )}
          </span>
          <div className="settings-row-actions">
            {armed ? (
              <>
                <button className="danger" disabled={busy} onClick={onForget}>
                  Forget it
                </button>
                <button className="secondary" disabled={busy} onClick={() => onArm(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button className="secondary" disabled={busy} onClick={() => onArm(true)}>
                Forget
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The section as it draws inside the packaged app, once the gate above has let it through.
 *
 * Its own component so the gate can be a plain early return: a check that decides whether a whole
 * surface exists should not have to be spelled as a condition inside every hook below it.
 */
function PackagedConnection({ serverBuild }: { serverBuild?: BuildIdentity | null | undefined }) {
  const [status, setStatus] = useState<ClientConnection>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  const load = (): void => {
    readConnection()
      .then((answer) => {
        // An answer this file will not vouch for is a failure and is said out loud. Setting it and
        // drawing nothing would leave a heading over an empty space, which reads as a screen that
        // was never finished rather than as an app that could not answer for itself.
        if (answer) setStatus(answer);
        else setError('This app answered with something this screen does not recognise.');
      })
      .catch((cause: unknown) => {
        setError(describeFailure(cause, 'This app could not report its own connection.'));
      });
  };

  useEffect(load, []);

  const prefer = (preference: NetworkPreference): void => {
    setBusy(true);
    setError('');
    saveNetworkPreference(preference)
      .then(() => {
        // Read it back rather than assume it: the shell refuses a preference when no server is
        // configured, and a row that painted the new answer on its own would be showing a setting
        // the device does not hold.
        load();
      })
      .catch((cause: unknown) => {
        setError(describeFailure(cause, 'That answer could not be saved on this device.'));
      })
      .finally(() => setBusy(false));
  };

  const forget = (): void => {
    setBusy(true);
    setError('');
    /*
     * The passkey first, and only while the box can be asked for one. Unpinning is not undoable
     * from this screen - getting back needs a fresh ticket, which needs a login on the server - so
     * it is worth the confirmation that the rest of this page asks for before a deletion. When the
     * connection is down there is nothing that could verify a passkey, and refusing to unpin a
     * server that has stopped answering would be the trap this whole section exists to open.
     */
    (status?.connected ? api.stepUp() : Promise.resolve())
      .then(forgetServer)
      .then(() => {
        setArmed(false);
        // The gateway serves its connection screen for any page load once the profile is gone, so
        // reloading is what actually takes the owner there.
        location.reload();
      })
      .catch((cause: unknown) => {
        setArmed(false);
        setError(forgetFailure(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="section-heading compact">
        <Server />
        <div>
          <strong>This device&apos;s connection</strong>
          <span>
            Which athanor this app is pinned to, how it finds it, and how to point it somewhere
            else.
          </span>
        </div>
      </div>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      {status ? (
        <ConnectionDetails
          status={status}
          serverBuild={serverBuild}
          busy={busy}
          armed={armed}
          onPrefer={prefer}
          onArm={setArmed}
          onForget={forget}
        />
      ) : null}
    </>
  );
}

/**
 * The gate, and the reason this file has two components in it.
 *
 * `nativeBridge.available()` is the one question that separates the packaged shell from a browser,
 * and every route below it is served by the shell alone. In a browser this renders nothing — not an
 * empty section, not a disabled row, nothing — because there is no pinned server to describe and a
 * greyed-out "Forget this server" would be the sort of control this program exists to remove.
 */
export function ConnectionRow({ serverBuild }: { serverBuild?: BuildIdentity | null | undefined }) {
  if (!nativeBridge.available()) return null;
  return <PackagedConnection serverBuild={serverBuild} />;
}
