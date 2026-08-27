/**
 * Turning one declared edit into what each format makes the model type.
 *
 * Both encoders are mechanical and neither is allowed to be clever. The search-and-replace encoder
 * is deliberately given the BEST encoding a model could produce - the smallest `oldText` that is
 * unique, searched over asymmetric context so it is never handed a larger block than it needs -
 * because the interesting question is whether the incumbent loses at its best, not whether it can
 * be made to look bad.
 *
 * The incumbent's semantics are not described here, they are checked against the shipped source.
 * `assertIncumbentSemantics` reads `apps/worker/src/tools/workspace.ts` and throws if the two lines
 * this file models - the exactly-once guard and the single replace - are no longer what ships. A
 * rig that keeps a private copy of the thing it is measuring reports a confident number about a
 * program that no longer exists.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blockAt } from '../../apps/worker/src/edit/block.js';
import { countOccurrences } from '../../apps/worker/src/values.js';
import type { Change, EditTask } from './corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceSource = path.resolve(here, '../../apps/worker/src/tools/workspace.ts');

/** The two lines of shipped behaviour this file reimplements, quoted from the module that ships. */
export const assertIncumbentSemantics = (): string => {
  const source = readFileSync(workspaceSource, 'utf8');
  const guard = 'if (countOccurrences(before, oldText) !== 1) {';
  const write = 'const after = before.replace(oldText, newText);';
  for (const line of [guard, write])
    if (!source.includes(line))
      throw new Error(
        `evals/edit models file_patch as "${line}", which apps/worker/src/tools/workspace.ts no longer contains. Re-read it before trusting any number this rig prints.`
      );
  return `${guard} / ${write}`;
};

/** A whole-line region, newline-terminated, which is how a model quotes lines out of a file. */
export const region = (lines: readonly string[], from: number, to: number): string =>
  lines
    .slice(from - 1, to)
    .map((line) => `${line}\n`)
    .join('');

/**
 * The smallest whole-line block containing `from..to` that occurs exactly once in `text`.
 *
 * Grown by total context first and then over every split of that context between the two sides, so
 * a target that is unique with one line above and none below is never charged for one below as
 * well. Undefined when no amount of context makes it unique, which is a file the incumbent cannot
 * edit here at all.
 */
export const minimalUnique = (
  lines: readonly string[],
  text: string,
  from: number,
  to: number
): { readonly from: number; readonly to: number } | undefined => {
  const last = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  for (let total = 0; total <= last; total += 1) {
    for (let up = 0; up <= total; up += 1) {
      const down = total - up;
      const start = from - up;
      const end = to + down;
      if (start < 1 || end > last) continue;
      if (countOccurrences(text, region(lines, start, end)) === 1) return { from: start, to: end };
    }
  }
  return undefined;
};

export interface ReplacePatch {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export interface LinePatchCall {
  readonly tool: 'file_edit';
  readonly args: { patch: string };
}

export type Encoded =
  | {
      readonly tool: 'file_patch';
      readonly args: { patches: ReplacePatch[] };
      /**
       * The lines each patch is actually replacing, beside the lines it had to quote to be unique.
       *
       * Not part of `args` and never counted: it exists so `selftest.ts` can check that no smaller
       * quote CONTAINING the target would have been unique. Without it the only way to check the
       * encoder is minimal is to call the function that decides minimality, which checks nothing.
       */
      readonly targets: ReadonlyArray<{
        target: { from: number; to: number };
        quote: { from: number; to: number };
      }>;
    }
  | { readonly tool: 'shell'; readonly args: { command: string } }
  | LinePatchCall;

/** Characters of the JSON arguments the model has to emit - the unit a provider bills on. */
export const emitted = (encoded: Encoded): number => JSON.stringify(encoded.args).length;

/**
 * The incumbent's encoding of a task: one patch per change, each against the text as the previous
 * patches in the same call left it, exactly as `workspace.ts` walks its `latestByPath`.
 *
 * A rename has no encoding at all - `file_patch` changes bytes inside a file and nothing else - so
 * it comes back as the `shell` call athanor actually uses for one.
 */
export const encodeReplace = (task: EditTask, read: string): Encoded => {
  if (task.changes.length === 1 && task.changes[0]?.kind === 'rename')
    return { tool: 'shell', args: { command: `mv ${task.path} ${task.changes[0].to}` } };

  const patches: ReplacePatch[] = [];
  const targets: Array<{
    target: { from: number; to: number };
    quote: { from: number; to: number };
  }> = [];
  let text = read;
  const push = (from: number, to: number, replacement: readonly string[]): void => {
    const lines = text.split('\n');
    const found = minimalUnique(lines, text, from, to);
    if (!found) throw new Error(`${task.id}: no unique oldText exists for lines ${from}-${to}`);
    const oldText = region(lines, found.from, found.to);
    const newText =
      region(lines, found.from, from - 1) +
      replacement.map((line) => `${line}\n`).join('') +
      region(lines, to + 1, found.to);
    patches.push({ path: task.path, oldText, newText });
    targets.push({ target: { from, to }, quote: { ...found } });
    text = text.replace(oldText, newText);
  };

  for (const change of task.changes) {
    switch (change.kind) {
      case 'replace':
        push(change.from, change.to, change.lines);
        break;
      case 'block': {
        const span = blockSpan(text, change.at);
        push(span.from, span.to, change.lines);
        break;
      }
      case 'insert': {
        const anchor = change.at;
        const lines = text.split('\n');
        const found = minimalUnique(lines, text, anchor, anchor);
        if (!found) throw new Error(`${task.id}: no unique anchor for an insert at ${anchor}`);
        const oldText = region(lines, found.from, found.to);
        const added = change.lines.map((line) => `${line}\n`).join('');
        const newText =
          change.side === 'after'
            ? region(lines, found.from, anchor) + added + region(lines, anchor + 1, found.to)
            : region(lines, found.from, anchor - 1) + added + region(lines, anchor, found.to);
        patches.push({ path: task.path, oldText, newText });
        targets.push({ target: { from: anchor, to: anchor }, quote: { ...found } });
        text = text.replace(oldText, newText);
        break;
      }
      case 'move': {
        const lines = text.split('\n');
        const moved = lines.slice(change.from - 1, change.to);
        push(change.from, change.to, []);
        // The destination anchor is addressed in the text the removal left behind, which is what
        // the model would be reasoning about too - `file_patch` applies its patches in order.
        const shifted =
          change.after > change.to ? change.after - (change.to - change.from + 1) : change.after;
        const now = text.split('\n');
        const found = minimalUnique(now, text, Math.max(1, shifted), Math.max(1, shifted));
        if (!found) throw new Error(`${task.id}: no unique anchor for the paste`);
        const oldText = region(now, found.from, found.to);
        const newText =
          region(now, found.from, shifted) +
          moved.map((line) => `${line}\n`).join('') +
          region(now, shifted + 1, found.to);
        patches.push({ path: task.path, oldText, newText });
        targets.push({ target: { from: shifted, to: shifted }, quote: { ...found } });
        text = text.replace(oldText, newText);
        break;
      }
      case 'rename':
        throw new Error(`${task.id}: a rename cannot share a call with text edits`);
    }
  }
  return { tool: 'file_patch', args: { patches }, targets };
};

/** The line-addressed encoding: the header, the tag, one operation per change, `+` bodies. */
export const encodeLines = (task: EditTask, tag: string): LinePatchCall => {
  const rows: string[] = [];
  const renameOnly = task.changes.length === 1 && task.changes[0]?.kind === 'rename';
  rows.push(renameOnly ? `[${task.path}]` : `[${task.path}#${tag}]`);
  for (const change of task.changes) {
    switch (change.kind) {
      case 'replace':
        rows.push(
          change.from === change.to ? `PUT ${change.from}:` : `PUT ${change.from}.=${change.to}:`
        );
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'block':
        rows.push(`PUT ${change.at}*:`);
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'insert':
        rows.push(`PUT ${change.side === 'after' ? '>' : '<'}${change.at}:`);
        rows.push(...change.lines.map((line) => `+${line}`));
        break;
      case 'move':
        rows.push(`CUT ${change.from}.=${change.to} @m`);
        rows.push(`PUT >${change.after} @m`);
        break;
      case 'rename':
        rows.push(`MV ${change.to}`);
        break;
    }
  }
  return { tool: 'file_edit', args: { patch: rows.join('\n') } };
};

/**
 * The block span the corpus means, computed with the same rule the applier uses.
 *
 * Imported rather than reimplemented so a change to how a block is found cannot make the incumbent
 * quote a different region from the one the candidate replaces, which would compare two edits.
 */
const blockSpan = (text: string, at: number): { from: number; to: number } => {
  const lines = text.split('\n');
  const found = blockAt(lines, at - 1);
  return { from: found.from + 1, to: found.to + 1 };
};

/** The incumbent's applier, faithful to `workspace.ts`: exactly once, then one replace. */
export const applyReplace = (
  patches: readonly ReplacePatch[],
  before: string
): { text: string; applied: number; failed: number } => {
  let text = before;
  let applied = 0;
  let failed = 0;
  for (const patch of patches) {
    if (countOccurrences(text, patch.oldText) !== 1) {
      failed += 1;
      continue;
    }
    text = text.replace(patch.oldText, patch.newText);
    applied += 1;
  }
  return { text, applied, failed };
};

/** The intended result: the declared changes applied to the text they were written against. */
export const intended = (task: EditTask, read: string): string => {
  const start = read.split('\n');
  const splices: Array<{ start: number; remove: number; insert: string[]; order: number }> = [];
  const order = { value: 0 };
  for (const change of task.changes) {
    order.value += 1;
    switch (change.kind) {
      case 'replace':
        splices.push({
          start: change.from - 1,
          remove: change.to - change.from + 1,
          insert: [...change.lines],
          order: order.value
        });
        break;
      case 'block': {
        const span = blockSpan(read, change.at);
        splices.push({
          start: span.from - 1,
          remove: span.to - span.from + 1,
          insert: [...change.lines],
          order: order.value
        });
        break;
      }
      case 'insert':
        splices.push({
          start: change.side === 'after' ? change.at : change.at - 1,
          remove: 0,
          insert: [...change.lines],
          order: order.value
        });
        break;
      case 'move': {
        const moved = start.slice(change.from - 1, change.to);
        splices.push({
          start: change.from - 1,
          remove: change.to - change.from + 1,
          insert: [],
          order: order.value
        });
        splices.push({ start: change.after, remove: 0, insert: moved, order: order.value + 1 });
        order.value += 1;
        break;
      }
      case 'rename':
        return read;
    }
  }
  const out = [...start];
  for (const splice of [...splices].sort((left, right) =>
    left.start === right.start ? right.order - left.order : right.start - left.start
  ))
    out.splice(splice.start, splice.remove, ...splice.insert);
  return out.join('\n');
};

export type { Change };
