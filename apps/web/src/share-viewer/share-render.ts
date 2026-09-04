/**
 * What the viewer draws for what it opened, decided without a DOM so it can be read back in a test.
 */
import type { ShareSnapshot, ShareSnapshotEventKind } from '@athanor/contracts';

/**
 * Types the browser may be handed as a document from a `blob:` URL the viewer minted.
 *
 * The same list the box uses when it serves an artifact to the owner, for the same reason: a
 * declared type is a claim by whoever saved the file, and the agent that saved it takes
 * instructions from what it reads. Anything not on this list is offered as bytes to save. HTML is
 * the one exception with a presentation of its own - a frame with `sandbox="allow-scripts"` and
 * nothing else, which is an opaque origin that can reach no cookie, no storage and no page.
 */
const INLINE_SAFE: Record<string, ArtifactPresentation> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video'
};

export type ArtifactPresentation =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'text'
  | 'frame'
  | 'download';

export const artifactPresentation = (mimeType: string): ArtifactPresentation => {
  const declared = mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (declared === 'text/html') return 'frame';
  return INLINE_SAFE[declared] ?? 'download';
};

/** What a reader is told an event is, where the kind alone would not say. */
export const kindLabel = (kind: ShareSnapshotEventKind): string => {
  switch (kind) {
    case 'user_message':
      return 'You';
    case 'assistant_message':
      return 'athanor';
    case 'assistant_reasoning':
      return 'How it got there';
    case 'plan':
      return 'Plan';
    case 'status':
      return 'Status';
    case 'tool_started':
    case 'tool_result':
      return 'Step';
    case 'question_asked':
      return 'Asked';
    case 'approval_requested':
      return 'Asked to approve';
    case 'approval_resolved':
      return 'Decision';
    case 'notice':
      return 'Notice';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'completed':
      return 'Result';
  }
};

/** Kinds drawn as prose with markdown; the rest are one line each. */
export const isProseKind = (kind: ShareSnapshotEventKind): boolean =>
  kind === 'user_message' ||
  kind === 'assistant_message' ||
  kind === 'assistant_reasoning' ||
  kind === 'completed' ||
  kind === 'plan';

/** The whole snapshot as a Markdown document, for the download at the foot of the page. */
export const snapshotMarkdown = (snapshot: ShareSnapshot): string => {
  const lines: string[] = [`# ${snapshot.title}`, ''];
  for (const event of snapshot.events) {
    if (isProseKind(event.kind))
      lines.push(`## ${kindLabel(event.kind)}`, '', event.text.trim(), '');
    else lines.push(`- ${kindLabel(event.kind)}: ${event.text.trim().replace(/\s+/g, ' ')}`, '');
  }
  if (snapshot.artifacts.length) {
    lines.push('## Files', '');
    for (const artifact of snapshot.artifacts)
      lines.push(`- ${artifact.name} (${artifact.mimeType}, ${formatBytes(artifact.sizeBytes)})`);
    lines.push('');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** A file name a browser will accept for the download, from the snapshot's title. */
export const downloadName = (title: string, extension: string): string =>
  `${title.replace(/[^a-zA-Z0-9 _-]+/g, ' ').trim() || 'conversation'}.${extension}`;
