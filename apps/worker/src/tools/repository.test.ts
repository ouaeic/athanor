import { describe, expect, it } from 'vitest';
import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import {
  executeRepositoryTool,
  IMPORT_SWEEP_PATTERN,
  OVERVIEW_RANKED_PER_FILE,
  OVERVIEW_SYMBOL_BUDGET,
  rankByReference,
  spreadAcrossFiles,
  strideAcross
} from './repository.js';
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
 * Which symbols an overview leads with, which the proportional sample does not decide.
 *
 * Striding settled where the budget is spent; it did not settle what it is spent on. Measured on
 * this repository, the shipped sample opens with `SAFARI_MACOS`, `productionEnvironment`,
 * `nginxConf` and `MODEL_ID` - four fixtures out of four - and spends 103 of its 300 rows on test
 * files, 116 on names nothing outside their own file can reach, and 47 of its 197 measurable rows
 * on names referenced from nowhere else at all. Counting how often the repository imports a name
 * puts `AthanorError`, `DataStore`, `TaskRecord` and `AgentState` in those first four places and
 * takes the test-file rows to 53 and the unreachable ones to 59.
 *
 * The graph was measured and declined. Against a held-out half of this corpus that the ranking
 * never saw, as mean references per measurable row over four splits: the shipped proportional
 * sample 1.84, aider's PageRank over the file reference graph 2.14, distinct importers per
 * resolved declaration 2.25, and counting the name in import statements with no graph at all 3.25.
 */
describe('which symbols an overview leads with', () => {
  /** A symbol sweep line, as the overview's own ripgrep pattern produces one. */
  const declares = (path: string, row: number, name: string, exported = true): string =>
    `${path}:${row}:${exported ? 'export ' : ''}const ${name} = 1;`;

  /** An import statement, as `rg --multiline --no-filename --no-line-number` returns one. */
  const importsFrom = (names: readonly string[], specifier: string): string =>
    `import { ${names.join(', ')} } from '${specifier}';`;

  /** A tree wide enough that the budget has to choose, with the interesting file sorting last. */
  const wideTree = (): string[] => [
    ...Array.from({ length: 400 }, (_, index) =>
      declares(`apps/a${String(index).padStart(3, '0')}.ts`, 1, `local${index}`)
    ),
    declares('services/relay/protocol.ts', 12, 'AthanorError')
  ];

  it('leads with the name the repository imports most, not with the file that sorts first', () => {
    const lines = wideTree();
    const sweep = Array.from({ length: 50 }, () => importsFrom(['AthanorError'], './x.js')).join(
      '\n'
    );

    // The shipped sample opens at the front of the tree and cannot do otherwise: in path order
    // `apps/a000.ts` is first, and nothing in a stride knows that the last file is the one that
    // 50 others depend on.
    expect(spreadAcrossFiles(lines, 300)[0]).toBe(declares('apps/a000.ts', 1, 'local0'));
    expect(rankByReference(lines, sweep, 300)[0]).toBe(
      declares('services/relay/protocol.ts', 12, 'AthanorError')
    );
  });

  it('orders the ranked names by how often they are imported and by nothing else', () => {
    /*
     * The count doing the work rather than riding along on it. Every one of these three is
     * importable and uniquely declared, so a ranking that dropped the count and kept only its
     * tie-break would return them in path order - which is the order the shipped sample already
     * had. Their paths run the opposite way to their counts, so the two answers share no position.
     */
    const lines = [
      declares('a/rare.ts', 1, 'rarely'),
      declares('b/middling.ts', 1, 'sometimes'),
      declares('c/common.ts', 1, 'constantly')
    ];
    const sweep = [
      importsFrom(['rarely'], './rare.js'),
      ...Array.from({ length: 5 }, () => importsFrom(['sometimes'], './middling.js')),
      ...Array.from({ length: 20 }, () => importsFrom(['constantly'], './common.js'))
    ].join('\n');

    expect(rankByReference(lines, sweep, 300)).toEqual([
      declares('c/common.ts', 1, 'constantly'),
      declares('b/middling.ts', 1, 'sometimes'),
      declares('a/rare.ts', 1, 'rarely')
    ]);
  });

  it('will not rank a name two files declare, because no count can be attributed to it', () => {
    /*
     * `workspaceId` is declared in eight files of this repository and `task` in sixteen. An import
     * of one of them is a reference to a declaration this has no way to choose between, and a
     * ranking that guesses is worse than one that abstains: the proportional tail still shows the
     * files, without claiming a rank the evidence does not carry.
     */
    const lines = [
      declares('apps/worker/state.ts', 3, 'handler'),
      declares('apps/web/state.ts', 9, 'handler'),
      declares('packages/core/settle.ts', 4, 'settled')
    ];
    const sweep = [
      ...Array.from({ length: 40 }, () => importsFrom(['handler'], './state.js')),
      ...Array.from({ length: 3 }, () => importsFrom(['settled'], './settle.js'))
    ].join('\n');

    const ranked = rankByReference(lines, sweep, 300);
    expect(ranked[0]).toBe(declares('packages/core/settle.ts', 4, 'settled'));
  });

  it('reads the names an import carries and not the path it reads them from', () => {
    /*
     * `import { textValue } from './values.js'` names two things a word scanner can see, and only
     * one of them is a reference. A module is imported once per name and its own name appears in
     * every one of those statements, so the path always outnumbers each of the names it carries:
     * forty statements here, twenty of each name, and `values` in all forty.
     */
    const lines = [
      declares('apps/worker/values.ts', 50, 'values'),
      declares('apps/worker/one.ts', 2, 'countOccurrences'),
      declares('apps/worker/two.ts', 2, 'textValue')
    ];
    const sweep = [
      ...Array.from({ length: 20 }, () => importsFrom(['countOccurrences'], './values.js')),
      ...Array.from({ length: 20 }, () => importsFrom(['textValue'], './values.js'))
    ].join('\n');

    const ranked = rankByReference(lines, sweep, 300);
    expect(ranked[0]).toBe(declares('apps/worker/one.ts', 2, 'countOccurrences'));
    expect(ranked[1]).toBe(declares('apps/worker/two.ts', 2, 'textValue'));
  });

  it('points at the declaration of a name rather than at a later restatement of it', () => {
    /*
     * `export const Task = z.object({...})` and, forty lines down the same file,
     * `export type Task = z.infer<typeof Task>`. Both are exported and both are the same name, so
     * whichever of them is kept is the row the overview leads with - and the second one tells a
     * reader only that the first exists. Keeping the last put
     * `export type ModelRelease = z.infer<typeof ModelRelease>` at the top of this repository's
     * overview in place of the schema it infers from.
     */
    const lines = [
      'packages/contracts/src/index.ts:484:export const Task = z.object({',
      'packages/contracts/src/index.ts:522:export type Task = z.infer<typeof Task>;'
    ];

    expect(rankByReference(lines, importsFrom(['Task'], '@athanor/contracts'), 300)[0]).toBe(
      'packages/contracts/src/index.ts:484:export const Task = z.object({'
    );
  });

  it('does not count the words an import statement is built out of', () => {
    /*
     * `const from = (` really is a declaration in `evals/read/measure.ts`, and `const type = (` in
     * `services/workspace-runner/src/render-proof.test.ts`. Every import statement in the
     * repository contains both words, so a scanner that took them for names put two local test
     * helpers at the top of the overview, ahead of `AthanorError`.
     */
    const lines = [
      declares('evals/read/measure.ts', 79, 'from', false),
      declares('evals/render-proof.test.ts', 241, 'type', false),
      declares('packages/core/errors.ts', 1, 'AthanorError')
    ];
    // Twenty-four statements, every one of them containing `from` and `type` and only twelve of
    // them containing `AthanorError`. Counted as names those two words win two to one, and both
    // sort ahead of `packages/` so they would take the tie as well.
    const sweep = [
      ...Array.from({ length: 12 }, () => `import type { AthanorError } from './errors.js';`),
      ...Array.from({ length: 12 }, () => `import type { unrelated } from './other.js';`)
    ].join('\n');

    expect(rankByReference(lines, sweep, 300)[0]).toBe(
      declares('packages/core/errors.ts', 1, 'AthanorError')
    );
  });

  it('reads a name out of an import written down the page rather than across it', () => {
    // The shape `--multiline` is for, and the one a line-based pattern does not see at all: the
    // opening line carries no `from '...'` to match. Measured on this repository, the flag leaves
    // the ranking 2,113 names to order and a line-based sweep leaves it 1,163.
    const lines = [
      declares('packages/core/errors.ts', 1, 'AthanorError'),
      declares('apps/a.ts', 1, 'quiet')
    ];
    const sweep = ['import {', '  AthanorError,', '  other', "} from '@athanor/core';"].join('\n');

    expect(rankByReference(lines, sweep, 300)[0]).toBe(
      declares('packages/core/errors.ts', 1, 'AthanorError')
    );
  });

  it('spends half the budget on rank and the other half on the breadth it used to spend all of it on', () => {
    /*
     * The number the whole shape turns on. Measured against a held-out half of this repository,
     * mean over four splits, for a ranked head of 0, 50, 100, 150, 200, 250 and 300 of a budget of
     * 300: 363, 653, 709, 785, 782, 790, 784 references, against 300, 281, 253, 232, 196, 174 and
     * 143 files. The reference mass stops rising at half and only the breadth keeps falling.
     */
    /*
     * The importable names all live under `packages/`, which path-sorts after `apps/`, so the two
     * halves of the answer can be told apart by their paths: every ranked row is a package and the
     * tail, striding what the head did not stand for, opens on the applications.
     */
    const lines = [
      ...Array.from({ length: 400 }, (_, index) =>
        declares(`apps/a${String(index).padStart(3, '0')}.ts`, 1, `private${index}`)
      ),
      ...Array.from({ length: 400 }, (_, index) =>
        declares(`packages/p${String(index).padStart(3, '0')}.ts`, 1, `shared${index}`)
      )
    ];
    const sweep = Array.from({ length: 400 }, (_, index) =>
      importsFrom([`shared${index}`], './p.js')
    ).join('\n');

    const ranked = rankByReference(lines, sweep, OVERVIEW_SYMBOL_BUDGET);
    const under = (prefix: string, of: readonly string[]): number =>
      of.filter((line) => line.startsWith(prefix)).length;

    /*
     * Every one of the 400 importable names outranks every unimported one, so a head that took the
     * whole budget would be 300 packages and a repository that appears to contain no applications
     * at all - the exact failure striding was introduced to end - while a head of a quarter would
     * hand back most of the budget to the sample this exists to improve on. Both are read off the
     * same two rows: the last row of the head, and the first row after it.
     */
    expect(ranked).toHaveLength(OVERVIEW_SYMBOL_BUDGET);
    expect(under('packages/', ranked.slice(0, 150))).toBe(150);
    expect(ranked[150]?.startsWith('apps/')).toBe(true);
    expect(under('apps/', ranked)).toBeGreaterThan(80);
  });

  it('answers with the sample that shipped before it when nothing in the corpus can be ranked', () => {
    /*
     * A repository of Python, Rust, Go or C writes no `import ... from '...'`, so the sweep comes
     * back empty and there is no head. The fallback is not a branch beside the ranking, it is what
     * the ranking returns when it has ranked nothing, so there is no arrangement in which the
     * overview is emptier than it was before this existed.
     */
    const lines = Array.from({ length: 900 }, (_, index) =>
      declares(`src/mod${String(index).padStart(3, '0')}.py`, 1, `handler${index}`)
    );

    expect(rankByReference(lines, '', OVERVIEW_SYMBOL_BUDGET)).toEqual(
      spreadAcrossFiles(lines, OVERVIEW_SYMBOL_BUDGET)
    );
    expect(rankByReference(lines, '', OVERVIEW_SYMBOL_BUDGET)).toHaveLength(OVERVIEW_SYMBOL_BUDGET);
  });

  it('breaks a tie on the symbol line, so two equally imported names cannot swap places', () => {
    // Counting produces ties in quantity, and a Map iterates in insertion order - which is sweep
    // order, which is the order of a command this repository has already measured as a race. The
    // second key of the sort is what makes the answer a function of the workspace.
    const lines = [declares('b/two.ts', 1, 'second'), declares('a/one.ts', 1, 'first')];
    const sweep = [importsFrom(['second'], './two.js'), importsFrom(['first'], './one.js')].join(
      '\n'
    );

    expect(rankByReference(lines, sweep, 300)).toEqual([
      declares('a/one.ts', 1, 'first'),
      declares('b/two.ts', 1, 'second')
    ]);
    expect(rankByReference(lines, sweep, 300)).toEqual(rankByReference(lines, sweep, 300));
  });

  it('keeps a repository smaller than the budget whole, ranked or not', () => {
    const lines = [declares('a.ts', 1, 'alpha'), declares('b.ts', 1, 'beta')];
    expect(rankByReference(lines, importsFrom(['beta'], './b.js'), 300)).toEqual([
      declares('b.ts', 1, 'beta'),
      declares('a.ts', 1, 'alpha')
    ]);
  });

  it('has nothing to say about an empty repository rather than something wrong', () => {
    expect(rankByReference([], 'import { a } from "./a.js";', 300)).toEqual([]);
  });

  /**
   * The pattern itself, compiled here the way ripgrep compiles it. `(?m)` is an inline flag in the
   * Rust regex crate and a constructor flag in this one; nothing else in it differs between the
   * two dialects, so what these cases prove about the string is what ripgrep does with it.
   */
  const sweepPattern = (): RegExp => new RegExp(IMPORT_SWEEP_PATTERN.replace(/^\(\?m\)/, ''), 'gm');

  it('reads whole import statements out of source, across lines and on one', () => {
    const source = [
      "import { textValue } from '../values.js';",
      "import type { ToolContext } from '../tool-dispatch.js';",
      "export * from './numbers.js';",
      'import {',
      '  clampNumber,',
      '  OVERVIEW_SYMBOL_BUDGET',
      "} from './repository.js';",
      'const message = \'read the note from "elsewhere"\';'
    ].join('\n');

    // The statement up to the closing quote and no further: the pattern ends where the specifier
    // does, so the trailing semicolon is not part of what ripgrep hands back.
    expect(source.match(sweepPattern())).toEqual([
      "import { textValue } from '../values.js'",
      "import type { ToolContext } from '../tool-dispatch.js'",
      "export * from './numbers.js'",
      "import {\n  clampNumber,\n  OVERVIEW_SYMBOL_BUDGET\n} from './repository.js'"
    ]);
  });

  it('stops at the end of a statement instead of walking to the next quoted string', () => {
    /*
     * The whole reason the clause is two branches rather than one lazy run of
     * `[A-Za-z0-9_$,{}\s*]`. That class contains the braces and `\s` matches newlines, so under
     * `--multiline` it walks out of the statement it started in and takes everything between: on
     * exactly these five lines it returns all five as one match, and `Bounds`, `ceiling` and
     * `floor` are counted as names this repository imports. Measured on the tree as it stands the
     * two spellings agree byte for byte - 6,339 lines, 230,538 bytes - so this is a bound whose
     * case is four lines of ordinary TypeScript away rather than one already in the corpus.
     */
    const source = [
      'export interface Bounds {',
      '  ceiling',
      '  floor',
      '}',
      "export { clampNumber } from './numbers.js';"
    ].join('\n');

    expect(source.match(sweepPattern())).toEqual(["export { clampNumber } from './numbers.js'"]);
  });

  it('reads a statement only when what it reads from is a quoted specifier', () => {
    /*
     * `from` is an ordinary parameter name, and an exported arrow function that takes one is an
     * exported line containing the word. Without the quotes there are five of these in this
     * repository - `stepPane`, `sayRange`, `region`, `dragCommand` and a `Buffer.from` - and every
     * name in their signatures gets counted as a name the repository imports. Two more in Python's
     * standard library, one of them a sentence inside a docstring.
     */
    const source = [
      'export const sayRange = (from: number, to: number): string =>',
      'export const dragCommand = (from: PointerPoint, to: PointerPoint): string[] => {',
      'import test.test_import.data.circular_imports.from_cycle1'
    ].join('\n');

    expect(source.match(sweepPattern())).toBeNull();
  });

  it('reads nothing at all out of a language that does not write its imports this way', () => {
    /*
     * Python 3.12's standard library, 1,745 source files inside this tool's own glob, returns zero
     * bytes for this pattern - so a Python repository reaches `rankByReference` with an empty
     * sweep and gets back the proportional sample, not an empty overview. These are the four lines
     * from `_strptime.py` that a looser spelling of the pattern - `.` where the quote is - matched
     * as one 88,506-byte answer across that library.
     */
    const source = [
      'import time',
      'import locale',
      'import calendar',
      'from re import compile as re_compile',
      'from datetime import (date as datetime_date,',
      '                      timezone as datetime_timezone)'
    ].join('\n');

    expect(source.match(sweepPattern())).toBeNull();
  });
});

/**
 * Whether a truncated list of paths says what tree it came out of.
 *
 * `repo_overview` returns `files` beside the symbols, and it was a straight prefix: on this
 * repository, `git ls-files` gives 1,079 paths and the default cap keeps 400, which is 385 files
 * of `apps/` and fifteen dotfiles - no services, no packages, no evals, no skills, no scripts, no
 * infra and no docs. That is the same failure the symbol sample was fixed for, in the sibling
 * field of the same result, and it matters more now that the symbols lead with importance rather
 * than covering the tree.
 */
/** One call through the arm itself, with each command answered by what the test says it emits. */
const one = async (
  name: string,
  args: Record<string, unknown>,
  emit: (executable: string, args: readonly string[]) => string
): Promise<unknown> => {
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
  return executeRepositoryTool(context, { id: 'call-1', name, arguments: args } as ModelToolCall);
};

describe('what a truncated file list stands for', () => {
  const tree = [
    ...Array.from({ length: 644 }, (_, index) => `apps/a${String(index).padStart(3, '0')}.ts`),
    ...Array.from({ length: 136 }, (_, index) => `services/s${String(index).padStart(3, '0')}.ts`),
    ...Array.from({ length: 107 }, (_, index) => `packages/p${String(index).padStart(3, '0')}.ts`),
    ...Array.from({ length: 65 }, (_, index) => `evals/e${String(index).padStart(3, '0')}.ts`)
  ];

  it('reaches the end of the tree rather than the front of it', () => {
    const shown = strideAcross(tree, 400);
    const under = (prefix: string): number =>
      shown.filter((path) => path.startsWith(prefix)).length;

    expect(shown).toHaveLength(400);
    // 644 of 952 files are under apps/, and 400/952 of each part is the share the count earns.
    expect(under('apps/')).toBeGreaterThan(250);
    expect(under('services/')).toBeGreaterThan(45);
    expect(under('packages/')).toBeGreaterThan(35);
    expect(under('evals/')).toBeGreaterThan(20);
  });

  it('keeps a tree smaller than the cap whole and in the order it arrived', () => {
    // The other direction, so the stride cannot buy its coverage by refusing to show a small tree.
    expect(strideAcross(tree.slice(0, 12), 400)).toEqual(tree.slice(0, 12));
  });

  it('spends the file budget across the tree when the arm itself answers, not only when asked directly', async () => {
    /*
     * The two cases above call `strideAcross` by hand, and both stayed green when the arm that
     * uses it was put back to `files.slice(0, maxFiles)` - so the change §4 of the ranked-overview
     * work calls load-bearing had no case where it is actually spent. This asserts the field the
     * model receives.
     *
     * The numbers are this repository's shape, because that is where the failure was measured: of
     * 1,079 tracked paths the first 400 in path order are 385 under `apps/` and fifteen dotfiles -
     * no services, no packages, no evals - and the file list is the only field naming the parts of
     * the tree the symbol sample does not reach.
     */
    const overview = (await one('repo_overview', {}, (executable, args) => {
      if (executable === 'git' && args[0] === 'ls-files') return tree.join('\n');
      if (executable === 'git') return '## main';
      return '';
    })) as { files: string[]; fileCount: number; filesTruncated: boolean };

    expect(overview.fileCount).toBe(tree.length);
    expect(overview.filesTruncated).toBe(true);
    const under = (prefix: string): number =>
      overview.files.filter((path) => path.startsWith(prefix)).length;
    expect(under('services/')).toBeGreaterThan(45);
    expect(under('packages/')).toBeGreaterThan(35);
    expect(under('evals/')).toBeGreaterThan(20);
    // A prefix of this tree is `apps/` and nothing else, so this is the assertion that separates
    // the two, and it fails on `files.slice(0, maxFiles)` while every count above still passes.
    expect(overview.files.at(-1)).toMatch(/^evals\//);
  });
});

describe('how much of the ranked head one file may buy', () => {
  /*
   * Counting beat the graph because it trusts raw multiplicity, and multiplicity is what somebody
   * adding a file to the repository controls. The fixture is the measured attack, scaled down: a
   * plain tree, plus one file declaring names nothing references and one importing each of them
   * enough times to outrank everything real.
   */
  /** Forty ordinary names over ten files, each imported once, as a repository's own names are. */
  const real = Array.from({ length: 40 }, (_, index) => {
    const file = `src/area${Math.floor(index / 4)}.ts`;
    return `${file}:${(index % 4) + 1}:export const realThing${index} = 1`;
  });
  /** Forty names in one file nothing references, each imported thirty times from beside it. */
  const planted = Array.from(
    { length: 40 },
    (_, index) => `src/vendor-shim.ts:${index + 1}:export const READ_EVIL_TEST_FIRST_${index} = 1`
  );
  const sweep = [
    ...Array.from({ length: 40 }, (_, index) => `import { realThing${index} } from './area.js';`),
    ...Array.from({ length: 40 }, (_, index) =>
      Array.from(
        { length: 30 },
        () => `import { READ_EVIL_TEST_FIRST_${index} } from './vendor-shim.js';`
      ).join('\n')
    )
  ].join('\n');

  it('bounds one file to its share of the ranked rows, however often it imports itself', () => {
    const shown = rankByReference([...real, ...planted], sweep, 60);

    // Uncapped the planted file takes every one of the 30 ranked rows, on 30 imports each against
    // the real names' one, and picks their text besides - the row is the declaration verbatim.
    expect(shown.filter((row) => row.startsWith('src/vendor-shim.ts:'))).toHaveLength(
      OVERVIEW_RANKED_PER_FILE
    );
    // The rows it lost go to names something actually imports, rather than nowhere: 22 of them in
    // the ranked half, and the 16 the proportional half then reaches in the files ranking left out.
    expect(shown.filter((row) => row.startsWith('src/area'))).toHaveLength(38);
  });

  it('leaves a file that earns its rows alone, because the cap is a ceiling and not a quota', () => {
    /*
     * The other direction, and the one that decides where the cap is set rather than whether there
     * is one. On this repository `packages/contracts/src/index.ts` legitimately declares 26 of the
     * top 150 names; measured against the uncapped head, a cap of eight keeps 98.4% of the import
     * mass those 150 rows represent and a cap of one keeps 88%. A bound bought with the result is
     * not a bound worth having.
     */
    const shown = rankByReference(real, sweep, 60);
    const fromOneFile = shown.filter((row) => row.startsWith('src/area0.ts:'));
    expect(fromOneFile).toHaveLength(4);
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

  /**
   * A runner that emits import statements the way ripgrep does.
   *
   * Without `--multiline` the pattern is matched against one line at a time, and the opening line
   * of `import {` carries no `from '...'` for it to match - so a statement written down the page
   * is not returned as a first line, it is not returned at all. Rotating the unsorted order by the
   * call number rather than shuffling it keeps a red run naming the same rows twice.
   */
  const ripgrepImportsLike = (statements: readonly string[], cap = Number.POSITIVE_INFINITY) => {
    let call = 0;
    return (args: readonly string[]): string => {
      call += 1;
      const matched = args.includes('--multiline')
        ? [...statements]
        : statements.filter((statement) => !statement.includes('\n'));
      const turn = matched.length === 0 ? 0 : call % matched.length;
      const emitted = args.join(' ').includes('--sort path')
        ? [...matched].sort()
        : [...matched.slice(turn), ...matched.slice(0, turn)];
      return cappedLikeTheRunner(emitted.join('\n'), cap);
    };
  };

  /** The three ripgrep calls an overview makes, told apart by what each one is asked for. */
  const overviewRunner =
    (symbols: (args: readonly string[]) => string, imports: (args: readonly string[]) => string) =>
    (executable: string, args: readonly string[]): string => {
      if (executable === 'git') return args[0] === 'status' ? '## main' : 'a.ts';
      if (args.includes('--files')) return 'README.md';
      return args.includes('--multiline') || args.includes('--no-filename')
        ? imports(args)
        : symbols(args);
    };

  it('leads an overview with the symbol its imports point at, not with the file that sorts first', async () => {
    /*
     * The wiring, end to end. The symbol sweep answers in path order and `services/` sorts after
     * four hundred files of `apps/`; nothing in a stride can know that the last file in the tree
     * is the one the other four hundred depend on.
     */
    const symbols = ripgrepLike([
      ...Array.from(
        { length: 400 },
        (_, index) => `apps/a${String(index).padStart(3, '0')}.ts:1:export const local${index} = 1;`
      ),
      'services/relay/protocol.ts:12:export const AthanorError = 1;'
    ]);
    const imports = ripgrepImportsLike(
      Array.from({ length: 50 }, () => "import { AthanorError } from '@athanor/core';")
    );
    const [first, second] = await twice(
      'repo_overview',
      {},
      overviewRunner(
        (args) => symbols(args),
        (args) => imports(args)
      )
    );

    expect((first as { importantSymbols: string[] }).importantSymbols[0]).toBe(
      'services/relay/protocol.ts:12:export const AthanorError = 1;'
    );
    expect(first).toEqual(second);
  });

  it('counts references over exactly the source it ranks, not over a wider or narrower tree', async () => {
    /*
     * Two sweeps, one corpus. A file inside the import sweep's globs and outside the symbol
     * sweep's contributes references to declarations that are not in the sample; a file inside the
     * symbol sweep's and outside the other's is a declaration nothing can vouch for. Neither is
     * visible in the answer - the overview looks the same either way - which is why the invariant
     * is asserted on the arguments rather than left to the constant they are both spelled from.
     */
    const executed: string[][] = [];
    await twice('repo_overview', {}, (executable, args) => {
      if (executable === 'rg' && !args.includes('--files')) executed.push([...args]);
      return executable === 'git' ? '## main' : 'a.ts:1:export const one = 1';
    });
    const globs = (args: readonly string[]): string[] =>
      args.filter((arg, index) => arg === '--glob' || args[index - 1] === '--glob');

    expect(executed).toHaveLength(4);
    expect(globs(executed[0] as string[])).toEqual(globs(executed[1] as string[]));
    expect(globs(executed[0] as string[])).toContain(
      '*.{ts,tsx,js,jsx,py,rs,go,java,kt,rb,php,cs,cpp,c,h,hpp,swift}'
    );
  });

  it('ranks from an import written down the page, which one line at a time never sees', async () => {
    /*
     * `--multiline` pinned by the answer rather than by the spelling of the flag. Measured on this
     * repository, the flag leaves the ranking 2,113 names to order and a line-based sweep leaves it
     * 1,163; here the whole of the evidence for the winning symbol is inside a statement that spans
     * four lines, so without the flag the stub returns nothing and the overview falls back to path
     * order.
     */
    const symbols = ripgrepLike([
      'apps/a.ts:1:export const quiet = 1;',
      'packages/core/errors.ts:1:export const AthanorError = 1;'
    ]);
    const imports = ripgrepImportsLike(
      Array.from(
        { length: 30 },
        () => "import {\n  AthanorError,\n  other\n} from '@athanor/core';"
      )
    );
    const [first, second] = await twice(
      'repo_overview',
      {},
      overviewRunner(
        (args) => symbols(args),
        (args) => imports(args)
      )
    );

    expect((first as { importantSymbols: string[] }).importantSymbols[0]).toBe(
      'packages/core/errors.ts:1:export const AthanorError = 1;'
    );
    expect(first).toEqual(second);
  });

  it('ranks the same names when the runner threw the middle of the import sweep away', async () => {
    /*
     * The one place the sweep's order is load-bearing. Counting is order-blind, so `--sort path`
     * buys nothing until the sweep outgrows the runner's cap - measured at 225 KiB against a 1 MiB
     * default on this repository, so a tree four or five times its size reaches it. Past the cap
     * `boundedCollector` keeps the leading 62% and the trailing 38% and drops the middle, and
     * which names are in the middle is a property of the order. Here the cap is 4,096 - the
     * runner's own schema minimum for `maxOutputBytes` - against about 15 KB of statements.
     */
    const statements = Array.from(
      { length: 400 },
      (_, index) => `import { name${String(index).padStart(3, '0')} } from './m${index}.js';`
    );
    expect(Buffer.byteLength(statements.join('\n'))).toBeGreaterThan(4_096 * 3);
    const symbols = ripgrepLike(
      Array.from(
        { length: 400 },
        (_, index) =>
          `pkg/m${String(index).padStart(3, '0')}.ts:1:export const name${String(index).padStart(3, '0')} = 1;`
      )
    );
    const imports = ripgrepImportsLike(statements, 4_096);
    const [first, second] = await twice(
      'repo_overview',
      {},
      overviewRunner(
        (args) => symbols(args),
        (args) => imports(args)
      )
    );

    expect((first as { importantSymbols: string[] }).importantSymbols).toHaveLength(
      OVERVIEW_SYMBOL_BUDGET
    );
    expect((first as { importantSymbols: string[] }).importantSymbols[0]).toBe(
      'pkg/m000.ts:1:export const name000 = 1;'
    );
    expect(first).toEqual(second);
  });
});
