import { describe, expect, it } from 'vitest';
import type { DataStore } from '@athanor/data';
import type { PendingRow } from './context.js';
import type { PushPayload } from './payload.js';
import { EndpointHealth } from './retry.js';
import { runSweep, type SweepInput } from './sweep.js';

const now = new Date('2026-07-31T12:00:00.000Z');

const row = (overrides: Partial<PendingRow> = {}): PendingRow =>
  ({
    id: 'subscription-1',
    userId: 'owner',
    endpoint: 'https://push.example/1',
    p256dh: 'p',
    auth: 'a',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    kind: 'task_finished',
    resourceId: 'task-1',
    taskId: 'task-1',
    taskStatus: 'completed',
    eventAt: '2026-07-31T12:00:00.000Z',
    taskTitle: null,
    message: null,
    ...overrides
  }) as PendingRow;

interface Recorded {
  /** Every argument list `listPendingNotifications` was called with, in order. */
  listed: unknown[][];
  settled: Array<[string, string, string]>;
  sessions: Array<{ lastSeenAt: string }>;
}

const harness = (
  pending: PendingRow[],
  parts: Record<string, unknown> = {},
  sessions: Array<{ lastSeenAt: string }> = []
): { store: DataStore; recorded: Recorded } => {
  const recorded: Recorded = { listed: [], settled: [], sessions };
  const store = {
    listPendingNotifications: async (...args: unknown[]) => {
      recorded.listed.push(args);
      return pending;
    },
    recordNotificationDelivery: async (id: string, kind: string, resourceId: string) => {
      recorded.settled.push([id, kind, resourceId]);
    },
    effectiveSpendLimits: async () => ({ timeZone: 'UTC' }),
    notificationSettings: async () => null,
    listSessions: async () => recorded.sessions,
    listApprovals: async () => [],
    getTask: async () => null,
    deletePushSubscriptionById: async () => undefined,
    recordSecurityEvent: async () => undefined,
    ...parts
  } as unknown as DataStore;
  return { store, recorded };
};

const sweep = (
  store: DataStore,
  overrides: Partial<SweepInput> = {}
): { input: SweepInput; sent: PushPayload[] } => {
  const sent: PushPayload[] = [];
  return {
    sent,
    input: {
      store,
      masterKey: undefined,
      endpoints: new EndpointHealth(),
      batchSize: 100,
      deferredLastSweep: 0,
      send: async (_row, payload) => void sent.push(payload),
      now: () => now,
      warn: () => undefined,
      ...overrides
    }
  };
};

describe('runSweep', () => {
  it('hands the data layer the key, which is the whole difference between a named conversation and "Untitled conversation"', async () => {
    // The service read the same /etc/athanor/control.env that carries DATA_MASTER_KEY and never
    // asked for it, so the only production caller of listPendingNotifications passed one argument
    // and every title came back null. This is the assertion that the key gets as far as the query.
    const key = new Uint8Array(32).fill(7);
    const { store, recorded } = harness([row({ taskTitle: 'Reconcile the March invoices' })]);
    const { input, sent } = sweep(store, { masterKey: key });
    await runSweep(input);
    expect(recorded.listed).toEqual([[100, key]]);
    expect(sent[0]?.title).toBe('Reconcile the March invoices');
  });

  it('still sweeps on a box with no key, wording what it can without one', async () => {
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store);
    await runSweep(input);
    expect(recorded.listed).toEqual([[100, undefined]]);
    expect(sent[0]?.title).toBe('Untitled conversation');
  });

  it('delivers, settles and reports one sent notification', async () => {
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(1);
    expect(recorded.settled).toEqual([['subscription-1', 'task_finished', 'task-1']]);
    expect(result).toMatchObject({ pending: 1, delivered: 1, suppressed: 0, held: 0, idle: false });
  });

  it('reports a batch it could only hold as idle, so the caller waits instead of spinning', async () => {
    // A hold writes nothing and is reconsidered next pass, so a sweep that held everything has
    // nothing to show for the four-branch UNION it just ran. Only endpoint waits were counted
    // before, so this loop re-issued that query as fast as PostgreSQL would answer it - for as
    // long as the owner kept a tab open, which on this machine can be days.
    const { store, recorded } = harness(
      [row({ kind: 'agent_message', resourceId: 'notification-1', taskStatus: null })],
      {},
      [{ lastSeenAt: '2026-07-31T11:59:30.000Z' }]
    );
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ pending: 1, held: 1, suppressed: 1, idle: true });
  });

  it('is not idle while one row in a held batch is still deliverable', async () => {
    // The owner is at the keyboard, so their own notice holds; the second row belongs to somebody
    // else in the house who is not, and it must not be made to wait for them.
    const { store } = harness(
      [
        row({ kind: 'agent_message', resourceId: 'notification-1', taskStatus: null }),
        row({ id: 'subscription-2', userId: 'other', resourceId: 'task-2', taskId: 'task-2' })
      ],
      {
        listSessions: async (userId: string) =>
          userId === 'owner' ? [{ lastSeenAt: '2026-07-31T11:59:30.000Z' }] : []
      }
    );
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ pending: 2, held: 1, delivered: 1, idle: false });
  });

  it('waits out an endpoint inside its backoff without attempting it, and widens the next page by it', async () => {
    const endpoints = new EndpointHealth();
    endpoints.failed('subscription-1', 500, now);
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store, { endpoints });
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ pending: 1, deferred: 1, held: 0, idle: true });

    const second = sweep(store, { endpoints, deferredLastSweep: result.deferred });
    await runSweep(second.input);
    expect(recorded.listed[1]).toEqual([101, undefined]);
  });

  it('settles a kind the owner switched off, so the server honours it and never reconsiders it', async () => {
    const { store, recorded } = harness([row()], {
      notificationSettings: async () => ({
        kinds: { task_finished: false },
        quietHours: null,
        quietHoursAllowApprovals: true,
        timeZone: 'UTC'
      })
    });
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([['subscription-1', 'task_finished', 'task-1']]);
    // Not idle: a drop settles its ledger row, so the next query returns fewer rows rather than
    // the same ones. Falling straight through is what drains a backlog quickly.
    expect(result).toMatchObject({ suppressed: 1, held: 0, idle: false });
  });

  it('holds a spend pause the owner is sitting in front of rather than dropping it forever', async () => {
    // The box has stopped and waits for a person to raise the ceiling. Dropping it settles the
    // ledger row, which means that notification is never sent to that device again at all.
    const { store, recorded } = harness([row({ kind: 'spend_paused', taskStatus: 'paused' })], {}, [
      { lastSeenAt: '2026-07-31T11:59:30.000Z' }
    ]);
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ held: 1, idle: true });
  });

  it('keeps a database that will not answer from ending the loop', async () => {
    const { store } = harness([], {
      listPendingNotifications: async () => {
        throw new Error('database unavailable');
      }
    });
    const { input } = sweep(store);
    await expect(runSweep(input)).resolves.toMatchObject({ pending: 0, idle: true });
  });

  it('does not put a device into a wait for a failure that was never the device’s', async () => {
    // Everything before the send is a read of the owner's own rows. A failure there says nothing
    // about the far end, and holding it against the endpoint would back off a working phone.
    const endpoints = new EndpointHealth();
    const { store } = harness([row()], {
      getTask: async () => {
        throw new Error('database unavailable');
      },
      recordNotificationDelivery: async () => {
        throw new Error('database unavailable');
      }
    });
    const { input } = sweep(store, { endpoints });
    const result = await runSweep(input);
    expect(result.failed).toBe(1);
    expect(endpoints.waiting('subscription-1', new Date(now.getTime() + 1))).toBe(false);
  });

  it('forgets a subscription the push service says is gone, and never retries it', async () => {
    const deleted: string[] = [];
    const { store, recorded } = harness([row()], {
      deletePushSubscriptionById: async (id: string) => void deleted.push(id)
    });
    const { input } = sweep(store, {
      send: async () => {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
    });
    const result = await runSweep(input);
    expect(deleted).toEqual(['subscription-1']);
    // Nothing is marked delivered that was not: the row goes away with the subscription.
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ failed: 1, delivered: 0 });
  });
});
