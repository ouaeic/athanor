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
import { encryptJson, renderMemoryPack, type MemoryPackEntry } from '@athanor/core';
import type { DataStore, MemoryPackRecord, TaskRecord } from '@athanor/data';
import type { ModelMessage } from '@athanor/model-gateway';
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
}

const probe = (): CaptureProbe => {
  const uses: CaptureProbe['uses'] = [];
  const warnings: string[] = [];
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
    appendTaskEvent: async (input: { kind: string }) => {
      warnings.push(input.kind);
      return { id: 'event' };
    }
  } as unknown as DataStore;
  return { deps: { store, memoryConsolidatedAt: new Map() }, uses, warnings };
};

const task = {
  id: taskId,
  userId,
  workspaceId,
  status: 'running'
} as unknown as TaskRecord;

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
