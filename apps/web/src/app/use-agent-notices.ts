import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiFailure } from '../api.js';
import { approvalDenialMessage, approvalReach } from '../approval-copy.js';
import { describeFailure } from '../failure-text.js';
import { nativeBridge } from '../native.js';
import { nativeNotificationsEnabled } from '../native-notifications.js';
import type { NotificationSettings } from '../notification-settings.js';
import type { AgentNotification } from '../notice-log.js';
import { taskStateAnnouncement } from '../timeline-state.js';
import { terminalTaskStatuses } from '../task-status.js';
import type { Approval, Bootstrap } from '../types.js';
import { nativeNoticesToRaise, type NativeNotice } from './conversation-facts.js';

/**
 * Everything athanor has decided to tell the owner, and whether the packaged shell should ring.
 *
 * Three lists arrive from three different polls — the notice log, the approval queue, and
 * conversations reaching an end — and each needs its own seen-set. One shared set would let
 * whichever list answered second skip its own seeding and ring for everything already waiting.
 * Each is null until its source has answered once, which is what makes the seeding honest: seeded
 * from an empty initial state instead, the first real answer would look like news and a shell
 * opening to four waiting approvals would raise four notifications about them.
 */
export const useAgentNotices = (input: {
  auth: 'loading' | 'required' | 'ready';
  /** Read whenever Settings has been open, because that is the only screen that can change it. */
  settingsOpen: boolean;
  tasks: Bootstrap['tasks'] | undefined;
  /** How fast the queue is polled: three seconds while a turn is running, fifteen otherwise. */
  taskIsActive: boolean;
  /** The bootstrap this render has, read at announce time to name the conversation a request is in. */
  currentData: RefObject<Bootstrap | undefined>;
  /** The card owes focus back when the last request goes; there is nothing left to leave it on. */
  focusComposer: () => void;
  onError: (message: string) => void;
}) => {
  const { auth, settingsOpen, tasks, taskIsActive, currentData, focusComposer, onError } = input;
  const [notices, setNotices] = useState<AgentNotification[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // Kept apart from `error` because only one thing may sit above the composer and the approval card
  // is what sits there while a decision is pending - an answer that would not send has to be said
  // on the card, and a failure from anywhere else must not be. Carried with the request's id: the
  // pending list is refetched every few seconds, and the next card must not inherit this one's.
  const [approvalFailure, setApprovalFailure] = useState<{
    approvalId: string;
    message: string;
  }>();
  /**
   * Notices already seen, so a packaged shell rings once per notice rather than once per poll.
   *
   * Seeded on the first load rather than left empty: a shell opening to four waiting notices should
   * show them, not raise four notifications about things that happened while it was closed.
   */
  const announcedNotices = useRef<Set<string> | null>(null);
  const announcedApprovals = useRef<Set<string> | null>(null);
  const announcedEndings = useRef<Set<string> | null>(null);
  /** The owner's notification policy, read by the one client it was never applied to. */
  const [notificationPolicy, setNotificationPolicy] = useState<NotificationSettings | null>(null);

  const announce = useCallback(
    (seen: { current: Set<string> | null }, candidates: NativeNotice[]) => {
      // The first sight of a list is not news. A shell opening to four waiting approvals should
      // show them, not raise four notifications about things that happened while it was closed.
      if (!seen.current) {
        seen.current = new Set(candidates.map((candidate) => candidate.id));
        return;
      }
      // Only in a packaged shell - a browser has Web Push, which the box drives - only once the
      // owner has pressed the button in Settings that stores the preference, and only when nobody
      // is looking at the window: a notification about something already on screen is noise.
      //
      // The middle clause is what stops `notify` raising an OS permission dialog from a timer, at a
      // moment the owner did not choose, under a screen that told them it could not happen at all.
      if (
        !nativeBridge.available() ||
        !nativeNotificationsEnabled() ||
        document.visibilityState === 'visible'
      ) {
        for (const candidate of candidates) seen.current.add(candidate.id);
        return;
      }
      for (const notice of nativeNoticesToRaise({
        candidates,
        seen: seen.current,
        settings: notificationPolicy
      }))
        void nativeBridge.notify(notice.title, notice.body);
    },
    [notificationPolicy]
  );

  const loadNotices = useCallback(() => {
    void api
      .agentNotifications()
      .then((list) => {
        const next = list ?? [];
        setNotices(next);
        announce(
          announcedNotices,
          next.map((notice) => ({
            id: notice.id,
            kind: notice.kind === 'takeover_needed' ? 'takeoverNeeded' : 'agentMessage',
            title: notice.taskTitle || 'athanor',
            body: notice.message
          }))
        );
      })
      .catch(() => undefined);
  }, [announce]);

  /*
   * Read whenever Settings has been open, because that is the only screen that can change it, and
   * only on a packaged shell: a browser's copy of this policy is applied by the box on the delivery
   * path and asking for it here would buy nothing. A box too old to have the route answers null,
   * which `ringsNatively` reads as "has never been told otherwise".
   */
  useEffect(() => {
    if (auth !== 'ready' || settingsOpen || !nativeBridge.available()) return;
    void api
      .notificationSettings()
      .then(setNotificationPolicy)
      .catch(() => undefined);
  }, [auth, settingsOpen]);

  /*
   * The approval queue is the one the box ranks priority 0 — the agent has stopped and is waiting
   * on a person — and it was the one kind the native path could not carry. The list is already
   * here; this is the seen-set treatment the notice poll has always had, applied to it.
   *
   * Announced from the answer rather than from an effect on the state it lands in: an empty first
   * poll is indistinguishable from the empty initial state, so an effect would seed from the state
   * before anything had been asked and then ring for every request already waiting.
   */
  const receiveApprovals = useCallback(
    (pending: Approval[]) => {
      setApprovals(pending);
      announce(
        announcedApprovals,
        pending.map((approval) => ({
          id: approval.id,
          kind: 'approvalRequired' as const,
          title:
            currentData.current?.tasks.find((item) => item.id === approval.taskId)?.title ??
            'athanor',
          // The same sentence the card and the live region use, so what wakes the phone and what
          // is on the screen when they pick it up are the same words.
          body: `Your confirmation is required. ${approvalReach(approval)}.`
        }))
      );
    },
    [announce]
  );

  /*
   * A conversation reaching an end, which is `task_finished` — a kind the settings screen has always
   * offered a switch for and which nothing on this client could ever raise.
   *
   * The id carries the status, so the transition is what is announced rather than the conversation:
   * a task that is already finished when the app opens seeds the set and says nothing.
   */
  useEffect(() => {
    if (!tasks) return;
    announce(
      announcedEndings,
      tasks
        .filter((item) => terminalTaskStatuses.has(item.status))
        .map((item) => ({
          id: `${item.id}:${item.status}`,
          kind: 'taskFinished' as const,
          // The sentence already names the conversation, so the title does not say it twice.
          title: 'athanor',
          body: taskStateAnnouncement(item.title, item.status)
        }))
    );
  }, [tasks, announce]);

  /**
   * The approval queue is deliberately global — it is never filtered to the open conversation — so
   * what feeds it must be too. It used to be polled inside the transcript effect, which returns
   * early with no conversation open and cleared its own timer once the open one finished. An
   * approval raised by a scheduled run therefore never appeared on the new-conversation screen,
   * which is exactly the screen someone sits on while thinking.
   */
  useEffect(() => {
    if (auth !== 'ready') return;
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void api
        .approvals()
        .then((pending) => {
          if (active) receiveApprovals(pending);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, taskIsActive ? 3_000 : 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [auth, taskIsActive, receiveApprovals]);

  /** The same ask, on demand, for the two paths that are told rather than polling: push and the shell. */
  const refreshApprovals = useCallback(() => {
    void api
      .approvals()
      .then(receiveApprovals)
      .catch(() => undefined);
  }, [receiveApprovals]);

  /**
   * The owner's answer to one request, and everything that has to be true after it lands.
   *
   * The card only goes when the decision actually landed. It used to be an unguarded `async` called
   * as `void onResolve(...)`, so an expired approval or a dropped connection produced an unhandled
   * rejection and a button that did nothing at all — on the one control where doing nothing silently
   * is least acceptable. The wording matches what the lock-screen path already says for the same
   * three outcomes.
   */
  const resolve = async (id: string, decision: 'approve' | 'deny', note?: string) => {
    setApprovalFailure(undefined);
    // Read before the decision lands, because the row it is read from is about to be filtered out
    // of the list below and the message needs the conversation it belongs to - which is routinely
    // not the one on screen.
    const refused = approvals.find((item) => item.id === id);
    try {
      await api.resolveApproval(id, decision);
      setApprovals((items) => items.filter((item) => item.id !== id));
      onError('');
      /*
        The reason, sent as what it is: the owner's own words, on the channel that already carries
        them.

        Second request rather than a field on the first, and deliberately so. This one is encrypted
        with the workspace key, lands in the transcript where the owner can read back what they
        said, and is owner speech everywhere it matters - the taint model and the compaction rule
        that never paraphrases the user. `interrupt` is the whole point of the timing: the denied
        turn resumes the moment the decision lands, and a message that waited for it to finish would
        arrive after the agent had already tried the neighbouring version of the thing it was just
        refused.

        Nothing is sent for an untouched box, so denying costs exactly the one request it cost
        before this field existed.
      */
      const message = refused ? approvalDenialMessage(refused, note) : '';
      if (refused && message)
        await api
          .continueTask(refused.taskId, { prompt: message, interrupt: true })
          // The decision itself has landed and the card is gone, so this cannot be said on the
          // card. Said in the strip instead, and said specifically: an owner who typed a reason
          // has to know whether the agent got it.
          .catch((cause: unknown) =>
            onError(describeFailure(cause, 'That request was denied, but your reason was not sent'))
          );
      // The card took focus when it appeared, so it owes it back: the control just pressed is about
      // to unmount, and focus left on a dead node drops a keyboard onto the top of the document.
      // Not when another request is queued — that card focuses itself a commit later, and it is
      // still the owner's turn.
      if (approvals.length <= 1) focusComposer();
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.status === 404) {
        // The request is gone, so its card goes with it and there is nothing left to write on. The
        // strip below says why, which it can once no other request is waiting - and when one is,
        // the card being replaced is itself the answer.
        setApprovals((items) => items.filter((item) => item.id !== id));
        onError('That request was already answered, or it expired.');
        return;
      }
      setApprovalFailure({
        approvalId: id,
        message: describeFailure(cause, 'That decision could not be sent')
      });
    }
  };

  return {
    notices,
    loadNotices,
    approvals,
    refreshApprovals,
    approvalFailure,
    resolve
  };
};
