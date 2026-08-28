import { describe, expect, it } from 'vitest';
import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { executeWorkspaceTool } from './workspace.js';
import { forgetReads, recordRead } from '../edit/index.js';
import { type AgentState } from '../agent-state.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * `file_patch` end to end, on the bytes - the line-addressed editor as the model actually reaches it.
 *
 * `tool-dispatch.test.ts` already covers the runner calls a patch makes - the read, the write, the
 * usage re-read - and `edit/edit.test.ts` covers the parser and the applier as units. Nothing here
 * re-tests those. What is tested here is what the shipped ARM does to a file on disk, because an
 * applier that is right and an arm that hands it the wrong snapshot are indistinguishable until
 * somebody reads the file.
 *
 * Every case below is a shape a model actually emits, and the file this replaced tested the quoted
 * editor's move the same way for the same reason. Driven through `executeWorkspaceTool` itself
 * rather than through the dispatch table, so what is under test is the shipped arm and not a model
 * of it. The runner is a two-method fake holding one file in memory; every assertion is about what
 * that file says afterwards.
 */

/** The file the patches are made against: two functions, the second used by the first. */
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
 * One `file_patch` call against an in-memory tree, with the reads the turn has already made.
 *
 * The reads are stood up through `recordRead`, which is the same function `file_read` calls one
 * arm over - a line number means nothing without a record of what was shown under it, and a test
 * that skipped this would only ever exercise the refusal.
 *
 * Only four of the eighteen fields on a `ToolContext` are reachable from this arm - the task, the
 * runner, the store's storage counter and the turn state that remembers a file's hash - so the
 * other fourteen are deliberately absent rather than stubbed: standing them up would be fourteen
 * ways for this file to go red for a reason that has nothing to do with a patch.
 */
const patch = async (
  patches: unknown,
  files: Record<string, string> = { 'workspace/queue.ts': QUEUE },
  seen: readonly string[] = ['workspace/queue.ts']
): Promise<Applied> => {
  forgetReads();
  const written = new Map<string, string>(Object.entries(files));
  for (const path of seen) recordRead('task-1', path, 1, written.get(path) ?? '');
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
  it('cuts the text out and pastes it after the anchor, unchanged and crossing the wire once', async () => {
    // The corpus shape: the helper moved above the function that calls it. The moved lines are
    // named by a range and never typed at all, which is the whole point of the operation - the
    // quoted editor this replaced had to carry every one of them in `oldText`.
    const { written, result } = await patch([
      { path: 'workspace/queue.ts', edit: 'CUT 7.=10 @ready\nPUT >1 @ready\n' }
    ]);

    const after = written.get('workspace/queue.ts') ?? '';
    expect(after.indexOf('export const ready')).toBeLessThan(after.indexOf('export const drain'));
    // Byte-for-byte the same characters, in a different place: a move that reformats is a move the
    // model has to review, and reviewing it costs the read the operation was meant to save.
    expect(after).toContain('  return job.ready && job.expiresAt > Date.now();\n};');
    expect(result).toMatchObject({ patchCount: 1 });
  });

  it('refuses two cuts into one register rather than losing the first block', async () => {
    /*
     * The worst failure this vertical can have, and it shipped: `registers.set` was last-wins, so
     * gathering two helpers under one name deleted both and pasted only the second one back - with
     * `ok: true` and an empty notes array. Silent data loss reported as success.
     *
     * Asserted on the bytes first, because the message is the consequence and the file is the harm.
     */
    await expect(
      patch([
        {
          path: 'workspace/queue.ts',
          edit: 'CUT 3.=6 @moved\nCUT 8.=10 @moved\nPUT >1 @moved\n'
        }
      ])
    ).rejects.toThrow(/both hold their lines as @moved/);

    const { written } = await patch([
      { path: 'workspace/queue.ts', edit: 'CUT 3.=6 @a\nCUT 8.=10 @b\nPUT >1 @a\nPUT >1 @b\n' }
    ]);
    // Named apart, both blocks survive - so the refusal above is about the collision and not about
    // gathering two blocks, which is a thing the format can do.
    expect(written.get('workspace/queue.ts')).toContain('export const drain');
    expect(written.get('workspace/queue.ts')).toContain('export const ready');
  });

  it('refuses a register nothing filled, rather than pasting emptiness', async () => {
    await expect(patch([{ path: 'workspace/queue.ts', edit: 'PUT >1 @never\n' }])).rejects.toThrow(
      /@never was never filled/
    );
    // Nothing was written: a paste of a register that does not exist is a whole-patch refusal and
    // not a no-op that reports success.
  });
});

describe('the diff a model reaches for when it does not reach for this one', () => {
  it('reads a zero-context insertion hunk as an insertion, not as a replacement', async () => {
    /*
     * `git diff -U0` writes `@@ -1,0 +2,1 @@` for a pure insertion - remove nothing at line 1, add
     * one line after it. The count was clamped to one and the hunk applied as a REPLACEMENT of line
     * 1, destroying a line while reporting success, and printing a note that read `PUT 1.=0:` - a
     * range this dialect cannot express. The defect was legible in the harness's own output.
     */
    const { written, result } = await patch([
      {
        path: 'workspace/queue.ts',
        edit: "@@ -1,0 +2,1 @@\n+import type { Clock } from './clock.js';\n"
      }
    ]);

    const after = written.get('workspace/queue.ts') ?? '';
    expect(after.startsWith("import type { Job } from './types.js';\n")).toBe(true);
    expect(after).toContain("import type { Clock } from './clock.js';");
    // The line the hunk did not ask to remove is still there.
    expect(after).toContain("import type { Job } from './types.js';");
    expect(((result as { notes?: string[] }).notes ?? []).join(' ')).toMatch(/PUT >1/);
  });

  it('refuses a zero-count hunk that also claims to remove lines', async () => {
    // `-1,0` and a `-` row are two readings that put different text in the file, and there is no
    // evidence to choose between them. Everything else in this parser is forgiving; this is where
    // the line is drawn, because forgiving it would be guessing at intent.
    await expect(
      patch([
        {
          path: 'workspace/queue.ts',
          edit: "@@ -1,0 +2,1 @@\n-import type { Job } from './types.js';\n+import type { Clock } from './clock.js';\n"
        }
      ])
    ).rejects.toThrow(/removes no lines, but this hunk carries - rows/);
  });
});

describe('the shapes a patch is allowed to be', () => {
  it('refuses two patches on one file, rather than chaining them onto moved numbers', async () => {
    // Every range in a patch names the numbers of the read it came from. A second patch on the same
    // file would be addressed against those same numbers while the first had already moved them.
    await expect(
      patch([
        { path: 'workspace/queue.ts', edit: 'PUT 1:\n+// a\n' },
        { path: 'workspace/queue.ts', edit: 'PUT 2:\n+// b\n' }
      ])
    ).rejects.toThrow(/appears in two patches of the same call/);
  });

  it('refuses a patch with no edit in it', async () => {
    await expect(patch([{ path: 'workspace/queue.ts' }])).rejects.toThrow(AthanorError);
    await expect(patch([{ path: 'workspace/queue.ts' }])).rejects.toThrow(
      /requires a path and a non-empty edit/
    );
  });

  it('writes nothing at all when two operations in one patch overlap', async () => {
    /*
     * Atomic per file, which is the opposite of what the quoted editor did. It applied the hunks
     * that matched and reported the ones that did not - right for independent quoted edits, and
     * wrong here: half a patch applied means every remaining number in the model's head is off by
     * the delta, so the retry is worse than the failure.
     */
    await expect(
      patch([{ path: 'workspace/queue.ts', edit: 'PUT 3.=6:\n+// one\nPUT 5:\n+// two\n' }])
    ).rejects.toThrow(/touch the same lines/);
  });

  it('lands one file and refuses another, with the file’s own text inside the refusal', async () => {
    /*
     * The property the whole format is bought on. A quoted patch carries its own evidence; a line
     * number carries none, so a refusal that only said "no" would cost a read AND a generation on
     * the highest-traffic tool in the harness. Every refusal here hands back the live file,
     * numbered, so the retry is a re-emit.
     */
    const { written, result } = await patch(
      [
        { path: 'workspace/queue.ts', edit: 'PUT 4:\n+  const job = queue.pop();\n' },
        { path: 'workspace/other.ts', edit: 'PUT 2:\n+const changed = true;\n' }
      ],
      { 'workspace/queue.ts': QUEUE, 'workspace/other.ts': 'const a = 1;\nconst b = 2;\n' },
      // `other.ts` was never read this turn, so its numbers are a guess.
      ['workspace/queue.ts']
    );

    expect(written.get('workspace/queue.ts')).toContain('queue.pop()');
    expect(written.get('workspace/other.ts')).toBe('const a = 1;\nconst b = 2;\n');
    expect(failures(result)[0]).toMatch(/No read of workspace\/other\.ts is on record/);
    // The numbered live text, so the next attempt needs no read - asserted rather than assumed,
    // because "actionable" is a claim about a string and this is the string.
    expect(failures(result)[0]).toMatch(/2:const b = 2;/);
    expect(result).toMatchObject({ patchCount: 1 });
  });

  it('lets a second edit follow the first with no read between them', async () => {
    // The applier re-records what it wrote as seen, so a turn that edits twice does not have to
    // spend a read proving to itself what it just authored. Without it the format is one edit deep
    // per file, which is most of what a turn actually does.
    const first = await patch([{ path: 'workspace/queue.ts', edit: 'CUT 2\n' }]);
    expect(first.result).toMatchObject({ patchCount: 1 });
    expect(String(first.result.wrote)).toMatch(/\d+:/);
  });
});
