/**
 * What the command palette lists for what has been typed.
 *
 * The palette is the only place several of these actions exist at all, so what it does and does
 * not surface is the difference between a feature being reachable and not. Ranking, de-duplication
 * and the cap are decided here rather than inside the component.
 */
import type { Command } from './CommandPalette.js';
import type { ConversationSearchResult, Task } from './types.js';

/**
 * Ranks by where the match lands rather than whether it merely occurs: a title that starts with
 * the query is what the owner meant, a word-start match is next, an interior match is last. This
 * keeps "term" from surfacing "Determine…" above "Terminal".
 */
export const score = (haystack: string, needle: string): number => {
  const text = haystack.toLowerCase();
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  if (index === 0) return 0;
  return /\s|[-_/]/.test(text[index - 1] ?? '') ? 1 : 2;
};

export type PaletteRow =
  | { kind: 'command'; id: string; command: Command }
  | {
      kind: 'conversation';
      id: string;
      taskId: string;
      workspaceId: string;
      label: string;
      hint: string;
    };

/** How many rows are drawn. Beyond this the list is a wall rather than an answer. */
export const MAX_PALETTE_ROWS = 40;

export const paletteRows = (input: {
  query: string;
  commands: Command[];
  /** The conversations this device already has, matched on their titles as the owner types. */
  tasks: Task[];
  /** What the box found inside conversation bodies, which arrives a moment later. */
  matches: ConversationSearchResult[];
  limit?: number;
}): PaletteRow[] => {
  const term = input.query.trim().toLowerCase();
  const ranked = input.commands
    .map((command, index) => ({ command, index, rank: term ? score(command.label, term) : 0 }))
    .filter((entry) => entry.rank >= 0);

  /**
   * Where each group sits, and it has to be somewhere: the list draws a heading whenever the group
   * changes from one row to the next, so a group that appears in two runs is drawn twice. The
   * palette listed "Actions" above the computer surfaces and again below them, because the
   * commands are assembled in two passes with the surfaces built in between - two identical
   * headings around one group of four, in the one list that is supposed to make everything
   * findable. Ranking made it worse by interleaving them further.
   *
   * A group takes the position of its best-matching member, so typing still floats the group that
   * answers you to the top; within a group the original order stands.
   */
  const groupRank = new Map<string, { rank: number; index: number }>();
  for (const entry of ranked) {
    const best = groupRank.get(entry.command.group);
    if (!best || entry.rank < best.rank) groupRank.set(entry.command.group, entry);
  }
  const rows: PaletteRow[] = ranked
    .sort((left, right) => {
      const a = groupRank.get(left.command.group)!;
      const b = groupRank.get(right.command.group)!;
      // Groups first, so each heading is drawn once; then the ranking, inside the group.
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.index !== b.index) return a.index - b.index;
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.index - right.index;
    })
    .map(({ command }) => ({ kind: 'command' as const, id: command.id, command }));

  const seen = new Set<string>();
  const addConversation = (taskId: string, workspaceId: string, label: string, hint: string) => {
    if (seen.has(taskId) || !label.trim()) return;
    seen.add(taskId);
    rows.push({ kind: 'conversation', id: `task:${taskId}`, taskId, workspaceId, label, hint });
  };
  for (const task of input.tasks) {
    if (term && score(task.title, term) < 0) continue;
    addConversation(task.id, task.workspaceId, task.title, task.status);
  }
  // The box's own results come second and are deduplicated against the local ones, so a
  // conversation this device has keeps the name it has here rather than appearing twice.
  for (const result of input.matches)
    addConversation(result.taskId, result.workspaceId, result.title, result.excerpt);

  return rows.slice(0, input.limit ?? MAX_PALETTE_ROWS);
};
