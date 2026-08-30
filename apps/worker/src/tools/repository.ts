import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { type ExecObservation, type ProcessObservation } from '../agent-state.js';
import { event } from '../tool-recording.js';
import { boundedKnowledge, textValue } from '../values.js';
import {
  buildSubscriptionAgentArgs,
  subscriptionAgentExecutable,
  subscriptionAgentLoginCommand,
  subscriptionAgentName,
  subscriptionAgentPackage,
  subscriptionAgentRunEnvironment,
  subscriptionAgentStatusArgs,
  type SubscriptionAgent
} from '../subscription-agent.js';
import { type ToolContext } from '../tool-dispatch.js';
import { diagnosticsCommand, diagnosticsLanguage } from './diagnostics.js';
import { clampNumber } from './numbers.js';

/**
 * The repository tools: reading a codebase, and handing work to a coding agent inside it.
 *
 * Grouped by what they need rather than by what they do: every one of them resolves a repository
 * root first and answers in terms of it, and `coding_agent` is here rather than with the workspace
 * tools because what it drives is a subscription CLI scoped to that same root.
 */

/**
 * Where a code search stops being an answer and starts being a wall to read.
 *
 * A search result is not evidence, it is a decision: which file do I open next. The measured
 * finding this pair of numbers implements is that the two are in tension - an iterative search that
 * returned each match with its surrounding context scored six points *below* one that returned only
 * `path (N matches)` and a total. More context about each hit made the model worse at choosing
 * between them, which is the only thing a search result is for.
 *
 * It is also the cheapest context saving in the tool surface. `maxResults` defaults to 120 lines
 * and its ceiling is 500; a ripgrep line is a whole line of source, so 500 of them is tens of
 * kilobytes against a `RECENT_TOOL_OUTPUT_CHARS` of 24,000 - a large, cache-resident block of
 * mostly noise, of which the model needed one path.
 *
 * Two numbers rather than one because they answer different questions. The line threshold is where
 * the lines stop being readable; the file ceiling is where the *list of files* stops being a
 * decision surface too, and no collapsing helps, so the call is refused and the model is told to
 * narrow it.
 *
 * Exported because the catalogue tells the model about both of them and a description that states
 * a bound the runtime does not apply is the defect this repository has closed twice already - once
 * where `session_search` advertised fifty results against a retrieval of thirty. Not imported by
 * `tool-catalogue.ts`, though, which is the shape that answer usually takes: this module reaches
 * `agent.js`, which reaches `tools.js`, which is the catalogue, so an import the other way closes a
 * cycle whose evaluation order decides whether `agentTools` reads an initialised constant or throws
 * on the temporal dead zone - and it would depend on which file the process happened to load first.
 * The binding is made in `tool-catalogue.test.ts` instead, where importing both costs nothing and
 * catches the same drift a day earlier.
 */
export const CODE_SEARCH_COLLAPSE_LINES = 40;
export const CODE_SEARCH_FILE_CEILING = 100;

/**
 * The path each ripgrep line belongs to, and how many lines landed in it.
 *
 * Greedy up to the last `path:line:column:` prefix rather than cutting at the first colon: a
 * filename may legitimately contain one, and `weird:12:file.ts:3:1:text` cut at the first colon
 * groups real matches under a directory that does not exist. Anchoring on the line-and-column pair
 * ripgrep is being asked for by `--line-number --column` is the only part of the shape this code
 * chose itself. A line that does not have it at all is counted under itself, so a format this does
 * not recognise still produces a total that adds up rather than silently losing rows.
 */
const groupByFile = (matches: readonly string[]): Map<string, number> => {
  const files = new Map<string, number>();
  for (const line of matches) {
    const file = /^(.*):\d+:\d+:/.exec(line)?.[1] ?? line;
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  return files;
};

/** How many symbol lines an overview carries, which is what the downstream result cap affords. */
export const OVERVIEW_SYMBOL_BUDGET = 300;

/**
 * The flags that make a ripgrep answer a function of the workspace rather than of thread scheduling.
 *
 * ripgrep searches and walks in parallel and writes each file's block as its thread finishes, so
 * every rg call in this file emits a different order on every run. Measured on this repository over
 * twenty consecutive runs, on ripgrep 15.2.0 and again on 13.0.0: the symbol sweep agreed with its
 * own first run 1/20 times, `rg --files` 1/20, and the instruction-file list 1/20.
 *
 * The rate is not a rate to tune against. Four consecutive batches of twenty runs of one unchanged
 * `code_search` - `clampNumber`, 40 lines across 7 files - against one unchanged tree agreed 1/20,
 * 10/20, 1/20 and 9/20, with 8, 11, 12 and 9 distinct orders; the same search on 13.0.0 was 1/20
 * with 20 distinct orders in every batch. A batch that came back 10/20 would have read as mostly
 * settled. An order that holds on this machine against this corpus with this ripgrep is not an
 * order that holds.
 *
 * That alone would be an ordering problem, and every consumer below cuts the output, which makes it
 * a *set* problem. The two cuts are in different places and only one of them can be repaired here:
 *
 * - The harness cuts. `matches.slice(0, maxResults)`, `strideAcross` and `spreadAcrossFiles` all
 *   keep a prefix or a stride of the lines, so whichever thread finished first decided what the
 *   model was shown. This one a sort in this process could fix.
 * - The runner cuts first, and this one it could not. `boundedCollector` in the runner caps a
 *   command at `maxOutputBytes` - 1 MiB by default - keeping the leading 62% and the trailing 38%
 *   and dropping the middle. A `code_search` for `const` on this repository emits 2.6 MB and one
 *   for `e` emits 23.1 MB, both far over that. Simulating the collector over twelve unsorted runs:
 *   twelve different surviving *sets*, between 9,637 and 11,108 of the 25,770 matching lines, with
 *   3,702 lines present in the first run and absent from the second, and 507 lines that no run saw
 *   at all. Sorting in the worker cannot return a line the runner already threw away.
 *
 * So the order is settled at the source, where both cuts see it. The same twelve runs with these
 * flags: one surviving set, 9,462 lines, twelve times out of twelve.
 *
 * It is not free - `--sort` turns off ripgrep's parallelism, which is the reason to say what it
 * buys rather than to reach for it everywhere. Measured cost per call on this corpus: the symbol
 * sweep 21.5 ms -> 47.5 ms, a `code_search` 13.2 ms -> 24.6 ms, `rg --files` 8.0 ms -> 10.2 ms, the
 * instruction-file list 8.8 ms -> 9.2 ms. Tens of milliseconds against tool timeouts of 60 and 90
 * seconds, for the difference between an answer and a sample of one.
 *
 * `git status` and `git ls-files` get nothing added: both agreed 20/20 over twenty runs, because
 * the index they read is a path-sorted structure, and there is no flag to pin.
 */
const SETTLED_ORDER = ['--sort', 'path'];

/**
 * The source an overview reads, shared by the two sweeps that read it.
 *
 * Held together rather than written twice because the second sweep counts names that the first one
 * has to be able to place: a file inside one glob and outside the other contributes references to
 * a declaration that is not in the sample, or a declaration nothing can vouch for. Two copies of
 * this list are two answers to the same question.
 */
const SOURCE_GLOBS = [
  '--glob',
  '!node_modules/**',
  '--glob',
  '!dist/**',
  '--glob',
  '!build/**',
  '--glob',
  '*.{ts,tsx,js,jsx,py,rs,go,java,kt,rb,php,cs,cpp,c,h,hpp,swift}'
];

/**
 * Which symbols an overview shows when it cannot show them all.
 *
 * ripgrep searches in parallel and emits in whatever order its threads finish, so taking the first
 * three hundred lines was taking the first three hundred lines of a race. Measured on this
 * repository: 300 of 5,797 symbols, covering 44 of 622 files, forty of them under `services/`, with
 * the whole of `apps/` - the worker, the api, the web client, every part of the harness - standing
 * for two files, and a different forty-four on each run. An overview whose subject is chosen by
 * thread scheduling is not an overview, and this is the tool the catalogue tells the model to reach
 * for first.
 *
 * `--sort path` settles the order. This settles the choice: one symbol from every file before any
 * file gets a second, so a budget smaller than the repository buys breadth rather than whichever
 * directory finished first, and within a file an exported name goes ahead of an unexported one
 * because the public surface is what an overview is for.
 *
 * The path is taken up to the FIRST `:number:` rather than the last, which is the opposite of
 * `groupByFile` above and for the opposite reason: that one is given `--column` and can anchor on
 * a line-and-column pair too specific to appear in source text, and this one is not, so `:\d+:`
 * matched greedily would find a time literal in the code and call it a filename.
 */
/**
 * A budget smaller than the list, spent along the whole of it instead of down the front.
 *
 * Taking the first `budget` entries of a path-sorted list is the same failure as taking the first
 * `budget` that ripgrep happened to emit, only reproducible: this repository sorts `apps/` first
 * and has 644 of its 1,079 tracked files under it, so a straight prefix of 400 is 385 files of
 * `apps/` and fifteen dotfiles - no services, no packages, no evals, no skills, no scripts, no
 * infra, no docs. Striding spends the budget in proportion to where the entries actually are.
 */
export const strideAcross = <T>(items: readonly T[], budget: number): T[] => {
  if (items.length <= budget) return [...items];
  const stride = items.length / budget;
  return Array.from({ length: budget }, (_, index) => items[Math.floor(index * stride)] as T);
};

export const spreadAcrossFiles = (lines: readonly string[], budget: number): string[] => {
  const byFile = new Map<string, string[]>();
  for (const line of lines) {
    const file = /^(.*?):\d+:/.exec(line)?.[1] ?? line;
    const held = byFile.get(file);
    if (held) held.push(line);
    else byFile.set(file, [line]);
  }
  const unexported = (line: string): number => (/:\d+:\s*export\s/.test(line) ? 0 : 1);
  for (const held of byFile.values()) held.sort((a, b) => unexported(a) - unexported(b));
  const files = [...byFile.values()];
  // More files than budget, which is the case this tool is for.
  if (files.length > budget) return strideAcross(files, budget).map((held) => held[0] as string);
  const spread: string[] = [];
  for (let round = 0; spread.length < budget; round += 1) {
    let placed = false;
    for (const held of files) {
      const line = held[round];
      if (line === undefined) continue;
      spread.push(line);
      placed = true;
      if (spread.length === budget) return spread;
    }
    if (!placed) break;
  }
  return spread;
};

/**
 * The import statements of a repository, which is the only reference edge a regular expression can
 * read without resolving anything.
 *
 * It is two shapes, and the reason is that under `--multiline` a lazy run does not stop at the end
 * of a statement. `--multiline` is needed at all because the shape this is for spans lines -
 * `import {` newline names newline `} from '...'` - and a line-based pattern does not see it: the
 * opening line carries no `from '...'` for a pattern to match, so it is not returned as a first
 * line, it is not returned at all. Measured on this repository, the flag leaves the ranking 2,113
 * names to order and a line-based sweep leaves it 1,163.
 *
 * With the flag, one run of `[A-Za-z0-9_$,{}\s*]*?` between the keyword and `from` walks out of
 * the statement, because `\s` matches newlines and `{` and `}` are inside the class. On these five
 * lines
 *
 *     export interface Bounds {
 *       ceiling
 *       floor
 *     }
 *     export { clampNumber } from './numbers.js';
 *
 * it returns all five as one match, and `Bounds`, `ceiling` and `floor` are then counted as names
 * the repository imports. So a newline is allowed only where a statement can contain one: the
 * first branch is a single line with no quote in it, the second is a brace list that may span
 * lines, and neither can leave the statement it started in. On those five lines this returns the
 * import and nothing else.
 *
 * The two agree everywhere in this repository - byte-identical output, 6,337 lines and 230,381
 * bytes - which is the point: it is a bound with no case here yet, and the case is five lines of
 * ordinary TypeScript away. Both return 0 bytes against the 1,745 source files of Python 3.12's
 * standard library, where the fallback below is what answers.
 *
 * The quoted specifier is not in that position: without it, five lines of this repository are read
 * as imports today - `stepPane`, `sayRange`, `region`, `dragCommand` and a `Buffer.from([...])`,
 * every one an exported function whose first parameter is called `from` - and two of the Python
 * library's, one of them a sentence inside a docstring.
 *
 * Neither the filename nor the line number is asked for, because neither is used. Counting
 * distinct importing files and counting occurrences agree on 149 of the top 150 on this
 * repository and score within noise of each other (3.25 against 3.29 held-out references per
 * line), so the cheaper one is taken: dropping both prefixes takes the sweep from 463 KiB to
 * 225 KiB, which is 22% of the runner's 1 MiB output cap rather than 45%. Past that cap
 * `boundedCollector` drops the middle of the output; the ranking degrades to fewer names and the
 * proportional fill covers the rest, and because `--sort path` fixes the bytes, what survives is
 * the same on every run.
 *
 * Measured cost of the whole sweep: 36 ms over five runs on this repository, against the symbol
 * sweep's 57 ms beside it, and 62 ms on the 1,745 files of the Python library it declines to read.
 */
export const IMPORT_SWEEP_PATTERN =
  '(?m)^[ \\t]*(?:import|export)[ \\t]+(?:[^\\n\'"]*?|[^\\n\'"{]*\\{[A-Za-z0-9_$,\\s]*?\\}[ \\t]*)\\bfrom[ \\t]*[\'"][^\'"\\n]+[\'"]';

/** The words an import statement is built from, which are not the names it carries. */
const IMPORT_GRAMMAR = new Set(['import', 'export', 'from', 'type', 'as', 'default']);

/**
 * Which half of an overview's symbol budget is bought by importance rather than by breadth.
 *
 * Measured on this repository against a held-out half of the corpus the ranking never saw - the
 * graph built from one half, scored by how many files in the other half mention each name in code
 * with comments and string bodies stripped - mean over four splits, 300 symbols each time:
 *
 *   ranked head    0    50   100   150   200   250   300
 *   references   363   653   709   785   782   790   784
 *   files        300   281   253   232   196   174   143
 *
 * The reference mass stops rising at half the budget and only the breadth keeps falling, so half
 * is where the two meet. At 300 the sample is 143 files and `evals/` is down to five of them; at
 * 150 it is 232 files with every top-level directory still in it, and the proportional tail is
 * still doing the job the whole budget used to do alone.
 */
export const OVERVIEW_RANKED_SHARE = 2;

/** How many of the ranked rows one file may supply. @see `rankByReference`, where it is spent. */
export const OVERVIEW_RANKED_PER_FILE = 8;

/**
 * The symbols an overview leads with, ordered by how many times the repository imports them.
 *
 * The shipped sample was proportional, not ranked: one symbol from each of 300 of 625 files, which
 * spends 103 of its 300 rows on test files, 116 on names nothing outside their own file can even
 * reach, and 47 of its 197 measurable rows on names referenced from nowhere else at all. Its first
 * four rows on this repository are `SAFARI_MACOS`, `productionEnvironment`, `nginxConf` and
 * `MODEL_ID`, every one of them a fixture. Ranked, the first four are `AthanorError`, `DataStore`,
 * `TaskRecord` and `AgentState`.
 *
 * Three ways of getting an order out of the imports were measured against the held-out half
 * described above, as mean references per measurable row over four splits:
 *
 *   proportional, as shipped                                          1.84
 *   aider: pagerank over the file graph, rank split across out-edges   2.14
 *   distinct importers per (resolved declaring file, name)             2.25
 *   occurrences of the name in import clauses, no graph at all         3.25
 *
 * Those four were prototypes. This function, re-measured the same way against the sweep the
 * shipped ripgrep arguments actually produce, scores 3.18 against the proportional 1.76.
 *
 * So the graph is declined. Not because PageRank is wrong but because it measured worse than
 * counting, twice: it also loses to counting on the whole corpus, and adding aider's own
 * distinctiveness filter to it does not close the gap (2.14 -> 2.08). What the graph costs to
 * resolve is what it loses by: an import of `@athanor/core` or of a barrel that re-exports is an
 * edge no path arithmetic here resolves, and those are exactly the imports the most-used symbols
 * arrive through. Counting keeps them. A damping factor and forty iterations of a numeric fixed
 * point, for a worse answer, is the organ nobody needs.
 *
 * A name is only counted when the sweep declares it in exactly one file, because a count cannot be
 * attributed to a declaration that could be any of several - `workspaceId` is declared in eight
 * files here and `task` in sixteen. Ties break on the symbol line, which is unique, so the whole
 * order is total and the answer is the same on every run, as `IDEMPOTENT_WITHIN_TURN` already
 * claims it is.
 *
 * When the sweep is empty - a repository of Python, Rust, Go or C, none of which writes
 * `import ... from '...'`, or one where the runner returned nothing - there is no ranked head and
 * this returns exactly the proportional sample that shipped before it. The fallback is the same
 * code path rather than a branch beside it, so there is no arrangement in which it is skipped.
 */
export const rankByReference = (
  symbolLines: readonly string[],
  importSweep: string,
  budget: number
): string[] => {
  const declaration =
    /^(.*?):\d+:\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|def|fn|struct|enum|trait)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const exported = (line: string): boolean => /:\d+:\s*export\s/.test(line);
  const filesDeclaring = new Map<string, Set<string>>();
  const declaredAt = new Map<string, string>();
  for (const line of symbolLines) {
    const found = declaration.exec(line);
    if (found === null) continue;
    const file = found[1] as string;
    const name = found[2] as string;
    const seen = filesDeclaring.get(name);
    if (seen) seen.add(file);
    else filesDeclaring.set(name, new Set([file]));
    /*
     * The first exported declaration of the name, not the last. A name is routinely written twice
     * in one file - `export const Task = z.object({...})` and then `export type Task = z.infer<...>`
     * - and the second is a restatement of the first. Keeping whichever came last showed
     * `export type ModelRelease = z.infer<typeof ModelRelease>` at the top of this repository's
     * overview in place of the schema it infers from.
     */
    const held = declaredAt.get(name);
    if (held === undefined || (!exported(held) && exported(line))) declaredAt.set(name, line);
  }
  const imported = new Map<string, number>();
  // The specifier is a path, not a reference: `from './values.js'` would otherwise score whatever
  // `values` happens to be declared as.
  const named = importSweep.replace(/'[^'\n]*'|"[^"\n]*"/g, ' ');
  for (const word of named.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = word[0];
    if (IMPORT_GRAMMAR.has(name) || filesDeclaring.get(name)?.size !== 1) continue;
    imported.set(name, (imported.get(name) ?? 0) + 1);
  }
  const ordered = [...imported]
    .map(([name, count]) => [declaredAt.get(name) as string, count] as const)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
  /*
   * How much of the ranked head one file may buy.
   *
   * Counting beat the graph because it trusts raw multiplicity, and raw multiplicity is the one
   * thing somebody adding a file to the repository controls completely. Measured: a 300-module
   * tree plus two inert files - 160 constants in one, each imported 40 times from the other, and
   * nothing anywhere referencing either - took 149 of the 300 rows, and because a row is the
   * declaration line verbatim, whoever wrote the file also wrote its text. `repo_overview` is the
   * first thing an agent runs in an unfamiliar checkout, so that is a dependency choosing 149
   * lines of what the model reads about the repository it is about to edit. The proportional
   * sample this replaced gave that file 0 rows, because it gave every file at most one.
   *
   * Eight rather than one, because the head does not lose rows to this - it refills from the next
   * name down - and what changes is which rows. Measured on this repository against the uncapped
   * head: the import mass the 150 rows represent goes from 1,672 to 1,646 (98.4%) and the files
   * they come from from 77 to 90. A cap of one would keep only 88% of the mass and cost the real
   * barrel files - `packages/contracts/src/index.ts` legitimately declares 26 of the 150 - so this
   * is set where an attacker is bounded to 8 rows of 300 and the measured win is intact.
   */
  const perFile = new Map<string, number>();
  const ranked: string[] = [];
  for (const [line] of ordered) {
    if (ranked.length >= Math.floor(budget / OVERVIEW_RANKED_SHARE)) break;
    const file = /^(.*?):\d+:/.exec(line)?.[1] ?? line;
    const taken = perFile.get(file) ?? 0;
    if (taken >= OVERVIEW_RANKED_PER_FILE) continue;
    perFile.set(file, taken + 1);
    ranked.push(line);
  }
  const shown = new Set(ranked.map((line) => /^(.*?):\d+:/.exec(line)?.[1] ?? line));
  const rest = symbolLines.filter((line) => !shown.has(/^(.*?):\d+:/.exec(line)?.[1] ?? line));
  return [...ranked, ...spreadAcrossFiles(rest, budget - ranked.length)];
};

export async function executeRepositoryTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, key } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'code_search': {
      const query = textValue(call.arguments.query);
      const path = textValue(call.arguments.path, 'workspace');
      const maxResults = clampNumber(call.arguments.maxResults, {
        min: 1,
        max: 500,
        fallback: 120
      });
      /**
       * Whole-word matching is ripgrep's own flag; taking the query literally is a separate one.
       *
       * They used to be the same flag, and that was the old symbol tool's bug wearing a new
       * cause. That tool wrapped the name in `\b...\b`, which is wrong for exactly the names it
       * existed to find: a word boundary before `$` needs a word character in front of it, so
       * `$scope` never matched. It returned nothing and looked like an answer. With `--fixed-
       * strings` only on the wholeWord branch, the default path still returned nothing for
       * `$scope.value` - now because `$` is an end-of-line anchor - and worse, `foo(bar)` matched
       * `foobar()` and missed the call it meant. rg exits 0 or 1 on both, so nothing threw.
       */
      const wholeWord = call.arguments.wholeWord === true;
      const literal = call.arguments.literal === true || wholeWord;
      const glob = textValue(call.arguments.glob).trim();
      /**
       * A model with no glob to give sends the string "null" or "none" as readily as it omits the
       * field, and `--glob null` matches no file at all - one more empty result that reads as an
       * answer. Guarded here rather than in textValue, whose other callers include `query`, where
       * "null" is an ordinary thing to go looking for.
       */
      const useGlob = glob !== '' && !['null', 'none', 'undefined'].includes(glob.toLowerCase());
      const search = async (fixedStrings: boolean): Promise<string[]> => {
        const args = [
          '--line-number',
          '--column',
          '--no-heading',
          // Both cuts below - the runner's byte cap and this arm's own `slice(0, maxResults)` -
          // keep a prefix of whatever order arrives, so the order is settled before either.
          ...SETTLED_ORDER,
          '--color',
          'never',
          '--smart-case',
          ...(fixedStrings ? ['--fixed-strings'] : []),
          ...(wholeWord ? ['--word-regexp'] : []),
          ...(useGlob ? ['--glob', glob] : []),
          '--',
          query,
          '.'
        ];
        const result = await context.runner.call<ExecObservation>(
          task.workspaceId,
          task.id,
          'exec',
          `${root}/exec`,
          { executable: 'rg', args, cwd: path, timeoutSeconds: 60 }
        );
        if (![0, 1].includes(result.exitCode ?? -1))
          throw new AthanorError('code_search_failed', result.stderr || 'Code search failed');
        return result.stdout.split('\n').filter(Boolean);
      };
      let matches = await search(literal);
      /**
       * Nothing found, and the query has regex punctuation in it: read it again as text.
       *
       * The description says which engine this is, but a description is advice and an empty
       * result is a silent wrong answer. This costs one extra rg only in the case that has
       * already failed, and it needs no guess about what the model meant - a regex reading that
       * matched nothing is not a reading worth defending.
       */
      let searchedLiterally = literal;
      if (matches.length === 0 && !literal && /[[\](){}.*+?|^$\\]/.test(query)) {
        const retried = await search(true);
        if (retried.length > 0) {
          matches = retried;
          searchedLiterally = true;
        }
      }
      const files = groupByFile(matches);
      /*
       * The refusal, before any of the three answers below.
       *
       * Past a hundred files there is no shape this call can come back in that a model could act
       * on: the lines are a wall, and the list of files is a wall too. So it is refused rather than
       * answered, in the one form the model can do something with - the count it hit, and the
       * levers that make it smaller. A refusal reaches the model as `Tool failed: <message>` and
       * counts toward `repeatedFailures`, which is the right accounting: a model that sends the
       * byte-identical too-broad search again has learned nothing from being told, and that is
       * exactly the loop the repeat detector exists to end.
       *
       * Nothing of the model's own is interpolated. `query` is model-supplied and unbounded, and an
       * error message is owner-facing prose in the journal as well as model-facing text here; the
       * count and the lever names are this file's own words and say everything the model needs.
       */
      if (files.size > CODE_SEARCH_FILE_CEILING)
        throw new AthanorError(
          'code_search_too_broad',
          `${files.size} files match, past the ${CODE_SEARCH_FILE_CEILING} this tool will list - please narrow your search: give path or glob, set wholeWord, or search for a longer string.`
        );
      /*
       * Collapse when there is a file to choose, and not otherwise.
       *
       * `files.size > 1` is what makes the narrowing terminate, and it is the whole reason the
       * condition is not simply a line count. Without it, a model told "pick a file and narrow to
       * it" narrows to that file, gets 300 lines in it, and is collapsed again to the single row it
       * already had - a loop with no exit inside this tool. With it, narrowing to one file always
       * returns lines, so the advice the description gives is advice that can be taken.
       *
       * It is also the honest reading of the finding: a result in one file poses no choice, so
       * there is no choosing for the extra context to degrade. `summary` stays available for the
       * model that wants the surface anyway, and means what it says rather than doubling as the
       * off switch for this collapse - a schema bound that is not the bound the runtime applies is
       * the defect this file has been through twice already.
       */
      if (
        call.arguments.summary === true ||
        (files.size > 1 && matches.length > CODE_SEARCH_COLLAPSE_LINES)
      )
        return {
          query,
          path,
          literal: searchedLiterally,
          summarised: true,
          files: [...files]
            .sort(([leftPath, left], [rightPath, right]) =>
              right === left ? leftPath.localeCompare(rightPath) : right - left
            )
            .map(([file, count]) => ({ path: file, matches: count })),
          totalFiles: files.size,
          totalMatches: matches.length
        };
      return {
        query,
        path,
        literal: searchedLiterally,
        matches: matches.slice(0, maxResults),
        totalReturned: Math.min(matches.length, maxResults),
        truncated: matches.length > maxResults
      };
    }
    case 'repo_overview': {
      const path = textValue(call.arguments.path, 'workspace');
      const maxFiles = clampNumber(call.arguments.maxFiles, { min: 20, max: 1_000, fallback: 400 });
      const run = (executable: string, args: string[]) =>
        context.runner.call<ExecObservation>(task.workspaceId, task.id, 'exec', `${root}/exec`, {
          executable,
          args,
          cwd: path,
          timeoutSeconds: 90
        });
      const [status, tracked, symbols, imports, instructions] = await Promise.all([
        run('git', ['status', '--short', '--branch']),
        run('git', ['ls-files']),
        run('rg', [
          '--line-number',
          '--no-heading',
          // `spreadAcrossFiles` keeps 300 of these, so without a settled order the overview is a
          // sample of whichever directories finished first: 1/20 runs agreed with the first, and
          // `IDEMPOTENT_WITHIN_TURN` called this a pure function of the workspace throughout.
          ...SETTLED_ORDER,
          '--color',
          'never',
          ...SOURCE_GLOBS,
          '^(export\\s+)?(abstract\\s+)?(class|interface|type|function|const|def|fn|struct|enum|trait)\\s+',
          '.'
        ]),
        /*
         * The reference sweep, over the same source files as the symbol sweep so that a name it
         * counts is a name the other one can place. It is the cheaper of the two - measured over
         * five runs each on this repository, 44 ms against the symbol sweep's 57 ms - and it runs
         * beside it here, so what it adds to a call bounded at 90 seconds is nothing.
         */
        run('rg', [
          '--multiline',
          '--no-filename',
          '--no-line-number',
          '--no-heading',
          ...SETTLED_ORDER,
          '--color',
          'never',
          ...SOURCE_GLOBS,
          IMPORT_SWEEP_PATTERN,
          '.'
        ]),
        run('rg', [
          '--files',
          /*
           * The one call here whose whole output is returned, and it is sorted anyway.
           *
           * Nothing cuts this list, so no instruction file can be lost to the order - but the
           * result it lands in is `repo_overview`, which `IDEMPOTENT_WITHIN_TURN` names a pure
           * function of the workspace, and it is cache-resident for the rest of the turn. Twelve
           * paths that come back in a different order on 19 of 20 runs make that claim false and
           * move the block every time the overview is read again. Measured cost of settling it:
           * 8.8 ms -> 9.2 ms, because the glob has already cut the walk down to twelve rows.
           */
          ...SETTLED_ORDER,
          '--glob',
          'AGENTS.md',
          '--glob',
          'CONTRIBUTING.md',
          '--glob',
          'README*'
        ])
      ]);
      let files = tracked.stdout.split('\n').filter(Boolean);
      if (!files.length) {
        /*
         * The untracked branch, which had the tracked branch's ordering guarantee and nothing that
         * provided it. `git ls-files` reads a path-sorted index and measured 20/20 identical over
         * twenty runs, so the stride below is a defined sample of a defined order for a repository
         * with a working tree. For one without - a downloaded folder, a fresh `mkdir`, a checkout
         * whose `.git` the agent has not made yet - it was taking 400 of 1,071 paths out of a walk
         * that agreed with itself 1/20 times.
         */
        const discovered = await run('rg', ['--files', ...SETTLED_ORDER]);
        files = discovered.stdout.split('\n').filter(Boolean);
      }
      const symbolLines = symbols.stdout.split('\n').filter(Boolean);
      const shownSymbols = rankByReference(symbolLines, imports.stdout, OVERVIEW_SYMBOL_BUDGET);
      return {
        path,
        versionControl: status.stdout.trim() || 'No Git working tree detected',
        files: strideAcross(files, maxFiles),
        fileCount: files.length,
        filesTruncated: files.length > maxFiles,
        importantSymbols: shownSymbols,
        symbolsTruncated: symbolLines.length > shownSymbols.length,
        // What the overview is standing for, so a model can tell "this repository has 622 files"
        // from "I was shown symbols from 300 of them" rather than inferring coverage it does not
        // have. The old shape reported truncation and left the reader to assume it was even.
        symbolCount: symbolLines.length,
        filesRepresented: new Set(shownSymbols.map((line) => /^(.*?):\d+:/.exec(line)?.[1])).size,
        instructionFiles: instructions.stdout.split('\n').filter(Boolean)
      };
    }
    case 'code_diagnostics': {
      const path = textValue(call.arguments.path, 'workspace');
      const requested = textValue(call.arguments.language, 'auto');
      /*
       * Through the shared clamp, because this number ends up in a JSON body and `NaN` does not
       * survive that trip as a number: `JSON.stringify` writes it as `null`, so a timeout the
       * model spelled wrong reached the runner as an absent field rather than as the floor it had
       * just been clamped by. The bound that silently disappears is the same family as the
       * schedule ceiling that never fires, arriving through serialisation instead of arithmetic.
       */
      const timeoutSeconds = clampNumber(call.arguments.timeoutSeconds, {
        min: 10,
        max: 1_800,
        fallback: 300
      });
      const listing = await context.runner.call<{ entries: Array<{ name: string }> }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/files?path=${encodeURIComponent(path)}`
      );
      const names = new Set(listing.entries.map((entry) => entry.name));
      /*
       * The ladder and the command table live in `tools/diagnostics.ts`, and this is now their only
       * caller.
       *
       * They moved there so the approval floor could read the same answer this call was about to
       * act on - two copies would have been two answers, and the one the owner was asked about
       * would have been the wrong one. That reason is gone: the `code_diagnostics` card was removed
       * and `approval-floor.ts` no longer takes a listing of its own, so nothing else reads this
       * table. They stay a leaf anyway, for the reason written at the top of that file: it imports
       * nothing, so a test that asks what a `Cargo.toml` resolves to does not drag `tool-dispatch`
       * and the runner client in behind it.
       *
       * What replaced the card is `REPEATABLE_TOOLS_THAT_WRITE` in `turn-bounds.ts`, which takes the
       * turn's undo point before this arm runs - measured, because `make -s` and `cargo check` write
       * to the tree and this tool was exempt from that undo point while they did.
       */
      const language = diagnosticsLanguage(requested, names);
      const command = diagnosticsCommand(language, names);
      if (!command)
        return {
          available: false,
          reason:
            'No supported project marker was found. Use the shell tool for a repository-specific diagnostic command.'
        };
      const result = await context.runner.call<ExecObservation>(
        task.workspaceId,
        task.id,
        'exec',
        `${root}/exec`,
        {
          ...command,
          cwd: path,
          timeoutSeconds,
          maxOutputBytes: 4_000_000
        }
      );
      return {
        available: true,
        language,
        command: [command.executable, ...command.args],
        passed: result.exitCode === 0 && !result.timedOut,
        ...result
      };
    }
    case 'coding_agent': {
      const action = textValue(call.arguments.action);
      const agent = textValue(call.arguments.agent);
      if (!['codex', 'claude', 'opencode'].includes(agent))
        throw new AthanorError('coding_agent_invalid', 'Choose Codex, Claude Code, or OpenCode');
      const subscriptionAgent = agent as SubscriptionAgent;
      const agentName = subscriptionAgentName(subscriptionAgent);
      const executable = subscriptionAgentExecutable(subscriptionAgent);
      const run = (args: string[], options: Record<string, unknown> = {}) =>
        context.runner.call<ExecObservation>(task.workspaceId, task.id, 'exec', `${root}/exec`, {
          executable,
          args,
          cwd: textValue(call.arguments.cwd, 'workspace'),
          timeoutSeconds: clampNumber(call.arguments.timeoutSeconds, {
            min: 30,
            max: 3_600,
            fallback: 900
          }),
          maxOutputBytes: 4_000_000,
          ...options
        });
      if (action === 'status') {
        const version = await run(['--version'], { timeoutSeconds: 30 }).catch(
          (cause: unknown) => ({
            exitCode: null,
            signal: null,
            stdout: '',
            stderr: cause instanceof Error ? cause.message : 'CLI is not installed',
            durationMs: 0,
            timedOut: false
          })
        );
        if (version.exitCode !== 0)
          return {
            agent,
            installed: false,
            authenticated: false,
            setupAction: { action: 'setup', agent },
            loginCommand: subscriptionAgentLoginCommand(subscriptionAgent)
          };
        const auth = await run(subscriptionAgentStatusArgs(subscriptionAgent), {
          timeoutSeconds: 30
        }).catch(() => undefined);
        const authText = `${auth?.stdout ?? ''}\n${auth?.stderr ?? ''}`;
        const authenticated =
          auth?.exitCode === 0 &&
          !/not logged|not authenticated|login required|signed out|no credentials|0 credentials/i.test(
            authText
          ) &&
          (agent !== 'opencode' || Boolean(authText.trim()));
        return {
          agent,
          installed: true,
          version: version.stdout.trim() || version.stderr.trim(),
          authenticated,
          authStatus: authText.trim().slice(0, 2_000) || 'Run the login command to confirm access.',
          loginCommand: subscriptionAgentLoginCommand(subscriptionAgent),
          loginInstructions:
            'Open the Terminal pane, run the login command, and complete the publisher’s browser flow. athanor never receives the password or OAuth token.'
        };
      }
      if (action === 'setup') {
        const packageName = subscriptionAgentPackage(subscriptionAgent);
        const installed = await context.runner.call<ExecObservation>(
          task.workspaceId,
          task.id,
          'exec',
          `${root}/exec`,
          {
            executable: 'npm',
            args: ['install', '--prefix', '.athanor/tools', packageName],
            cwd: 'workspace',
            network: true,
            timeoutSeconds: 900,
            maxOutputBytes: 2_000_000
          }
        );
        if (installed.exitCode !== 0)
          throw new AthanorError(
            'coding_agent_setup_failed',
            installed.stderr || `Could not install ${packageName}`
          );
        const version = await run(['--version'], { timeoutSeconds: 30 });
        return {
          agent,
          installed: version.exitCode === 0,
          version: version.stdout.trim() || version.stderr.trim(),
          authenticated: false,
          next:
            agent === 'codex'
              ? 'Open Terminal and run codex login to connect a ChatGPT subscription.'
              : agent === 'claude'
                ? 'Open Terminal and run claude to connect a Claude Pro or Max subscription.'
                : 'Open Terminal and run opencode auth login. OpenCode supports ChatGPT Plus, GitHub Copilot, GitLab Duo, provider API keys, and other publisher-supported logins.'
        };
      }
      if (action === 'run') {
        if (task.privacyRoute === 'provider_zdr')
          throw new AthanorError(
            'coding_agent_privacy_conflict',
            'This task requires zero-retention model routing. Subscription coding CLIs have their own publisher data policies, so Athanor will not send this private task to one. Use the main coding tools here, or start a standard-privacy task if you deliberately want that specialist.'
          );
        const prompt = boundedKnowledge(call.arguments.prompt, 100_000);
        if (!prompt.trim())
          throw new AthanorError('coding_agent_prompt_empty', 'A coding mission is required');
        const sessionId = textValue(call.arguments.sessionId).trim();
        const maxTurns = clampNumber(call.arguments.maxTurns, { min: 1, max: 40, fallback: 12 });
        const args = buildSubscriptionAgentArgs({
          agent: subscriptionAgent,
          prompt,
          ...(sessionId ? { sessionId } : {}),
          maxTurns
        });
        // The same clamp as the `run` helper above, and the one whose value actually reaches the
        // runner: every call site of that helper overrides its timeout, this one does not.
        const timeoutSeconds = clampNumber(call.arguments.timeoutSeconds, {
          min: 30,
          max: 3_600,
          fallback: 900
        });
        const startedAt = Date.now();
        let process = await context.runner.call<ProcessObservation>(
          task.workspaceId,
          task.id,
          'exec',
          `${root}/processes/start`,
          {
            executable,
            args,
            cwd: textValue(call.arguments.cwd, 'workspace'),
            env: subscriptionAgentRunEnvironment(subscriptionAgent),
            timeoutSeconds,
            maxOutputBytes: 4_000_000,
            network: true
          }
        );
        let reportedEvents = 0;
        let pollCount = 0;
        while (process.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          pollCount += 1;
          process = await context.runner.call<ProcessObservation>(
            task.workspaceId,
            task.id,
            'exec',
            `${root}/processes/${encodeURIComponent(process.sessionId)}`,
            { action: 'poll' }
          );
          if (pollCount % 5 === 0) {
            const latestTask = await context.store.getTask(task.userId, task.id);
            if (latestTask && ['cancelled', 'paused'].includes(latestTask.status)) {
              await context.runner.call(
                task.workspaceId,
                task.id,
                'exec',
                `${root}/processes/${encodeURIComponent(process.sessionId)}`,
                { action: 'kill' }
              );
              throw new AthanorError(
                'coding_agent_interrupted',
                `${agentName} stopped with the athanor task`
              );
            }
          }
          const observedEvents = (process.stdout ?? '')
            .split('\n')
            .filter((line) => line.trim().startsWith('{')).length;
          if (observedEvents >= reportedEvents + 8) {
            reportedEvents = observedEvents;
            await event(
              context.store,
              task,
              key,
              'status',
              `${agentName} is working in the repository`,
              { agent, observedEvents }
            );
          }
        }
        const result: ExecObservation = {
          exitCode: process.exitCode ?? null,
          stdout: process.stdout ?? '',
          stderr: process.stderr ?? '',
          durationMs: Date.now() - startedAt,
          timedOut: process.status === 'timed_out'
        };
        const records = result.stdout
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Record<string, unknown>];
            } catch {
              return [];
            }
          });
        const claudeResult =
          agent === 'claude'
            ? (records.at(-1) ??
              (() => {
                try {
                  return JSON.parse(result.stdout) as Record<string, unknown>;
                } catch {
                  return undefined;
                }
              })())
            : undefined;
        const codexMessages = records.flatMap((record) => {
          const item =
            record.item && typeof record.item === 'object'
              ? (record.item as Record<string, unknown>)
              : undefined;
          return item?.type === 'agent_message' && typeof item.text === 'string' ? [item.text] : [];
        });
        const openCodeMessages =
          agent === 'opencode'
            ? records.flatMap((record) => {
                const data =
                  record.data && typeof record.data === 'object'
                    ? (record.data as Record<string, unknown>)
                    : undefined;
                const partValue = record.part ?? data?.part;
                const part =
                  partValue && typeof partValue === 'object'
                    ? (partValue as Record<string, unknown>)
                    : undefined;
                return record.type === 'text' && typeof part?.text === 'string' ? [part.text] : [];
              })
            : [];
        const openCodeSessionId =
          agent === 'opencode'
            ? records
                .flatMap((record) => {
                  const data =
                    record.data && typeof record.data === 'object'
                      ? (record.data as Record<string, unknown>)
                      : undefined;
                  const partValue = record.part ?? data?.part;
                  const part =
                    partValue && typeof partValue === 'object'
                      ? (partValue as Record<string, unknown>)
                      : undefined;
                  const value = record.sessionID ?? data?.sessionID ?? part?.sessionID;
                  return typeof value === 'string' ? [value] : [];
                })
                .at(-1)
            : undefined;
        const summary =
          (typeof claudeResult?.result === 'string' ? claudeResult.result : undefined) ??
          codexMessages.at(-1) ??
          openCodeMessages.at(-1) ??
          result.stdout.slice(-16_000);
        /**
         * The reason, wherever the agent chose to put it.
         *
         * These CLIs report failure on stdout as their last JSON record and leave stderr empty -
         * an unauthenticated run exits 1 having written "Not logged in - please run /login" and
         * nothing else. Reading only stderr turned that into "exited without completing", which
         * tells the owner nothing about the one thing they have to do. The parse happens before
         * this check so the failure can be read out of the same records the success is.
         */
        if (result.exitCode !== 0 || claudeResult?.is_error === true)
          throw new AthanorError(
            'coding_agent_failed',
            [summary, result.stderr].map((text) => String(text ?? '').trim()).find(Boolean) ??
              `${agentName} exited without completing`
          );
        return {
          agent,
          completed: true,
          sessionId:
            typeof claudeResult?.session_id === 'string'
              ? claudeResult.session_id
              : typeof records[0]?.thread_id === 'string'
                ? records[0].thread_id
                : (openCodeSessionId ?? sessionId) || undefined,
          summary,
          eventCount: records.length,
          durationMs: result.durationMs,
          stderr: result.stderr.slice(-4_000)
        };
      }
      throw new AthanorError('coding_agent_action_invalid', 'Unknown coding agent action');
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
