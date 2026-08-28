/**
 * What `code_diagnostics` will actually run, and which of those commands is the repository's own.
 *
 * This is one table read by two callers that must never disagree. `tools/repository.ts` runs the
 * command; `approval-policy.ts` decides whether the owner is asked first. While the ladder lived
 * only in the dispatch arm the floor could not see it at all - `code_diagnostics` appeared nowhere
 * in `approval-policy.ts`, in any security mode - so a tool that runs `go test ./...`, `make -s` and
 * `cargo check` ran them with nothing shown to anybody.
 *
 * A leaf module rather than an export from `repository.ts` because `approval-policy.ts` must import
 * it: `repository.ts` reaches `tool-dispatch.js`, and an import back the other way closes a cycle
 * whose evaluation order decides whether the floor reads an initialised table or throws on the
 * temporal dead zone. The same answer `CODE_SEARCH_COLLAPSE_LINES` records one file over.
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
   * `-I` is not decoration, and it is the reason Python is not on the carded table below.
   *
   * `python3 -m compileall` puts the working directory at the front of `sys.path`, so a repository
   * with a `compileall.py` at its root has that file imported and executed instead of the standard
   * library's - measured on this machine against CPython 3.10.10, where a `compileall.py` writing to
   * stderr produced its line and exit 0. `-I` is isolated mode: neither the script directory nor the
   * user site directory is on `sys.path`, the same run leaves the repository's file alone, and the
   * `__pycache__` entries for the real sources are still written. Without it Python would belong
   * beside `make` and `cargo`, and the card would be asking about a hole that can simply be closed.
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

/**
 * ONE SENTENCE, AND IT IS THE WHOLE RULE: the card fires on the languages whose diagnostic is the
 * project's own build or test recipe - where what runs is a file the repository author wrote - and
 * not on the languages where athanor names a fixed parser or type-checker that the repository's own
 * files cannot redirect.
 *
 * The value is what the owner is told decides it, because "this runs arbitrary code" is an adjective
 * and `build.rs` is a fact they can go and read. Presence in this table is the whole of the test:
 * a language here cards in every security mode, a language absent from it never cards, and
 * `diagnostics.test.ts` fails if the catalogue offers a language this table has not judged either
 * way.
 *
 * Measured on this machine rather than assumed, for the three that can be run here:
 *   - `make -s` on a Makefile whose default target writes a file wrote it (exit 0).
 *   - `cargo check --message-format short` on a crate with a `build.rs` that writes a file ran it
 *     (cargo 1.x, "Compiling x v0.1.0", then the file existed).
 *   - `ruby -e '...compile_file...'` over a script whose top level writes a file did NOT write it,
 *     which is why Ruby is absent: `RubyVM::InstructionSequence.compile_file` compiles and stops.
 *
 * The rest are the documented job of the command. `go test ./...` builds and runs the repository's
 * tests. `mvn compile` runs the plugins the `pom.xml` names, and `dotnet build` the tasks the
 * project file names. `gradle` evaluates `build.gradle` as a program, and the `gradlew` form is
 * worse than that: the executable is itself a script in the repository, which fetches and runs the
 * distribution its own properties file names. `swift build` compiles and runs `Package.swift` to
 * get the manifest. `Rscript` sources an `.Rprofile` from the working directory before it reaches
 * the parse loop the arguments ask for, so the repository chooses what runs even though the command
 * only means to parse. `terraform validate` launches the provider plugins under `.terraform` to read
 * their schemas, and those are executables sitting in the tree.
 *
 * Deliberately absent, and each for a reason rather than by omission: TypeScript and Python are the
 * two languages nearly all of this product's own work is in, and a card on them is a card tapped
 * through by Tuesday. `tsc --noEmit` type-checks and emits nothing; `python3 -I -m compileall`
 * byte-compiles in isolated mode and imports nothing of the repository's (see above). Julia, Ruby,
 * PHP and Dart are parse-and-analyse commands over files the repository supplies as *data*.
 */
export const REPOSITORY_DIRECTED_DIAGNOSTICS: Readonly<Record<string, string>> = {
  rust: 'a build.rs and the procedural macros the crate depends on, which cargo compiles and runs',
  go: "the repository's own test files, which go test compiles and runs",
  java: 'the pom.xml plugins, or build.gradle - and where a gradlew is present, a script in the repository itself',
  kotlin:
    'build.gradle - and where a gradlew is present, a script in the repository itself, which fetches the toolchain its properties file names',
  csharp: 'the build tasks the .csproj or .sln names, which MSBuild loads and runs',
  cpp: 'the recipes in the Makefile, or the custom commands in the generated CMake build',
  swift: 'Package.swift, which swift build compiles and runs to produce the manifest',
  r: 'an .Rprofile in this directory, which R runs at startup before it parses anything',
  terraform: 'the provider plugins under .terraform, which validate launches to read their schemas'
};

/** What in this repository decides what the diagnostic runs, or null when nothing there does. */
export const repositoryDirectedDiagnostic = (language: string): string | null =>
  REPOSITORY_DIRECTED_DIAGNOSTICS[language] ?? null;
