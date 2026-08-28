import { sha256, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import {
  applyEdit,
  displayedRanges,
  firstUnshownLine,
  numberedWindow,
  readsOf,
  recordRead,
  recordWrite,
  renderNumbered,
  toLines
} from '../edit/index.js';
import { RECENT_TOOL_OUTPUT_CHARS } from '../context.js';
import { HELPER_PACKAGE_MANAGERS, PACKAGE_VERBS } from '../turn-bounds.js';
import { textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';
import { finiteNumber } from './numbers.js';

/**
 * How much of what a patch just wrote comes back in the result.
 *
 * The one failure a line-addressed format cannot detect on the way in is an off-by-one with no
 * evidence attached: `PUT 40.=42:` where the model meant 41, and nothing in the patch says what it
 * thought was at 40. `apply.ts` explains why guessing is not available there. This is the other half
 * of that decision - the model is shown the head and the tail of every region it wrote, with the
 * line above and below, so a miscount is visible on the same turn instead of at test time.
 *
 * Bounded, because it is input tokens on every successful edit and the whole point of the format is
 * not spending tokens. Four rows per region is the first line, the last line and one line of context
 * on each side, which is exactly enough to see that an edit landed one line high.
 */
const ECHO_ROWS_PER_REGION = 2;
const ECHO_MAX_ROWS = 24;

/**
 * How much of a file one `file_read` puts in front of the model, on either arm.
 *
 * THIS IS NOT AN ECONOMY. The economy already exists and is uniform: `recordToolResult` bounds the
 * serialised form of EVERY tool result at `RECENT_TOOL_OUTPUT_CHARS` before pushing it into the
 * window, so an unbounded read of this repository's largest test file arrives at exactly 24,000
 * characters whatever this arm does. Measured through the shipped path: 354,014 bytes on disk,
 * 403,252 characters serialised, 24,000 delivered - 5.95%. A second bound in front of that one
 * would save no tokens, and the first draft of this change was proposed on the belief that it
 * would.
 *
 * What it is for is the gap that bound OPENS. The cut happens two layers downstream, after this arm
 * has already answered `truncated: false, totalLines: 8332` and already called `recordRead` over all
 * 8,332 lines - so the harness's record of what the model was shown was wrong by 7,800 lines, and
 * that record is the only evidence a line-addressed `file_patch` rests on. An edit to line 8,000
 * of a file the model had seen 500 lines of was accepted, by name, because of this. So this bound
 * exists to make the read's own report true: what is displayed, what is claimed, and what is
 * recorded as seen become the same set of lines, and the downstream cut never has a file_read to
 * make a decision about.
 *
 * That is why the byte budget is DERIVED from the window bound rather than chosen. It is the
 * agreement condition between the two layers, and if someone moves the window bound the read has to
 * follow it or the gap reopens. Three quarters leaves room for the line-number gutter, the JSON
 * escaping and the envelope: measured over all 830 tracked text files in this repository, the worst
 * serialised result is 21,793 characters, 2,207 inside the bound, and no file exceeds it.
 *
 * It is now the delivery budget rather than a cut made after delivery, and it binds both arms. The
 * runner is handed these two numbers and answers with the prefix that fits them, so what crosses the
 * wire, what the model is shown, and what both seen-line ledgers vouch for are one set of bytes
 * instead of three computations that have to keep agreeing.
 */
const FILE_READ_DISPLAY_BYTES = Math.floor(RECENT_TOOL_OUTPUT_CHARS * 0.75);

/**
 * The line cap, and it is a CATASTROPHE FLOOR rather than an economy or a working limit.
 *
 * On real source the budget above is what binds and this is never reached: at 18,000 bytes, moving
 * this number from 600 to 2,000 changes what is delivered for 0 of 830 tracked files, because a
 * line of code averages 43.4 characters and 18,000 bytes is 415 of them. What it is here for is the
 * file the byte budget cannot bound - 18,000 bytes of two-character lines is 9,000 lines, and 9,000
 * lines recorded as seen is the same defect this change exists to remove, reached from the other
 * side. A column of numbers is not a licence to edit 9,000 anchors blind.
 *
 * 800 because it is above what an unbounded read has any business vouching for and below what
 * anyone reads: p75 of this repository's tracked files is 339 lines and p90 is 715, and across
 * 12,347 real windowed reads measured on this machine p90 displayed is 360 lines. It costs a second
 * call on the narrow-line minority and nothing on the rest.
 */
const FILE_READ_DISPLAY_LINES = 800;

/**
 * Notes, or forgets, that the reads of this path have not been shown to reach the end of it.
 *
 * A number rather than a flag, because what `firstUnshown` needs is a line the reads have to
 * cover, and the two arms know that line to different precision. An unwindowed read has the whole
 * file's length exactly. A windowed read that stopped before the end knows only that the file goes
 * at least one line further than what it delivered whole - the ranged reader deliberately does not
 * walk to the end of a two-gigabyte log to count. So the number is a floor, never an overstatement,
 * and it is only ever raised: a later, narrower read learning less about the file must not lower the
 * bar a wider one set.
 *
 * Written as a fresh object for the same reason every other field of `AgentState` is - the state is
 * snapshotted between steps and a mutated map would edit history.
 */
const withPartialRead = (
  existing: Record<string, number> | undefined,
  path: string,
  atLeastLines: number | undefined
): Record<string, number> => {
  const next = { ...(existing ?? {}) };
  if (atLeastLines === undefined) delete next[path];
  else next[path] = Math.max(next[path] ?? 0, atLeastLines);
  return next;
};

/**
 * Moves that floor by what an edit changed the file's length by, because the file it is a floor on
 * is now one line-count longer or shorter.
 *
 * A patch used to DELETE the entry outright, on the reasoning that the version the read was about
 * no longer exists. The version does not; the unread remainder does. Measured on the shipped arm:
 * `file_read` of lines 1-200 of an 8,332-line file, then one `PUT 10:`, and the outstanding floor
 * went from 201 to nothing - after which a whole-file `file_write` destroyed 576,512 bytes without
 * being asked a question. An edit to line 10 says nothing about line 8,000, and clearing the floor
 * claimed it did.
 *
 * "At least N lines" survives the shift exactly: a file that had at least N lines and gained
 * `delta` of them has at least N + delta, and the floor stays a floor whichever way the edit went.
 */
const shiftPartialRead = (
  existing: Record<string, number> | undefined,
  path: string,
  delta: number
): Record<string, number> => {
  const outstanding = existing?.[path];
  if (outstanding === undefined) return { ...(existing ?? {}) };
  return { ...existing, [path]: Math.max(1, outstanding + delta) };
};

/**
 * The first line of this file the turn has not been shown, or `undefined` when it has been shown
 * all of them up to `reachTo`.
 *
 * Asked of the COVERAGE record rather than of the snapshots. Two reads of lines 1-400 and 300-900
 * have shown lines 1-900 and this has to say so - a model that read the rest in a second call has
 * genuinely seen the file and should not be refused for the shape of how it got there. Asking the
 * snapshots was how that promise was broken: they are capped at four per file because they carry
 * text, so a file paged through in twenty windows kept the last four of them and the answer was no.
 * Measured on this repository at the time: 37 of 946 tracked files were long enough that no
 * sequence of reads could ever make a whole-file write of them legal - and the refusal named
 * reading the remainder, which is what the model had just finished doing.
 */
const firstUnshown = (taskId: string, path: string, reachTo: number): number | undefined =>
  firstUnshownLine(displayedRanges(taskId, path), reachTo);

/**
 * The workspace tools: commands, processes and files on the owner's own computer.
 *
 * These are the arms that can change the machine, and three of them carry state the turn has to
 * remember across calls - the SHA the file was read at, which is what makes a blind overwrite
 * refusable rather than merely regrettable.
 */
export async function executeWorkspaceTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, state } = context;
  const root = `/v1/workspaces/${task.workspaceId}`;
  switch (call.name) {
    case 'shell': {
      const background = call.arguments.background === true;
      const execution = { ...call.arguments };
      delete execution.background;
      const executable = textValue(execution.executable).split('/').pop()?.toLowerCase();
      /*
       * Whether this invocation is asking the computer to install software on itself.
       *
       * It decides one thing: whether the request carries the `system.packages` capability, which
       * is what lets the runner rewrite the command onto the privileged helper. The runner does
       * the real parse - `packageOperation` in `services/workspace-runner/src/execution.ts` is the
       * authority on which manager and which verb it can carry out, and it refuses anything else
       * by name.
       *
       * This gate used to name apt and apt-get and the verbs `install` and `update`, which is one
       * of the four families this box runs on and one of the spellings those families use. On
       * Fedora, Rocky, Arch, Alpine and openSUSE the capability was never requested, so `dnf
       * install` reached the runner without it and was refused with "an approved system-packages
       * capability is required" - a message about a permission, for a command that would have
       * been allowed. The runner-side repair for the other families landed and could not be
       * reached from here.
       *
       * Deliberately a superset of what the helper carries out rather than a copy of it. A gate
       * narrower than the parse behind it is exactly the defect above; a gate wider than it costs
       * a capability on a command the runner then declines by name, which is the better message
       * of the two. The four managers `PACKAGE_OPERATIONS` leaves out - emerge, rpm, rpm-ostree
       * and yay - are omitted here too: they are package management as far as the approval card
       * is concerned and not something this helper can carry out.
       */
      const systemPackageCommand =
        !background &&
        HELPER_PACKAGE_MANAGERS.has(executable ?? '') &&
        Array.isArray(execution.args) &&
        execution.args.some((argument) => {
          const value = String(argument).toLowerCase();
          // pacman says what it is doing with a flag rather than a verb: `-S` with names is an
          // install and `-Sy` with none is an index refresh.
          return (
            PACKAGE_VERBS.has(value) || (executable === 'pacman' && /^-[a-z]*s[a-z]*$/.test(value))
          );
        });
      const result = await context.runner.call(
        task.workspaceId,
        task.id,
        systemPackageCommand ? ['exec', 'system.packages'] : 'exec',
        background ? `${root}/processes/start` : `${root}/exec`,
        execution
      );
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return result;
    }
    case 'process': {
      const action = textValue(call.arguments.action, 'list');
      if (action === 'list')
        return context.runner.call(task.workspaceId, task.id, 'exec', `${root}/processes`);
      const sessionId = textValue(call.arguments.sessionId);
      if (!sessionId) throw new Error('process requires sessionId for this action');
      return context.runner.call(
        task.workspaceId,
        task.id,
        'exec',
        `${root}/processes/${encodeURIComponent(sessionId)}`,
        { action, ...(call.arguments.data === undefined ? {} : { data: call.arguments.data }) }
      );
    }
    case 'files_list':
      return context.runner.call(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/files?path=${encodeURIComponent(textValue(call.arguments.path, 'workspace'))}`
      );
    case 'file_read': {
      const path = textValue(call.arguments.path);
      /*
       * A window is read as a window.
       *
       * Asking for lines 900-920 used to pull the entire file across the runner boundary and into
       * this process, decode it, split it, and throw all but twenty lines away. On a log or a
       * dataset that is the difference between a small request and one that can exhaust the
       * worker - and the runner has always had a ranged reader, which nothing called.
       *
       * The whole-file path stays for the unbounded case, because it is the only one that
       * returns the hash `file_write` needs: a whole-file write does not fail on a concurrent
       * change, it silently discards it, and this tree has at least three other writers - the
       * agent's own shell, a second worker slot, and the owner in the file browser.
       */
      // The second of the three clamps that already defended against `NaN`, and the defence was
      // the implicit one: `NaN > 0` is false, so an unreadable line number fell through to the
      // whole-file read. Said out loud now, in the words the other arms use.
      const requestedStart = finiteNumber(call.arguments.startLine) ?? 0;
      const requestedEnd = finiteNumber(call.arguments.endLine) ?? 0;
      const windowed = requestedStart > 0 || requestedEnd > 0;
      if (windowed) {
        const startLine = Math.max(1, requestedStart || 1);
        const wanted = Math.max(startLine, requestedEnd || startLine + 200);
        /*
         * The same two budgets the unwindowed arm below is held to, and for the same reason rather
         * than for symmetry.
         *
         * This arm used to fetch 400,000 bytes and record every line of them as displayed, while
         * `recordToolResult` cut the result to 24,000 characters two layers downstream. On this
         * repository's largest test file `file_read {startLine: 1, endLine: 8332}` delivered all
         * 354,014 bytes, vouched for all 8,332 lines, and put 5.95% of them in front of the model -
         * the identical defect the unwindowed bound was shipped to close, still open on the arm that
         * is 47.4% of the read traffic on this machine. It also made the write guard below trivially
         * walkable: one wide window and the record claimed the whole file had been seen.
         *
         * It binds on very little real traffic. Across 12,347 windowed reads measured on this
         * machine p90 displayed is 360 lines, and 360 lines of this repository's average 43.4
         * characters is 15,600 bytes - inside both budgets.
         */
        const endLine = Math.min(wanted, startLine + FILE_READ_DISPLAY_LINES - 1);
        const read = await context.runner.readFileLines(task.workspaceId, task.id, path, {
          startLine,
          endLine,
          maxBytes: FILE_READ_DISPLAY_BYTES
        });
        /*
         * A read that stopped MID-LINE displayed half a line, and half a line is not displayed. It
         * is still returned - the model asked for it - but it is not recorded as seen, because a
         * record that vouched for the half that never arrived is exactly the blind anchor the
         * record exists to refuse. The runner's own seen-line ledger draws the same line in the
         * same place, deliberately, off the same field.
         *
         * `truncated` is not that question and answering it with `truncated` cost a line per
         * window. A window whose budget ran out exactly as a line ended delivered that line whole
         * and is reported truncated because it could not start the next one; cutting the last row
         * off then discards a line the model is looking at. Measured through this arm over 947
         * tracked text files, nine of them page end to end into coverage with a hole in it -
         * `evals/report.ts` delivers line 337 and recorded 1-336 - and the whole-file write the
         * paging had earned was refused, naming a line the model had already been shown.
         */
        const shownLines = toLines(read.content);
        const whole = read.partialLine ? shownLines.slice(0, -1) : shownLines;
        if (whole.length) recordRead(task.id, path, read.startLine, whole.join('\n'));
        /*
         * What this window leaves outstanding, so the whole-file write below can be asked about it.
         *
         * Nothing did this before, and that was the severe hole: a window read set no length and
         * claimed no hash, so the worker's guard had nothing to consult and the runner's ran behind
         * a hash this arm cannot produce. Measured through the shipped tool, `file_read` of lines
         * 1-200 followed by a whole-file `file_write` was accepted and destroyed 8,132 lines.
         *
         * `totalLines` only arrives when the reader actually reached the end of the file; when it
         * did not, all that is known is that the file goes further than what came back whole, and
         * that is enough to refuse a write claiming to replace all of it.
         */
        /*
         * `read.endLine` is a line this window reached; the floor has to be a line it did not show,
         * and which of those two `endLine` is depends on how the window ended.
         *
         * Cut mid-line, `endLine` IS the unshown line - half of it arrived, so naming it is exact.
         * Cut between lines, `endLine` was delivered whole and the file is known to go at least one
         * further, because the reader stopped only when it found another line to start. Carrying
         * the mid-line answer into the between-lines case understates the floor by one, and that
         * one line is the difference between refusing a whole-file write after a single window of a
         * 901-line file and accepting it: measured with the record fixed and this left alone, the
         * worker's floor stopped firing and only the runner's own guard still refused.
         */
        const reachTo =
          read.totalLines ??
          (read.partialLine ? read.endLine : Math.max(read.endLine + 1, startLine));
        state.partialReads = withPartialRead(
          state.partialReads,
          path,
          read.totalLines !== undefined &&
            firstUnshown(task.id, path, read.totalLines) === undefined
            ? undefined
            : reachTo
        );
        return {
          path,
          startLine: read.startLine,
          endLine: read.endLine,
          ...(read.totalLines === undefined ? {} : { totalLines: read.totalLines }),
          // Where to carry on from, when the window was cut short by its own byte budget rather
          // than by reaching the end. Without it a truncated read is a dead end.
          ...(read.nextStartLine === undefined ? {} : { nextStartLine: read.nextStartLine }),
          // True when the window the model asked for is not the window it got, whichever budget
          // stopped it: saying `false` because no line was cut in half, on a request for 8,332
          // lines answered with 800, is the report being wrong in the direction that costs most.
          truncated: read.truncated || read.endLine < wanted,
          content: renderNumbered(shownLines, read.startLine)
        };
      }
      /*
       * The budget travels with the request, and what comes back is what was recorded as shown.
       *
       * This arm used to fetch the whole file and cut it here. The cut was right and the place was
       * wrong: the runner is where the seen-line ledger lives, so a prefix chosen after the fact was
       * a prefix that ledger never heard about, and the two records of what the model had been shown
       * disagreed. Measured on a 659-line file, an unwindowed read displaying lines 1-397 followed
       * by a window over the remainder left the runner holding 398-659 only - and a patch to line
       * 50, a line the model HAD been shown, was refused by name. Asking for the prefix instead of
       * making one means the arm cannot display what it was not sent, so the two ledgers hold the
       * same lines by construction.
       */
      const read = await context.runner.readFileForDisplay(task.workspaceId, task.id, path, {
        maxBytes: FILE_READ_DISPLAY_BYTES,
        maxLines: FILE_READ_DISPLAY_LINES
      });
      const shown = toLines(read.content);
      // The same rule the windowed arm above draws: a line cut short by the byte budget is shown,
      // because an answer of no lines is a dead end, and is not recorded, because it did not arrive.
      const whole = read.partialLine ? shown.slice(0, -1) : shown;
      const complete = read.displayedLines >= read.totalLines;
      /*
       * The hash is still recorded, and deliberately, because it answers a different question.
       *
       * `expectSha256` asks "is this still the file you read", and the runner hashed the whole file
       * whatever it sent back - the bound is about what is DISPLAYED, not about what was hashed - so
       * the claim is as true as it ever was and the concurrency guard keeps working. What a partial
       * read must not do is authorise replacing the part it did not show, and that is a second
       * question with a second answer below. Conflating them by dropping the hash would refuse the
       * blind write by removing a guard, which is the wrong mechanism for the right refusal: it
       * would also switch the runner's own 409 off for the same file.
       */
      if (read.sha256)
        state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: read.sha256 };
      /*
       * What a read that did not show the whole file leaves behind: the file's real length, so a
       * later whole-file write can be asked whether anything has since shown the rest.
       *
       * Cleared on a complete read, because a read that showed everything has nothing outstanding
       * and a stale entry would refuse a write that is now perfectly well evidenced.
       */
      state.partialReads = withPartialRead(
        state.partialReads,
        path,
        complete ? undefined : read.totalLines
      );
      // Only what was displayed whole is recorded as displayed. This is the whole point of the
      // bound: `readsOf` is the evidence `file_patch` rests a line number on, and before this it
      // vouched for every line of the file after a read that had put a fraction of them on screen.
      if (whole.length) recordRead(task.id, path, 1, whole.join('\n'));
      return {
        path,
        startLine: 1,
        endLine: shown.length,
        totalLines: read.totalLines,
        /*
         * Where to carry on from, in the same words the windowed path above uses, so a read cut
         * short here is continued exactly as one cut short there is - and absent when there is
         * nowhere to carry on TO. A file of one line longer than the whole budget is the case that
         * proves this bound is about delivered bytes rather than delivered lines: it is reported
         * truncated, because it is, and it is offered no continuation, because there is no second
         * line and resuming at the first would hand back the same half forever.
         */
        ...(!complete && shown.length < read.totalLines ? { nextStartLine: shown.length + 1 } : {}),
        truncated: !complete,
        content: renderNumbered(shown, 1)
      };
    }
    /*
     * The line-addressed editor, which replaced oldText/newText search-and-replace outright.
     *
     * The old shape proved an edit was fresh by making the model quote the text it was replacing,
     * exactly once. That quote was the safety AND the cost: on a file that says `return null;`
     * eleven times the quote had to grow until it was unique, and then be typed back with one word
     * different. Measured on this repository's own corpus over fifteen tasks, addressing by line
     * number instead cost 61% fewer characters of arguments and won fourteen of the fourteen rows
     * where both formats did what the task asked. A move - the worst row - went from 777 characters
     * to 57, because the moved block crosses the wire once instead of twice.
     *
     * It REPLACES rather than joins. Two ways to do one thing doubles what the model has to learn,
     * pays for both entries on every request of every turn, and turns a real saving into a net loss;
     * `docs/design/edit/BUILD.md` has the byte ledger both ways.
     *
     * The freshness proof moved from the model to the harness. `apps/worker/src/edit/snapshots.ts`
     * remembers the exact lines each `file_read` above put in front of the model, so at apply time
     * there are two texts to compare - what was shown, and what is on disk now - and a range needs
     * to carry no evidence at all. That is strictly better evidence than a quote, because a quote is
     * the model's memory of the file and a snapshot is this process's record of what it sent.
     *
     * Nothing here loosens the two guards that were already on this path. The runner's hash from the
     * read is still claimed on the write, so a file that changed between the two fails closed rather
     * than being silently overwritten. The runner's own seen-line ledger still runs underneath,
     * against the whole-file write this produces, and it is what holds when this process's snapshot
     * cache is cold - a worker restart mid-turn loses an opinion here and loses nothing there.
     */
    case 'file_patch': {
      const patches = Array.isArray(call.arguments.patches)
        ? (call.arguments.patches as Array<Record<string, unknown>>)
        : [];
      if (!patches.length || patches.length > 40)
        throw new AthanorError('patch_invalid', 'Provide between 1 and 40 patches');
      const applied: Array<{
        path: string;
        sha256: string;
        lines: number;
        wrote: string;
        notes: readonly string[];
      }> = [];
      const failures: Array<{ path: string; reason: string }> = [];
      const readHashes = new Map<string, string>();
      const seenPaths = new Set<string>();
      for (const patch of patches) {
        const path = textValue(patch.path);
        const edit = textValue(patch.edit);
        if (!path || !edit)
          throw new AthanorError(
            'patch_invalid',
            'Every patch requires a path and a non-empty edit.'
          );
        /*
         * One patch per file, and a repeated path is refused rather than chained.
         *
         * Every range in a patch names the numbers of the read it came from. A second patch on the
         * same file would be addressed against those same numbers while the first patch had already
         * moved them, so chaining the two would apply the second one somewhere the model never
         * meant. Saying so is one sentence; getting it wrong is a corrupted file.
         */
        if (seenPaths.has(path))
          throw new AthanorError(
            'patch_invalid',
            `${path} appears in two patches of the same call. Every operation on one file addresses the numbers of the same read, so they belong in that file's single patch.`
          );
        seenPaths.add(path);
        let before: string;
        try {
          const read = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
          before = read.content;
          if (read.sha256) readHashes.set(path, read.sha256);
        } catch (cause) {
          failures.push({
            path,
            reason: `${path} could not be read: ${cause instanceof Error ? cause.message : 'read failed'}. Check the path with files_list before patching it.`
          });
          continue;
        }
        const result = applyEdit(path, edit, before, readsOf(task.id, path));
        if (!result.ok) {
          failures.push({ path, reason: result.refusal.message });
          continue;
        }
        const written = await context.runner.writeFile(
          task.workspaceId,
          task.id,
          path,
          result.text,
          readHashes.get(path)
        );
        const hash = (written as { sha256?: unknown })?.sha256;
        /*
         * What is on disk now is what this patch just wrote, in both ledgers.
         *
         * The hash, so a `file_write` later in the same turn claims the version this produced rather
         * than the one the read produced - without it the runner answered 409 naming the very tool
         * that had caused the change. And the snapshot, so a SECOND edit to this file needs no read
         * between them: the lines are text the model authored, which is text it has been shown by
         * definition, and the numbers in the echo below are the numbers of this recording.
         */
        if (typeof hash === 'string')
          state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: hash };
        const after = toLines(result.text);
        /*
         * What this patch changed, and what it did NOT.
         *
         * Both of these used to say the file had been read in full - the floor was deleted and the
         * whole new text was recorded as shown - on the reasoning that the version the read was
         * about no longer exists. One successful patch therefore disarmed both layers of the guard
         * for the rest of the turn, on every file, always: measured on the shipped arm, a windowed
         * read of lines 1-200 then one `PUT 10:` left `PUT 8000:` landing silently at a line
         * nothing had displayed, and a whole-file write destroying 576,512 bytes accepted. What a
         * patch authorises is the span it wrote; the rest of the file is exactly as unread as it
         * was, one line-count shorter or longer.
         */
        state.partialReads = shiftPartialRead(
          state.partialReads,
          path,
          after.length - toLines(before).length
        );
        recordWrite(task.id, path, result.text, result.changed);
        applied.push({
          path,
          sha256: sha256(result.text),
          lines: after.length,
          wrote: result.wrote
            .slice(0, Math.ceil(ECHO_MAX_ROWS / (ECHO_ROWS_PER_REGION + 2)))
            .map((region) =>
              region.to - region.from + 1 <= ECHO_ROWS_PER_REGION + 2
                ? numberedWindow(after, region, 1)
                : `${numberedWindow(after, { from: region.from, to: region.from }, 1)}\n...\n${numberedWindow(after, { from: region.to, to: region.to }, 1)}`
            )
            // A blank line between regions: two ranges of numbers run together read as one range
            // with a gap in it, which is the one thing this echo exists to make unambiguous.
            .join('\n\n'),
          notes: result.notes
        });
      }
      if (!applied.length)
        throw new AthanorError(
          'patch_conflict',
          failures.map((failure) => failure.reason).join('\n\n') || 'No patch could be applied'
        );
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return {
        filesChanged: applied.map(({ path, sha256: digest, lines }) => ({
          path,
          sha256: digest,
          lines
        })),
        patchCount: applied.length,
        // The numbers the file now has, so the next edit to it addresses this and not the read.
        wrote: applied.map(({ path, wrote }) => `${path}\n${wrote}`).join('\n\n'),
        ...(applied.some(({ notes }) => notes.length)
          ? { notes: applied.flatMap(({ notes }) => notes) }
          : {}),
        ...(failures.length
          ? {
              failed: failures,
              instruction: `${failures.length} of ${patches.length} patches were not applied and wrote nothing; the rest are already written. Each reason below carries the file's real text at those lines, so fix only the failures and send them again without reading first.`
            }
          : {})
      };
    }
    case 'image_read':
      return context.runner.readImage(task.workspaceId, task.id, textValue(call.arguments.path));
    case 'file_write': {
      const writePath = textValue(call.arguments.path);
      /*
       * A whole-file write may not be the way a model discards the part of a file it was never
       * shown.
       *
       * This is the other half of the display bound above, and without it that bound would have
       * made things worse rather than better: capping the display while leaving this alone means a
       * model that saw 415 lines of 2,000 still holds a hash over all 2,000, the runner's
       * concurrency check passes because the file really has not changed, and 1,585 lines are
       * destroyed by a call that looked entirely well-formed.
       *
       * This comment used to claim the WINDOWED read was the safe one - that the same write after a
       * window "is refused by name one layer down". It was not. Measured through this arm against
       * the real runner on an 8,332-line file: after `file_read {startLine: 1, endLine: 200}` the
       * whole-file write was ACCEPTED and destroyed 8,330 of 8,332 lines, 354,002 of 354,014 bytes.
       * The runner's guard is correct and fires by name when it runs; it simply never ran, because
       * the windowed arm claims no hash and the guard was opened only for callers that do. Both
       * ends of that are now closed - every read arm records what it left outstanding here, and the
       * runner holds an agent's write to its record whether or not a hash came with it - and the
       * lesson is the one this repository already has a rule about: a comment is not a measurement.
       *
       * It is a coverage question, not a freshness one, so it is asked of the read record rather
       * than of the hash - and it lifts the moment the record covers the file, which is what makes
       * the refusal below performable rather than a wall. Reading the rest with startLine and
       * endLine is a thing the model can actually do, and doing it clears this.
       */
      const outstanding = state.partialReads?.[writePath];
      const unshownFrom =
        outstanding === undefined ? undefined : firstUnshown(task.id, writePath, outstanding);
      if (unshownFrom !== undefined)
        throw new AthanorError(
          'write_unread',
          /*
           * One outstanding line is the file with no newlines in it, and it needs a different
           * sentence because the usual two recoveries are both closed to it: there is no further
           * range to read, and a line-addressed edit needs a line that has been shown whole. Naming
           * a recovery the model cannot perform is a failure this repository has already paid for
           * once, in a truncation marker that said "run the tool again".
           */
          outstanding === 1
            ? `${writePath} is a single line too long to be delivered in one read, so you have been shown only the start of it and writing the whole file would discard the rest. A line-addressed edit cannot reach it either, because its one line has never been shown whole. Transform it with a program from the shell instead - read the file, change it, write it back - so nothing depends on you having seen all of it.`
            : `${writePath} has at least ${outstanding} lines and line ${unshownFrom} onwards has never been shown to you, so writing the whole file would discard the part you have not read. Either use file_patch, which changes the lines you were shown and leaves the rest of the file exactly as it is, or read from line ${unshownFrom} with file_read using startLine and endLine and then send this write again.`
        );
      // Only claimed when this turn actually read the file. A first write, or a write to
      // something never read, claims nothing and proceeds - demanding a hash everywhere would
      // refuse every file this computer creates.
      const expected = state.readFileHashes?.[writePath];
      const result = await context.runner.writeFile(
        task.workspaceId,
        task.id,
        writePath,
        textValue(call.arguments.content),
        expected
      );
      // What is on disk now is what this turn just wrote, so a second write in the same turn
      // claims that rather than the version read before it.
      if (typeof (result as { sha256?: unknown })?.sha256 === 'string')
        state.readFileHashes = {
          ...(state.readFileHashes ?? {}),
          [writePath]: (result as { sha256: string }).sha256
        };
      // The content is what this call supplied, so there is no unread remainder left to protect -
      // and the record of what has been shown becomes that content, whole. This is the one write
      // where "text a caller authored is text it has been shown" is true of the whole file, and
      // saying so replaces a record whose line numbers describe a version that is now gone.
      state.partialReads = withPartialRead(state.partialReads, writePath, undefined);
      recordWrite(task.id, writePath, textValue(call.arguments.content));
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return result;
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
