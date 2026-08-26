/**
 * The order of the preamble, asserted as an order.
 *
 * `window.ts` was the largest pure move of Wave 7.2 - 407 lines - and it arrived with no test of its
 * own. `assemblePreamble` was exercised only by driving a whole turn through `agent-run.test.ts`,
 * which reads the *contents* of the window and never its arrangement. That is the wrong half. Every
 * line in this file is about where a block sits, because where it sits is what a provider's cache
 * charges for: Wave 3 measured the ordering here at 74.8% -> 76.1% byte-common prefix and -4.5%
 * billable input, and until now the only thing protecting that number was the eval suite's aggregate
 * token count - a figure that moves for a dozen reasons and names none of them.
 *
 * So the assertions here are deliberately about position and identity rather than about text:
 *
 * - the three preamble blocks land in one order, and it is the same order on a fresh turn and on a
 *   resumed one, which is the property `injectMemoryPack` and the brief's move-to-the-end exist for;
 * - a block whose bytes have not changed is written over in place, so the window is byte-identical
 *   rather than merely equal - a splice that moved everything behind it by one would satisfy a
 *   contents test and re-bill the whole prompt;
 * - the two blocks the header calls frozen are ranked and clocked against `task.createdAt`, so they
 *   do not rewrite themselves mid-run;
 * - the plan and the runtime block go at the tail, which is the opposite decision and is argued for
 *   in the file at length.
 */
import { WEB_TOOL_DISCLOSURE, type WebToolPlan } from '@athanor/contracts';
import { encryptJson } from '@athanor/core';
import type {
  DataStore,
  MemoryCandidateRecord,
  MemoryPackRecord,
  TaskPlanRecord,
  TaskRecord,
  WorkspaceMemoryRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from '@athanor/data';
import type { ModelMessage } from '@athanor/model-gateway';
import { describe, expect, it } from 'vitest';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import { CONDENSED_HISTORY_MARKER, RUNTIME_CONTEXT_MARKER } from './context.js';
import { MEMORY_PACK_MARKER, memoryItemAad, memoryPackBudgetTokens } from './memory-runtime.js';
import type { AgentRunnerClient } from './runner-client.js';
import { WORKSPACE_BRIEF_MARKER } from './turn-bounds.js';
import {
  assemblePreamble,
  refreshActivePlan,
  refreshRuntimeContext,
  type WindowDeps
} from './window.js';

const key = new Uint8Array(32).fill(9);
const KNOWLEDGE_MARKER = 'CURATED ENCRYPTED KNOWLEDGE';
const PLAN_MARKER = 'ACTIVE USER-VISIBLE PLAN';
const BASE_PROMPT = 'BASE SYSTEM PROMPT';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

const task = {
  id: taskId,
  userId,
  workspaceId,
  securityMode: 'standard',
  createdAt: '2026-08-01T00:00:00.000Z'
} as unknown as TaskRecord;

const workspace = {
  id: workspaceId,
  userId,
  name: 'daily',
  securityMode: 'standard'
} as unknown as WorkspaceRecord;

interface Probe {
  deps: WindowDeps;
  /** What the runner answers for `workspace/ATHANOR.md`; `null` makes the read fail. */
  brief: string | null;
  memories: WorkspaceMemoryRecord[];
  skills: WorkspaceSkillRecord[];
  /** Set to make the memory store throw, which is the "memory is an aid, not a precondition" path. */
  packFails: boolean;
  /** What the fusion query answers with, which is what ends up rendered into the pack. */
  candidates: MemoryCandidateRecord[];
  plan: TaskPlanRecord | null;
  readonly events: Array<{ kind: string }>;
  readonly recallQueries: unknown[];
}

const memory = (id: string, target: 'workspace' | 'user', content: string): WorkspaceMemoryRecord =>
  ({
    id,
    userId,
    workspaceId,
    target,
    contentCiphertext: encryptJson({ content }, key, `workspace-memory:${workspaceId}`),
    validUntil: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceMemoryRecord;

/** One row the fusion query can return, sealed the way the item layer seals them. */
const candidate = (id: string, body: string): MemoryCandidateRecord => ({
  id,
  layer: 'item',
  kind: 'fact',
  trust: 'stated',
  status: 'active',
  observedAt: '2026-07-01T00:00:00.000Z',
  validFrom: '2026-07-01T00:00:00.000Z',
  validTo: null,
  subjectKey: null,
  predicate: null,
  tokensEst: 20,
  score: 1,
  documentCiphertext: encryptJson({ body }, key, memoryItemAad(workspaceId))
});

const skill = (id: string, name: string, description: string): WorkspaceSkillRecord =>
  ({
    id,
    userId,
    workspaceId,
    nameHash: name,
    documentCiphertext: encryptJson({ name, description }, key, `workspace-skill:${workspaceId}`),
    version: 1,
    enabled: true,
    status: 'active',
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceSkillRecord;

const probe = (): Probe => {
  const state: Probe = {
    brief: null,
    memories: [],
    skills: [],
    packFails: false,
    candidates: [],
    plan: null,
    events: [],
    recallQueries: [],
    deps: undefined as unknown as WindowDeps
  };
  const packs = new Map<string, MemoryPackRecord>();
  state.deps = {
    config: { PREVIEW_BASE_URL: 'https://preview.invalid' } as unknown as AgentWorkerConfig,
    runner: {
      readFile: async (_workspaceId: string, _taskId: string, path: string) => {
        if (state.brief === null) throw new Error(`no such file: ${path}`);
        return state.brief;
      }
    } as unknown as AgentRunnerClient,
    store: {
      listWorkspaceMemories: async () => state.memories,
      curateWorkspaceSkills: async () => undefined,
      listWorkspaceSkills: async () => state.skills,
      getMemoryPack: async (id: string) => packs.get(id) ?? null,
      saveMemoryPack: async (input: {
        taskId: string;
        workspaceId: string;
        bodyCiphertext: unknown;
        sha256: string;
        itemIds: string[];
        tokensEst: number;
      }) => {
        const record = {
          ...input,
          briefVersion: null,
          itemIds: [...input.itemIds],
          createdAt: '2026-08-01T00:00:00.000Z'
        } as unknown as MemoryPackRecord;
        packs.set(input.taskId, record);
        return record;
      },
      recallMemoryCandidates: async (input: unknown) => {
        state.recallQueries.push(input);
        if (state.packFails) throw new Error('memory store unavailable');
        return state.candidates;
      },
      appendTaskEvent: async (input: { kind: string }) => {
        state.events.push({ kind: input.kind });
        return { id: 'event' };
      },
      getLatestTaskPlan: async () => state.plan,
      createTaskPlan: async (input: { taskId: string }) => {
        const record = {
          id: 'plan-1',
          taskId: input.taskId,
          version: 1,
          parentVersion: null,
          branchName: 'Main',
          stepsCiphertext: encryptJson(
            { steps: [{ id: 's1', title: 'Inspect', status: 'in_progress' }], branchName: 'Main' },
            key,
            `task-plan:${taskId}`
          ),
          createdBy: 'agent',
          createdAt: '2026-08-01T00:00:00.000Z'
        } as TaskPlanRecord;
        state.plan = record;
        return record;
      }
    } as unknown as DataStore
  };
  return state;
};

const freshState = (): AgentState => ({
  messages: [
    { role: 'system', content: BASE_PROMPT },
    { role: 'user', content: 'fix the importer' }
  ],
  step: 0,
  credits: 0
});

/** What each message in the window is, by the marker that identifies it. */
const shape = (messages: ModelMessage[]): string[] =>
  messages.map((message) => {
    if (message.role !== 'system') return `${message.role}`;
    if (message.content.startsWith(KNOWLEDGE_MARKER)) return 'knowledge';
    if (message.content.startsWith(MEMORY_PACK_MARKER)) return 'pack';
    if (message.content.startsWith(WORKSPACE_BRIEF_MARKER)) return 'brief';
    if (message.content.startsWith(CONDENSED_HISTORY_MARKER)) return 'condensed';
    if (message.content.startsWith(RUNTIME_CONTEXT_MARKER)) return 'runtime';
    if (message.content.startsWith(PLAN_MARKER)) return 'plan';
    return 'base';
  });

const preamble = { task, key, goal: 'fix the importer', contextTokens: 200_000 };

/** The in-house route, which is what the runtime block says when nothing has moved it. */
const inHouse: WebToolPlan = {
  mode: 'in_house',
  reason: 'forced_in_house',
  disclosure: WEB_TOOL_DISCLOSURE.in_house,
  serverTools: []
};

describe('the preamble', () => {
  /**
   * The order, on a fresh turn.
   *
   * Frozen blocks first - the reviewed knowledge and the recalled pack, both anchored to the task's
   * own creation instant - then the workspace brief, which is a plain file the running agent writes
   * and is therefore the one block that genuinely changes between turns. Ahead of them it would move
   * the divergence point to the second message and re-bill everything behind it.
   */
  it('puts the frozen blocks ahead of the block that changes', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.skills = [skill('s1', 'importer', 'how the importer works')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
    // The pack is absent here only because this store recalled nothing; with entries it lands
    // between the two, which the next case measures.
    expect(state.messages[1]?.content).toContain('prefers metric units');
    expect(state.messages[1]?.content).toContain('importer');
    expect(state.messages[2]?.content).toContain('This project uses uv.');
  });

  /**
   * All four blocks at once, which is the arrangement the measurement was taken on.
   *
   * This is the assertion the whole file is for: reviewed knowledge, then the recalled pack, then
   * the brief, then the owner's goal. Nothing else in the repository states it - `agent-run.test.ts`
   * reads what the window contains and never where anything sits, and the eval suite sees only a
   * token total.
   */
  it('lands the four blocks in one order: knowledge, pack, brief, goal', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.candidates = [candidate('c1', 'the exporter writes UTF-8')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'pack', 'brief', 'user']);
    expect(state.messages[2]?.content).toContain('the exporter writes UTF-8');
  });

  /**
   * And the same four in the same order when the turn is resumed into a window that already has
   * them, which is what makes the ordering a cacheable prefix rather than a first-turn accident.
   */
  it('reaches that order again from a window that already holds all four', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.candidates = [candidate('c1', 'the exporter writes UTF-8')];
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    const before = state.messages.map((message) => message.content);

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'pack', 'brief', 'user']);
    expect(state.messages.map((message) => message.content)).toEqual(before);
  });

  /**
   * The same order on a resumed turn, which is the case the brief's move-to-the-end exists for.
   *
   * `injectMemoryPack` removes and re-adds at the end of the leading system run, so a resume whose
   * window already held a brief would otherwise get the pack *after* it - and the window's shape
   * would depend on which turn it was, which is exactly what a cached prefix cannot survive.
   */
  it('reaches the same order from a window that already holds a brief', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    const state = freshState();
    state.messages.splice(1, 0, {
      role: 'system',
      content: `${WORKSPACE_BRIEF_MARKER}\nstale placement`
    });
    expect(shape(state.messages)).toEqual(['base', 'brief', 'user']);

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
  });

  /**
   * An unchanged block leaves the window byte-identical, not merely equal.
   *
   * The knowledge block is written over where it sits and the brief is written over where it sits
   * once it is already last. Removing and re-inserting either would move every message behind it by
   * one - a change no contents assertion can see and every cache can.
   */
  it('rewrites nothing when a second assembly finds the same facts', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'workspace', 'the importer reads three columns')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });
    const before = state.messages.map((message) => message.content);
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(state.messages.map((message) => message.content)).toEqual(before);
    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
  });

  /**
   * Both frozen blocks are ranked and clocked against the task's own start, not the wall clock.
   *
   * The header on the knowledge block says "frozen for this run" and the pack is persisted as
   * rendered bytes for the same reason. Reading it off the recall query is the only place the claim
   * is observable without waiting for a day to pass.
   */
  it('anchors recall to the task start rather than to now', async () => {
    const probed = probe();
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(probed.recallQueries).toHaveLength(1);
    const query = probed.recallQueries[0] as { now: Date; asOf: Date; budgetTokens: number };
    expect(query.now.toISOString()).toBe(task.createdAt);
    expect(query.asOf.toISOString()).toBe(task.createdAt);
    // The pack's share of the lead model's window - a share with a ceiling on it, which is why
    // this reads the helper rather than restating the arithmetic.
    expect(query.budgetTokens).toBe(memoryPackBudgetTokens(200_000));
    expect(memoryPackBudgetTokens(4_096)).toBeLessThan(memoryPackBudgetTokens(200_000));
  });

  /**
   * Memory is an aid, not a precondition. A store that cannot be read writes a warning the owner can
   * see and leaves the rest of the preamble intact.
   */
  it('starts the task without a pack when memory cannot be read', async () => {
    const probed = probe();
    probed.packFails = true;
    probed.brief = 'This project uses uv.';
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(probed.events).toEqual([{ kind: 'warning' }]);
    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
  });

  /** A workspace with no brief file contributes no block, rather than an empty one. */
  it('leaves no brief block when there is no brief', async () => {
    const probed = probe();
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'user']);
  });

  /** And a brief that has been deleted since the last turn is taken back out of the window. */
  it('removes a brief block once the file is gone', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(shape(state.messages)).toContain('brief');

    probed.brief = null;
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'user']);
  });

  /**
   * The condensed brief is carried in two places on purpose, and a resumed state that has the
   * sections but not the message would otherwise continue with no record of the condensed work.
   * It is republished directly after the goal, which is where compaction keeps it.
   */
  it('republishes a condensed history that a resume arrived without', async () => {
    const probed = probe();
    const state = freshState();
    state.contextBrief = {
      sections: [{ from: 1, to: 3, messages: 12, source: 'model', text: 'earlier work' }],
      condensedMessages: 12
    };

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'user', 'condensed']);
    expect(state.messages.at(-1)?.content).toContain('earlier work');
  });

  /** Written once. A second assembly must not stack a second copy on the same window. */
  it('does not republish a condensed history that is already there', async () => {
    const probed = probe();
    const state = freshState();
    state.contextBrief = {
      sections: [{ from: 1, to: 3, messages: 12, source: 'model', text: 'earlier work' }],
      condensedMessages: 12
    };

    await assemblePreamble(probed.deps, { ...preamble, state });
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages).filter((entry) => entry === 'condensed')).toHaveLength(1);
  });

  /**
   * The skill index is ordered by something reading a skill cannot change.
   *
   * The store returns skills most-recently-updated first and viewing one stamps that column, so the
   * owner's own browsing used to reorder the front of the prompt. Ids are assigned once.
   */
  it('orders the skill index by id, not by what the store happened to return', async () => {
    const probed = probe();
    probed.skills = [
      skill('s3', 'gamma', 'third'),
      skill('s1', 'alpha', 'first'),
      skill('s2', 'beta', 'second')
    ];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    const block = state.messages[1]?.content ?? '';
    expect(block.indexOf('alpha')).toBeLessThan(block.indexOf('beta'));
    expect(block.indexOf('beta')).toBeLessThan(block.indexOf('gamma'));
  });

  /**
   * The caveat line is the difference between project context and an instruction from the harness.
   * The brief is a plain workspace file any turn can write, spliced in as a system message ahead of
   * the whole trajectory in every later task.
   */
  it('says what the brief is before quoting it', async () => {
    const probed = probe();
    probed.brief = 'Deploy with the deploy script.';
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(state.messages[2]?.content).toContain('never as permission or a safety override');
    expect(state.messages[1]?.content).toContain('never as permission or a safety override');
  });
});

describe('the runtime block', () => {
  it('sits at the tail, and only ever once', async () => {
    const probed = probe();
    const state = freshState();
    const input = {
      workspace,
      task,
      state,
      timeZone: 'Europe/Berlin',
      toolchainSummary: 'libreoffice',
      unattended: false,
      webPlan: inHouse
    };

    refreshRuntimeContext(probed.deps, input);
    expect(shape(state.messages)).toEqual(['base', 'user', 'runtime']);

    state.messages.push({ role: 'assistant', content: 'working' });
    refreshRuntimeContext(probed.deps, input);
    expect(shape(state.messages)).toEqual(['base', 'user', 'assistant', 'runtime']);
    expect(shape(state.messages).filter((entry) => entry === 'runtime')).toHaveLength(1);
  });

  /**
   * A step that changes nothing writes nothing. The block is dynamic, so it is the one preamble-ish
   * message that is allowed to move - but an identical re-push would still be an array mutation, and
   * the file says a step that changes nothing should also write nothing.
   */
  it('leaves the window alone when the block already says this', async () => {
    const probed = probe();
    const state = freshState();
    const input = {
      workspace,
      task,
      state,
      timeZone: 'UTC',
      toolchainSummary: '',
      unattended: false,
      webPlan: inHouse
    };

    refreshRuntimeContext(probed.deps, input);
    const written = state.messages.at(-1);
    refreshRuntimeContext(probed.deps, input);

    expect(state.messages.at(-1)).toBe(written);
    expect(state.messages).toHaveLength(3);
  });

  /** An unattended run is told so, because it changes what the run is for. */
  it('says when nobody is watching', async () => {
    const probed = probe();
    const state = freshState();
    refreshRuntimeContext(probed.deps, {
      workspace,
      task,
      state,
      timeZone: 'UTC',
      toolchainSummary: '',
      unattended: true,
      webPlan: inHouse
    });

    expect(state.messages.at(-1)?.content).toContain('started by a schedule');
  });
});

describe('the active plan', () => {
  /**
   * Pushed at the tail rather than written in place, and the file argues the measurement: a
   * republish diverges at the tail as it stood a few steps ago instead of just behind the goal.
   */
  it('goes to the tail and takes any older copy with it', async () => {
    const probed = probe();
    const state = freshState();
    state.messages.push({ role: 'system', content: `${PLAN_MARKER} v1 (Main).\n1. [pending] old` });
    state.messages.push({ role: 'assistant', content: 'working' });
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 2,
      parentVersion: 1,
      branchName: 'Main',
      stepsCiphertext: encryptJson(
        { steps: [{ id: 's1', title: 'Rewrite the importer', status: 'in_progress' }] },
        key,
        `task-plan:${taskId}`
      ),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };

    const changed = await refreshActivePlan(probed.deps, task, key, state);

    expect(changed).toBe(true);
    expect(shape(state.messages)).toEqual(['base', 'user', 'assistant', 'plan']);
    expect(state.messages.at(-1)?.content).toContain('Rewrite the importer');
    expect(state.planVersion).toBe(2);
  });

  it('writes nothing when the window already holds this version', async () => {
    const probed = probe();
    const state = freshState();
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 2,
      parentVersion: null,
      branchName: 'Main',
      stepsCiphertext: encryptJson({ steps: [] }, key, `task-plan:${taskId}`),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };
    await refreshActivePlan(probed.deps, task, key, state);
    const written = state.messages.at(-1);

    const changed = await refreshActivePlan(probed.deps, task, key, state);

    expect(changed).toBe(false);
    expect(state.messages.at(-1)).toBe(written);
  });

  /** A plan sealed for a different task is refused rather than read. */
  it('refuses a plan sealed under another task', async () => {
    const probed = probe();
    const state = freshState();
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 1,
      parentVersion: null,
      branchName: 'Main',
      stepsCiphertext: encryptJson({ steps: [] }, key, 'task-plan:99999999'),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };

    await expect(refreshActivePlan(probed.deps, task, key, state)).rejects.toThrow(
      /encryption context/i
    );
  });

  /** With nothing published and no fallback asked for, the window stays as it was. */
  it('does not invent a plan unless it is asked to', async () => {
    const probed = probe();
    const state = freshState();

    expect(await refreshActivePlan(probed.deps, task, key, state)).toBe(false);
    expect(shape(state.messages)).toEqual(['base', 'user']);

    expect(await refreshActivePlan(probed.deps, task, key, state, true)).toBe(true);
    expect(state.planIsFallback).toBe(true);
    expect(shape(state.messages)).toEqual(['base', 'user', 'plan']);
  });
});
