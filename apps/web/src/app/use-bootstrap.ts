import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react';
import { api, ApiFailure } from '../api.js';
import { describeFailure } from '../failure-text.js';
import { nativeBridge } from '../native.js';
import type { InspectorTab } from '../client-state.js';
import type { Bootstrap, MessageDraft } from '../types.js';
import type { SavedModelChoice } from './use-model-choice.js';

/**
 * What the box tells this device about the owner, and where it puts each answer.
 *
 * `load` is the one route in, so every choice the owner made on another device arrives through it —
 * the panel they left open, the model they picked, the sentence they were part-way through typing.
 * Naming the destinations rather than reaching for setters is what lets those three live in the
 * hooks that own them instead of in a 3,203-line closure.
 */
export interface BootstrapRestore {
  inspector: (saved: { open: boolean; tab: InspectorTab }) => void;
  model: (saved: SavedModelChoice) => void;
  drafts: (drafts: MessageDraft[]) => void;
  pruneDrafts: (liveTaskIds: string[], sent: MessageDraft[]) => void;
}

/**
 * The connection to the box: whether this device is signed in, what it last heard, and every
 * occasion on which it asks again.
 *
 * Nine effects used to state that in nine places. They are one subject — a single-owner box the
 * screen is a window onto — and the rules between them only make sense together: a failure that is
 * not a refusal must never sign anybody out, a background poll only exists in a packaged shell,
 * and every foreground refresh is gated on somebody actually looking at the window.
 */
export const useBootstrap = (input: {
  /*
   * A ref, and it is the one cycle this screen genuinely has: bootstrap writes into state that is
   * downstream of bootstrap — the panel, the model picker and the composer all need the answer it
   * fetches, and all three are built after it. The bag is filled during the render that builds them
   * and read only from effects and promise callbacks, which cannot run before that render commits.
   */
  restore: RefObject<BootstrapRestore | null>;
  setTaskId: Dispatch<SetStateAction<string | undefined>>;
  /** Written true the moment the box has answered, so no save can precede its copy. */
  serverPreferencesLoaded: { current: boolean };
  onError: (message: string) => void;
}) => {
  const { restore, setTaskId, serverPreferencesLoaded, onError } = input;
  const [auth, setAuth] = useState<'loading' | 'required' | 'ready'>('loading');
  const [data, setData] = useState<Bootstrap>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [offline, setOffline] = useState(false);
  const currentData = useRef<Bootstrap | undefined>(undefined);
  useEffect(() => {
    currentData.current = data;
  }, [data]);

  const load = useCallback(async () => {
    try {
      const response = await api.bootstrap();
      const next: Bootstrap = { ...response, schedules: response.schedules ?? [] };
      setData(next);
      // What the owner chose, from the one place that is the same on every device they use. Applied
      // once per load and before any save is allowed, so the device adopts the shared answer rather
      // than arguing with it. A box that has never been told anything leaves this device's copy be.
      // The panel the owner left open, wherever they left it open.
      const savedInspector = next.user.preferences?.inspector;
      if (savedInspector) restore.current?.inspector(savedInspector);
      const savedModel = next.user.preferences?.model;
      if (savedModel) restore.current?.model(savedModel);
      restore.current?.drafts(next.drafts ?? []);
      serverPreferencesLoaded.current = true;
      setAuth('ready');
      setOffline(false);
      restore.current?.pruneDrafts(
        next.tasks.map((item) => item.id),
        next.drafts ?? []
      );
      const requested = new URLSearchParams(window.location.search);
      const requestedTaskId = requested.get('task') ?? undefined;
      const requestedWorkspaceId = requested.get('workspace') ?? undefined;
      const requestedTask = next.tasks.find((item) => item.id === requestedTaskId);
      const requestedWorkspace = next.workspaces.find((item) => item.id === requestedWorkspaceId);
      // Where the box last saw this owner, used only when the address says nothing. A link always
      // wins — following one is a deliberate instruction about where to go, and the saved place is
      // only a guess at where they would otherwise want to be. Installed to a home screen there is
      // never a query to read, which is exactly the case this exists for.
      const place =
        requestedTaskId || requestedWorkspaceId ? undefined : next.user.preferences?.place;
      const resumedTaskId = requestedTaskId ?? place?.taskId ?? undefined;
      const resumedTask = requestedTask ?? next.tasks.find((item) => item.id === resumedTaskId);
      // A linked conversation is kept even when the bootstrap page does not carry it; it is
      // fetched on demand below rather than silently redirecting the user to a blank new task.
      setTaskId((current) => current ?? resumedTaskId);
      setWorkspaceId((current) =>
        current && next.workspaces.some((item) => item.id === current)
          ? current
          : (resumedTask?.workspaceId ??
            requestedWorkspace?.id ??
            next.workspaces.find((item) => item.id === place?.workspaceId)?.id ??
            next.workspaces[0]?.id)
      );
    } catch (cause) {
      /*
       * Only a real refusal signs the owner out.
       *
       * Every failure used to set `auth` to 'required', which unmounts the workbench and renders
       * the marketing sign-in page — and bootstrap is re-fired on focus, online and
       * visibilitychange, so a phone losing signal in a lift replaced the conversation being
       * watched with a passkey button while its session was still perfectly valid.
       */
      const refused =
        cause instanceof ApiFailure &&
        (cause.code === 'authentication_required' || cause.status === 401);
      if (refused) {
        setAuth('required');
        return;
      }
      setOffline(true);
      // A first load has nothing to keep on screen, so the failure has to be stated somewhere.
      if (!currentData.current) onError(describeFailure(cause, 'Could not reach your athanor'));
    }
  }, []);

  /**
   * A conversation started somewhere else, on a device nobody has touched.
   *
   * Bootstrap re-ran on focus, on regaining the network and on becoming visible - all of which
   * require somebody to pick the device up. A tablet left open on the desk therefore showed the
   * sidebar it had when it was set down, however much had happened on the laptop since, which is
   * the exact opposite of what "the same computer from anywhere" promises. A minute is slow enough
   * to be nothing on a box serving one person and quick enough that the list is never a surprise;
   * only while the tab is actually being looked at, so a backgrounded phone stays silent.
   */
  useEffect(() => {
    if (auth !== 'ready') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [auth, load]);

  /*
   * Retries on its own, with backoff, so a blip heals without the owner doing anything.
   *
   * `focus`, `online` and `visibilitychange` already re-fetch, but none of those fire while the tab
   * simply sits there with no network, which is the case this is for.
   */
  useEffect(() => {
    if (!offline || auth === 'required') return;
    let attempt = 0;
    let timer = 0;
    const retry = () => {
      attempt += 1;
      void load();
      timer = window.setTimeout(retry, Math.min(30_000, 2_000 * 2 ** attempt));
    };
    timer = window.setTimeout(retry, 2_000);
    return () => window.clearTimeout(timer);
  }, [offline, auth, load]);

  return {
    auth,
    setAuth,
    data,
    setData,
    workspaceId,
    setWorkspaceId,
    offline,
    currentData,
    load
  };
};

/**
 * Every occasion on which this device asks the box what has happened.
 *
 * Held apart from `useBootstrap` because two of the three also refresh the notice log and the
 * approval queue, and those are built on top of the bootstrap rather than inside it. The rules are
 * one subject: a foreground refresh is gated on somebody actually looking at the window, and the
 * background poll — the only one that is not — exists solely because a packaged shell has no push
 * subscription and no other way of being told.
 */
export const useRefreshTriggers = (input: {
  auth: 'loading' | 'required' | 'ready';
  load: () => Promise<void>;
  refreshNotices: () => void;
  refreshApprovals: () => void;
}) => {
  const { auth, load, refreshNotices, refreshApprovals } = input;
  /*
   * The poll that runs while nobody is looking, which only a packaged shell has.
   *
   * Every other refresh here is gated on `visibilityState === 'visible'`, for good reasons: a
   * backgrounded phone should not be asking a box for anything. But that gate is also why the one
   * `notify` call site in the product could never fire — the only paths that reached it ran when the
   * window was visible, and it declines to interrupt anyone over a window they are looking at. A
   * shell with no push subscription has no other way of being told, so it keeps asking, slowly, and
   * only while it is in the background.
   */
  useEffect(() => {
    if (auth !== 'ready' || !nativeBridge.available()) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') return;
      refreshNotices();
      refreshApprovals();
      void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [auth, load, refreshNotices, refreshApprovals]);

  useEffect(() => {
    /*
     * The service worker refuses to raise a notification over a window that is already open, and
     * tells the window instead. Without this the suppressed push would cost the owner up to three
     * seconds of polling to see the approval it was about — which is the whole reason the phone
     * was allowed to stay dark.
     */
    if (!('serviceWorker' in navigator)) return;
    const receivePush = (event: MessageEvent<unknown>) => {
      const message = event.data as { source?: unknown } | null;
      if (!message || message.source !== 'athanor-push') return;
      refreshApprovals();
      refreshNotices();
      void load();
    };
    navigator.serviceWorker.addEventListener('message', receivePush);
    return () => navigator.serviceWorker.removeEventListener('message', receivePush);
  }, [load, refreshNotices, refreshApprovals]);

  useEffect(() => {
    void load();
    refreshNotices();
    const refreshWhenActive = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
      refreshNotices();
    };
    window.addEventListener('focus', refreshWhenActive);
    window.addEventListener('online', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => {
      window.removeEventListener('focus', refreshWhenActive);
      window.removeEventListener('online', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
    };
  }, [load, refreshNotices]);
};

/**
 * Whether what is on screen is a release the box has already replaced.
 *
 * The shell is served from disk and refreshed behind it, which is the whole difference between an
 * icon that opens and an icon that loads. Its one cost is a single launch, after an update, that
 * shows the previous release — and the person who pays it is whoever has just deployed, who read
 * a logo that should have changed as a deploy that had failed. The worker holds both documents at
 * the moment it can compare them; this is that answer arriving.
 *
 * Asked for as well as listened for, because the comparison is a round trip to the box and this
 * window has a module graph to evaluate first: on a box on the same network the answer is
 * routinely ready before there is anything here to receive it.
 */
export const useShellSuperseded = (): boolean => {
  const [superseded, setSuperseded] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const receive = (event: MessageEvent<unknown>) => {
      const message = event.data as { source?: unknown } | null;
      if (message?.source === 'athanor-shell-superseded') setSuperseded(true);
    };
    navigator.serviceWorker.addEventListener('message', receive);
    navigator.serviceWorker.controller?.postMessage({ source: 'athanor-shell-check' });
    return () => navigator.serviceWorker.removeEventListener('message', receive);
  }, []);
  return superseded;
};
