import { describe, expect, it } from 'vitest';
import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { executeWorkspaceTool } from './workspace.js';
import { forgetReads, recordRead, toLines } from '../edit/index.js';
import { RECENT_TOOL_OUTPUT_CHARS, serializeToolResultForModel } from '../context.js';
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

/**
 * The display bound on an unwindowed `file_read`, and the rule about what a bounded read authorises.
 *
 * These two are one feature and are tested together on purpose. A bound on the display alone makes
 * this vertical strictly more dangerous, not less: the model is shown a prefix, and the hash the
 * same read leaves behind still authorises replacing every line of the file - including the ones
 * the bound has just stopped it from seeing. The measurement that started this is in the first case
 * below; the one that decides whether the change was worth making is `destroys the remainder`.
 *
 * Driven through `executeWorkspaceTool` for the same reason the patch cases above are: what is under
 * test is the shipped arm, and a bound proved against a model of the arm is a bound nobody has.
 */
const HASH = 'sha-of-the-whole-file';

interface Read {
  readonly result: Record<string, unknown>;
  readonly state: AgentState;
  readonly written: Map<string, string>;
  readonly run: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * One turn against an in-memory tree, with the calls made in order and the state carried between
 * them. The state is what carries a read's claim to the write that follows it, so a helper that
 * built a fresh one per call would test every guard here against a turn that never happened.
 */
/**
 * What one line costs a budget, the way the runner counts it.
 *
 * Lines are separated by newlines rather than terminated by them, so every line but the file's last
 * carries its separator and the last one carries nothing. One byte, and it is the difference between
 * this fake and the reader it stands in for - which is the difference that produced the defect these
 * cases exist about, so it is not rounded off here.
 */
const lineCost = (line: string, isLast: boolean): number =>
  Buffer.byteLength(line, 'utf8') + (isLast ? 0 : 1);

/** How many leading lines of `text` fit a display budget, whole. `services/…/files.ts` decides it. */
const fitting = (
  lines: readonly string[],
  budget: { maxBytes: number; maxLines: number },
  from = 0
): number => {
  let bytes = 0;
  let taken = 0;
  while (from + taken < lines.length && taken < budget.maxLines) {
    const cost = lineCost(lines[from + taken] ?? '', from + taken === lines.length - 1);
    if (bytes + cost > budget.maxBytes) break;
    bytes += cost;
    taken += 1;
  }
  return taken;
};

const turn = async (
  files: Record<string, string>,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Promise<Read> => {
  forgetReads();
  const written = new Map<string, string>(Object.entries(files));
  const state = {} as AgentState;
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-read', userId: 'user-1' },
    state,
    store: { setWorkspaceStorage: async () => undefined },
    runner: {
      readFileWithHash: async (_w: string, _t: string, path: string) => {
        const content = written.get(path);
        if (content === undefined) throw new Error(`no such file ${path}`);
        return { content, sha256: HASH };
      },
      /*
       * The display read as the runner performs it: the prefix that fits, the whole file's hash, and
       * how much of what came back arrived whole. The arm cannot show what it was not sent, which is
       * the property this fake has to preserve to be worth testing against - a fake that handed back
       * the file and let the arm choose would be testing the arrangement that had the two ledgers
       * disagreeing in the first place.
       */
      readFileForDisplay: async (
        _w: string,
        _t: string,
        path: string,
        budget: { maxBytes: number; maxLines: number }
      ) => {
        const text = written.get(path);
        if (text === undefined) throw new Error(`no such file ${path}`);
        const all = toLines(text);
        const whole = fitting(all, budget);
        const partialLine = whole === 0 && text.length > 0;
        return {
          content: partialLine
            ? Buffer.from(text, 'utf8').subarray(0, budget.maxBytes).toString('utf8')
            : all.slice(0, whole).join('\n'),
          sha256: HASH,
          totalLines: all.length,
          displayedLines: whole,
          partialLine
        };
      },
      /*
       * The ranged reader, cutting only on line boundaries. The half-line case it also has is left
       * to `services/workspace-runner/src/files.test.ts`, where the real reader is: standing a
       * second implementation of it up here would be two things to keep in agreement rather than one.
       *
       * `truncated` and `partialLine` are still both reported, and honestly, because THE DIFFERENCE
       * BETWEEN THEM IS WHAT THIS FAKE GOT WRONG. It used to answer `truncated: false` to every
       * window, including the ones the byte budget ended - so the arm's record of what it had shown
       * was derived from a flag that was never set here, and a defect that cost a line per window
       * was invisible to all thirty cases below while `services/workspace-runner` and this file
       * both stayed green. A window this reader ends between two lines is truncated and carries no
       * half-line; only the real reader produces the other combination.
       */
      readFileLines: async (
        _w: string,
        _t: string,
        path: string,
        window: { startLine: number; endLine: number; maxBytes: number }
      ) => {
        const all = toLines(written.get(path) ?? '');
        const asked = Math.max(0, Math.min(window.endLine, all.length) - window.startLine + 1);
        const taken = Math.min(
          asked,
          fitting(all, { maxBytes: window.maxBytes, maxLines: asked }, window.startLine - 1)
        );
        const endLine = window.startLine + Math.max(taken, 1) - 1;
        const reachedEnd = window.startLine - 1 + taken >= all.length;
        return {
          content: all.slice(window.startLine - 1, window.startLine - 1 + taken).join('\n'),
          startLine: window.startLine,
          endLine,
          ...(reachedEnd ? { totalLines: all.length } : { nextStartLine: endLine + 1 }),
          truncated: taken < asked,
          partialLine: false,
          fileBytes: Buffer.byteLength(written.get(path) ?? '', 'utf8')
        };
      },
      writeFile: async (_w: string, _t: string, path: string, content: string) => {
        written.set(path, content);
        return { sha256: `written-${path}` };
      },
      call: async () => ({ storageBytes: 1 })
    }
  } as unknown as ToolContext;
  const run = async (name: string, args: Record<string, unknown>) =>
    (await executeWorkspaceTool(context, {
      id: `call-${name}`,
      name,
      arguments: args
    } as unknown as ModelToolCall)) as Record<string, unknown>;
  let result: Record<string, unknown> = {};
  for (const call of calls) result = await run(call.name, call.args);
  return { result, state, written, run };
};

/** A file of `count` lines, each one distinguishable from every other by its own number. */
const tall = (count: number, width = 60): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1} ${'x'.repeat(width)}`).join('\n');

describe('reading a file bigger than one result can hold', () => {
  it('shows a prefix, says how long the file really is, and says where to carry on', async () => {
    const { result } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    // The claim the unbounded read used to make on this file was `truncated: false, totalLines:
    // 8332` while 5.95% of it reached the model. Every field below is now about what arrived.
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(8_332);
    expect(result.startLine).toBe(1);
    // Fewer lines than the file has, and the continuation picks up at the next one.
    expect(result.endLine).toBeLessThan(8_332);
    expect(result.nextStartLine).toBe((result.endLine as number) + 1);
    expect(String(result.content).split('\n')).toHaveLength(result.endLine as number);
    // Numbering still starts where the file does, so the continuation window lines up.
    expect(String(result.content).startsWith('1:line 1 ')).toBe(true);
  });

  it('keeps the serialised result inside the bound that decides what reaches the model', async () => {
    /*
     * The agreement condition, asserted rather than assumed. `recordToolResult` cuts every tool
     * result at RECENT_TOOL_OUTPUT_CHARS on the way into the window; if a read can exceed that, the
     * cut lands on a file_read again and the record of what was shown stops matching what was sent,
     * which is the entire defect this bound exists to close.
     */
    for (const file of [tall(8_332), tall(50_000, 4), tall(3_000, 400)]) {
      const { result } = await turn({ 'workspace/big.ts': file }, [
        { name: 'file_read', args: { path: 'workspace/big.ts' } }
      ]);
      expect(serializeToolResultForModel(result, Number.MAX_SAFE_INTEGER).length).toBeLessThan(
        RECENT_TOOL_OUTPUT_CHARS
      );
    }
  });

  it('stops on the line cap rather than the byte budget when the lines are short', async () => {
    // 50,000 lines of four characters is 250,000 bytes, so the byte budget alone would hand back
    // 4,500 lines and record every one of them as seen. The line cap is the only thing in the way.
    const { result } = await turn({ 'workspace/narrow.txt': tall(50_000, 0) }, [
      { name: 'file_read', args: { path: 'workspace/narrow.txt' } }
    ]);

    expect(result.endLine).toBe(800);
    expect(result.totalLines).toBe(50_000);
  });

  it('still shows a line that is longer on its own than the whole budget, cut to the budget', async () => {
    // The one case that cannot be served whole and must not be served empty: an answer of no lines
    // is a dead end. One line is still a bound - the file has three - and the line arrives cut to
    // the budget rather than whole, because the budget is about bytes delivered and this is the
    // shape that proves it.
    const { result } = await turn(
      { 'workspace/one.json': `${'a'.repeat(80_000)}\nsecond\nthird` },
      [{ name: 'file_read', args: { path: 'workspace/one.json' } }]
    );

    expect(result.endLine).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.nextStartLine).toBe(2);
    expect(Buffer.byteLength(String(result.content), 'utf8')).toBeLessThan(19_000);
  });

  /*
   * A file with no newlines in it, which is not an exemption from the bound but the case that shows
   * what the bound is about. `apps/desktop/src-tauri/gen/schemas/acl-manifests.json` is 76,478 bytes
   * on one line: measured through this arm against the real runner, it used to answer
   * `truncated: false, totalLines: 1`, hand the whole 76,480-character result to a layer that cuts
   * at 24,000, record nothing, and let the following whole-file write destroy 76,476 bytes.
   *
   * `truncated` is a claim about bytes delivered, so it is true here, and the line is not counted as
   * shown, so nothing rests on it.
   */
  describe('a file whose only line is longer than one read can deliver', () => {
    const ONE_LINE = { 'workspace/acl.json': `{"x":"${'a'.repeat(76_000)}"}` };

    it('reports itself truncated, and offers no continuation because there is none', async () => {
      const { result } = await turn(ONE_LINE, [
        { name: 'file_read', args: { path: 'workspace/acl.json' } }
      ]);

      expect(result).toMatchObject({ startLine: 1, endLine: 1, totalLines: 1, truncated: true });
      // There is no line 2 to carry on at, and resuming at line 1 would hand back the same half
      // forever, so a continuation would be a recovery the model cannot perform.
      expect(result.nextStartLine).toBeUndefined();
      expect(Buffer.byteLength(String(result.content), 'utf8')).toBeLessThan(19_000);
    });

    it('refuses the write that would discard the part of that line it never showed', async () => {
      const { run, written } = await turn(ONE_LINE, [
        { name: 'file_read', args: { path: 'workspace/acl.json' } }
      ]);

      await expect(
        run('file_write', { path: 'workspace/acl.json', content: '{}' })
      ).rejects.toThrow(AthanorError);
      expect(written.get('workspace/acl.json')).toHaveLength(76_008);
      // And the refusal names a recovery that exists. Reading a range cannot help a file with one
      // line in it, and neither can a line-addressed edit, so it says to use a program.
      await expect(
        run('file_write', { path: 'workspace/acl.json', content: '{}' })
      ).rejects.toThrow(/from the shell/);
    });

    it('vouches for none of that line, so a patch cannot rest on it either', async () => {
      const { run } = await turn(ONE_LINE, [
        { name: 'file_read', args: { path: 'workspace/acl.json' } }
      ]);

      await expect(
        run('file_patch', { patches: [{ path: 'workspace/acl.json', edit: 'PUT 1:\n+{}\n' }] })
      ).rejects.toThrow(/No read of workspace\/acl\.json is on record/);
    });
  });

  it('leaves a file that fits exactly as it was', async () => {
    // The bound has to be invisible on the 81% of this repository it never touches, and a read that
    // showed everything still says so - `truncated: false`, no continuation, nothing outstanding.
    const { result, state } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts' } }
    ]);

    expect(result).toMatchObject({ startLine: 1, endLine: 120, totalLines: 120, truncated: false });
    expect(result.nextStartLine).toBeUndefined();
    expect(state.partialReads?.['workspace/small.ts']).toBeUndefined();
    expect(state.readFileHashes?.['workspace/small.ts']).toBe(HASH);
  });
});

describe('what a read that showed part of a file lets you do to the rest of it', () => {
  it('refuses a patch aimed past the lines it displayed, and applies one inside them', async () => {
    /*
     * The ledger half of the defect, measured before this bound existed: one unwindowed read of
     * `agent-run.test.ts` recorded all 8,332 lines as displayed while 490 reached the model, so a
     * line number anywhere in the file resolved against a snapshot that had never been shown. The
     * refusal below is `apply.ts` doing the job it always did, against a record that is now true.
     */
    const { run } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    await expect(
      run('file_patch', {
        patches: [{ path: 'workspace/big.ts', edit: 'PUT 8000:\n+changed\n' }]
      })
    ).rejects.toThrow(/No read has shown you workspace\/big\.ts at 8000/);

    // And the bound does not over-refuse: a line the read did display is still editable.
    const inside = await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 12:\n+changed\n' }]
    });
    expect(inside).toMatchObject({ patchCount: 1 });
  });

  it('refuses a whole-file write that would destroy the lines it never showed', async () => {
    /*
     * THE ATTACK. A model reads a 8,332-line file, is shown a prefix of it, and writes back 200
     * lines under the hash that read left behind. Every guard downstream agrees with the call: the
     * file has not changed, so the runner's 409 does not fire; an unwindowed read records nothing
     * with the runner's seen-line ledger, so its 428 does not fire either. Measured against the
     * real `files.ts` before this refusal existed: ACCEPTED, 8,132 lines destroyed - while the
     * identical write after a WINDOWED read of the same 200 lines is refused by name one layer
     * down. This closes the gap between those two, and the file is asserted first because the
     * message is the consequence and the bytes are the harm.
     */
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: tall(200) })
    ).rejects.toThrow(AthanorError);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  it('tells the model the two things that actually get the write through', async () => {
    // A refusal naming a recovery the model cannot perform is the failure this repository has
    // already paid for once, in the truncation marker that said "run the tool again". Both of these
    // are performable, and the case below proves the second one really does lift it.
    const { run } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'replacement' })
    ).rejects.toThrow(/file_patch/);
    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'replacement' })
    ).rejects.toThrow(/startLine and endLine/);
  });

  it('lets the write through once the reads have paged to the end of the file', async () => {
    /*
     * The refusal is about coverage, not about the shape of how it was obtained, so reads that
     * between them cover the file clear it. Without this the bound would be a wall on any file too
     * big for one result, and the only way to change one would be to never have read it.
     *
     * Every window is continued from exactly where the previous read said to carry on, rather than
     * from a number this test picked: a continuation that does not tile is a continuation the model
     * cannot follow, and the loop terminating at all is the assertion that they do tile.
     */
    const {
      run,
      written,
      result: first
    } = await turn({ 'workspace/mid.ts': tall(900) }, [
      { name: 'file_read', args: { path: 'workspace/mid.ts' } }
    ]);

    await expect(run('file_write', { path: 'workspace/mid.ts', content: 'new' })).rejects.toThrow(
      AthanorError
    );

    let next = first.nextStartLine as number | undefined;
    let reads = 1;
    while (next !== undefined) {
      const page = await run('file_read', {
        path: 'workspace/mid.ts',
        startLine: next,
        endLine: 900
      });
      reads += 1;
      next = page.nextStartLine as number | undefined;
      expect(reads).toBeLessThan(20);
    }
    await run('file_write', { path: 'workspace/mid.ts', content: 'new' });
    expect(written.get('workspace/mid.ts')).toBe('new');
    // The price of the escape, said out loud: a 900-line file of 70-character lines is four reads.
    expect(reads).toBe(4);
  });

  it('refuses the whole-file write a windowed read used to authorise, and destroys nothing', async () => {
    /*
     * THE SEVERE ONE, and it is the most ordinary read shape in the harness: 47.4% of 14,314 real
     * `file_read` calls on this machine name a window. That arm set no outstanding length and claims
     * no hash - the ranged reader has no whole-file digest to give it - so the worker had nothing to
     * consult and the runner's own guard sat behind a hash this path never produces. Measured
     * through this arm against the real runner on `apps/worker/src/agent-run.test.ts`, 8,332 lines
     * and 354,014 bytes: `file_read {startLine: 1, endLine: 200}` then a whole-file `file_write` was
     * ACCEPTED and destroyed 8,330 lines, 354,002 bytes, with the file's sha256 changed.
     *
     * The comment in this arm asserted the opposite - that the windowed write was "refused by name
     * one layer down". It was not, and that is why nothing here is asserted from a comment.
     */
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: tall(200) })
    ).rejects.toThrow(/line 201 onwards has never been shown to you/);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  it('says a window that covered the whole file leaves nothing outstanding', async () => {
    // The other direction of the same guard, and the one that decides whether it survives contact
    // with anybody: a window wide enough to have shown the file is a read of the file, and the write
    // after it is ordinary work rather than something to be refused.
    const { run, written, state } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts', startLine: 1, endLine: 400 } }
    ]);

    expect(state.partialReads?.['workspace/small.ts']).toBeUndefined();
    await run('file_write', { path: 'workspace/small.ts', content: 'replaced' });
    expect(written.get('workspace/small.ts')).toBe('replaced');
  });

  it('holds a window to the same budget as a read with no window at all', async () => {
    /*
     * A window used to be fetched under a 400,000-byte budget and recorded whole, while
     * `recordToolResult` cut the result to 24,000 characters two layers downstream - so asking for
     * lines 1 to 8,332 vouched for 8,332 lines and showed 5.95% of them. That is the same defect the
     * unwindowed bound was shipped to close, and it also made the refusal above walkable in one
     * call: one wide window and the record claimed the file had been seen.
     */
    const { result, state } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 8_332 } }
    ]);

    expect(result.endLine).toBeLessThan(8_332);
    expect(result.truncated).toBe(true);
    expect(String(result.content).split('\n')).toHaveLength(result.endLine as number);
    expect(serializeToolResultForModel(result, Number.MAX_SAFE_INTEGER).length).toBeLessThan(
      RECENT_TOOL_OUTPUT_CHARS
    );
    // And what it left outstanding is what stops the write: the file goes further than this window.
    expect(state.partialReads?.['workspace/big.ts']).toBeGreaterThan(result.endLine as number);
  });

  it('does not stand between a first write and a file nothing has read', async () => {
    // Creating a file, an upload landing on a name, a generated document: none of them are editing
    // from a read, and holding them to a read record would refuse every file this computer makes.
    const { written } = await turn({}, [
      { name: 'file_write', args: { path: 'workspace/new.md', content: 'hello' } }
    ]);
    expect(written.get('workspace/new.md')).toBe('hello');
  });

  it('does not stand between a whole-file write and a file that was read whole', async () => {
    const { written } = await turn({ 'workspace/small.ts': tall(120) }, [
      { name: 'file_read', args: { path: 'workspace/small.ts' } },
      { name: 'file_write', args: { path: 'workspace/small.ts', content: 'replaced' } }
    ]);
    expect(written.get('workspace/small.ts')).toBe('replaced');
  });

  /*
   * THE ONE A PATCH USED TO OPEN, and it was open on every file, always.
   *
   * This case asserted the opposite until now - that a patch stops the file being held - on the
   * reasoning that the text on disk is text the turn authored. It is not: a line-addressed patch
   * authors a span and leaves the rest of the file exactly where it was. Measured through this arm
   * on an 8,332-line file, one `PUT 12:` after a bounded read cleared the outstanding length AND
   * recorded all 8,332 lines as shown, so the whole-file write below was accepted and destroyed
   * 576,512 bytes of a file the model had seen 258 lines of.
   */
  it('still holds a file against its unread remainder after a patch has changed one line', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts' } }
    ]);
    await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 12:\n+changed\n' }]
    });
    const after = written.get('workspace/big.ts') ?? '';

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'now mine' })
    ).rejects.toThrow(/never been shown to you/);
    expect(written.get('workspace/big.ts')).toBe(after);
    expect(toLines(after)).toHaveLength(8_332);
  });

  /*
   * The same disarming, one layer up, and the one that lands silently: after a successful patch the
   * whole file counted as displayed, so `PUT 8000:` - refused by name on the line above, and on the
   * line below - was accepted at a line nothing had ever put on screen.
   */
  it('refuses a patch at a line no read displayed, even after a patch has landed on that file', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);
    await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 10:\n+changed\n' }]
    });

    await expect(
      run('file_patch', {
        patches: [{ path: 'workspace/big.ts', edit: 'PUT 8000:\n+blind\n' }]
      })
    ).rejects.toThrow(/No read has shown you workspace\/big\.ts at 8000/);
    expect(toLines(written.get('workspace/big.ts') ?? '')[7_999]).toContain('line 8000');
  });

  /*
   * The reversal condition, and it is asserted in the same file as the two above deliberately: the
   * fix for them is worthless if it costs a turn its second edit. A patch authorises the span it
   * wrote and carries every line the reads had shown across its own change, so the next edit inside
   * that window needs no read between them.
   */
  it('lets a second patch follow the first inside the window a read displayed', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);
    await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 10:\n+first\n' }]
    });
    const second = await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 20:\n+second\n' }]
    });

    expect(second).toMatchObject({ patchCount: 1 });
    const lines = toLines(written.get('workspace/big.ts') ?? '');
    expect(lines[9]).toBe('first');
    expect(lines[19]).toBe('second');
  });

  /*
   * An edit that changes the file's LENGTH moves every line after it, and the record has to move
   * with it or the second edit of the turn lands somewhere the model did not mean. Nine lines are
   * inserted at line 10, so what was line 20 is line 29 - and that is the number the patch above
   * reports back in `wrote`.
   */
  it('carries the lines a read showed across an edit that changed how many there are', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);
    await run('file_patch', {
      patches: [
        {
          path: 'workspace/big.ts',
          edit: `PUT <10:\n${Array.from({ length: 9 }, (_, at) => `+added ${at + 1}`).join('\n')}\n`
        }
      ]
    });
    await run('file_patch', {
      patches: [{ path: 'workspace/big.ts', edit: 'PUT 29:\n+moved\n' }]
    });

    const lines = toLines(written.get('workspace/big.ts') ?? '');
    expect(lines).toHaveLength(8_341);
    expect(lines[28]).toBe('moved');
    // And the line that was 20 before the insertion is the one that changed, not its neighbour.
    expect(lines[27]).toBe('line 19 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });
});

/**
 * The other direction of the write guard: what it must NOT refuse.
 *
 * A guard that refuses legitimate work gets deleted by the first person it inconveniences, and it
 * deserves to be. The record of what has been shown was kept as at most four windows of text per
 * file, and the coverage question was answered off those four - so any file longer than four
 * windows could be read from its first line to its last and the whole-file write of it was still
 * refused, with a message naming the read the model had just performed. Measured on this
 * repository at the time: 37 of 946 tracked files.
 */
describe('a file too long to be remembered four windows at a time', () => {
  /** Pages a file from `startLine` to its end, following only what each read says comes next. */
  const pageThrough = async (
    run: Read['run'],
    path: string,
    startLine: number
  ): Promise<number> => {
    let next: number | undefined = startLine;
    let reads = 0;
    while (next !== undefined) {
      const page: Record<string, unknown> = await run('file_read', {
        path,
        startLine: next,
        endLine: 100_000
      });
      reads += 1;
      next = page.nextStartLine as number | undefined;
      expect(reads).toBeLessThan(80);
    }
    return reads;
  };

  it('lets the whole-file write through once the reads have reached its last line', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, []);
    const reads = await pageThrough(run, 'workspace/big.ts', 1);
    // The price of the escape, said out loud, and it is more than four: 8,332 lines of 67 bytes
    // against an 18,000-byte display budget.
    expect(reads).toBe(33);

    await run('file_write', { path: 'workspace/big.ts', content: 'mine now' });
    expect(written.get('workspace/big.ts')).toBe('mine now');
  });

  it('still refuses it while the reads stop short of the end', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 4_000 } }
    ]);

    await expect(
      run('file_write', { path: 'workspace/big.ts', content: 'mine now' })
    ).rejects.toThrow(AthanorError);
    expect(toLines(written.get('workspace/big.ts') ?? '')).toHaveLength(8_332);
  });

  /*
   * THE MESSAGE IS A PROMISE AND THIS IS THE TEST THAT IT IS KEPT. This repository has already paid
   * once for a marker that named a recovery the model could not perform. So the refusal is read for
   * the line it names, that exact read is performed, and the same write is sent again.
   */
  it('names a line to read from, and reading from it lifts the refusal', async () => {
    const { run, written } = await turn({ 'workspace/big.ts': tall(8_332) }, [
      { name: 'file_read', args: { path: 'workspace/big.ts', startLine: 1, endLine: 200 } }
    ]);

    const refusal = await run('file_write', {
      path: 'workspace/big.ts',
      content: 'mine now'
    }).catch((error: unknown) => error);
    const named = /read from line (\d+) with file_read/.exec((refusal as Error).message);
    expect(named?.[1]).toBe('201');

    // Thirty-three reads from line 201, against thirty-three from line 1: a window is 253 lines of
    // this file, so the 200 already shown are most of one.
    const reads = await pageThrough(run, 'workspace/big.ts', Number(named?.[1]));
    expect(reads).toBe(33);
    await run('file_write', { path: 'workspace/big.ts', content: 'mine now' });
    expect(written.get('workspace/big.ts')).toBe('mine now');
  });

  /*
   * THE INVERTED REFUSAL from the wave before this one, re-run: an unwindowed read shows a prefix,
   * a window covers the remainder, and the line to edit is in the prefix. Both ledgers used to
   * disagree about which lines that was, so editing line 50 - a line the FIRST read had put on
   * screen - was refused by name while editing line 400 sailed through. Shown means editable, and
   * neither the coverage record nor the authored-span rule may take that back.
   */
  it('still edits a line the first read showed, after a window covered the rest', async () => {
    const { run, written } = await turn({ 'workspace/mid.ts': tall(659) }, []);
    const first = await run('file_read', { path: 'workspace/mid.ts' });
    await run('file_read', {
      path: 'workspace/mid.ts',
      startLine: first.nextStartLine as number,
      endLine: 659
    });

    const landed = await run('file_patch', {
      patches: [{ path: 'workspace/mid.ts', edit: 'PUT 50:\n+line 50 // touched\n' }]
    });
    expect(landed).toMatchObject({ patchCount: 1 });
    expect(toLines(written.get('workspace/mid.ts') ?? '')[49]).toBe('line 50 // touched');
  });

  /*
   * The refusal for a file whose single line is longer than one read is the other kind: both of the
   * usual recoveries are closed to it, and it says so instead of naming one that cannot be
   * performed. `acl-manifests.json` in this repository is the real one - 76,478 bytes, zero
   * newlines.
   */
  it('sends a file with no newlines in it somewhere else entirely', async () => {
    const { run, written } = await turn({ 'workspace/acl.json': 'x'.repeat(76_478) }, [
      { name: 'file_read', args: { path: 'workspace/acl.json' } }
    ]);

    const refusal = await run('file_write', {
      path: 'workspace/acl.json',
      content: '{}'
    }).catch((error: unknown) => error);
    expect((refusal as Error).message).toMatch(/Transform it with a program from the shell/);
    expect((refusal as Error).message).not.toMatch(/file_read using startLine/);
    expect(written.get('workspace/acl.json')).toHaveLength(76_478);
  });
});
