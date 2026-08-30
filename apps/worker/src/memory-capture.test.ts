/**
 * The write path a finished turn runs, and the one question it is the only place able to answer.
 *
 * `memory-runtime.test.ts` pins `recordMemoryPackOutcome` itself: given a pack, a request and what
 * the turn produced, which entries come back cited. What it cannot pin is that anything ever hands
 * those three things over - and that is precisely the shape of the defect this wave closed. The
 * column existed, the formula read it, the store's writer took the flag, and no caller passed it.
 * A test that only exercises the callee would have been green through all nine waves of that.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  encryptJson,
  renderMemoryPack,
  type EncryptedEnvelope,
  type MemoryPackEntry
} from '@athanor/core';
import type { ModelRelease } from '@athanor/contracts';
import type { DataStore, MemoryPackRecord, TaskRecord } from '@athanor/data';
import type { ModelGateway, ModelMessage } from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';
import type { CompletionVerification } from './completion.js';
import { captureMemory, type MemoryCaptureDeps } from './memory-capture.js';
import { memoryPackAad } from './memory-runtime.js';

const dataKey = Buffer.alloc(32, 7);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

const RATE_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SEND_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RATE_BODY = 'The renewal rate on the brochure job is 4.25 per cent for the current term.';

const packEntry = (id: string, title: string, body: string): MemoryPackEntry => ({
  id,
  kind: 'fact',
  trust: 'stated',
  observedAt: '2026-07-01T00:00:00.000Z',
  validFrom: '2026-07-01T00:00:00.000Z',
  validTo: null,
  title,
  tags: [],
  body
});

const rendered = renderMemoryPack([
  packEntry(RATE_ID, 'brochure renewal rate', RATE_BODY),
  packEntry(
    SEND_ID,
    'the last brochure send',
    'The last brochure send was held back until every font came back embedded.'
  )
]);

interface CaptureProbe {
  readonly deps: MemoryCaptureDeps;
  readonly uses: Array<{ itemIds: readonly string[]; cited?: boolean; outcome?: string }>;
  readonly warnings: string[];
  /** Every timeline line this write path emitted, sealed exactly as the store would hold it. */
  readonly events: Array<{ kind: string; payloadCiphertext: EncryptedEnvelope }>;
}

const probe = (): CaptureProbe => {
  const uses: CaptureProbe['uses'] = [];
  const warnings: string[] = [];
  const events: CaptureProbe['events'] = [];
  const pack: MemoryPackRecord = {
    taskId,
    workspaceId,
    briefVersion: null,
    bodyCiphertext: encryptJson({ body: rendered.body }, dataKey, memoryPackAad(taskId)),
    sha256: rendered.sha256,
    itemIds: [...rendered.itemIds],
    tokensEst: rendered.tokensEst,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
  const store = {
    createMemoryItem: async (input: { id?: string }) => ({ id: input.id ?? 'item' }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => 0,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    recordMemoryDeadEnds: async () => ({ recorded: [], retired: [] }),
    getMemoryPack: async () => pack,
    recordMemoryUse: async (input: {
      itemIds: readonly string[];
      cited?: boolean;
      outcome?: string;
    }) => {
      uses.push(input);
      return input.itemIds.length;
    },
    consolidateMemory: async () => undefined,
    // The failure channel, and the reason every case below asserts on it. A memory write must
    // never fail a verified turn, so `captureMemory` catches everything and reports it as a
    // timeline warning - which means a test that only checks "it did not throw" checks nothing at
    // all, and would have passed with the whole write path broken.
    appendTaskEvent: async (input: { kind: string; payloadCiphertext: EncryptedEnvelope }) => {
      warnings.push(input.kind);
      events.push(input);
      return { id: 'event' };
    }
  } as unknown as DataStore;
  return { deps: { store, memoryConsolidatedAt: new Map() }, uses, warnings, events };
};

/** What the owner would read on the timeline, out of the sealed payload the store holds. */
const summaries = (capture: CaptureProbe, kind: string): string[] =>
  capture.events
    .filter((entry) => entry.kind === kind)
    .map(
      (entry) =>
        decryptJson<{ summary: string }>(entry.payloadCiphertext, dataKey, `task-event:${taskId}`)
          .summary
    );

const task = {
  id: taskId,
  userId,
  workspaceId,
  status: 'running',
  // The proposer resolves the task's own model before it claims the day, so a task with none would
  // stop one step earlier than these cases are about.
  modelId: 'vendor/model',
  privacyRoute: 'provider_zdr'
} as unknown as TaskRecord;

/** Enough of a release for `compactionModel` to have something to fall back to. */
const catalogue = [
  {
    id: 'vendor/model',
    provider: 'custom',
    commercialUse: true,
    contextTokens: 128_000,
    capabilities: ['chat'],
    usageClass: 'light',
    privacyRoute: 'provider_zdr'
  }
] as unknown as ModelRelease[];

const state = (messages: ModelMessage[]): AgentState =>
  ({ messages, step: 3, credits: 1 }) as unknown as AgentState;

const conversational = (): CompletionVerification =>
  ({
    status: 'not_applicable',
    evidence: [],
    remainingRisks: []
  }) as unknown as CompletionVerification;

describe('what a finished turn tells the store about the memory it was given', () => {
  it('cites the entry the answer quoted, and grades the rest ungraded', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'What rate are we renewing the brochure job at?' },
        { role: 'assistant', content: RATE_BODY }
      ]),
      {
        summary: 'Answered from what the workspace already remembered.',
        verification: conversational()
      }
    );
    expect(capture.warnings).toEqual([]);
    // The wire. Before this wave both production callers of `recordMemoryUse` left `cited` out, so
    // `mem.item.cited_count` was zero in every workspace that had ever run and a fifth of the
    // salience score was a constant for every row in the pool.
    expect(capture.uses).toEqual([
      { workspaceId, itemIds: [RATE_ID], taskId, cited: true, outcome: 'ok' },
      { workspaceId, itemIds: [SEND_ID], taskId, cited: false, outcome: 'unknown' }
    ]);
  });

  it('counts a procedure the harness followed, which no answer would ever quote', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'Is the brochure ready to send?' },
        { role: 'assistant', content: 'Everything checks out.' }
      ]),
      {
        summary: 'Checked the brochure.',
        verification: conversational(),
        verifiedCommands: [
          {
            label: 'fonts',
            executable: 'echo',
            args: ['The', 'last', 'brochure', 'send', 'was', 'held', 'back'],
            cwd: '/workspace'
          }
        ]
      } as never
    );
    expect(capture.warnings).toEqual([]);
    expect(capture.uses[0]).toMatchObject({ itemIds: [SEND_ID], cited: true });
  });

  /**
   * The cap that ate 57.7% of everything the owner had ever typed, in silence.
   *
   * `recordTurnEpisode` keeps the first eight six-kilobyte chunks of each part and drops the rest.
   * Measured over 3,950 real turns: 197 (5.0%) run past it, and 34.6 MB of 59.9 MB of the owner's
   * own words never reached a source row. The cap is right and is unchanged; what was wrong is
   * that nothing said so, so the owner could search memory for a constraint they had definitely
   * written and be told, truthfully and uselessly, that nothing matched.
   */
  describe('saying what the verbatim cap refused', () => {
    const oversized = 'The brief. '.padEnd(60_000, 'y');

    it('says how much of an oversized turn is searchable in the conversation only', async () => {
      const capture = probe();
      await captureMemory(
        capture.deps,
        task,
        dataKey,
        state([
          { role: 'user', content: oversized },
          { role: 'assistant', content: 'Read it.' }
        ]),
        { summary: 'Read the brief.', verification: conversational() }
      );
      // Never a warning: the turn WAS recorded, and "this turn was not recorded in memory" is the
      // sentence that must stay reserved for when it was not.
      expect(capture.warnings).not.toContain('warning');
      expect(summaries(capture, 'status')).toEqual([
        'Stored the first 8 parts of this turn verbatim; 2 further parts are searchable in the conversation but not in memory'
      ]);
    });

    it('stays quiet on a turn that fitted, which is 95% of them', async () => {
      const capture = probe();
      await captureMemory(
        capture.deps,
        task,
        dataKey,
        state([
          { role: 'user', content: 'What rate are we renewing the brochure job at?' },
          { role: 'assistant', content: RATE_BODY }
        ]),
        { summary: 'Answered.', verification: conversational() }
      );
      expect(summaries(capture, 'status')).toEqual([]);
    });
  });

  it('grades nothing at all on a turn the harness stopped', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'What rate are we renewing the brochure job at?' },
        { role: 'assistant', content: RATE_BODY }
      ]),
      { summary: 'Ran out of steps.', verification: conversational(), interrupted: true }
    );
    expect(capture.warnings).toEqual([]);
    expect(capture.uses).toEqual([]);
  });
});

/*
 * The production call site for the nightly proposer.
 *
 * `proposeMemoryFacts` is pinned against the real schema in `memory-runtime.test.ts`. What only
 * this file can pin is that a finished turn reaches it at all, and - the half that matters more -
 * that a proposer which cannot reach a provider does not turn a recorded turn into a warning
 * saying it was not recorded. That sentence is reserved, and it would be false here: the episode,
 * the sources, the observations and the promotions are all written before this runs.
 */
describe('the one model call a day, from the turn that triggers it', () => {
  const finish = async (capture: CaptureProbe) =>
    captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'Never stop to ask me for permission.' },
        { role: 'assistant', content: 'Understood.' }
      ]),
      { summary: 'Carried on.', verification: conversational() }
    );

  /**
   * Both directions on one fixture: the day's sources are read exactly once when the proposer is
   * wired in, and not at all when it is not. Counting the store read rather than the provider call
   * is deliberate - it is the first thing the run does that only the proposer does, so a route that
   * silently stopped being taken would show here rather than being hidden behind an unreachable
   * provider.
   */
  it('reads the day only when a proposer is wired in, and never otherwise', async () => {
    let read = 0;
    const wire = (capture: CaptureProbe, withProposer: boolean): CaptureProbe => {
      Object.assign(capture.deps.store, {
        claimMemoryProposalRun: async () => ({
          claimed: true,
          previous: '2026-07-30T00:00:00.000Z'
        }),
        countMemoryFactProposals: async () => 0,
        listMemoryProposalSources: async () => {
          read += 1;
          return [];
        }
      });
      return withProposer
        ? {
            ...capture,
            deps: {
              ...capture.deps,
              proposals: {
                store: capture.deps.store,
                assertProviderConfigured: async () => undefined,
                currentCatalog: async () => catalogue,
                withLeaseRenewal: async (_task, operation) => operation(),
                /*
                 * A gateway that opens and a chat that does not.
                 *
                 * `proposeMemoryFacts` resolves the provider in FRONT of the claim, so a stub that
                 * threw here refused the run before it read anything - and this case is about what
                 * it reads. The refusal that belongs to this fixture is on the request itself: the
                 * day is empty, so the call is never made, and a version that made one fails here.
                 */
                gateway: async () => ({
                  provider: 'custom',
                  gateway: {
                    chat: async () => {
                      throw new Error('no case here should reach a provider');
                    }
                  } as unknown as ModelGateway
                })
              }
            }
          }
        : capture;
    };

    const bare = wire(probe(), false);
    await finish(bare);
    expect(read).toBe(0);
    expect(bare.warnings).toEqual([]);

    const wired = wire(probe(), true);
    await finish(wired);
    expect(read).toBe(1);
    // Quiet, because nothing was refused. The nightly line is written only when a bound fired.
    expect(wired.warnings).toEqual([]);
  });

  it('never says a recorded turn was not recorded, when only the proposer failed', async () => {
    const capture = probe();
    const wired: CaptureProbe = {
      ...capture,
      deps: {
        ...capture.deps,
        proposals: {
          store: capture.deps.store,
          assertProviderConfigured: async () => {
            throw new Error('no provider is configured');
          },
          currentCatalog: async () => catalogue,
          withLeaseRenewal: async (_task, operation) => operation(),
          gateway: async () => {
            throw new Error('unreachable');
          }
        }
      }
    };
    Object.assign(wired.deps.store, {
      claimMemoryProposalRun: async () => {
        throw new Error('the database went away');
      }
    });
    await finish(wired);
    expect(wired.warnings).not.toContain('warning');
    expect(summaries(wired, 'status')).toEqual([
      'Could not look over the day for rules worth remembering; everything this turn did is still recorded'
    ]);
  });
});
