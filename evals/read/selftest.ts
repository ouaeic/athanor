/**
 * The checks the table cannot perform, and the ones that decide whether any of it is honest.
 *
 * A read-cost rig is easy to write dishonestly, and every way of doing it produces a plausible
 * number rather than an error. So each check below is a way this directory's headline figure could
 * be a confident lie:
 *
 *   1. A COUNTER THAT COUNTS THE WRONG THING. `readLedgerOf` is driven over a synthetic event
 *      stream whose answers are known by construction - including a refused patch, which must
 *      contribute to neither column, and a two-file patch, which must contribute two edits.
 *   2. A DECLARATION THAT CANNOT BE WRONG. A trajectory declares the number it must produce, and
 *      that declaration is checked here against the FILE, by arithmetic, so a window that runs past
 *      the end of a file cannot quietly declare the lines that are not there. The one read that
 *      declares no number - the bounded one - is checked instead for the conditions under which a
 *      bound can fire at all: a file long enough to cut, and no window competing to cut it first.
 *   3. AN EDIT THAT LANDS FOR THE WRONG REASON. Every declared patch must address a line some
 *      earlier step of the same trajectory displayed, where "displayed" is what `recordWrite`
 *      actually records TODAY - the span a patch authored, not the whole file it rewrote. A patch
 *      that lands because a previous trajectory's read is still in the process-global snapshot
 *      store is a row measuring leakage.
 *   4. ORDER DEPENDENCE. That store is keyed by task id, and every fixture in this harness shares
 *      one. So the whole set is measured a second time in reverse and must agree row for row.
 *   5. A COLLISION WITH THE GENERAL CORPUS. Two rows under one id would share a baseline row and
 *      hide each other's drift, exactly as `evals/run.ts` refuses for its own fixtures.
 *   6. A QUOTIENT THAT LIES AT THE EDGES. Zero edits and zero lines are different facts and
 *      `linesPerEdit` must not confuse them.
 *
 * Part of the run rather than a script beside it, for the reason `evals/edit/selftest.ts` gives:
 * a rig whose honesty depends on somebody remembering a second command reports a confident wrong
 * number on the machine where they did not.
 */
import { linesPerEdit, readLedgerOf } from '../harness.js';
import { fixtures } from '../fixtures.js';
import { measureTrajectory } from './measure.js';
import { FILES, TRAJECTORIES, lineCount, type Trajectory } from './trajectories.js';
import { NARROW_ROW, WIDE_ROW } from './report.js';

const started = (id: string, tool: string, args: Record<string, unknown>) => ({
  kind: 'tool_started',
  payload: { toolCallId: id, tool, arguments: args }
});
const result = (id: string, value: unknown) => ({
  kind: 'tool_result',
  payload: { toolCallId: id, result: value }
});

/**
 * The lines a trajectory has put in front of the model by the time it reaches step `index`.
 *
 * `bounded` is how many lines that trajectory's bounded read actually displayed, measured rather
 * than declared - it is the one quantity here that a constant elsewhere decides.
 *
 * The patch rule used to say `recordWrite` re-records the whole file, so every line of it counted
 * as shown from the first patch onwards. That was true when this was written and 13a05c4 removed
 * it: `edit/snapshots.ts:265` records only the SPANS a patch authored, because text a line-
 * addressed patch reproduces is not text anybody was shown. The rule below is the one the code has
 * now, and it is strictly the tighter of the two - a row that passes it would pass the old one, so
 * correcting it can only find a row resting on evidence it does not have.
 */
const displayedBy = (
  trajectory: Trajectory,
  index: number,
  bounded: number
): ReadonlyMap<string, Set<number>> => {
  const shown = new Map<string, Set<number>>();
  for (const step of trajectory.steps.slice(0, index)) {
    const seen = shown.get(step.path) ?? new Set<number>();
    if (step.kind === 'read') {
      const from = step.from ?? 1;
      const rows = step.shows === 'bounded' ? bounded : step.shows;
      for (let line = from; line < from + rows; line += 1) seen.add(line);
    } else if (step.kind === 'patch') {
      // The span this patch authored, and nothing else. One line in, one line out.
      seen.add(step.at);
    } else {
      // A whole-file write supplied every line, which is the one case `recordWrite` still records
      // whole - `snapshots.ts:275`, the branch with no `changed` argument.
      for (let line = 1; line <= step.content.split('\n').length; line += 1) seen.add(line);
    }
    shown.set(step.path, seen);
  }
  return shown;
};

export const selfTest = async (): Promise<readonly string[]> => {
  const problems: string[] = [];

  // 5. Ids, against each other and against the corpus this rig also measures.
  const corpusIds = new Set(fixtures.map((fixture) => fixture.id));
  const seen = new Set<string>();
  for (const trajectory of TRAJECTORIES) {
    if (seen.has(trajectory.id)) problems.push(`two trajectories share the id ${trajectory.id}`);
    seen.add(trajectory.id);
    if (corpusIds.has(trajectory.id))
      problems.push(
        `${trajectory.id} is also a fixture id, so the two would share one baseline row`
      );
    if (!trajectory.steps.length) problems.push(`${trajectory.id} declares no steps`);
    /*
     * A bounded row is held to the lines its run displayed, and this rig reads that off the row's
     * total. So a bounded row may have exactly one read: a second one would fold two reads into a
     * number check 3 then treats as one, and the patch coverage check would silently widen.
     */
    const reads = trajectory.steps.filter((step) => step.kind === 'read');
    if (
      reads.some((step) => step.kind === 'read' && step.shows === 'bounded') &&
      reads.length !== 1
    )
      problems.push(
        `${trajectory.id} declares a bounded read and makes ${reads.length} reads; the bounded row's displayed count is read off the row total, which only equals the read's own when there is one`
      );
  }
  for (const id of [NARROW_ROW, WIDE_ROW])
    if (!seen.has(id))
      problems.push(`${id} is named by the separation gate and is not in TRAJECTORIES`);

  /*
   * The forward pass, run before the declaration checks rather than after them.
   *
   * Check 3 needs one number it cannot derive: how many lines the bounded read displayed, which a
   * constant in `apps/worker/src/tools/workspace.ts` decides and this directory deliberately does
   * not copy. Measuring it is also stricter than declaring it - the patch is held to what the run
   * really put in front of the model, not to what the rig believed it would.
   */
  const forwards = new Map<string, string>();
  const displayed = new Map<string, number>();
  for (const trajectory of TRAJECTORIES) {
    const row = await measureTrajectory(trajectory);
    forwards.set(row.id, `${row.displayedLines}/${row.landedEdits}`);
    displayed.set(row.id, row.displayedLines);
  }

  // 2 and 3. Every declaration, against the files, and every patch against what was shown.
  for (const trajectory of TRAJECTORIES)
    for (const [index, step] of trajectory.steps.entries()) {
      if (step.kind === 'read') {
        if (FILES[step.path] === undefined)
          problems.push(`${trajectory.id}: reads ${step.path}, which this workspace does not hold`);
        else if (step.shows === 'bounded') {
          // A bounded read declares that the bound cuts into the file, so the file has to be big
          // enough for a bound to have anything to cut. A one-line file would satisfy every other
          // check here and measure nothing.
          if (step.from !== undefined || step.to !== undefined)
            problems.push(
              `${trajectory.id}: reads a window of ${step.path} AND declares the display bound cut it short. A window is bounded by the window; this row would not say which bound fired.`
            );
          if (lineCount(step.path) < 2)
            problems.push(
              `${trajectory.id}: declares the display bound cuts ${step.path} short, and ${step.path} is ${lineCount(step.path)} line(s) long, so no bound can fire on it`
            );
        } else if (step.from !== undefined || step.to !== undefined) {
          const from = step.from ?? 1;
          const to = Math.min(step.to ?? lineCount(step.path), lineCount(step.path));
          const available = Math.max(0, to - from + 1);
          if (step.shows !== available)
            problems.push(
              `${trajectory.id}: a window of ${step.path} lines ${from}-${step.to ?? '(end)'} can display ${available} lines and the step declares ${step.shows}`
            );
        } else if (step.shows < 1 || step.shows > lineCount(step.path))
          problems.push(
            `${trajectory.id}: an unwindowed read of ${step.path} declares ${step.shows} of ${lineCount(step.path)} lines, which is not a number that read can produce`
          );
        continue;
      }
      if (step.kind !== 'patch') continue;
      const shown = displayedBy(trajectory, index, displayed.get(trajectory.id) ?? 0).get(
        step.path
      );
      if (!shown?.has(step.at))
        problems.push(
          `${trajectory.id}: patches ${step.path} at line ${step.at}, which no earlier step of this trajectory displayed. If it lands, it landed on evidence left behind by another row.`
        );
    }

  // 1. The counter, on a stream whose answers are arithmetic.
  const ledger = readLedgerOf([
    started('r1', 'file_read', { path: 'a.ts' }),
    result('r1', {
      path: 'a.ts',
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      content: '1:a\n2:b\n3:c'
    }),
    started('r2', 'file_read', { path: 'b.ts', startLine: 10, endLine: 11 }),
    result('r2', { path: 'b.ts', startLine: 10, endLine: 11, content: '10:x\n11:y' }),
    // A refused patch: the loop writes an `error` event and no `tool_result`, so nothing here.
    started('p0', 'file_patch', { patches: [{ path: 'a.ts', edit: 'PUT 900.=900:\n+nope' }] }),
    { kind: 'error', payload: { toolCallId: 'p0' } },
    started('p1', 'file_patch', { patches: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
    result('p1', {
      filesChanged: [{ path: 'a.ts' }, { path: 'b.ts' }],
      patchCount: 2,
      wrote: 'a.ts\n2:B\n\nb.ts\n10:X'
    }),
    started('w1', 'file_write', { path: 'c.ts', content: 'hello\n' }),
    result('w1', { ok: true })
  ]);
  // Five echo rows, not four: `wrote` carries a path header per file and a blank line between the
  // regions, and those are rows the model is shown too. This expectation said four until the check
  // itself reported the difference, which is the one way a test of arithmetic is worth having.
  const wanted = { displayedLines: 5, landedEdits: 3, echoLines: 5, mismatches: 0, windowed: 1 };
  if (ledger.displayedLines !== wanted.displayedLines)
    problems.push(
      `readLedgerOf counted ${ledger.displayedLines} displayed lines on a stream that displayed ${wanted.displayedLines}`
    );
  if (ledger.landedEdits !== wanted.landedEdits)
    problems.push(
      `readLedgerOf counted ${ledger.landedEdits} landed edits on a stream that landed ${wanted.landedEdits} (two files in one patch, one write, one refusal)`
    );
  if (ledger.echoLines !== wanted.echoLines)
    problems.push(
      `readLedgerOf counted ${ledger.echoLines} echo rows rather than ${wanted.echoLines}`
    );
  if (ledger.claimMismatches !== wanted.mismatches)
    problems.push('readLedgerOf found a claim mismatch on a stream that has none');
  if (ledger.reads.filter((read) => read.windowed).length !== wanted.windowed)
    problems.push('readLedgerOf did not recognise the windowed read by its arguments');
  // The mismatch detector itself, on a result whose content and stated range disagree.
  const skewed = readLedgerOf([
    started('r3', 'file_read', { path: 'a.ts' }),
    result('r3', { path: 'a.ts', startLine: 1, endLine: 9, content: '1:a\n2:b' })
  ]);
  if (skewed.claimMismatches !== 1)
    problems.push(
      'readLedgerOf accepted a read whose content is two rows and whose stated range is nine, so the cross-check is not running'
    );

  // 6. The quotient at the edges.
  if (linesPerEdit({ ...ledger, landedEdits: 0 }) !== null)
    problems.push('linesPerEdit returns a number for a turn that landed no edit');
  if (linesPerEdit({ ...ledger, displayedLines: 0, landedEdits: 1 }) !== 0)
    problems.push('linesPerEdit does not report 0 for an edit that displayed nothing');

  // 4. Order independence, measured rather than assumed, against the forward pass above.
  for (const trajectory of [...TRAJECTORIES].reverse()) {
    const row = await measureTrajectory(trajectory);
    const was = forwards.get(row.id);
    const now = `${row.displayedLines}/${row.landedEdits}`;
    if (was !== now)
      problems.push(
        `${row.id} measured ${was} in declaration order and ${now} in reverse, so a row here depends on what ran before it`
      );
  }

  return problems;
};
