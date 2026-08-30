import { describe, expect, it } from 'vitest';
import { agentTools } from '../tool-catalogue.js';
import { CHECKPOINT_EXEMPT_TOOLS, REPEATABLE_TOOLS } from '../turn-bounds.js';
import { diagnosticsCommand, diagnosticsLanguage } from './diagnostics.js';

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
