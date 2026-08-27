/**
 * The floor line F3: a per-observation cut has to leave the cut content somewhere retrievable.
 *
 * Two levels, deliberately. The unit half proves the fixed point in `truncateMiddle` - a recovery
 * that names where the cut fell changes the marker's length by naming it - because that arithmetic
 * has no other test and it is the half a future edit will get wrong. The live half drives
 * `recordToolResult`, because a helper that spills correctly proves nothing about whether the
 * string in the model's window went through it, and "the mechanism exists but no production caller
 * reaches it" is the finding this programme has made four times.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decryptJson, generateDataKey } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from './agent-state.js';
import { isQuarantinedDownloadPath } from './command-classification.js';
import { RECENT_TOOL_OUTPUT_CHARS, toolResultText, truncateMiddle } from './context.js';
import {
  MAX_SPILL_CHARS,
  SPILL_DIRECTORY,
  UNTRUSTED_SPILL_DIRECTORY,
  spillOverflow,
  spillPathFor,
  useOutputSpill
} from './output-spill.js';
import type { AgentRunnerClient } from './runner-client.js';
import { recordToolResult, type ToolRecordingDeps } from './tool-recording.js';

const dataKey = generateDataKey();
const task = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: 'user-1',
  workspaceId: 'workspace-1'
} as unknown as TaskRecord;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Write {
  workspaceId: string;
  taskId: string;
  path: string;
  content: string;
}

/**
 * The recording harness of `sanitise.test.ts`, plus the runner the spill writes through and a
 * ledger of what it was asked to write. `refuse` is how the negative case is built: a runner that
 * says no must cost the model the pointer and nothing else.
 */
const recording = (
  options: { refuse?: boolean; register?: boolean } = {}
): {
  deps: ToolRecordingDeps;
  state: AgentState;
  writes: Write[];
  events: Array<{ summary: string; payload: unknown }>;
} => {
  const events: Array<{ summary: string; payload: unknown }> = [];
  const writes: Write[] = [];
  const store = {
    appendTaskEvent: async (input: { payloadCiphertext: Parameters<typeof decryptJson>[0] }) => {
      events.push(
        decryptJson<{ summary: string; payload: unknown }>(input.payloadCiphertext, dataKey)
      );
      return { id: `event-${events.length}`, sequence: events.length };
    }
  } as unknown as DataStore;
  const deps = {
    store,
    config: {} as ToolRecordingDeps['config'],
    raiseTakeover: async () => undefined,
    destinationContext: () => ({ knownOrigins: [], ownerText: '' })
  } as unknown as ToolRecordingDeps;
  const state = { messages: [], credits: 0, step: 1 } as unknown as AgentState;
  const runner = {
    writeFile: async (workspaceId: string, taskId: string, path: string, content: string) => {
      if (options.refuse) throw new Error('workspace service refused the write');
      writes.push({ workspaceId, taskId, path, content });
      return { ok: true };
    }
  } as unknown as AgentRunnerClient;
  if (options.register !== false) useOutputSpill(state, runner);
  return { deps, state, writes, events };
};

const windowEntry = (state: AgentState): string =>
  (state.messages.at(-1) as { content: string }).content;

/** Tagged and non-repeating, so a slice of it can only match the place it came from. */
const body = (chars: number, tag: string): string => {
  let value = '';
  for (let index = 0; value.length < chars; index += 1) value += `${tag}-${index} `;
  return value.slice(0, chars);
};

describe('the fixed point that lets a marker say where the cut fell', () => {
  it('names the character the omitted span begins at, and it is exactly right', () => {
    const value = body(50_000, 'x');
    const cut = truncateMiddle(
      value,
      24_000,
      'tool output',
      (at) => `starts at ${at.character} on line ${at.line}`
    );
    const named = /starts at (\d+) on line (\d+)/.exec(cut);
    expect(named).not.toBeNull();
    const character = Number(named?.[1]);
    // The head the model is holding is the value up to exactly the character the marker names.
    expect(cut.startsWith(value.slice(0, character))).toBe(true);
    // And the head is where the marker starts, so nothing between them is unaccounted for.
    expect(cut.indexOf('\n[… ')).toBe(character);
  });

  it('counts lines in the value, not in the marker', () => {
    const value = `${'line\n'.repeat(20_000)}tail`;
    const cut = truncateMiddle(value, 24_000, 'tool output', (at) => `line ${at.line}`);
    const named = /line (\d+) …/.exec(cut);
    const line = Number(named?.[1]);
    const character = cut.indexOf('\n[… ');
    // Every newline before the cut and no newline after it.
    expect(line).toBe(value.slice(0, character).split('\n').length);
    expect(line).toBeGreaterThan(1);
  });

  it('leaves the string and the absent recovery byte-identical to what they always were', () => {
    // The regression this guards is the reason the fixed point is written as a separate branch:
    // every other caller of `truncateMiddle` passes a fixed sentence or nothing, and those two
    // paths must not have moved by a character - the cache and availability rigs are measured on
    // them.
    const value = body(50_000, 'y');
    expect(truncateMiddle(value, 24_000, 'tool output')).toBe(
      `${value.slice(0, 14_850)}\n[… 26000 characters omitted from tool output …]\n${value.slice(value.length - 9_101)}`
    );
    const fixed = truncateMiddle(value, 24_000, 'tool output', 'ask the owner');
    expect(fixed).toContain('; ask the owner …]');
    expect(fixed).toHaveLength(24_000);
  });

  it('drops a recovery the bound cannot afford, exactly as a fixed sentence is dropped', () => {
    // A route that squeezes tool arguments to 40 characters must not spend all forty on a sentence
    // about where the other characters went. @see the half-the-bound rule in `truncateMiddle`.
    const cut = truncateMiddle(
      body(4_000, 'z'),
      40,
      'earlier tool arguments',
      (at) => `a very long recovery sentence naming character ${at.character}`
    );
    expect(cut).not.toContain('recovery sentence');
    expect(cut).toContain('characters omitted from earlier tool arguments');
  });
});

describe('a 200 kB tool result, cut for the window and parked whole on the disk', () => {
  const shell = {
    id: 'call-1',
    name: 'shell',
    arguments: { executable: 'bash', args: ['-lc', 'pnpm test'] }
  } as unknown as ModelToolCall;
  const result = (chars = 200_000): Record<string, unknown> => ({
    exitCode: 0,
    stdout: body(chars, 'out'),
    stderr: ''
  });

  it('writes one file, names it by its own sha256, and points the model at it', async () => {
    const { deps, state, writes } = recording();
    const payload = result();
    const full = toolResultText(payload);
    await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, payload);

    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    expect(write.workspaceId).toBe('workspace-1');
    expect(write.taskId).toBe(task.id);
    expect(write.content).toBe(full);
    // The name is the hash of the bytes, so the notice and the file cannot disagree about which
    // result this is.
    expect(write.path).toBe(`${SPILL_DIRECTORY}/${sha256(full)}.txt`);
    expect(sha256(write.content)).toBe(write.path.split('/').pop()?.replace('.txt', ''));
    expect(windowEntry(state)).toContain(write.path);
  });

  it('names a character offset from which the omitted region is exactly recoverable', async () => {
    const { deps, state, writes } = recording();
    const payload = result();
    await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, payload);
    const window = windowEntry(state);
    const character = Number(/cut begins at character (\d+)/.exec(window)?.[1]);
    expect(Number.isFinite(character)).toBe(true);

    // The recovery performed, on the file that is actually there: the head the model is holding,
    // then `cut -c` from the named character, then the tail it is holding, is the whole result.
    const parked = writes[0]!.content;
    const head = window.slice(0, window.indexOf('\n[… '));
    const tail = window.slice(window.indexOf(' …]\n') + ' …]\n'.length);
    expect(parked.slice(0, character)).toBe(head);
    expect(parked.endsWith(tail)).toBe(true);
    const recovered = parked.slice(character, parked.length - tail.length);
    expect(head + recovered + tail).toBe(parked);
    expect(recovered.length).toBeGreaterThan(170_000);
  });

  it('teaches the cheaper call as well as naming the recovery', async () => {
    // #31: free, and it changes the next call rather than this one.
    const { deps, state } = recording();
    const window = windowEntry(
      (await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, result()), state)
    );
    expect(window).toContain('bound long output where it is made');
    expect(window).toContain('head, tail or grep');
  });

  it('writes the same bytes once however many times a poll loop reads them', async () => {
    const { deps, state, writes } = recording();
    for (let step = 0; step < 5; step += 1)
      await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, result());
    expect(writes).toHaveLength(1);
    // And every one of the five window entries still points at it.
    const pointing = (state.messages as Array<{ content: string }>).filter((message) =>
      message.content.includes(writes[0]!.path)
    );
    expect(pointing).toHaveLength(5);
  });

  it('leaves a result that fits the window alone', async () => {
    const { deps, state, writes } = recording();
    await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, result(1_000));
    expect(writes).toHaveLength(0);
    expect(windowEntry(state)).not.toContain('characters omitted');
  });
});

describe('what is claimed when the spill could not happen', () => {
  const shell = {
    id: 'call-1',
    name: 'shell',
    arguments: { executable: 'bash', args: ['-lc', 'pnpm test'] }
  } as unknown as ModelToolCall;
  const big = { exitCode: 0, stdout: body(200_000, 'out') };

  it('says nothing about a path when the runner refused the write', async () => {
    const { deps, state } = recording({ refuse: true });
    await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, big);
    const window = windowEntry(state);
    expect(window).toContain('characters omitted from tool output …]');
    expect(window).not.toContain(SPILL_DIRECTORY);
    expect(window).not.toContain('cut begins at character');
  });

  it('says nothing when no writer was registered, which is a delegated specialist', async () => {
    const { deps, state, writes } = recording({ register: false });
    await recordToolResult(deps, task, Buffer.from(dataKey), state, shell, big);
    expect(writes).toHaveLength(0);
    expect(windowEntry(state)).not.toContain(SPILL_DIRECTORY);
  });

  it('says nothing about a body past the ceiling', async () => {
    const { state, writes } = recording();
    const over = 'x'.repeat(MAX_SPILL_CHARS + 1);
    expect(await spillOverflow(task, state, over, false)).toBeNull();
    expect(writes).toHaveLength(0);
  });
});

describe('where a spilled result is parked, and why trust is the only thing that decides it', () => {
  const page = {
    id: 'call-2',
    name: 'parallel_web_read',
    arguments: { urls: ['https://vendor.test/pricing'] }
  } as unknown as ModelToolCall;

  it('parks a fetched page inside the download quarantine, so reading it back is still fenced', async () => {
    const { deps, state, writes } = recording();
    await recordToolResult(deps, task, Buffer.from(dataKey), state, page, {
      sources: [{ url: 'https://vendor.test/p', requestedUrl: 'https://vendor.test/p' }],
      text: body(200_000, 'page')
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path.startsWith(`${UNTRUSTED_SPILL_DIRECTORY}/`)).toBe(true);
    /*
     * The attack this closes. Park a hostile page on a clean path and the model's own `file_read`
     * of it comes back trusted: no fence, no sanitise pass, the injected sentence delivered in the
     * harness's own voice - which is exactly the hole wave 1 shut on the read path. The existing
     * quarantine list is what refuses it, so there is no second list to drift.
     */
    expect(isQuarantinedDownloadPath(writes[0]!.path)).toBe(true);
  });

  it('does not quarantine the owner’s own build log', async () => {
    const { deps, state, writes } = recording();
    await recordToolResult(
      deps,
      task,
      Buffer.from(dataKey),
      state,
      {
        id: 'call-3',
        name: 'file_read',
        arguments: { path: 'workspace/build.log' }
      } as unknown as ModelToolCall,
      { content: body(200_000, 'log') }
    );
    expect(writes[0]!.path.startsWith(`${SPILL_DIRECTORY}/`)).toBe(true);
    expect(isQuarantinedDownloadPath(writes[0]!.path)).toBe(false);
  });

  it('gives the same bytes two different addresses depending on where they came from', () => {
    const text = 'the same forty bytes, from two directions';
    expect(spillPathFor(text, true)).not.toBe(spillPathFor(text, false));
    expect(spillPathFor(text, true)).toContain(sha256(text));
    expect(spillPathFor(text, false)).toContain(sha256(text));
  });
});

describe('the window bound the spill hangs off', () => {
  it('is the same 24,000 characters it has always been', () => {
    // Exported for `recordToolResult` to ask "will this be cut at all" before serialising twice.
    // If it ever moves, the spill threshold moves with it rather than drifting away from it.
    expect(RECENT_TOOL_OUTPUT_CHARS).toBe(24_000);
  });
});
