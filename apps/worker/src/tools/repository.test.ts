import { describe, expect, it } from 'vitest';
import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { executeRepositoryTool, OVERVIEW_SYMBOL_BUDGET, spreadAcrossFiles } from './repository.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * What a code search comes back as, which is the tool's capability and not its garnish.
 *
 * `tool-dispatch.test.ts` already covers the arguments this arm sends to ripgrep - the flags, the
 * glob a model wrote as "none", the literal retry. Nothing here re-tests those. What is tested here
 * is the half that had no test at all: the shape of the answer, and the two thresholds that decide
 * which shape it is. Before this file, `code_search` had exactly one documented outcome - every
 * matching line, sliced to `maxResults` - and the case that mattered was the one nobody wrote a
 * fixture for: a real query against a real repository, which returns hundreds of lines the model
 * has to read to learn one path.
 *
 * The measured finding behind the change: an iterative search returning each match with its
 * surrounding context scored six points below one returning only `path (N matches)` and a total.
 * More context per hit, worse at choosing between hits.
 */

/**
 * A ripgrep line as `--line-number --column --no-heading` produces one.
 *
 * The default body is a whole line of real-width source rather than a token, because the byte case
 * below is measuring bytes: a fixture whose matched lines are seventeen characters long would prove
 * the collapse saves five times its own size when against actual source it saves fifteen.
 */
const line = (
  path: string,
  row: number,
  text = '  const handler = await registry.resolve(request.name, { fallback: defaultHandler });'
): string => `${path}:${row}:1:${text}`;

/**
 * Only two of the eighteen fields on a `ToolContext` are reachable from this arm: the task, for the
 * workspace and task ids the capability token is minted against, and the runner it calls through.
 * Standing up the other sixteen to prove a return shape would be sixteen ways for this file to go
 * red for a reason that has nothing to do with what it is asserting.
 */
const search = async (
  args: Record<string, unknown>,
  stdout: string,
  exitCode = 0
): Promise<Record<string, unknown>> => {
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-1' },
    runner: {
      call: async () => ({ exitCode, stdout, stderr: '', durationMs: 1, timedOut: false })
    }
  } as unknown as ToolContext;
  const call = { id: 'call-1', name: 'code_search', arguments: args } as unknown as ModelToolCall;
  return (await executeRepositoryTool(context, call)) as Record<string, unknown>;
};

/** `count` files, `each` matching lines apiece, in the layout a monorepo actually has. */
const spread = (count: number, each: number): string =>
  Array.from({ length: count }, (_, file) =>
    Array.from({ length: each }, (_, row) => line(`packages/p${file}/src/index.ts`, row + 1)).join(
      '\n'
    )
  ).join('\n');

describe('what a code search answers with', () => {
  it('returns the lines when the result is small enough to be read as lines', async () => {
    // The unchanged path, asserted here so the collapse below is visibly a threshold and not a
    // replacement. Three files and nine lines is a result a model can act on directly.
    const result = await search({ query: 'handler' }, spread(3, 3));

    expect(result.matches).toHaveLength(9);
    expect(result.totalReturned).toBe(9);
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty('summarised');
  });

  it('collapses a wide result to one row per file with its match count', async () => {
    // Thirty files, six matches each: 180 lines of source, which is what the model used to be sent
    // and read to learn thirty paths.
    const result = await search({ query: 'handler' }, spread(30, 6));

    expect(result.summarised).toBe(true);
    expect(result.totalFiles).toBe(30);
    expect(result.totalMatches).toBe(180);
    expect(result).not.toHaveProperty('matches');
    expect((result.files as { path: string; matches: number }[])[0]).toEqual({
      path: 'packages/p0/src/index.ts',
      matches: 6
    });
  });

  it('costs under two kilobytes where the lines it replaces cost twenty', async () => {
    // The number the whole item exists for. `RECENT_TOOL_OUTPUT_CHARS` is 24,000 and this result
    // is cache-resident for the rest of the turn, so the difference below is paid every step, not
    // once. Asserted against the serialised result rather than against a count of rows, because
    // bytes on the wire are the thing being bought.
    const stdout = spread(30, 6);
    const collapsed = Buffer.byteLength(JSON.stringify(await search({ query: 'handler' }, stdout)));
    const raw = Buffer.byteLength(stdout);

    expect(collapsed).toBeLessThan(2_000);
    // Past 24,000 the old shape was not merely large, it was cut - so the model paid for a full
    // truncated block and still did not hold every path that matched.
    expect(raw).toBeGreaterThan(20_000);
  });

  it('orders the rows by match count, so the first row is the file to open', async () => {
    // A decision surface that is not ordered by anything is a list, and the model reads it in the
    // order ripgrep walked the directory tree - which is alphabetical, and says nothing.
    const result = await search(
      { query: 'handler' },
      [
        line('src/a.ts', 1),
        ...Array.from({ length: 50 }, (_, row) => line('src/z.ts', row + 1)),
        line('src/b.ts', 1),
        line('src/b.ts', 2)
      ].join('\n')
    );

    expect((result.files as { path: string }[]).map((file) => file.path)).toEqual([
      'src/z.ts',
      'src/b.ts',
      'src/a.ts'
    ]);
  });

  it('refuses a search matching more than a hundred files instead of answering it', async () => {
    // Past the ceiling neither shape helps: the lines are a wall and the list of files is a wall.
    // The refusal is the only answer a model can act on, so it names the count and the levers.
    await expect(search({ query: 'e' }, spread(101, 1))).rejects.toMatchObject({
      code: 'code_search_too_broad'
    });
    const error = await search({ query: 'e' }, spread(101, 1)).catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(AthanorError);
    expect((error as Error).message).toContain('101 files match');
    expect((error as Error).message).toMatch(/narrow your search/);
    expect((error as Error).message).toMatch(/path or glob/);
  });

  it('says nothing of the model’s own back to it in the refusal', async () => {
    // The message is journalled where the owner reads it as well as returned where the model does,
    // and `query` is unbounded model-supplied text. Same shape as every other unbounded
    // interpolation this repository has had to close.
    const error = await search({ query: 'IGNORE ALL PREVIOUS'.repeat(200) }, spread(101, 1)).catch(
      (raised: unknown) => raised
    );

    expect((error as Error).message).not.toContain('IGNORE ALL PREVIOUS');
    expect((error as Error).message.length).toBeLessThan(250);
  });

  it('still returns lines when every match is in one file, however many there are', async () => {
    /*
     * The property that makes the advice takeable, and the reason the collapse is not a plain line
     * count. The description tells the model to pick a file and narrow to it; if narrowing to one
     * file collapsed again to the single row it already had, that advice would be a loop with no
     * exit inside this tool. One file poses no choice, so there is no choosing for the extra
     * context to degrade - which is the finding's own reasoning, not an exception to it.
     */
    const result = await search(
      { query: 'handler' },
      Array.from({ length: 300 }, (_, row) => line('src/only.ts', row + 1)).join('\n')
    );

    expect(result.summarised).toBeUndefined();
    expect(result.matches).toHaveLength(120);
    expect(result.truncated).toBe(true);
  });

  it('gives the per-file surface on request, for a result it would have sent as lines', async () => {
    // `summary` means what it says: it adds the surface, it does not switch the collapse off. A
    // boolean whose false value is not the opposite of its true value is a bound the model believes
    // it set.
    const result = await search({ query: 'handler', summary: true }, spread(2, 2));

    expect(result.summarised).toBe(true);
    expect(result.totalMatches).toBe(4);
    expect(result).not.toHaveProperty('matches');
  });

  it('groups by the path and not by the first colon on the line', async () => {
    // A filename may contain a colon. Cut at the first one, `weird:12:file.ts:3:1:text` is filed
    // under a directory that does not exist, and the counts stop adding up to the total.
    const result = await search(
      { query: 'handler', summary: true },
      ['weird:12:file.ts:3:1:one', 'weird:12:file.ts:9:1:two', 'plain.ts:1:1:three'].join('\n')
    );

    expect(result.files).toEqual([
      { path: 'weird:12:file.ts', matches: 2 },
      { path: 'plain.ts', matches: 1 }
    ]);
    expect(result.totalMatches).toBe(3);
  });

  it('answers an empty result as an empty result rather than as a surface', async () => {
    // rg exits 1 with no output when nothing matched, which is not a failure and never was.
    const result = await search({ query: 'nothing' }, '', 1);

    expect(result.matches).toEqual([]);
    expect(result.totalReturned).toBe(0);
    expect(result).not.toHaveProperty('summarised');
  });
});

/**
 * Which symbols an overview stands for, which was a race until it was not.
 *
 * `repo_overview` is the tool the catalogue tells the model to reach for first, and it was taking
 * the first three hundred lines ripgrep happened to emit. Measured on this repository: 300 of 5,799
 * symbols, covering 44 of 622 files, forty of them under `services/`, and a different forty-four on
 * each of three consecutive runs - while `IDEMPOTENT_WITHIN_TURN` named this tool a pure function of
 * the workspace. These are about the choice rather than the order, because ordering it alone moves
 * the failure rather than fixing it: sorted by path, a straight prefix of 300 is 300 files of
 * `apps/` and a codebase that appears to have no services in it at all.
 */
describe('what an overview stands for when it cannot show everything', () => {
  const corpus = (files: number, each: number): string[] =>
    Array.from({ length: files }, (_, file) =>
      Array.from(
        { length: each },
        (_, line) =>
          `${file < files / 2 ? 'apps' : 'services'}/mod${file}.ts:${line + 1}:${line === each - 1 ? 'export ' : ''}const s${line} = 1`
      )
    ).flat();

  const filesIn = (lines: readonly string[]): Set<string> =>
    new Set(lines.map((line) => /^(.*?):\d+:/.exec(line)?.[1] ?? line));

  it('spends a budget smaller than the repository across all of it, not down the front of it', () => {
    const shown = spreadAcrossFiles(corpus(600, 9), 300);
    expect(shown).toHaveLength(300);
    expect(filesIn(shown).size).toBe(300);
    const services = [...filesIn(shown)].filter((file) => file?.startsWith('services/')).length;
    // Half the files are under services/, so about half the sample should be, and a prefix would
    // have given none of them.
    expect(services).toBeGreaterThan(120);
  });

  it('gives every file a symbol before it gives any file a second', () => {
    const shown = spreadAcrossFiles(corpus(40, 5), 60);
    expect(filesIn(shown).size).toBe(40);
  });

  it('answers the same twice, which is what the tool was already claimed to do', () => {
    const lines = corpus(600, 9);
    expect(spreadAcrossFiles(lines, 300)).toEqual(spreadAcrossFiles(lines, 300));
  });

  it('shows the exported name when a file can only be represented by one of its symbols', () => {
    const shown = spreadAcrossFiles(corpus(600, 9), 300);
    expect(shown.every((line) => line.includes('export '))).toBe(true);
  });

  it('keeps a repository smaller than the budget whole', () => {
    const lines = corpus(10, 4);
    expect(spreadAcrossFiles(lines, OVERVIEW_SYMBOL_BUDGET)).toHaveLength(lines.length);
  });

  it('has nothing to say about an empty repository rather than something wrong', () => {
    expect(spreadAcrossFiles([], 300)).toEqual([]);
  });
});

/**
 * Whether the answer is a function of the workspace, which is what the harness already claims.
 *
 * `IDEMPOTENT_WITHIN_TURN` holds `code_search` and `repo_overview` and refuses to run either of
 * them twice with the same arguments inside one turn, on the grounds that the second call is
 * byte-identically uninformative. Measured against this repository before the flags below, over
 * twenty consecutive runs of each command, on ripgrep 15.2.0 and again on 13.0.0:
 *
 *   git status --short --branch        20/20 agreed     1 distinct order
 *   git ls-files                       20/20 agreed     1 distinct order
 *   rg symbol sweep                     1/20 agreed    20 distinct orders
 *   rg --files                          1/20 agreed    20 distinct orders
 *   rg --files --glob AGENTS.md …       1/20 agreed    20 distinct orders
 *   rg code_search 'clampNumber'        1/20 agreed     8 distinct orders (20 on 13.0.0)
 *
 * The tests below are not a second copy of those numbers. They pin the flags that produce them, in
 * the only way a flag can be pinned: with a runner that behaves the way the real one does. A stub
 * that hands back a fixed string proves the tool can parse a string - it cannot go red when the
 * flag that settled the string is deleted, and that is the defect this file exists to close.
 */

/** The path a ripgrep line belongs to, as ripgrep's own per-file blocks are divided. */
const pathOf = (one: string): string => /^(.*?):\d+:/.exec(one)?.[1] ?? one;

/** A corpus held the way ripgrep holds it while it searches: one block of lines per file. */
const perFileBlocks = (lines: readonly string[]): string[][] => {
  const byFile = new Map<string, string[]>();
  for (const one of lines) {
    const held = byFile.get(pathOf(one));
    if (held) held.push(one);
    else byFile.set(pathOf(one), [one]);
  }
  return [...byFile.values()];
};

/**
 * The runner's own output cap, reproduced from `boundedCollector` in the workspace runner.
 *
 * It keeps the leading 62% and the trailing 38% of a command's bytes and drops the middle, which is
 * why a sort in the worker cannot repair a large search: the lines are gone before this process
 * sees any of them. Reproduced rather than imported because the worker does not depend on the
 * runner package, and a copy that drifts is caught by the byte figures in DETERMINISM.md.
 */
const cappedLikeTheRunner = (text: string, cap: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= cap) return text;
  const head = bytes.subarray(0, Math.floor(cap * 0.62));
  const tail = bytes.subarray(bytes.length - (cap - head.length));
  const omitted = bytes.length - head.length - tail.length;
  return `${head.toString('utf8')}\n[… ${omitted} bytes omitted from stdout; beginning and end preserved …]\n${tail.toString('utf8')}`;
};

/**
 * A runner that emits the way ripgrep emits: per-file blocks, in path order when it was asked for
 * one and in a different order on every call when it was not.
 *
 * The unsorted branch rotates the blocks by the call number rather than shuffling them randomly,
 * so a red run names the same rows twice and this file has no seed to carry. It is the same
 * property the machine shows - the first call and the second disagree - reached deterministically.
 */
const ripgrepLike = (corpus: readonly string[], cap = Number.POSITIVE_INFINITY) => {
  const blocks = perFileBlocks(corpus);
  let call = 0;
  return (args: readonly string[]): string => {
    call += 1;
    const settled = args.join(' ').includes('--sort path');
    /*
     * Bytewise, which is what ripgrep does and what `localeCompare` does not: `rg --files --sort
     * path` on this repository answers AGENTS.md, CONTRIBUTING.md, README.md, apps/…, because 'R'
     * is 0x52 and 'a' is 0x61. A stub that ordered these the way a phone book would would have
     * been asserting a sequence the real command never produces.
     */
    const emitted = settled
      ? [...blocks].sort((left, right) => (pathOf(left[0] ?? '') < pathOf(right[0] ?? '') ? -1 : 1))
      : blocks.length === 0
        ? blocks
        : [...blocks.slice(call % blocks.length), ...blocks.slice(0, call % blocks.length)];
    return cappedLikeTheRunner(emitted.flat().join('\n'), cap);
  };
};

/** The same call twice against the same workspace, which is what the answers have to agree about. */
const twice = async (
  name: string,
  args: Record<string, unknown>,
  emit: (executable: string, args: readonly string[]) => string
): Promise<[unknown, unknown]> => {
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-1' },
    runner: {
      call: async (
        _workspaceId: string,
        _taskId: string,
        _scopes: unknown,
        _url: string,
        body: { executable: string; args: readonly string[] }
      ) => {
        const stdout = emit(body.executable, body.args);
        return { exitCode: stdout ? 0 : 1, stdout, stderr: '', durationMs: 1, timedOut: false };
      }
    }
  } as unknown as ToolContext;
  const call = { id: 'call-1', name, arguments: args } as unknown as ModelToolCall;
  return [await executeRepositoryTool(context, call), await executeRepositoryTool(context, call)];
};

describe('a repository read answering the same thing twice', () => {
  const corpus = (files: number, each: number): string[] =>
    Array.from({ length: files }, (_, file) =>
      Array.from({ length: each }, (_, row) =>
        line(`packages/p${String(file).padStart(3, '0')}/src/index.ts`, row + 1)
      )
    ).flat();

  it('gives back the same lines when the result is small enough to survive as lines', async () => {
    // 35 lines across 7 files: under the collapse threshold and past the one-file exemption, which
    // is the branch that was named as still holding the property after the overview was fixed.
    const emit = ripgrepLike(corpus(7, 5));
    const [first, second] = await twice('code_search', { query: 'handler' }, (_, args) =>
      emit(args)
    );

    expect((first as { matches: string[] }).matches).toHaveLength(35);
    expect(first).toEqual(second);
  });

  it('gives back the same lines under a cap the model set below the match count', async () => {
    // The slice that makes the order load-bearing inside this process. Ten of thirty-five lines
    // kept: which ten was decided by whichever of ripgrep's threads finished first.
    const emit = ripgrepLike(corpus(7, 5));
    const [first, second] = await twice(
      'code_search',
      { query: 'handler', maxResults: 10 },
      (_, args) => emit(args)
    );

    expect((first as { matches: string[] }).matches).toHaveLength(10);
    expect((first as { matches: string[] }).matches.map(pathOf)).toEqual([
      'packages/p000/src/index.ts',
      'packages/p000/src/index.ts',
      'packages/p000/src/index.ts',
      'packages/p000/src/index.ts',
      'packages/p000/src/index.ts',
      'packages/p001/src/index.ts',
      'packages/p001/src/index.ts',
      'packages/p001/src/index.ts',
      'packages/p001/src/index.ts',
      'packages/p001/src/index.ts'
    ]);
    expect(first).toEqual(second);
  });

  it('counts the same matches when the runner threw the middle of them away', async () => {
    /*
     * The case a sort in this process could not have fixed, and the reason the flag is on the
     * command rather than on the array it returns. A `code_search` for `const` against this
     * repository emits 2.6 MB and the runner's default cap is 1 MiB; simulating that cap over
     * twelve unsorted runs gave twelve different surviving sets, 9,637 to 11,108 lines of 25,770,
     * with 3,702 lines in the first run absent from the second. Here the cap is 8,192 - twice the
     * runner's own schema minimum for `maxOutputBytes` - against about 28 KB of matches, which is
     * the ratio that leaves more than `CODE_SEARCH_COLLAPSE_LINES` alive so the collapsed shape is
     * the one being compared. At the schema minimum itself the survivors fall under the threshold
     * and the tool answers in lines, which is the case the two tests above already hold.
     */
    const lines = corpus(30, 8);
    expect(Buffer.byteLength(lines.join('\n'))).toBeGreaterThan(8_192 * 3);
    const emit = ripgrepLike(lines, 8_192);
    const [first, second] = await twice('code_search', { query: 'handler' }, (_, args) =>
      emit(args)
    );

    expect((first as { summarised: boolean }).summarised).toBe(true);
    expect((first as { totalMatches: number }).totalMatches).toBeLessThan(lines.length);
    expect(first).toEqual(second);
  });

  it('still answers the searches it is for, rather than buying agreement with a refusal', async () => {
    // The other direction. A bound that is only ever checked by breaking it can be a bound that
    // refuses everything, so: the narrow search returns its lines, the wide one collapses with
    // every file counted, and the one past the ceiling is still the refusal it was.
    const narrow = ripgrepLike(corpus(1, 4));
    const [lines] = await twice('code_search', { query: 'handler' }, (_, args) => narrow(args));
    expect((lines as { matches: string[] }).matches).toHaveLength(4);

    const wide = ripgrepLike(corpus(30, 6));
    const [collapsed] = await twice('code_search', { query: 'handler' }, (_, args) => wide(args));
    expect(collapsed).toMatchObject({ summarised: true, totalFiles: 30, totalMatches: 180 });

    const broad = ripgrepLike(corpus(101, 1));
    await expect(
      twice('code_search', { query: 'handler' }, (_, args) => broad(args))
    ).rejects.toMatchObject({ code: 'code_search_too_broad' });
  });

  it('stands for the same files in an overview of a tree that has no working copy', async () => {
    /*
     * The untracked branch. `git ls-files` returns nothing for a downloaded folder or a checkout
     * whose `.git` the agent has not made yet, and the `rg --files` that answers instead was being
     * cut to `maxFiles` in walk order - 400 of 1,071 paths on this repository, agreeing with the
     * previous run 1 time in 20.
     */
    const files = Array.from(
      { length: 900 },
      (_, index) => `pkg${String(index).padStart(3, '0')}.ts`
    );
    const emit = ripgrepLike(files.map((path) => `${path}:1:export const one = 1`));
    const [first, second] = await twice('repo_overview', { maxFiles: 100 }, (executable, args) => {
      if (executable === 'git') return args[0] === 'status' ? '## main' : '';
      if (args.includes('--files')) return emit(args).split('\n').map(pathOf).join('\n');
      return emit(args);
    });

    expect((first as { fileCount: number }).fileCount).toBe(900);
    expect((first as { files: string[] }).files).toHaveLength(100);
    expect((first as { filesTruncated: boolean }).filesTruncated).toBe(true);
    expect(first).toEqual(second);
  });

  it('names the same instruction files, which nothing cuts and which still moved every run', async () => {
    // Nothing truncates this list, so no file is lost to the order - but `repo_overview` is
    // cache-resident for the rest of the turn, and twelve paths that arrive in a different order
    // each time move that block on every read of a result the harness calls a pure function.
    const instructions = ['README.md', 'apps/web/README.md', 'AGENTS.md', 'docs/CONTRIBUTING.md'];
    const emit = ripgrepLike(instructions.map((path) => `${path}:1:x`));
    const [first, second] = await twice('repo_overview', {}, (executable, args) => {
      if (executable === 'git') return args[0] === 'status' ? '## main' : 'a.ts';
      if (args.includes('--files')) return emit(args).split('\n').map(pathOf).join('\n');
      return 'a.ts:1:export const one = 1';
    });

    expect((first as { instructionFiles: string[] }).instructionFiles).toEqual([
      'AGENTS.md',
      'README.md',
      'apps/web/README.md',
      'docs/CONTRIBUTING.md'
    ]);
    expect(first).toEqual(second);
  });

  it('stands for the same symbols in an overview larger than the budget', async () => {
    // The overview race that was fixed an hour before this file was written, pinned here by the
    // answer rather than by the spelling of the flag: 300 symbols kept out of 4,000.
    const emit = ripgrepLike(corpus(500, 8));
    const [first, second] = await twice('repo_overview', {}, (executable, args) => {
      if (executable === 'git') return args[0] === 'status' ? '## main' : 'a.ts';
      if (args.includes('--files')) return 'README.md';
      return emit(args);
    });

    expect((first as { importantSymbols: string[] }).importantSymbols).toHaveLength(
      OVERVIEW_SYMBOL_BUDGET
    );
    expect((first as { filesRepresented: number }).filesRepresented).toBe(OVERVIEW_SYMBOL_BUDGET);
    expect(first).toEqual(second);
  });
});
