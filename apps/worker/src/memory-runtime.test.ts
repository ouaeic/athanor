import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMemoryItemIndex,
  decryptJson,
  renderMemoryPack,
  encryptJson,
  memoryIndexKey,
  memoryObjectKey,
  memorySubjectKey,
  MEMORY_RECALL_BUDGET_TOKENS,
  MEMORY_RECALL_ITEM_CEILING,
  MEMORY_RECALL_MAX_ITEMS,
  type EncryptedEnvelope,
  type MemoryKind
} from '@athanor/core';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@athanor/data';
import type {
  CreateMemoryItemInput,
  MemoryCandidateRecord,
  MemoryFactCandidateRecord,
  MemoryItemRecord,
  MemoryPackRecord,
  MemorySourceRecord,
  RecallMemoryInput
} from '@athanor/data';
import type { ModelMessage } from '@athanor/model-gateway';
import {
  buildTaskMemoryPack,
  chunkMemoryBody,
  episodeContent,
  episodeTitle,
  extractTurn,
  finishedAnswerText,
  injectMemoryPack,
  memoryItemAad,
  memoryPackBudgetTokens,
  memoryPackAad,
  memoryPackEntries,
  memoryPackMessage,
  memorySourceAad,
  recallMemory,
  searchMemorySessions,
  MEMORY_PACK_MARKER,
  MEMORY_SESSION_SEARCH_CONTEXT_HITS,
  MEMORY_SESSION_SEARCH_MAX_RESULTS,
  observedMemoryFacts,
  recordMemoryPackOutcome,
  recordTurnEpisode,
  shouldConsolidateMemory,
  type MemoryCaptureStore,
  type MemoryPackStore,
  type MemoryRecallStore
} from './memory-runtime.js';

const dataKey = Buffer.alloc(32, 7);
const indexKey = memoryIndexKey(dataKey);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

const candidate = (
  id: string,
  kind: MemoryKind,
  document: { title?: string; body: string },
  overrides: Partial<MemoryCandidateRecord> = {}
): MemoryCandidateRecord => ({
  id,
  layer: kind === 'source' ? 'source' : 'item',
  kind,
  trust: 'stated',
  status: 'active',
  observedAt: '2026-07-01T00:00:00.000Z',
  validFrom: '2026-07-01T00:00:00.000Z',
  validTo: null,
  subjectKey: null,
  predicate: null,
  tokensEst: 20,
  score: 1,
  documentCiphertext: encryptJson(
    document,
    dataKey,
    kind === 'source' ? memorySourceAad(workspaceId) : memoryItemAad(workspaceId)
  ),
  ...overrides
});

interface PackStoreProbe {
  readonly store: MemoryPackStore;
  readonly recallCalls: RecallMemoryInput[];
  readonly saved: MemoryPackRecord[];
}

const packStore = (candidates: () => MemoryCandidateRecord[]): PackStoreProbe => {
  const recallCalls: RecallMemoryInput[] = [];
  const saved: MemoryPackRecord[] = [];
  const packs = new Map<string, MemoryPackRecord>();
  const store: MemoryPackStore = {
    getMemoryPack: async (id) => packs.get(id) ?? null,
    saveMemoryPack: async (input) => {
      const existing = packs.get(input.taskId);
      if (existing) return existing;
      const record: MemoryPackRecord = {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        briefVersion: input.briefVersion ?? null,
        bodyCiphertext: input.bodyCiphertext,
        sha256: input.sha256,
        itemIds: [...input.itemIds],
        tokensEst: input.tokensEst,
        createdAt: '2026-07-31T00:00:00.000Z'
      };
      packs.set(input.taskId, record);
      saved.push(record);
      return record;
    },
    recallMemoryCandidates: async (input) => {
      recallCalls.push(input);
      return candidates();
    }
  };
  return { store, recallCalls, saved };
};

interface CaptureProbe {
  readonly store: MemoryCaptureStore;
  readonly items: CreateMemoryItemInput[];
  readonly sources: Parameters<DataStore['createMemorySource']>[0][];
  readonly evidence: { itemId: string; sourceIds: string[] }[];
  readonly observations: Parameters<DataStore['observeMemoryFactCandidate']>[0][];
  readonly uses: Parameters<DataStore['recordMemoryUse']>[0][];
  /** Candidates the store offers for promotion, and what the callback made of each. */
  promotable: MemoryFactCandidateRecord[];
  readonly promotions: Array<{ candidate: MemoryFactCandidateRecord; prepared: unknown }>;
  pack: MemoryPackRecord | null;
}

const captureStore = (): CaptureProbe => {
  const probe: CaptureProbe = {
    items: [],
    sources: [],
    evidence: [],
    observations: [],
    uses: [],
    promotable: [],
    promotions: [],
    pack: null,
    store: {
      createMemoryItem: async (input) => {
        probe.items.push(input);
        const now = '2026-07-31T00:00:00.000Z';
        const record: MemoryItemRecord = {
          id: input.id ?? 'generated',
          userId: input.userId,
          workspaceId: input.workspaceId,
          kind: input.kind,
          status: input.status ?? 'active',
          trust: input.trust,
          documentCiphertext: input.documentCiphertext,
          observedAt: now,
          retiredAt: null,
          validFrom: now,
          validTo: null,
          subjectKey: input.index.subjectKey,
          predicate: input.predicate ?? null,
          predFunctional: false,
          objectKey: input.index.objectKey,
          episodeId: input.episodeId ?? null,
          taskId: input.taskId ?? null,
          lastVerified: null,
          okCount: 0,
          failCount: 0,
          pin: false,
          useCount: 0,
          citedCount: 0,
          negCount: 0,
          lastUsedAt: null,
          salience: 0,
          tokensEst: input.index.tokensEst,
          indexed: input.index.indexed,
          createdAt: now,
          updatedAt: now
        };
        return record;
      },
      createMemorySource: async (input) => {
        probe.sources.push(input);
        const record: MemorySourceRecord = {
          id: `source-${probe.sources.length}`,
          userId: input.userId,
          workspaceId: input.workspaceId,
          occurredAt: '2026-07-31T00:00:00.000Z',
          channel: input.channel,
          role: input.role ?? null,
          taskId: input.taskId ?? null,
          episodeId: input.episodeId ?? null,
          originCiphertext: input.originCiphertext ?? null,
          originKey: input.originKey ?? null,
          bodyCiphertext: input.bodyCiphertext,
          chunkIndex: input.chunkIndex ?? 0,
          chunkOf: input.chunkOf ?? null,
          tokensEst: input.tokensEst,
          indexed: input.indexed ?? true,
          createdAt: '2026-07-31T00:00:00.000Z'
        };
        return record;
      },
      attachMemoryEvidence: async (itemId, sources) => {
        probe.evidence.push({ itemId, sourceIds: sources.map((entry) => entry.sourceId) });
        return sources.length;
      },
      // Promotion is what makes the memory automatic: the double runs the callback over whatever
      // the probe is holding, so a test can assert both that it is reached and what it produces.
      promoteMemoryFactCandidates: async (_workspaceId, prepare) => {
        const promoted: Awaited<ReturnType<DataStore['promoteMemoryFactCandidates']>> = [];
        for (const candidate of probe.promotable) {
          const prepared = await prepare(candidate);
          if (!prepared) continue;
          probe.promotions.push({ candidate, prepared });
          promoted.push({
            candidate,
            item: { id: `fact-${probe.promotions.length}` } as never,
            supersededIds: []
          });
        }
        return promoted;
      },
      observeMemoryFactCandidate: async (input) => {
        probe.observations.push(input);
        const record: MemoryFactCandidateRecord = {
          workspaceId: input.workspaceId,
          subjectKey: input.subjectKey,
          predicate: input.predicate,
          objectKey: input.objectKey,
          episodeCount: 1,
          firstSeen: '2026-07-31T00:00:00.000Z',
          lastSeen: '2026-07-31T00:00:00.000Z',
          episodeIds: [input.episodeId],
          draftCiphertext: input.draftCiphertext ?? null
        };
        return record;
      },
      getMemoryPack: async () => probe.pack,
      recordMemoryUse: async (input) => {
        probe.uses.push(input);
        return input.itemIds.length;
      }
    }
  };
  return probe;
};

describe('memory pack read path', () => {
  it('renders, seals and persists a pack from the recall candidates', async () => {
    const probe = packStore(() => [
      candidate('bbbbbbbb-0000-4000-8000-000000000002', 'episode', {
        title: 'Rotated the certificate',
        body: 'Renewed the TLS certificate and reloaded nginx.'
      }),
      candidate('aaaaaaaa-0000-4000-8000-000000000001', 'fact', {
        title: 'default shell',
        body: 'The owner uses fish.'
      })
    ]);

    const pack = await buildTaskMemoryPack({
      store: probe.store,
      taskId,
      workspaceId,
      dataKey,
      query: 'restart nginx after rotating the certificate',
      clockAnchor: new Date('2026-07-31T08:00:00.000Z')
    });

    expect(pack.reused).toBe(false);
    // Deterministic (kind, id) order, not score order: facts render before episodes.
    expect(pack.body.indexOf('## Facts')).toBeLessThan(pack.body.indexOf('## Episodes'));
    expect(pack.body).toContain('The owner uses fish.');
    expect(pack.itemIds).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002'
    ]);
    expect(probe.recallCalls[0]?.now).toEqual(new Date('2026-07-31T08:00:00.000Z'));
    const stored = probe.saved[0];
    expect(stored?.bodyCiphertext.aad).toBe(`memory-pack:${taskId}`);
    expect(decryptJson<{ body: string }>(stored!.bodyCiphertext, dataKey).body).toBe(pack.body);
  });

  it('re-emits the stored bytes on resume instead of re-ranking against a newer clock', async () => {
    let live = [
      candidate('aaaaaaaa-0000-4000-8000-000000000001', 'fact', { body: 'The owner uses fish.' })
    ];
    const probe = packStore(() => live);
    const first = await buildTaskMemoryPack({
      store: probe.store,
      taskId,
      workspaceId,
      dataKey,
      query: 'which shell',
      clockAnchor: new Date('2026-07-31T08:00:00.000Z')
    });

    // The store moves on mid-task: a newer, higher-ranked memory arrives.
    live = [
      ...live,
      candidate('cccccccc-0000-4000-8000-000000000003', 'fact', { body: 'The owner uses zsh now.' })
    ];
    const resumed = await buildTaskMemoryPack({
      store: probe.store,
      taskId,
      workspaceId,
      dataKey,
      query: 'which shell',
      clockAnchor: new Date('2026-08-04T08:00:00.000Z')
    });

    expect(resumed.reused).toBe(true);
    expect(resumed.body).toBe(first.body);
    expect(resumed.sha256).toBe(first.sha256);
    // Byte-stability is only worth anything if the second run never pays for the ranking either.
    expect(probe.recallCalls).toHaveLength(1);
  });

  it('keeps the bytes another worker wrote first', async () => {
    const probe = packStore(() => [
      candidate('aaaaaaaa-0000-4000-8000-000000000001', 'fact', { body: 'The owner uses fish.' })
    ]);
    await buildTaskMemoryPack({
      store: probe.store,
      taskId,
      workspaceId,
      dataKey,
      query: 'which shell',
      clockAnchor: new Date('2026-07-31T08:00:00.000Z')
    });
    const winner = probe.saved[0]!;

    // A second worker that already ranked a different set still sends what is cached.
    const raced = packStore(() => [
      candidate('dddddddd-0000-4000-8000-000000000004', 'fact', { body: 'Something else.' })
    ]);
    const racedStore: MemoryPackStore = {
      ...raced.store,
      getMemoryPack: async () => null,
      saveMemoryPack: async () => winner
    };
    const pack = await buildTaskMemoryPack({
      store: racedStore,
      taskId,
      workspaceId,
      dataKey,
      query: 'which shell',
      clockAnchor: new Date('2026-07-31T09:00:00.000Z')
    });
    expect(pack.body).toContain('The owner uses fish.');
    expect(pack.reused).toBe(true);
  });

  it('drops a row sealed for another tier or another key rather than trusting it', () => {
    const foreign = candidate(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'fact',
      { body: 'x' },
      {
        documentCiphertext: encryptJson({ body: 'x' }, dataKey, 'workspace-memory:elsewhere')
      }
    );
    const unreadable = candidate(
      'bbbbbbbb-0000-4000-8000-000000000002',
      'fact',
      { body: 'y' },
      {
        documentCiphertext: encryptJson(
          { body: 'y' },
          Buffer.alloc(32, 9),
          memoryItemAad(workspaceId)
        )
      }
    );
    const good = candidate('cccccccc-0000-4000-8000-000000000003', 'fact', { body: 'z' });
    expect(memoryPackEntries([foreign, unreadable, good], workspaceId, dataKey)).toEqual([
      expect.objectContaining({ id: 'cccccccc-0000-4000-8000-000000000003', body: 'z' })
    ]);
  });

  it('renders a source row with its verbatim body', () => {
    const entries = memoryPackEntries(
      [
        candidate('eeeeeeee-0000-4000-8000-000000000005', 'source', { body: '$ systemctl restart' })
      ],
      workspaceId,
      dataKey
    );
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'source', body: '$ systemctl restart' })
    ]);
  });

  it('budgets the pack against the smaller of 6000 tokens and a share of the window', () => {
    expect(memoryPackBudgetTokens(1_000_000)).toBe(6_000);
    expect(memoryPackBudgetTokens(32_000)).toBe(3_840);
    expect(memoryPackBudgetTokens(1_000)).toBeGreaterThan(0);
  });
});

interface RecallProbe {
  readonly store: MemoryRecallStore;
  readonly calls: RecallMemoryInput[];
  readonly uses: Parameters<DataStore['recordMemoryUse']>[0][];
  pack: MemoryPackRecord | null;
}

const recallStore = (candidates: () => MemoryCandidateRecord[]): RecallProbe => {
  const probe: RecallProbe = {
    calls: [],
    uses: [],
    pack: null,
    store: {
      getMemoryPack: async () => probe.pack,
      recallMemoryCandidates: async (input) => {
        probe.calls.push(input);
        return candidates();
      },
      recordMemoryUse: async (input) => {
        probe.uses.push(input);
        return input.itemIds.length;
      }
    }
  };
  return probe;
};

const packRecord = (itemIds: string[]): MemoryPackRecord => ({
  taskId,
  workspaceId,
  briefVersion: null,
  bodyCiphertext: encryptJson({ body: '# MEMORY PACK\n' }, dataKey, `memory-pack:${taskId}`),
  sha256: 'sha',
  itemIds,
  tokensEst: 10,
  createdAt: '2026-07-31T00:00:00.000Z'
});

describe('agent-initiated recall', () => {
  const answer = candidate('cccccccc-0000-4000-8000-000000000003', 'fact', {
    title: 'wal archive',
    body: 'The write ahead log is archived to /srv/athanor/var/wal.'
  });

  it('asks the store what the frozen pack did not already answer', async () => {
    const probe = recallStore(() => [answer]);
    probe.pack = packRecord(['aaaaaaaa-0000-4000-8000-000000000001']);

    const result = await recallMemory({
      store: probe.store,
      workspaceId,
      dataKey,
      taskId,
      query: 'where does the write ahead log get archived',
      now: new Date('2026-07-31T09:00:00.000Z')
    });

    expect(result.entries).toMatchObject([{ id: answer.id, title: 'wal archive' }]);
    // Told rather than hidden: an empty result then means "nothing else", which the agent cannot
    // tell from "nothing at all" without it, and would answer by asking again for no reason.
    expect(result.alreadyInContext).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
    expect(result.tokensEst).toBeGreaterThan(0);

    const [call] = probe.calls;
    expect(call?.excludeIds).toEqual(['aaaaaaaa-0000-4000-8000-000000000001']);
    // Relevance, not (kind, id): nothing caches a recall, and the agent reads from the top.
    expect(call?.order).toBe('relevance');
    // Ranked against the clock now, unlike the pack, which is anchored to the task's start.
    expect(call?.now).toEqual(new Date('2026-07-31T09:00:00.000Z'));
  });

  it('records the retrieval as a use without grading it a success', async () => {
    const probe = recallStore(() => [
      answer,
      candidate('dddddddd-0000-4000-8000-000000000004', 'source', { body: '$ ls /srv/athanor' })
    ]);
    await recallMemory({ store: probe.store, workspaceId, dataKey, taskId, query: 'wal archive' });
    // Only the curated overlay has salience counters, and whether the row helped is settled when
    // the turn is verified - claiming it here would grade every recall a success as it was made.
    expect(probe.uses).toEqual([{ workspaceId, itemIds: [answer.id], taskId }]);
    expect(probe.uses[0]).not.toHaveProperty('outcome');
  });

  it('spends a fixed budget and holds the item count inside the bound the schema states', async () => {
    // The budget is not negotiable and no longer pretends to be. It used to be a `budgetTokens`
    // input clamped between 256 and a 4,000 ceiling in `packages/core`, and the tool schema is
    // `additionalProperties: false` and never declared the field - so the clamp's own test was the
    // only caller that had ever reached it, and every recall the product has answered was answered
    // at MEMORY_RECALL_BUDGET_TOKENS. Both the input and the ceiling are gone (ATH-164); what the
    // model does control is `maxItems`, and these are the bounds the schema now interpolates from
    // the same constants this asserts against.
    const probe = recallStore(() => []);
    await recallMemory({
      store: probe.store,
      workspaceId,
      dataKey,
      taskId,
      query: 'anything',
      maxItems: 4_000
    });
    expect(probe.calls[0]?.budgetTokens).toBe(MEMORY_RECALL_BUDGET_TOKENS);
    expect(probe.calls[0]?.maxItems).toBe(MEMORY_RECALL_ITEM_CEILING);

    await recallMemory({
      store: probe.store,
      workspaceId,
      dataKey,
      taskId,
      query: 'anything',
      maxItems: -3
    });
    expect(probe.calls[1]?.budgetTokens).toBe(MEMORY_RECALL_BUDGET_TOKENS);
    expect(probe.calls[1]?.maxItems).toBe(1);

    // Omitted entirely, the model gets the number the schema advertises as its default.
    await recallMemory({ store: probe.store, workspaceId, dataKey, taskId, query: 'anything' });
    expect(probe.calls[2]?.maxItems).toBe(MEMORY_RECALL_MAX_ITEMS);
  });

  it('refuses a question it cannot ask rather than asking a different one', async () => {
    const probe = recallStore(() => []);
    const ask = (extra: Record<string, unknown>) =>
      recallMemory({
        store: probe.store,
        workspaceId,
        dataKey,
        taskId,
        query: 'what shell do I use',
        ...extra
      });
    await expect(ask({ asOf: 'last tuesday' })).rejects.toThrow('date');
    await expect(ask({ kinds: ['invention'] })).rejects.toThrow('kinds');
    await expect(
      recallMemory({ store: probe.store, workspaceId, dataKey, taskId, query: '   ' })
    ).rejects.toThrow('ask');
    expect(probe.calls).toEqual([]);
  });

  it('passes the bitemporal window through, which is what makes "before" answerable', async () => {
    const probe = recallStore(() => []);
    await recallMemory({
      store: probe.store,
      workspaceId,
      dataKey,
      taskId,
      query: 'which shell did I use before',
      kinds: ['fact', 'fact'],
      scope: 'archive',
      asOf: '2026-01-01T00:00:00.000Z',
      includeSuperseded: true
    });
    expect(probe.calls[0]).toMatchObject({
      kinds: ['fact'],
      scope: 'archive',
      asOf: '2026-01-01T00:00:00.000Z',
      includeSuperseded: true
    });
  });

  it('skips a row sealed for a different tier instead of failing the call', async () => {
    const foreign = {
      ...candidate('eeeeeeee-0000-4000-8000-000000000005', 'fact', { body: 'Elsewhere.' }),
      documentCiphertext: encryptJson({ body: 'Elsewhere.' }, dataKey, 'memory-item:other')
    };
    const probe = recallStore(() => [foreign, answer]);
    const result = await recallMemory({
      store: probe.store,
      workspaceId,
      dataKey,
      taskId,
      query: 'wal'
    });
    expect(result.entries.map((entry) => entry.id)).toEqual([answer.id]);
  });
});

describe('memory pack injection', () => {
  const preamble = (): ModelMessage[] => [
    { role: 'system', content: 'You operate a persistent computer' },
    { role: 'system', content: 'ATHANOR RUNTIME CONTEXT' },
    { role: 'system', content: 'CURATED ENCRYPTED KNOWLEDGE (user-visible)' },
    { role: 'user', content: 'restart the service' },
    { role: 'assistant', content: 'working' }
  ];

  it('lands at the end of the system preamble, ahead of the goal', () => {
    const messages = preamble();
    expect(injectMemoryPack(messages, { body: '# MEMORY PACK\n', itemIds: ['a'] })).toBe(3);
    expect(messages[3]?.content.startsWith(MEMORY_PACK_MARKER)).toBe(true);
    expect(messages[4]).toEqual({ role: 'user', content: 'restart the service' });
    // The reviewed knowledge block is untouched: the pack sits beside it, not in place of it.
    expect(messages[2]?.content.startsWith('CURATED ENCRYPTED KNOWLEDGE')).toBe(true);
  });

  it('replaces the previous pack on resume instead of stacking a second one', () => {
    const messages = preamble();
    injectMemoryPack(messages, { body: '# MEMORY PACK\nfirst\n', itemIds: ['a'] });
    injectMemoryPack(messages, { body: '# MEMORY PACK\nsecond\n', itemIds: ['a'] });
    const packs = messages.filter((message) => message.content.startsWith(MEMORY_PACK_MARKER));
    expect(packs).toHaveLength(1);
    expect(packs[0]?.content).toContain('second');
  });

  it('injects nothing when recall found nothing, and clears a stale block', () => {
    const messages = preamble();
    injectMemoryPack(messages, { body: '# MEMORY PACK\n', itemIds: ['a'] });
    expect(injectMemoryPack(messages, { body: '# MEMORY PACK\n', itemIds: [] })).toBe(-1);
    expect(messages.some((message) => message.content.startsWith(MEMORY_PACK_MARKER))).toBe(false);
    expect(injectMemoryPack(messages, null)).toBe(-1);
    expect(messages).toHaveLength(5);
  });

  it('carries no clock, counter or request id that would rewrite the cached prefix', () => {
    const message = memoryPackMessage('# MEMORY PACK\n');
    expect(memoryPackMessage('# MEMORY PACK\n').content).toBe(message.content);
    expect(message.content).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    expect(message.role).toBe('system');
  });
});

describe('turn extraction', () => {
  it('reads only the newest turn and keeps the commands it ran', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'preamble' },
      { role: 'user', content: 'first request' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '1', name: 'shell', arguments: { executable: 'ls', args: ['/etc'] } }]
      },
      { role: 'user', content: 'now restart nginx' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: '2',
            name: 'shell',
            arguments: { executable: 'systemctl', args: ['restart', 'nginx'] }
          },
          { id: '3', name: 'file_read', arguments: { path: 'workspace/nginx.conf' } },
          { id: '4', name: 'set_plan', arguments: { steps: ['a'] } }
        ]
      }
    ];
    expect(extractTurn(messages)).toEqual({
      request: 'now restart nginx',
      artifacts: ['systemctl restart nginx', 'file_read workspace/nginx.conf']
    });
  });

  it('survives a turn with no user message at all', () => {
    expect(extractTurn([{ role: 'system', content: 'preamble' }])).toEqual({
      request: '',
      artifacts: []
    });
  });
});

describe('episode content', () => {
  it('summarises deterministically, with no model call', () => {
    const content = episodeContent({
      request: 'Rotate the TLS certificate\nand reload nginx',
      summary: 'Issued a new certificate and reloaded nginx.',
      outcome: 'ok',
      verifiedClaims: ['nginx -t reported syntax ok'],
      remainingRisks: ['renewal timer untested'],
      artifacts: ['systemctl reload nginx', 'systemctl reload nginx']
    });
    expect(content.title).toBe('Rotate the TLS certificate');
    expect(content.body).toContain('Goal: Rotate the TLS certificate and reload nginx');
    expect(content.body).toContain('Outcome: ok');
    expect(content.body).toContain('Verified: nginx -t reported syntax ok');
    expect(content.body).toContain('Remaining risks: renewal timer untested');
    // Repeated commands collapse rather than filling the episode with the same line.
    expect(content.body.match(/- systemctl reload nginx/gu)).toHaveLength(1);
    expect(content).toEqual(
      episodeContent({
        request: 'Rotate the TLS certificate\nand reload nginx',
        summary: 'Issued a new certificate and reloaded nginx.',
        outcome: 'ok',
        verifiedClaims: ['nginx -t reported syntax ok'],
        remainingRisks: ['renewal timer untested'],
        artifacts: ['systemctl reload nginx', 'systemctl reload nginx']
      })
    );
  });

  it('tags with identifiers rather than prose, which is what a later probe matches', () => {
    const content = episodeContent({
      request: 'Deploy the app with systemctl restart athanor.target',
      summary: 'Deployed.',
      outcome: 'ok'
    });
    expect(content.tags).toContain('athanor.target');
    expect(content.tags).not.toContain('deploy');
  });

  it('falls back to a title when the request has no usable first line', () => {
    expect(episodeTitle('   \n\n')).toBe('Untitled turn');
  });
});

describe('verbatim chunking', () => {
  it('splits on line boundaries under the row cap', () => {
    const body = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n');
    expect(chunkMemoryBody(body, 90)).toEqual([
      'a'.repeat(40) + '\n' + 'b'.repeat(40),
      'c'.repeat(40)
    ]);
  });

  it('cuts a single over-long line rather than dropping the row', () => {
    const chunks = chunkMemoryBody('x'.repeat(250), 100);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
    expect(chunks.join('')).toBe('x'.repeat(250));
  });

  it('never emits a chunk over the byte cap, including multi-byte text', () => {
    // 400 two-byte characters at a 100-byte cap is several chunks. A chunker that returned nothing
    // would satisfy the loop below without having capped anything, which is the failure that
    // matters here: the cap exists because a chunk over it is rejected by the store.
    const chunks = chunkMemoryBody('é'.repeat(400), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('produces nothing for empty input', () => {
    expect(chunkMemoryBody('   \n  ')).toEqual([]);
  });
});

describe('owner fact observations', () => {
  it('recognises owner-stated shapes against the vetted predicate registry', () => {
    expect(observedMemoryFacts('By the way I use fish as my shell, and I live in Lisbon.')).toEqual(
      [
        { subject: 'owner', predicate: 'default_shell', object: 'fish' },
        { subject: 'owner', predicate: 'lives_in', object: 'Lisbon' }
      ]
    );
  });

  it('reads a service fact with its own subject', () => {
    expect(observedMemoryFacts('the preview gateway listens on 8443')).toEqual([
      { subject: 'preview gateway', predicate: 'runs_on', object: '8443' }
    ]);
  });

  it('finds nothing in an ordinary request', () => {
    expect(observedMemoryFacts('please restart nginx and check the logs')).toEqual([]);
  });

  it('is bounded, so one long message cannot flood the review queue', () => {
    const text = Array.from({ length: 20 }, (_, i) => `I prefer option ${i}`).join('. ');
    expect(observedMemoryFacts(text)).toHaveLength(5);
  });

  it('does not carry a stale regex cursor between calls', () => {
    const text = 'I live in Porto';
    expect(observedMemoryFacts(text)).toEqual(observedMemoryFacts(text));
  });

  it('says the same thing twice once, and two different things twice', () => {
    // The de-duplication key joins subject, predicate and object on a byte none of them can hold.
    // It used to be a literal NUL in the source, which made the whole module arrive as binary -
    // grep skipped it and git refused to diff it - so it is an escape now, and this is what proves
    // the separator is still a separator rather than something a subject could contain.
    expect(observedMemoryFacts('my shell is fish, and my shell is fish')).toEqual([
      { subject: 'owner', predicate: 'default_shell', object: 'fish' }
    ]);
    expect(observedMemoryFacts('my shell is fish. the preview gateway listens on 8443')).toEqual([
      { subject: 'owner', predicate: 'default_shell', object: 'fish' },
      { subject: 'preview gateway', predicate: 'runs_on', object: '8443' }
    ]);
  });
});

describe('turn capture write path', () => {
  const capture = async (probe: CaptureProbe, request: string) =>
    recordTurnEpisode({
      store: probe.store,
      userId,
      workspaceId,
      taskId,
      dataKey,
      request,
      summary: 'Restarted nginx and confirmed it is serving.',
      outcome: 'ok',
      verifiedClaims: ['curl returned 200'],
      remainingRisks: [],
      artifacts: ['systemctl restart nginx'],
      occurredAt: new Date('2026-07-31T09:00:00.000Z')
    });

  it('keeps a secret out of memory, which is the one sink that is kept and re-read', async () => {
    // redaction.ts calls itself "the last thing between a secret and somewhere it can be read", and
    // it guarded every log line, security event and cross-process error - but not this path, which
    // is the only one that stores text deliberately, keeps it, indexes it and reads it back into a
    // later prompt. A key pasted into a request landed verbatim in mem.source and in its index.
    const probe = captureStore();
    const result = await recordTurnEpisode({
      store: probe.store,
      userId,
      workspaceId,
      taskId,
      dataKey,
      request: 'deploy with sk-live-4f9ab21c77de40aabc31 and tell me if it worked',
      summary: 'Deployed successfully.',
      outcome: 'ok',
      verifiedClaims: ['called https://deploy:hunter2@example.com/api and got 200'],
      remainingRisks: [],
      // artifacts reconstruct shell command lines, which is exactly where an inline token shows up.
      artifacts: [
        'curl -H "Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" https://api'
      ],
      occurredAt: new Date('2026-07-31T09:00:00.000Z')
    });
    expect(result).not.toBeNull();

    const episodeBody = decryptJson<{ body: string }>(
      probe.items[0]!.documentCiphertext,
      dataKey
    ).body;
    const sourceBodies = probe.sources
      .map((source) => decryptJson<{ body: string }>(source.bodyCiphertext, dataKey).body)
      .join('\n');
    const everything = `${episodeBody}\n${sourceBodies}\n${JSON.stringify(probe.sources)}`;
    for (const secret of [
      'sk-live-4f9ab21c77de40aabc31',
      'hunter2',
      'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    ])
      expect(everything, `${secret} reached durable memory`).not.toContain(secret);
    // The surrounding words survive, so the episode is still worth recalling.
    expect(episodeBody).toContain('deploy');
  });

  it('writes one episode over verbatim sources it cites as evidence', async () => {
    const probe = captureStore();
    const result = await capture(probe, 'restart nginx please');

    expect(result?.sourceIds).toHaveLength(2);
    expect(probe.items).toHaveLength(1);
    const episode = probe.items[0]!;
    expect(episode.kind).toBe('episode');
    expect(episode.trust).toBe('derived');
    expect(episode.documentCiphertext.aad).toBe(`memory-item:${workspaceId}`);
    expect(decryptJson<{ body: string }>(episode.documentCiphertext, dataKey).body).toContain(
      'Goal: restart nginx please'
    );

    expect(probe.sources.map((source) => source.role)).toEqual(['owner', 'agent']);
    for (const source of probe.sources) {
      expect(source.episodeId).toBe(result?.episodeId);
      expect(source.channel).toBe('chat');
      expect(source.bodyCiphertext.aad).toBe(`memory-source:${workspaceId}`);
    }
    expect(decryptJson<{ body: string }>(probe.sources[0]!.bodyCiphertext, dataKey).body).toBe(
      'restart nginx please'
    );
    expect(probe.evidence).toEqual([{ itemId: result?.episodeId, sourceIds: result?.sourceIds }]);
  });

  it('never mints a durable fact, only an observation the owner still has to approve', async () => {
    const probe = captureStore();
    const result = await capture(probe, 'I use fish as my shell. Now restart nginx.');

    // The product invariant: automatic capture writes episodes, never facts.
    expect(probe.items.map((item) => item.kind)).toEqual(['episode']);
    expect(probe.items.every((item) => item.predicate === undefined)).toBe(true);
    expect(result?.factCandidates).toBe(1);
    expect(probe.observations).toEqual([
      {
        workspaceId,
        subjectKey: memorySubjectKey('owner', indexKey),
        predicate: 'default_shell',
        objectKey: memoryObjectKey('fish', indexKey),
        episodeId: result?.episodeId,
        observedAt: new Date('2026-07-31T09:00:00.000Z'),
        draftCiphertext: expect.objectContaining({
          aad: `memory-fact-candidate:${workspaceId}`
        }) as EncryptedEnvelope
      }
    ]);
  });

  it('reads observations out of the owner request only, never the agent account of its own work', async () => {
    const probe = captureStore();
    await recordTurnEpisode({
      store: probe.store,
      userId,
      workspaceId,
      taskId,
      dataKey,
      request: 'set up the shell',
      summary: 'I use fish as my shell now, and I work for Contoso.',
      outcome: 'ok',
      occurredAt: new Date('2026-07-31T09:00:00.000Z')
    });
    expect(probe.observations).toEqual([]);
  });

  it('chunks an oversized request across rows that all point at the first one', async () => {
    const probe = captureStore();
    const result = await capture(probe, 'x'.repeat(14_000));
    const owner = probe.sources.filter((source) => source.role === 'owner');
    expect(owner.length).toBeGreaterThan(1);
    expect(owner.map((source) => source.chunkIndex)).toEqual([0, 1, 2]);
    expect(owner[0]?.chunkOf ?? null).toBeNull();
    expect(owner[1]?.chunkOf).toBe(result?.sourceIds[0]);
  });

  it('skips an empty turn instead of writing a hollow episode', async () => {
    const probe = captureStore();
    await expect(
      recordTurnEpisode({
        store: probe.store,
        userId,
        workspaceId,
        taskId,
        dataKey,
        request: '  ',
        summary: '',
        outcome: 'ok',
        occurredAt: new Date('2026-07-31T09:00:00.000Z')
      })
    ).resolves.toBeNull();
    expect(probe.items).toEqual([]);
  });
});

describe('pack outcome and consolidation cadence', () => {
  it('records the real outcome against exactly the items that were injected', async () => {
    const probe = captureStore();
    probe.pack = {
      taskId,
      workspaceId,
      briefVersion: null,
      bodyCiphertext: encryptJson({ body: '# MEMORY PACK\n' }, dataKey, `memory-pack:${taskId}`),
      sha256: 'abc',
      itemIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
      tokensEst: 10,
      createdAt: '2026-07-31T00:00:00.000Z'
    };
    await expect(
      recordMemoryPackOutcome({ store: probe.store, workspaceId, taskId, outcome: 'ok' })
    ).resolves.toBe(1);
    expect(probe.uses).toEqual([
      {
        workspaceId,
        itemIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
        taskId,
        outcome: 'ok'
      }
    ]);
  });

  /**
   * The producer for the control that read a column nothing wrote.
   *
   * `mem.item.cited_count` is `0.20` of the salience score that decides what survives
   * consolidation; `recordMemoryUse` is its only writer, behind `cited`; and until this wave both
   * production callers left it out, so the column was zero on every box and the term was a
   * constant for every row in the pool. These cases pin the two halves of the repair: which
   * entries a finished turn can be shown to have used, and the grade the rest are left with.
   */
  describe('citing the entries the finished turn used', () => {
    const rateId = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const sendId = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const rendered = renderMemoryPack([
      {
        id: rateId,
        kind: 'fact',
        trust: 'stated',
        observedAt: '2026-07-01T00:00:00.000Z',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: null,
        title: 'brochure renewal rate',
        tags: [],
        body: 'The renewal rate on the brochure job is 4.25 per cent for the current term.'
      },
      {
        id: sendId,
        kind: 'episode',
        trust: 'derived',
        observedAt: '2026-07-01T00:00:00.000Z',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: null,
        title: 'the last brochure send',
        tags: [],
        body: 'The last brochure send was held back until every font came back embedded.'
      }
    ]);
    const packedProbe = (): CaptureProbe => {
      const probe = captureStore();
      probe.pack = {
        taskId,
        workspaceId,
        briefVersion: null,
        bodyCiphertext: encryptJson({ body: rendered.body }, dataKey, memoryPackAad(taskId)),
        sha256: rendered.sha256,
        itemIds: [...rendered.itemIds],
        tokensEst: rendered.tokensEst,
        createdAt: '2026-07-31T00:00:00.000Z'
      };
      return probe;
    };

    it('records the used entry as cited and leaves the untouched one ungraded', async () => {
      const probe = packedProbe();
      await expect(
        recordMemoryPackOutcome({
          store: probe.store,
          workspaceId,
          taskId,
          outcome: 'ok',
          dataKey,
          used: ['The renewal rate on the brochure job is 4.25 per cent for the current term.'],
          request: 'What rate are we renewing the brochure job at?'
        })
      ).resolves.toBe(2);
      expect(probe.uses).toEqual([
        { workspaceId, itemIds: [rateId], taskId, cited: true, outcome: 'ok' },
        // Not `ok`. An entry the finished work never touched is not evidence that the pack worked,
        // and crediting it with the turn's success is what made `ok_count` a count of injections.
        { workspaceId, itemIds: [sendId], taskId, cited: false, outcome: 'unknown' }
      ]);
    });

    it('takes an explicit id list, which is the interface a citing finish feeds', async () => {
      const probe = packedProbe();
      await recordMemoryPackOutcome({
        store: probe.store,
        workspaceId,
        taskId,
        outcome: 'ok',
        dataKey,
        citedItemIds: [sendId]
      });
      expect(probe.uses[0]).toMatchObject({ itemIds: [sendId], cited: true });
    });

    it("cites nothing when the turn only handed back the owner's own words", async () => {
      const probe = packedProbe();
      await recordMemoryPackOutcome({
        store: probe.store,
        workspaceId,
        taskId,
        outcome: 'ok',
        dataKey,
        used: ['I checked the rate we are renewing the brochure job at.'],
        request: 'What rate are we renewing the brochure job at?'
      });
      expect(probe.uses).toEqual([
        { workspaceId, itemIds: [rateId, sendId], taskId, cited: false, outcome: 'unknown' }
      ]);
    });

    it('writes exactly the row it always wrote when it cannot open the pack', async () => {
      const probe = packedProbe();
      // The fallback that keeps a memory write from ever being the thing that fails a verified
      // turn: a key that cannot open these bytes attributes nothing, and attributing nothing must
      // not be spelled the same way as attributing nothing *to* every entry.
      await recordMemoryPackOutcome({
        store: probe.store,
        workspaceId,
        taskId,
        outcome: 'ok',
        dataKey: Buffer.alloc(32, 9),
        used: ['The renewal rate on the brochure job is 4.25 per cent for the current term.']
      });
      expect(probe.uses).toEqual([
        { workspaceId, itemIds: [rateId, sendId], taskId, outcome: 'ok' }
      ]);
    });

    it('writes the pack-wide grade when the caller offers nothing to attribute', async () => {
      const probe = packedProbe();
      await recordMemoryPackOutcome({
        store: probe.store,
        workspaceId,
        taskId,
        outcome: 'ok',
        dataKey,
        used: ['  ']
      });
      expect(probe.uses).toEqual([
        { workspaceId, itemIds: [rateId, sendId], taskId, outcome: 'ok' }
      ]);
    });
  });

  describe('what the turn said, as attribution reads it', () => {
    it("collects the turn's assistant prose and stops at the previous request", () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'first request' },
        { role: 'assistant', content: 'an answer from the turn before' },
        { role: 'user', content: 'second request' },
        { role: 'assistant', content: 'thinking out loud about the rate' },
        { role: 'tool', content: 'a tool result' },
        { role: 'assistant', content: 'the finished answer' }
      ];
      // Newest first, and the earlier turn is not this turn's evidence.
      expect(finishedAnswerText(messages)).toBe(
        'the finished answer\nthinking out loud about the rate'
      );
    });

    it('is empty for a turn the model has not answered yet', () => {
      expect(finishedAnswerText([{ role: 'user', content: 'go' }])).toBe('');
      expect(finishedAnswerText([])).toBe('');
    });
  });

  it('records nothing when the task had no pack', async () => {
    const probe = captureStore();
    await expect(
      recordMemoryPackOutcome({ store: probe.store, workspaceId, taskId, outcome: 'ok' })
    ).resolves.toBe(0);
    expect(probe.uses).toEqual([]);
  });

  it('consolidates once a day, not once a turn', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(shouldConsolidateMemory(undefined, 1_000)).toBe(true);
    expect(shouldConsolidateMemory(1_000, 1_000 + day - 1)).toBe(false);
    expect(shouldConsolidateMemory(1_000, 1_000 + day)).toBe(true);
  });
});

/**
 * The fakes above pin the contracts; this pins the SQL. Everything the runtime writes has to
 * survive a real migrated schema - foreign keys, chunk ordering, the blind index the recall query
 * matches on - and everything it reads has to come back through the same fusion query the store
 * ships. PGlite has neither pg_trgm nor pgvector, which is exactly the degraded case the design
 * requires to keep working.
 */
describe('against the real store', () => {
  let database: Database;
  let store: DataStore;
  let realUserId: string;
  let realWorkspaceId: string;
  let realTaskId: string;
  const startedAt = new Date('2026-07-31T08:00:00.000Z');

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    realUserId = user.id;
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'computer',
      storageLimitBytes: 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    realWorkspaceId = workspace.id;
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: encryptJson({ title: 'restart' }, dataKey, 'task-title:x'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'restart nginx' }, dataKey, 'task-prompt:x')
    });
    realTaskId = task.id;
  });

  afterEach(async () => database.close());

  const captureTurn = async (request: string, taskIdForTurn = realTaskId) =>
    recordTurnEpisode({
      store,
      userId: realUserId,
      workspaceId: realWorkspaceId,
      taskId: taskIdForTurn,
      dataKey,
      request,
      summary: 'Reloaded nginx on the preview gateway and confirmed it answers on 8443.',
      outcome: 'ok',
      verifiedClaims: ['curl https://localhost:8443 returned 200'],
      artifacts: ['systemctl reload nginx'],
      occurredAt: new Date('2026-07-30T08:00:00.000Z')
    });

  it('captures a turn that a later task then actually recalls', async () => {
    const captured = await captureTurn('reload nginx on the preview gateway');
    expect(captured).not.toBeNull();

    const episode = await store.getMemoryItem(realWorkspaceId, captured!.episodeId);
    expect(episode?.kind).toBe('episode');
    expect(episode?.taskId).toBe(realTaskId);
    await expect(store.listMemoryEvidence(captured!.episodeId)).resolves.toHaveLength(2);

    const pack = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: startedAt
    });
    expect(pack.reused).toBe(false);
    expect(pack.itemIds).toContain(captured!.episodeId);
    expect(pack.body).toContain('Goal: reload nginx on the preview gateway');
    // The verbatim layer came back too: replacing text with extracted artifacts measurably loses
    // accuracy, so both tiers have to be reachable from one query.
    expect(pack.body).toContain('## Verbatim');
  });

  it('re-emits identical bytes for the same task after the store has moved on', async () => {
    await captureTurn('reload nginx on the preview gateway');
    const first = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: startedAt
    });

    const later = await store.createTask({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      titleCiphertext: encryptJson({ title: 'again' }, dataKey, 'task-title:x'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'again' }, dataKey, 'task-prompt:x')
    });
    await captureTurn('reload nginx again on the preview gateway', later.id);

    const resumed = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: new Date('2026-08-06T08:00:00.000Z')
    });
    expect(resumed.reused).toBe(true);
    expect(resumed.body).toBe(first.body);
    expect(resumed.sha256).toBe(first.sha256);
  });

  it('keeps what the harness verified about this workspace, not only what the owner said', async () => {
    // The other half of memory. An acceptance check that passed is a command the HARNESS ran and
    // watched exit zero - not the agent's account of its work - which is why it lands at `derived`
    // and is admitted to recall where anything the agent merely concluded is `inferred` and is not.
    // "The deck has six slides" is about one afternoon; "in workspace, pnpm test exits 0" is about
    // the machine, and it is what the next turn needs in order not to rediscover it.
    const result = await recordTurnEpisode({
      store,
      userId: realUserId,
      workspaceId: realWorkspaceId,
      taskId: realTaskId,
      dataKey,
      request: 'Fix the failing test',
      summary: 'Fixed it.',
      outcome: 'ok',
      verifiedCommands: [
        { label: 'the suite passes', executable: 'pnpm', args: ['test'], cwd: 'workspace' }
      ],
      occurredAt: new Date('2026-07-31T09:00:00.000Z')
    });
    expect(result?.procedures).toBe(1);
    const procedures = await store.listMemoryItems(realWorkspaceId, { kind: 'procedure' });
    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.trust).toBe('derived');
  });

  it('settles nothing on a turn that read somebody else\u2019s words', async () => {
    // The gate that matters. An observation is only ever taken from the owner's own message, so a
    // page cannot state a fact - but it can try to make the owner restate one, and a turn holding
    // attacker-written text is the wrong moment to let anything become durable. The episode is
    // still recorded: what happened is history either way.
    await captureTurn('I use fish as my shell.');
    const later = await store.createTask({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      titleCiphertext: encryptJson({ title: 'again' }, dataKey, 'task-title:t'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'again' }, dataKey, 'task-prompt:t')
    });
    const result = await recordTurnEpisode({
      store,
      userId: realUserId,
      workspaceId: realWorkspaceId,
      taskId: later.id,
      dataKey,
      request: 'I use fish as my shell, remember',
      summary: 'Noted.',
      outcome: 'ok',
      tainted: true,
      occurredAt: new Date('2026-07-31T08:00:00.000Z')
    });
    expect(result?.episodeId).toBeTruthy();
    expect(result?.promotedFacts).toBe(0);
    await expect(store.listMemoryItems(realWorkspaceId, { kind: 'fact' })).resolves.toEqual([]);
    // It is corroborated and waiting - the next clean turn settles it, rather than it being lost.
    await expect(store.listPromotableMemoryFactCandidates(realWorkspaceId)).resolves.toMatchObject([
      { predicate: 'default_shell', episodeCount: 2 }
    ]);
  });

  it('mints a fact once the owner has said the same thing twice, without asking them', async () => {
    const first = await captureTurn('I use fish as my shell. Now reload nginx.');
    expect(first?.factCandidates).toBe(1);
    await expect(store.listMemoryItems(realWorkspaceId, { kind: 'fact' })).resolves.toEqual([]);
    // One sighting is not enough to promote, which is the whole point of the candidate table.
    await expect(store.listPromotableMemoryFactCandidates(realWorkspaceId)).resolves.toEqual([]);

    const later = await store.createTask({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      titleCiphertext: encryptJson({ title: 'again' }, dataKey, 'task-title:x'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'again' }, dataKey, 'task-prompt:x')
    });
    await recordTurnEpisode({
      store,
      userId: realUserId,
      workspaceId: realWorkspaceId,
      taskId: later.id,
      dataKey,
      request: 'I use fish as my shell, remember',
      summary: 'Noted.',
      outcome: 'ok',
      occurredAt: new Date('2026-07-31T08:00:00.000Z')
    });
    // The second telling corroborates it, and the turn that corroborates it is the turn that
    // settles it. Memory the owner has to approve entry by entry is not memory, it is a queue.
    // What keeps this safe is upstream: only the owner's own words are ever scanned for an
    // observation, so the agent cannot nominate its own conclusions, and a turn that read anything
    // from outside settles nothing at all - which the next test holds.
    await expect(store.listPromotableMemoryFactCandidates(realWorkspaceId)).resolves.toEqual([]);
    const facts = await store.listMemoryItems(realWorkspaceId, { kind: 'fact' });
    expect(facts).toHaveLength(1);
  });

  it('leaves a fact out of the pack once its validity has ended, and still reaches it as of a date', async () => {
    /*
     * The bitemporal clause, on the one query that fills the prompt.
     *
     * `store.test.ts` covers `asOf` at the store layer and has since it was written. The pack never
     * passed it: `buildTaskMemoryPack` sent `now` and stopped, `q.as_of` was NULL, and the validity
     * half of `MEMORY_ITEM_ADMISSIBLE` short-circuited to true for every pack this computer has
     * ever built - so the clause was covered everywhere except where it decides what the model is
     * told (ATH-045). A fact still `active` with a `valid_to` a day before the task opened was
     * ranked into the block at the top of the window as a current fact, held back by nothing but a
     * x0.12 prior that fusion leaves well above the noise floor on a request with little grip.
     *
     * The second half is what makes this test about `asOf` rather than about the row happening not
     * to match: anchored inside its own validity window, the same row comes back.
     */
    const content = {
      title: 'certificate rotation',
      body: 'The certificate rotation is blocked until the registrar answers.',
      subject: 'certificate rotation',
      object: 'blocked'
    };
    const expired = await store.createMemoryItem({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      kind: 'fact',
      trust: 'stated',
      predicate: 'project_status',
      documentCiphertext: encryptJson(content, dataKey, memoryItemAad(realWorkspaceId)),
      index: buildMemoryItemIndex(content, indexKey),
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      validFrom: new Date('2026-07-01T00:00:00.000Z'),
      // Observation plus a fortnight, which is how a dead end is actually recorded - and the row is
      // deliberately left `active`, because an expiry that has passed is not a status change. That
      // is exactly why the status filter alone never caught it.
      validTo: new Date('2026-07-15T00:00:00.000Z')
    });
    await store.rebuildMemoryCorpusStats(realWorkspaceId);
    const query = 'what is the status of the certificate rotation';

    const pack = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query,
      clockAnchor: startedAt
    });
    expect(pack.itemIds).not.toContain(expired.id);
    expect(pack.body).not.toContain('blocked until the registrar answers');

    // A task that opened while the fact was still true gets it, from the same store and the same
    // query - so what changed the answer is the anchor and nothing else.
    const earlier = await store.createTask({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      titleCiphertext: encryptJson({ title: 'earlier' }, dataKey, 'task-title:x'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: query }, dataKey, 'task-prompt:x')
    });
    const whileValid = await buildTaskMemoryPack({
      store,
      taskId: earlier.id,
      workspaceId: realWorkspaceId,
      dataKey,
      query,
      clockAnchor: new Date('2026-07-08T08:00:00.000Z')
    });
    expect(whileValid.itemIds).toContain(expired.id);
  });

  /**
   * The column at the far end of the wire, against the real schema.
   *
   * Everything above this line is a probe asserting which arguments were passed. This is the one
   * that says the argument reaches a `cited_count` on a migrated `mem.item` and moves the number
   * the salience formula reads - which is the whole claim, because the defect was never that the
   * SQL was wrong.
   */
  const rememberedFact = async (title: string, body: string) => {
    const content = { title, body, subject: title, tags: [] };
    return store.createMemoryItem({
      userId: realUserId,
      workspaceId: realWorkspaceId,
      kind: 'fact',
      trust: 'stated',
      documentCiphertext: encryptJson(content, dataKey, memoryItemAad(realWorkspaceId)),
      index: buildMemoryItemIndex(content, indexKey),
      predicate: 'related_to',
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      validFrom: new Date('2026-07-01T00:00:00.000Z')
    });
  };

  const packOf = async (...items: { id: string; title: string; body: string }[]) => {
    const rendered = renderMemoryPack(
      items.map((item) => ({
        id: item.id,
        kind: 'fact' as const,
        trust: 'stated' as const,
        observedAt: '2026-07-01T00:00:00.000Z',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: null,
        title: item.title,
        tags: [],
        body: item.body
      }))
    );
    await store.saveMemoryPack({
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      bodyCiphertext: encryptJson({ body: rendered.body }, dataKey, memoryPackAad(realTaskId)),
      sha256: rendered.sha256,
      itemIds: rendered.itemIds,
      tokensEst: rendered.tokensEst
    });
    return rendered;
  };

  it('increments cited_count on the entry the answer used, and only that one', async () => {
    const used = await rememberedFact(
      'the brochure renewal rate',
      'The renewal rate on the brochure job is 4.25 per cent for the current term.'
    );
    const ignored = await rememberedFact(
      'the last brochure send',
      'The last brochure send was held back until every font came back embedded.'
    );
    await packOf(
      {
        id: used.id,
        title: 'the brochure renewal rate',
        body: 'The renewal rate on the brochure job is 4.25 per cent for the current term.'
      },
      {
        id: ignored.id,
        title: 'the last brochure send',
        body: 'The last brochure send was held back until every font came back embedded.'
      }
    );

    await recordMemoryPackOutcome({
      store,
      workspaceId: realWorkspaceId,
      taskId: realTaskId,
      outcome: 'ok',
      dataKey,
      used: ['The renewal rate on the brochure job is 4.25 per cent for the current term.'],
      request: 'What rate are we renewing the brochure job at?'
    });

    const citedRow = await store.getMemoryItem(realWorkspaceId, used.id);
    const ignoredRow = await store.getMemoryItem(realWorkspaceId, ignored.id);
    expect(citedRow?.citedCount).toBe(1);
    expect(citedRow?.okCount).toBe(1);
    // Both were injected, so both were used; only one was read.
    expect(ignoredRow?.useCount).toBe(1);
    expect(ignoredRow?.citedCount).toBe(0);
    expect(ignoredRow?.okCount).toBe(0);
  });

  it('ranks a cited memory above an uncited one once consolidation has run', async () => {
    const used = await rememberedFact(
      'the brochure renewal rate',
      'The renewal rate on the brochure job is 4.25 per cent for the current term.'
    );
    const ignored = await rememberedFact(
      'the last brochure send',
      'The last brochure send was held back until every font came back embedded.'
    );
    await packOf(
      {
        id: used.id,
        title: 'the brochure renewal rate',
        body: 'The renewal rate on the brochure job is 4.25 per cent for the current term.'
      },
      {
        id: ignored.id,
        title: 'the last brochure send',
        body: 'The last brochure send was held back until every font came back embedded.'
      }
    );
    await recordMemoryPackOutcome({
      store,
      workspaceId: realWorkspaceId,
      taskId: realTaskId,
      outcome: 'ok',
      dataKey,
      used: ['The renewal rate on the brochure job is 4.25 per cent for the current term.'],
      request: 'What rate are we renewing the brochure job at?'
    });

    await store.consolidateMemory(realWorkspaceId, { now: startedAt });
    const citedSalience = (await store.getMemoryItem(realWorkspaceId, used.id))?.salience ?? 0;
    const ignoredSalience = (await store.getMemoryItem(realWorkspaceId, ignored.id))?.salience ?? 0;
    // Both were injected the same number of times, so the usage term is identical and the citation
    // term is the only thing separating them. Before this wave it was identical too, and these two
    // rows scored the same forever.
    expect(citedSalience).toBeGreaterThan(ignoredSalience);
  });

  /**
   * §4.7 #112. The tiered store had no duplicate suppression on the write path at all: the only
   * collapse anywhere was `DISTINCT ON (dedupe_key)` at recall time, which needs the bytes to be
   * identical, so two paraphrases of one preference produced two rows, two slots of the recall
   * budget and two lines in the block at the top of every later window.
   */
  describe('near-duplicate suppression on the write path', () => {
    const write = async (
      kind: 'fact' | 'procedure' | 'episode',
      subject: string | null,
      body: string
    ) => {
      const content = { title: null, tags: [], body, subject, object: null };
      return store.createMemoryItem({
        userId: realUserId,
        workspaceId: realWorkspaceId,
        kind,
        trust: 'stated',
        documentCiphertext: encryptJson(content, dataKey, memoryItemAad(realWorkspaceId)),
        index: buildMemoryItemIndex(content, indexKey),
        ...(kind === 'fact' ? { predicate: 'related_to' } : {}),
        observedAt: new Date('2026-07-01T00:00:00.000Z'),
        validFrom: new Date('2026-07-01T00:00:00.000Z')
      });
    };
    const activeCount = async (kind: string) =>
      Number(
        (
          await database.query<{ count: string }>(
            `SELECT count(*) AS count FROM mem.item
             WHERE workspace_id=$1 AND kind=$2::mem.kind AND status='active'`,
            [realWorkspaceId, kind]
          )
        ).rows[0]!.count
      );

    const preference =
      'The owner prefers the preview gateway reloaded rather than restarted whenever the certificate rotates.';
    /** Same ten content words, different sentence. Jaccard 1.00 over keyed body lexemes. */
    const paraphrase =
      'Whenever the certificate rotates, the owner prefers that the preview gateway is reloaded rather than restarted.';

    it('returns the row already remembered instead of writing the paraphrase beside it', async () => {
      const first = await write('fact', 'gateway reload', preference);
      const second = await write('fact', 'gateway reload', paraphrase);
      expect(second.id).toBe(first.id);
      expect(await activeCount('fact')).toBe(1);
    });

    it('leaves a looser restatement standing, which is what a 0.9 floor costs', async () => {
      // Measured, not guessed: swapping "rather than" for "not" takes the same sentence from 1.00
      // to 0.818 - nine shared lexemes over a union of eleven - and 0.818 is under the floor. The
      // floor is set where it is because the opposite error is unrecoverable: a refused write of a
      // fact that had genuinely changed is a correction the owner never gets back, while a
      // duplicate that survives costs a line of the pack and is collapsed by consolidation later.
      const first = await write('fact', 'gateway reload', preference);
      const second = await write(
        'fact',
        'gateway reload',
        'Whenever the certificate rotates the owner prefers the preview gateway reloaded, not restarted.'
      );
      expect(second.id).not.toBe(first.id);
      expect(await activeCount('fact')).toBe(2);
    });

    it('writes a genuinely different statement about the same subject', async () => {
      const first = await write('fact', 'gateway reload', preference);
      const second = await write(
        'fact',
        'gateway reload',
        'The preview gateway answers on port 8443 and the certificate is renewed by the relay itself.'
      );
      expect(second.id).not.toBe(first.id);
      expect(await activeCount('fact')).toBe(2);
    });

    it('never suppresses an episode, because two similar turns both happened', async () => {
      const first = await write('episode', null, preference);
      const second = await write('episode', null, preference);
      // The audit trail is one row per turn. Collapsing it would make "what did I do on Tuesday"
      // answer with Monday's work, and deleting the conversation would no longer delete its record.
      expect(second.id).not.toBe(first.id);
      expect(await activeCount('episode')).toBe(2);
    });

    it('writes a short entry even when its every word is already here', async () => {
      // Why the floor exists, in the one case that can actually reach the threshold from below it.
      // Jaccard is a set measure and word order is not in the set: these two sentences have the
      // identical four lexemes - deploy, relay, before, gateway - so they score 1.00 and mean
      // opposite things. Above the floor a run of eight content words in common is a paraphrase;
      // below it, it is a sentence rewritten backwards, and refusing the second one would lose a
      // correction the owner had just made, which is the worst thing this mechanism could do.
      const first = await write('fact', 'deploy order', 'Deploy the relay before the gateway.');
      const second = await write('fact', 'deploy order', 'Deploy the gateway before the relay.');
      expect(second.id).not.toBe(first.id);
      expect(await activeCount('fact')).toBe(2);
    });

    it('keeps two paraphrases about different subjects apart', async () => {
      const first = await write('fact', 'gateway reload', preference);
      const second = await write('fact', 'relay reload', paraphrase);
      expect(second.id).not.toBe(first.id);
      expect(await activeCount('fact')).toBe(2);
    });
  });

  /**
   * The nightly half of §4.3, which had never had a caller.
   *
   * `resolveMemoryContradiction` is the resolution table and nothing in the product could reach it;
   * `markMemoryFactsDisputed` writes the status the review queue serves and nothing in the product
   * could reach that either, so the queue could clear a dispute nothing was able to raise. Both are
   * closed by one pass, and this is the state that reaches it: a predicate that used to permit many
   * values, narrowed to one by a release, over a subject that had already accumulated two - the
   * case `#backfillPredicateFunctional` deliberately leaves standing and promises will be "resolved
   * the ordinary way".
   */
  describe('the contradiction pass inside consolidation', () => {
    const statedFact = async (
      subject: string,
      object: string,
      observedAt: string,
      trust: 'stated' | 'derived' = 'stated'
    ) => {
      const content = { title: null, tags: [], body: `${subject} is ${object}.`, subject, object };
      return store.createMemoryItem({
        userId: realUserId,
        workspaceId: realWorkspaceId,
        kind: 'fact',
        trust,
        documentCiphertext: encryptJson(content, dataKey, memoryItemAad(realWorkspaceId)),
        index: buildMemoryItemIndex(content, indexKey),
        predicate: 'related_to',
        observedAt: new Date(observedAt),
        validFrom: new Date(observedAt)
      });
    };
    /** What a release that narrows a cardinality leaves behind, exactly. */
    const narrowRelatedTo = async () =>
      database.query(`UPDATE mem.predicate SET cardinality='one' WHERE name='related_to'`);

    const statusOf = async (id: string) => (await store.getMemoryItem(realWorkspaceId, id))?.status;

    it('does nothing at all while the predicate still permits many values', async () => {
      await statedFact('the gateway', 'behind the relay', '2026-07-01T00:00:00.000Z');
      await statedFact('the gateway', 'in front of the relay', '2026-07-02T00:00:00.000Z');
      const report = await store.consolidateMemory(realWorkspaceId, { now: startedAt });
      expect(report.factsDisputed).toBe(0);
      expect(report.factsSuperseded).toBe(0);
      expect(report.factsRetracted).toBe(0);
    });

    it('raises a dispute when the owner stated both, and puts it in the review queue', async () => {
      const first = await statedFact('the gateway', 'behind the relay', '2026-07-01T00:00:00.000Z');
      const second = await statedFact(
        'the gateway',
        'in front of the relay',
        '2026-07-02T00:00:00.000Z'
      );
      await narrowRelatedTo();

      const report = await store.consolidateMemory(realWorkspaceId, { now: startedAt });
      expect(report.factsDisputed).toBe(2);
      expect(await statusOf(first.id)).toBe('disputed');
      expect(await statusOf(second.id)).toBe('disputed');
      // The queue three documents promise, finally with something in it.
      const queued = await store.listDisputedMemoryItems(realWorkspaceId, 10);
      expect(queued.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
      // And the link that says what each conflicts with, without which "disputed" is unactionable.
      expect(queued.find((entry) => entry.id === first.id)?.contradicts).toEqual([second.id]);
    });

    it('keeps what the owner stated over what athanor inferred', async () => {
      const inferred = await statedFact(
        'the gateway',
        'behind the relay',
        '2026-07-02T00:00:00.000Z',
        'derived'
      );
      const stated = await statedFact(
        'the gateway',
        'in front of the relay',
        '2026-07-01T00:00:00.000Z'
      );
      await narrowRelatedTo();

      const report = await store.consolidateMemory(realWorkspaceId, { now: startedAt });
      // Newer, and it still loses: trust outranks recency, because a thing the owner said is not
      // overturned by something athanor worked out afterwards.
      expect(report.factsRetracted).toBe(1);
      expect(await statusOf(inferred.id)).toBe('retracted');
      expect(await statusOf(stated.id)).toBe('active');
    });

    it('supersedes the older of two inferred values and links the replacement', async () => {
      const older = await statedFact(
        'the gateway',
        'behind the relay',
        '2026-07-01T00:00:00.000Z',
        'derived'
      );
      const newer = await statedFact(
        'the gateway',
        'in front of the relay',
        '2026-07-02T00:00:00.000Z',
        'derived'
      );
      await narrowRelatedTo();

      const report = await store.consolidateMemory(realWorkspaceId, { now: startedAt });
      expect(report.factsSuperseded).toBe(1);
      expect(await statusOf(older.id)).toBe('superseded');
      expect(await statusOf(newer.id)).toBe('active');
      const links = await database.query<{ src_id: string; rel: string }>(
        `SELECT src_id, rel FROM mem.link WHERE dst_id=$1`,
        [older.id]
      );
      expect(links.rows).toEqual([{ src_id: newer.id, rel: 'supersedes' }]);
    });

    it('answers each pair once, so a nightly pass does not become a standing bill', async () => {
      await statedFact('the gateway', 'behind the relay', '2026-07-01T00:00:00.000Z', 'derived');
      await statedFact(
        'the gateway',
        'in front of the relay',
        '2026-07-02T00:00:00.000Z',
        'derived'
      );
      await narrowRelatedTo();
      expect(
        (await store.consolidateMemory(realWorkspaceId, { now: startedAt })).factsSuperseded
      ).toBe(1);
      // The loser is no longer active and the link records the answer, so the second night finds
      // nothing to do rather than re-deciding what was already decided.
      expect(
        (await store.consolidateMemory(realWorkspaceId, { now: startedAt })).factsSuperseded
      ).toBe(0);
    });
  });

  it('records the pack outcome and survives a consolidation pass', async () => {
    await captureTurn('reload nginx on the preview gateway');
    const pack = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: startedAt
    });
    await expect(
      recordMemoryPackOutcome({
        store,
        workspaceId: realWorkspaceId,
        taskId: realTaskId,
        outcome: 'ok'
      })
    ).resolves.toBeGreaterThan(0);

    const report = await store.consolidateMemory(realWorkspaceId, { now: startedAt });
    expect(report.salienceUpdated).toBeGreaterThan(0);
    // Consolidation must never make an injected pack unreadable mid-task.
    const after = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: startedAt
    });
    expect(after.body).toBe(pack.body);
  });

  /**
   * Two conversations the task never mentioned, so nothing here can be answered by what the pack
   * happened to open with. That is the whole case the recall tool exists for.
   */
  const captureHistory = async (): Promise<Map<string, string>> => {
    const tasks = new Map<string, string>();
    const history: [string, string, string][] = [
      [
        'wal',
        'set up write ahead log archiving for postgres',
        'The write ahead log is archived to /srv/athanor/var/wal every five minutes by archive_command.'
      ],
      [
        'fonts',
        'the report came out in the wrong typeface',
        'LibreOffice substituted a metric-compatible face because Calibri was not installed. I installed the Carlito family and the report renders as written.'
      ]
    ];
    for (const [name, request, summary] of history) {
      const created = await store.createTask({
        userId: realUserId,
        workspaceId: realWorkspaceId,
        titleCiphertext: encryptJson({ title: name }, dataKey, 'task-title:x'),
        nameIndex: { nameTokens: '', openingTokens: '' },
        modelId: 'vendor/model',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        promptCiphertext: encryptJson({ prompt: request }, dataKey, 'task-prompt:x')
      });
      tasks.set(name, created.id);
      await recordTurnEpisode({
        store,
        userId: realUserId,
        workspaceId: realWorkspaceId,
        taskId: created.id,
        dataKey,
        request,
        summary,
        outcome: 'ok',
        occurredAt: new Date('2026-07-20T08:00:00.000Z')
      });
    }
    await store.rebuildMemoryCorpusStats(realWorkspaceId);
    return tasks;
  };

  it('answers a question the frozen pack never covered, and does not repeat what it did', async () => {
    await captureHistory();
    const pack = await buildTaskMemoryPack({
      store,
      taskId: realTaskId,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'reload nginx on the preview gateway',
      clockAnchor: startedAt
    });

    // Before this existed the task was finished: the pack was chosen from the opening request and
    // frozen, and nothing about the write ahead log could enter it however relevant it became.
    const recalled = await recallMemory({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      taskId: realTaskId,
      query: 'where does the write ahead log get archived',
      now: startedAt
    });
    expect(recalled.entries.length).toBeGreaterThan(0);
    expect(recalled.entries.some((entry) => entry.body.includes('/srv/athanor/var/wal'))).toBe(
      true
    );
    // Nothing the pack already spent tokens on comes back a second time.
    for (const entry of recalled.entries) expect(pack.itemIds).not.toContain(entry.id);
    expect(recalled.alreadyInContext).toEqual([...pack.itemIds]);
  });

  it('searches past conversations by what they meant, and shows the turns around a hit', async () => {
    const tasks = await captureHistory();

    // "typeface" appears in no stored turn: the transcript says "wrong typeface" in the request and
    // "metric-compatible face" in the reply, and the answer is the reply. A substring scan of the
    // question finds no position in the answer at all.
    const found = await searchMemorySessions({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'why did the report render in a substituted typeface'
    });
    expect(found.matches.length).toBeGreaterThan(0);
    expect(found.matches[0]?.taskId).toBe(tasks.get('fonts'));
    expect(found.conversations).toBeGreaterThan(0);
    const excerpts = found.matches.map((match) => match.text).join('\n');
    expect(excerpts).toContain('Carlito');

    // The answer is very often in the reply to the message that matched, so the leading hits carry
    // their neighbours - and only the leading ones, because each is a second query.
    expect(found.matches.filter((match) => match.context).length).toBeLessThanOrEqual(
      MEMORY_SESSION_SEARCH_CONTEXT_HITS
    );
    // A turn that is already a result is never also printed as another result's context: two hits
    // in one thread are each other's neighbours, and that is the same tokens twice.
    const shown = new Set(found.matches.map((match) => match.id));
    const context = found.matches.flatMap((match) => match.context ?? []);
    expect(context.every((turn) => !shown.has(turn.id))).toBe(true);
  });

  it('restricts a search to one past conversation, and bounds what a search can return', async () => {
    const tasks = await captureHistory();
    const inside = await searchMemorySessions({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'archive the write ahead log',
      taskId: tasks.get('wal')!
    });
    expect(inside.matches.length).toBeGreaterThan(0);
    expect(inside.matches.every((match) => match.taskId === tasks.get('wal'))).toBe(true);

    const capped = await searchMemorySessions({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'archive the write ahead log',
      maxResults: 10_000
    });
    expect(capped.matches.length).toBeLessThanOrEqual(MEMORY_SESSION_SEARCH_MAX_RESULTS);

    await expect(
      searchMemorySessions({ store, workspaceId: realWorkspaceId, dataKey, query: ' ' })
    ).rejects.toThrow('look for');
  });

  it('returns nothing rather than everything when no past conversation matches', async () => {
    await captureHistory();
    const found = await searchMemorySessions({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'what did the dentist charge for the crown'
    });
    expect(found.matches).toEqual([]);
    expect(found.conversations).toBe(0);
    // "It never came up" and "it happened before this computer started recording" are different
    // facts. Without the second number the agent states the first one, about the owner's own life.
    expect(found.searchable).toMatchObject({ conversations: 2 });
    expect(found.searchable?.turns).toBeGreaterThan(0);
    expect(found.searchable?.earliest).toBe('2026-07-20T08:00:00.000Z');
  });

  it('says the store is empty rather than that nothing was ever discussed', async () => {
    const found = await searchMemorySessions({
      store,
      workspaceId: realWorkspaceId,
      dataKey,
      query: 'anything at all'
    });
    expect(found.searchable).toEqual({ conversations: 0, turns: 0, earliest: null });
  });
});
