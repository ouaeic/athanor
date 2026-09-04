/**
 * The checks the tables cannot perform, and the ones that decide whether any of them is honest.
 *
 * A corpus of failures is the easiest rig in this repository to write dishonestly: choose the
 * malformed shapes the harness happens to forgive and every column reads "cost 0". So the checks
 * here are aimed at this lane rather than at the applier, and every one of them is a way the table
 * above could be a confident lie:
 *
 *   1. AN EXPECTATION THAT MATCHES BY ACCIDENT. Every `apply` case must ask for a file that is
 *      actually different from the one it started with. A case whose intended result is the
 *      original scores 0 for doing nothing at all.
 *   2. A SCORER THAT PASSES EVERYTHING. `carriesLiveText` and `namesAShape` decide the difference
 *      between one round trip and two for the whole corpus, so they are exercised on inputs whose
 *      answers are known: a real window, an invented one, and plain prose.
 *   3. LEAKAGE BETWEEN CASES. The snapshot store is process-global. A record left behind by one
 *      case would make a later one pass for a reason that has nothing to do with the case, so the
 *      whole corpus is run twice and the two runs must agree row for row.
 *   4. A COMPARISON AGAINST A PROGRAM THAT NO LONGER EXISTS - or, now, against one that has come
 *      back. `assertIncumbentRetired` reads the shipped module.
 *   5. AN INTENT THAT ASKS FOR NOTHING, or a quoted emission the schema would have rejected before
 *      the applier ever saw it. Either would make the incumbent lose a row it never played.
 *
 * Deliberately part of the run rather than a script beside it. A rig whose honesty depends on
 * somebody having remembered to run a second file reports a confident wrong number on the machine
 * where they did not.
 */
import {
  anchorPrefixes,
  foldAnchor,
  isWeakAnchor,
  STRONG_ANCHOR_CHARS
} from '../../apps/worker/src/edit/format.js';
import { carriesLiveText, namesAShape, runConformance, sourceOf, CASES } from './conformance.js';
import { assertIncumbentRetired, PAIRED } from './incumbent.js';

export const selfTest = (): string[] => {
  const problems: string[] = [];

  const ids = new Set<string>();
  for (const item of CASES) {
    if (ids.has(item.id)) problems.push(`two cases share the id ${item.id}`);
    ids.add(item.id);
    if (!item.edit.length) problems.push(`${item.id}: the emission is empty`);
  }

  // 1. Every `apply` case must ask for a change. Computed here, from the case's own declaration,
  // and never from anything the applier returned.
  const first = runConformance();
  for (const item of CASES) {
    if (item.want.kind !== 'apply') continue;
    const { live } = sourceOf(item);
    if (item.want.after(live) === live)
      problems.push(`${item.id}: the intended file is the original, so landing it proves nothing`);
  }

  // 2. The two scorers, on inputs whose answers are known.
  const live = ['alpha', 'beta', 'gamma', 'delta'];
  if (!carriesLiveText('here it is:\n1:alpha\n2:beta\n3:gamma', live))
    problems.push('carriesLiveText rejects a real three-row window');
  if (!carriesLiveText('here it is:\n1| alpha\n2| beta\n3| gamma', live))
    problems.push('carriesLiveText rejects the numbering the retired explainer used');
  if (carriesLiveText('here it is:\n1:alpha\n2:BETA\n3:GAMMA', live))
    problems.push('carriesLiveText accepts a window that is not what the file says');
  if (carriesLiveText('the file has 4 lines', live))
    problems.push('carriesLiveText accepts a message that quotes nothing');
  if (namesAShape('the file has changed since you read it'))
    problems.push('namesAShape accepts prose that names no spelling');
  if (!namesAShape('expected PUT N:, PUT N.=M:, CUT N.=M'))
    problems.push('namesAShape rejects the sentence the parser actually sends');

  /*
   * 2b. The anchor fold and the weak-anchor threshold, on inputs whose answers are known. Every
   * `anchored` row rests on these two functions, and a fold that quietly widened - or a threshold
   * that quietly moved - would move every row in the group without any case saying so.
   */
  if (foldAnchor('“x” – ‘y’ z') !== '"x" - \'y\' z')
    problems.push('foldAnchor does not fold curly quotes, the en dash and the no-break space');
  if (foldAnchor('\t\tfoo') !== foldAnchor('    foo'))
    problems.push('foldAnchor does not put tab and space indentation in one class');
  if (foldAnchor('foo') === foldAnchor('  foo'))
    problems.push('foldAnchor folds an unindented line onto an indented one');
  if (foldAnchor('return a - b') !== 'return a - b')
    problems.push('foldAnchor changes a line that is already ASCII');
  if (!isWeakAnchor('}') || !isWeakAnchor('return;') || !isWeakAnchor(''))
    problems.push('isWeakAnchor lets a brace, a seven-character row or a blank stand alone');
  if (isWeakAnchor('return 1;') || STRONG_ANCHOR_CHARS !== 8)
    problems.push('the weak-anchor threshold is not eight non-space characters');
  if (!anchorPrefixes('  if (!job)', '\tif (!job) return null;'))
    problems.push('anchorPrefixes rejects a folded prefix');
  if (anchorPrefixes('  if (!job) return null;', '  if (!job)'))
    problems.push('anchorPrefixes accepts an anchor longer than the line');

  // 3. The process-global snapshot store must not carry anything between cases.
  const second = runConformance();
  for (const [index, row] of first.entries()) {
    const twin = second[index];
    if (!twin || twin.id !== row.id || twin.cost !== row.cost || twin.verdict !== row.verdict)
      problems.push(
        `${row.id}: a second run of the same corpus disagrees with the first (${row.verdict}/${row.cost} then ${twin?.verdict}/${twin?.cost}), so a record is leaking between cases`
      );
  }

  // 4. The program being compared against is the one this rig says it is.
  try {
    assertIncumbentRetired();
  } catch (cause) {
    problems.push(cause instanceof Error ? cause.message : 'the incumbent pin threw');
  }

  // 5. The paired intents ask for something, and both emissions are calls the arm would accept.
  for (const intent of PAIRED) {
    const live = intent.live ?? intent.file;
    if (intent.after === live)
      problems.push(`${intent.id}: the intended file is the original, so the intent is empty`);
    if (!intent.patches.length) problems.push(`${intent.id}: no quoted emission`);
    for (const patch of intent.patches)
      if (!patch.oldText.length)
        problems.push(
          `${intent.id}: a quoted patch with an empty oldText, which the arm rejected before applying anything - the incumbent would not have played this row`
        );
    if (!intent.edit.length) problems.push(`${intent.id}: no line-addressed emission`);
  }

  return problems;
};
