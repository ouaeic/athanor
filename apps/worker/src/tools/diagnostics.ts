/**
 * What `code_diagnostics` will actually run: fifteen languages, the marker each is recognised by,
 * and the one command each resolves to.
 *
 * ── What stops a cloned repository's build recipe, and what does not ───────────────────────────
 *
 * Stated here plainly because it used to be answered by an approval card, and a stated limit is
 * worth more than a card that asks about one of two doors.
 *
 * Nine of these fifteen commands are the project's own build or test recipe, so what executes is a
 * file whoever wrote the repository chose: `cargo check` compiles and runs `build.rs` and the
 * crate's procedural macros; `go test ./...` builds and runs the repository's tests; `make -s` runs
 * a Makefile target; `mvn compile` and `dotnet build` run the plugins and tasks the project file
 * names; `gradle` evaluates `build.gradle` as a program, and the `gradlew` form runs a script that
 * is itself in the tree; `swift build` compiles and runs `Package.swift`; `Rscript` sources an
 * `.Rprofile` from the working directory before it reaches the parse loop; `terraform validate`
 * launches the provider plugins under `.terraform`. The other six - TypeScript, Python, Julia,
 * Ruby, PHP, Dart - name a fixed parser or type-checker over files the repository supplies as data.
 *
 * WHAT STOPS IT: nothing in the approval floor, and that is deliberate. A card was tried here and
 * removed. `shell` runs the identical nine commands with no card in balanced or autonomous, so the
 * card asked about a shape the model reaches unasked one line over; `npm install` makes every
 * project's dependency tree foreign and the build then runs it, so a rule honest enough to call
 * `node_modules` a stranger's would card every build there is. Running someone else's code is the
 * job here, not the exception.
 *
 * WHAT DOES STOP IT: two bounds and one limit, none of them a question.
 *   1. The turn takes an undo point first. `code_diagnostics` is subtracted from
 *      `CHECKPOINT_EXEMPT_TOOLS` (`turn-bounds.ts`) by name, in every language, so the writes
 *      measured below are rewindable. This is the repair the card was standing in for.
 *   2. It runs under a bounded timeout - `clampNumber(timeoutSeconds, 10..1800, 300)` in the
 *      dispatch arm - and under `cwd: path`, whose default is `workspace`. Say what that confinement
 *      is and is not, because the difference decides whether bound 1 reaches: the runner's
 *      `resolveInside` refuses a path outside the CONTAINER HOME, not outside `workspace`, and
 *      `isUserData` is not applied to an exec cwd. So the ordinary call - `workspace`, or a
 *      directory under it - runs inside `CHECKPOINT_CONTENT` and is fully rewindable, and a call
 *      naming `.athanor/browser` would not be, since the roots pick that up only when
 *      `CHECKPOINT_INCLUDE_BROWSER_PROFILE` is on and it ships off. Nothing confines where the
 *      command writes once it has started; that is rung 0, below.
 *   3. And the limit, unhedged: beyond that, a build recipe runs with whatever this task can reach.
 *      The sandbox is an IDENTITY boundary and not a filesystem one. `scripts/athanor-sandbox` is
 *      `setpriv --reuid --regid --clear-groups --no-new-privs`; there is no bwrap, no landlock and
 *      no filter on what a command may open. `execution.ts` sets `HOME` to the workspace root,
 *      which is one level ABOVE `CHECKPOINT_CONTENT`, so a recipe that writes to `$HOME/.cargo` or
 *      `$HOME/.gradle` writes outside what bound 1 can rewind. And `ISOLATE_AGENT_NETWORK` ships
 *      false, so the recipe has the host's ordinary network access whatever the call declared.
 *      `docs/design/floor/DIAGNOSTICS.md` argues that rather than mentioning it: it is rung-0 work,
 *      it is not this wave's, and a card on rung 3 was never going to substitute for it.
 *
 * Measured on this machine rather than assumed, and it is why the bound is unconditional rather
 * than per-language: `make -s` on a Makefile whose target writes a file wrote it; `cargo check` on
 * a crate with a writing `build.rs` left 50 new paths and on a crate with NO `build.rs` at all
 * still left 16; and two of the six "parse only" languages write too - `python3 -I -m compileall`
 * leaves `__pycache__`, `tsc --noEmit` under `incremental` leaves a `.tsbuildinfo`. The nine/six
 * split is a fact about whose program runs. It was never the write/no-write split, and no bound
 * should be keyed to it.
 *
 * ── Why this is its own module ────────────────────────────────────────────────────────────────
 *
 * A leaf rather than an export from `repository.ts`, which is the only caller that runs these
 * commands: `repository.ts` imports `tool-dispatch.js`, so a test that wanted to ask what a
 * `Cargo.toml` resolves to would drag the dispatch table and the runner client in behind it. The
 * ladder and the table are the subject of their own suite and of the design note above, and they
 * are worth reading without that. The same answer `CODE_SEARCH_COLLAPSE_LINES` records one file
 * over.
 */

export interface DiagnosticsCommand {
  executable: string;
  args: string[];
}

/**
 * The project marker each language is recognised by, in the order the ladder tries them.
 *
 * Order is load-bearing and is the order the ladder always had: a repository with both a
 * `package.json` and a `Cargo.toml` is diagnosed as TypeScript, and moving `Cargo.toml` above it
 * would change which command runs on a real tree.
 */
export const diagnosticsLanguage = (requested: string, names: ReadonlySet<string>): string => {
  if (requested !== 'auto') return requested;
  if (names.has('tsconfig.json') || names.has('package.json')) return 'typescript';
  if (names.has('pyproject.toml') || names.has('requirements.txt')) return 'python';
  if (names.has('Cargo.toml')) return 'rust';
  if (names.has('go.mod')) return 'go';
  if (names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts'))
    return 'java';
  if ([...names].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) return 'csharp';
  if (names.has('CMakeLists.txt') || names.has('Makefile')) return 'cpp';
  if (names.has('DESCRIPTION') || names.has('renv.lock')) return 'r';
  if (names.has('Project.toml')) return 'julia';
  if (names.has('Gemfile')) return 'ruby';
  if (names.has('composer.json')) return 'php';
  if ([...names].some((name) => name.endsWith('.tf'))) return 'terraform';
  if (names.has('Package.swift')) return 'swift';
  if (names.has('pubspec.yaml')) return 'dart';
  return '';
};

export const diagnosticsCommand = (
  language: string,
  names: ReadonlySet<string>
): DiagnosticsCommand | undefined => {
  if (language === 'typescript')
    return names.has('pnpm-lock.yaml')
      ? { executable: 'pnpm', args: ['exec', 'tsc', '--noEmit', '--pretty', 'false'] }
      : { executable: 'npx', args: ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'] };
  /*
   * `-I` is not decoration, and it is the one place in this table where a hole was closed instead
   * of described.
   *
   * `python3 -m compileall` puts the working directory at the front of `sys.path`, so a repository
   * with a `compileall.py` at its root has that file imported and executed instead of the standard
   * library's - measured on this machine against CPython 3.10.10, where a `compileall.py` writing to
   * stderr produced its line and exit 0. `-I` is isolated mode: neither the script directory nor the
   * user site directory is on `sys.path`, and the same run leaves the repository's file alone.
   * Without it Python would be running a stranger's program the way `make` and `cargo` do, and no
   * amount of asking the owner about it would have been as good as the flag.
   *
   * The `__pycache__` entries for the real sources are still written, which is why Python does not
   * escape the undo point either: see `REPEATABLE_TOOLS_THAT_WRITE`.
   */
  if (language === 'python')
    return { executable: 'python3', args: ['-I', '-m', 'compileall', '-q', '.'] };
  if (language === 'rust')
    return { executable: 'cargo', args: ['check', '--message-format', 'short'] };
  if (language === 'go') return { executable: 'go', args: ['test', './...'] };
  if (language === 'java')
    return names.has('pom.xml')
      ? { executable: 'mvn', args: ['-q', '-DskipTests', 'compile'] }
      : names.has('gradlew')
        ? { executable: 'bash', args: ['./gradlew', 'compileJava', '--console=plain'] }
        : { executable: 'gradle', args: ['compileJava', '--console=plain'] };
  if (language === 'kotlin')
    return names.has('gradlew')
      ? { executable: 'bash', args: ['./gradlew', 'compileKotlin', '--console=plain'] }
      : { executable: 'gradle', args: ['compileKotlin', '--console=plain'] };
  if (language === 'csharp') return { executable: 'dotnet', args: ['build', '--nologo'] };
  if (language === 'cpp')
    return names.has('CMakeLists.txt') && names.has('build')
      ? { executable: 'cmake', args: ['--build', 'build'] }
      : { executable: 'make', args: ['-s'] };
  if (language === 'r')
    return {
      executable: 'Rscript',
      args: [
        '-e',
        'files <- list.files(".", pattern="\\\\.[Rr]$", recursive=TRUE, full.names=TRUE); files <- files[!grepl("/(renv|\\\\.git)/", files)]; invisible(lapply(files, function(file) parse(file=file))); cat(length(files), "R files parsed\\n")'
      ]
    };
  if (language === 'julia')
    return {
      executable: 'julia',
      args: [
        '--project=.',
        '-e',
        'for (root, dirs, files) in walkdir("."); filter!(name -> name != ".git", dirs); for file in files; endswith(file, ".jl") && Meta.parseall(read(joinpath(root, file), String)); end; end'
      ]
    };
  if (language === 'ruby')
    return {
      executable: 'ruby',
      args: [
        '-e',
        'Dir.glob("**/*.rb").reject { |file| file.start_with?("vendor/") }.each { |file| RubyVM::InstructionSequence.compile_file(file) }'
      ]
    };
  if (language === 'php')
    return {
      executable: 'php',
      args: [
        '-r',
        '$files=new RecursiveIteratorIterator(new RecursiveDirectoryIterator(".")); foreach($files as $file){if($file->isFile() && $file->getExtension()==="php"){token_get_all(file_get_contents($file->getPathname()), TOKEN_PARSE);}}'
      ]
    };
  if (language === 'terraform') return { executable: 'terraform', args: ['validate', '-no-color'] };
  if (language === 'swift') return { executable: 'swift', args: ['build'] };
  if (language === 'dart') return { executable: 'dart', args: ['analyze'] };
  return undefined;
};
