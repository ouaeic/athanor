import { describe, expect, it } from 'vitest';
import { agentTools } from '../tool-catalogue.js';
import {
  diagnosticsCommand,
  diagnosticsLanguage,
  repositoryDirectedDiagnostic,
  REPOSITORY_DIRECTED_DIAGNOSTICS
} from './diagnostics.js';

/**
 * The languages that may run without asking, written down here rather than derived, because the
 * whole value of this test is that the two halves are stated in different places by different
 * people and have to meet.
 *
 * Each is a fixed program athanor names, doing a fixed thing to files the repository supplies as
 * data. `tsc --noEmit` type-checks and emits nothing. `python3 -I -m compileall` byte-compiles in
 * isolated mode, which is what keeps a repository's own `compileall.py` off `sys.path`. Julia's
 * `Meta.parseall`, Ruby's `compile_file` and PHP's `token_get_all` parse and stop; `dart analyze`
 * analyses.
 */
const PARSE_ONLY = ['typescript', 'python', 'julia', 'ruby', 'php', 'dart'];

const catalogueLanguages = (): string[] => {
  const diagnostics = agentTools.find((tool) => tool.name === 'code_diagnostics');
  const properties = diagnostics?.parameters.properties as
    | Record<string, { enum?: string[] }>
    | undefined;
  return (properties?.language?.enum ?? []).filter((language) => language !== 'auto');
};

describe('what a diagnostic actually runs', () => {
  /**
   * The drift guard, and the reason this file exists at all.
   *
   * The floor decides whether to stop the turn from the language, so a language the catalogue
   * offers and this table has never judged is a language that runs its build with nothing shown to
   * anybody - which is exactly the state `code_diagnostics` was found in. Adding one to the
   * catalogue enum has to fail here until somebody has said which side it is on.
   */
  it('has judged every language the catalogue offers, one way or the other', () => {
    const offered = catalogueLanguages();
    // Counted before the two sets are compared, because a catalogue this could not read would
    // otherwise pass by covering nothing.
    expect(offered.length).toBeGreaterThanOrEqual(15);

    const judged = [...Object.keys(REPOSITORY_DIRECTED_DIAGNOSTICS), ...PARSE_ONLY].sort();
    expect(judged).toEqual([...offered].sort());
    expect(Object.keys(REPOSITORY_DIRECTED_DIAGNOSTICS).length).toBeGreaterThan(0);
    expect(PARSE_ONLY.length).toBeGreaterThan(0);
  });

  it('names a command for every language it offers, so none of them resolves to nothing', () => {
    const offered = catalogueLanguages();
    expect(offered.length).toBeGreaterThanOrEqual(15);
    for (const language of offered)
      expect(diagnosticsCommand(language, new Set()), language).toBeDefined();
  });

  /**
   * The nine that card, each named by the command that made them dangerous rather than by the label
   * on the branch. `make -s` and `cargo check` were both run against a repository whose recipe
   * wrote a file, and both wrote it; the rest are what these commands are documented to do.
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
      expect(repositoryDirectedDiagnostic(language), language).toBeTruthy();
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
   * the same tree compiles and the repository's file is left alone. Drop the flag and Python
   * belongs on the carded table, so the flag is the thing being checked.
   */
  it('byte-compiles Python without putting the repository on the import path', () => {
    const command = diagnosticsCommand('python', new Set());
    expect([command?.executable, ...(command?.args ?? [])].join(' ')).toBe(
      'python3 -I -m compileall -q .'
    );
    expect(repositoryDirectedDiagnostic('python')).toBeNull();
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
    expect(repositoryDirectedDiagnostic('typescript')).toBeNull();
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
    expect(repositoryDirectedDiagnostic('')).toBeNull();
  });

  it('lets an explicitly named language stand rather than re-deriving it from the directory', () => {
    expect(diagnosticsLanguage('go', new Set(['package.json']))).toBe('go');
  });
});
