/**
 * Running both formats over the same edit and recording what each one cost and whether it landed.
 *
 * Two numbers per task per format and nothing else: the characters of JSON arguments the model has
 * to emit, and whether the file afterwards is the file the task asked for. "Landed" is not "the
 * tool returned success" - it is a byte comparison against the intended text, computed from the
 * declared change by `intended()`, which neither encoder can see. A format that applies something
 * confidently and gets it wrong scores zero here, which is the only scoring that matters.
 *
 * The read side is measured too and kept separate. Line addressing is only meaningful if the read
 * carries line numbers, and that is a cost on every read whether or not an edit follows. Netting it
 * against the output saving silently would be arguing for a conclusion; both numbers are printed
 * and the ruling is where they get weighed.
 */
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { renderNumbered } from '../../apps/worker/src/edit/format.js';
import { SnapshotStore } from '../../apps/worker/src/edit/snapshots.js';
import { fileText, TASKS, type EditTask } from './corpus.js';
import {
  applyReplace,
  assertIncumbentSemantics,
  emitted,
  encodeLines,
  encodeReplace,
  intended
} from './encode.js';

export interface FormatResult {
  /** Characters of JSON arguments the model must emit for this edit. */
  readonly chars: number;
  /** The edit was applied to something. */
  readonly landed: boolean;
  /** The file afterwards is byte-identical to what the task asked for. */
  readonly correct: boolean;
  /** Why not, in one word, when it did not land. */
  readonly refusal?: string;
}

export interface Row {
  readonly id: string;
  readonly what: string;
  readonly desired: 'land' | 'refuse';
  readonly note?: string;
  readonly replace: FormatResult;
  readonly lines: FormatResult;
  /** Characters the read itself costs, plain and numbered. */
  readonly read: { readonly plain: number; readonly numbered: number };
}

const windowOf = (task: EditTask, text: string) =>
  task.read ?? { startLine: 1, endLine: text.split('\n').length };

const measureOne = (task: EditTask): Row => {
  const read = fileText(task.path);
  const window = windowOf(task, read);
  const live = task.drift ? task.drift(read) : read;
  if (task.drift && live === read)
    throw new Error(`${task.id}: drift() changed nothing, so the stale case is not being tested`);

  const wanted = intended(task, read);
  const rename = task.changes.length === 1 && task.changes[0]?.kind === 'rename';
  const expected = task.drift ? task.drift(wanted) : wanted;

  const store = new SnapshotStore();
  const tag = store.record(task.path, read, window);

  const replaceCall = encodeReplace(task, read);
  const linesCall = encodeLines(task, tag);

  let replace: FormatResult;
  if (replaceCall.tool !== 'file_patch') {
    // A rename is a shell call. It lands, it is correct, and the honest thing to record is that
    // the incumbent pays almost nothing for it - not that it lacks the operation.
    replace = { chars: emitted(replaceCall), landed: true, correct: true };
  } else {
    const applied = applyReplace(replaceCall.args.patches, live);
    const landed = applied.applied > 0 && applied.failed === 0;
    replace = {
      chars: emitted(replaceCall),
      landed,
      correct: landed && applied.text === expected,
      ...(landed ? {} : { refusal: 'no unique match' })
    };
  }

  const outcome = applyEdit(linesCall.args.patch, new Map([[task.path, live]]), store);
  const produced = rename
    ? outcome.files.get((task.changes[0] as { to: string }).to)
    : outcome.files.get(task.path);
  const lines: FormatResult = {
    chars: emitted(linesCall),
    landed: outcome.ok,
    correct: outcome.ok && produced === expected,
    ...(outcome.ok ? {} : { refusal: outcome.failures[0]?.kind ?? 'refused' })
  };

  return {
    id: task.id,
    what: task.what,
    desired: task.outcome,
    ...(task.note ? { note: task.note } : {}),
    replace,
    lines,
    read: {
      plain: read
        .split('\n')
        .slice(window.startLine - 1, window.endLine)
        .join('\n').length,
      numbered: renderNumbered(task.path, read, window).length
    }
  };
};

export interface Measurement {
  readonly rows: readonly Row[];
  /** The shipped lines this rig models the incumbent as, quoted from the module that ships them. */
  readonly incumbent: string;
}

export const measureAll = (): Measurement => ({
  incumbent: assertIncumbentSemantics(),
  rows: TASKS.map(measureOne)
});

/** A format did what the task wanted: landed correctly, or refused when refusing was right. */
export const behaved = (result: FormatResult, desired: 'land' | 'refuse'): boolean =>
  desired === 'land' ? result.correct : !result.landed;
