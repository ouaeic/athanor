import { ConversationSource } from '@athanor/contracts';
import { decryptJson, unwrapDataKey } from '@athanor/core';
import { projectResponse, type TaskRecord } from '@athanor/data';
import type { WindowDeps } from './window.js';

const excerpt = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[Excerpt; use the source for more.]` : text;

/** Source-linked context is data. It never becomes an owner message or an approval grant. */
export async function conversationContext(
  deps: Pick<WindowDeps, 'store' | 'runner' | 'masterKey'>,
  task: TaskRecord,
  key: Uint8Array
): Promise<string> {
  if (!task.projectId || task.parentMissionId) return '';
  const [record, page, inputs, notes] = await Promise.all([
    deps.store.getProject(task.userId, task.projectId),
    deps.store.listProjectConversations(task.userId, task.projectId, { limit: 12 }),
    deps.runner.call<{ sources: Array<{ workspaceId: string; path: string }> }>(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/project-inputs`
    ),
    deps.store.listProjectNotes(task.userId, task.projectId, deps.masterKey, { limit: 8 })
  ]);
  if (!record) return '';
  const project = projectResponse(record, deps.masterKey);
  const lines = [
    `Project ${project.id}: ${project.title}`,
    `Shared brief:\n${excerpt(project.brief, 8000)}`,
    'Each conversation has its own direction, history and approvals. Search related conversations with session_search; an empty search is not proof that work did not happen.',
    'Write outputs in your own workspace. Shared input paths are read-only; scripts can read datasets in place without copying them. Use process tools for long-running work.',
    ...inputs.sources
      .slice(0, 24)
      .map((source) => `Input workspace ${source.workspaceId}: ${source.path}`),
    'Owner-saved project notes (source claims remain fallible):',
    ...notes.notes.map(
      (note) =>
        `${note.kind} ${note.id}${note.source ? ` from conversation ${note.source.taskId}${note.source.eventId ? ` event ${note.source.eventId}` : ''}` : ' (owner note)'}: ${excerpt(note.body, 600)}`
    ),
    `Recent conversations (${page.nextCursor ? 'partial list' : 'all listed'}):`,
    ...page.tasks.map(
      (other) =>
        `${other.id} [${other.status}] ${other.titleCiphertext ? excerpt(decryptJson<{ title: string }>(other.titleCiphertext, key).title, 160) : (other.legacyTitle ?? 'Conversation')}; workspace ${other.workspaceId}`
    )
  ];
  if (task.conversationSourceCiphertext) {
    const selected = ConversationSource.parse(
      decryptJson(task.conversationSourceCiphertext, key, `conversation-source:${project.id}`)
    );
    const source = await deps.store.getTask(task.userId, selected.taskId);
    if (source?.projectId === project.id) {
      const workspace = await deps.store.getWorkspace(task.userId, source.workspaceId);
      if (workspace?.wrappedKey) {
        const sourceKey = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
        const event = await deps.store.projectSourceEvent(
          task.userId,
          project.id,
          source.id,
          selected.eventId
        );
        lines.push(
          `Selected context: conversation ${source.id}${selected.eventId ? `, event ${selected.eventId}` : ''}${selected.filePath ? `, file ${selected.filePath}` : ''}`
        );
        if (selected.result)
          lines.push(
            `Selected result reference: ${JSON.stringify(selected.result)}. Verify mutable files against this hash before relying on them; changed files are not this version.`
          );
        if (event?.payloadCiphertext) {
          const value = decryptJson<Record<string, unknown>>(
            event.payloadCiphertext,
            sourceKey,
            `task-event:${source.id}`
          );
          const body =
            typeof value.markdown === 'string'
              ? value.markdown
              : typeof value.text === 'string'
                ? value.text
                : typeof value.content === 'string'
                  ? value.content
                  : JSON.stringify(value);
          lines.push(excerpt(body, 6000));
        }
      }
    }
  }
  return lines.join('\n');
}
