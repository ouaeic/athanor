import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.js';
import { bumpFire } from '../fire.js';
import {
  EMPTY_EVENT_WINDOW,
  EVENT_PAGE_SIZE,
  windowAfterPage,
  type EventWindow
} from '../event-window.js';
import { describeFailure } from '../failure-text.js';
import { mergeTaskEvents } from '../timeline-state.js';
import { upsertTask } from '../task-list.js';
import { terminalTaskStatuses } from '../task-status.js';
import type { Bootstrap, TaskEvent } from '../types.js';

/**
 * The conversation on screen, and everything that keeps it arriving.
 *
 * Four cells that are one window onto a log the box holds: the events this device has, where the
 * stream resumes (`lastSequence`), where reading backwards continues (`eventWindow`), and whether
 * the live connection is the thing feeding it. Any one of them read without the others is how a
 * transcript comes to disagree with the box — which it did three separate ways before this took the
 * shape it has: an effect keyed on the conversation alone left a finished-then-continued stream
 * closed, an `EventSource` with no `onerror` froze on the 429 the stream cap answers with, and a
 * reopen replayed from sequence zero.
 */
export const useTranscript = (input: {
  taskId: string | undefined;
  /** Whether the bootstrap has landed. The stream must not open before the box has been reached. */
  ready: boolean;
  /** Part of the key, so a turn starting or finishing rebuilds the stream rather than leaving it shut. */
  taskIsActive: boolean;
  setData: Dispatch<SetStateAction<Bootstrap | undefined>>;
  currentData: { current: Bootstrap | undefined };
  onError: (message: string) => void;
}) => {
  const { taskId, ready, taskIsActive, setData, currentData, onError } = input;
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [streamDegraded, setStreamDegraded] = useState(false);
  const lastSequence = useRef(0);
  /**
   * How much of the open conversation is on this device, and whether the box holds more before it.
   *
   * Paired with `lastSequence`, which is the other end of the same window: that one is where the
   * stream resumes, this one is where reading backwards continues.
   */
  const [eventWindow, setEventWindow] = useState<EventWindow>(EMPTY_EVENT_WINDOW);
  /**
   * The conversation whose newest page has already been asked for.
   *
   * The transcript effect is keyed on liveness as well as on the conversation, so a turn starting
   * or finishing tears it down and builds it again - and the opening page must not be re-fetched
   * for a conversation this device is already holding.
   */
  const openedTask = useRef<string | undefined>(undefined);

  useEffect(() => {
    setEvents([]);
    lastSequence.current = 0;
    // Both ends of the window go with the transcript: a fork, a branch or a plain switch starts
    // again from the newest page, and the offer to read backwards belongs to the conversation it
    // was measured on.
    setEventWindow(EMPTY_EVENT_WINDOW);
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !ready) return;
    let active = true;
    let stream: EventSource | undefined;
    let backupTimer: number | undefined;
    let reopenTimer: number | undefined;
    let failures = 0;

    /*
     * Arrivals are collected and folded in once per animation frame.
     *
     * Every event used to be its own `setEvents`, so every event was its own render, and every
     * render rebuilt the whole transcript from the whole log — `buildConversation`, the work-log
     * overview, the settled-tool set, provenance and cost, all of them full scans. Measured on an
     * 800-event log replayed the way this effect replays it: 83 ms of pure rebuild one event at a
     * time against 0.20 ms for the same log folded in once — 429x, before React touches a node. The
     * cost is quadratic in the length of the log, so it is worst on exactly the two occasions it is
     * most visible: opening a long conversation, and catching up after a dropped stream, both of
     * which arrive as a burst. Mid-answer, where a frame holds a handful of deltas rather than all
     * of them, the same change is worth about 6x.
     *
     * A frame is the right window because a frame is what the screen can show. Nothing is dropped:
     * the buffer is drained on the frame, and drained synchronously if the effect is torn down
     * first, because `lastSequence` has already moved past these events and a reopened stream would
     * not send them again.
     */
    const buffered: TaskEvent[] = [];
    let flushFrame: number | undefined;

    const flush = () => {
      flushFrame = undefined;
      if (buffered.length === 0) return;
      const batch = buffered.splice(0, buffered.length);
      setEvents((current) => mergeTaskEvents(current, batch));
    };

    const absorb = (incoming: TaskEvent) => {
      lastSequence.current = Math.max(lastSequence.current, incoming.sequence);
      // The one place the flame is fed, and it is a thing that actually happened rather than a
      // render or a timer. Here rather than after the flush, so a burst counts as a burst.
      bumpFire();
      buffered.push(incoming);
      flushFrame ??= window.requestAnimationFrame(flush);
    };

    /** The non-streaming route, used to catch up after a stream that could not be re-established. */
    const catchUp = () => {
      void api
        .events(taskId, { after: lastSequence.current })
        .then((batch) => {
          if (!active) return;
          for (const incoming of batch) absorb(incoming);
          // The marker stays up while this is what is feeding the transcript; only a stream that
          // actually reopens takes it down.
        })
        .catch(() => undefined);
    };

    const open = () => {
      if (!active) return;
      const cursor = lastSequence.current;
      stream = new EventSource(
        `/v1/tasks/${encodeURIComponent(taskId)}/events/stream${cursor ? `?after=${cursor}` : ''}`
      );
      stream.onopen = () => {
        failures = 0;
        setStreamDegraded(false);
        if (backupTimer !== undefined) {
          window.clearInterval(backupTimer);
          backupTimer = undefined;
        }
      };
      stream.onmessage = (message: MessageEvent<string>) => {
        if (!active) return;
        try {
          absorb(JSON.parse(message.data) as TaskEvent);
        } catch {
          // A malformed frame is ignored; cursor replay supplies valid persisted events.
        }
      };
      stream.addEventListener('terminal', () => stream?.close());
      stream.onerror = () => {
        if (!active) return;
        // The browser retries a dropped connection on its own; what it cannot recover from is a
        // non-200, which is what the stream cap answers with.
        if (stream?.readyState !== EventSource.CLOSED) return;
        failures += 1;
        stream = undefined;
        if (failures >= 2 && backupTimer === undefined) {
          setStreamDegraded(true);
          catchUp();
          backupTimer = window.setInterval(catchUp, 2_000);
        }
        reopenTimer = window.setTimeout(open, Math.min(30_000, 1_000 * 2 ** failures));
      };
    };

    /**
     * The newest page first, then the stream from where that page ends.
     *
     * Opening used to be one act: point an `EventSource` at cursor zero and let the box replay the
     * conversation from its first frame. On a 2,000-event conversation that is 43.2 ms of decrypt
     * and re-serialise on the box and 1.09 MB on the wire before the newest message can be drawn,
     * against 3.7 ms and 110 kB for the newest page alone - and 24.6 ms against 5.2 ms of parsing
     * and building on this side. The page is one request; the stream then resumes at its last
     * sequence, so nothing arrives twice and nothing older is ever sent.
     *
     * If the page cannot be fetched the stream still opens, at cursor zero, which is exactly what
     * this did before - a degraded open is a whole conversation, not an empty one.
     */
    const start = async () => {
      if (openedTask.current !== taskId) {
        openedTask.current = taskId;
        try {
          const page = await api.events(taskId, { limit: EVENT_PAGE_SIZE });
          if (!active) return;
          for (const incoming of page) absorb(incoming);
          setEventWindow(windowAfterPage(page));
        } catch {
          // Left at the empty window: no offer to read backwards, and the stream below opens at
          // zero and replays everything, which is the behaviour this replaced.
        }
        if (!active) return;
      }
      open();
    };
    void start();

    const poll = async () => {
      try {
        const updated = await api.task(taskId);
        if (!active) return;
        // Upsert, not map: a conversation older than the newest 200 is reachable from search and
        // from a link, and a map would drop it on the floor and render an empty canvas forever.
        setData((current) =>
          current ? { ...current, tasks: upsertTask(current.tasks, updated) } : current
        );
      } catch {
        /* a later cursor poll retries */
      }
    };
    void poll();
    // A finished conversation has nothing left to poll for, but the timer stays alive: a follow-up
    // puts the same conversation back to work without changing its id.
    const timer = window.setInterval(() => {
      if (
        terminalTaskStatuses.has(
          currentData.current?.tasks.find((item) => item.id === taskId)?.status ?? ''
        )
      )
        return;
      void poll();
    }, 3_000);
    return () => {
      active = false;
      stream?.close();
      window.clearInterval(timer);
      if (backupTimer !== undefined) window.clearInterval(backupTimer);
      if (reopenTimer !== undefined) window.clearTimeout(reopenTimer);
      // Liveness is part of this effect's key, so a turn finishing tears it down mid-stream. The
      // frame that was owed would never run, and the cursor has already passed what it was holding.
      if (flushFrame !== undefined) {
        window.cancelAnimationFrame(flushFrame);
        flush();
      }
    };
  }, [taskId, ready, taskIsActive]);

  /**
   * The part of this conversation that opening it deliberately did not send.
   *
   * "Earlier in this conversation" only ever revealed transcript nodes this device already held,
   * so it stopped at the top of whatever had been loaded and the rest of a long conversation was
   * unreachable. It now walks the same window backwards a page at a time: `before` the oldest
   * sequence held, oldest-first, merged rather than prepended because a page can overlap what is
   * here after a reconnect replayed part of it.
   *
   * The merge is the per-event path rather than a concat - the batch is older than everything held,
   * which is the one order `mergeTaskEvents` cannot fast-path - and that is fine at this size: it
   * happens on a click, once per page, not on every frame of a streaming answer.
   */
  const loadEarlier = async () => {
    const id = taskId;
    if (!id || !eventWindow.more || eventWindow.loading || eventWindow.oldest <= 1) return;
    setEventWindow((current) => ({ ...current, loading: true }));
    try {
      const page = await api.events(id, { before: eventWindow.oldest, limit: EVENT_PAGE_SIZE });
      // The conversation may have been switched while this was in flight; its events belong to a
      // transcript that is no longer on screen.
      if (openedTask.current !== id) return;
      setEvents((current) => mergeTaskEvents(current, page));
      setEventWindow((current) => windowAfterPage(page, current));
    } catch (cause) {
      setEventWindow((current) => ({ ...current, loading: false }));
      onError(describeFailure(cause, 'Could not load the earlier part of this conversation'));
    }
  };

  return { events, setEvents, eventWindow, streamDegraded, loadEarlier };
};
