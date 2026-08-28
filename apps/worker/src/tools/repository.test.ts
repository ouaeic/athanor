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
