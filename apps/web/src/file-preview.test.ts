import { describe, expect, it } from 'vitest';
import {
  EDITABLE_BYTE_LIMIT,
  previewMime,
  readFilePreview,
  TEXT_PREVIEW_LIMIT
} from './file-preview.js';

const bytesOf = (values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
const textOf = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

describe('what the Files pane decides a file is', () => {
  it('names the media it can draw, including what comes off a phone', () => {
    expect(previewMime('holiday.JPG')).toBe('image/jpeg');
    expect(previewMime('diagram.svg')).toBe('image/svg');
    expect(previewMime('IMG_0421.heic')).toBe('image/heic');
    expect(previewMime('shot.avif')).toBe('image/avif');
    expect(previewMime('scan.bmp')).toBe('image/bmp');
    expect(previewMime('clip.webm')).toBe('video/webm');
    expect(previewMime('notes.txt')).toBeUndefined();
    expect(previewMime('LICENSE')).toBeUndefined();
  });

  it('refuses to read bytes that are not text as text', () => {
    // The first bytes of a real PDF, then a byte no UTF-8 sequence can begin with. The lenient
    // decoder turns this into replacement characters and the download was rebuilt from those.
    const pdf = bytesOf([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0xfd]);
    expect(readFilePreview('report.pdf', pdf)).toEqual({ kind: 'binary' });
    // A lone continuation byte, and a truncated multi-byte sequence: both are what a zip or an
    // executable looks like to a decoder.
    expect(readFilePreview('archive.zip', bytesOf([0x50, 0x4b, 0x03, 0x04, 0x80]))).toEqual({
      kind: 'binary'
    });
    expect(readFilePreview('a.bin', bytesOf([0xe2, 0x82]))).toEqual({ kind: 'binary' });
  });

  it('refuses valid UTF-8 that is carrying NULs, which no editor here should hold', () => {
    expect(readFilePreview('a.dat', bytesOf([0x68, 0x69, 0x00, 0x68, 0x69]))).toEqual({
      kind: 'binary'
    });
  });

  it('keeps text that happens to be non-Latin, which the strict decoder must not reject', () => {
    const shown = readFilePreview('notes.md', textOf('# Notes\nこんにちは — café 🌍\n'));
    expect(shown).toMatchObject({ kind: 'text', text: '# Notes\nこんにちは — café 🌍\n' });
    expect(shown.kind === 'text' && shown.editableText).toBe('# Notes\nこんにちは — café 🌍\n');
    expect(shown.kind === 'text' && shown.reason).toBeUndefined();
  });

  it('says when what is on screen is not the whole file', () => {
    const truncated = readFilePreview('huge.log', textOf('x'.repeat(TEXT_PREVIEW_LIMIT + 10)));
    expect(truncated).toMatchObject({ kind: 'text', reason: 'truncated' });
    expect(truncated.kind === 'text' && truncated.text).toHaveLength(TEXT_PREVIEW_LIMIT);
    // Nothing to hold whole, so nothing to edit: a save would write back what is on screen.
    expect(truncated.kind === 'text' && truncated.editableText).toBeUndefined();
  });

  it('says when a file is whole on screen but too large to edit', () => {
    const readOnly = readFilePreview('big.csv', textOf('y'.repeat(EDITABLE_BYTE_LIMIT + 1)));
    expect(readOnly).toMatchObject({ kind: 'text', reason: 'read_only' });
    expect(readOnly.kind === 'text' && readOnly.editableText).toBeUndefined();
    // ...and the byte on the other side of the line is editable, with no disclosure to make.
    const editable = readFilePreview('big.csv', textOf('y'.repeat(EDITABLE_BYTE_LIMIT)));
    expect(editable.kind === 'text' && editable.reason).toBeUndefined();
    expect(editable.kind === 'text' && editable.editableText).toHaveLength(EDITABLE_BYTE_LIMIT);
  });

  it('measures the editable limit in bytes, not characters', () => {
    // Four bytes each, so a million characters of this is four megabytes on disk. Counting the
    // string would have called it editable and then written it back through a save.
    const emoji = textOf('🌍'.repeat(EDITABLE_BYTE_LIMIT / 4 + 1));
    expect(emoji.byteLength).toBeGreaterThan(EDITABLE_BYTE_LIMIT);
    expect(readFilePreview('emoji.txt', emoji)).toMatchObject({ reason: 'read_only' });
  });

  it('never inspects the bytes of something it is going to draw', () => {
    // A JPEG is not valid UTF-8, and asking would classify the owner's photo as binary.
    expect(readFilePreview('photo.jpg', bytesOf([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      kind: 'media',
      mime: 'image/jpeg'
    });
  });
});
