export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the file as it is now, absent for added lines. */
  before?: number;
  /** 1-based line number in the file as it would be, absent for removed lines. */
  after?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** True when the change was too large to align line by line and is shown as a whole rewrite. */
  coarse: boolean;
  unchanged: boolean;
  /** True when the file does not exist yet, so every line is new. */
  created: boolean;
}

export interface FileChange {
  path: string;
  /** Absent when the current contents are not known to the client and must be fetched. */
  before?: string;
  after: string;
}

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline terminates the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// The alignment is quadratic, so a very large rewrite would freeze the tab instead of rendering.
// Past this many cells the change is shown as a whole-file replacement, which is still honest.
const MAX_ALIGNMENT_CELLS = 400_000;

/**
 * Longest-common-subsequence line alignment, with the shared head and tail trimmed first so the
 * quadratic part only sees the region that actually differs.
 */
export const diffLines = (
  before: string,
  after: string
): { lines: DiffLine[]; coarse: boolean } => {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  )
    head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  )
    tail += 1;

  const beforeMiddle = beforeLines.slice(head, beforeLines.length - tail);
  const afterMiddle = afterLines.slice(head, afterLines.length - tail);
  const lines: DiffLine[] = [];
  const emit = (kind: DiffLineKind, text: string, beforeLine?: number, afterLine?: number) =>
    lines.push({
      kind,
      text,
      ...(beforeLine === undefined ? {} : { before: beforeLine }),
      ...(afterLine === undefined ? {} : { after: afterLine })
    });

  for (let index = 0; index < head; index += 1)
    emit('context', beforeLines[index]!, index + 1, index + 1);

  const coarse = beforeMiddle.length * afterMiddle.length > MAX_ALIGNMENT_CELLS;
  if (coarse) {
    beforeMiddle.forEach((text, index) => emit('remove', text, head + index + 1));
    afterMiddle.forEach((text, index) => emit('add', text, undefined, head + index + 1));
  } else {
    const rows = beforeMiddle.length;
    const columns = afterMiddle.length;
    const table = new Uint32Array((rows + 1) * (columns + 1));
    for (let row = rows - 1; row >= 0; row -= 1)
      for (let column = columns - 1; column >= 0; column -= 1)
        table[row * (columns + 1) + column] =
          beforeMiddle[row] === afterMiddle[column]
            ? table[(row + 1) * (columns + 1) + column + 1]! + 1
            : Math.max(
                table[(row + 1) * (columns + 1) + column]!,
                table[row * (columns + 1) + column + 1]!
              );
    let row = 0;
    let column = 0;
    while (row < rows && column < columns) {
      if (beforeMiddle[row] === afterMiddle[column]) {
        emit('context', beforeMiddle[row]!, head + row + 1, head + column + 1);
        row += 1;
        column += 1;
      } else if (
        table[(row + 1) * (columns + 1) + column]! >= table[row * (columns + 1) + column + 1]!
      ) {
        emit('remove', beforeMiddle[row]!, head + row + 1);
        row += 1;
      } else {
        emit('add', afterMiddle[column]!, undefined, head + column + 1);
        column += 1;
      }
    }
    while (row < rows) {
      emit('remove', beforeMiddle[row]!, head + row + 1);
      row += 1;
    }
    while (column < columns) {
      emit('add', afterMiddle[column]!, undefined, head + column + 1);
      column += 1;
    }
  }

  for (let index = 0; index < tail; index += 1) {
    const beforeLine = beforeLines.length - tail + index;
    const afterLine = afterLines.length - tail + index;
    emit('context', beforeLines[beforeLine]!, beforeLine + 1, afterLine + 1);
  }
  return { lines, coarse };
};

/** Groups the aligned lines into hunks, keeping `context` unchanged lines around each change. */
export const buildFileDiff = (
  path: string,
  before: string | undefined,
  after: string,
  context = 3
): FileDiff => {
  const created = before === undefined;
  const { lines, coarse } = diffLines(before ?? '', after);
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'remove').length;
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0)
    return { path, added, removed, hunks: [], coarse, unchanged: true, created };

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changedIndexes[0]! - context);
  let end = Math.min(lines.length - 1, changedIndexes[0]! + context);
  const flush = () => {
    const slice = lines.slice(start, end + 1);
    const first = slice[0]!;
    const beforeStart =
      first.before ?? slice.find((line) => line.before !== undefined)?.before ?? 0;
    const afterStart = first.after ?? slice.find((line) => line.after !== undefined)?.after ?? 0;
    const beforeCount = slice.filter((line) => line.kind !== 'add').length;
    const afterCount = slice.filter((line) => line.kind !== 'remove').length;
    hunks.push({
      header: `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
      lines: slice
    });
  };
  for (const index of changedIndexes.slice(1)) {
    if (index - context > end + 1) {
      flush();
      start = Math.max(0, index - context);
    }
    end = Math.min(lines.length - 1, index + context);
  }
  flush();
  return { path, added, removed, hunks, coarse, unchanged: false, created };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The file changes a tool call would make, from the arguments the approval is cryptographically
 * bound to. `file_patch` carries both sides of each edit; `file_write` carries only the new
 * contents, so `before` is left absent for the caller to fetch from the computer.
 */
export const fileChangesFromTool = (tool: string | undefined, args: unknown): FileChange[] => {
  const record = asRecord(args);
  if (tool === 'file_write') {
    const path = asText(record.path);
    const after = asText(record.content);
    return path !== undefined && after !== undefined ? [{ path, after }] : [];
  }
  if (tool === 'file_patch') {
    const patches = Array.isArray(record.patches) ? record.patches : [];
    return patches.flatMap((entry) => {
      const patch = asRecord(entry);
      const path = asText(patch.path);
      const before = asText(patch.oldText);
      const after = asText(patch.newText);
      return path !== undefined && before !== undefined && after !== undefined
        ? [{ path, before, after }]
        : [];
    });
  }
  return [];
};

export const diffStat = (diff: FileDiff): string =>
  diff.unchanged
    ? 'no change'
    : `${diff.added > 0 ? `+${diff.added}` : ''}${diff.added > 0 && diff.removed > 0 ? ' ' : ''}${
        diff.removed > 0 ? `−${diff.removed}` : ''
      }`;
