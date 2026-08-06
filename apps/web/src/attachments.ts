/**
 * Attachments as a thing the owner can see and take back, rather than a path inside their sentence.
 *
 * Every route into the composer — paperclip, drag-and-drop, paste, camera, share target, native
 * folder import — used to concatenate `workspace/uploads/<uuid>-<name>` onto the draft, which made
 * that path the message: it was what the transcript showed, what search indexed, and what the
 * sidebar excerpt quoted. The upload now lives beside the draft instead of inside it, and the paths
 * are attached to the message as a trailer the transcript renders as files.
 */

/** The runner's own ceiling for a single uploaded file. */
export const MAX_ATTACHMENT_BYTES = 49 * 1024 * 1024;

/**
 * How many files one message carries. Twenty parallel uploads already saturate a home link, and a
 * folder dropped by accident is the realistic way this is reached.
 */
export const MAX_ATTACHMENT_COUNT = 20;

/** Uploads land here, and the transcript only treats a path under one of these as an attachment. */
export const ATTACHMENT_ROOTS = ['workspace/uploads/', 'workspace/imports/'] as const;

export type AttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  /** Where the file landed on the agent computer. Empty until the upload finishes. */
  path: string;
  status: AttachmentStatus;
  /** 0–1. Determinate, because a 49 MiB upload over a home link is minutes of silence otherwise. */
  progress: number;
  /** An object URL for an image chosen on this device, so the thumbnail costs no round trip. */
  previewUrl?: string;
  error?: string;
}

/**
 * A file name the agent can refer to and a shell can quote without escaping.
 *
 * The tail is kept rather than the head: the extension is the part that decides how the file is
 * read, and a long name is usually distinctive at its end (`…-2026-q3-report.pdf`).
 */
export const safeAttachmentName = (name: string): string =>
  name
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(-120) || 'attachment';

export const attachmentPath = (name: string, id: string): string =>
  `workspace/uploads/${id}-${safeAttachmentName(name)}`;

/** The name as it was chosen, recovered from a stored path for a transcript rendered later. */
export const attachmentDisplayName = (path: string): string => {
  const base = path.split('/').pop() ?? path;
  // Uploads are prefixed with the id that made them unique; nobody needs to read a UUID.
  return base.replace(/^[0-9a-f]{8}-[0-9a-f-]{27}-/i, '') || base;
};

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);

const imageMimeTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
};

const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

export const isImageAttachment = (path: string): boolean => imageExtensions.has(extensionOf(path));

/**
 * The MIME type an image needs to be handed to the browser as.
 *
 * The file route answers `application/octet-stream` and the deployment sends `nosniff`, so bytes
 * fetched from the agent computer have to be re-typed from the extension before an `<img>` will
 * take them.
 */
export const imageMimeType = (path: string): string =>
  imageMimeTypes[extensionOf(path)] ?? 'application/octet-stream';

const fileKinds: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet',
  'application/vnd.oasis.opendocument.text': 'Document',
  'application/vnd.oasis.opendocument.spreadsheet': 'Spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'Presentation',
  'application/msword': 'Word document',
  'application/vnd.ms-excel': 'Spreadsheet',
  'application/vnd.ms-powerpoint': 'Presentation',
  'text/csv': 'CSV',
  'text/markdown': 'Markdown',
  'text/html': 'Web page',
  'application/json': 'JSON',
  'application/zip': 'Archive'
};

/**
 * What a produced file is, in the words someone would use for it.
 *
 * The card under a finished piece of work read
 * "application/vnd.openxmlformats-officedocument.presentationml.presentation" — the one string in
 * the interface least like the thing the owner had just asked for.
 */
export const fileKindLabel = (mimeType: string, name = ''): string => {
  const named = fileKinds[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (named) return named;
  const family = mimeType.split('/')[0];
  if (family === 'image') return 'Image';
  if (family === 'video') return 'Video';
  if (family === 'audio') return 'Audio';
  if (family === 'text') return 'Text file';
  const extension = extensionOf(name);
  return extension ? `${extension.toUpperCase()} file` : 'File';
};

const TRAILER_HEADING = 'Attached files:';

/**
 * The line the agent reads, appended at send time rather than typed into the draft.
 *
 * It is deliberately plain prose with one path per line: the model needs to know the files are
 * there and where they are, and anything more structured would be a private protocol that only
 * this client understands.
 */
export const attachmentTrailer = (paths: string[]): string =>
  paths.length ? `${TRAILER_HEADING}\n${paths.map((path) => `- ${path}`).join('\n')}` : '';

export const withAttachments = (prompt: string, paths: string[]): string => {
  const trailer = attachmentTrailer(paths);
  if (!trailer) return prompt;
  return prompt ? `${prompt}\n\n${trailer}` : trailer;
};

/**
 * The extension a recording has to be sent under.
 *
 * `MediaRecorder` returns whatever the browser chose — `audio/webm;codecs=opus` on Chrome and
 * Firefox, `audio/mp4` on Safari — and the transcription route reads the container from the
 * extension rather than sniffing the bytes. Getting this wrong is a failed transcription of a
 * recording the owner cannot make again.
 */
export const voiceNoteExtension = (mimeType: string): 'm4a' | 'ogg' | 'webm' => {
  const type = mimeType.toLowerCase();
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
};

/**
 * Which of the files just handed to the composer will actually be uploaded, and what to say about
 * the rest.
 *
 * Every route in — paperclip, drop, paste, camera, share target — arrives here, so this is the one
 * place that decides. The count used to be applied before the size check, so twenty files too big
 * to send took the whole allowance with them and the twenty-first, which was fine, vanished with no
 * message at all. Nothing is ever dropped silently except an empty file, which is what a folder
 * dropped on the composer produces.
 */
export const planUploads = <T extends { name: string; size: number }>(
  files: T[]
): { accepted: T[]; message: string } => {
  const real = files.filter((file) => file.size > 0);
  const oversized = real.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
  const sendable = real.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
  const accepted = sendable.slice(0, MAX_ATTACHMENT_COUNT);
  const notes: string[] = [];
  if (oversized.length)
    notes.push(
      `${oversized.map((file) => file.name).join(', ')} ${
        oversized.length === 1 ? 'is' : 'are'
      } over the 49 MiB limit for one file. Put ${
        oversized.length === 1 ? 'it' : 'them'
      } on the agent computer from the Files pane instead.`
    );
  if (sendable.length > accepted.length)
    notes.push(
      `Only the first ${MAX_ATTACHMENT_COUNT} files were attached; ${
        sendable.length - accepted.length
      } were left out. Send them in a second message, or put the folder on the agent computer from the Files pane.`
    );
  return { accepted, message: notes.join(' ') };
};

/**
 * Splits a stored message back into what the owner wrote and what they attached.
 *
 * The match is deliberately narrow — the block has to be the last thing in the message, every line
 * has to be a path under an upload root, and nothing may follow it — so a message that merely talks
 * about attached files is never silently turned into a file strip.
 */
export const splitAttachments = (markdown: string): { body: string; paths: string[] } => {
  const index = markdown.lastIndexOf(`${TRAILER_HEADING}\n`);
  if (index === -1) return { body: markdown, paths: [] };
  const before = markdown.slice(0, index);
  if (before && !/\n\s*$/.test(before)) return { body: markdown, paths: [] };
  const lines = markdown
    .slice(index + TRAILER_HEADING.length + 1)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return { body: markdown, paths: [] };
  const paths: string[] = [];
  for (const line of lines) {
    const match = /^-\s+(\S+)$/.exec(line.trim());
    const path = match?.[1];
    if (!path || !ATTACHMENT_ROOTS.some((root) => path.startsWith(root)))
      return { body: markdown, paths: [] };
    paths.push(path);
  }
  return { body: before.trimEnd(), paths };
};
