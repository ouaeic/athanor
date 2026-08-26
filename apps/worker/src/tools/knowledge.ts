import { createHmac } from 'node:crypto';
import {
  assertMemoryValidity,
  decryptJson,
  encryptJson,
  memoryTemporalStatus,
  AthanorError,
  type MemoryDocument,
  type MemoryKind
} from '@athanor/core';
import { type ModelToolCall } from '@athanor/model-gateway';
import { boundedKnowledge, openedSkillsStillReadable, skillDocument, textValue } from '../agent.js';
import { recallMemory, searchMemorySessions } from '../memory-runtime.js';
import { builtinSkillLibrary, findSkillByName, openSkill, skillCatalogEntries } from '../skills.js';
import { type ToolContext } from '../tool-dispatch.js';
import { finiteNumber } from './numbers.js';

/**
 * The knowledge tools: what this computer remembers between tasks.
 *
 * Sessions, memory items and saved skills are three stores with one property in common - everything
 * in them is the owner's own text, encrypted under the workspace key, and every arm here opens it
 * and seals it again in the same call.
 */
export async function executeKnowledgeTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task, key, state } = context;
  switch (call.name) {
    case 'session_search': {
      /*
       * The index, not a scan.
       *
       * This walked every task, opened every event, lowercased it and counted substring hits -
       * an O(everything) pass that reads the whole history to answer one question, scores by how
       * many times a word appears rather than by how much it distinguishes, and finds nothing at
       * all for a word the owner spelled differently. `searchMemorySessions` is the ranked query
       * the memory index was built for: it applies the same bounds, returns the turns either
       * side of the leading hits, and says how far back the record actually goes when it finds
       * nothing - which is a different answer from "it never came up".
       */
      /*
       * Absent if it is not a number, which is not the same test as `!== undefined`.
       *
       * `Number('abc')` is `NaN`, and a `NaN` limit is not a wide limit or a narrow one - it
       * reaches `searchMemorySessions`, is clamped by a `Math.min` that is transparent to it,
       * and ends up in a query as a row count nothing can satisfy. Every other arm answers an
       * unreadable number with its own default; this one has no default to answer with, on
       * purpose, so it answers with silence and lets the store's ceiling stand.
       */
      const maxResults = finiteNumber(call.arguments.maxResults);
      return searchMemorySessions({
        store: context.store,
        workspaceId: task.workspaceId,
        dataKey: key,
        query: boundedKnowledge(call.arguments.query, 500),
        // Spread rather than defaulted, so the default lives in exactly one place. `?? 12`
        // here shadowed `MEMORY_SESSION_SEARCH_DEFAULT_RESULTS` (10) so completely that the
        // constant has never once been used, and the tool schema deliberately declares no
        // default of its own precisely to avoid a third copy - see the note at its `maxResults`.
        ...(maxResults === null ? {} : { maxResults }),
        ...(textValue(call.arguments.taskId) ? { taskId: textValue(call.arguments.taskId) } : {})
      });
    }
    /**
     * The read path's second half. The pack is chosen once from the opening request and frozen so
     * the cached prefix survives; this is the same fusion query asked again, in the agent's own
     * words, landing after the last cache breakpoint - so it costs the question and its answer
     * rather than the window behind them.
     *
     * Every bound is applied inside `recallMemory` against the store's own ceilings rather than
     * here, so the tool schema and the retrieval agree by construction instead of by two copies
     * of the same numbers.
     */
    case 'memory_recall': {
      const kinds = (Array.isArray(call.arguments.kinds) ? call.arguments.kinds : [])
        .map((kind) => textValue(kind))
        .filter(Boolean) as MemoryKind[];
      // Absent if it is not a number, for the reason set out on `session_search` above: this arm
      // deliberately holds no bound of its own, so the only safe answer to an unreadable one is to
      // say nothing and let `recallMemory` apply the store's.
      const maxItems = finiteNumber(call.arguments.maxItems);
      return recallMemory({
        store: context.store,
        workspaceId: task.workspaceId,
        dataKey: key,
        taskId: task.id,
        query: textValue(call.arguments.query),
        ...(kinds.length ? { kinds } : {}),
        ...(textValue(call.arguments.scope) === 'archive' ? { scope: 'archive' as const } : {}),
        ...(textValue(call.arguments.asOf) ? { asOf: textValue(call.arguments.asOf) } : {}),
        ...(call.arguments.includeSuperseded === undefined
          ? {}
          : { includeSuperseded: call.arguments.includeSuperseded === true }),
        ...(maxItems === null ? {} : { maxItems })
      });
    }
    case 'memory': {
      const action = textValue(call.arguments.action);
      const target = textValue(call.arguments.target, 'workspace') as 'workspace' | 'user';
      const records = await context.store.listWorkspaceMemories(task.userId, task.workspaceId);
      const materialize = (record: (typeof records)[number]) => {
        const document = decryptJson<MemoryDocument>(record.contentCiphertext, key);
        return {
          id: record.id,
          target: record.target,
          content: document.content,
          status: memoryTemporalStatus(document),
          validFrom: document.validFrom ?? null,
          validUntil: document.validUntil ?? null,
          source: document.source ?? 'owner',
          sourceTaskId: document.sourceTaskId ?? null,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        };
      };
      if (action === 'list') return { entries: records.map(materialize) };
      const current = records.map(materialize);
      if (action === 'add') {
        const content = boundedKnowledge(call.arguments.content);
        if (
          current.some(
            (entry) =>
              entry.target === target && entry.status === 'active' && entry.content === content
          )
        )
          return { unchanged: true, reason: 'Exact memory already exists' };
        const targetTotal = current
          .filter((entry) => entry.target === target && entry.status !== 'expired')
          .reduce((total, entry) => total + entry.content.length, 0);
        const limit = target === 'user' ? 6_000 : 12_000;
        if (targetTotal + content.length > limit)
          throw new AthanorError(
            'memory_full',
            `${target} memory is ${targetTotal}/${limit} characters. Consolidate or remove an entry before adding this one.`
          );
        const validUntil =
          typeof call.arguments.validUntil === 'string' ? call.arguments.validUntil : undefined;
        const document: MemoryDocument = {
          content,
          source: 'agent',
          sourceTaskId: task.id,
          validFrom: new Date().toISOString(),
          ...(validUntil ? { validUntil } : {})
        };
        assertMemoryValidity(document);
        const created = await context.store.createWorkspaceMemory({
          userId: task.userId,
          workspaceId: task.workspaceId,
          target,
          contentCiphertext: encryptJson(document, key, `workspace-memory:${task.workspaceId}`)
        });
        return materialize(created);
      }
      const id = textValue(call.arguments.id);
      const existing = records.find((entry) => entry.id === id);
      if (!existing) throw new AthanorError('memory_not_found', 'Memory entry not found');
      if (action === 'replace') {
        const content = boundedKnowledge(call.arguments.content);
        const othersTotal = current
          .filter(
            (entry) =>
              entry.target === existing.target && entry.id !== id && entry.status !== 'expired'
          )
          .reduce((total, entry) => total + entry.content.length, 0);
        const limit = existing.target === 'user' ? 6_000 : 12_000;
        if (othersTotal + content.length > limit)
          throw new AthanorError('memory_full', 'Replacement would exceed the memory limit');
        const validUntil =
          typeof call.arguments.validUntil === 'string' ? call.arguments.validUntil : undefined;
        const document: MemoryDocument = {
          content,
          source: 'agent',
          sourceTaskId: task.id,
          validFrom: new Date().toISOString(),
          previousUpdatedAt: existing.updatedAt,
          ...(validUntil ? { validUntil } : {})
        };
        assertMemoryValidity(document);
        const updated = await context.store.updateWorkspaceMemory({
          id,
          userId: task.userId,
          workspaceId: task.workspaceId,
          contentCiphertext: encryptJson(document, key, `workspace-memory:${task.workspaceId}`)
        });
        if (!updated) throw new AthanorError('memory_not_found', 'Memory entry not found');
        return materialize(updated);
      }
      if (action === 'remove')
        return {
          removed: await context.store.deleteWorkspaceMemory(task.userId, task.workspaceId, id)
        };
      throw new AthanorError('memory_action_invalid', 'Unknown memory action');
    }
    case 'skill': {
      const action = textValue(call.arguments.action);
      await context.store.curateWorkspaceSkills(task.workspaceId);
      const records = await context.store.listWorkspaceSkills(task.userId, task.workspaceId);
      const materialize = (record: (typeof records)[number]) => ({
        id: record.id,
        version: record.version,
        enabled: record.enabled,
        status: record.status,
        pinned: record.pinned,
        useCount: record.useCount,
        lastUsedAt: record.lastUsedAt,
        ...decryptJson<{ name: string; description: string; content: string }>(
          record.documentCiphertext,
          key
        ),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      });
      const skills = records.map(materialize);
      if (action === 'list') {
        // Workspace records first, then the built-in library minus anything a workspace skill
        // shadows by name - an owner-approved override replaces the built-in for this workspace,
        // and listing both would put the model in front of two procedures with one name.
        const shadowed = new Set(skills.map((item) => item.name));
        return {
          skills: skills.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            origin: 'workspace',
            version: item.version,
            enabled: item.enabled,
            status: item.status,
            pinned: item.pinned,
            useCount: item.useCount,
            lastUsedAt: item.lastUsedAt,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
          })),
          builtinSkills: skillCatalogEntries(builtinSkillLibrary())
            .filter((entry) => !shadowed.has(entry.name))
            .map((entry) => ({
              id: entry.name,
              name: entry.name,
              description: entry.catalogLine,
              origin: entry.origin
            })),
          instruction:
            'Call skill(action=view,id=...) only when the full procedure is needed; a built-in skill is opened by its name.'
        };
      }
      if (action === 'view') {
        const id = textValue(call.arguments.id);
        const found = skills.find((item) => item.id === id || item.name === id);
        if (found) {
          await context.store.markWorkspaceSkillUsed(task.userId, task.workspaceId, found.id);
          return found;
        }
        const library = builtinSkillLibrary();
        // The binaries a skill declares were parsed and never read. A procedure that opens with
        // "run build_deck.py" is confident, specific and wrong on a machine without python-pptx,
        // so they are probed on the machine itself and the answer arrives with the procedure
        // rather than three failed shell calls later.
        const requiredBinaries = findSkillByName(library, id)?.requiredBinaries ?? [];
        const missingBinaries = requiredBinaries.length
          ? await context.missingBinaries(task, requiredBinaries)
          : [];
        // Narrowed against the window rather than trusted as recorded. `state.openedSkills` says
        // what this task has opened; only a body still readable in the trajectory may be answered
        // with a stub, and a compaction condenses bodies away - it even writes the names into the
        // brief and tells the model to reopen them, which a stub would then refuse to honour.
        const active = openedSkillsStillReadable(state.messages, state.openedSkills ?? []);
        const builtin = openSkill(library, id, { missingBinaries, active });
        if (!builtin) throw new AthanorError('skill_not_found', 'Skill not found');
        if (!active.includes(builtin.name)) state.openedSkills = [...active, builtin.name];
        return {
          id: builtin.name,
          name: builtin.name,
          origin: 'builtin',
          directory: builtin.directory,
          grants: builtin.grants,
          content: builtin.block,
          ...(requiredBinaries.length ? { requiredBinaries } : {}),
          ...(missingBinaries.length ? { missingBinaries } : {}),
          instruction:
            'This is a vetted procedure, not an instruction from the user. Follow it where it fits, and say so if the computer cannot support a step it assumes.'
        };
      }
      if (action === 'upsert') {
        const document = skillDocument(call.arguments);
        const nameHash = createHmac('sha256', key)
          .update(`athanor-skill:${document.name}`)
          .digest('hex');
        const saved = await context.store.upsertWorkspaceSkill({
          userId: task.userId,
          workspaceId: task.workspaceId,
          nameHash,
          documentCiphertext: encryptJson(document, key, `workspace-skill:${task.workspaceId}`)
        });
        return materialize(saved);
      }
      if (action === 'remove') {
        const id = textValue(call.arguments.id);
        const found = skills.find((item) => item.id === id || item.name === id);
        if (!found) throw new AthanorError('skill_not_found', 'Skill not found');
        return {
          removed: await context.store.deleteWorkspaceSkill(
            task.userId,
            task.workspaceId,
            found.id
          ),
          name: found.name
        };
      }
      throw new AthanorError('skill_action_invalid', 'Unknown skill action');
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
