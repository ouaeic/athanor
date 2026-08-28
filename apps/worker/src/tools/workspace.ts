import { sha256, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import {
  applyEdit,
  numberedWindow,
  readsOf,
  recordRead,
  recordWrite,
  renderNumbered,
  toLines
} from '../edit/index.js';
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
        const endLine = Math.max(startLine, requestedEnd || startLine + 200);
        const read = await context.runner.readFileLines(task.workspaceId, task.id, path, {
          startLine,
          endLine,
          maxBytes: 400_000
        });
        /*
         * A read that stopped on its byte budget stopped mid-line, and that line was not displayed.
         * It is still returned - the model asked for it - but it is not recorded as seen, because a
         * record that vouched for the half that never arrived is exactly the blind anchor the
         * record exists to refuse. The runner's own seen-line ledger draws the same line in the
         * same place, deliberately.
         */
        const shownLines = toLines(read.content);
        const whole = read.truncated ? shownLines.slice(0, -1) : shownLines;
        if (whole.length) recordRead(task.id, path, read.startLine, whole.join('\n'));
        return {
          path,
          startLine: read.startLine,
          endLine: read.endLine,
          ...(read.totalLines === undefined ? {} : { totalLines: read.totalLines }),
          // Where to carry on from, when the window was cut short by its own byte budget rather
          // than by reaching the end. Without it a truncated read is a dead end.
          ...(read.nextStartLine === undefined ? {} : { nextStartLine: read.nextStartLine }),
          truncated: read.truncated,
          content: renderNumbered(shownLines, read.startLine)
        };
      }
      const read = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
      if (read.sha256)
        state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: read.sha256 };
      const lines = toLines(read.content);
      recordRead(task.id, path, 1, read.content);
      return {
        path,
        startLine: 1,
        endLine: lines.length,
        totalLines: lines.length,
        truncated: false,
        content: renderNumbered(lines, 1)
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
        recordWrite(task.id, path, result.text);
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
