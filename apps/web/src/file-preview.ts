/**
 * What the Files pane does with the bytes it was handed.
 *
 * This was thirty lines inside the pane, and it decided four things that all reach the owner: what
 * the file is, whether what is on screen is all of it, whether it can be edited, and - through the
 * string it produced - what a download would contain. The last one was wrong: bytes that are not
 * text were decoded leniently into a page of replacement characters, and the download was rebuilt
 * from that string, so a PDF, a zip or a photo came back from the owner's own computer as a file
 * their computer could not open. The decision lives here so it can be exercised on real bytes.
 */

/** Above this, only the first slice is shown, and that has to be said. */
export const TEXT_PREVIEW_LIMIT = 2_000_000;

/** Above this the file is held read-only: a save would write back what is on screen. */
export const EDITABLE_BYTE_LIMIT = 1_000_000;

/**
 * Rendered inline. `heic` and `heif` are here because a phone's own camera roll is the commonest
 * thing an owner puts on this computer, and treating one as text is how it used to be corrupted -
 * a device that cannot draw it still gets a card and an intact download rather than a wall of
 * replacement characters.
 */
const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'heic',
  'heif'
];
const VIDEO_EXTENSIONS = ['mp4', 'webm'];

export const previewMime = (name: string): string | undefined => {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.includes(extension))
    return `image/${extension === 'jpg' ? 'jpeg' : extension}`;
  return VIDEO_EXTENSIONS.includes(extension) ? `video/${extension}` : undefined;
};

export type FilePreview =
  | { kind: 'media'; mime: string }
  | { kind: 'binary' }
  | {
      kind: 'text';
      /** What to show, which is not always what the file holds. */
      text: string;
      /** The whole of it, for the editor; absent when there is no whole to hold. */
      editableText?: string;
      reason?: 'truncated' | 'read_only';
    };

export const readFilePreview = (name: string, bytes: ArrayBuffer): FilePreview => {
  const mime = previewMime(name);
  if (mime) return { kind: 'media', mime };
  let text: string;
  try {
    // Strict, so bytes that are not text say so instead of decoding into U+FFFD and being believed.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'binary' };
  }
  // Valid UTF-8 carrying NULs is not a document anyone is going to read or edit here.
  if (text.includes('\u0000')) return { kind: 'binary' };
  if (text.length > TEXT_PREVIEW_LIMIT)
    return { kind: 'text', text: text.slice(0, TEXT_PREVIEW_LIMIT), reason: 'truncated' };
  return bytes.byteLength <= EDITABLE_BYTE_LIMIT
    ? { kind: 'text', text, editableText: text }
    : { kind: 'text', text, reason: 'read_only' };
};
