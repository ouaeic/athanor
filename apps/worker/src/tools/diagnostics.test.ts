import { describe, expect, it } from 'vitest';
import { agentTools } from '../tool-catalogue.js';
import { CHECKPOINT_EXEMPT_TOOLS, REPEATABLE_TOOLS } from '../turn-bounds.js';
import { diagnosticsCommand, diagnosticsLanguage, diagnosticsSelection } from './diagnostics.js';

const catalogueLanguages = (): string[] => {
  const diagnostics = agentTools.find((tool) => tool.name === 'code_diagnostics');
  const properties = diagnostics?.parameters.properties as
    | Record<string, { enum?: string[] }>
    | undefined;
  return (properties?.language?.enum ?? []).filter((language) => language !== 'auto');
};

describe('what a diagnostic actually runs', () => {
  it('names a command for every language it offers, so none of them resolves to nothing', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    for (const language of offered)
      expect(diagnosticsCommand(language, new Set()), language).toBeDefined();
  });

  /**
   * The bound that replaced the approval card, asserted where the fifteen commands are written
   * down, because that is the only place a sixteenth will be added.
   *
   * This tool used to be exempt from the turn's undo point, on the reading that a tool safe to
   * replay is a tool that changed nothing. Measured on this machine, every command in the table
   * below can write: `make -s` wrote its target's file; `cargo check` left 50 new paths on a crate
   * with a writing `build.rs` and still left 16 - `Cargo.lock` and `target/` - on a crate with no
   * `build.rs` at all; `python3 -I -m compileall` leaves `__pycache__`; `tsc --noEmit` under
   * `incremental` leaves a `.tsbuildinfo`. Two of those four are languages the removed card called
   * safe, which is why the bound is the tool and not a list of languages.
   *
   * Both halves are asserted. Still repeatable - a second `make -s` tells the owner nothing new,
   * which is what keeps this tool batchable and replayable - and no longer exempt, so a turn of
   * nothing but diagnostics has something to rewind to. A language added to the catalogue inherits
   * the bound with no further decision, which is the point of keying it to the tool.
   */
  it('takes the turn’s undo point, in every language, because every one of them can write', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    expect(REPEATABLE_TOOLS.has('code_diagnostics')).toBe(true);
    expect(CHECKPOINT_EXEMPT_TOOLS.has('code_diagnostics')).toBe(false);
  });

  /**
   * The nine whose command is the project's own build or test recipe, each named by the command
   * rather than by a label. Nothing keys a card to this list any more - `shell` runs the identical
   * nine for free, so the card was a toll on the phrasing - but the commands themselves are the
   * product's promise about what a diagnostic does, and a silent change to one of them would change
   * what runs on a stranger's tree.
   */
  it('runs the project’s own build for the languages whose recipe the repository writes', () => {
    const commands = {
      rust: 'cargo check --message-format short',
      go: 'go test ./...',
      java: 'mvn -q -DskipTests compile',
      kotlin: 'gradle compileKotlin --console=plain',
      csharp: 'dotnet build --nologo',
      cpp: 'make -s',
      swift: 'swift build',
      terraform: 'terraform validate -no-color'
    };
    for (const [language, expected] of Object.entries(commands)) {
      const markers = language === 'java' ? new Set(['pom.xml']) : new Set<string>();
      const command = diagnosticsCommand(language, markers);
      expect([command?.executable, ...(command?.args ?? [])].join(' '), language).toBe(expected);
    }
  });

  /**
   * The gradle wrapper is the worst shape in the table and the one most easily lost: the executable
   * is `bash`, and the program is a file in the repository being diagnosed.
   */
  it('reaches for a script inside the repository when a gradle wrapper is present', () => {
    const command = diagnosticsCommand('java', new Set(['build.gradle', 'gradlew']));
    expect([command?.executable, ...(command?.args ?? [])].join(' ')).toBe(
      'bash ./gradlew compileJava --console=plain'
    );
  });

  /**
   * Isolated mode, asserted as the flag rather than as a comment about it.
   *
   * Without `-I`, `python3 -m compileall` puts the working directory at the front of `sys.path` and
   * a repository holding a `compileall.py` has that file imported and run. Measured on CPython
   * 3.10.10: the repository's file produced its output and the command still exited 0. With `-I`
   * the same tree compiles and the repository's file is left alone. It is the one hole in this
   * table that was closed rather than described, and a flag is the only kind of answer that keeps
   * costing nothing - so the flag is the thing being checked.
   */
  it('byte-compiles Python without putting the repository on the import path', () => {
    const command = diagnosticsCommand('python', new Set());
    expect([command?.executable, ...(command?.args ?? [])].join(' ')).toBe(
      'python3 -I -m compileall -q .'
    );
  });

  it('type-checks TypeScript with the workspace’s own package manager and emits nothing', () => {
    const pnpm = diagnosticsCommand('typescript', new Set(['package.json', 'pnpm-lock.yaml']));
    expect([pnpm?.executable, ...(pnpm?.args ?? [])].join(' ')).toBe(
      'pnpm exec tsc --noEmit --pretty false'
    );
    const npx = diagnosticsCommand('typescript', new Set(['package.json']));
    expect([npx?.executable, ...(npx?.args ?? [])].join(' ')).toBe(
      'npx --no-install tsc --noEmit --pretty false'
    );
  });

  it('picks the language from the marker file the directory holds', () => {
    const markers: Array<[string, string]> = [
      ['package.json', 'typescript'],
      ['pyproject.toml', 'python'],
      ['Cargo.toml', 'rust'],
      ['go.mod', 'go'],
      ['pom.xml', 'java'],
      ['Makefile', 'cpp'],
      ['Package.swift', 'swift'],
      ['main.tf', 'terraform']
    ];
    expect(markers.length).toBeGreaterThan(0);
    for (const [marker, language] of markers)
      expect(diagnosticsLanguage('auto', new Set([marker])), marker).toBe(language);
  });

  /**
   * A directory with nothing to recognise resolves to nothing, and that is an answer rather than a
   * gap: the dispatch arm returns `available: false` and executes no command at all.
   */
  it('resolves to no language, and so to no command, in a directory with no project marker', () => {
    expect(diagnosticsLanguage('auto', new Set(['notes.md']))).toBe('');
    expect(diagnosticsCommand('', new Set(['notes.md']))).toBeUndefined();
  });

  it('lets an explicitly named language stand rather than re-deriving it from the directory', () => {
    expect(diagnosticsLanguage('go', new Set(['package.json']))).toBe('go');
  });
});

/**
 * A command that fails for want of a project file is not a diagnostic, and the tool used to return
 * one as though it were.
 *
 * Measured on this machine, 2026-09-01. `pnpm exec tsc --noEmit --pretty false` at this
 * repository's own root - a `package.json`, no `tsconfig.json`, which is the shape the ladder
 * recognises as TypeScript and the shape the default `path` of `workspace` names - **exits 1 with
 * 4,994 bytes on stdout and 0 on stderr**, and the 4,994 bytes are the compiler's usage page:
 * "COMMON COMMANDS", the option list, `tsc --init`. It reached the model as `passed: false` with
 * output, which is what a wall of type errors looks like.
 *
 * The same shape, driven the same way in a `mktemp -d` holding only the marker named:
 *
 * | selected as | command | directory holds | exit | bytes |
 * | --- | --- | --- | --- | --- |
 * | `auto`, `package.json` | `tsc --noEmit` | no `tsconfig.json` | 1 | 4,994 |
 * | `auto`, `CMakeLists.txt` | `make -s` | no `Makefile`, no `build` | 2 | 61 |
 * | `language: 'rust'` | `cargo check` | no `Cargo.toml` | 101 | 153 |
 * | `language: 'swift'` | `swift build` | no `Package.swift` | 1 | 420 |
 *
 * And the other direction, which is why the table below is a table rather than one `if`: `ruby -e
 * Dir.glob(...)` with no `Gemfile` and `python3 -I -m compileall -q .` in an empty directory both
 * exit 0 with no output. Those commands take the DIRECTORY as their input, so requiring a project
 * file of them would refuse a diagnostic that works. R, Julia and PHP are the same recursive walk.
 */
describe('what a diagnostic refuses to run, and says instead', () => {
  /**
   * A directory that satisfies each language, so that a sixteenth cannot be added without someone
   * writing down what it needs before it will run.
   */
  const satisfied: Record<string, string[]> = {
    typescript: ['package.json', 'tsconfig.json'],
    python: ['pyproject.toml'],
    rust: ['Cargo.toml'],
    go: ['go.mod'],
    java: ['pom.xml'],
    kotlin: ['build.gradle'],
    csharp: ['app.csproj'],
    cpp: ['Makefile'],
    r: ['DESCRIPTION'],
    julia: ['Project.toml'],
    ruby: ['Gemfile'],
    php: ['composer.json'],
    terraform: ['main.tf'],
    swift: ['Package.swift'],
    dart: ['pubspec.yaml']
  };

  /**
   * The six whose command reads the directory rather than a project file. They are named here so
   * that tightening the rule onto one of them - which would refuse a diagnostic that runs today -
   * fails rather than passes quietly.
   */
  const needNoProjectFile = ['python', 'r', 'julia', 'ruby', 'php', 'dart'];

  it('runs the real command for every language it offers, given a directory that holds its project', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    for (const language of offered) {
      const names = satisfied[language];
      expect(names, `${language} has no directory written down that satisfies it`).toBeDefined();
      const selection = diagnosticsSelection(language, new Set(names));
      expect(selection.reason, language).toBeUndefined();
      expect(selection.command, language).toEqual(diagnosticsCommand(language, new Set(names)));
    }
  });

  it('answers with a sentence naming the missing file, and no command, in a bare directory', () => {
    const offered = catalogueLanguages();
    for (const language of offered) {
      const selection = diagnosticsSelection(language, new Set());
      if (needNoProjectFile.includes(language)) {
        expect(selection.command, language).toBeDefined();
        continue;
      }
      expect(selection.command, language).toBeUndefined();
      expect(selection.reason, language).toContain(language);
    }
  });

  /**
   * The defect itself, in both directions, at the two conditions that produced it: the marker the
   * ladder recognises is present and the file the command reads is not.
   */
  it('will not send tsc at a package.json with no tsconfig.json beside it', () => {
    const withoutConfig = diagnosticsSelection('typescript', new Set(['package.json']));
    expect(withoutConfig.command).toBeUndefined();
    expect(withoutConfig.reason).toContain('no tsconfig.json');
    expect(withoutConfig.reason).toContain('typescript');
    // The whole command, not its executable: `pnpm` and `npx` are what run `tsc`, and naming either
    // of them alone tells the reader the wrong program failed.
    expect(withoutConfig.reason).toContain('npx --no-install tsc --noEmit --pretty false');

    const withConfig = diagnosticsSelection(
      'typescript',
      new Set(['package.json', 'tsconfig.json', 'pnpm-lock.yaml'])
    );
    expect(withConfig.reason).toBeUndefined();
    expect([withConfig.command?.executable, ...(withConfig.command?.args ?? [])].join(' ')).toBe(
      'pnpm exec tsc --noEmit --pretty false'
    );
  });

  /**
   * The second condition the ladder reaches on its own, and the one that made the rule a negation
   * of the cmake condition rather than a check for a `build` entry.
   *
   * `CMakeLists.txt` names C++, but `cmake --build build` is chosen only when a configured `build`
   * directory is there too; every other C++ directory falls through to `make -s`. Three of these
   * four cases pass a `build` or a `CMakeLists.txt` and still have nothing for `make` to read - the
   * stray-`build` row is the one that a `!names.has('build')` rule would have walked straight past.
   */
  it('will not send make at a directory with no Makefile for it to read', () => {
    const cases: Array<[string[], string | undefined]> = [
      [['CMakeLists.txt'], undefined],
      [['build'], undefined],
      [['CMakeLists.txt', 'build'], 'cmake --build build'],
      [['CMakeLists.txt', 'Makefile'], 'make -s'],
      [['Makefile'], 'make -s']
    ];
    for (const [names, expected] of cases) {
      const selection = diagnosticsSelection('cpp', new Set(names));
      const ran = selection.command
        ? [selection.command.executable, ...selection.command.args].join(' ')
        : undefined;
      expect(ran, names.join('+')).toBe(expected);
      if (!expected) expect(selection.reason, names.join('+')).toContain('Makefile');
    }
  });

  /**
   * The requirement is checked whether the language came from the ladder or from the caller.
   *
   * `diagnosticsLanguage` lets a named language stand without re-deriving it, so `cargo check` in a
   * directory with no `Cargo.toml` - exit 101, 153 bytes - is reachable by one argument even though
   * the ladder would never have chosen Rust there. Same mistake, different author.
   */
  it('checks the project file for a language the caller named, not only one the ladder chose', () => {
    const cases: Array<[string, string]> = [
      ['rust', 'Cargo.toml'],
      ['go', 'go.mod'],
      ['java', 'pom.xml'],
      ['kotlin', 'build.gradle'],
      ['csharp', '.csproj'],
      ['swift', 'Package.swift'],
      ['terraform', '.tf']
    ];
    for (const [language, wanted] of cases) {
      const language_ = diagnosticsLanguage(language, new Set(['notes.md']));
      expect(language_).toBe(language);
      const selection = diagnosticsSelection(language_, new Set(['notes.md']));
      expect(selection.command, language).toBeUndefined();
      expect(selection.reason, language).toContain(wanted);
    }
  });

  /**
   * Two absences, two sentences. A directory holding nothing recognisable is a different answer
   * from one holding a marker whose command has no project to read, and the first sentence would
   * be false in the second directory - there is a `package.json` right there.
   */
  it('tells a directory with no marker apart from one whose command has no project', () => {
    expect(diagnosticsSelection('', new Set(['notes.md'])).reason).toBe(
      'No supported project marker was found. Use the shell tool for a repository-specific diagnostic command.'
    );
    expect(diagnosticsSelection('typescript', new Set(['package.json'])).reason).not.toContain(
      'No supported project marker'
    );
  });
});
