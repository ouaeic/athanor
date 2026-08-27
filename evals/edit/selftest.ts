/**
 * The checks the run itself cannot perform, and the one that decides whether any of it is honest.
 *
 *   NODE_OPTIONS=--conditions=development pnpm exec tsx evals/edit/selftest.ts
 *
 * A comparison of two encodings is worth nothing unless they encode the SAME edit. Nothing in the
 * table can tell you that: a by-line patch that quietly did less work would show up as a saving,
 * and it would look exactly like a real one. So the first check applies both encodings to a clean
 * copy of the file and demands the two results are byte-identical to each other and to the intended
 * text, which is computed a third way and read by neither encoder.
 *
 * The second check is the one the incumbent is owed. `minimalUnique` claims to hand `file_patch`
 * the smallest unique `oldText`; this proves it independently, by trying every narrower range that
 * still contains the lines being replaced and demanding that none of them is unique. If that ever
 * stops holding, every saving in the table is inflated by exactly the slack.
 *
 * Deliberately not a vitest file. A rig whose honesty depends on somebody having run its test suite
 * reports a confident wrong number on the machine where the suite was skipped - so this is a script
 * that exits non-zero, and the README tells you to run it.
 */
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { SnapshotStore } from '../../apps/worker/src/edit/snapshots.js';
import { fileText, TASKS } from './corpus.js';
import {
  applyReplace,
  encodeLines,
  encodeReplace,
  intended,
  minimalUnique,
  region
} from './encode.js';

const problems: string[] = [];
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

for (const task of TASKS) {
  const read = fileText(task.path);
  const lineCount = read.split('\n').length;
  const window = task.read ?? { startLine: 1, endLine: lineCount };
  const wanted = intended(task, read);
  const rename = task.changes.length === 1 && task.changes[0]?.kind === 'rename';

  if (!rename && wanted === read) problems.push(`${task.id}: the intended text is the original`);

  // Both encodings, against a CLEAN file, with no drift and no window narrowing. Drift and windows
  // are what the table measures; this is only asking whether the two encoders wrote the same edit.
  const store = new SnapshotStore();
  const tag = store.record(task.path, read);
  const byLine = applyEdit(encodeLines(task, tag).args.patch, new Map([[task.path, read]]), store);
  const destination = rename ? (task.changes[0] as { to: string }).to : task.path;
  const lineResult = byLine.files.get(destination);

  const quote = encodeReplace(task, read);
  const quoteResult =
    quote.tool === 'file_patch' ? applyReplace(quote.args.patches, read).text : read;

  if (!byLine.ok)
    problems.push(
      `${task.id}: the by-line encoding does not apply to a clean file - ${byLine.failures[0]?.kind}`
    );
  else if (lineResult !== wanted)
    problems.push(`${task.id}: the by-line encoding is not the declared edit`);
  if (quoteResult !== wanted)
    problems.push(`${task.id}: the quote encoding is not the declared edit`);
  if (byLine.ok && lineResult !== quoteResult)
    problems.push(`${task.id}: THE TWO ENCODINGS ARE DIFFERENT EDITS - the row compares nothing`);

  /*
   * Every quote the incumbent was given must be minimal, and "minimal" has to mean the right thing.
   *
   * A first attempt at this check shrank the quote by a line on each side and complained when the
   * shrunken text was still unique - and it complained about all three block edits, wrongly. The
   * quote for a block replacement IS the block: shrinking it means quoting less than the model is
   * replacing, which is not an encoding at all. The check is now over ranges that still CONTAIN the
   * target, which is the only kind of context there was ever a choice about.
   *
   * The patches are replayed in order, because `file_patch` applies them in order and the second
   * patch's numbers live in the text the first one left behind.
   */
  if (quote.tool === 'file_patch') {
    let text = read;
    for (const [index, patch] of quote.args.patches.entries()) {
      const spans = quote.targets[index];
      const lines = text.split('\n');
      if (spans) {
        const { target, quote: written } = spans;
        if (written.from > target.from || written.to < target.to)
          problems.push(`${task.id}: the quote does not contain the lines it replaces`);
        for (let from = written.from; from <= target.from; from += 1)
          for (let to = Math.max(target.to, from); to <= written.to; to += 1) {
            if (from === written.from && to === written.to) continue;
            if (count(text, region(lines, from, to)) === 1)
              problems.push(
                `${task.id}: lines ${from}-${to} would already have been unique, so quoting ${written.from}-${written.to} overcharges the incumbent`
              );
          }
      }
      text = text.replace(patch.oldText, patch.newText);
    }
  }

  if (window.endLine < lineCount && !task.note)
    problems.push(`${task.id}: reads only part of the file but does not say why`);
}

function count(source: string, value: string): number {
  let found = 0;
  let at = source.indexOf(value);
  while (at >= 0) {
    found += 1;
    at = source.indexOf(value, at + value.length);
  }
  return found;
}

// A last look at the tool the whole comparison rests on, exercised on the corpus rather than on a
// hand-made string: no target may be so repetitive that no unique quote exists, because a task the
// incumbent cannot express at all would have to be reported, not silently dropped.
for (const task of TASKS) {
  const read = fileText(task.path);
  const lines = read.split('\n');
  for (const change of task.changes)
    if (change.kind === 'replace' && !minimalUnique(lines, read, change.from, change.to))
      problems.push(`${task.id}: no unique quote exists at all - that is a finding, not a row`);
}

if (problems.length) {
  say(`\n  ${problems.length} problem(s):`);
  for (const problem of problems) say(`    ${problem}`);
  say('');
  process.exit(1);
}
say(
  `\n  ${TASKS.length} tasks: both encodings produce the declared edit, and every quote is minimal.\n`
);
