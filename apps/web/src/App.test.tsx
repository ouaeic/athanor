/**
 * Which conversation has the computer.
 *
 * These cases are the queueing rule the box actually runs, read from this side: one computer goes
 * to one conversation at a time, a computer of its own runs at once, and parking a turn hands the
 * computer over rather than holding it until something expires. If the two ever disagree the screen
 * is telling the owner to wait for a computer that is free, or saying nothing while they wait.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computerHeldBy,
  mayOfferReload,
  nativeNoticesToRaise,
  type NativeNotice
} from './app/conversation-facts.js';
import { api } from './api.js';
import type { NotificationSettings } from './notification-settings.js';
import type { Task } from './types.js';

const conversation = (id: string, status: Task['status'], workspaceId = 'desk'): Task =>
  ({ id, workspaceId, status, title: `Conversation ${id}` }) as Task;

const waiting = conversation('second', 'queued');

describe('the conversation holding the computer', () => {
  it('is the neighbour working on the same computer', () => {
    const working = conversation('first', 'running');
    expect(computerHeldBy(waiting, [working, waiting])).toBe(working);
  });

  it('counts a neighbour that has only just been handed the computer', () => {
    // `planning` is written by the hand-over itself, so it is a holder from its first millisecond.
    const handed = conversation('first', 'planning');
    expect(computerHeldBy(waiting, [handed, waiting])).toBe(handed);
  });

  it('is nobody when the work is on another computer', () => {
    const elsewhere = conversation('first', 'running', 'spare');
    expect(computerHeldBy(waiting, [elsewhere, waiting])).toBeUndefined();
  });

  it('is nobody once the turn holding it has parked to ask the owner something', () => {
    const parked = conversation('first', 'awaiting_user');
    expect(computerHeldBy(waiting, [parked, waiting])).toBeUndefined();
  });

  it('is nobody when the neighbour is queued too, because neither has been handed anything', () => {
    const alsoWaiting = conversation('first', 'queued');
    expect(computerHeldBy(waiting, [alsoWaiting, waiting])).toBeUndefined();
  });

  it('is nobody for a conversation that is itself working', () => {
    const working = conversation('second', 'running');
    expect(computerHeldBy(working, [conversation('first', 'running'), working])).toBeUndefined();
  });
});

/**
 * When the screen may say it is showing a release the box has replaced.
 *
 * The offer ends in a reload, and a reload throws away everything that exists only in this tab. The
 * sentence in the composer is banked on the way out; a recording and an attachment tray cannot be,
 * so the offer waits rather than asking anyone to trade work for it. Nothing here expires, so
 * waiting costs nothing at all.
 */
describe('offering the reload', () => {
  const tab = { superseded: true, recording: false, attachmentCount: 0 };

  it('is made when this tab is holding nothing of its own', () => {
    expect(mayOfferReload(tab)).toBe(true);
  });

  it('is not made when there is nothing to say', () => {
    expect(mayOfferReload({ ...tab, superseded: false })).toBe(false);
  });

  it('waits while a voice note is being recorded, which exists nowhere else yet', () => {
    expect(mayOfferReload({ ...tab, recording: true })).toBe(false);
  });

  it('waits while files are attached, because the box is told about them with the next keystroke', () => {
    expect(mayOfferReload({ ...tab, attachmentCount: 1 })).toBe(false);
  });

  it('never appears for its own sake once the recording and the tray are done', () => {
    expect(mayOfferReload({ superseded: false, recording: true, attachmentCount: 3 })).toBe(false);
  });
});

/**
 * The list the owner filed away, which nothing could ask for.
 *
 * `include=archived` is the only mechanism anywhere that lists an archived conversation, and no
 * client ever sent it — so Archive, a control on every row of the sidebar, was a one-way door. The
 * assertion is on the request rather than on a click, because this package renders without a DOM:
 * what can go wrong here is the query string, and it is exactly what went wrong for a year.
 */
describe('showing the archived conversations', () => {
  const calls: string[] = [];

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it('asks for them by name, from the top of the list rather than from a cursor', async () => {
    vi.stubGlobal('fetch', (input: string | URL) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ tasks: [], nextCursor: null, hasMore: false }), {
          headers: { 'content-type': 'application/json' }
        })
      );
    });
    // The call the toggle makes. A cursor would be a position in the *active* list, and
    // `TaskPageQuery` refuses a zero-length one outright.
    await api.tasks(null, 'archived');
    expect(calls).toEqual(['/v1/tasks?include=archived']);
  });
});

/**
 * What a packaged shell rings about, and what the owner's settings stop it ringing about.
 *
 * Two of the worst items in the inventory meet in this function. The native path carried two of the
 * five kinds and not `approval_required` — the agent stopped, waiting on a person — so an installed
 * application could never be told the one thing that blocks it. And quiet hours and the per-kind
 * switches were stored and applied only on the Web Push delivery path, which is the one path a
 * packaged shell has no subscription on: the owner set 22:00–07:00, unticked a kind, saved, and the
 * phone rang anyway from a screen that said it would not.
 */
describe('what wakes a packaged shell', () => {
  const approval = (id: string): NativeNotice => ({
    id,
    kind: 'approvalRequired',
    title: 'Quarterly board deck',
    body: 'Your confirmation is required. Runs a command on your computer.'
  });

  const night = new Date('2026-01-15T23:30:00Z');
  const settings = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({
    kinds: {
      approvalRequired: true,
      taskFinished: true,
      spendPaused: true,
      agentMessage: true,
      takeoverNeeded: true
    },
    supported: [
      'approvalRequired',
      'taskFinished',
      'spendPaused',
      'agentMessage',
      'takeoverNeeded'
    ],
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursAllowApprovals: true,
    timeZone: 'Europe/London',
    ...patch
  });

  it('raises a newly-seen approval exactly once, and nothing at all on the next poll', () => {
    const seen = new Set<string>(['already-answered']);
    const candidates = [approval('waiting'), approval('already-answered')];
    expect(nativeNoticesToRaise({ candidates, seen, settings: null })).toEqual([
      approval('waiting')
    ]);
    // The same list again is what the next poll three seconds later hands it.
    expect(nativeNoticesToRaise({ candidates, seen, settings: null })).toEqual([]);
  });

  it('stays quiet about a kind the owner unticked', () => {
    const off = settings({ kinds: { ...settings().kinds, agentMessage: false } });
    const notice: NativeNotice = {
      id: 'notice-1',
      kind: 'agentMessage',
      title: 'Rent watcher',
      body: 'The listing came back on the market.'
    };
    expect(nativeNoticesToRaise({ candidates: [notice], seen: new Set(), settings: off })).toEqual(
      []
    );
  });

  it('stays quiet inside quiet hours, and lets an approval through when the owner said it may', () => {
    const quiet = settings({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    const finished: NativeNotice = {
      id: 'task-1:completed',
      kind: 'taskFinished',
      title: 'athanor',
      body: 'Quarterly board deck: Work finished.'
    };
    expect(
      nativeNoticesToRaise({ candidates: [finished], seen: new Set(), settings: quiet, at: night })
    ).toEqual([]);
    expect(
      nativeNoticesToRaise({
        candidates: [approval('waiting')],
        seen: new Set(),
        settings: quiet,
        at: night
      })
    ).toEqual([approval('waiting')]);
    expect(
      nativeNoticesToRaise({
        candidates: [approval('waiting')],
        seen: new Set(),
        settings: settings({
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          quietHoursAllowApprovals: false
        }),
        at: night
      })
    ).toEqual([]);
  });

  /*
   * Seen is seen, whether or not it rang. Holding a suppressed notice back to ring the moment the
   * window ends would make this a delivery queue - which the box's own push path already is - and
   * would land the whole night at 07:01.
   */
  it('does not save a suppressed notice up to ring when quiet hours end', () => {
    const seen = new Set<string>();
    const quiet = settings({ quietHoursStart: '22:00', quietHoursEnd: '07:00' });
    nativeNoticesToRaise({ candidates: [approval('waiting')], seen, settings: quiet, at: night });
    expect(
      nativeNoticesToRaise({
        candidates: [approval('waiting')],
        seen,
        settings: quiet,
        at: new Date('2026-01-16T09:00:00Z')
      })
    ).toEqual([]);
  });
});
