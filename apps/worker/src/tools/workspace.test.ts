import { describe, expect, it } from 'vitest';
import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { executeWorkspaceTool } from './workspace.js';
import { type AgentState } from '../agent-state.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The move operation on `file_patch`, which is the one patch shape that does not carry its result.
 *
 * `tool-dispatch.test.ts` already covers the runner calls a patch makes - the read, the write, the
 * usage re-read - and the batch semantics that let four hunks land while a fifth is refused.
 * Nothing here re-tests those. What is tested here is what the move actually does to the bytes on
 * disk, and the three ways it is allowed to refuse, because a move that lands in the wrong place is
 * indistinguishable from a move that worked until somebody reads the file.
 *
 * Driven through `executeWorkspaceTool` itself rather than through the dispatch table, so what is
 * under test is the shipped arm and not a model of it. The runner is a two-method fake holding one
 * file in memory; every assertion below is about what that file says afterwards.
 */

/** The file the moves are made against: two functions, the second used by the first. */
const QUEUE = `import type { Job } from './types.js';

export const drain = (queue: Job[]): Job | null => {
  const job = queue.shift();
  return job && ready(job) ? job : null;
};

export const ready = (job: Job): boolean => {
  return job.ready && job.expiresAt > Date.now();
};
`;

interface Applied {
  readonly written: Map<string, string>;
  readonly result: Record<string, unknown>;
}

/**
 * One `file_patch` call against an in-memory tree.
 *
 * Only four of the eighteen fields on a `ToolContext` are reachable from this arm - the task, the
 * runner, the store's storage counter and the turn state that remembers a file's hash - so the
 * other fourteen are deliberately absent rather than stubbed: standing them up would be fourteen
 * ways for this file to go red for a reason that has nothing to do with a move.
 */
const patch = async (
  patches: unknown,
  files: Record<string, string> = { 'workspace/queue.ts': QUEUE }
): Promise<Applied> => {
  const written = new Map<string, string>(Object.entries(files));
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-1', userId: 'user-1' },
    state: {} as AgentState,
    store: { setWorkspaceStorage: async () => undefined },
    runner: {
      readFileWithHash: async (_workspace: string, _task: string, path: string) => {
        const content = written.get(path);
        if (content === undefined) throw new Error(`no such file ${path}`);
        return { content, sha256: `sha-${path}` };
      },
      writeFile: async (_workspace: string, _task: string, path: string, content: string) => {
        written.set(path, content);
        return { sha256: `written-${path}` };
      },
      call: async () => ({ storageBytes: 1 })
    }
  } as unknown as ToolContext;
  const call = {
    id: 'call-1',
    name: 'file_patch',
    arguments: { patches }
  } as unknown as ModelToolCall;
  const result = (await executeWorkspaceTool(context, call)) as Record<string, unknown>;
  return { written, result };
};

const failures = (result: Record<string, unknown>): string[] =>
  ((result.failed ?? []) as Array<{ reason: string }>).map((failure) => failure.reason);

describe('moving a block instead of retyping it', () => {
  it('cuts the text out and pastes it directly after the anchor, unchanged', async () => {
    // The corpus shape: the helper moved above the function that calls it. The moved lines are
    // emitted once, as oldText, and never again - which is the whole point of the operation.
    const moved = `export const ready = (job: Job): boolean => {
  return job.ready && job.expiresAt > Date.now();
};
`;
    const { written, result } = await patch([
      {
        path: 'workspace/queue.ts',
        oldText: `\n${moved}`,
        moveAfter: "import type { Job } from './types.js';\n"
      }
    ]);

    expect(written.get('workspace/queue.ts')).toBe(`import type { Job } from './types.js';

export const ready = (job: Job): boolean => {
  return job.ready && job.expiresAt > Date.now();
};

export const drain = (queue: Job[]): Job | null => {
  const job = queue.shift();
  return job && ready(job) ? job : null;
};
`);
    // Byte-for-byte the same characters, in a different place: a move that reformats is a move the
    // model has to review, and reviewing it costs the read the operation was meant to save.
    expect(written.get('workspace/queue.ts')).toContain(moved);
    expect(result).toMatchObject({ patchCount: 1 });
  });

  it('moves to the top of the file on an empty anchor, which nothing else can express', async () => {
    // There is no quotable text before line one, so the empty string is a real destination rather
    // than an absent argument. This is the case that decides `moving` on presence, not emptiness.
    const { written } = await patch([
      {
        path: 'workspace/queue.ts',
        oldText: 'export const ready = (job: Job): boolean => {\n',
        moveAfter: ''
      }
    ]);

    expect(written.get('workspace/queue.ts')?.startsWith('export const ready')).toBe(true);
  });

  it('refuses an anchor inside the block it is moving, rather than pasting into the hole', async () => {
    // The failure the "count the anchor in the text with the block already cut out" rule exists
    // for. Against the original text this anchor is unique and the paste target is inside the
    // region about to disappear; against the cut text it is simply not there.
    const { written, result } = await patch([
      {
        path: 'workspace/queue.ts',
        oldText: `export const ready = (job: Job): boolean => {
  return job.ready && job.expiresAt > Date.now();
};
`,
        moveAfter: '  return job.ready && job.expiresAt > Date.now();\n'
      },
      // A second patch that does land, so the refusal above is visibly a per-patch refusal and not
      // the whole call throwing.
      {
        path: 'workspace/queue.ts',
        oldText: 'const job = queue.shift();',
        newText: 'const job = queue.pop();'
      }
    ]);

    // Asserted first because it is the consequence and not the message. Count the anchor against
    // the text before the cut and this guard passes, the paste is a `String.replace` that finds
    // nothing, and the block is deleted - with `patchCount: 1` and no failure reported.
    expect(written.get('workspace/queue.ts')).toContain('export const ready');
    expect(failures(result)[0]).toMatch(/moveAfter is not in workspace\/queue\.ts once oldText/);
    expect(failures(result)[0]).toMatch(/inside the block being moved/);
    expect(result).toMatchObject({ patchCount: 1 });
    expect(written.get('workspace/queue.ts')).toContain('queue.pop()');
  });

  it('refuses an ambiguous anchor and says how many places it matched', async () => {
    // A call whose every patch failed still throws rather than reporting an empty success, so the
    // reason is read off the thrown conflict here and off `failed` in the mixed case above.
    await expect(
      patch([
        {
          path: 'workspace/queue.ts',
          oldText: "import type { Job } from './types.js';\n",
          moveAfter: '};\n'
        }
      ])
    ).rejects.toThrow(/moveAfter appears 2 times in workspace\/queue\.ts.*Extend moveAfter/);
  });

  it('still refuses on oldText, with the explanation a replacement gets', async () => {
    // The move does not get its own uniqueness rule. `oldText` is the evidence for both shapes and
    // fails closed the same way, which is what makes this an operation rather than a format.
    await expect(
      patch([{ path: 'workspace/queue.ts', oldText: '};\n', moveAfter: '' }])
    ).rejects.toThrow(/oldText appears 2 times/);
  });
});

describe('the shapes a patch is allowed to be', () => {
  it('refuses a patch carrying both a replacement and a move', async () => {
    // Two edits wearing one patch: which of them the file ends up with would be decided by the
    // order of two lines in this arm, and no answer to that is the one the model meant.
    await expect(
      patch([
        { path: 'workspace/queue.ts', oldText: 'const job', newText: 'let job', moveAfter: '' }
      ])
    ).rejects.toThrow(/never both/);
  });

  it('refuses a patch that names neither, rather than deleting the text', async () => {
    /*
     * The regression `newText` leaving the required set would otherwise have shipped.
     *
     * Before the move shape the schema demanded `newText`, so its absence was a malformed call.
     * With it optional, `textValue` turns the missing field into `''` and the replacement empties
     * the region - so a move whose `moveAfter` did not survive generation would silently destroy
     * the block it was trying to keep, report `patchCount: 1`, and look like a success.
     */
    const { written } = await patch([
      { path: 'workspace/queue.ts', oldText: 'export const ready', newText: '' }
    ]);
    // An explicit empty newText still deletes, which is the spelling the refusal names.
    expect(written.get('workspace/queue.ts')).not.toContain('export const ready');

    await expect(
      patch([{ path: 'workspace/queue.ts', oldText: 'export const ready' }])
    ).rejects.toThrow(AthanorError);
    await expect(
      patch([{ path: 'workspace/queue.ts', oldText: 'export const ready' }])
    ).rejects.toThrow(/empty newText to delete it, or moveAfter to move it/);
  });

  it('lets a move and a replacement in one call see each other, in order', async () => {
    // Both shapes compose through the same `latestByPath`, so the second patch is matched against
    // what the first one left behind. A move that only worked as the sole patch in a call would be
    // a move the model has to spend a whole extra call on.
    const { written, result } = await patch([
      {
        path: 'workspace/queue.ts',
        oldText: `\nexport const ready = (job: Job): boolean => {
  return job.ready && job.expiresAt > Date.now();
};
`,
        moveAfter: "import type { Job } from './types.js';\n"
      },
      {
        path: 'workspace/queue.ts',
        oldText: 'job.ready && job.expiresAt > Date.now()',
        newText: 'job.ready && !job.cancelled'
      }
    ]);

    expect(result).toMatchObject({
      patchCount: 2,
      filesChanged: [{ path: 'workspace/queue.ts', replacements: 2 }]
    });
    const after = written.get('workspace/queue.ts') ?? '';
    expect(after.indexOf('export const ready')).toBeLessThan(after.indexOf('export const drain'));
    expect(after).toContain('!job.cancelled');
  });
});
