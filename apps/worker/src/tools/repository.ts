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
      const [status, tracked, symbols, instructions] = await Promise.all([
        run('git', ['status', '--short', '--branch']),
        run('git', ['ls-files']),
        run('rg', [
          '--line-number',
          '--no-heading',
          '--color',
          'never',
          '--glob',
          '!node_modules/**',
          '--glob',
          '!dist/**',
          '--glob',
          '!build/**',
          '--glob',
          '*.{ts,tsx,js,jsx,py,rs,go,java,kt,rb,php,cs,cpp,c,h,hpp,swift}',
          '^(export\\s+)?(abstract\\s+)?(class|interface|type|function|const|def|fn|struct|enum|trait)\\s+',
          '.'
        ]),
        run('rg', [
          '--files',
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
        const discovered = await run('rg', ['--files']);
        files = discovered.stdout.split('\n').filter(Boolean);
      }
      const symbolLines = symbols.stdout.split('\n').filter(Boolean);
      return {
        path,
        versionControl: status.stdout.trim() || 'No Git working tree detected',
        files: files.slice(0, maxFiles),
        fileCount: files.length,
        filesTruncated: files.length > maxFiles,
        importantSymbols: symbolLines.slice(0, 300),
        symbolsTruncated: symbolLines.length > 300,
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
      const language =
        requested !== 'auto'
          ? requested
          : names.has('tsconfig.json') || names.has('package.json')
            ? 'typescript'
            : names.has('pyproject.toml') || names.has('requirements.txt')
              ? 'python'
              : names.has('Cargo.toml')
                ? 'rust'
                : names.has('go.mod')
                  ? 'go'
                  : names.has('pom.xml') ||
                      names.has('build.gradle') ||
                      names.has('build.gradle.kts')
                    ? 'java'
                    : [...names].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))
                      ? 'csharp'
                      : names.has('CMakeLists.txt') || names.has('Makefile')
                        ? 'cpp'
                        : names.has('DESCRIPTION') || names.has('renv.lock')
                          ? 'r'
                          : names.has('Project.toml')
                            ? 'julia'
                            : names.has('Gemfile')
                              ? 'ruby'
                              : names.has('composer.json')
                                ? 'php'
                                : [...names].some((name) => name.endsWith('.tf'))
                                  ? 'terraform'
                                  : names.has('Package.swift')
                                    ? 'swift'
                                    : names.has('pubspec.yaml')
                                      ? 'dart'
                                      : '';
      let command: { executable: string; args: string[] } | undefined;
      if (language === 'typescript')
        command = names.has('pnpm-lock.yaml')
          ? { executable: 'pnpm', args: ['exec', 'tsc', '--noEmit', '--pretty', 'false'] }
          : {
              executable: 'npx',
              args: ['--no-install', 'tsc', '--noEmit', '--pretty', 'false']
            };
      else if (language === 'python')
        command = { executable: 'python3', args: ['-m', 'compileall', '-q', '.'] };
      else if (language === 'rust')
        command = { executable: 'cargo', args: ['check', '--message-format', 'short'] };
      else if (language === 'go') command = { executable: 'go', args: ['test', './...'] };
      else if (language === 'java')
        command = names.has('pom.xml')
          ? { executable: 'mvn', args: ['-q', '-DskipTests', 'compile'] }
          : names.has('gradlew')
            ? { executable: 'bash', args: ['./gradlew', 'compileJava', '--console=plain'] }
            : { executable: 'gradle', args: ['compileJava', '--console=plain'] };
      else if (language === 'kotlin')
        command = names.has('gradlew')
          ? { executable: 'bash', args: ['./gradlew', 'compileKotlin', '--console=plain'] }
          : { executable: 'gradle', args: ['compileKotlin', '--console=plain'] };
      else if (language === 'csharp')
        command = { executable: 'dotnet', args: ['build', '--nologo'] };
      else if (language === 'cpp')
        command =
          names.has('CMakeLists.txt') && names.has('build')
            ? { executable: 'cmake', args: ['--build', 'build'] }
            : { executable: 'make', args: ['-s'] };
      else if (language === 'r')
        command = {
          executable: 'Rscript',
          args: [
            '-e',
            'files <- list.files(".", pattern="\\\\.[Rr]$", recursive=TRUE, full.names=TRUE); files <- files[!grepl("/(renv|\\\\.git)/", files)]; invisible(lapply(files, function(file) parse(file=file))); cat(length(files), "R files parsed\\n")'
          ]
        };
      else if (language === 'julia')
        command = {
          executable: 'julia',
          args: [
            '--project=.',
            '-e',
            'for (root, dirs, files) in walkdir("."); filter!(name -> name != ".git", dirs); for file in files; endswith(file, ".jl") && Meta.parseall(read(joinpath(root, file), String)); end; end'
          ]
        };
      else if (language === 'ruby')
        command = {
          executable: 'ruby',
          args: [
            '-e',
            'Dir.glob("**/*.rb").reject { |file| file.start_with?("vendor/") }.each { |file| RubyVM::InstructionSequence.compile_file(file) }'
          ]
        };
      else if (language === 'php')
        command = {
          executable: 'php',
          args: [
            '-r',
            '$files=new RecursiveIteratorIterator(new RecursiveDirectoryIterator(".")); foreach($files as $file){if($file->isFile() && $file->getExtension()==="php"){token_get_all(file_get_contents($file->getPathname()), TOKEN_PARSE);}}'
          ]
        };
      else if (language === 'terraform')
        command = { executable: 'terraform', args: ['validate', '-no-color'] };
      else if (language === 'swift') command = { executable: 'swift', args: ['build'] };
      else if (language === 'dart') command = { executable: 'dart', args: ['analyze'] };
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
