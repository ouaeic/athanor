/**
 * Applying a line-addressed patch, and refusing one that cannot be applied honestly.
 *
 * The shipped `file_patch` proves an edit is fresh by making the model quote the text it is
 * replacing: if the quote is not there exactly once, the edit does not land. That proof is carried
 * in output tokens, on every hunk, and it is inflated by whatever it takes to be unique.
 *
 * Here the proof is carried once per file, as the tag, and the RANGE carries no proof at all. That
 * makes the freshness check the whole safety story, so it is done properly:
 *
 *   - a tag that resolves to nothing was never issued by this harness. It is fabricated or carried
 *     across a session boundary, and it is refused without ever looking at a line number, because
 *     numbers taken from a file the model never read are numbers that will land somewhere.
 *   - a tag that resolves to a snapshot the live file has since diverged from is stale. The
 *     snapshot says exactly what the model was looking at, so the addressed lines are re-located
 *     in the live file BY CONTENT; a unique relocation is applied and reported, and anything else
 *     fails closed with fresh numbered context. Guessing here is the one failure that corrupts
 *     code rather than wasting a round trip.
 *   - every addressed line must be inside a window the model was actually shown. An edit to line
 *     400 of a file read to line 120 parses perfectly and lands on the wrong lines, which is why
 *     it is a refusal and not a warning.
 *
 * Every operation in a section resolves against the ORIGINAL numbering of that section's snapshot.
 * The model never has to simulate the effect of its own earlier hunks, which is the counting error
 * this format exists to remove; the ops are turned into disjoint splices and applied from the end
 * of the file backwards.
 *
 * A section is atomic. `file_patch` applies the hunks that match and reports the ones that do not,
 * which is right for independent quoted edits and wrong here: half a section's ops applied means
 * every remaining number in the model's head is off by the delta, so the retry is worse than the
 * failure. Sections are independent of each other and still apply independently.
 */
import { blockAt } from './block.js';
import { fileTag, renderNumbered } from './format.js';
import { parseEdit, type EditOp, type EditSection, type ParseFailure } from './parse.js';
import { SnapshotStore } from './snapshots.js';

export type EditFailure =
  | ParseFailure
  | { readonly kind: 'missing_file'; readonly path: string; readonly message: string }
  | { readonly kind: 'tag_missing'; readonly path: string; readonly message: string }
  | {
      readonly kind: 'tag_unknown';
      readonly path: string;
      readonly tag: string;
      readonly message: string;
    }
  | {
      readonly kind: 'tag_stale';
      readonly path: string;
      readonly tag: string;
      readonly message: string;
      readonly context: string;
    }
  | {
      readonly kind: 'unseen';
      readonly path: string;
      readonly from: number;
      readonly to: number;
      readonly message: string;
    }
  | { readonly kind: 'out_of_range'; readonly path: string; readonly message: string }
  | { readonly kind: 'overlap'; readonly path: string; readonly message: string }
  | {
      readonly kind: 'missing_register';
      readonly path: string;
      readonly register: string;
      readonly message: string;
    };

export interface EditOutcome {
  readonly ok: boolean;
  /** Final text per path; `null` where the section removed the file. */
  readonly files: ReadonlyMap<string, string | null>;
  /** The tag each written file now carries, so the next edit needs no second read. */
  readonly tags: ReadonlyMap<string, string>;
  /** Paths whose anchor was stale and whose lines were re-located by content. */
  readonly recovered: readonly string[];
  readonly failures: readonly EditFailure[];
}

/** How much of the live file comes back with a stale anchor, so a retry needs no extra read. */
const CONTEXT_LINES = 12;

interface Splice {
  readonly start: number;
  readonly remove: number;
  readonly insert: readonly string[];
  readonly order: number;
}

const numberedContext = (path: string, text: string, around: number): string => {
  const total = text.split('\n').length;
  return renderNumbered(path, text, {
    startLine: Math.max(1, around - CONTEXT_LINES),
    endLine: Math.min(total, around + CONTEXT_LINES)
  });
};

/**
 * Where the snapshot's lines `from..to` now live in the current text, if anywhere unambiguous.
 *
 * Exact content match on the whole block, one-based inclusive in, one-based inclusive out. Zero
 * matches means the region was itself edited; more than one means the region was duplicated, and
 * in both cases the harness does not know which the model meant.
 */
const relocate = (
  was: readonly string[],
  now: readonly string[],
  from: number,
  to: number
): { from: number; to: number } | undefined => {
  const wanted = was.slice(from - 1, to);
  if (!wanted.length) return undefined;
  const hits: number[] = [];
  for (let index = 0; index + wanted.length <= now.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1)
      if (now[index + offset] !== wanted[offset]) {
        same = false;
        break;
      }
    if (same) {
      hits.push(index + 1);
      if (hits.length > 1) return undefined;
    }
  }
  const only = hits[0];
  return only === undefined ? undefined : { from: only, to: only + wanted.length - 1 };
};

/** The line span an operation reads, before any remapping: what has to have been seen. */
const spanOf = (op: EditOp, lines: readonly string[]): { from: number; to: number } | undefined => {
  switch (op.kind) {
    case 'replace':
    case 'cut':
      return { from: op.from, to: op.to };
    case 'replaceBlock': {
      const found = blockAt(lines, op.at - 1);
      return { from: found.from + 1, to: found.to + 1 };
    }
    case 'insert':
    case 'paste':
      return { from: op.at, to: op.at };
    default:
      return undefined;
  }
};

const applySection = (
  section: EditSection,
  live: string,
  store: SnapshotStore
): { text: string | null; renameTo?: string; recovered: boolean } | { failures: EditFailure[] } => {
  const { path } = section;
  const ops = section.ops;
  const removes = ops.some((op) => op.kind === 'remove');
  const rename = ops.find((op) => op.kind === 'rename');
  const lineOps = ops.filter(
    (op) => op.kind !== 'remove' && op.kind !== 'rename'
  ) as readonly Exclude<EditOp, { kind: 'remove' } | { kind: 'rename' }>[];

  if (removes) {
    if (lineOps.length)
      return {
        failures: [
          {
            kind: 'overlap',
            path,
            message: `REM deletes ${path}; it cannot share a section with edits to the same file.`
          }
        ]
      };
    return { text: null, recovered: false };
  }

  if (!lineOps.length && rename) return { text: live, renameTo: rename.to, recovered: false };

  if (!section.tag)
    return {
      failures: [
        {
          kind: 'tag_missing',
          path,
          message: `The section for ${path} has no #tag. Take it from the header of the read that gave you these line numbers.`
        }
      ]
    };

  const resolution = store.resolve(path, section.tag, live);
  if (resolution.kind === 'unknown')
    return {
      failures: [
        {
          kind: 'tag_unknown',
          path,
          tag: section.tag,
          message: `#${section.tag} was never issued for ${path} in this session, so the line numbers beside it are not from any read of this file. Read the file and use the tag its header returns.`
        }
      ]
    };

  const source = resolution.snapshot.text.split('\n');
  const target = live.split('\n');
  const stale = resolution.kind === 'stale';

  const splices: Splice[] = [];
  const registers = new Map<string, readonly string[]>();
  const failures: EditFailure[] = [];

  // Registers are filled from the ORIGINAL text before anything moves, so a CUT and the PUT that
  // pastes it can be written in either order and mean the same thing.
  for (const op of lineOps) {
    if (op.kind !== 'cut' || !op.register) continue;
    registers.set(op.register, source.slice(op.from - 1, op.to));
  }

  for (const [order, op] of lineOps.entries()) {
    const span = spanOf(op, source);
    if (!span) continue;
    const highest = op.kind === 'insert' || op.kind === 'paste' ? source.length + 1 : source.length;
    if (span.from < 1 || span.to > highest) {
      failures.push({
        kind: 'out_of_range',
        path,
        message: `${path} has ${source.length} lines at #${section.tag}; this addresses ${span.from}${span.to === span.from ? '' : `.=${span.to}`}.`
      });
      continue;
    }
    if (!store.wasSeen(resolution.snapshot, span.from, Math.min(span.to, source.length))) {
      failures.push({
        kind: 'unseen',
        path,
        from: span.from,
        to: span.to,
        message: `You have not been shown ${path} lines ${span.from}-${span.to}; editing lines you have not read lands on whatever happens to be there. Read that range first.`
      });
      continue;
    }

    // On a stale anchor the addressed lines are found again by their content. Insert points are
    // relocated by the line they hang off, which is why an insert past the last line - where there
    // is no such line - cannot be recovered and says so.
    let placed = span;
    if (stale) {
      const anchorTo = Math.min(span.to, source.length);
      const moved = relocate(source, target, span.from, anchorTo);
      if (!moved) {
        failures.push({
          kind: 'tag_stale',
          path,
          tag: section.tag,
          message: `${path} has changed since #${section.tag}, and lines ${span.from}-${span.to} are no longer where they were - the text there is ${anchorTo > source.length ? 'past the end of the file' : 'gone or duplicated'}. Nothing was written. The file now reads:`,
          context: numberedContext(path, live, span.from)
        });
        continue;
      }
      placed = { from: moved.from, to: moved.to + (span.to - anchorTo) };
    }

    switch (op.kind) {
      case 'replace':
      case 'replaceBlock':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: op.body,
          order
        });
        break;
      case 'cut':
        splices.push({
          start: placed.from - 1,
          remove: placed.to - placed.from + 1,
          insert: [],
          order
        });
        break;
      case 'insert':
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: 0,
          insert: op.body,
          order
        });
        break;
      case 'paste': {
        const value = registers.get(op.register);
        if (!value) {
          failures.push({
            kind: 'missing_register',
            path,
            register: op.register,
            message: `@${op.register} was never filled: a PUT that pastes a register needs a CUT ... @${op.register} in the same patch.`
          });
          break;
        }
        splices.push({
          start: op.side === 'before' ? placed.from - 1 : placed.from,
          remove: 0,
          insert: value,
          order
        });
        break;
      }
    }
  }

  if (failures.length) return { failures };

  const sorted = [...splices].sort((left, right) =>
    left.start === right.start ? right.order - left.order : right.start - left.start
  );
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const later = sorted[index] as Splice;
    const earlier = sorted[index + 1] as Splice;
    if (earlier.start + earlier.remove > later.start)
      return {
        failures: [
          {
            kind: 'overlap',
            path,
            message: `Two operations in ${path} touch the same lines (${earlier.start + 1} and ${later.start + 1}). Ranges name original lines and must be disjoint; write one operation covering both.`
          }
        ]
      };
  }

  const out = [...target];
  for (const splice of sorted) out.splice(splice.start, splice.remove, ...splice.insert);
  return {
    text: out.join('\n'),
    ...(rename ? { renameTo: rename.to } : {}),
    recovered: stale
  };
};

/**
 * Applies a patch against the given file contents and records the result in the store.
 *
 * The store is both the freshness authority and the place the next tag comes from: every file this
 * writes is snapshotted at its new text with the whole file marked seen, so the model can edit
 * again from the tag in the response without a second read. That round trip is a real part of what
 * the format costs, and `evals/edit/` counts it.
 */
export const applyEdit = (
  source: string,
  files: ReadonlyMap<string, string>,
  store: SnapshotStore
): EditOutcome => {
  const parsed = parseEdit(source);
  if (!parsed.ok)
    return {
      ok: false,
      files: new Map(),
      tags: new Map(),
      recovered: [],
      failures: [parsed.failure]
    };

  const written = new Map<string, string | null>();
  const tags = new Map<string, string>();
  const recovered: string[] = [];
  const failures: EditFailure[] = [];

  for (const section of parsed.sections) {
    const current = written.get(section.path) ?? files.get(section.path);
    if (current === undefined || current === null) {
      failures.push({
        kind: 'missing_file',
        path: section.path,
        message: `${section.path} is not in the workspace. Check the path, or write the file before editing it.`
      });
      continue;
    }
    const result = applySection(section, current, store);
    if ('failures' in result) {
      failures.push(...result.failures);
      continue;
    }
    if (result.recovered) recovered.push(section.path);
    if (result.text === null) {
      written.set(section.path, null);
      continue;
    }
    const destination = result.renameTo ?? section.path;
    if (result.renameTo) written.set(section.path, null);
    written.set(destination, result.text);
    tags.set(destination, store.record(destination, result.text));
  }

  return { ok: !failures.length, files: written, tags, recovered, failures };
};

export { SnapshotStore, fileTag, renderNumbered };
