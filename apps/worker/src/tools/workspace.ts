import { sha256, AthanorError } from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import {
  countOccurrences,
  patchFailure,
  textValue,
  HELPER_PACKAGE_MANAGERS,
  PACKAGE_VERBS,
  type PatchFailure
} from '../agent.js';
import { type ToolContext } from '../tool-dispatch.js';
import { finiteNumber } from './numbers.js';

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
        return {
          path,
          startLine: read.startLine,
          endLine: read.endLine,
          ...(read.totalLines === undefined ? {} : { totalLines: read.totalLines }),
          // Where to carry on from, when the window was cut short by its own byte budget rather
          // than by reaching the end. Without it a truncated read is a dead end.
          ...(read.nextStartLine === undefined ? {} : { nextStartLine: read.nextStartLine }),
          truncated: read.truncated,
          content: read.content
        };
      }
      const read = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
      if (read.sha256)
        state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: read.sha256 };
      const lines = read.content.split('\n');
      return {
        path,
        startLine: 1,
        endLine: lines.length,
        totalLines: lines.length,
        truncated: false,
        content: read.content
      };
    }
    case 'file_patch': {
      const patches = Array.isArray(call.arguments.patches)
        ? (call.arguments.patches as Array<Record<string, unknown>>)
        : [];
      if (!patches.length || patches.length > 40)
        throw new AthanorError('patch_invalid', 'Provide between 1 and 40 patches');
      const prepared: Array<{
        path: string;
        before: string;
        after: string;
        oldText: string;
        newText: string;
      }> = [];
      const latestByPath = new Map<string, string>();
      /*
       * The runner's own hash of what was read, kept so the write can claim it.
       *
       * A patch is a read-modify-write, and the write went out with no expectation at all - so
       * between the read and the write anything could change the file and the patch would land on
       * top of it silently. The whole-file `file_write` beside this has claimed its read since the
       * lost-update repair; this path had the same defect and none of the guard.
       */
      const readHashes = new Map<string, string>();
      // Every patch that matches is applied. The batch used to be all-or-nothing, so one stale
      // hunk out of five discarded the four that would have landed cleanly - and the model then
      // had to re-read files whose earlier reads the window had already gutted.
      const failures: PatchFailure[] = [];
      for (const patch of patches) {
        const path = textValue(patch.path);
        const oldText = textValue(patch.oldText);
        const newText = textValue(patch.newText);
        if (!path || !oldText)
          throw new AthanorError(
            'patch_invalid',
            'Every patch requires a path and non-empty oldText'
          );
        let before = latestByPath.get(path);
        if (before === undefined) {
          try {
            const read = await context.runner.readFileWithHash(task.workspaceId, task.id, path);
            before = read.content;
            if (read.sha256) readHashes.set(path, read.sha256);
          } catch (cause) {
            failures.push({
              path,
              occurrences: 0,
              reason: `${path} could not be read: ${cause instanceof Error ? cause.message : 'read failed'}. Check the path with files_list before patching it.`
            });
            continue;
          }
        }
        if (countOccurrences(before, oldText) !== 1) {
          failures.push(patchFailure(path, before, oldText));
          continue;
        }
        const after = before.replace(oldText, newText);
        prepared.push({ path, before, after, oldText, newText });
        latestByPath.set(path, after);
      }
      if (!prepared.length)
        throw new AthanorError(
          'patch_conflict',
          failures.map((failure) => failure.reason).join(' ') || 'No patch could be applied'
        );
      const changed = [...latestByPath.entries()];
      const writtenHashes = new Map<string, string>();
      for (const [path, content] of changed) {
        const written = await context.runner.writeFile(
          task.workspaceId,
          task.id,
          path,
          content,
          readHashes.get(path)
        );
        const hash = (written as { sha256?: unknown })?.sha256;
        if (typeof hash === 'string') writtenHashes.set(path, hash);
      }
      /*
       * What is on disk now is what this patch just wrote.
       *
       * Without this, a read-then-patch-then-write inside one turn sent the pre-patch hash to the
       * runner, which answered 409 - "this file changed after you read it... or use file_patch" -
       * naming the tool that had caused it. The only thing that changed the file was the agent's
       * own patch two calls earlier. The runner's own hash is preferred over one computed here
       * for the same reason the read claims one: it is the hash the next write will be checked
       * against, and anything else is this side guessing at it.
       */
      for (const [path] of changed) {
        const hash = writtenHashes.get(path);
        if (hash) state.readFileHashes = { ...(state.readFileHashes ?? {}), [path]: hash };
      }
      const usage = await context.runner.call<{ storageBytes: number }>(
        task.workspaceId,
        task.id,
        'files.read',
        `${root}/usage`
      );
      await context.store.setWorkspaceStorage(task.userId, task.workspaceId, usage.storageBytes);
      return {
        filesChanged: changed.map(([path, content]) => ({
          path,
          sha256: sha256(content),
          replacements: prepared.filter((patch) => patch.path === path).length
        })),
        patchCount: prepared.length,
        ...(failures.length
          ? {
              failed: failures,
              instruction: `${failures.length} of ${patches.length} patches did not apply and were skipped; the rest are already written. Fix only the failures below and send them again.`
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
