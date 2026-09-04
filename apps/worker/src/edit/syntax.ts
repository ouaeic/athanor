/**
 * The fast syntax gate: does the file still parse, answered on the same turn as the edit.
 *
 * The largest measured single effect on a line-addressed editor in the published record is a
 * syntax check in the loop - three points absolute on a benchmark whose whole spread is twenty -
 * and it works by putting the error in front of the model on the turn it made it, rather than at
 * the type-check four to six seconds later or at the test run a step after that. The deferred
 * checker in `tools/diagnostics.ts` stays; this runs first, in-process, in tens of milliseconds,
 * and answers the one question that check cannot answer quickly: did this patch leave a file that
 * no parser will read.
 *
 * A NOTE, NEVER A REFUSAL. The reference design refuses the edit and keeps the file untouched.
 * That is the wrong answer here for the same reason the plain off-by-one is applied and echoed
 * rather than refused: a model mid-way through a two-patch change legitimately leaves a file
 * unparseable between the patches, and refusing the first would refuse the change. The file is
 * written, the first fault is named with its numbered line, and the model fixes it with one more
 * edit or was about to anyway.
 *
 * TWO LANGUAGES, on purpose. JSON needs nothing. JavaScript and TypeScript are checked through the
 * compiler that is already installed at the root of this repository for its own build - it is not
 * a dependency of the worker and it is not added as one: a worker deployed without it simply has
 * no gate for those files, and the gate says nothing rather than failing the edit. No other
 * language, because no other parser is on the box for free, and a dependency added to check
 * syntax would be building the expensive half first.
 */
import type * as TypeScript from 'typescript';
import { toLines } from './format.js';

export interface SyntaxFault {
  /** One-based line of the first fault. */
  readonly line: number;
  readonly message: string;
}

/** How much of a parser's message is worth carrying; the line number is the useful part. */
const MESSAGE_CHARS = 200;

const JSON_EXTENSIONS = new Set(['.json']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
};

const trimmed = (message: string): string =>
  message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS - 1)}…` : message;

/** The line a character offset falls on, one-based. */
const lineOfOffset = (text: string, offset: number): number =>
  toLines(text.slice(0, Math.max(0, offset))).length;

const checkJson = (text: string): SyntaxFault | undefined => {
  try {
    JSON.parse(text);
    return undefined;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'invalid JSON';
    // The engine names the line where it can and the offset where it cannot; either is exact.
    const named = /\(line (\d+) column \d+\)/.exec(message);
    const offset = /at position (\d+)/.exec(message);
    const line = named ? Number(named[1]) : offset ? lineOfOffset(text, Number(offset[1])) : 1;
    return { line: Math.max(1, line), message: trimmed(message) };
  }
};

type Compiler = typeof TypeScript;

let compiler: Promise<Compiler | undefined> | undefined;

/**
 * The compiler, loaded once and only when a script file is patched.
 *
 * Resolved by the ordinary parent-directory walk from wherever the worker runs, which reaches
 * the repository root's copy on a box installed with its development dependencies and nothing
 * anywhere else. A failed import is remembered as "no gate", not retried on every patch.
 */
const loadCompiler = (): Promise<Compiler | undefined> => {
  compiler ??= import('typescript')
    .then((loaded) => (loaded as { default?: Compiler }).default ?? (loaded as Compiler))
    .catch(() => undefined);
  return compiler;
};

const checkScript = async (path: string, text: string): Promise<SyntaxFault | undefined> => {
  const ts = await loadCompiler();
  if (!ts) return undefined;
  const extension = extensionOf(path);
  const output = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      // Only where the file can carry it: the option present and unset is itself a diagnostic.
      ...(extension === '.tsx' || extension === '.jsx' ? { jsx: ts.JsxEmit.Preserve } : {}),
      allowJs: true
    }
  });
  // A fault IN THE FILE, which is the only kind worth a line number: an option the compiler
  // disliked has no position and is this gate's mistake, not the model's.
  const first = output.diagnostics?.find(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file !== undefined
  );
  if (!first) return undefined;
  const line =
    first.file && first.start !== undefined
      ? first.file.getLineAndCharacterOfPosition(first.start).line + 1
      : 1;
  return { line, message: trimmed(ts.flattenDiagnosticMessageText(first.messageText, ' ')) };
};

/**
 * The first syntax fault in `text`, or undefined when it parses or when no parser is here for it.
 *
 * Undefined for an unknown extension and for a missing compiler alike: absence of a gate is not
 * evidence about the file, and a note that said "checked, fine" for a Python file would be a lie
 * the model would act on.
 */
export const checkSyntax = async (path: string, text: string): Promise<SyntaxFault | undefined> => {
  const extension = extensionOf(path);
  if (JSON_EXTENSIONS.has(extension)) return checkJson(text);
  if (SCRIPT_EXTENSIONS.has(extension)) return checkScript(path, text);
  return undefined;
};
