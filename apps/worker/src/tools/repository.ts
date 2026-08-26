import { AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import {
  boundedKnowledge,
  event,
  textValue,
  type ExecObservation,
  type ProcessObservation
} from '../agent.js';
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
