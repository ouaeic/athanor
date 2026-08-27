/**
 * The one thing `evals/edit` measured and could not settle: whether a model emits the dialect.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────────────────────
 *
 * `evals/edit` priced a line-addressed edit format at 61% fewer output characters over fourteen of
 * fourteen tasks where both formats behave, and the ruling in `docs/design/exec3/L2.md` held it
 * anyway, because every one of those numbers is an upper bound available only to a model that gets
 * the spelling right every time. The study the format came from ships a hand-maintained deny-list
 * of four models that miscount anchors or drop the tag header - which is a statement that emission
 * failure is a real, per-model, routing-level fact rather than an implementation bug somebody could
 * fix. athanor runs on whatever model the owner points it at, so athanor cannot route around it.
 *
 * The ruling named the gate: one arm whose single difference is the edit tool, over the same
 * sample, reporting edit-success and mean output tokens on the same row. This is that arm.
 *
 * ── Why the sample is the corpus and not the fixtures ──────────────────────────────────────────
 *
 * `tasks.ts` takes the general sample from `evals/fixtures.ts` and gives the reason: a second
 * corpus is a corpus written by somebody who already has a hypothesis. The same reasoning points
 * here at `evals/edit/corpus.ts` rather than at anything written in this file. That corpus was
 * written before the arm existed, by a wave arguing the other side of the question, and it already
 * contains the two shapes where the incumbent should win outright. Its tasks are declared as
 * changes to lines, so the request the model sees, the text a correct edit produces, and the
 * offline character bound are all derived from one declaration - and no dialect is written by hand
 * on either side.
 *
 * ── How the request is built, and which way it is biased ───────────────────────────────────────
 *
 * A request quotes the lines as they read now and the lines they should read afterwards. That is
 * deliberately generous to `file_patch`, whose argument is exactly "the text now" and "the text
 * after": half of its call is sitting in the prompt. It is NOT generous by accident, and it is not
 * a hidden thumb on the scale - it is the same choice `evals/edit/encode.ts` made when it handed
 * the incumbent the smallest unique quote it could possibly need. The candidate is the thing asking
 * to ship, so the incumbent gets its best case, and a candidate that wins here wins against it.
 *
 * The quote is the TARGET region only, never the minimal unique one. `file_patch` still has to
 * grow its quote until it is unique - which is the incumbent's real cost and the whole reason the
 * 61% exists - and that work is left where it belongs, in the model.
 *
 * ── What is left out of the sample, and why that is also the safe direction ─────────────────────
 *
 * Three corpus tasks need something this world cannot do honestly: two drift the file between the
 * read and the edit, and one addresses a line outside the window the model was shown. They are the
 * rows where the CANDIDATE wins - it refuses them, and `file_patch` lands one of them wrongly - so
 * dropping them costs the candidate, not the incumbent. They are settled offline, by `evals/edit`
 * and by `apps/worker/src/edit/edit.test.ts`, and a live run is not where a refusal is proved.
 *
 * ── Why the reads differ between the two arms, when nothing else may ───────────────────────────
 *
 * `world.ts` rule 1 says a result is a function of the call alone, never of the arm. This world
 * breaks that rule in exactly one place and it is the only place the format allows: the candidate
 * addresses lines by number against a tag the harness issued, so its `file_read` answers with
 * numbered lines and a header. Reading plain and editing by number is not the candidate measured
 * badly, it is a format that cannot work at all, and every row would refuse for a reason that has
 * nothing to do with the model.
 *
 * So the read side is part of the format, it is configured once from the arm's settings before the
 * run rather than sniffed per call, and it is not free: `evals/edit` measures numbering at +13.9%
 * on the read, which is INPUT and is paid whether or not an edit follows. The live table prints
 * input tokens beside output tokens for that reason. Netting the two silently would be arguing for
 * a conclusion.
 */
import { blockAt } from '../../apps/worker/src/edit/block.js';
import { applyEdit } from '../../apps/worker/src/edit/apply.js';
import { fileTag, renderNumbered } from '../../apps/worker/src/edit/format.js';
import { SnapshotStore } from '../../apps/worker/src/edit/snapshots.js';
import { patchFailure } from '../../apps/worker/src/patch-failure.js';
import { countOccurrences } from '../../apps/worker/src/values.js';
import { FILES, TASKS as CORPUS, fileText, type Change, type EditTask } from '../edit/corpus.js';
import { intended } from '../edit/encode.js';
import { settingsFor } from './arms.js';
import { runOne, type RunRow } from './live.js';
import type { ArmTask } from './tasks.js';
import type { Oracle, OracleResult } from './world.js';

/* ------------------------------------------------------------------------------- the sample */

export interface EditArmTask extends ArmTask {
  /** The corpus row this was derived from, so a reader can check the derivation. */
  readonly corpusId: string;
  readonly path: string;
  /** Where a correct edit leaves the text, computed by the corpus own `intended`. */
  readonly wanted: string;
  /** Set only for a rename: the path the file must end up at. */
  readonly renamedTo?: string;
}

const lines = (text: string): readonly string[] => text.split('\n');

/** A one-based inclusive region of a file, as a block of text with no added indentation. */
const region = (text: string, from: number, to: number): string =>
  lines(text)
    .slice(from - 1, to)
    .join('\n');

const lineAt = (text: string, at: number): string => lines(text)[at - 1] ?? '';

const block = (text: string, at: number): { from: number; to: number } => {
  const found = blockAt([...lines(text)], at - 1);
  return { from: found.from + 1, to: found.to + 1 };
};

const fence = (label: string, text: string): string => `BEGIN ${label}\n${text}\nEND ${label}`;

/**
 * One declared change, in the owner's words rather than in either dialect.
 *
 * Mechanical on purpose. Prose written per task is prose an author tunes, one sentence at a time,
 * until the arm they expected to win does; this renders from the corpus declaration and the file,
 * so a task cannot be worded in a way that suits one format. Both arms receive the identical bytes,
 * which `selftest.ts` checks rather than trusting.
 */
const describe = (change: Change, path: string, before: string): string => {
  switch (change.kind) {
    case 'replace':
      return `In ${path}, replace the lines that read exactly\n\n${fence('CURRENT', region(before, change.from, change.to))}\n\nso that they read\n\n${fence('WANTED', change.lines.join('\n'))}`;
    case 'block': {
      const span = block(before, change.at);
      return `In ${path}, replace the whole block that begins with the line \`${lineAt(before, change.at)}\` - all of it, down to and including its last line - so that it reads\n\n${fence('WANTED', change.lines.join('\n'))}\n\nThe block as it stands is\n\n${fence('CURRENT', region(before, span.from, span.to))}`;
    }
    case 'insert':
      return `In ${path}, insert the following, immediately ${change.side} the line that reads \`${lineAt(before, change.at)}\`, changing nothing else\n\n${fence('WANTED', change.lines.join('\n'))}`;
    case 'move':
      return `In ${path}, move the following lines, unchanged, so that they sit immediately ${change.after === 0 ? 'at the top of the file' : `after the line that reads \`${lineAt(before, change.after)}\``}\n\n${fence('MOVING', region(before, change.from, change.to))}`;
    case 'rename':
      return `Rename ${path} to ${change.to}, leaving its contents exactly as they are.`;
  }
};

const requestFor = (task: EditTask, before: string): string => {
  const parts = task.changes.map((change) => describe(change, task.path, before));
  const body =
    parts.length === 1
      ? (parts[0] as string)
      : parts.map((part, index) => `(${index + 1}) ${part}`).join('\n\n');
  return `${body}\n\nRead the file before you edit it. Make this change and no other: afterwards the file must differ from the file as it is now only by what is described above. Then finish.`;
};

/**
 * The corpus rows a live run can score, and the reason the others are not here.
 *
 * `drift` needs the file to change underneath the model between its read and its edit, which this
 * world does not do; `refuse` needs an edit the harness must decline, which is a property of the
 * applier and is already proved by unit test. Both classes are the candidate's wins, so their
 * absence understates it.
 */
export const EXCLUDED_CORPUS_IDS: readonly string[] = CORPUS.filter(
  (task) => task.drift || task.outcome === 'refuse'
).map((task) => task.id);

export const EDIT_TASKS: readonly EditArmTask[] = CORPUS.filter(
  (task) => !task.drift && task.outcome === 'land'
).map((task) => {
  const before = fileText(task.path);
  const rename = task.changes.find((change) => change.kind === 'rename');
  return {
    id: `edit:${task.id}`,
    corpusId: task.id,
    shape: task.changes.length > 1 ? 'multi' : (task.changes[0]?.kind ?? 'replace'),
    request: requestFor(task, before),
    path: task.path,
    wanted: intended(task, before),
    ...(rename && rename.kind === 'rename' ? { renamedTo: rename.to } : {})
  };
});

/* -------------------------------------------------------------------------------- the world */

/** Why an edit call did not land, in the applier's own vocabulary. */
export interface EditRefusal {
  readonly tool: string;
  readonly kind: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const ok = (content: string): OracleResult => ({ content, terminal: false });

interface ReplacePatch {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/**
 * The corpus files, one editable filesystem, and both appliers as they actually ship.
 *
 * Neither applier is reimplemented. `file_patch` is the exactly-once guard and the single replace
 * from `workspace.ts`, with `patchFailure` - the shipped explainer - answering a miss, so the
 * incumbent gets its real retry story and not a curt "no match" that would make it look worse than
 * it is. `file_edit` is `applyEdit` from `apps/worker/src/edit/`, unmodified, including its own
 * refusal messages with fresh numbered context. A rig that scores two formats against two
 * appliers it wrote itself is a rig scoring its own opinion.
 */
export class EditWorld implements Oracle {
  private files = new Map<string, string>();
  private store = new SnapshotStore();
  /** Every call to an edit tool, whether or not it landed. */
  editCalls = 0;
  /** Calls the harness accepted. `editCalls - editApplied` is the dialect error count. */
  editApplied = 0;
  refusals: EditRefusal[] = [];

  constructor(private readonly numberedReads: boolean) {
    this.reset();
  }

  reset(): void {
    this.files = new Map(FILES.map((file) => [file.path, file.text]));
    this.store = new SnapshotStore();
    this.editCalls = 0;
    this.editApplied = 0;
    this.refusals = [];
  }

  /** The file as the turn left it, for scoring. `null` where the turn deleted or renamed it. */
  textAt(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  private paths(): readonly string[] {
    return [...this.files.keys()].sort();
  }

  private grep(needle: string): readonly string[] {
    const hits: string[] = [];
    for (const path of this.paths())
      for (const [index, line] of (this.files.get(path) ?? '').split('\n').entries())
        if (line.toLowerCase().includes(needle.toLowerCase()))
          hits.push(`${path}:${index + 1}: ${line}`);
    return hits;
  }

  /**
   * A read, in the dialect the arm's edit tool requires.
   *
   * The snapshot is recorded on the numbered path only. Recording one for the incumbent would cost
   * nothing and mean nothing: `file_patch` proves freshness with the quoted text and never asks
   * this store a question.
   */
  private read(path: string): string {
    const body = this.files.get(path);
    if (body === undefined) return `No such file: ${path}`;
    if (!this.numberedReads) return body;
    const total = body.split('\n').length;
    this.store.record(path, body, { startLine: 1, endLine: total });
    return renderNumbered(path, body, { startLine: 1, endLine: total });
  }

  /** The incumbent, faithful to `workspace.ts`: exactly once, then one replace, per patch, in order. */
  private patch(raw: unknown): OracleResult {
    this.editCalls += 1;
    const patches = Array.isArray(raw)
      ? (raw as ReplacePatch[])
      : raw && typeof raw === 'object'
        ? [raw as ReplacePatch]
        : [];
    if (!patches.length) {
      this.refusals.push({ tool: 'file_patch', kind: 'no_patches' });
      return ok(
        'file_patch takes a `patches` array of {path, oldText, newText}. Nothing was applied.'
      );
    }
    const staged = new Map<string, string>();
    const problems: string[] = [];
    for (const one of patches) {
      const path = text(one?.path);
      const oldText = text(one?.oldText);
      const before = staged.get(path) ?? this.files.get(path);
      if (before === undefined) {
        problems.push(
          `${path} could not be read. Check the path with files_list before patching it.`
        );
        continue;
      }
      if (!path || !oldText) {
        problems.push('Every patch requires a path and non-empty oldText.');
        continue;
      }
      if (countOccurrences(before, oldText) !== 1) {
        problems.push(patchFailure(path, before, oldText).reason);
        continue;
      }
      staged.set(path, before.replace(oldText, text(one?.newText)));
    }
    if (!staged.size) {
      this.refusals.push({ tool: 'file_patch', kind: 'no_unique_match' });
      return ok(problems.join(' ') || 'No patch could be applied.');
    }
    for (const [path, after] of staged) this.files.set(path, after);
    this.editApplied += 1;
    // A partially applied call is applied, and it is also a call the model has to reason about
    // again. Saying which is which is the difference between a retry and a corrupted file.
    return ok(
      `Patched ${[...staged.keys()].join(', ')}.${problems.length ? ` ${problems.length} patch(es) did not apply: ${problems.join(' ')}` : ''}`
    );
  }

  /** The candidate, which is `applyEdit` and nothing else. */
  private edit(source: string): OracleResult {
    this.editCalls += 1;
    const outcome = applyEdit(source, this.files, this.store);
    if (!outcome.ok) {
      this.refusals.push({ tool: 'file_edit', kind: outcome.failures[0]?.kind ?? 'refused' });
      return ok(outcome.failures.map((failure) => failure.message).join('\n\n'));
    }
    for (const [path, after] of outcome.files) {
      if (after === null) this.files.delete(path);
      else this.files.set(path, after);
    }
    this.editApplied += 1;
    const written = [...outcome.files.keys()];
    return ok(
      `Applied. ${written
        .map((path) => {
          const now = this.files.get(path);
          return now === undefined ? `${path} removed` : `[${path}#${fileTag(now)}]`;
        })
        .join(' ')}`
    );
  }

  /**
   * The four shell verbs the general world answers, plus `mv`.
   *
   * `mv` is here because a rename is the one row where the incumbent wins outright - it costs it a
   * 41-character shell call and the candidate a header and an `MV` - and a world that could not
   * perform one would have quietly deleted the incumbent's best case from the sample.
   */
  private shell(command: string): string {
    const trimmed = command
      .replace(/^bash\s+-lc\s+/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim();
    const move = /^mv\s+(\S+)\s+(\S+)$/.exec(trimmed);
    if (move) {
      const from = move[1] as string;
      const to = move[2] as string;
      const body = this.files.get(from);
      if (body === undefined) return `mv: ${from}: No such file or directory`;
      this.files.delete(from);
      this.files.set(to, body);
      return '';
    }
    if (/^ls\b/.test(trimmed) || /^find\b/.test(trimmed)) return this.paths().join('\n');
    const cat = /^cat\s+(\S+)$/.exec(trimmed);
    if (cat) {
      const body = this.files.get(cat[1] as string);
      return body ?? `cat: ${cat[1]}: No such file or directory`;
    }
    const grep = /^grep\s+(?:-\w+\s+)*['"]?([^'"]+?)['"]?(\s+\S+)?$/.exec(trimmed);
    if (grep) return this.grep(grep[1] as string).join('\n');
    return `athanor-eval: this rig's shell understands ls, cat, grep, find and mv over the workspace, and was given: ${trimmed}`;
  }

  answer(name: string, args: Record<string, unknown>): OracleResult {
    switch (name) {
      case 'finish':
        return { content: 'Turn ended.', terminal: true };
      case 'set_plan':
      case 'set_acceptance':
        return ok('Recorded.');
      case 'shell':
        return ok(this.shell(text(args.command)));
      case 'files_list':
      case 'repo_overview':
        return ok(this.paths().join('\n'));
      case 'file_read':
      case 'document_read':
        return ok(this.read(text(args.path) || text(args.documentId)));
      case 'file_write':
        // A whole-file rewrite is a real way to make this edit and both arms hold it. Scoring is
        // on the file afterwards, so an arm that reaches for it is neither rewarded nor punished
        // for the choice - which is the only treatment that does not decide the result in advance.
        this.files.set(text(args.path), text(args.content));
        return ok(`Wrote ${text(args.path)}.`);
      case 'file_patch':
        return this.patch(args.patches ?? args);
      case 'file_edit':
        return this.edit(text(args.patch));
      case 'code_search':
      case 'session_search':
      case 'document_search': {
        const hits = this.grep(text(args.query) || text(args.pattern));
        return ok(hits.length ? hits.join('\n') : 'No matches.');
      }
      case 'web_search':
        return ok('This rig has no network. Work from what is on the computer.');
      default:
        return ok(
          `athanor-eval: ${name} is not modelled by this rig. Reach the same fact another way, or finish with what you have.`
        );
    }
  }
}

/**
 * Whether the turn left the file the way the task asked for.
 *
 * Byte-exact, because the request quotes the wanted lines verbatim and there is nothing to guess.
 * `nearly` is the same comparison with trailing whitespace normalised the way the format's own
 * `normalise` does, and it exists so a run can tell "the model cannot spell the dialect" from "the
 * model added a trailing space", which are different findings and would otherwise print the same.
 */
export const scoreEdit = (
  world: EditWorld,
  task: EditArmTask
): { readonly correct: boolean; readonly nearly: boolean } => {
  const wantedPath = task.renamedTo ?? task.path;
  const after = world.textAt(wantedPath);
  if (after === null) return { correct: false, nearly: false };
  if (task.renamedTo && world.textAt(task.path) !== null) return { correct: false, nearly: false };
  const detrail = (value: string): string =>
    value
      .split('\n')
      .map((line) => line.replace(/[ \t\r]+$/, ''))
      .join('\n');
  return {
    correct: after === task.wanted,
    nearly: detrail(after) === detrail(task.wanted)
  };
};

/* ------------------------------------------------------------------------------- the live run */

/**
 * A row of the live edit table.
 *
 * `correct` is the only success column, and it is the file afterwards rather than the tool's own
 * word for what it did. A format that applies something confidently and gets it wrong scores zero
 * here, which is the scoring `evals/edit/measure.ts` chose for the same reason: "the tool returned
 * success" is the claim under test, not the evidence for it.
 *
 * `editCalls` and `editApplied` are the deny-list question stated in numbers. Their difference is
 * calls the harness refused - a miscounted anchor, a dropped header, a quote that was not unique -
 * and it is the quantity the whole ruling hangs on, so it is counted per call and not inferred from
 * whether the row ended up correct.
 */
export interface EditRow extends RunRow {
  readonly correct: boolean;
  readonly nearly: boolean;
  readonly editCalls: number;
  readonly editApplied: number;
  readonly refusals: readonly EditRefusal[];
}

/**
 * The fewest round trips a correct row can take: read the file, edit it, finish.
 *
 * The floor of the cost estimate, and it is a floor rather than an expectation on purpose. A model
 * that has to retry a refused edit pays a fourth, which is the thing being measured; quoting an
 * expectation here would be quoting the answer before the run.
 */
export const MIN_CALLS_PER_EDIT = 3;

export const runEditOne = async (
  apiKey: string,
  model: string,
  armId: string,
  task: EditArmTask,
  seed: number
): Promise<EditRow> => {
  const world = new EditWorld(settingsFor(armId).edit === 'lines');
  const row = await runOne(apiKey, model, armId, task, seed, {}, world);
  const score = scoreEdit(world, task);
  return {
    ...row,
    correct: score.correct && !row.error,
    nearly: score.nearly && !row.error,
    editCalls: world.editCalls,
    editApplied: world.editApplied,
    refusals: world.refusals
  };
};

export const runEditLive = async (
  apiKey: string,
  armIds: readonly string[],
  tasks: readonly EditArmTask[],
  tiers: readonly string[],
  seeds: number
): Promise<readonly EditRow[]> => {
  const rows: EditRow[] = [];
  for (const tier of tiers)
    for (const armId of armIds)
      for (const task of tasks)
        for (let seed = 0; seed < seeds; seed += 1)
          rows.push(await runEditOne(apiKey, tier, armId, task, seed));
  return rows;
};
