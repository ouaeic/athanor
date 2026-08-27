import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api } from '../api.js';
import { readInspectorChoice, writeInspectorChoice, type InspectorTab } from '../client-state.js';
import { followedPane } from '../inspector-follow.js';
import type { FileRequest, FileTarget, Task, TaskEvent } from '../types.js';

/**
 * The tools panel: whether it is there, which pane it is showing, and who decided that.
 *
 * Four cells that only make sense together. `open` and `tab` are the owner's stored choice, kept on
 * the box rather than in this browser; `heldFor` is the conversation in which they have overruled
 * the panel's own idea of where to look; `mounted` is the one-way latch that decides whether the
 * panel exists at all. Reading any one of them without the others gets the answer wrong — which is
 * how a suggestion once came to overwrite a saved preference, and how tapping "Work" on a phone
 * came to kill a running terminal.
 */
export const useInspector = (input: {
  taskId: string | undefined;
  task: Task | undefined;
  events: TaskEvent[];
  /** Until the box has answered, a save would be this browser's stale copy overwriting the shared one. */
  serverPreferencesLoaded: RefObject<boolean>;
}) => {
  const { taskId, task, events, serverPreferencesLoaded } = input;
  // The device's own copy, kept only so the first paint has something and so a box that cannot be
  // reached still offers the last choice. The server's copy is the real one and replaces it below.
  const stored = useRef(readInspectorChoice());
  const [open, setOpen] = useState(stored.current?.open ?? false);
  /*
   * Whether the panel has ever been opened, which is the only thing that decides whether it exists.
   *
   * A ref, not state: it only ever goes from false to true, and the render that has to notice is the
   * one `setOpen(true)` already causes. Nothing is built until it is asked for - a shell on
   * the box, a directory listing and a preview poll are all things nobody should pay for on a panel
   * they have never opened - and nothing is taken down once it is.
   */
  const mounted = useRef(false);
  if (open) mounted.current = true;
  const [tab, setTab] = useState<InspectorTab>(stored.current?.tab ?? 'files');
  /**
   * The conversation whose panel the owner has taken charge of.
   *
   * The panel follows the running work (see `inspector-follow.ts`), and following stops the instant
   * the owner names a tab themselves — for that conversation, not forever, because the next one is
   * a fresh question about where to look. Holding the conversation's id rather than a flag is what
   * makes it reset on its own when the owner moves. `''` is the conversation that does not exist
   * yet, so a tab chosen before the first message is sent survives becoming a task.
   */
  const [heldFor, setHeldFor] = useState<string>();
  useEffect(() => {
    writeInspectorChoice({ open, tab });
    // And to the box, on the same debounce as the other choices, so the panel is the owner's
    // rather than this browser's. Written only once the server's own answer has arrived, or the
    // first render would publish this device's default over whatever the box was holding.
    if (!serverPreferencesLoaded.current) return;
    const timer = window.setTimeout(() => {
      void api.savePreferences({ inspector: { open, tab } }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [open, tab]);
  /**
   * A tab the owner asked for by name, from wherever they asked: the strip, the phone bar, the
   * palette, a banner. Every one of them is the owner overruling the panel's own idea of where to
   * look, so every one of them stops it following until they move on.
   */
  const chooseTab = useCallback(
    (next: InspectorTab) => {
      setTab(next);
      setHeldFor(taskId ?? '');
    },
    [taskId]
  );
  const openTab = useCallback(
    (next: InspectorTab) => {
      setOpen(true);
      chooseTab(next);
    },
    [chooseTab]
  );
  /**
   * A file named in the conversation, opened where the owner is already looking.
   *
   * One state, not a call into the panel, because the panel is a sibling: the Files pane watches
   * this the way it watches the workspace it belongs to. The stamp is a count rather than a clock -
   * two clicks inside the same millisecond are two requests, and the pane has to obey both.
   */
  const [fileTarget, setFileTarget] = useState<FileTarget>();
  const openFile = useCallback(
    (request: FileRequest) => {
      setFileTarget((current) => ({ ...request, nonce: (current?.nonce ?? 0) + 1 }));
      openTab('files');
    },
    [openTab]
  );
  /*
   * The panel follows the work, until the owner says otherwise.
   *
   * The Inspector is 38% of a 1600px window and its default is a file listing, so an agent driving
   * the screen or running a build was doing it behind a directory that had not changed since it
   * loaded. `followedPane` names the pane where that would be visible, and it is only ever a
   * suggestion: the owner's own choice is what is stored and what comes back on the next device,
   * and naming a tab by hand ends the following for that conversation. So this is computed for the
   * render rather than written into `tab` — a suggestion that overwrote the saved choice
   * would be a hijack with a longer memory than the hijack.
   */
  const suggested = useMemo(() => followedPane(task, events), [task, events]);
  const shownTab = heldFor === (taskId ?? '') ? tab : (suggested ?? tab);
  /** The choice the box was holding, adopted once per bootstrap and before any save is allowed. */
  const applySaved = useCallback((saved: { open: boolean; tab: InspectorTab }) => {
    setOpen(saved.open);
    setTab(saved.tab);
  }, []);
  /**
   * A tab the owner picked while there was no conversation was picked for *this* one. Without it the
   * panel started following the moment the first message landed, over the top of a choice made
   * seconds earlier.
   */
  const carryChoiceInto = useCallback((createdTaskId: string) => {
    setHeldFor((current) => (current === '' ? createdTaskId : current));
  }, []);
  return {
    open,
    setOpen,
    mounted,
    shownTab,
    chooseTab,
    openTab,
    fileTarget,
    openFile,
    applySaved,
    carryChoiceInto
  };
};
